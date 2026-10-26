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
    st.settings.volume = U.finiteNumber(s.volume, 0, 100) ? Math.round(s.volume) : 100;
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
    if (!dates[cur]) return false;
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

/** 预计完成日：done / unknown / ok(+date,diff 正数=比截止早) / overdue */
function eta(st, g) {
  const done = doneAmount(st, g.id);
  const remain = g.total - done;
  if (remain <= 0) return { status: 'done' };
  const speed = last7Sum(st, g.id) / 7;
  if (speed <= 0) return { status: 'unknown' };
  const days = Math.ceil(remain / speed);
  const etaDate = U.addDays(U.todayStr(), days);
  const diff = U.diffDays(etaDate, g.deadline);
  if (U.diffDays(U.todayStr(), g.deadline) < 0) return { status: 'overdue', date: etaDate, diff: diff };
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

  const daysLeft = U.diffDays(t, g.deadline);
  if (daysLeft < 0) return { status: 'overdue', quota: remain, remain: remain, daysLeft: 0, wrote: false };

  const key = dayQuotaKey(g.id, t);
  const cached = st.snapshots ? st.snapshots[key] : null;
  if (U.finiteNumber(cached, 0.000000001, 1e9)) {
    return { status: 'ok', quota: cached, remain: remain, daysLeft: daysLeft, locked: true, wrote: false };
  }

  const totalDays = Math.max(1, U.diffDays(g.createdAt, g.deadline) + 1);
  const base = Math.ceil(g.total / totalDays);
  const elapsed = Math.max(1, Math.min(totalDays, U.diffDays(g.createdAt, t) + 1));
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
  const goals = activeGoals(st).filter((g) => !isComplete(st, g));
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

function pickNewer(a, b) {
  const ua = U.finiteNumber(a && a.updatedAt, 0, 1e15) ? a.updatedAt : 0;
  const ub = U.finiteNumber(b && b.updatedAt, 0, 1e15) ? b.updatedAt : 0;
  if (ua !== ub) return ua > ub ? a : b;
  // 打平：一律取「云端」侧（参数 b），两台设备因此得出相同结果
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
  // 墓碑清理：删除超过 90 天的目标不再保留
  const cut = U.addDays(U.todayStr(), -90);
  return out.filter((g) => {
    if (!g.deleted) return true;
    const t = g.updatedAt ? new Date(g.updatedAt).toISOString().slice(0, 10) : g.createdAt;
    return t >= cut;
  });
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
  const cut = U.addDays(U.todayStr(), -90);
  return out.filter((l) => {
    if (!l.deleted) return true;
    return l.date >= cut;
  });
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
  doneAmount, logsOn, minutesOn, dateSetOf, isRestDay, streak, last7Sum, eta,
  dayQuotaKey, dailyQuota, pruneSnapshots, isComplete, isTodayMet,
  weekStats, globalStreak, todayOverview,
  monthOf, logsShardKey, isLogsShardKey, isCoreKey, isKnownShardKey,
  touch, buildCoreShard, buildLogShards,
  mergeGoals, mergeNotes, mergeLogs, mergeSettings, mergeRemoteShards,
  seedData
};
