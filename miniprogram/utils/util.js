/**
 * 通用工具：日期、数字、字符串。
 * 与 H5 版 work.html 的同名函数保持逐行等价，保证两端对同一份数据算出同样的结果。
 */

function pad(n) { return (n < 10 ? '0' : '') + n; }

function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

function parseDate(s) {
  const p = String(s).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function todayStr() { return fmtDate(new Date()); }

function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

/** b - a，单位天 */
function diffDays(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

function fmtShort(s) {
  const p = String(s).split('-');
  return Number(p[1]) + '月' + Number(p[2]) + '日';
}

function weekdayCN(s) { return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][parseDate(s).getDay()]; }

function mondayOf(dateStr) {
  const d = parseDate(dateStr);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return fmtDate(d);
}

function isDateString(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = parseDate(v);
  return !isNaN(d.getTime()) && fmtDate(d) === v;
}

function finiteNumber(v, min, max) {
  return typeof v === 'number' && isFinite(v) && v >= min && v <= max;
}

function cleanText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

function trimNum(n) {
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return (Math.round(n * 10) / 10).toString();
}

function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }

/** 单调递增的写入时间戳：LWW 合并的比较基准 */
let lastStamp = 0;
function nextStamp() {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function safeJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/**
 * 目标配色的主题适配。
 * COLORS 里存的是写进数据的旧 hex（改值会让存量数据校验失败），
 * 渲染时统一换成 --gc-<hex> 变量：浅色解析为原始色、深色自动提亮。
 * 与 H5 版 gcolor() 等价。
 */
function gcolor(hex) {
  const h = String(hex || '').toLowerCase();
  return 'var(--gc-' + h.replace(/[^0-9a-f]/g, '') + ', ' + h + ')';
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** 相对时间：用于「最近同步」显示 */
function fmtAgo(ts, nowTs) {
  if (!ts) return '尚未同步';
  const now = nowTs || Date.now();
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 10) return '刚刚';
  if (sec < 60) return sec + ' 秒前';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  if (sec < 86400 * 30) return Math.floor(sec / 86400) + ' 天前';
  const d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

module.exports = {
  pad, fmtDate, parseDate, todayStr, addDays, diffDays, fmtShort, weekdayCN, mondayOf,
  isDateString, finiteNumber, cleanText, trimNum, uid, nextStamp, clone, safeJson,
  gcolor, fmtBytes, fmtAgo
};
