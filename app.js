/* 1日のタスクスケジューラー
 * ・自動スケジュール：優先順位（1が最優先）の高いタスクから 7:00〜22:00 に日単位で割り当てる。
 * ・週間スケジュール：タスクと予定を1週間の任意の日時へドラッグ＆ドロップで固定する。
 * tasks 配列の並び順がそのまま優先順位で、変更のたびに 1..n を振り直す。 */
'use strict';

const DAY_START = 7 * 60;   // 7:00 を分に換算
const DAY_END = 22 * 60;    // 22:00
const MAX_DURATION = DAY_END - DAY_START;
const SLOT = 30;            // 週間スケジュールの1コマ（分）
const WEEK_LENGTH = 7;
const HUES = [214, 268, 340, 24, 152, 190, 44, 300];

const LANG_KEY = 'daily-task-scheduler/lang';
const STORAGE_KEY = 'daily-task-scheduler/v3';
const EVENTS_KEY = 'daily-task-scheduler/events/v3';
const LEGACY_STORAGE_KEYS = ['daily-task-scheduler/v2', 'daily-task-scheduler/v1'];
const LEGACY_EVENTS_KEYS = ['daily-task-scheduler/events/v2', 'daily-task-scheduler/events/v1'];

const el = {
  form: document.getElementById('task-form'),
  id: document.getElementById('task-id'),
  name: document.getElementById('task-name'),
  priority: document.getElementById('task-priority'),
  duration: document.getElementById('task-duration'),
  assignee: document.getElementById('task-assignee'),
  due: document.getElementById('task-due'),
  notes: document.getElementById('task-notes'),
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
  lead: document.getElementById('lead'),
  scheduleHeading: document.getElementById('schedule-heading'),
  langSelect: document.getElementById('lang-select'),
  weekLabel: document.getElementById('week-label'),
  calendarHead: document.getElementById('calendar-head'),
  calendarGrid: document.getElementById('calendar-grid'),
  calendarLabel: document.getElementById('calendar-label'),
  calendarStatus: document.getElementById('calendar-status'),
  prevMonth: document.getElementById('prev-month'),
  thisMonth: document.getElementById('this-month'),
  nextMonth: document.getElementById('next-month'),
  prevWeek: document.getElementById('prev-week'),
  thisWeek: document.getElementById('this-week'),
  nextWeek: document.getElementById('next-week'),
  eventForm: document.getElementById('event-form'),
  eventId: document.getElementById('event-id'),
  eventName: document.getElementById('event-name'),
  eventDay: document.getElementById('event-day'),
  eventStart: document.getElementById('event-start'),
  eventAllDay: document.getElementById('event-allday'),
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

/* ---------- 表示言語 ---------- */

let lang = I18N[localStorage.getItem(LANG_KEY)] ? localStorage.getItem(LANG_KEY) : 'ja';

/* 辞書から文言を取り出し、{name} をパラメータで置き換える */
function t(key, params) {
  const text = (I18N[lang] && I18N[lang][key]) || I18N.ja[key] || key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    (params[name] === undefined ? match : String(params[name])));
}

function weekNames() {
  return WEEK_NAMES_BY_LANG[lang] || WEEK_NAMES_BY_LANG.ja;
}

/* 曜日名（日本語・英語のどちらの表記でも受け取る） */
function weekdayIndexOf(text) {
  const cleaned = String(text || '').replace(/曜日?$/, '').trim();
  if (!cleaned) return -1;
  for (const names of Object.values(WEEK_NAMES_BY_LANG)) {
    const index = names.findIndex((name) => name.toLowerCase() === cleaned.toLowerCase());
    if (index >= 0) return index;
  }
  return -1;
}

/* 画面上の固定文言を、いまの言語で書き換える */
function applyStaticText() {
  document.documentElement.lang = lang;
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((node) => {
    node.title = t(node.dataset.i18nTitle);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  });

  el.lead.textContent = t('app.lead', { range: rangeLabel() });
  el.scheduleHeading.textContent = t('schedule.heading', { range: rangeLabel() });
  el.langSelect.value = lang;
}

function setLanguage(next) {
  if (!I18N[next] || next === lang) return;
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch (e) {
    /* 保存できなくても表示は切り替える */
  }
  applyStaticText();
  fillSelectOptions();
  resetForm();
  resetEventForm();
  render();
}

/* ---------- 週（月曜始まり）の日付 ---------- */
/* 配置は日付（YYYY-MM-DD）で保持し、週間表は表示中の週だけを描画する。 */

const THIS_MONDAY = mondayOf(new Date());
let weekOffset = 0;                 // 0＝今週、-1＝前週、1＝翌週
let monthOffset = 0;                // カレンダーで表示中の月（0＝今月）

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function mondayOf(date) {
  const copy = startOfDay(date);
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy;
}

function viewedMonday() {
  const date = new Date(THIS_MONDAY);
  date.setDate(date.getDate() + weekOffset * 7);
  return date;
}

function isoDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function dayDate(index) {
  const date = viewedMonday();
  date.setDate(date.getDate() + index);
  return date;
}

/* 表示中の週の index 番目（0＝月曜）の日付キー */
function dayKey(index) {
  return isoDate(dayDate(index));
}

function keyToDate(key) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  return parts ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])) : null;
}

function todayKey() {
  return isoDate(new Date());
}

function labelOfKey(key, withYear) {
  const date = keyToDate(key);
  if (!date) return key || '';
  const params = {
    y: date.getFullYear(),
    m: date.getMonth() + 1,
    d: date.getDate(),
    w: weekNames()[(date.getDay() + 6) % 7],
  };
  return t(withYear ? 'date.long' : 'date.short', params);
}

function dayLabel(index) {
  return labelOfKey(dayKey(index));
}

function dayLabelLong(index) {
  return labelOfKey(dayKey(index), true);
}

/* 表示中の週で、今日にあたる列（無ければ -1） */
function todayIndex() {
  for (let index = 0; index < WEEK_LENGTH; index += 1) {
    if (dayKey(index) === todayKey()) return index;
  }
  return -1;
}

/* 予定フォームなどの初期値に使う列（今日が週内にないときは月曜） */
function defaultDayIndex() {
  const index = todayIndex();
  return index < 0 ? 0 : index;
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

/* 見出し用の時間帯（例：7:00〜22:00） */
function rangeLabel() {
  const hour = (minutes) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  return t('time.range', { from: hour(DAY_START), to: hour(DAY_END) });
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return t('duration.hm', { h, m });
  if (h) return t('duration.h', { h });
  return t('duration.m', { m });
}

/* 週間スケジュールは30分刻みなので、開始時刻をコマの先頭に合わせる */
function snapToSlot(minutes) {
  return DAY_START + Math.round((minutes - DAY_START) / SLOT) * SLOT;
}

function renumber() {
  tasks.forEach((task, i) => { task.priority = i + 1; });
}

/* ---------- 永続化 ---------- */

function readJson(keys) {
  for (const key of [].concat(keys)) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      /* 壊れているデータは無視して次を試す */
    }
  }
  return null;
}

/* 旧データの曜日番号（0＝月曜）を、今週の日付に読み替える */
function keyFromWeekday(day) {
  const date = new Date(THIS_MONDAY);
  date.setDate(date.getDate() + clamp(Number(day) || 0, 0, WEEK_LENGTH - 1));
  return isoDate(date);
}

/* 配置情報は {date, start}。
 * 旧形式（曜日番号 {day, start} や、分だけの数値）は今週の日付に読み替える。 */
function normalizePlacement(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { date: todayKey(), start: snapToSlot(clamp(value, DAY_START, DAY_END - SLOT)) };
  }
  if (typeof value === 'object' && Number.isFinite(Number(value.start))) {
    const start = snapToSlot(clamp(Number(value.start), DAY_START, DAY_END - SLOT));
    if (keyToDate(value.date)) return { date: value.date, start };
    return { date: keyFromWeekday(value.day), start };
  }
  return null;
}

function load() {
  const stored = readJson([STORAGE_KEY].concat(LEGACY_STORAGE_KEYS)) || [];
  const loaded = stored
    .filter((t) => t && typeof t.name === 'string')
    .map((t, i) => ({
      id: String(t.id || `${Date.now()}-${i}`),
      name: t.name,
      priority: clamp(Number(t.priority) || 1, 1, 99),
      duration: clamp(Number(t.duration) || 30, 5, MAX_DURATION),
      createdAt: Number(t.createdAt) || i,
      placedAt: normalizePlacement(t.placedAt),
      assignee: typeof t.assignee === 'string' ? t.assignee : '',
      due: keyToDate(t.due) ? t.due : '',
      notes: typeof t.notes === 'string' ? t.notes : '',
    }))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  loaded.forEach((task, i) => { task.priority = i + 1; });
  return loaded;
}

function loadEvents() {
  const stored = readJson([EVENTS_KEY].concat(LEGACY_EVENTS_KEYS)) || [];
  return stored
    .filter((e) => e && typeof e.name === 'string' && (e.allDay || Number.isFinite(Number(e.start))))
    .map((e, i) => ({
      id: String(e.id || `event-${Date.now()}-${i}`),
      name: e.name,
      date: keyToDate(e.date) ? e.date : keyFromWeekday(e.day),
      allDay: Boolean(e.allDay),
      start: e.allDay ? null : snapToSlot(clamp(Number(e.start), DAY_START, DAY_END - SLOT)),
      duration: e.allDay ? 0 : clamp(Number(e.duration) || 30, 5, MAX_DURATION),
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

/* 優先順位の順に一日の開始時刻から詰めていく。
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

/* 週間スケジュールに並ぶもの＝配置済みタスクと予定（すべての週） */
function allBoardItems() {
  const placedTasks = tasks
    .filter((task) => task.placedAt !== null)
    .map((task) => ({
      kind: 'task',
      id: task.id,
      name: task.name,
      date: task.placedAt.date,
      start: task.placedAt.start,
      duration: task.duration,
      priority: task.priority,
    }));
  const eventItems = events.filter((event) => !event.allDay).map((event) => ({
    kind: 'event',
    id: event.id,
    name: event.name,
    date: event.date,
    start: event.start,
    duration: event.duration,
    priority: event.priority || null,
  }));
  return placedTasks.concat(eventItems);
}

/* date を渡すとその日、省略すると表示中の週の項目を返す */
function boardItems(date) {
  const keys = date === undefined
    ? new Set(Array.from({ length: WEEK_LENGTH }, (unused, i) => dayKey(i)))
    : new Set([date]);
  return allBoardItems()
    .filter((item) => keys.has(item.date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start));
}

/* 指定日の終日の予定（登録順） */
function allDayEvents(date) {
  return events.filter((event) => event.allDay && event.date === date);
}

function isFree(kind, id, date, start, duration) {
  return boardItems(date).every((item) => {
    if (item.kind === kind && item.id === id) return true;
    return start >= occupiedEnd(item.start, item.duration) ||
      occupiedEnd(start, duration) <= item.start;
  });
}

/* 配置できない理由を返す（配置できる場合は null） */
function placementIssue(name, kind, id, date, start, duration) {
  if (start < DAY_START || occupiedEnd(start, duration) > DAY_END) {
    return t('board.overEnd', { name, end: formatTime(DAY_END) });
  }
  if (!isFree(kind, id, date, start, duration)) {
    return t('board.overlap', { name, date: labelOfKey(date) });
  }
  return null;
}

function placeItem(kind, id, date, start) {
  if (kind === 'event') return moveEvent(id, date, start);

  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  const issue = placementIssue(task.name, 'task', id, date, start, task.duration);
  if (issue) {
    setBoardStatus(issue);
    return;
  }

  task.placedAt = { date, start };
  save();
  render();
  setBoardStatus(t('board.placed', { name: task.name, date: labelOfKey(date), time: formatTime(start) }));
}

/* 一覧から外したタスク（優先順位あり）は「予定」と呼ばないようにする */
function eventLabel(event) {
  return t(event.priority ? 'event.labelPriority' : 'event.label', { name: event.name });
}

function moveEvent(id, date, start) {
  const event = events.find((e) => e.id === id);
  if (!event) return;

  /* 終日の予定は時間帯を持たないので、日付だけを移す */
  if (event.allDay) {
    event.date = date;
    saveEvents();
    render();
    setBoardStatus(t('board.allDayMoved', { label: eventLabel(event), date: labelOfKey(date) }));
    return;
  }

  const issue = placementIssue(event.name, 'event', id, date, start, event.duration);
  if (issue) {
    setBoardStatus(issue);
    return;
  }

  event.date = date;
  event.start = start;
  saveEvents();
  render();
  setBoardStatus(t('board.moved', { label: eventLabel(event), date: labelOfKey(date), time: formatTime(start) }));
}

function unplaceTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.placedAt === null) return;
  task.placedAt = null;
  save();
  render();
  setBoardStatus(t('board.unplaced', { name: task.name }));
}

function removeEvent(id) {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  if (!window.confirm(t('event.confirmDelete', { label: eventLabel(event) }))) return;
  const label = eventLabel(event);
  events = events.filter((e) => e.id !== id);
  if (editingEventId === id) resetEventForm();
  saveEvents();
  render();
  setBoardStatus(t('event.deleted', { label }));
}

/* 所要時間の変更などで配置が成立しなくなったタスクは解除する（予定は動かさない） */
function validatePlacements() {
  const fixed = events
    .filter((event) => !event.allDay)
    .map((event) => ({ date: event.date, start: event.start, duration: event.duration }));
  const dropped = [];

  tasks
    .filter((task) => task.placedAt !== null)
    .sort((a, b) => (a.placedAt.date < b.placedAt.date ? -1
      : a.placedAt.date > b.placedAt.date ? 1 : a.placedAt.start - b.placedAt.start))
    .forEach((task) => {
      const { date, start } = task.placedAt;
      const fits = start >= DAY_START &&
        (start - DAY_START) % SLOT === 0 &&
        occupiedEnd(start, task.duration) <= DAY_END;
      const overlaps = fixed.some((item) => item.date === date &&
        !(start >= occupiedEnd(item.start, item.duration) ||
          occupiedEnd(start, task.duration) <= item.start));
      if (fits && !overlaps) {
        fixed.push({ date, start, duration: task.duration });
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
    el.dialogMessage.textContent = t('conflict.message', { rank, name: rival.name });
    fillChoice(el.chooseMoving, moving, rank);
    fillChoice(el.chooseExisting, rival, rank);

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

function fillChoice(button, task, rank) {
  button.textContent = '';
  const name = document.createElement('strong');
  name.textContent = t('conflict.choice', { name: task.name });
  const meta = document.createElement('span');
  meta.textContent = t('conflict.choiceMeta', { duration: formatDuration(task.duration), rank });
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
  renderCalendar();
  renderSummary(plan);
  renderExport();
  if (dropped.length) {
    save();
    setBoardStatus(t('board.dropped', { names: joinNames(dropped) }));
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
    rank.title = t('list.rankTitle', { priority: task.priority });

    const body = document.createElement('div');
    body.className = 'task-body';
    const name = document.createElement('span');
    name.className = 'task-name';
    name.textContent = task.name;
    const meta = document.createElement('span');
    meta.className = 'task-meta';
    meta.textContent = t('list.itemMeta', { priority: task.priority, duration: formatDuration(task.duration) });
    body.append(name, meta);

    if (task.assignee || task.due) {
      const badges = document.createElement('span');
      badges.className = 'task-badges';
      if (task.assignee) badges.append(makeSpan(t('task.assignee', { name: task.assignee }), 'badge is-assignee'));
      const dueBadge = makeDueBadge(task.due);
      if (dueBadge) badges.append(dueBadge);
      body.append(badges);
    }

    if (task.notes) {
      const notes = makeSpan(task.notes, 'task-notes');
      notes.title = task.notes;
      body.append(notes);
    }

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    const recipients = extractEmails(task.assignee);
    if (recipients.length > 0) {
      const label = recipients.length > 1
        ? t('task.requestMany', { n: recipients.length })
        : t('task.request');
      const button = makeButton(label, () => openRequestMail(task),
        t('task.requestAria', { name: task.name }));
      button.title = recipients.join(', ');
      actions.append(button);
    }
    actions.append(
      makeButton(t('common.edit'), () => startEdit(task.id), t('list.editAria', { name: task.name })),
      makeButton(t('common.delete'), () => removeTask(task.id), t('list.deleteAria', { name: task.name }), true)
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
    slot.title = `${t('time.range', { from: formatTime(entry.start), to: formatTime(entry.end) })}　${entry.task.name}`;
    el.timeline.append(slot);
  });

  if (plan.freeMinutes > 0) {
    const free = document.createElement('div');
    free.className = 'slot free';
    free.style.flexGrow = String(plan.freeMinutes);
    free.style.flexBasis = '0';
    free.textContent = plan.scheduled.length ? t('schedule.freeShort') : t('schedule.dayEmpty', { range: rangeLabel() });
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
    cell.textContent = t('schedule.empty');
    row.append(cell);
    el.scheduleBody.append(row);
    return;
  }

  plan.scheduled.forEach((entry) => {
    el.scheduleBody.append(
      makeTaskRow(entry.task, t('time.rangeSpaced', {
        from: formatTime(entry.start),
        to: formatTime(entry.end),
      }))
    );
  });

  if (plan.freeMinutes > 0 && plan.scheduled.length > 0) {
    const last = plan.scheduled[plan.scheduled.length - 1].end;
    const row = document.createElement('tr');
    row.className = 'gap';
    row.append(
      makeCell('', 'handle-cell'),
      makeCell(t('time.rangeSpaced', { from: formatTime(last), to: formatTime(DAY_END) }), 'time'),
      makeCell(t('common.dash')),
      makeCell(t('schedule.free')),
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
    cell.textContent = t('schedule.unscheduled', { range: rangeLabel() });
    head.append(cell);
    el.scheduleBody.append(head);

    plan.unscheduled.forEach((task) => {
      el.scheduleBody.append(makeTaskRow(task, t('common.dash'), true));
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
      label: t('schedule.priorityAria', { name: task.name }),
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
      label: t('schedule.durationAria', { name: task.name }),
      onCommit: (value) => changeDuration(task.id, value),
    }),
    makeSpan(formatDuration(task.duration), 'cell-note')
  );

  const nameCell = makeCell(task.name);
  if (task.notes) nameCell.title = task.notes;
  if (task.assignee) nameCell.append(makeSpan(t('task.assignee', { name: task.assignee }), 'badge is-assignee'));
  const dueBadge = makeDueBadge(task.due);
  if (dueBadge) nameCell.append(dueBadge);
  if (task.placedAt !== null) {
    nameCell.append(
      makeSpan(t('schedule.placedBadge', {
        date: labelOfKey(task.placedAt.date),
        time: formatTime(task.placedAt.start),
      }), 'badge')
    );
  }

  const addCell = document.createElement('td');
  addCell.className = 'add-cell';
  const daySelect = document.createElement('select');
  daySelect.className = 'cell-select';
  daySelect.setAttribute('aria-label', t('schedule.dayAria', { name: task.name }));
  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const option = document.createElement('option');
    option.value = dayKey(day);
    option.textContent = dayLabel(day);
    daySelect.append(option);
  }
  const placedInWeek = task.placedAt &&
    Array.from({ length: WEEK_LENGTH }, (unused, i) => dayKey(i)).includes(task.placedAt.date);
  daySelect.value = placedInWeek ? task.placedAt.date : dayKey(defaultDayIndex());

  /* 時刻は「自動」（自動スケジュールの時刻、埋まっていれば最も早い空き）か、30分刻みの指定 */
  const timeSelect = document.createElement('select');
  timeSelect.className = 'cell-select';
  timeSelect.setAttribute('aria-label', t('schedule.timeAria', { name: task.name }));
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('schedule.autoTime');
  timeSelect.append(auto);
  for (let start = DAY_START; start < DAY_END; start += SLOT) {
    const option = document.createElement('option');
    option.value = String(start);
    option.textContent = formatTime(start);
    timeSelect.append(option);
  }
  timeSelect.value = placedInWeek ? String(task.placedAt.start) : '';

  addCell.append(
    daySelect,
    timeSelect,
    makeButton(
      t('common.add'),
      () => addTaskToDay(task.id, daySelect.value, timeSelect.value),
      t('schedule.addAria', { name: task.name })
    )
  );

  row.append(handleCell, makeCell(timeLabel, 'time'), priorityCell, nameCell, durationCell, addCell);
  return row;
}

/* 選んだ日時に配置する。時刻が「自動」のときは、
 * 自動スケジュールの時刻を優先し、埋まっていればその日の最も早い空き時間に置く。 */
function addTaskToDay(id, date, time) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;

  if (time !== '' && time !== undefined && time !== null) {
    placeItem('task', id, date, Number(time));
    return;
  }

  const entry = buildSchedule().scheduled.find((item) => item.task.id === id);
  const preferred = entry ? snapToSlot(entry.start) : DAY_START;
  const candidates = [preferred];
  for (let start = DAY_START; start < DAY_END; start += SLOT) candidates.push(start);

  const target = candidates.find((start) =>
    placementIssue(task.name, 'task', id, date, start, task.duration) === null);

  if (target === undefined) {
    setBoardStatus(t('board.noRoom', {
      date: labelOfKey(date),
      name: task.name,
      duration: formatDuration(task.duration),
    }));
    return;
  }
  placeItem('task', id, date, target);
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
  renderWeekLabel();
  el.boardHead.textContent = '';
  el.board.textContent = '';

  const headTime = document.createElement('th');
  headTime.scope = 'col';
  headTime.textContent = t('board.colTime');
  el.boardHead.append(headTime);

  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = dayLabel(day);
    if (day === todayIndex()) cell.className = 'is-today';
    el.boardHead.append(cell);
  }

  const byStart = new Map();   // `${date}:${slotIndex}` -> item
  const covered = new Set();
  boardItems().forEach((item) => {
    const index = Math.round((item.start - DAY_START) / SLOT);
    byStart.set(`${item.date}:${index}`, item);
    for (let i = index; i < index + slotSpan(item.duration); i += 1) covered.add(`${item.date}:${i}`);
  });

  el.clearPlacements.hidden = !tasks.some((task) => task.placedAt !== null);

  el.board.append(makeAllDayRow());

  const slotCount = (DAY_END - DAY_START) / SLOT;
  for (let index = 0; index < slotCount; index += 1) {
    const start = DAY_START + index * SLOT;
    const row = document.createElement('tr');
    row.append(makeCell(t('time.rangeSpaced', {
      from: formatTime(start),
      to: formatTime(start + SLOT),
    }), 'time'));

    for (let day = 0; day < WEEK_LENGTH; day += 1) {
      const date = dayKey(day);
      const item = byStart.get(`${date}:${index}`);
      if (item) {
        row.append(makeBoardCell(item, Math.min(slotSpan(item.duration), slotCount - index)));
      } else if (!covered.has(`${date}:${index}`)) {
        row.append(makeDropCell(date, start, day === todayIndex()));
      }
    }
    el.board.append(row);
  }
}

/* 表示中の週の範囲（例：2026/8/17（月） 〜 2026/8/23（日）） */
function weekRangeLabel() {
  return t('date.range', { from: dayLabelLong(0), to: dayLabelLong(WEEK_LENGTH - 1) });
}

/* 「」で囲んだ名前を並べる（英語版は引用符とカンマ区切り） */
function joinNames(names) {
  const quote = lang === 'ja' ? ['「', '」'] : ['“', '”'];
  return names.map((name) => `${quote[0]}${name}${quote[1]}`).join(t('common.listSeparator'));
}

function renderWeekLabel() {
  const weekKeys = new Set(Array.from({ length: WEEK_LENGTH }, (unused, i) => dayKey(i)));
  const others = allBoardItems().filter((item) => !weekKeys.has(item.date)).length;

  el.weekLabel.textContent = weekRangeLabel() +
    (weekOffset === 0 ? t('board.thisWeek')
      : weekOffset === -1 ? t('board.lastWeek')
        : weekOffset === 1 ? t('board.nextWeek') : '');
  if (others > 0) {
    el.weekLabel.append(makeSpan(t('board.otherWeeks', { n: others }), 'other-week'));
  }
  el.thisWeek.classList.toggle('is-current', weekOffset === 0);
  el.thisWeek.disabled = weekOffset === 0;
}

/* 週を切り替える。日の選択肢も表示中の週に合わせ直す。 */
function showWeek(offset) {
  weekOffset = offset;
  fillSelectOptions();
  resetEventForm();
  render();
  setBoardStatus(t('board.showingWeek', { range: weekRangeLabel() }));
}

/* 週間表のいちばん上に置く終日の行。1日に何件でも並べられる。 */
function makeAllDayRow() {
  const row = document.createElement('tr');
  row.className = 'allday-row';
  row.append(makeCell(t('board.allDay'), 'time'));

  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const date = dayKey(day);
    const cell = document.createElement('td');
    cell.className = 'allday-cell drop-cell' + (day === todayIndex() ? ' is-today' : '');
    cell.dataset.date = date;
    cell.dataset.allday = '1';
    cell.setAttribute('aria-label', t('board.allDayCellAria', { date: labelOfKey(date) }));

    allDayEvents(date).forEach((event) => cell.append(makeAllDayChip(event)));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'allday-add';
    add.textContent = '＋';
    add.setAttribute('aria-label', t('board.allDayAddAria', { date: labelOfKey(date) }));
    add.addEventListener('click', () => startAllDayEntry(date));
    cell.append(add);

    row.append(cell);
  }
  return row;
}

function makeAllDayChip(event) {
  const chip = document.createElement('div');
  chip.className = 'allday-chip';
  chip.dataset.itemId = event.id;

  chip.append(makeDragHandle('event', event.id, event.name, chip));

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'allday-name';
  name.textContent = event.name;
  name.title = t('event.editAria', { name: event.name });
  name.addEventListener('click', () => startEventEdit(event.id));
  chip.append(name);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'allday-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', t('event.deleteAria', { name: event.name }));
  remove.addEventListener('click', () => removeEvent(event.id));
  chip.append(remove);

  return chip;
}

/* 終日の枠の「＋」から、その日の終日の予定を入力する */
function startAllDayEntry(date) {
  resetEventForm();
  el.eventAllDay.checked = true;
  el.eventDay.value = date;
  syncAllDayFields();
  el.eventName.focus();
  setBoardStatus(t('board.dropClicked', { date: labelOfKey(date), time: t('board.allDay') }));
}

/* 終日にチェックが入っている間は、開始時刻と所要時間を使わない */
function syncAllDayFields() {
  const allDay = el.eventAllDay.checked;
  el.eventStart.disabled = allDay;
  el.eventDuration.disabled = allDay;
}

function makeBoardCell(item, span) {
  const cell = document.createElement('td');
  cell.className = 'placed-cell' + (item.date === todayKey() ? ' is-today' : '');
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
    ? t('board.eventDetail', { duration: formatDuration(item.duration) })
    : t('board.taskDetail', { priority: item.priority, duration: formatDuration(item.duration) });
  const timeText = t('time.range', {
    from: formatTime(item.start),
    to: formatTime(item.start + item.duration),
  });
  body.append(name, makeSpan(`${timeText}　${detail}`, 'placed-meta'));

  const source = item.kind === 'task' ? tasks.find((task) => task.id === item.id) : null;
  if (source && (source.assignee || source.due)) {
    const extra = [
      source.assignee ? t('task.assignee', { name: source.assignee }) : '',
      source.due ? t('task.due', { date: labelOfKey(source.due) }) : '',
    ].filter(Boolean).join('　');
    body.append(makeSpan(extra, 'placed-meta'));
  }
  if (source && source.notes) block.title = source.notes;

  const actions = document.createElement('div');
  actions.className = 'placed-actions';
  if (item.kind === 'event') {
    actions.append(
      makeButton(t('common.edit'), () => startEventEdit(item.id), t('event.editAria', { name: item.name })),
      makeButton(t('common.delete'), () => removeEvent(item.id), t('event.deleteAria', { name: item.name }), true)
    );
  } else {
    actions.append(makeButton(t('common.release'), () => unplaceTask(item.id), t('board.releaseAria', { name: item.name })));
  }

  block.append(makeDragHandle(item.kind, item.id, item.name, block), body, actions);
  cell.append(block);
  return cell;
}

function makeDropCell(date, start, isToday) {
  const cell = document.createElement('td');
  cell.className = 'drop-cell' + (isToday ? ' is-today' : '');
  cell.dataset.date = date;
  cell.dataset.start = String(start);
  cell.title = t('board.dropTitle', { date: labelOfKey(date), time: formatTime(start) });

  /* 空きコマをタップ／クリックすると、その日時で予定フォームを開く
   * （ドラッグ直後に合成されるクリックは無視する） */
  cell.addEventListener('click', () => {
    if (dragState || Date.now() - dragEndedAt < 400) return;
    el.eventDay.value = date;
    el.eventStart.value = String(start);
    el.eventName.focus();
    setBoardStatus(t('board.dropClicked', { date: labelOfKey(date), time: formatTime(start) }));
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
  handle.setAttribute('aria-label', t('board.dragAria', { name }));
  handle.title = t('board.dragTitle');
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
  if (!cell) return;

  if (cell.dataset.allday === '1') {
    const event = events.find((e) => e.id === id);
    if (kind !== 'event' || !event || !event.allDay) {
      setBoardStatus(t('board.allDayOnly'));
      return;
    }
    moveEvent(id, cell.dataset.date, null);
    return;
  }

  const dropped = events.find((e) => e.id === id);
  if (kind === 'event' && dropped && dropped.allDay) {
    setBoardStatus(t('board.allDayOnly'));
    return;
  }
  placeItem(kind, id, cell.dataset.date, Number(cell.dataset.start));
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

/* ---------- 月間カレンダー ---------- */

const CALENDAR_ROWS = 6;
const MAX_CHIPS = 3;

function viewedMonthStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  date.setMonth(date.getMonth() + monthOffset);
  return date;
}

function renderCalendar() {
  const monthStart = viewedMonthStart();
  const monthIndex = monthStart.getMonth();

  el.calendarLabel.textContent = t('calendar.month', {
    y: monthStart.getFullYear(),
    m: monthIndex + 1,
    monthName: (MONTH_NAMES_BY_LANG[lang] || MONTH_NAMES_BY_LANG.ja)[monthIndex],
  });
  el.thisMonth.classList.toggle('is-current', monthOffset === 0);
  el.thisMonth.disabled = monthOffset === 0;

  el.calendarHead.textContent = '';
  weekNames().forEach((name, index) => {
    const cell = document.createElement('div');
    cell.className = 'calendar-weekday' + (index >= 5 ? ' is-weekend' : '');
    cell.textContent = name;
    el.calendarHead.append(cell);
  });

  /* 月の1日を含む週の月曜から6週間分を並べる */
  const first = mondayOf(monthStart);
  const itemsByDate = new Map();
  const push = (item) => {
    if (!itemsByDate.has(item.date)) itemsByDate.set(item.date, []);
    itemsByDate.get(item.date).push(item);
  };
  events.filter((event) => event.allDay).forEach((event) => push({
    kind: 'event',
    id: event.id,
    name: event.name,
    date: event.date,
    start: null,
    duration: 0,
    priority: null,
  }));
  allBoardItems().forEach(push);

  el.calendarGrid.textContent = '';
  for (let i = 0; i < CALENDAR_ROWS * WEEK_LENGTH; i += 1) {
    const date = new Date(first);
    date.setDate(date.getDate() + i);
    el.calendarGrid.append(makeCalendarCell(date, monthIndex, itemsByDate));
  }
}

function makeCalendarCell(date, monthIndex, itemsByDate) {
  const key = isoDate(date);
  /* 終日の予定を先に、そのあと開始時刻の順に並べる */
  const items = (itemsByDate.get(key) || []).slice().sort((a, b) => {
    if (a.start === null) return b.start === null ? 0 : -1;
    if (b.start === null) return 1;
    return a.start - b.start;
  });
  const weekday = (date.getDay() + 6) % 7;

  const cell = document.createElement('button');
  cell.type = 'button';
  cell.className = 'calendar-day' +
    (date.getMonth() === monthIndex ? '' : ' is-other-month') +
    (key === todayKey() ? ' is-today' : '') +
    (weekday >= 5 ? ' is-weekend' : '');
  cell.dataset.date = key;
  cell.setAttribute('aria-label', t('calendar.dayAria', { date: labelOfKey(key, true), n: items.length }));
  cell.addEventListener('click', () => showWeekOf(key));

  const head = document.createElement('span');
  head.className = 'calendar-date';
  head.textContent = String(date.getDate());
  cell.append(head);

  if (key === todayKey()) {
    cell.append(makeSpan(t('calendar.today'), 'calendar-today'));
  }

  items.slice(0, MAX_CHIPS).forEach((item) => {
    const chip = document.createElement('span');
    const isAllDay = item.start === null;
    chip.className = 'calendar-chip' +
      (item.kind === 'event' && !item.priority ? ' is-event' : '') +
      (isAllDay ? ' is-allday' : '');
    chip.textContent = isAllDay
      ? `${t('board.allDay')} ${item.name}`
      : `${formatTime(item.start)} ${item.name}`;
    chip.title = isAllDay ? `${t('board.allDay')}　${item.name}` : `${t('time.range', {
      from: formatTime(item.start),
      to: formatTime(item.start + item.duration),
    })}　${item.name}`;
    cell.append(chip);
  });

  if (items.length > MAX_CHIPS) {
    cell.append(makeSpan(t('calendar.more', { n: items.length - MAX_CHIPS }), 'calendar-more'));
  }

  return cell;
}

/* カレンダーの日付から、その週を週間スケジュールに表示する */
function showWeekOf(key) {
  const date = keyToDate(key);
  if (!date) return;
  const diff = Math.round((mondayOf(date) - THIS_MONDAY) / (7 * 24 * 60 * 60 * 1000));
  weekOffset = diff;
  fillSelectOptions();
  resetEventForm();
  render();
  setCalendarStatus(t('calendar.jumped', { date: labelOfKey(key, true) }));
  document.getElementById('board-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

let calendarStatusTimer = 0;

function setCalendarStatus(message) {
  el.calendarStatus.textContent = message;
  window.clearTimeout(calendarStatusTimer);
  if (message) {
    calendarStatusTimer = window.setTimeout(() => { el.calendarStatus.textContent = ''; }, 4000);
  }
}

function showMonth(offset) {
  monthOffset = offset;
  renderCalendar();
}

function renderSummary(plan) {
  el.summary.textContent = '';
  const used = plan.scheduled.reduce((sum, entry) => sum + entry.task.duration, 0);
  const rows = [
    [t('summary.tasks'), t('common.count', { n: tasks.length })],
    [t('summary.scheduled'), t('summary.scheduledValue', {
      n: plan.scheduled.length,
      duration: formatDuration(used),
    })],
    [t('summary.free'), formatDuration(plan.freeMinutes)],
  ];
  if (plan.unscheduled.length) {
    rows.push([t('summary.unscheduled'), t('common.count', { n: plan.unscheduled.length })]);
  }

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

function exportHeader() {
  return ['excel.colKind', 'excel.colDay', 'excel.colDate', 'excel.colStart',
    'excel.colEnd', 'excel.colName', 'excel.colPriority', 'excel.colDuration',
    'excel.colDue', 'excel.colAssignee', 'excel.colNotes'].map((key) => t(key));
}
const EXPORT_WIDTHS = [8, 8, 12, 8, 8, 30, 10, 14, 12, 16, 40];

function exportRange() {
  const checked = document.querySelector('input[name="export-range"]:checked');
  return checked ? checked.value : 'day';
}

function selectedDate() {
  return keyToDate(el.exportDay.value) ? el.exportDay.value : dayKey(defaultDayIndex());
}

/* 出力する行。週単位は1週間分＋未配置タスク、日単位はその日の分＋未配置タスク。 */
/* 終日の予定も、開始時刻の欄を「終日」にして同じ表に並べる */
function allDayRows(dates) {
  return events
    .filter((event) => event.allDay && (dates === null || dates.has(event.date)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((event) => [
      t('excel.kindEvent'),
      weekNames()[(keyToDate(event.date).getDay() + 6) % 7],
      event.date,
      t('excel.allDay'),
      '',
      event.name,
      '',
      '',
      '',
      '',
      '',
    ]);
}

/* 週間表の項目から、元のタスクの追加情報を取り出す（予定は空欄） */
function taskFieldOf(item, field) {
  if (item.kind !== 'task') return '';
  const task = tasks.find((t) => t.id === item.id);
  return (task && task[field]) || '';
}

function exportRows() {
  const range = exportRange();
  const items = range === 'all'
    ? allBoardItems().slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start - b.start))
    : range === 'week' ? boardItems() : boardItems(selectedDate());

  const dates = range === 'all' ? null
    : range === 'week'
      ? new Set(Array.from({ length: WEEK_LENGTH }, (unused, i) => dayKey(i)))
      : new Set([selectedDate()]);

  const rows = allDayRows(dates).concat(items.map((item) => [
    t(item.kind === 'event' && !item.priority ? 'excel.kindEvent' : 'excel.kindTask'),
    weekNames()[(keyToDate(item.date).getDay() + 6) % 7],
    item.date,
    formatTime(item.start),
    formatTime(item.start + item.duration),
    item.name,
    item.priority || '',
    item.duration,
    taskFieldOf(item, 'due'),
    taskFieldOf(item, 'assignee'),
    taskFieldOf(item, 'notes'),
  ]));

  tasks
    .filter((task) => task.placedAt === null)
    .forEach((task) => {
      rows.push([t('excel.kindTask'), '', '', '', '', task.name, task.priority, task.duration,
        task.due || '', task.assignee || '', task.notes || '']);
    });

  return rows;
}

function renderExport() {
  el.exportDay.disabled = exportRange() !== 'day';

  const rows = exportRows();
  el.exportBody.textContent = '';

  if (rows.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = exportHeader().length;
    cell.className = 'center';
    cell.textContent = t('excel.previewEmpty');
    row.append(cell);
    el.exportBody.append(row);
    return;
  }

  rows.forEach((cells) => {
    const row = document.createElement('tr');
    if (cells[1] === '') row.className = 'unplaced-row';
    cells.forEach((value) => row.append(makeCell(value === '' ? t('common.dash') : String(value))));
    el.exportBody.append(row);
  });
}

function downloadWorkbook() {
  const range = exportRange();
  const rangeName = t(range === 'all' ? 'excel.all' : range === 'week' ? 'excel.week' : 'excel.day');
  const sheetName = range === 'all' ? t('excel.sheetAll')
    : range === 'week' ? t('excel.sheetWeek') : selectedDate();
  const title = range === 'all'
    ? t('excel.titleAll')
    : range === 'week'
      ? t('excel.titleWeek', { range: weekRangeLabel() })
      : t('excel.titleDay', { date: labelOfKey(selectedDate(), true) });

  const rows = [[title], [t('excel.rangeRow'), rangeName], exportHeader()].concat(exportRows());
  const blob = XLSX.build(sheetName, rows, EXPORT_WIDTHS);
  const fileName = range === 'all'
    ? `schedule-all-${isoDate(new Date())}.xlsx`
    : range === 'week'
      ? `schedule-week-${dayKey(0)}.xlsx`
      : `schedule-${selectedDate()}.xlsx`;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setStatus(t('excel.downloaded', { file: fileName }));
}

/* 取り込み：出力した表と同じ見出しを探し、その下の行を読み込む */
function parseRows(rows) {
  const hasAlias = (cells, key) => XLSX_ALIASES[key].some((label) => cells.includes(label));
  const headerIndex = rows.findIndex((cells) => hasAlias(cells, 'kind') && hasAlias(cells, 'name'));
  if (headerIndex < 0) {
    throw new Error(t('excel.errorHeader'));
  }

  const header = rows[headerIndex];
  const column = (key) => {
    for (const label of XLSX_ALIASES[key]) {
      const index = header.indexOf(label);
      if (index >= 0) return index;
    }
    return -1;
  };
  const columns = {
    kind: column('kind'),
    day: column('day'),
    date: column('date'),
    start: column('start'),
    name: column('name'),
    priority: column('priority'),
    duration: column('duration'),
    due: column('due'),
    assignee: column('assignee'),
    notes: column('notes'),
  };
  if (columns.name < 0 || columns.duration < 0) {
    throw new Error(t('excel.errorColumns'));
  }

  const entries = [];
  let skipped = 0;

  rows.slice(headerIndex + 1).forEach((cells) => {
    const value = (key) => (columns[key] >= 0 ? (cells[columns[key]] || '').trim() : '');
    const name = value('name');
    if (!name) return;

    const isAllDay = XLSX_ALIASES.allDay.includes(value('start'));
    const duration = Number(value('duration'));
    if (!isAllDay && (!Number.isFinite(duration) || duration < 5)) {
      skipped += 1;
      return;
    }

    const dayIndex = weekdayIndexOf(value('day'));
    const startMatch = /^(\d{1,2}):(\d{2})$/.exec(value('start'));
    const start = startMatch
      ? snapToSlot(clamp(Number(startMatch[1]) * 60 + Number(startMatch[2]), DAY_START, DAY_END - SLOT))
      : null;

    /* 日付があればそれを使い、無ければ曜日を表示中の週に当てはめる */
    const dateCell = value('date');
    const date = keyToDate(dateCell) ? dateCell : (dayIndex >= 0 ? dayKey(dayIndex) : null);
    const placed = date !== null && (start !== null || isAllDay);
    const kind = XLSX_ALIASES.event.includes(value('kind')) || isAllDay ? 'event' : 'task';

    if (kind === 'event' && !placed) {
      skipped += 1;
      return;
    }

    const dueCell = value('due');
    entries.push({
      kind,
      name,
      due: keyToDate(dueCell) ? dueCell : '',
      assignee: value('assignee'),
      notes: value('notes'),
      allDay: isAllDay,
      duration: isAllDay ? 0 : clamp(duration, 5, MAX_DURATION),
      priority: Number(value('priority')) || null,
      date: placed ? date : null,
      start: isAllDay ? null : (placed ? start : null),
    });
  });

  return { entries, skipped, range: detectRange(rows, headerIndex, entries) };
}

/* 日単位か週単位かの判定。出力時に入れた「範囲」の行を優先し、
 * 無い場合はタイトルや曜日の散らばりから推測する。 */
function detectRange(rows, headerIndex, entries) {
  const includesAny = (value, key) => XLSX_ALIASES[key].some((word) => value.includes(word));
  for (const cells of rows.slice(0, headerIndex)) {
    const index = XLSX_ALIASES.rangeRow.reduce(
      (found, label) => (found >= 0 ? found : cells.indexOf(label)), -1);
    if (index >= 0 && cells[index + 1]) {
      const value = cells[index + 1];
      if (includesAny(value, 'all')) return 'all';
      return includesAny(value, 'week') ? 'week' : 'day';
    }
    const title = cells.find((cell) => typeof cell === 'string' && cell);
    if (title) {
      if (title.includes('すべてのタスク') || title.includes('All tasks')) return 'all';
      if (title.includes('週間スケジュール') || title.includes('Weekly schedule')) return 'week';
    }
  }

  /* 「範囲」の行が無いファイルは、日付の散らばりから推測する */
  const dates = Array.from(new Set(entries.filter((entry) => entry.date !== null).map((entry) => entry.date)));
  if (dates.length <= 1) return 'day';
  const weeks = new Set(dates.map((date) => isoDate(mondayOf(keyToDate(date)))));
  return weeks.size > 1 ? 'all' : 'week';
}

function newId(prefix) {
  return `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/* すべて：タスクと予定をまるごと置き換える */
function applyAllImport(entries) {
  const importedTasks = [];
  const importedEvents = [];

  entries.forEach((entry, index) => {
    if (entry.kind === 'event') {
      importedEvents.push({
        id: newId('event-'),
        name: entry.name,
        date: entry.date,
        allDay: Boolean(entry.allDay),
        start: entry.start,
        duration: entry.duration,
        priority: entry.priority,
      });
    } else {
      importedTasks.push({
        id: newId(''),
        name: entry.name,
        priority: entry.priority || importedTasks.length + 1,
        duration: entry.duration,
        createdAt: Date.now() + index,
        placedAt: entry.date === null ? null : { date: entry.date, start: entry.start },
        assignee: entry.assignee || '',
        due: entry.due || '',
        notes: entry.notes || '',
      });
    }
  });

  importedTasks.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  tasks = importedTasks;
  events = importedEvents;
  renumber();
  return { taskCount: importedTasks.length, eventCount: importedEvents.length, conflicts: [] };
}

/* 日単位・週単位：対象の日付だけを入れ替える（他の日はそのまま）。
 * 同じ名前のタスクは既存のものを使い回し、無ければ新しく追加する。
 * resolveDate は、行をどの日付に置くかを返す（未配置の行は null）。 */
function applyPartialImport(entries, clearDates, resolveDate) {
  const cleared = new Set(clearDates);
  tasks.forEach((task) => {
    if (task.placedAt && cleared.has(task.placedAt.date)) task.placedAt = null;
  });
  events = events.filter((event) => !cleared.has(event.date));

  const conflicts = [];
  let taskCount = 0;
  let eventCount = 0;

  entries.forEach((entry) => {
    const date = resolveDate(entry);

    if (entry.kind === 'event') {
      if (date === null) return;
      const id = newId('event-');
      if (entry.allDay) {
        events.push({ id, name: entry.name, date, allDay: true, start: null, duration: 0, priority: null });
        eventCount += 1;
        return;
      }
      if (placementIssue(entry.name, 'event', id, date, entry.start, entry.duration)) {
        conflicts.push(entry.name);
        return;
      }
      events.push({
        id, name: entry.name, date, allDay: false, start: entry.start, duration: entry.duration, priority: null,
      });
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
        assignee: entry.assignee || '',
        due: entry.due || '',
        notes: entry.notes || '',
      };
      tasks.push(task);
      renumber();
    } else {
      task.duration = entry.duration;
      if (entry.assignee) task.assignee = entry.assignee;
      if (entry.due) task.due = entry.due;
      if (entry.notes) task.notes = entry.notes;
    }
    taskCount += 1;

    if (date !== null && entry.start !== null) {
      if (placementIssue(task.name, 'task', task.id, date, entry.start, task.duration)) {
        conflicts.push(task.name);
        return;
      }
      task.placedAt = { date, start: entry.start };
    }
  });

  return { taskCount, eventCount, conflicts };
}

/* 取り込む曜日を選ぶダイアログ。戻り値は曜日の番号か null（キャンセル）。 */
function askImportDay(message, defaultDate) {
  return new Promise((resolve) => {
    el.importMessage.textContent = message;
    el.importDay.value = Array.from(el.importDay.options).some((option) => option.value === defaultDate)
      ? defaultDate
      : dayKey(defaultDayIndex());

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
    const onConfirm = () => finish(el.importDay.value);
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
      setStatus(t('excel.importEmpty'));
      return;
    }

    const taskRows = entries.filter((entry) => entry.kind === 'task').length;
    const eventRows = entries.length - taskRows;
    let result;
    let summary;

    if (range === 'all') {
      const message = t('excel.confirmAll', {
        tasks: tasks.length,
        events: events.length,
        fileTasks: taskRows,
        fileEvents: eventRows,
      });
      if (!window.confirm(message)) {
        setStatus(t('excel.importCanceled'));
        return;
      }
      result = applyAllImport(entries);
      summary = t('excel.summaryAll', { file: file.name });
    } else if (range === 'week') {
      /* ファイルの日付が属する週（日付が無ければ表示中の週）だけを上書きする */
      const dated = entries.find((entry) => entry.date !== null);
      const monday = dated ? mondayOf(keyToDate(dated.date)) : viewedMonday();
      const weekDates = Array.from({ length: WEEK_LENGTH }, (unused, i) => {
        const date = new Date(monday);
        date.setDate(date.getDate() + i);
        return isoDate(date);
      });

      const weekRange = t('date.range', {
        from: labelOfKey(weekDates[0], true),
        to: labelOfKey(weekDates[WEEK_LENGTH - 1], true),
      });
      const message = t('excel.confirmWeek', {
        range: weekRange,
        fileTasks: taskRows,
        fileEvents: eventRows,
      });
      if (!window.confirm(message)) {
        setStatus(t('excel.importCanceled'));
        return;
      }

      result = applyPartialImport(entries, weekDates, (entry) => {
        if (entry.date === null) return null;
        if (weekDates.includes(entry.date)) return entry.date;
        /* 別の週の日付は、同じ曜日の位置に読み替える */
        return weekDates[(keyToDate(entry.date).getDay() + 6) % 7];
      });
      summary = t('excel.summaryWeek', {
        file: file.name,
        range: t('date.range', {
          from: labelOfKey(weekDates[0]),
          to: labelOfKey(weekDates[WEEK_LENGTH - 1]),
        }),
      });
    } else {
      const fileEntry = entries.find((entry) => entry.date !== null);
      const date = await askImportDay(
        t('import.message', { file: file.name, tasks: taskRows, events: eventRows }),
        fileEntry ? fileEntry.date : dayKey(defaultDayIndex())
      );
      if (!date) {
        setStatus(t('excel.importCanceled'));
        return;
      }
      result = applyPartialImport(entries, [date], (entry) => (entry.date === null ? null : date));
      summary = t('excel.summaryDay', { file: file.name, date: labelOfKey(date, true) });
    }

    save();
    saveEvents();
    resetForm();
    resetEventForm();
    render();
    setStatus(
      t('excel.importResult', {
        summary,
        tasks: result.taskCount,
        events: result.eventCount,
      }) +
      (result.conflicts.length
        ? t('excel.importConflicts', { names: joinNames(result.conflicts) })
        : '') +
      (skipped ? t('excel.importSkipped', { n: skipped }) : '')
    );
  } catch (error) {
    setStatus(t('excel.importFailed', { message: error.message }));
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
    showError(t('form.errorName'));
    return null;
  }
  if (!Number.isFinite(priority) || priority < 1) {
    showError(t('form.errorPriority'));
    return null;
  }
  if (!Number.isFinite(duration) || duration < 5) {
    showError(t('form.errorDurationMin'));
    return null;
  }
  if (duration > MAX_DURATION) {
    showError(t('form.errorDurationMax', { max: formatDuration(MAX_DURATION) }));
    return null;
  }

  const due = el.due.value.trim();
  if (due && !keyToDate(due)) {
    showError(t('form.errorDue'));
    return null;
  }

  clearError();
  return {
    name,
    priority: clamp(priority, 1, 99),
    duration: clamp(duration, 5, MAX_DURATION),
    assignee: el.assignee.value.trim(),
    due,
    notes: el.notes.value.trim(),
  };
}

/* 期限のバッジ（過ぎていれば強調） */
function makeDueBadge(due) {
  if (!due) return null;
  const key = todayKey();
  const state = due < key ? 'overdue' : due === key ? 'dueToday' : 'due';
  const badge = makeSpan(t(`task.${state}`, { date: labelOfKey(due) }), 'badge is-due');
  if (state === 'overdue') badge.classList.add('is-overdue');
  if (state === 'dueToday') badge.classList.add('is-today');
  return badge;
}

/* 依頼先に含まれるメールアドレスを取り出す。
 * 「山田さん yamada@example.com, 佐藤 sato@example.com」のように、
 * 名前混じり・カンマ／セミコロン／読点／空白区切りでも複数拾える。 */
function extractEmails(value) {
  const found = String(value || '').split(/[,;、，\s]+/)
    .map((part) => part.replace(/^[<（("']+|[>）)"']+$/g, '').trim())
    .filter((part) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(part));
  return Array.from(new Set(found));
}

function openRequestMail(task) {
  const recipients = extractEmails(task.assignee);
  if (recipients.length === 0) return;

  const subject = t('task.mailSubject', { name: task.name });
  const body = t('task.mailBody', {
    name: task.name,
    due: task.due ? labelOfKey(task.due, true) : t('task.none'),
    duration: formatDuration(task.duration),
    priority: task.priority,
    notes: task.notes || t('task.none'),
  });
  const url = `mailto:${recipients.map(encodeURIComponent).join(',')}` +
    `?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(url, '_blank');
  setBoardStatus(t('task.mailOpened', { name: task.name, n: recipients.length }));
}

function resetForm() {
  editingId = null;
  el.form.reset();
  el.id.value = '';
  el.assignee.value = '';
  el.due.value = '';
  el.notes.value = '';
  el.priority.value = String(tasks.length + 1);
  el.duration.value = '60';
  el.submit.textContent = t('form.add');
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
  el.assignee.value = task.assignee || '';
  el.due.value = task.due || '';
  el.notes.value = task.notes || '';
  el.submit.textContent = t('form.update');
  el.cancel.hidden = false;
  clearError();
  render();
  el.name.focus();
}

function removeTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (!window.confirm(t('list.confirmDelete', { name: task.name }))) return;
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
    task.assignee = input.assignee;
    task.due = input.due;
    task.notes = input.notes;
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
      assignee: '',
      due: '',
      notes: '',
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
    ? t('list.confirmClearPlanning', { n: placed.length })
    : t('list.confirmClearPlanningEmpty');
  if (!window.confirm(message)) return;

  placed.forEach((task) => {
    events.push({
      id: newId('event-'),
      name: task.name,
      date: task.placedAt.date,
      allDay: false,
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
    ? t('list.clearedPlanning', { n: placed.length })
    : t('list.clearedPlanningEmpty'));
});

el.clear.addEventListener('click', () => {
  if (tasks.length === 0) return;
  if (!window.confirm(t('list.confirmClearAll'))) return;
  tasks = [];
  save();
  resetForm();
  render();
});

/* ---------- 予定（優先度なし）の入力 ---------- */

/* 日の選択肢は表示中の週に合わせて作り直す（選択中の日はできるだけ残す） */
function fillDayOptions(select) {
  const previous = select.value;
  select.textContent = '';
  const keys = [];
  for (let day = 0; day < WEEK_LENGTH; day += 1) {
    const option = document.createElement('option');
    option.value = dayKey(day);
    option.textContent = dayLabel(day);
    select.append(option);
    keys.push(option.value);
  }
  select.value = keys.includes(previous) ? previous : dayKey(defaultDayIndex());
}

function fillSelectOptions() {
  [el.eventDay, el.exportDay, el.importDay].forEach(fillDayOptions);

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
  el.eventAllDay.checked = false;
  syncAllDayFields();
  el.eventSubmit.textContent = t('event.add');
  el.eventCancel.hidden = true;
}

function startEventEdit(id) {
  const event = events.find((e) => e.id === id);
  if (!event) return;
  editingEventId = id;
  el.eventId.value = id;
  el.eventName.value = event.name;
  el.eventDay.value = event.date;
  el.eventAllDay.checked = Boolean(event.allDay);
  if (!event.allDay) {
    el.eventStart.value = String(event.start);
    el.eventDuration.value = String(event.duration);
  }
  syncAllDayFields();
  el.eventSubmit.textContent = t('event.update');
  el.eventCancel.hidden = false;
  el.eventName.focus();
}

el.eventForm.addEventListener('submit', (submitEvent) => {
  submitEvent.preventDefault();

  const name = el.eventName.value.trim();
  const date = el.eventDay.value;
  const allDay = el.eventAllDay.checked;
  const start = Number(el.eventStart.value);
  const duration = Number(el.eventDuration.value);

  if (!name) {
    setBoardStatus(t('event.errorName'));
    el.eventName.focus();
    return;
  }
  if (!allDay && (!Number.isFinite(duration) || duration < 5 || duration > MAX_DURATION)) {
    setBoardStatus(t('event.errorDuration', { max: formatDuration(MAX_DURATION) }));
    el.eventDuration.focus();
    return;
  }

  const id = editingEventId || `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (!allDay) {
    const issue = placementIssue(name, 'event', id, date, start, duration);
    if (issue) {
      setBoardStatus(issue);
      return;
    }
  }

  const wasEditing = Boolean(editingEventId);
  const values = allDay
    ? { name, date, allDay: true, start: null, duration: 0 }
    : { name, date, allDay: false, start, duration };

  let target;
  if (editingEventId) {
    target = events.find((e) => e.id === editingEventId);
    Object.assign(target, values);   /* 優先順位は保持する */
  } else {
    target = Object.assign({ id, priority: null }, values);
    events.push(target);
  }

  saveEvents();
  resetEventForm();
  render();
  const messageKey = allDay
    ? (wasEditing ? 'event.updatedAllDay' : 'event.addedAllDay')
    : (wasEditing ? 'event.updated' : 'event.added');
  setBoardStatus(t(messageKey, {
    label: eventLabel(target),
    date: labelOfKey(date),
    time: allDay ? t('board.allDay') : formatTime(start),
  }));
});

el.eventAllDay.addEventListener('change', syncAllDayFields);

el.eventCancel.addEventListener('click', () => {
  resetEventForm();
  setBoardStatus(t('event.editCanceled'));
});

el.clearPlacements.addEventListener('click', () => {
  if (!tasks.some((task) => task.placedAt !== null)) return;
  if (!window.confirm(t('board.confirmClearPlacements'))) return;
  tasks.forEach((task) => { task.placedAt = null; });
  save();
  render();
  setBoardStatus(t('board.clearedPlacements'));
});

el.prevMonth.addEventListener('click', () => showMonth(monthOffset - 1));
el.nextMonth.addEventListener('click', () => showMonth(monthOffset + 1));
el.thisMonth.addEventListener('click', () => showMonth(0));

el.prevWeek.addEventListener('click', () => showWeek(weekOffset - 1));
el.nextWeek.addEventListener('click', () => showWeek(weekOffset + 1));
el.thisWeek.addEventListener('click', () => showWeek(0));

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

el.langSelect.addEventListener('change', () => setLanguage(el.langSelect.value));

/* 所要時間の上限は DAY_START / DAY_END から作る */
el.duration.max = String(MAX_DURATION);
el.eventDuration.max = String(MAX_DURATION);

applyStaticText();
fillSelectOptions();
resetEventForm();
resetForm();
render();
