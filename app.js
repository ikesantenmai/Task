/* 1日のタスクスケジューラー
 * ・自動スケジュール：優先順位（1が最優先）の高いタスクから 9:00〜18:00 に日単位で割り当てる。
 * ・週間スケジュール：タスクと予定を1週間の任意の日時へドラッグ＆ドロップで固定する。
 * tasks 配列の並び順がそのまま優先順位で、変更のたびに 1..n を振り直す。 */
'use strict';

const DAY_START = 9 * 60;   // 9:00 を分に換算
const DAY_END = 18 * 60;    // 18:00
const MAX_DURATION = DAY_END - DAY_START;
const SLOT = 30;            // 週間スケジュールの1コマ（分）
const WEEK_LENGTH = 7;
const WEEK_NAMES = ['月', '火', '水', '木', '金', '土', '日'];
const HUES = [214, 268, 340, 24, 152, 190, 44, 300];

const STORAGE_KEY = 'daily-task-scheduler/v2';
const EVENTS_KEY = 'daily-task-scheduler/events/v2';
const LEGACY_STORAGE_KEY = 'daily-task-scheduler/v1';
const LEGACY_EVENTS_KEY = 'daily-task-scheduler/events/v1';

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
  clearPlanning: document.getElementById('clear-planning-btn'),
  list: document.getElementById('task-list'),
  listEmpty: document.getElementById('list-empty'),
  timeline: document.getElementById('timeline'),
  scheduleBody: document.getElementById('schedule-body'),
  summary: document.getElementById('summary'),
  boardHead: document.getElementById('board-head'),
  board: document.getElementById('board-body'),
  boardStatus: document.getElementById('board-status'),
  clearPlacements: document.getElementById('clear-placements'),
  eventForm: document.getElementById('event-form'),
  eventId: document.getElementById('event-id'),
  eventName: document.getElementById('event-name'),
  eventDay: document.getElementById('event-day'),
  eventStart: document.getElementById('event-start'),
  eventDuration: document.getElementById('event-duration'),
  eventSubmit: document.getElementById('event-submit'),
  eventCancel: document.getElementById('event-cancel'),
  exportBody: document.getElementById('export-body'),
  exportStatus: document.getElementById('export-status'),
  exportDay: document.getElementById('export-day'),
  download: document.getElementById('download-btn'),
  importFile: document.getElementById('import-file'),
  importDialog: document.getElementById('import-dialog'),
  importMessage: document.getElementById('import-message'),
  importDay: document.getElementById('import-day'),
  importConfirm: document.getElementById('import-confirm'),
  importCancel: document.getElementById('import-cancel'),
  dialog: document.getElementById('conflict-dialog'),
  dialogMessage: document.getElementById('conflict-message'),
  chooseMoving: document.getElementById('choose-moving'),
  chooseExisting: document.getElementById('choose-existing'),
  dialogCancel: document.getElementById('conflict-cancel'),
};

/* ---------- 週（月曜始まり）の日付 ---------- */

const WEEK_START = mondayOfThisWeek();

function mondayOfThisWeek() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date;
}

function todayIndex() {
  return (new Date().getDay() + 6) % 7;
}

function dayDate(index) {
  const date = new Date(WEEK_START);
  date.setDate(date.getDate() + index);
  return date;
}

function dayLabel(index) {
  const date = dayDate(index);
  return `${date.getMonth() + 1}/${date.getDate()}（${WEEK_NAMES[index]}）`;
}

function dayLabelLong(index) {
  const date = dayDate(index);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}（${WEEK_NAMES[index]}）`;
}

function dayStamp(index) {
  const date = dayDate(index);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
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

/* 週間スケジュールは30分刻みなので、開始時刻をコマの先頭に合わせる */
function snapToSlot(minutes) {
  return DAY_START + Math.round((minutes - DAY_START) / SLOT) * SLOT;
}

function renumber() {
  tasks.forEach((task, i) => { task.priority = i + 1; });
}

/* ---------- 永続化 ---------- */

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/* 配置情報は {day, start}。旧形式（分だけの数値）は当日の予定として引き継ぐ。 */
function normalizePlacement(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { day: todayIndex(), start: snapToSlot(clamp(value, DAY_START, DAY_END - SLOT)) };
  }
  if (typeof value === 'object' && Number.isFinite(Number(value.start))) {
    return {
      day: clamp(Number(value.day) || 0, 0, WEEK_LENGTH - 1),
      start: snapToSlot(clamp(Number(value.start), DAY_START, DAY_END - SLOT)),
    };
  }
  return null;
}

function load() {
  const stored = readJson(STORAGE_KEY) || readJson(LEGACY_STORAGE_KEY) || [];
  const loaded = stored
    .filter((t) => t && typeof t.name === 'string')
    .map((t, i) => ({
      id: String(t.id || `${Date.now()}-${i}`),
      name: t.name,
      priority: clamp(Number(t.priority) || 1, 1, 99),
      duration: clamp(Number(t.duration) || 30, 5, MAX_DURATION),
      createdAt: Number(t.createdAt) || i,
      placedAt: normalizePlacement(t.placedAt),
    }))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  loaded.forEach((task, i) => { task.priority = i + 1; });
  return loaded;
}

function loadEvents() {
  const stored = readJson(EVENTS_KEY) || readJson(LEGACY_EVENTS_KEY) || [];
  return stored
    .filter((e) => e && typeof e.name === 'string' && Number.isFinite(Number(e.start)))
    .map((e, i) => ({
      id: String(e.id || `event-${Date.now()}-${i}`),
      name: e.name,
      day: Number.isFinite(Number(e.day)) ? clamp(Number(e.day), 0, WEEK_LENGTH - 1) : todayIndex(),
      start: snapToSlot(clamp(Number(e.start), DAY_START, DAY_END - SLOT)),
      duration: clamp(Number(e.duration) || 30, 5, MAX_DURATION),
      priority: Number(e.priority) > 0 ? clamp(Number(e.priority), 1, 99) : null,
    }));
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (e) {
    /* 保存できなくても画面の操作は継続できる */
  }
}

function saveEvents() {
  try {
    localStorage.setItem(EVENTS_KEY, JSON.stringify(events));
  } catch (e) {
    /* 保存できなくても画面の操作は継続できる */
  }
}

let tasks = load();
let events = loadEvents();     // 優先度を持たない予定（会議・昼休みなど）
let editingId = null;
let editingEventId = null;

/* ---------- 自動スケジュール（日単位） ---------- */

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

/* ---------- 週間スケジュール（配置） ---------- */

/* 表示上は30分単位のコマを占有するため、終了時刻もコマ単位に切り上げる */
function slotSpan(duration) {
  return Math.max(1, Math.ceil(duration / SLOT));
}

function occupiedEnd(start, duration) {
  return start + slotSpan(duration) * SLOT;
}

/* 週間スケジュールに並ぶもの＝配置済みタスクと予定 */
function boardItems(day) {
  const placedTasks = tasks
    .filter((task) => task.placedAt !== null)
    .map((task) => ({
      kind: 'task',
      id: task.id,
      name: task.name,
      day: task.placedAt.day,
      start: task.placedAt.start,
      duration: task.duration,
      priority: task.priority,
    }));
  const eventItems = events.map((event) => ({
    kind: 'event',
    id: event.id,
    name: event.name,
    day: event.day,
    start: event.start,
    duration: event.duration,
    priority: event.priority || null,
  }));
  return placedTasks
    .concat(eventItems)
    .filter((item) => day === undefined || item.day === day)
    .sort((a, b) => a.day - b.day || a.start - b.start);
}

function isFree(kind, id, day, start, duration) {
  return boardItems(day).every((item) => {
    if (item.kind === kind && item.id === id) return true;
    return start >= occupiedEnd(item.start, item.duration) ||
      occupiedEnd(start, duration) <= item.start;
  });
}

/* 配置できない理由を返す（配置できる場合は null） */
function placementIssue(name, kind, id, day, start, duration) {
  if (start < DAY_START || occupiedEnd(start, duration) > DAY_END) {
    return `「${name}」は ${formatTime(DAY_END)} を超えるため、この時間には配置できません。`;
  }
  if (!isFree(kind, id, day, start, duration)) {
    return `「${name}」は ${dayLabel(day)} の他のタスク・予定と重なるため、この時間には配置できません。`;
  }
  return null;
}

function placeItem(kind, id, day, start) {
  if (kind === 'event') return moveEvent(id, day, start);

  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  const issue = placementIssue(task.name, 'task', id, day, start, task.duration);
  if (issue) {
    setBoardStatus(issue);
    return;
  }

  task.placedAt = { day, start };
  save();
  render();
  setBoardStatus(`「${task.name}」を ${dayLabel(day)} ${formatTime(start)} に配置しました。`);
}

/* 一覧から外したタスク（優先順位あり）は「予定」と呼ばないようにする */
function eventLabel(event) {
  return event.priority ? `「${event.name}」` : `予定「${event.name}」`;
}

function moveEvent(id, day, start) {
  const event = events.find((e) => e.id === id);
  if (!event) return;

  const issue = placementIssue(event.name, 'event', id, day, start, event.duration);
  if (issue) {
    setBoardStatus(issue);
    return;
  }

  event.day = day;
  event.start = start;
  saveEvents();
  render();
  setBoardStatus(`${eventLabel(event)}を ${dayLabel(day)} ${formatTime(start)} に移動しました。`);
}

function unplaceTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.placedAt === null) return;
  task.placedAt = null;
  save();
  render();
  setBoardStatus(`「${task.name}」の配置を解除しました。`);
}

function removeEvent(id) {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  if (!window.confirm(`${eventLabel(event)}を削除しますか？`)) return;
  const label = eventLabel(event);
  events = events.filter((e) => e.id !== id);
  if (editingEventId === id) resetEventForm();
  saveEvents();
  render();
  setBoardStatus(`${label}を削除しました。`);
}

/* 所要時間の変更などで配置が成立しなくなったタスクは解除する（予定は動かさない） */
function validatePlacements() {
  const fixed = events.map((event) => ({ day: event.day, start: event.start, duration: event.duration }));
  const dropped = [];

  tasks
    .filter((task) => task.placedAt !== null)
    .sort((a, b) => a.placedAt.day - b.placedAt.day || a.placedAt.start - b.placedAt.start)
    .forEach((task) => {
      const { day, start } = task.placedAt;
      const fits = start >= DAY_START &&
        (start - DAY_START) % SLOT === 0 &&
        occupiedEnd(start, task.duration) <= DAY_END;
      const overlaps = fixed.some((item) => item.day === day &&
        !(start >= occupiedEnd(item.start, item.duration) ||
          occupiedEnd(start, task.duration) <= item.start));
      if (fits && !overlaps) {
        fixed.push({ day, start, duration: task.duration });
      } else {
        task.placedAt = null;
        dropped.push(task.name);
      }
    });

  return dropped;
}

/* ---------- 優先順位の変更 ---------- */

let conflictOpen = false;

/* 同じ優先順位のタスクがある場合に、どちらを先にするか選んでもらう。
 * 戻り値は 'moving'（動かす側が先）／'existing'（既存が先）／null（キャンセル）。 */
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
  const dropped = validatePlacements();
  const plan = buildSchedule();
  renderList();
  renderTimeline(plan);
  renderTable(plan);
  renderBoard();
  renderSummary(plan);
  renderExport();
  if (dropped.length) {
    save();
    setBoardStatus(`${dropped.map((name) => `「${name}」`).join('、')}は時間が収まらなくなったため配置を解除しました。`);
  }
}

function renderList() {
  el.list.textContent = '';
  el.listEmpty.hidden = tasks.length > 0;
  el.clear.hidden = tasks.length === 0;
  el.clearPlanning.hidden = tasks.length === 0;

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
    cell.colSpan = 6;
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
      makeCell('', 'handle-cell'),
      makeCell(`${formatTime(last)} 〜 ${formatTime(DAY_END)}`, 'time'),
      makeCell('—'),
      makeCell('空き時間'),
      makeCell(formatDuration(plan.freeMinutes), 'duration'),
      makeCell('')
    );
    el.scheduleBody.append(row);
  }

  if (plan.unscheduled.length > 0) {
    const head = document.createElement('tr');
    head.className = 'section-row';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = '割り当てできなかったタスク（9:00〜18:00 に収まりません。優先順位か所要時間を見直してください）';
    head.append(cell);
    el.scheduleBody.append(head);

    plan.unscheduled.forEach((task) => {
      el.scheduleBody.append(makeTaskRow(task, '—', true));
    });
  }
}

/* 優先順位と所要時間をその場で編集でき、週間スケジュールへドラッグできる行 */
function makeTaskRow(task, timeLabel, unscheduled) {
  const row = document.createElement('tr');
  if (unscheduled) row.className = 'unscheduled';
  row.dataset.taskId = task.id;

  const handleCell = document.createElement('td');
  handleCell.className = 'handle-cell';
  handleCell.append(makeDragHandle('task', task.id, task.name, row));

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

  const nameCell = makeCell(task.name);
  if (task.placedAt !== null) {
    nameCell.append(
      makeSpan(`配置済み ${dayLabel(task.placedAt.day)} ${formatTime(task.placedAt.start)}`, 'badge')
    );
  }

  const addCell = document.createElement('td');
  addCell.className = 'add-cell';
  const daySelect = document.createElement('select');
  daySelect.className = 'cell-select';
  daySelect.setAttribute('aria-label', `${task.name} を追加する曜日`);
  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const option = document.createElement('option');
    option.value = String(day);
    option.textContent = dayLabel(day);
    daySelect.append(option);
  }
  daySelect.value = String(task.placedAt ? task.placedAt.day : todayIndex());
  addCell.append(
    daySelect,
    makeButton('追加', () => addTaskToDay(task.id, Number(daySelect.value)), `${task.name} を選んだ曜日に追加`)
  );

  row.append(handleCell, makeCell(timeLabel, 'time'), priorityCell, nameCell, durationCell, addCell);
  return row;
}

/* 選んだ曜日の空いている時間に、自動スケジュールの時刻を優先して配置する */
function addTaskToDay(id, day) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  const entry = buildSchedule().scheduled.find((item) => item.task.id === id);
  const preferred = entry ? snapToSlot(entry.start) : DAY_START;
  const candidates = [preferred];
  for (let start = DAY_START; start < DAY_END; start += SLOT) candidates.push(start);

  const target = candidates.find((start) =>
    placementIssue(task.name, 'task', id, day, start, task.duration) === null);

  if (target === undefined) {
    setBoardStatus(`${dayLabel(day)} には「${task.name}」（${formatDuration(task.duration)}）を置ける空き時間がありません。`);
    return;
  }
  placeItem('task', id, day, target);
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

/* ---------- 週間スケジュールの描画 ---------- */

function renderBoard() {
  el.boardHead.textContent = '';
  el.board.textContent = '';

  const headTime = document.createElement('th');
  headTime.scope = 'col';
  headTime.textContent = '時間';
  el.boardHead.append(headTime);

  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = dayLabel(day);
    if (day === todayIndex()) cell.className = 'is-today';
    el.boardHead.append(cell);
  }

  const byStart = new Map();   // `${day}:${slotIndex}` -> item
  const covered = new Set();
  boardItems().forEach((item) => {
    const index = Math.round((item.start - DAY_START) / SLOT);
    byStart.set(`${item.day}:${index}`, item);
    for (let i = index; i < index + slotSpan(item.duration); i += 1) covered.add(`${item.day}:${i}`);
  });

  el.clearPlacements.hidden = !tasks.some((task) => task.placedAt !== null);

  const slotCount = (DAY_END - DAY_START) / SLOT;
  for (let index = 0; index < slotCount; index += 1) {
    const start = DAY_START + index * SLOT;
    const row = document.createElement('tr');
    row.append(makeCell(`${formatTime(start)} 〜 ${formatTime(start + SLOT)}`, 'time'));

    for (let day = 0; day < WEEK_LENGTH; day += 1) {
      const item = byStart.get(`${day}:${index}`);
      if (item) {
        row.append(makeBoardCell(item, Math.min(slotSpan(item.duration), slotCount - index)));
      } else if (!covered.has(`${day}:${index}`)) {
        row.append(makeDropCell(day, start));
      }
    }
    el.board.append(row);
  }
}

function makeBoardCell(item, span) {
  const cell = document.createElement('td');
  cell.className = 'placed-cell' + (item.day === todayIndex() ? ' is-today' : '');
  cell.rowSpan = span;

  const isPlainEvent = item.kind === 'event' && !item.priority;
  const block = document.createElement('div');
  block.className = 'placed' + (isPlainEvent ? ' is-event' : '');
  block.dataset.itemId = item.id;

  const body = document.createElement('div');
  body.className = 'placed-body';
  const name = document.createElement('strong');
  name.textContent = item.name;
  const detail = isPlainEvent
    ? `予定・${formatDuration(item.duration)}`
    : `優先${item.priority}・${formatDuration(item.duration)}`;
  body.append(
    name,
    makeSpan(`${formatTime(item.start)}〜${formatTime(item.start + item.duration)}　${detail}`, 'placed-meta')
  );

  const actions = document.createElement('div');
  actions.className = 'placed-actions';
  if (item.kind === 'event') {
    actions.append(
      makeButton('編集', () => startEventEdit(item.id), `予定 ${item.name} を編集`),
      makeButton('削除', () => removeEvent(item.id), `予定 ${item.name} を削除`, true)
    );
  } else {
    actions.append(makeButton('解除', () => unplaceTask(item.id), `${item.name} の配置を解除`));
  }

  block.append(makeDragHandle(item.kind, item.id, item.name, block), body, actions);
  cell.append(block);
  return cell;
}

function makeDropCell(day, start) {
  const cell = document.createElement('td');
  cell.className = 'drop-cell' + (day === todayIndex() ? ' is-today' : '');
  cell.dataset.day = String(day);
  cell.dataset.start = String(start);
  cell.title = `${dayLabel(day)} ${formatTime(start)}　クリックすると、この時間に予定を追加できます`;

  /* 空きコマをタップ／クリックすると、その日時で予定フォームを開く
   * （ドラッグ直後に合成されるクリックは無視する） */
  cell.addEventListener('click', () => {
    if (dragState || Date.now() - dragEndedAt < 400) return;
    el.eventDay.value = String(day);
    el.eventStart.value = String(start);
    el.eventName.focus();
    setBoardStatus(`${dayLabel(day)} ${formatTime(start)} 開始の予定を入力できます。`);
  });

  return cell;
}

/* ---------- ドラッグ＆ドロップ（マウス・タッチ共通） ----------
 * iPhone / iPad の Safari は HTML5 のドラッグ＆ドロップに対応していないため、
 * Pointer Events で自前に実装している。 */

let dragState = null;
let dragEndedAt = 0;

function makeDragHandle(kind, id, name, sourceElement) {
  const handle = makeSpan('⠿', 'drag-handle');
  handle.setAttribute('role', 'button');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-label', `${name} をドラッグして週間スケジュールに配置`);
  handle.title = 'ドラッグして週間スケジュールの時間帯に配置';
  handle.addEventListener('pointerdown', (event) => startDrag(event, kind, id, name, sourceElement));
  return handle;
}

function startDrag(event, kind, id, name, sourceElement) {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  if (dragState) return;
  event.preventDefault();

  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = name;
  document.body.append(ghost);

  dragState = {
    kind,
    id,
    ghost,
    source: sourceElement,
    hovered: null,
    pointerId: event.pointerId,
    point: { x: event.clientX, y: event.clientY },
    raf: 0,
  };
  if (sourceElement) sourceElement.classList.add('dragging');
  document.body.classList.add('is-dragging');
  moveGhost(event.clientX, event.clientY);
  dragState.raf = requestAnimationFrame(autoScrollStep);

  document.addEventListener('pointermove', onDragMove, { passive: false });
  document.addEventListener('pointerup', onDragEnd);
  document.addEventListener('pointercancel', onDragCancel);
}

function moveGhost(x, y) {
  dragState.ghost.style.left = `${x}px`;
  dragState.ghost.style.top = `${y}px`;
}

function dropCellFromPoint(x, y) {
  dragState.ghost.style.visibility = 'hidden';
  const element = document.elementFromPoint(x, y);
  dragState.ghost.style.visibility = '';
  return element ? element.closest('td.drop-cell') : null;
}

function setHovered(cell) {
  if (dragState.hovered === cell) return;
  if (dragState.hovered) dragState.hovered.classList.remove('drop-hover');
  dragState.hovered = cell;
  if (cell) cell.classList.add('drop-hover');
}

function onDragMove(event) {
  if (!dragState) return;
  event.preventDefault();      /* タッチ操作中に画面がスクロールしないようにする */
  dragState.point = { x: event.clientX, y: event.clientY };
  moveGhost(event.clientX, event.clientY);
  setHovered(dropCellFromPoint(event.clientX, event.clientY));
}

/* 画面端までドラッグしたら、縦（ページ）と横（週間表）を自動でスクロールする。
 * 画面の小さい端末で、離れた曜日・時間帯にも運べるようにするため。 */
function autoScrollStep() {
  if (!dragState) return;
  const { x, y } = dragState.point;
  const margin = 90;
  const speed = 14;
  let moved = false;

  if (y < margin) {
    window.scrollBy(0, -speed);
    moved = true;
  } else if (y > window.innerHeight - margin) {
    window.scrollBy(0, speed);
    moved = true;
  }

  const scroller = el.board.closest('.table-scroll');
  if (scroller) {
    const rect = scroller.getBoundingClientRect();
    if (x < rect.left + margin && scroller.scrollLeft > 0) {
      scroller.scrollLeft -= speed;
      moved = true;
    } else if (x > rect.right - margin) {
      scroller.scrollLeft += speed;
      moved = true;
    }
  }

  if (moved) setHovered(dropCellFromPoint(x, y));
  dragState.raf = requestAnimationFrame(autoScrollStep);
}

function onDragEnd(event) {
  if (!dragState) return;
  const { kind, id } = dragState;
  const cell = dropCellFromPoint(event.clientX, event.clientY);
  finishDrag();
  if (cell) {
    placeItem(kind, id, Number(cell.dataset.day), Number(cell.dataset.start));
  }
}

function onDragCancel() {
  if (dragState) finishDrag();
}

function finishDrag() {
  dragEndedAt = Date.now();
  cancelAnimationFrame(dragState.raf);
  setHovered(null);
  dragState.ghost.remove();
  if (dragState.source) dragState.source.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  document.removeEventListener('pointercancel', onDragCancel);
  dragState = null;
}

let boardStatusTimer = 0;

function setBoardStatus(message) {
  el.boardStatus.textContent = message;
  window.clearTimeout(boardStatusTimer);
  if (message) {
    boardStatusTimer = window.setTimeout(() => { el.boardStatus.textContent = ''; }, 4000);
  }
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

/* ---------- Excel 出力・取り込み ---------- */

const EXPORT_HEADER = ['種別', '曜日', '日付', '開始', '終了', '名称', '優先順位', '所要時間（分）'];
const EXPORT_WIDTHS = [8, 8, 12, 8, 8, 30, 10, 14];

function exportRange() {
  const checked = document.querySelector('input[name="export-range"]:checked');
  return checked ? checked.value : 'day';
}

function selectedDay() {
  const value = Number(el.exportDay.value);
  return Number.isFinite(value) ? clamp(value, 0, WEEK_LENGTH - 1) : todayIndex();
}

/* 出力する行。週単位は1週間分＋未配置タスク、日単位はその日の分＋未配置タスク。 */
function exportRows() {
  const isWeek = exportRange() === 'week';
  const day = selectedDay();
  const items = isWeek ? boardItems() : boardItems(day);

  const rows = items.map((item) => [
    item.kind === 'event' && !item.priority ? '予定' : 'タスク',
    WEEK_NAMES[item.day],
    dayStamp(item.day),
    formatTime(item.start),
    formatTime(item.start + item.duration),
    item.name,
    item.priority || '',
    item.duration,
  ]);

  tasks
    .filter((task) => task.placedAt === null)
    .forEach((task) => {
      rows.push(['タスク', '', '', '', '', task.name, task.priority, task.duration]);
    });

  return rows;
}

function renderExport() {
  const isWeek = exportRange() === 'week';
  el.exportDay.disabled = isWeek;

  const rows = exportRows();
  el.exportBody.textContent = '';

  if (rows.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = EXPORT_HEADER.length;
    cell.className = 'center';
    cell.textContent = '出力する内容がありません。タスクや予定を追加してください。';
    row.append(cell);
    el.exportBody.append(row);
    return;
  }

  rows.forEach((cells) => {
    const row = document.createElement('tr');
    if (cells[1] === '') row.className = 'unplaced-row';
    cells.forEach((value) => row.append(makeCell(value === '' ? '—' : String(value))));
    el.exportBody.append(row);
  });
}

function downloadWorkbook() {
  const isWeek = exportRange() === 'week';
  const sheetName = isWeek ? '週間スケジュール' : `${dayStamp(selectedDay())}`;
  const title = isWeek
    ? `${dayLabelLong(0)} 〜 ${dayLabelLong(WEEK_LENGTH - 1)} の週間スケジュール`
    : `${dayLabelLong(selectedDay())} のスケジュール`;

  const rows = [[title], ['範囲', isWeek ? '週単位' : '日単位'], EXPORT_HEADER].concat(exportRows());
  const blob = XLSX.build(sheetName, rows, EXPORT_WIDTHS);
  const fileName = isWeek
    ? `schedule-week-${dayStamp(0)}.xlsx`
    : `schedule-${dayStamp(selectedDay())}.xlsx`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(`${fileName} を出力しました。`);
}

/* 取り込み：出力した表と同じ見出しを探し、その下の行を読み込む */
function parseRows(rows) {
  const headerIndex = rows.findIndex((cells) => cells.includes('種別') && cells.includes('名称'));
  if (headerIndex < 0) {
    throw new Error('「種別」「名称」の見出しが見つかりません。このアプリで出力した Excel を選んでください。');
  }

  const header = rows[headerIndex];
  const column = (label) => header.indexOf(label);
  const columns = {
    kind: column('種別'),
    day: column('曜日'),
    start: column('開始'),
    name: column('名称'),
    priority: column('優先順位'),
    duration: column('所要時間（分）'),
  };
  if (columns.name < 0 || columns.duration < 0) {
    throw new Error('「名称」または「所要時間（分）」の列が見つかりません。');
  }

  const entries = [];
  let skipped = 0;

  rows.slice(headerIndex + 1).forEach((cells) => {
    const value = (key) => (columns[key] >= 0 ? (cells[columns[key]] || '').trim() : '');
    const name = value('name');
    if (!name) return;

    const duration = Number(value('duration'));
    if (!Number.isFinite(duration) || duration < 5) {
      skipped += 1;
      return;
    }

    const dayIndex = WEEK_NAMES.indexOf(value('day').replace(/曜日?$/, ''));
    const startMatch = /^(\d{1,2}):(\d{2})$/.exec(value('start'));
    const start = startMatch
      ? snapToSlot(clamp(Number(startMatch[1]) * 60 + Number(startMatch[2]), DAY_START, DAY_END - SLOT))
      : null;
    const placed = dayIndex >= 0 && start !== null;
    const kind = value('kind') === '予定' ? 'event' : 'task';

    if (kind === 'event' && !placed) {
      skipped += 1;
      return;
    }

    entries.push({
      kind,
      name,
      duration: clamp(duration, 5, MAX_DURATION),
      priority: Number(value('priority')) || null,
      day: placed ? dayIndex : null,
      start: placed ? start : null,
    });
  });

  return { entries, skipped, range: detectRange(rows, headerIndex, entries) };
}

/* 日単位か週単位かの判定。出力時に入れた「範囲」の行を優先し、
 * 無い場合はタイトルや曜日の散らばりから推測する。 */
function detectRange(rows, headerIndex, entries) {
  for (const cells of rows.slice(0, headerIndex)) {
    const index = cells.indexOf('範囲');
    if (index >= 0 && cells[index + 1]) {
      return cells[index + 1].includes('週') ? 'week' : 'day';
    }
    if (cells.some((cell) => typeof cell === 'string' && cell.includes('週間スケジュール'))) {
      return 'week';
    }
  }
  const days = new Set(entries.filter((entry) => entry.day !== null).map((entry) => entry.day));
  return days.size > 1 ? 'week' : 'day';
}

function newId(prefix) {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* 週単位：タスクと予定をまるごと置き換える */
function applyWeekImport(entries) {
  const importedTasks = [];
  const importedEvents = [];

  entries.forEach((entry, index) => {
    if (entry.kind === 'event') {
      importedEvents.push({
        id: newId('event-'),
        name: entry.name,
        day: entry.day,
        start: entry.start,
        duration: entry.duration,
      });
    } else {
      importedTasks.push({
        id: newId(''),
        name: entry.name,
        priority: entry.priority || importedTasks.length + 1,
        duration: entry.duration,
        createdAt: Date.now() + index,
        placedAt: entry.day === null ? null : { day: entry.day, start: entry.start },
      });
    }
  });

  importedTasks.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  tasks = importedTasks;
  events = importedEvents;
  renumber();
  return { taskCount: importedTasks.length, eventCount: importedEvents.length, conflicts: [] };
}

/* 日単位：選んだ曜日だけを入れ替える。
 * 同じ名前のタスクは既存のものを使い回し、無ければ新しく追加する。 */
function applyDayImport(entries, day) {
  tasks.forEach((task) => {
    if (task.placedAt && task.placedAt.day === day) task.placedAt = null;
  });
  events = events.filter((event) => event.day !== day);

  const conflicts = [];
  let taskCount = 0;
  let eventCount = 0;

  entries.forEach((entry) => {
    if (entry.kind === 'event') {
      const id = newId('event-');
      if (placementIssue(entry.name, 'event', id, day, entry.start, entry.duration)) {
        conflicts.push(entry.name);
        return;
      }
      events.push({ id, name: entry.name, day, start: entry.start, duration: entry.duration });
      eventCount += 1;
      return;
    }

    let task = tasks.find((t) => t.name === entry.name);
    if (!task) {
      task = {
        id: newId(''),
        name: entry.name,
        priority: tasks.length + 1,
        duration: entry.duration,
        createdAt: Date.now(),
        placedAt: null,
      };
      tasks.push(task);
      renumber();
    } else {
      task.duration = entry.duration;
    }
    taskCount += 1;

    if (entry.start !== null) {
      if (placementIssue(task.name, 'task', task.id, day, entry.start, task.duration)) {
        conflicts.push(task.name);
        return;
      }
      task.placedAt = { day, start: entry.start };
    }
  });

  return { taskCount, eventCount, conflicts };
}

/* 取り込む曜日を選ぶダイアログ。戻り値は曜日の番号か null（キャンセル）。 */
function askImportDay(message, defaultDay) {
  return new Promise((resolve) => {
    el.importMessage.textContent = message;
    el.importDay.value = String(defaultDay);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      el.importConfirm.removeEventListener('click', onConfirm);
      el.importCancel.removeEventListener('click', onCancel);
      el.importDialog.removeEventListener('close', onCancel);
      if (el.importDialog.open) el.importDialog.close();
      resolve(result);
    };
    const onConfirm = () => finish(Number(el.importDay.value));
    const onCancel = () => finish(null);

    el.importConfirm.addEventListener('click', onConfirm);
    el.importCancel.addEventListener('click', onCancel);
    el.importDialog.addEventListener('close', onCancel);

    if (typeof el.importDialog.showModal === 'function') {
      el.importDialog.showModal();
    } else {
      el.importDialog.setAttribute('open', '');
    }
    el.importConfirm.focus();
  });
}

async function importWorkbook(file) {
  try {
    const rows = await XLSX.parse(await file.arrayBuffer());
    const { entries, skipped, range } = parseRows(rows);

    if (entries.length === 0) {
      setStatus('取り込める行がありませんでした。');
      return;
    }

    const taskRows = entries.filter((entry) => entry.kind === 'task').length;
    const eventRows = entries.length - taskRows;
    let result;
    let summary;

    if (range === 'week') {
      const message = `週単位のファイルです。現在のタスク（${tasks.length}件）と予定（${events.length}件）を、` +
        `ファイルの内容（タスク ${taskRows}件・予定 ${eventRows}件）で置き換えます。よろしいですか？`;
      if (!window.confirm(message)) {
        setStatus('取り込みを中止しました。');
        return;
      }
      result = applyWeekImport(entries);
      summary = `${file.name} でタスクと週間表を置き換えました`;
    } else {
      const fileDay = entries.find((entry) => entry.day !== null);
      const day = await askImportDay(
        `${file.name}（タスク ${taskRows}件・予定 ${eventRows}件）を取り込みます。` +
        '選んだ曜日の内容は、ファイルの内容に置き換わります。',
        fileDay ? fileDay.day : todayIndex()
      );
      if (day === null) {
        setStatus('取り込みを中止しました。');
        return;
      }
      result = applyDayImport(entries, day);
      summary = `${file.name} を ${dayLabel(day)} に取り込みました`;
    }

    save();
    saveEvents();
    resetForm();
    resetEventForm();
    render();
    setStatus(
      `${summary}（タスク ${result.taskCount}件・予定 ${result.eventCount}件）。` +
      (result.conflicts.length
        ? `${result.conflicts.map((name) => `「${name}」`).join('、')}は時間が重なるため配置していません。`
        : '') +
      (skipped ? `${skipped}件は内容が不正なため読み飛ばしました。` : '')
    );
  } catch (error) {
    setStatus(`取り込みに失敗しました：${error.message}`);
  }
}

let statusTimer = 0;

function setStatus(message) {
  el.exportStatus.textContent = message;
  window.clearTimeout(statusTimer);
  if (message) statusTimer = window.setTimeout(() => { el.exportStatus.textContent = ''; }, 6000);
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
      placedAt: null,
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

/* タスク一覧と自動スケジュールだけを空にする。
 * 週間表に配置済みのタスクは、優先順位を保ったままそのまま残す。 */
el.clearPlanning.addEventListener('click', () => {
  if (tasks.length === 0) return;
  const placed = tasks.filter((task) => task.placedAt !== null);
  const message = placed.length
    ? `タスク一覧と自動スケジュールをクリアします。週間表に配置済みの ${placed.length}件は、` +
      'そのまま週間表に残ります（タスク一覧からは消えます）。よろしいですか？'
    : 'タスク一覧と自動スケジュールをクリアします。よろしいですか？';
  if (!window.confirm(message)) return;

  placed.forEach((task) => {
    events.push({
      id: newId('event-'),
      name: task.name,
      day: task.placedAt.day,
      start: task.placedAt.start,
      duration: task.duration,
      priority: task.priority,
    });
  });

  tasks = [];
  save();
  saveEvents();
  resetForm();
  render();
  setBoardStatus(placed.length
    ? `タスク一覧と自動スケジュールをクリアしました（週間表の ${placed.length}件はそのまま残っています）。`
    : 'タスク一覧と自動スケジュールをクリアしました。');
});

el.clear.addEventListener('click', () => {
  if (tasks.length === 0) return;
  if (!window.confirm('すべてのタスクを削除しますか？')) return;
  tasks = [];
  save();
  resetForm();
  render();
});

/* ---------- 予定（優先度なし）の入力 ---------- */

function fillSelectOptions() {
  el.eventDay.textContent = '';
  el.exportDay.textContent = '';
  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const option = document.createElement('option');
    option.value = String(day);
    option.textContent = dayLabel(day);
    el.eventDay.append(option);
    el.exportDay.append(option.cloneNode(true));
  }
  el.importDay.textContent = '';
  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const option = document.createElement('option');
    option.value = String(day);
    option.textContent = dayLabel(day);
    el.importDay.append(option);
  }
  el.eventDay.value = String(todayIndex());
  el.exportDay.value = String(todayIndex());
  el.importDay.value = String(todayIndex());

  el.eventStart.textContent = '';
  for (let start = DAY_START; start < DAY_END; start += SLOT) {
    const option = document.createElement('option');
    option.value = String(start);
    option.textContent = formatTime(start);
    el.eventStart.append(option);
  }
}

function resetEventForm() {
  editingEventId = null;
  el.eventId.value = '';
  el.eventName.value = '';
  el.eventDuration.value = '60';
  el.eventSubmit.textContent = '予定を追加';
  el.eventCancel.hidden = true;
}

function startEventEdit(id) {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  editingEventId = id;
  el.eventId.value = id;
  el.eventName.value = event.name;
  el.eventDay.value = String(event.day);
  el.eventStart.value = String(event.start);
  el.eventDuration.value = String(event.duration);
  el.eventSubmit.textContent = '予定を更新';
  el.eventCancel.hidden = false;
  el.eventName.focus();
}

el.eventForm.addEventListener('submit', (submitEvent) => {
  submitEvent.preventDefault();

  const name = el.eventName.value.trim();
  const day = Number(el.eventDay.value);
  const start = Number(el.eventStart.value);
  const duration = Number(el.eventDuration.value);

  if (!name) {
    setBoardStatus('予定名を入力してください。');
    el.eventName.focus();
    return;
  }
  if (!Number.isFinite(duration) || duration < 5 || duration > MAX_DURATION) {
    setBoardStatus(`所要時間は5分〜${formatDuration(MAX_DURATION)}の範囲で入力してください。`);
    el.eventDuration.focus();
    return;
  }

  const id = editingEventId || `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const issue = placementIssue(name, 'event', id, day, start, duration);
  if (issue) {
    setBoardStatus(issue);
    return;
  }

  const action = editingEventId ? '更新' : '追加';
  let target;
  if (editingEventId) {
    target = events.find((e) => e.id === editingEventId);
    Object.assign(target, { name, day, start, duration });   /* 優先順位は保持する */
  } else {
    target = { id, name, day, start, duration, priority: null };
    events.push(target);
  }

  saveEvents();
  resetEventForm();
  render();
  setBoardStatus(`${eventLabel(target)}を ${dayLabel(day)} ${formatTime(start)} に${action}しました。`);
});

el.eventCancel.addEventListener('click', () => {
  resetEventForm();
  setBoardStatus('予定の編集をキャンセルしました。');
});

el.clearPlacements.addEventListener('click', () => {
  if (!tasks.some((task) => task.placedAt !== null)) return;
  if (!window.confirm('週間スケジュールに配置したタスクをすべて解除しますか？')) return;
  tasks.forEach((task) => { task.placedAt = null; });
  save();
  render();
  setBoardStatus('すべての配置を解除しました。');
});

el.download.addEventListener('click', downloadWorkbook);
el.importFile.addEventListener('change', () => {
  const file = el.importFile.files && el.importFile.files[0];
  if (file) importWorkbook(file);
  el.importFile.value = '';     /* 同じファイルを続けて選べるようにする */
});
el.exportDay.addEventListener('change', renderExport);
document.querySelectorAll('input[name="export-range"]').forEach((radio) => {
  radio.addEventListener('change', renderExport);
});

fillSelectOptions();
resetEventForm();
resetForm();
render();
