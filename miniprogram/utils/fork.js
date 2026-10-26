/**
 * 分享分叉（模仿 H5 第 17 轮「公开链接改成分叉副本」）。
 *
 * 语义：分享者把小程序转发给同学，卡片路径里带着一份**目标模板**；
 * 同学打开后（未登录、且自己还没有任何进度时）把模板种到他的手机上，
 * 从此各记各的 —— 分享者看不到同学的打卡，同学也改不到分享者的数据。
 *
 * 与 H5 版的两处刻意差异：
 *   1. H5 公开链接能实时读分享者的云端数据，所以「重新载入」是回源重拉；
 *      小程序分享卡片是快照，重新载入只能拿到**分享那一刻**的模板
 *      （想要最新的，让同学再转一次）。
 *   2. H5 分叉连打卡记录一起复制；卡片路径放不下历史记录，这里只复制
 *      目标本身（名称 / 总量 / 截止 / 配色 / 障碍与预案），进度从零开始。
 *
 * 本模块刻意不依赖 store / auth：入站判定是纯函数（返回「执行计划」，
 * 由 store 落地），方便单独测试，也避免和 store 互相 require。
 *
 * 现状（2026-10-25 强制登录后）：入站分叉链路仍在工作（未登录访客点分享卡片
 * → 种模板 → 登录时并入账号）；但「欢迎横幅」与「重新载入分享的目标」两个
 * 出口实际不可达 —— 未登录用户会被登录闸门立刻带走，而登录又会清掉分叉记录
 * （clearOnLogin）。保留它们是给未配置 ENV_ID 的本地模式用的，别当活功能排期。
 */

const CFG = require('./config.js');
const M = require('./model.js');
const U = require('./util.js');

/** 分享路径里参数名：/pages/today/today?fr=<base64url> */
const QUERY_KEY = 'fr';

/** 卡片路径长度保险丝：微信对分享 path 的 query 有长度限制，
 *  超限时先丢障碍/预案字段、再逐个丢目标，绝不生成打不开的链接。 */
const MAX_ENCODED = 1400;

/** 模板最多带 8 个目标：分享的是「计划」，不是整份账号搬家 */
const MAX_GOALS = 8;

/* ================= base64url 编解码 =================
   不用 encodeURIComponent：中文一个字会膨胀成 9 个字符，
   base64（3 字节 → 4 字符）只有它的 44%，同样目标数能省一半路径长度。 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Encode(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xffff) i++;              // 代理对：codePointAt 取到完整码点后要跳两位
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function utf8Decode(bytes) {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let c = 0;
    let extra = 0;
    if (b < 0x80) { c = b; extra = 0; }
    else if (b >= 0xc0 && b < 0xe0) { c = b & 0x1f; extra = 1; }
    else if (b >= 0xe0 && b < 0xf0) { c = b & 0x0f; extra = 2; }
    else if (b >= 0xf0 && b < 0xf8) { c = b & 0x07; extra = 3; }
    else return null;                 // 非法首字节
    for (let j = 0; j < extra; j++) {
      const nb = bytes[i + 1 + j];
      if (nb === undefined || (nb & 0xc0) !== 0x80) return null;
      c = (c << 6) | (nb & 0x3f);
    }
    i += 1 + extra;
    if (c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return null;
    s += String.fromCodePoint(c);
  }
  return s;
}

function b64FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    s += B64[b0 >> 2];
    s += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    if (b1 === undefined) break;
    s += B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    if (b2 === undefined) break;
    s += B64[b2 & 63];
  }
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64(s) {
  const clean = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const out = [];
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = B64.indexOf(clean[i]);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

/* ================= 模板：state → 紧凑数组 → state ================= */

/**
 * 目标行结构（数组比对象省一半字符）：
 *   [name, unit, total, days, colorIdx, obstacle?, plan?]
 * days = 分享者当初设定的总天数。不给截止日：同学的截止日 = 他的今天 + days - 1，
 * 节奏与分享者从头开始时一致，而不是背着分享者已产生的追赶欠账。
 */
function goalRow(g) {
  const days = Math.max(1, U.diffDays(g.createdAt || U.todayStr(), g.deadline) + 1);
  const row = [
    U.cleanText(g.name, 30),
    U.cleanText(g.unit, 6) || '个',
    Math.round(Number(g.total) || 0),
    Math.min(3650, days),
    Math.max(0, M.COLORS.indexOf(g.color))
  ];
  const obstacle = U.cleanText(g.obstacle, 60);
  const plan = U.cleanText(g.plan, 60);
  if (obstacle || plan) row.push(obstacle);   // plan 占第 7 位，obstacle 空也要占位
  if (plan) row.push(plan);
  return row;
}

/** 从当前状态提炼分享模板：活跃、非示例的目标，按卡片顺序最多 8 个 */
function tplFromState(st) {
  const goals = M.activeGoals(st).filter((g) => !g.sample).slice(0, MAX_GOALS);
  return { v: 1, g: goals.map(goalRow) };
}

/** 模板 → 同学手机上的目标。每一个都过 normalizeGoal，坏行直接丢弃。 */
function goalsFromTpl(tpl) {
  if (!tpl || tpl.v !== 1 || !Array.isArray(tpl.g)) return [];
  const today = U.todayStr();
  const out = [];
  tpl.g.slice(0, MAX_GOALS).forEach((row) => {
    if (!Array.isArray(row) || row.length < 5) return;
    const name = U.cleanText(row[0], 30);
    if (!name) return;
    const total = Number(row[2]);
    const days = Number(row[3]);
    if (!U.finiteNumber(total, 1, 1e9)) return;
    if (!U.finiteNumber(days, 1, 3650)) return;
    const obstacle = row.length > 5 ? U.cleanText(row[5], 60) : '';
    const plan = row.length > 6 ? U.cleanText(row[6], 60) : '';
    const candidate = {
      id: U.uid(),
      name: name,
      unit: U.cleanText(row[1], 6) || '个',
      total: total,
      deadline: U.addDays(today, Math.round(days) - 1),
      createdAt: today,
      color: M.COLORS[Math.min(M.COLORS.length - 1, Math.max(0, Number(row[4]) || 0))],
      obstacle: obstacle,
      plan: plan
    };
    const g = M.normalizeGoal(candidate);
    if (g) out.push(g);
  });
  return out;
}

/* ================= 编码 ================= */

function encodeTpl(tpl) {
  return b64FromBytes(utf8Encode(JSON.stringify(tpl)));
}

function decodeTpl(str) {
  if (typeof str !== 'string' || !str || str.length > MAX_ENCODED * 2) return null;
  try {
    const text = utf8Decode(bytesFromB64(str));
    if (text === null) return null;
    const tpl = JSON.parse(text);
    if (!tpl || tpl.v !== 1 || !Array.isArray(tpl.g)) return null;
    return tpl;
  } catch (e) { return null; }
}

/** 超长时逐级裁剪：先丢文案字段，再丢目标，保证路径永远打得开 */
function encodeTplFit(tpl) {
  let s = encodeTpl(tpl);
  if (s.length <= MAX_ENCODED) return s;
  const lean = { v: 1, g: tpl.g.map((r) => r.slice(0, 5)) };
  s = encodeTpl(lean);
  let g = lean.g;
  while (s.length > MAX_ENCODED && g.length > 1) {
    g = g.slice(0, g.length - 1);
    s = encodeTpl({ v: 1, g: g });
  }
  return s.length <= MAX_ENCODED ? s : '';
}

/* ================= 分叉记录（纯本机） ================= */

function read() {
  try {
    const raw = wx.getStorageSync(CFG.K.FORK);
    if (!raw || typeof raw !== 'object') return null;
    const rec = typeof raw === 'string' ? U.safeJson(raw, null) : raw;
    if (!rec || rec.forked !== true) return null;
    return {
      forked: true,
      at: U.finiteNumber(rec.at, 0, 1e15) ? rec.at : 0,
      welcomed: rec.welcomed === true,
      tpl: typeof rec.tpl === 'string' ? rec.tpl : ''
    };
  } catch (e) { return null; }
}

function write(rec) {
  try { wx.setStorageSync(CFG.K.FORK, rec); } catch (e) { /* 配额满等情况不阻塞主流程 */ }
}

function clear() {
  try { wx.removeStorageSync(CFG.K.FORK); } catch (e) { }
}

/** 登录即完成分叉的使命：数据从此跟账号走，本机不再需要分叉记录 */
function clearOnLogin() { clear(); }

function pendingWelcome() {
  const rec = read();
  return !!(rec && !rec.welcomed);
}

function markWelcomed() {
  const rec = read();
  if (rec && !rec.welcomed) write({ forked: true, at: rec.at, welcomed: true, tpl: rec.tpl });
}

function info() {
  const rec = read();
  if (!rec) return { forked: false, at: 0 };
  return { forked: true, at: rec.at };
}

/* ================= 入站判定（纯函数） ================= */

/**
 * 判定一次带 ?fr= 的打开要不要分叉。返回执行计划，不直接改数据：
 *   { apply:true,  goals, tpl }   → 调用方（store）落盘
 *   { apply:false, reason }       → 'no-query' | 'logged' | 'already' | 'own-progress' | 'bad-tpl'
 * 判定顺序即优先级：已登录不分叉（他有自己的账号）；
 * 已分叉不分叉（本机进度属于这位同学，换卡片也不覆盖 —— H5 第 17 轮同款闸门）；
 * 自己已有进度不分叉（那份数据比模板重要）。
 */
function planIncoming(query, logged, st) {
  const fr = query && query[QUERY_KEY];
  if (!fr || typeof fr !== 'string') return { apply: false, reason: 'no-query' };
  if (logged) return { apply: false, reason: 'logged' };
  if (read()) return { apply: false, reason: 'already' };

  const tpl = decodeTpl(fr);
  if (!tpl) return { apply: false, reason: 'bad-tpl' };
  const goals = goalsFromTpl(tpl);
  if (!goals.length) return { apply: false, reason: 'bad-tpl' };

  const hasOwn = (st && st.goals && st.goals.some((g) => !g.deleted && !g.sample))
    || (st && st.logs && st.logs.some((l) => !l.deleted));
  if (hasOwn) return { apply: false, reason: 'own-progress' };

  /* 记录里存访客收到的原始串：能打开一次就能打开第二次，重载时逐字节还原 */
  return { apply: true, goals: goals, tpl: fr };
}

/* ================= 出站：构造转发卡片 ================= */

/**
 * 四个页签共用的转发配置。路径固定指向今日页（同学的入口就是打卡页），
 * 模板取当前状态 —— 未登录的分享者也能分享（模板 = 他手机上的真实目标）。
 */
function shareConfig(st) {
  const tpl = tplFromState(st || { goals: [] });
  const enc = encodeTplFit(tpl);
  const path = enc
    ? '/pages/today/today?' + QUERY_KEY + '=' + enc
    : '/pages/today/today';
  return {
    title: '学习目标打卡，分享给你一起坚持',
    path: path
  };
}

module.exports = {
  QUERY_KEY, MAX_GOALS, MAX_ENCODED,
  utf8Encode, utf8Decode, b64FromBytes, bytesFromB64,
  tplFromState, goalsFromTpl, encodeTpl, decodeTpl, encodeTplFit,
  read, write, clear, clearOnLogin, pendingWelcome, markWelcomed, info,
  planIncoming, shareConfig
};
