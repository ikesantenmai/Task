/* 1日のタスクスケジューラー
 * 優先順位（1が最優先）の高いタスクから 9:00〜18:00 に順番に割り当てる。 */
'use strict';

const DAY_START = 9 * 60;   // 9:00 を分に換算
const DAY_END = 18 * 60;    // 18:00
const STORAGE_KEY = 'daily-task-scheduler/v1';
const HUES = [214, 268, 340, 24, 152, 190, 44, 300];

const el = {
  form: document.getElementById('task-form'),
  id: document.getElementById('task-id'),
  name: document.getElementById('task-name'),
  priority: document.getElementById('task-priority'),
  duration: document.getElementById('task-duration'),
  error: document.getElementById('form-error'),
  submit: document.getElementById('submit-btn'),
  cancel: document.getElementById('cancel-btn'),
  clear: document.getElementById('clear-btn'),
  list: document.getElementById('task-list'),
  listEmpty: document.getElementById('list-empty'),
  timeline: document.getElementById('timeline'),
  scheduleBody: document.getElementById('schedule-body'),
  overflow: document.getElementById('overflow'),
  overflowList: document.getElementById('overflow-list'),
  summary: document.getElementById('summary'),
  exportText: document.getElementById('export-text'),
  exportStatus: document.getElementById('export-status'),
  copy: document.getElementById('copy-btn'),
  download: document.getElementById('download-btn'),
};

let tasks = load();
let editingId = null;

/* ---------- 永続化 ---------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.name === 'string')
      .map((t, i) => ({
        id: String(t.id || `${Date.now()}-${i}`),
        name: t.name,
        priority: clamp(Number(t.priority) || 1, 1, 99),
        duration: clamp(Number(t.duration) || 30, 5, DAY_END - DAY_START),
        createdAt: Number(t.createdAt) || i,
      }));
  } catch (e) {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (e) {
    /* 保存できなくても画面の操作は継続できる */
  }
}

/* ---------- ユーティリティ ---------- */

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}時間${m}分`;
  if (h) return `${h}時間`;
  return `${m}分`;
}

/* ---------- スケジューリング ---------- */

/* 優先順位（同順位は登録順）で並べ、9:00 から詰めていく。
 * 残り時間に収まらないタスクは飛ばし、後続の短いタスクで埋める。 */
function buildSchedule() {
  const ordered = tasks
    .slice()
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  const scheduled = [];
  const unscheduled = [];
  let cursor = DAY_START;

  for (const task of ordered) {
    if (cursor + task.duration <= DAY_END) {
      scheduled.push({ task, start: cursor, end: cursor + task.duration });
      cursor += task.duration;
    } else {
      unscheduled.push(task);
    }
  }

  return { ordered, scheduled, unscheduled, freeMinutes: DAY_END - cursor };
}

/* ---------- 描画 ---------- */

function render() {
  const plan = buildSchedule();
  renderList(plan.ordered);
  renderTimeline(plan);
  renderTable(plan);
  renderOverflow(plan);
  renderSummary(plan);
  renderExport(plan);
}

function renderList(ordered) {
  el.list.textContent = '';
  el.listEmpty.hidden = ordered.length > 0;
  el.clear.hidden = ordered.length === 0;

  ordered.forEach((task) => {
    const item = document.createElement('li');
    item.className = 'task-item' + (task.id === editingId ? ' editing' : '');

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = task.priority;
    rank.title = `優先順位 ${task.priority}`;

    const body = document.createElement('div');
    body.className = 'task-body';
    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = task.name;
    const meta = document.createElement('span');
    meta.className = 'task-meta';
    meta.textContent = `優先順位 ${task.priority}・所要 ${formatDuration(task.duration)}`;
    body.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    actions.append(
      makeButton('編集', () => startEdit(task.id), `${task.name} を編集`),
      makeButton('削除', () => removeTask(task.id), `${task.name} を削除`, true)
    );

    item.append(rank, body, actions);
    el.list.append(item);
  });
}

function makeButton(label, onClick, ariaLabel, danger) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn ghost btn-small' + (danger ? ' danger' : '');
  button.textContent = label;
  button.setAttribute('aria-label', ariaLabel);
  button.addEventListener('click', onClick);
  return button;
}

function renderTimeline(plan) {
  el.timeline.textContent = '';
  plan.scheduled.forEach((entry, index) => {
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.style.flexGrow = String(entry.task.duration);
    slot.style.flexBasis = '0';
    slot.style.background = `hsl(${HUES[index % HUES.length]} 62% 48%)`;
    slot.textContent = entry.task.name;
    slot.title = `${formatTime(entry.start)}〜${formatTime(entry.end)}　${entry.task.name}`;
    el.timeline.append(slot);
  });

  if (plan.freeMinutes > 0) {
    const free = document.createElement('div');
    free.className = 'slot free';
    free.style.flexGrow = String(plan.freeMinutes);
    free.style.flexBasis = '0';
    free.textContent = plan.scheduled.length ? '空き' : '9:00〜18:00 は空いています';
    el.timeline.append(free);
  }

  el.timeline.style.opacity = plan.scheduled.length ? '1' : '.6';
}

function renderTable(plan) {
  el.scheduleBody.textContent = '';

  if (plan.scheduled.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'center';
    cell.textContent = 'タスクを追加するとスケジュールが表示されます。';
    row.append(cell);
    el.scheduleBody.append(row);
    return;
  }

  plan.scheduled.forEach((entry) => {
    const row = document.createElement('tr');
    row.append(
      makeCell(`${formatTime(entry.start)} 〜 ${formatTime(entry.end)}`, 'time'),
      makeCell(String(entry.task.priority)),
      makeCell(entry.task.name),
      makeCell(formatDuration(entry.task.duration), 'duration')
    );
    el.scheduleBody.append(row);
  });

  if (plan.freeMinutes > 0) {
    const last = plan.scheduled[plan.scheduled.length - 1].end;
    const row = document.createElement('tr');
    row.className = 'gap';
    row.append(
      makeCell(`${formatTime(last)} 〜 ${formatTime(DAY_END)}`, 'time'),
      makeCell('—'),
      makeCell('空き時間'),
      makeCell(formatDuration(plan.freeMinutes), 'duration')
    );
    el.scheduleBody.append(row);
  }
}

function makeCell(text, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

function renderOverflow(plan) {
  el.overflow.hidden = plan.unscheduled.length === 0;
  el.overflowList.textContent = '';
  plan.unscheduled.forEach((task) => {
    const item = document.createElement('li');
    item.textContent = `${task.name}（優先順位 ${task.priority}・${formatDuration(task.duration)}）`;
    el.overflowList.append(item);
  });
}

function renderSummary(plan) {
  el.summary.textContent = '';
  const used = plan.scheduled.reduce((sum, entry) => sum + entry.task.duration, 0);
  const rows = [
    ['タスク数', `${tasks.length} 件`],
    ['割り当て済み', `${plan.scheduled.length} 件 / ${formatDuration(used)}`],
    ['空き時間', formatDuration(plan.freeMinutes)],
  ];
  if (plan.unscheduled.length) rows.push(['未割り当て', `${plan.unscheduled.length} 件`]);

  const dl = document.createElement('dl');
  rows.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  });
  el.summary.append(dl);
}

/* ---------- テキスト出力 ---------- */

const RULE = '='.repeat(44);
const THIN_RULE = '-'.repeat(44);

function todayLabel() {
  const now = new Date();
  const week = ['日', '月', '火', '水', '木', '金', '土'][now.getDay()];
  return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}（${week}）`;
}

/* スケジュールをそのまま貼り付けられるプレーンテキストに整形する。 */
function buildText(plan) {
  const lines = [];
  lines.push(`${todayLabel()} のスケジュール（${formatTime(DAY_START)}〜${formatTime(DAY_END)}）`);
  lines.push(RULE);
  lines.push('');

  if (plan.scheduled.length === 0) {
    lines.push('タスクが登録されていません。');
  } else {
    plan.scheduled.forEach((entry) => {
      lines.push(
        `${formatTime(entry.start)}〜${formatTime(entry.end)}  ${entry.task.name}` +
        `  [優先${entry.task.priority}・${formatDuration(entry.task.duration)}]`
      );
    });
    if (plan.freeMinutes > 0) {
      const last = plan.scheduled[plan.scheduled.length - 1].end;
      lines.push(`${formatTime(last)}〜${formatTime(DAY_END)}  （空き時間）  [${formatDuration(plan.freeMinutes)}]`);
    }
  }

  if (plan.unscheduled.length > 0) {
    lines.push('');
    lines.push('■ 割り当てできなかったタスク');
    plan.unscheduled.forEach((task) => {
      lines.push(`- ${task.name}  [優先${task.priority}・${formatDuration(task.duration)}]`);
    });
  }

  const used = plan.scheduled.reduce((sum, entry) => sum + entry.task.duration, 0);
  lines.push('');
  lines.push(THIN_RULE);
  lines.push(
    `タスク ${tasks.length}件 / 割り当て ${plan.scheduled.length}件・${formatDuration(used)}` +
    ` / 空き ${formatDuration(plan.freeMinutes)}` +
    (plan.unscheduled.length ? ` / 未割り当て ${plan.unscheduled.length}件` : '')
  );

  return lines.join('\n');
}

function renderExport(plan) {
  el.exportText.value = buildText(plan);
  setStatus('');
}

let statusTimer = 0;

function setStatus(message) {
  el.exportStatus.textContent = message;
  window.clearTimeout(statusTimer);
  if (message) statusTimer = window.setTimeout(() => { el.exportStatus.textContent = ''; }, 3000);
}

async function copyText() {
  const text = el.exportText.value;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      /* file:// などクリップボードAPIが使えない環境向けのフォールバック */
      el.exportText.select();
      if (!document.execCommand('copy')) throw new Error('execCommand failed');
      el.exportText.setSelectionRange(0, 0);
    }
    setStatus('クリップボードにコピーしました。');
  } catch (e) {
    el.exportText.select();
    setStatus('コピーできませんでした。テキストを選択したので手動でコピーしてください。');
  }
}

function downloadText() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');

  /* BOM 付きで保存し、Windows のテキストエディタでも文字化けしないようにする */
  const blob = new Blob(['\uFEFF' + el.exportText.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `schedule-${stamp}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`schedule-${stamp}.txt をダウンロードしました。`);
}

/* ---------- 操作 ---------- */

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

function clearError() {
  el.error.textContent = '';
  el.error.hidden = true;
}

function readForm() {
  const name = el.name.value.trim();
  const priority = Number(el.priority.value);
  const duration = Number(el.duration.value);

  if (!name) {
    showError('タスク名を入力してください。');
    return null;
  }
  if (!Number.isFinite(priority) || priority < 1) {
    showError('優先順位は1以上の数値で入力してください。');
    return null;
  }
  if (!Number.isFinite(duration) || duration < 5) {
    showError('所要時間は5分以上で入力してください。');
    return null;
  }
  if (duration > DAY_END - DAY_START) {
    showError(`所要時間は1日の枠（${formatDuration(DAY_END - DAY_START)}）以内で入力してください。`);
    return null;
  }

  clearError();
  return { name, priority: clamp(priority, 1, 99), duration: clamp(duration, 5, DAY_END - DAY_START) };
}

function resetForm() {
  editingId = null;
  el.form.reset();
  el.id.value = '';
  el.priority.value = String(nextPriority());
  el.duration.value = '60';
  el.submit.textContent = '追加する';
  el.cancel.hidden = true;
  clearError();
}

function nextPriority() {
  if (tasks.length === 0) return 1;
  return clamp(Math.max(...tasks.map((t) => t.priority)) + 1, 1, 99);
}

function startEdit(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  editingId = id;
  el.id.value = id;
  el.name.value = task.name;
  el.priority.value = String(task.priority);
  el.duration.value = String(task.duration);
  el.submit.textContent = '更新する';
  el.cancel.hidden = false;
  clearError();
  render();
  el.name.focus();
}

function removeTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (!window.confirm(`「${task.name}」を削除しますか？`)) return;
  tasks = tasks.filter((t) => t.id !== id);
  if (editingId === id) resetForm();
  save();
  render();
}

el.form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = readForm();
  if (!input) return;

  if (editingId) {
    tasks = tasks.map((t) => (t.id === editingId ? { ...t, ...input } : t));
  } else {
    tasks.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      ...input,
    });
  }

  save();
  resetForm();
  render();
  el.name.focus();
});

el.cancel.addEventListener('click', () => {
  resetForm();
  render();
});

el.clear.addEventListener('click', () => {
  if (tasks.length === 0) return;
  if (!window.confirm('すべてのタスクを削除しますか？')) return;
  tasks = [];
  save();
  resetForm();
  render();
});

el.copy.addEventListener('click', copyText);
el.download.addEventListener('click', downloadText);

resetForm();
render();
