/**
 * 数据预拉取的服务端。
 *
 * 协议（微信《数据预拉取》）：
 *   冷启动时微信服务器**直接调用**这个云函数的 index.js，
 *   把整个返回值当作字符串缓存到本地；客户端用
 *   wx.getBackgroundFetchData({ fetchType: 'pre' }) 取回。
 *
 * 三条硬约束决定了这里的写法：
 *   1. 返回值必须是**字符串**，且不超过 256KB —— 所以我们自己先卡在 200KB，
 *      超出时丢掉最旧的月份并标记 partial（客户端见 partial 就不跳过常规拉取）。
 *   2. 这个调用**不是客户端发起的**，所以 cloud.getWXContext().OPENID 可能为空；
 *      微信会把身份放在 event.openId（或 event.userInfo.openId）里。
 *      但 event 是**客户端可伪造**的（任何人都能 wx.cloud.callFunction 调本函数），
 *      因此只在 ctx.openid 为空时才采信 event 里的身份 —— 客户端直接调用时
 *      ctx.openid 一定存在且不可伪造，event 里的 openId 会被忽略。
 *   3. 预拉取发生在冷启动关键路径上，只能做「两次查询 + 拼字符串」，
 *      不做合并、不写库、不调其它云函数。
 *
 * 返回体只带副本（不删不改云端数据）：
 *   { v, at, userId, partial, shards: { 'core': {rev,payload}, 'logs:2026-10': {rev,payload} } }
 * 客户端按 rev 与 dirty 标记决定要不要采纳，服务端不替客户端做合并。
 */

const VERSION = 1;

/** 微信的硬上限是 256KB；留出余量，避免边界上刚好被丢弃 */
const MAX_BODY_BYTES = 200 * 1024;

const LOGS_PREFIX = 'logs:';
const LOGS_RE = /^logs:\d{4}-(0[1-9]|1[0-2])$/;

function isKnownKey(k) {
  return k === 'core' || (typeof k === 'string' && LOGS_RE.test(k));
}

function byteLen(s) {
  try { return Buffer.byteLength(s, 'utf8'); } catch (e) { return 0; }
}

function emptyPayload(at) {
  return { v: VERSION, at: at || 0, userId: '', partial: false, shards: {} };
}

/**
 * 找出这次调用代表哪个微信。
 * ctx.openid 由微信在「小程序内调用」时注入，不可伪造，优先；
 * 预拉取调用没有客户端上下文，退到 event 里的 openId。
 * @returns {{ openid: string, via: 'context'|'event'|'' }}
 */
function resolveOpenid(ctx, event) {
  if (ctx && ctx.openid) return { openid: ctx.openid, via: 'context' };
  const e = event || {};
  const u = e.userInfo || {};
  const id = e.openId || e.openid || u.openId || u.openid || '';
  return { openid: typeof id === 'string' ? id : '', via: id ? 'event' : '' };
}

/**
 * 拼预拉取载荷。
 * @param {object} ctx { repo, now, openid }
 * @param {object} event 微信预拉取请求的事件（含 openId / userInfo）
 * @returns {Promise<string>} 可直接作为缓存体的 JSON 字符串
 */
async function build(ctx, event) {
  const at = (ctx && ctx.now) || Date.now();
  const out = emptyPayload(at);

  const id = resolveOpenid(ctx, event);
  if (!id.openid) {
    console.log('[prefetch] 无身份来源，返回空载荷');
    return JSON.stringify(out);
  }

  const account = await ctx.repo.findAccountByOpenid(id.openid);
  if (!account || account.status !== 'active') {
    console.log('[prefetch] 未建号或账号停用，返回空载荷 via=' + id.via);
    return JSON.stringify(out);
  }

  const rows = await ctx.repo.listDocs(account._id);
  const known = rows.filter((d) => d && isKnownKey(d.key));

  // core 先放（首屏全靠它），日志月份新的优先；预算不够时丢最旧的
  known.sort((a, b) => {
    if (a.key === 'core') return -1;
    if (b.key === 'core') return 1;
    return a.key < b.key ? 1 : -1;
  });

  const shards = {};
  let partial = false;
  let used = 0;

  for (let i = 0; i < known.length; i++) {
    const d = known[i];
    if (typeof d.rev !== 'number' || !isFinite(d.rev)) continue;
    const entry = { rev: d.rev, payload: d.payload || null };
    // 单个分片的字节 + 键名与分隔符的少量开销
    const bytes = byteLen(JSON.stringify(entry)) + d.key.length + 8;
    if (used + bytes > MAX_BODY_BYTES) { partial = true; break; }
    shards[d.key] = entry;
    used += bytes;
  }

  out.userId = account._id;
  out.shards = shards;
  out.partial = partial;

  let body = JSON.stringify(out);
  // 兜底：估算与实际序列化有偏差时，从最旧的分片开始丢，直到进预算
  if (byteLen(body) > MAX_BODY_BYTES) {
    const keys = Object.keys(shards).filter((k) => k !== 'core');
    keys.sort();
    while (byteLen(body) > MAX_BODY_BYTES && keys.length) {
      delete shards[keys.shift()];
      out.partial = true;
      body = JSON.stringify(out);
    }
  }

  /* 极端情况：core 一个分片就超过预算（服务端允许单分片到 512KB）。
     这时不能截断 core（会丢目标/复盘），也不能发超 256KB 的 body（微信不会缓存），
     干脆返回空载荷让客户端走常规 pull —— partial 标记只是给人看日志用的。 */
  if (byteLen(body) > MAX_BODY_BYTES) {
    out.shards = {};
    out.partial = true;
    body = JSON.stringify(out);
  }

  console.log('[prefetch] ok via=' + id.via + ' userId=' + account._id +
    ' shards=' + Object.keys(shards).length + ' bytes=' + byteLen(body) +
    ' partial=' + out.partial);
  return body;
}

module.exports = {
  VERSION: VERSION,
  MAX_BODY_BYTES: MAX_BODY_BYTES,
  build: build,
  emptyPayload: emptyPayload,
  resolveOpenid: resolveOpenid,
  isKnownKey: isKnownKey
};
