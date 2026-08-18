/* 最小限の XLSX 読み書き（外部ライブラリなし）
 * ・書き出し：無圧縮（Store）ZIP に、必要最小限の OOXML を詰める
 * ・読み込み：ZIP の中央ディレクトリを辿り、Store と Deflate の両方に対応する
 * 数式や書式は扱わず、文字列と数値だけを行列として往復させる。 */
'use strict';

const XLSX = (() => {
  const encoder = new TextEncoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- ZIP（書き出し・無圧縮） ---------- */

  function zipStore(files) {
    const parts = [];
    const central = [];
    let offset = 0;

    files.forEach((file) => {
      const nameBytes = encoder.encode(file.name);
      const data = encoder.encode(file.content);
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true);          // 無圧縮
      view.setUint16(10, 0, true);
      view.setUint16(12, 0x2821, true);    // 日付（固定値）
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);

      const entry = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(entry.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, 0, true);
      centralView.setUint16(14, 0x2821, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      entry.set(nameBytes, 46);

      parts.push(local, data);
      central.push(entry);
      offset += local.length + data.length;
    });

    const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, files.length, true);
    endView.setUint16(10, files.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  /* ---------- ZIP（読み込み） ---------- */

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('この環境では圧縮された Excel ファイルを読み込めません。');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    let endOffset = -1;
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        endOffset = i;
        break;
      }
    }
    if (endOffset < 0) throw new Error('Excel ファイル（.xlsx）として読み取れません。');

    const count = view.getUint16(endOffset + 10, true);
    let pointer = view.getUint32(endOffset + 16, true);
    const decoder = new TextDecoder();
    const files = new Map();

    for (let i = 0; i < count; i += 1) {
      if (view.getUint32(pointer, true) !== 0x02014b50) break;
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = decoder.decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(dataStart, dataStart + compressedSize);

      /* eslint-disable no-await-in-loop */
      const content = method === 0 ? raw : await inflateRaw(raw);
      files.set(name, decoder.decode(content));
      pointer += 46 + nameLength + extraLength + commentLength;
    }

    return files;
  }

  /* ---------- シートの組み立て ---------- */

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function columnName(index) {
    let name = '';
    let n = index;
    do {
      name = String.fromCharCode(65 + (n % 26)) + name;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return name;
  }

  function cellXml(reference, value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `<c r="${reference}"><v>${value}</v></c>`;
    }
    const text = value === null || value === undefined ? '' : String(value);
    if (text === '') return '';
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
  }

  /* rows: 文字列か数値の二次元配列（1行目が見出し） */
  function build(sheetName, rows, widths) {
    const sheetRows = rows.map((cells, rowIndex) => {
      const xml = cells
        .map((value, columnIndex) => cellXml(`${columnName(columnIndex)}${rowIndex + 1}`, value))
        .join('');
      return `<row r="${rowIndex + 1}">${xml}</row>`;
    }).join('');

    const cols = (widths || []).map((width, index) =>
      `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');

    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
  cols ? `<cols>${cols}</cols>` : ''}<sheetData>${sheetRows}</sheetData></worksheet>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

    return zipStore([
      { name: '[Content_Types].xml', content: contentTypes },
      { name: '_rels/.rels', content: rels },
      { name: 'xl/workbook.xml', content: workbook },
      { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
      { name: 'xl/worksheets/sheet1.xml', content: sheet },
    ]);
  }

  /* ---------- シートの読み取り ---------- */

  function sharedStringsOf(xml) {
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(doc.getElementsByTagName('si')).map((si) =>
      Array.from(si.getElementsByTagName('t')).map((t) => t.textContent).join(''));
  }

  function columnIndexOf(reference) {
    const match = /^([A-Z]+)/.exec(reference || '');
    if (!match) return 0;
    return match[1].split('').reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 64), 0) - 1;
  }

  /* 戻り値は文字列の二次元配列 */
  async function parse(buffer) {
    const files = await unzip(buffer);
    const sheetName = ['xl/worksheets/sheet1.xml']
      .concat(Array.from(files.keys()).filter((name) => /^xl\/worksheets\/.+\.xml$/.test(name)))
      .find((name) => files.has(name));
    if (!sheetName) throw new Error('シートが見つかりませんでした。');

    const strings = sharedStringsOf(files.get('xl/sharedStrings.xml'));
    const doc = new DOMParser().parseFromString(files.get(sheetName), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('シートの内容を読み取れませんでした。');
    }

    return Array.from(doc.getElementsByTagName('row')).map((row) => {
      const cells = [];
      Array.from(row.getElementsByTagName('c')).forEach((cell) => {
        const index = columnIndexOf(cell.getAttribute('r'));
        const type = cell.getAttribute('t');
        let value = '';
        if (type === 'inlineStr') {
          value = Array.from(cell.getElementsByTagName('t')).map((t) => t.textContent).join('');
        } else {
          const v = cell.getElementsByTagName('v')[0];
          const raw = v ? v.textContent : '';
          value = type === 's' ? (strings[Number(raw)] || '') : raw;
        }
        cells[index] = value === null || value === undefined ? '' : String(value).trim();
      });
      for (let i = 0; i < cells.length; i += 1) {
        if (cells[i] === undefined) cells[i] = '';
      }
      return cells;
    });
  }

  return { build, parse };
})();
