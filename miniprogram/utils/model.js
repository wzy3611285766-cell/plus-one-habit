/**
 * 领域模型：数据结构定义、统计计算、跨设备合并。
 *
 * 与 H5 版 work.html 的关系：
 *   - 数据结构完全兼容（goals / logs / notes / snapshots / settings），
 *     从 H5 导出的 JSON 可以直接被 parseState() 接受。
 *   - 统计函数（doneAmount / streak / eta / dailyQuota / weekStats）逐行照搬 H5 实现，
 *     保证同一份数据在两端算出同一个数字。
 * 新增：
 *   - updatedAt / deleted 两个字段，仅用于多设备 LWW 合并，不参与业务展示。
 *   - METRICS merge* 系列纯函数，负责把「本机分片」与「云端分片」合并成最终状态。
 */

const U = require('./util.js');

const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#0ea5e9', '#8b5cf6', '#ef4444', '#f97316', '#14b8a6'];
const SEED_IDS = ['seed-g1', 'seed-g2', 'seed-g3', 'seed-g4', 'seed-g5', 'seed-g6'];
/** 示例名单改版时 +1：旧设备上已装载的示例会在启动时自动换成新版（store.refreshSeed） */
const SEED_VERSION = 5;
const STATE_VERSION = 3;

/* ================= 状态 ================= */

function blankState() {
  return {
    version: STATE_VERSION,
    seedVersion: SEED_VERSION,
    goals: [],
    logs: [],
    notes: {},
    snapshots: {},
    /* volume 是「相对基准音量的百分比」，不是绝对值：
         100 = 音效设计时的基准电平（-3 dBFS）
          60 = 在基准上衰减到 60% 幅度（-4.44 dB → -7.44 dBFS）
       播放时的增益 = volume / 100，不要在这里预先做除法，
       否则调整基准时所有历史用户的实际音量会一起漂移。 */
    settings: { sound: true, volume: 60, theme: 'auto' },
    seeded: false,
    sampleCleared: false,
    createdAt: U.todayStr()
  };
}

/* ================= 校验（与 H5 validateState 同等严格度） ================= */

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function validId(v) { return typeof v === 'string' && ID_RE.test(v); }

function normalizeGoal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!validId(raw.id)) return null;
  const name = U.cleanText(raw.name, 30);
  if (!name) return null;
  const unit = U.cleanText(raw.unit, 6) || '个';
  if (!U.finiteNumber(raw.total, 1, 1e9)) return null;
  if (!U.isDateString(raw.deadline)) return null;
  const createdAt = U.isDateString(raw.createdAt) ? raw.createdAt : U.todayStr();
  const color = COLORS.indexOf(raw.color) >= 0 ? raw.color : COLORS[0];
  const g = {
    id: raw.id,
    name: name,
    unit: unit,
    total: Math.round(raw.total * 100) / 100,
    deadline: raw.deadline,
    createdAt: createdAt,
    color: color,
    obstacle: U.cleanText(raw.obstacle, 60),
    plan: U.cleanText(raw.plan, 60),
    sample: !!raw.sample,
    updatedAt: U.finiteNumber(raw.updatedAt, 0, 1e15) ? raw.updatedAt : 0
  };
  if (U.finiteNumber(raw.order, 0, 1e9)) g.order = raw.order;

  /* 暂停区间：[{ f: 开始日, t: 结束日 | '' }]，最后一段 t 为空表示仍在暂停。
     用「区间数组」而不是一个 paused 布尔：恢复之后仍然要知道当时停过多久，
     否则历史暂停期会被当成漏卡，连续天数一恢复就断（用户最不能接受的那种）。
     只留最近 20 段，够回溯且不会让目标无限膨胀。 */
  if (Array.isArray(raw.pauses)) {
    const pauses = [];
    raw.pauses.forEach((p) => {
      if (!p || typeof p !== 'object') return;
      if (!U.isDateString(p.f)) return;
      const t = U.isDateString(p.t) ? p.t : '';
      if (t && t < p.f) return;          // 结束早于开始：坏区间直接丢
      pauses.push({ f: p.f, t: t });
    });
    pauses.sort((a, b) => (a.f < b.f ? -1 : (a.f > b.f ? 1 : 0)));
    /* 合并重叠/相接的区间：两台设备各自点过暂停就可能叠出两段，
       重叠会让 pausedDaysBetween 重复计数，恢复后的建议量被算少。 */
    const merged = [];
    pauses.forEach((p) => {
      const last = merged[merged.length - 1];
      if (!last) { merged.push(p); return; }
      const lastEnd = last.t || '9999-12-31';   // 开区间吃掉后面所有区间
      if (p.f > lastEnd) { merged.push(p); return; }
      last.t = (last.t && p.t) ? (p.t > last.t ? p.t : last.t) : '';
    });
    if (merged.length > 20) merged.splice(0, merged.length - 20);
    if (merged.length) g.pauses = merged;
  }

  if (raw.deleted === true) {
    g.deleted = true;
    // 墓碑只保留定位信息，避免把历史数据反复上传
    g.name = g.name || '(已删除)';
    g.total = g.total || 1;
    g.deadline = g.deadline || createdAt;
  }
  return g;
}

function normalizeLog(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!validId(raw.id)) return null;
  if (!validId(raw.goalId)) return null;
  if (!U.isDateString(raw.date)) return null;
  const amount = U.finiteNumber(raw.amount, 0.000000001, 1e9) ? raw.amount : null;
  if (amount === null && raw.deleted !== true) return null;
  const l = {
    id: raw.id,
    goalId: raw.goalId,
    date: raw.date,
    amount: amount === null ? 0 : amount,
    minutes: U.finiteNumber(raw.minutes, 0, 1440) ? Math.round(raw.minutes) : null,
    makeup: !!raw.makeup,
    ts: U.finiteNumber(raw.ts, 0, 1e15) ? raw.ts : 0,
    updatedAt: U.finiteNumber(raw.updatedAt, 0, 1e15) ? raw.updatedAt : 0
  };
  if (raw.deleted === true) l.deleted = true;
  return l;
}

function normalizeNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = {
    keep: U.cleanText(raw.keep, 100),
    problem: U.cleanText(raw.problem, 100),
    try: U.cleanText(raw.try, 100),
    next: U.cleanText(raw.next, 100),
    updatedAt: U.finiteNumber(raw.updatedAt, 0, 1e15) ? raw.updatedAt : 0
  };
  if (raw.deleted === true) n.deleted = true;
  return n;
}

/**
 * 清洗任意外部数据（旧版 localStorage / 云端分片 / H5 导出文件）。
 * 永不抛异常，坏数据一律丢弃并计数，供 UI 提示。
 */
function parseState(raw) {
  const st = blankState();
  const dropped = { goals: 0, logs: 0, notes: 0 };
  if (!raw || typeof raw !== 'object') return { state: st, dropped: dropped, ok: false };

  if (Array.isArray(raw.goals)) {
    const seen = {};
    raw.goals.forEach((g) => {
      const n = normalizeGoal(g);
      if (!n || seen[n.id]) { dropped.goals++; return; }
      seen[n.id] = 1;
      st.goals.push(n);
    });
    if (st.goals.length > 500) { dropped.goals += st.goals.length - 500; st.goals = st.goals.slice(0, 500); }
  }

  if (Array.isArray(raw.logs)) {
    const seen = {};
    raw.logs.forEach((l) => {
      const n = normalizeLog(l);
      if (!n || seen[n.id]) { dropped.logs++; return; }
      seen[n.id] = 1;
      st.logs.push(n);
    });
    if (st.logs.length > 100000) { dropped.logs += st.logs.length - 100000; st.logs = st.logs.slice(-100000); }
  }

  if (raw.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes)) {
    Object.keys(raw.notes).forEach((k) => {
      if (!U.isDateString(k)) { dropped.notes++; return; }
      const n = normalizeNote(raw.notes[k]);
      if (!n) { dropped.notes++; return; }
      st.notes[k] = n;
    });
  }

  if (raw.snapshots && typeof raw.snapshots === 'object' && !Array.isArray(raw.snapshots)) {
    Object.keys(raw.snapshots).forEach((k) => {
      const parts = String(k).split('|');
      if (parts.length !== 2 || !validId(parts[0]) || !U.isDateString(parts[1])) return;
      if (U.finiteNumber(raw.snapshots[k], 0, 1e9)) st.snapshots[k] = raw.snapshots[k];
    });
  }

  if (raw.settings && typeof raw.settings === 'object') {
    const s = raw.settings;
    st.settings.sound = typeof s.sound === 'boolean' ? s.sound : true;
    /* 缺省值与 blankState 保持一致（60），不要写 100：
       旧数据若只有 sound/theme 而没有 volume，会突然变满音量。 */
    st.settings.volume = U.finiteNumber(s.volume, 0, 100) ? Math.round(s.volume) : 60;
    st.settings.theme = ['auto', 'dark', 'light'].indexOf(s.theme) >= 0 ? s.theme : 'auto';
    if (U.finiteNumber(s.updatedAt, 0, 1e15)) st.settings.updatedAt = s.updatedAt;
  }

  st.seeded = !!raw.seeded;
  st.seedVersion = U.finiteNumber(raw.seedVersion, 0, 1e9) ? Math.round(raw.seedVersion) : 0;
  st.sampleCleared = !!raw.sampleCleared;
  if (U.isDateString(raw.createdAt)) st.createdAt = raw.createdAt;

  return { state: st, dropped: dropped, ok: true };
}

/* ================= 查询 ================= */

function goalById(st, id) {
  for (let i = 0; i < st.goals.length; i++) if (st.goals[i].id === id) return st.goals[i];
  return null;
}

/** 活跃目标：过滤墓碑后按 order / 创建时间排序 */
function activeGoals(st) {
  const list = st.goals.filter((g) => !g.deleted);
  list.sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 1e9;
    const bo = typeof b.order === 'number' ? b.order : 1e9;
    if (ao !== bo) return ao - bo;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? 1 : -1;
  });
  return list;
}

function activeLogs(st) { return st.logs.filter((l) => !l.deleted); }

/* ================= 暂停 =================
 * 语义只有一条：暂停期间「不要求打卡」，而不是「不许打卡」。
 * 所以暂停日既不进今日清单，也不算漏打、不打断连续、不排每日建议量；
 * 用户临时想打一记 +1 也仍然允许（记录照常入库）。
 */

/** 某个日期是否处在暂停区间内（含开始日与结束日） */
function isPausedOn(g, date) {
  if (!g || !g.pauses || !g.pauses.length || !date) return false;
  for (let i = 0; i < g.pauses.length; i++) {
    const p = g.pauses[i];
    if (!p || !U.isDateString(p.f)) continue;
    if (date < p.f) continue;
    if (!p.t || date <= p.t) return true;
  }
  return false;
}

/** 当前是否处于暂停中：最后一段没有结束日 */
function isPaused(g) {
  if (!g || !g.pauses || !g.pauses.length) return false;
  const last = g.pauses[g.pauses.length - 1];
  return !!(last && last.f && !last.t);
}

/** 本次暂停从哪天开始；未暂停返回空串 */
function pausedSince(g) {
  if (!isPaused(g)) return '';
  return g.pauses[g.pauses.length - 1].f;
}

/** 生效中的目标：未删除、未暂停（已完成与否由调用方再判） */
function runningGoals(st) {
  return activeGoals(st).filter((g) => !isPaused(g));
}

/** 一个日期区间内被暂停掉的天数（含两端，按区间求交而不是逐日遍历） */
function pausedDaysBetween(g, start, end) {
  if (!g || !g.pauses || !g.pauses.length || !start || !end || end < start) return 0;
  let n = 0;
  for (let i = 0; i < g.pauses.length; i++) {
    const p = g.pauses[i];
    if (!p || !U.isDateString(p.f)) continue;
    const from = p.f > start ? p.f : start;
    const to = p.t ? (p.t < end ? p.t : end) : end;
    if (from <= to) n += U.diffDays(from, to) + 1;
  }
  return n;
}

/* ================= 统计（逐行对齐 H5） ================= */

function doneAmount(st, gid) {
  let s = 0;
  const logs = st.logs;
  for (let i = 0; i < logs.length; i++) if (logs[i].goalId === gid && !logs[i].deleted) s += logs[i].amount;
  return s;
}

function logsOn(st, gid, dateStr) {
  let s = 0;
  const logs = st.logs;
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    if (l.goalId === gid && l.date === dateStr && !l.deleted) s += l.amount;
  }
  return s;
}

function minutesOn(st, gid, dateStr) {
  let s = 0;
  const logs = st.logs;
  for (let i = 0; i < logs.length; i++) {
    const l = logs[i];
    if (l.goalId === gid && l.date === dateStr && l.minutes && !l.deleted) s += l.minutes;
  }
  return s;
}

function dateSetOf(st, gid) {
  const s = {};
  for (let i = 0; i < st.logs.length; i++) {
    const l = st.logs[i];
    if (l.goalId === gid && !l.deleted) s[l.date] = 1;
  }
  return s;
}

/** 休息日：本周一（不早于创建日）至 d-1 无漏打，则 d 是本周首个漏打日 */
function isRestDay(st, gid, d, dates) {
  const g = goalById(st, gid);
  if (!g) return false;
  const mon = U.mondayOf(d);
  const start = mon < g.createdAt ? g.createdAt : mon;
  let cur = start;
  while (cur < d) {
    /* 暂停日不算漏打：否则恢复后的第一周，休息日会被暂停期「用掉」 */
    if (!dates[cur] && !isPausedOn(g, cur)) return false;
    cur = U.addDays(cur, 1);
  }
  return true;
}

function streak(st, gid) {
  const g = goalById(st, gid);
  if (!g) return 0;
  const dates = dateSetOf(st, gid);
  let d = U.todayStr();
  if (!dates[d]) d = U.addDays(d, -1);
  let s = 0;
  while (d >= g.createdAt) {
    if (dates[d]) { s++; d = U.addDays(d, -1); continue; }
    /* 暂停期不计数，也不打断：恢复后连续天数接着上次往下数 */
    if (isPausedOn(g, d)) { d = U.addDays(d, -1); continue; }
    if (isRestDay(st, gid, d, dates)) { d = U.addDays(d, -1); continue; }
    break;
  }
  return s;
}

function last7Sum(st, gid) {
  const t = U.todayStr();
  const from = U.addDays(t, -6);
  let s = 0;
  for (let i = 0; i < st.logs.length; i++) {
    const l = st.logs[i];
    if (l.goalId === gid && l.date >= from && l.date <= t && !l.deleted) s += l.amount;
  }
  return s;
}

/** 预计完成日：done / paused / unknown / ok(+date,diff 正数=比截止早) / overdue */
function eta(st, g) {
  const done = doneAmount(st, g.id);
  const remain = g.total - done;
  if (remain <= 0) return { status: 'done' };

  /* 暂停中不推算：速度窗口里全是 0，硬算出来的「拖后 N 天」只会制造焦虑 */
  if (isPaused(g)) return { status: 'paused' };

  const today = U.todayStr();
  const sum = last7Sum(st, g.id);
  if (sum <= 0) return { status: 'unknown' };

  /* 平均速度的窗口取「建档天数」与 7 的较小值。
     固定除以 7 会把新目标的速度稀释：昨天刚建、今天打了 100，也按 14/天 算，
     预计日期被推到很远，明明进度很快却显示「拖后」。
     建档满 7 天后与原来的口径完全一致。 */
  const elapsed = U.isDateString(g.createdAt) ? Math.max(1, U.diffDays(g.createdAt, today) + 1) : 7;
  const windowDays = Math.min(7, elapsed);
  const speed = sum / windowDays;

  const days = Math.ceil(remain / speed);
  const etaDate = U.addDays(today, days);
  const diff = U.diffDays(etaDate, g.deadline);
  if (U.diffDays(today, g.deadline) < 0) return { status: 'overdue', date: etaDate, diff: diff };
  return { status: 'ok', date: etaDate, diff: diff };
}

function dayQuotaKey(gid, dateStr) { return gid + '|' + dateStr; }

/**
 * 每日建议量：开始时锁定，当天不因打卡而缩水。
 *   1) 基准 = ceil(总量 / 总天数)
 *   2) 落后追缴：历史欠账摊到剩余天数
 *   3) 当天一旦达到配额即锁定（快照落在 state.snapshots）
 * 注意：本函数会写 state.snapshots，调用方负责 save（与 H5 行为一致）。
 */
function dailyQuota(st, g, opts) {
  const t = (opts && opts.today) || U.todayStr();
  const remain = g.total - doneAmount(st, g.id);
  if (remain <= 0) return { status: 'done', quota: 0, remain: 0, wrote: false };

  /* 暂停期间不排今日工作量，也不写快照：给一个「今天该做 3 个」等于在催，
     而用户刚刚明确说过要先放下这件事。恢复当天重新按剩余天数算。 */
  if (isPausedOn(g, t)) {
    return { status: 'paused', quota: 0, remain: remain, daysLeft: Math.max(0, U.diffDays(t, g.deadline)), wrote: false };
  }

  const daysLeft = U.diffDays(t, g.deadline);
  if (daysLeft < 0) return { status: 'overdue', quota: remain, remain: remain, daysLeft: 0, wrote: false };

  const key = dayQuotaKey(g.id, t);
  const cached = st.snapshots ? st.snapshots[key] : null;
  if (U.finiteNumber(cached, 0.000000001, 1e9)) {
    return { status: 'ok', quota: cached, remain: remain, daysLeft: daysLeft, locked: true, wrote: false };
  }

  const totalDays = Math.max(1, U.diffDays(g.createdAt, g.deadline) + 1);
  const base = Math.ceil(g.total / totalDays);
  /* 暂停期不产生「欠账」：恢复当天不该一次性补上暂停那几天该做的量。
     截止日不因暂停而延后（那是用户自己定下的），所以剩余天数照常算。 */
  const elapsed = Math.max(1, Math.min(totalDays,
    U.diffDays(g.createdAt, t) + 1 - pausedDaysBetween(g, g.createdAt, t)));
  const shouldDone = base * elapsed;
  const debt = shouldDone - doneAmount(st, g.id);

  let quota = base;
  if (debt > 0 && daysLeft + 1 > 0) quota = Math.max(base, Math.ceil(debt / (daysLeft + 1)));
  quota = Math.min(quota, remain);
  quota = Math.max(1, quota);

  if (!st.snapshots) st.snapshots = {};
  st.snapshots[key] = quota;
  pruneSnapshots(st);

  /* wrote 标记这个调用真正写入了快照。
     调用方据此决定要不要落盘 —— 因为 dailyQuota 会改 state.snapshots，
     页面如果无条件 save，就会变成「每次收到状态事件都整份写一次 localStorage」，
     数据量大时那是几百 KB 的同步写。 */
  return { status: 'ok', quota: quota, remain: remain, daysLeft: daysLeft, locked: false, wrote: true };
}

function pruneSnapshots(st) {
  if (!st.snapshots) return;
  const cut = U.addDays(U.todayStr(), -45);
  Object.keys(st.snapshots).forEach((k) => {
    const d = String(k).split('|')[1];
    if (!U.isDateString(d) || d < cut) delete st.snapshots[k];
  });
}

function isComplete(st, g) { return doneAmount(st, g.id) >= g.total; }

function isTodayMet(st, g) {
  if (isComplete(st, g)) return false;
  if (isPausedOn(g, U.todayStr())) return false;
  const q = dailyQuota(st, g, null);
  if (q.status !== 'ok') return false;
  return logsOn(st, g.id, U.todayStr()) >= q.quota;
}

/** 一段日期区间的汇总：per {gid:{sum,days,mins}} + totalMin + activeDays */
function weekStats(st, start, end) {
  const per = {};
  let totalMin = 0;
  let totalSum = 0;
  const allDays = {};
  activeGoals(st).forEach((g) => {
    let sum = 0;
    const days = {};
    let mins = 0;
    st.logs.forEach((l) => {
      if (l.deleted) return;
      if (l.goalId === g.id && l.date >= start && l.date <= end) {
        sum += l.amount;
        days[l.date] = 1;
        allDays[l.date] = 1;
        if (l.minutes) mins += l.minutes;
      }
    });
    per[g.id] = { sum: sum, days: Object.keys(days).length, mins: mins };
    totalMin += mins;
    totalSum += sum;
  });
  return { per: per, totalMin: totalMin, totalSum: totalSum, activeDays: Object.keys(allDays).length };
}

/** 全局连续天数：所有目标里「今天或昨天有记录」的最长连续自然日 */
function globalStreak(st) {
  const dates = {};
  st.logs.forEach((l) => { if (!l.deleted) dates[l.date] = 1; });
  let d = U.todayStr();
  if (!dates[d]) d = U.addDays(d, -1);
  let s = 0;
  const floor = st.createdAt;
  while (d >= floor && dates[d]) { s++; d = U.addDays(d, -1); }
  return s;
}

/** 今日总览：用于今日页首屏。snapshotsWritten 告诉调用方是否需要落盘 */
function todayOverview(st) {
  const t = U.todayStr();
  /* 暂停的目标不进今日清单：今日页只回答「今天要做什么」 */
  const goals = activeGoals(st).filter((g) => !isComplete(st, g) && !isPaused(g));
  let met = 0;
  let amount = 0;
  let quota = 0;
  let snapshotsWritten = false;
  const rows = goals.map((g) => {
    const q = dailyQuota(st, g, { today: t });
    if (q.wrote) snapshotsWritten = true;
    const got = logsOn(st, g.id, t);
    const ok = q.status === 'ok' && got >= q.quota;
    if (ok) met++;
    amount += got;
    quota += q.status === 'ok' ? q.quota : got;
    return {
      goal: g,
      got: got,
      quota: q.quota,
      status: q.status,
      met: ok,
      remain: q.status === 'done' ? 0 : q.remain,
      streak: streak(st, g.id),
      daysLeft: q.daysLeft === undefined ? 0 : q.daysLeft
    };
  });
  return {
    rows: rows, met: met, total: rows.length, amount: amount, quota: quota,
    streak: globalStreak(st), snapshotsWritten: snapshotsWritten
  };
}

/* ================= 分片 & 跨设备合并 ================= */

const CORE_KEY = 'core';
const LOGS_PREFIX = 'logs:';

function monthOf(dateStr) { return String(dateStr).slice(0, 7); }

function logsShardKey(month) { return LOGS_PREFIX + month; }

function isLogsShardKey(k) { return typeof k === 'string' && k.indexOf(LOGS_PREFIX) === 0 && /^logs:\d{4}-\d{2}$/.test(k); }

function isCoreKey(k) { return k === CORE_KEY; }

function isKnownShardKey(k) { return isCoreKey(k) || isLogsShardKey(k); }

/** 打一个目标/记录/复盘的新鲜度戳（LWW 基准），并返回它 */
function touch(obj) {
  obj.updatedAt = U.nextStamp();
  return obj;
}

/** core 分片载荷：不含 snapshots（本机派生数据，不进云端） */
function buildCoreShard(st) {
  const notes = {};
  Object.keys(st.notes).forEach((k) => {
    const n = st.notes[k];
    if (!n) return;
    // 空且非墓碑的复盘不占空间
    if (!n.deleted && !n.keep && !n.problem && !n.try && !n.next) return;
    notes[k] = n;
  });
  return {
    /* 示例目标不进云端：它是给人「看一眼这个产品怎么用」的演示数据，
       传上去会混进真实账号，换设备时还会看到一堆不属于自己的目标。 */
    goals: st.goals.filter((g) => !g.sample).map((g) => g),
    notes: notes,
    settings: st.settings
  };
}

/** logs 分片载荷：按月份切分，单文档体量可控（≤31 天 × N 条） */
function buildLogShards(st) {
  const byMonth = {};
  st.logs.forEach((l) => {
    const m = monthOf(l.date);
    if (!byMonth[m]) byMonth[m] = { items: [] };
    byMonth[m].items.push(l);
  });
  return byMonth;
}

/* ---- 合并：全部是纯函数，同输入必得同输出（收敛性依赖这一点） ---- */

/** 墓碑寿命（天）：超过这个时间的删除标记不再随数据传播 */
const TOMBSTONE_DAYS = 90;

/**
 * 墓碑是否已经可以丢弃。
 *
 * 关键：按「删除时刻」算，绝不能按业务日期算。
 * 删掉一条三个月前的误记时，它的 date 天生就在 90 天前 ——
 * 按 date 判断会让墓碑当场失效，别的设备下次推送就会把这条记录复活。
 * updatedAt 由 deleteLog / deleteGoal 的 touch() 写成删除时刻。
 *
 * 没有删除时刻的墓碑（极老的迁移数据）一律保留：无法判断它是否过期时，
 * 多留几个字节远比让一条记录复活安全。
 */
function isExpiredTombstone(obj, deletedAt) {
  if (!obj || !obj.deleted) return false;
  if (!U.finiteNumber(deletedAt, 1, 1e15)) return false;
  const cutTs = U.parseDate(U.addDays(U.todayStr(), -TOMBSTONE_DAYS)).getTime();
  return deletedAt < cutTs;
}

/**
 * 暂停区间的「完整度」。同时间戳时用它判断哪一侧的数据更全。
 *
 * 为什么需要它：不认识 pauses 字段的旧版本客户端，把同一个目标同步回云端时
 * 会把这个字段整个丢掉，而 updatedAt 原样带回来。合并时时间戳打平、按
 * 「打平取云端」的规则就会把用户刚按下的暂停悄悄抹掉 —— 表现就是「暂停了，
 * 第二天任务又回到待办，得再按一次」。
 * 这个比较是纯函数：两台设备面对同一对对象必得同一结果，收敛性不受影响。
 */
function pauseDepth(g) {
  if (!g || !Array.isArray(g.pauses)) return 0;
  let n = 0;
  g.pauses.forEach((p) => { if (p && U.isDateString(p.f)) n++; });
  return n;
}

function pickNewer(a, b) {
  const ua = U.finiteNumber(a && a.updatedAt, 0, 1e15) ? a.updatedAt : 0;
  const ub = U.finiteNumber(b && b.updatedAt, 0, 1e15) ? b.updatedAt : 0;
  if (ua !== ub) return ua > ub ? a : b;
  /* 打平：先比暂停区间的完整度（旧客户端丢字段的那一份不能赢），
     再一律取「云端」侧（参数 b），两台设备因此得出相同结果 */
  const da = pauseDepth(a);
  const db = pauseDepth(b);
  if (da !== db) return da > db ? a : b;
  return b;
}

function mergeGoals(localGoals, remoteGoals) {
  const map = {};
  (localGoals || []).forEach((g) => { if (g && g.id) map[g.id] = g; });
  (remoteGoals || []).forEach((g) => {
    if (!g || !g.id) return;
    map[g.id] = map[g.id] ? pickNewer(map[g.id], g) : g;
  });
  const out = Object.keys(map).map((k) => map[k]);
  return out.filter((g) => !isExpiredTombstone(g, g.updatedAt));
}

function mergeNotes(localNotes, remoteNotes) {
  const out = {};
  Object.keys(localNotes || {}).forEach((k) => { out[k] = localNotes[k]; });
  Object.keys(remoteNotes || {}).forEach((k) => {
    out[k] = out[k] ? pickNewer(out[k], remoteNotes[k]) : remoteNotes[k];
  });
  return out;
}

function mergeLogs(localLogs, remoteLogs) {
  const map = {};
  (localLogs || []).forEach((l) => { if (l && l.id) map[l.id] = l; });
  (remoteLogs || []).forEach((l) => {
    if (!l || !l.id) return;
    map[l.id] = map[l.id] ? pickNewer(map[l.id], l) : l;
  });
  const out = Object.keys(map).map((k) => map[k]);
  /* 与目标一样按「删除时刻」判定：一条 100 天前的记录今天才被删，
     墓碑必须继续传播，否则别的设备会把这条记录复活。 */
  return out.filter((l) => !isExpiredTombstone(l, l.updatedAt));
}

function mergeSettings(localS, remoteS) {
  if (!localS) return remoteS || { sound: true, volume: 60, theme: 'auto' };
  if (!remoteS) return localS;
  return pickNewer(localS, remoteS);
}

/**
 * 把一批云端分片合并进本机 state（原地修改并返回 state）。
 * 只处理 core 与 logs:* 两类分片；未知分片忽略。
 */
function mergeRemoteShards(st, shards) {
  let changed = false;
  (shards || []).forEach((shard) => {
    if (!shard || !isKnownShardKey(shard.key)) return;
    const p = shard.payload || {};
    if (isCoreKey(shard.key)) {
      const nextGoals = mergeGoals(st.goals, p.goals);
      const nextNotes = mergeNotes(st.notes, p.notes);
      const nextSettings = mergeSettings(st.settings, p.settings);
      if (JSON.stringify(nextGoals) !== JSON.stringify(st.goals)) changed = true;
      if (JSON.stringify(nextNotes) !== JSON.stringify(st.notes)) changed = true;
      if (JSON.stringify(nextSettings) !== JSON.stringify(st.settings)) changed = true;
      st.goals = nextGoals;
      st.notes = nextNotes;
      st.settings = nextSettings;
    } else if (isLogsShardKey(shard.key)) {
      const month = shard.key.slice(LOGS_PREFIX.length);
      const local = st.logs.filter((l) => monthOf(l.date) === month);
      const merged = mergeLogs(local, p.items);
      const rest = st.logs.filter((l) => monthOf(l.date) !== month);
      const nextLogs = rest.concat(merged);
      if (JSON.stringify(nextLogs) !== JSON.stringify(st.logs)) changed = true;
      st.logs = nextLogs;
    }
  });
  return { state: st, changed: changed };
}

/* ================= 演示数据 ================= */

function seedData() {
  const t = U.todayStr();
  const goals = [
    { id: SEED_IDS[0], name: '背英语四级单词', unit: '个', total: 1200, deadline: U.addDays(t, 68), color: COLORS[0], obstacle: '晚上容易困', plan: '早上通勤时先背 20 个' },
    { id: SEED_IDS[1], name: '复习错题', unit: '道', total: 300, deadline: U.addDays(t, 48), color: COLORS[1], obstacle: '攒着不想翻', plan: '每天晚饭后固定 15 分钟' },
    { id: SEED_IDS[2], name: '读《币安人生》', unit: '页', total: 440, deadline: U.addDays(t, 40), color: COLORS[2], obstacle: '睡前刷手机', plan: '把书放在餐桌上' }
  ].map((g) => {
    const out = Object.assign({}, g, { createdAt: t, sample: true });
    return touch(out);
  });
  return { goals: goals, logs: [] };
}

module.exports = {
  COLORS, SEED_IDS, SEED_VERSION, STATE_VERSION, CORE_KEY, LOGS_PREFIX,
  blankState, parseState, normalizeGoal, normalizeLog, normalizeNote,
  goalById, activeGoals, activeLogs,
  isPausedOn, isPaused, pausedSince, runningGoals, pausedDaysBetween,
  doneAmount, logsOn, minutesOn, dateSetOf, isRestDay, streak, last7Sum, eta,
  dayQuotaKey, dailyQuota, pruneSnapshots, isComplete, isTodayMet,
  weekStats, globalStreak, todayOverview,
  monthOf, logsShardKey, isLogsShardKey, isCoreKey, isKnownShardKey,
  touch, buildCoreShard, buildLogShards,
  mergeGoals, mergeNotes, mergeLogs, mergeSettings, mergeRemoteShards,
  seedData
};
