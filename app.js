/* 1日のタスクスケジューラー
 * 優先順位（1が最優先）の高いタスクから 9:00〜18:00 に順番に割り当てる。
 * tasks 配列の並び順がそのまま優先順位で、変更のたびに 1..n を振り直す。 */
'use strict';

const DAY_START = 9 * 60;   // 9:00 を分に換算
const DAY_END = 18 * 60;    // 18:00
const MAX_DURATION = DAY_END - DAY_START;
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
  summary: document.getElementById('summary'),
  exportText: document.getElementById('export-text'),
  exportStatus: document.getElementById('export-status'),
  copy: document.getElementById('copy-btn'),
  download: document.getElementById('download-btn'),
  dialog: document.getElementById('conflict-dialog'),
  dialogMessage: document.getElementById('conflict-message'),
  chooseMoving: document.getElementById('choose-moving'),
  chooseExisting: document.getElementById('choose-existing'),
  dialogCancel: document.getElementById('conflict-cancel'),
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
    const loaded = parsed
      .filter((t) => t && typeof t.name === 'string')
      .map((t, i) => ({
        id: String(t.id || `${Date.now()}-${i}`),
        name: t.name,
        priority: clamp(Number(t.priority) || 1, 1, 99),
        duration: clamp(Number(t.duration) || 30, 5, MAX_DURATION),
        createdAt: Number(t.createdAt) || i,
      }))
      .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    loaded.forEach((task, i) => { task.priority = i + 1; });
    return loaded;
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

function renumber() {
  tasks.forEach((task, i) => { task.priority = i + 1; });
}

/* ---------- スケジューリング ---------- */

/* 優先順位の順に 9:00 から詰めていく。
 * 残り時間に収まらないタスクは飛ばし、後続の短いタスクで埋める。 */
function buildSchedule() {
  const scheduled = [];
  const unscheduled = [];
  let cursor = DAY_START;

  for (const task of tasks) {
    if (cursor + task.duration <= DAY_END) {
      scheduled.push({ task, start: cursor, end: cursor + task.duration });
      cursor += task.duration;
    } else {
      unscheduled.push(task);
    }
  }

  return { scheduled, unscheduled, freeMinutes: DAY_END - cursor };
}

/* ---------- 優先順位の変更 ---------- */

/* 同じ優先順位のタスクがある場合に、どちらを先にするか選んでもらう。
 * 戻り値は 'moving'（動かす側が先）／'existing'（既存が先）／null（キャンセル）。 */
let conflictOpen = false;

function askPriorityConflict(moving, rival, rank) {
  /* ダイアログを開いている間に別の変更が届いても、二重に適用しない */
  if (conflictOpen) return Promise.resolve(null);
  conflictOpen = true;

  return new Promise((resolve) => {
    el.dialogMessage.textContent =
      `優先順位 ${rank} には既に「${rival.name}」があります。どちらを先に実行しますか？`;
    fillChoice(el.chooseMoving, moving, `優先順位 ${rank}（先に実行）`);
    fillChoice(el.chooseExisting, rival, `優先順位 ${rank}（先に実行）`);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      conflictOpen = false;
      el.chooseMoving.removeEventListener('click', onMoving);
      el.chooseExisting.removeEventListener('click', onExisting);
      el.dialogCancel.removeEventListener('click', onCancel);
      el.dialog.removeEventListener('close', onClose);
      if (el.dialog.open) el.dialog.close();
      resolve(result);
    };
    const onMoving = () => finish('moving');
    const onExisting = () => finish('existing');
    const onCancel = () => finish(null);
    const onClose = () => finish(null);

    el.chooseMoving.addEventListener('click', onMoving);
    el.chooseExisting.addEventListener('click', onExisting);
    el.dialogCancel.addEventListener('click', onCancel);
    el.dialog.addEventListener('close', onClose);

    if (typeof el.dialog.showModal === 'function') {
      el.dialog.showModal();
    } else {
      el.dialog.setAttribute('open', '');
    }
    el.chooseMoving.focus();
  });
}

function fillChoice(button, task, badgeText) {
  button.textContent = '';
  const name = document.createElement('strong');
  name.textContent = `「${task.name}」を先にする`;
  const meta = document.createElement('span');
  meta.textContent = `所要 ${formatDuration(task.duration)}　→　${badgeText}`;
  button.append(name, meta);
}

/* 既存タスクを希望の優先順位へ移動する。重複時は選択ダイアログを挟む。 */
async function moveTask(id, desiredRank) {
  const from = tasks.findIndex((t) => t.id === id);
  if (from < 0) return false;

  const rank = clamp(desiredRank, 1, tasks.length);
  if (rank - 1 === from) return false;

  const moving = tasks[from];
  const rival = tasks[rank - 1];
  const choice = await askPriorityConflict(moving, rival, rank);
  if (!choice) return false;

  tasks.splice(from, 1);
  const rivalIndex = tasks.indexOf(rival);
  tasks.splice(choice === 'moving' ? rivalIndex : rivalIndex + 1, 0, moving);
  renumber();
  return true;
}

/* 新しいタスクを希望の優先順位に差し込む。重複時は選択ダイアログを挟む。 */
async function insertTask(task, desiredRank) {
  const rank = clamp(desiredRank, 1, tasks.length + 1);
  if (rank > tasks.length) {
    tasks.push(task);
    renumber();
    return true;
  }

  const rival = tasks[rank - 1];
  const choice = await askPriorityConflict(task, rival, rank);
  if (!choice) return false;

  tasks.splice(choice === 'moving' ? rank - 1 : rank, 0, task);
  renumber();
  return true;
}

/* ---------- 描画 ---------- */

function render() {
  const plan = buildSchedule();
  renderList();
  renderTimeline(plan);
  renderTable(plan);
  renderSummary(plan);
  renderExport(plan);
}

function renderList() {
  el.list.textContent = '';
  el.listEmpty.hidden = tasks.length > 0;
  el.clear.hidden = tasks.length === 0;

  tasks.forEach((task) => {
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

  if (tasks.length === 0) {
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
    el.scheduleBody.append(
      makeTaskRow(entry.task, `${formatTime(entry.start)} 〜 ${formatTime(entry.end)}`)
    );
  });

  if (plan.freeMinutes > 0 && plan.scheduled.length > 0) {
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

  if (plan.unscheduled.length > 0) {
    const head = document.createElement('tr');
    head.className = 'section-row';
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.textContent = '割り当てできなかったタスク（9:00〜18:00 に収まりません。優先順位か所要時間を見直してください）';
    head.append(cell);
    el.scheduleBody.append(head);

    plan.unscheduled.forEach((task) => {
      el.scheduleBody.append(makeTaskRow(task, '—', true));
    });
  }
}

/* 優先順位と所要時間をその場で編集できる行を作る。 */
function makeTaskRow(task, timeLabel, unscheduled) {
  const row = document.createElement('tr');
  if (unscheduled) row.className = 'unscheduled';

  const priorityCell = document.createElement('td');
  priorityCell.append(
    makeNumberInput({
      value: task.priority,
      min: 1,
      max: Math.max(tasks.length, 1),
      step: 1,
      field: 'priority',
      taskId: task.id,
      label: `${task.name} の優先順位`,
      onCommit: (value) => changePriority(task.id, value),
    })
  );

  const durationCell = document.createElement('td');
  durationCell.className = 'duration';
  durationCell.append(
    makeNumberInput({
      value: task.duration,
      min: 5,
      max: MAX_DURATION,
      step: 5,
      field: 'duration',
      taskId: task.id,
      label: `${task.name} の所要時間（分）`,
      onCommit: (value) => changeDuration(task.id, value),
    }),
    makeSpan(formatDuration(task.duration), 'cell-note')
  );

  row.append(
    makeCell(timeLabel, 'time'),
    priorityCell,
    makeCell(task.name),
    durationCell
  );
  return row;
}

function makeNumberInput(options) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'cell-input';
  input.value = String(options.value);
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.dataset.taskId = options.taskId;
  input.dataset.field = options.field;
  input.setAttribute('aria-label', options.label);
  input.addEventListener('change', () => {
    const value = Number(input.value);
    if (!Number.isFinite(value)) {
      render();
      return;
    }
    options.onCommit(value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
  });
  return input;
}

function makeSpan(text, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

function makeCell(text, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
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
  const blob = new Blob(['﻿' + el.exportText.value], { type: 'text/plain;charset=utf-8' });
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
  if (duration > MAX_DURATION) {
    showError(`所要時間は1日の枠（${formatDuration(MAX_DURATION)}）以内で入力してください。`);
    return null;
  }

  clearError();
  return { name, priority: clamp(priority, 1, 99), duration: clamp(duration, 5, MAX_DURATION) };
}

function resetForm() {
  editingId = null;
  el.form.reset();
  el.id.value = '';
  el.priority.value = String(tasks.length + 1);
  el.duration.value = '60';
  el.submit.textContent = '追加する';
  el.cancel.hidden = true;
  clearError();
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
  renumber();
  if (editingId === id) resetForm();
  save();
  render();
}

/* 表からの優先順位の変更（重複時は比較ダイアログ、キャンセル時は元に戻す） */
async function changePriority(id, value) {
  const changed = await moveTask(id, value);
  if (changed) save();
  render();
  if (changed) focusCell(id, 'priority');
}

/* 表からの所要時間の変更 */
function changeDuration(id, value) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.duration = clamp(value, 5, MAX_DURATION);
  save();
  render();
  focusCell(id, 'duration');
}

/* 再描画で入力欄が作り直されるため、操作していたセルに focus を戻す */
function focusCell(id, field) {
  const input = el.scheduleBody.querySelector(
    `input[data-task-id="${CSS.escape(id)}"][data-field="${field}"]`
  );
  if (input) input.focus();
}

el.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = readForm();
  if (!input) return;

  if (editingId) {
    const task = tasks.find((t) => t.id === editingId);
    if (!task) return;
    task.name = input.name;
    task.duration = input.duration;
    if (input.priority !== task.priority) {
      const moved = await moveTask(editingId, input.priority);
      if (!moved) {
        /* 順位の変更は取り消し。名前と所要時間の変更は保存する。 */
        save();
        render();
        el.priority.value = String(task.priority);
        return;
      }
    }
  } else {
    const task = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      ...input,
    };
    const inserted = await insertTask(task, input.priority);
    if (!inserted) return;
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
