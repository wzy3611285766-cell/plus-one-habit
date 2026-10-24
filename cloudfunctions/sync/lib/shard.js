/**
 * 分片定义与载荷清洗。
 *
 * 为什么要在服务端再洗一遍：客户端传来的 payload 是不可信输入。
 * 不洗的话，任何一个改过小程序包的客户端都能往你的云数据库里塞
 * 任意结构的几 MB 文档，把账号的同步数据撑爆。
 * 这里做三件事：白名单取字段、按上限截断、按字节数拒绝。
 */

const { AppError, CODES } = require('./errors.js');

const CORE = 'core';
const LOGS_PREFIX = 'logs:';
const LOGS_RE = /^logs:\d{4}-(0[1-9]|1[0-2])$/;

const LIMITS = {
  MAX_GOALS: 500,
  MAX_NOTES: 400,
  MAX_LOGS_PER_MONTH: 2000,           // 单月 2000 条 ≈ 每天 65 次，远超正常使用
  MAX_DOC_BYTES: 512 * 1024,          // 单个分片上限（正常数据达不到，作为兜底防线）
  MAX_DOCS_PER_PUSH: 40,              // 单次推送的分片数上限
  /* 单次推送总字节上限。云函数调用入参本身有大小限制，卡在 2MB
     既留足余量，又能在客户端异常（比如某个月份数据被撑大）时给出明确错误，
     而不是让一次同步在网络上神秘地失败。 */
  MAX_PUSH_BYTES: 2 * 1024 * 1024
};

function num(v, min, max, dflt) {
  return typeof v === 'number' && isFinite(v) && v >= min && v <= max ? v : dflt;
}

function str(v, max) { return typeof v === 'string' ? v.slice(0, max) : ''; }

function bool(v) { return v === true; }

function isDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

function isId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v); }

function isKey(k) {
  return k === CORE || (typeof k === 'string' && LOGS_RE.test(k));
}

function cleanGoal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isId(raw.id)) return null;
  const g = {
    id: raw.id,
    name: str(raw.name, 30),
    unit: str(raw.unit, 6),
    total: num(raw.total, 0, 1e9, 0),
    deadline: isDate(raw.deadline) ? raw.deadline : '',
    createdAt: isDate(raw.createdAt) ? raw.createdAt : '',
    color: str(raw.color, 12),
    obstacle: str(raw.obstacle, 60),
    plan: str(raw.plan, 60),
    sample: bool(raw.sample),
    updatedAt: num(raw.updatedAt, 0, 1e15, 0)
  };
  const order = num(raw.order, 0, 1e9, null);
  if (order !== null) g.order = order;
  if (raw.deleted === true) g.deleted = true;
  return g;
}

function cleanLog(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isId(raw.id) || !isId(raw.goalId)) return null;
  if (!isDate(raw.date)) return null;
  const l = {
    id: raw.id,
    goalId: raw.goalId,
    date: raw.date,
    amount: num(raw.amount, 0, 1e9, 0),
    minutes: num(raw.minutes, 0, 1440, null),
    makeup: bool(raw.makeup),
    ts: num(raw.ts, 0, 1e15, 0),
    updatedAt: num(raw.updatedAt, 0, 1e15, 0)
  };
  if (raw.deleted === true) l.deleted = true;
  return l;
}

function cleanNote(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = {
    keep: str(raw.keep, 100),
    problem: str(raw.problem, 100),
    try: str(raw.try, 100),
    next: str(raw.next, 100),
    updatedAt: num(raw.updatedAt, 0, 1e15, 0)
  };
  if (raw.deleted === true) n.deleted = true;
  return n;
}

function cleanSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = {
    sound: typeof s.sound === 'boolean' ? s.sound : true,
    volume: num(s.volume, 0, 100, 100),
    theme: ['auto', 'dark', 'light'].indexOf(s.theme) >= 0 ? s.theme : 'auto',
    updatedAt: num(s.updatedAt, 0, 1e15, 0)
  };
  return out;
}

function cleanCore(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const goals = [];
  if (Array.isArray(p.goals)) {
    p.goals.slice(0, LIMITS.MAX_GOALS).forEach((g) => {
      const c = cleanGoal(g);
      if (c) goals.push(c);
    });
  }
  const notes = {};
  if (p.notes && typeof p.notes === 'object' && !Array.isArray(p.notes)) {
    Object.keys(p.notes).slice(0, LIMITS.MAX_NOTES).forEach((k) => {
      if (!isDate(k)) return;
      const c = cleanNote(p.notes[k]);
      if (c) notes[k] = c;
    });
  }
  return { goals: goals, notes: notes, settings: cleanSettings(p.settings) };
}

function cleanLogs(raw, month) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const items = [];
  if (Array.isArray(p.items)) {
    p.items.slice(0, LIMITS.MAX_LOGS_PER_MONTH).forEach((l) => {
      const c = cleanLog(l);
      // 归属月份对不上的记录一律丢弃，否则一条错日期就能污染整个分片
      if (c && c.date.slice(0, 7) === month) items.push(c);
    });
  }
  return { items: items };
}

/**
 * 清洗一个分片。返回可直接入库的载荷。
 * @throws AppError PAYLOAD_TOO_LARGE / INVALID_INPUT
 */
function sanitizeShard(key, rawPayload) {
  if (!isKey(key)) throw AppError(CODES.INVALID_INPUT, '未知的数据分片：' + String(key).slice(0, 40));
  const cleaned = key === CORE ? cleanCore(rawPayload) : cleanLogs(rawPayload, key.slice(LOGS_PREFIX.length));

  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(cleaned), 'utf8'); } catch (e) { bytes = 0; }
  if (bytes > LIMITS.MAX_DOC_BYTES) {
    throw AppError(CODES.PAYLOAD_TOO_LARGE, '数据分片过大（' + Math.round(bytes / 1024) + 'KB），请先清理历史记录');
  }
  return cleaned;
}

/** 估算一个分片的字节数（用于统计页展示） */
function sizeOf(payload) {
  try { return Buffer.byteLength(JSON.stringify(payload), 'utf8'); } catch (e) { return 0; }
}

module.exports = {
  CORE: CORE,
  LOGS_PREFIX: LOGS_PREFIX,
  LIMITS: LIMITS,
  isKey: isKey,
  sanitizeShard: sanitizeShard,
  sizeOf: sizeOf
};
