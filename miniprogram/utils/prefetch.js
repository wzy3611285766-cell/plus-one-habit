/**
 * 数据预拉取的客户端。
 *
 * 链路：小程序后台配置「云开发 + prefetch 云函数」→ 用户冷启动时微信先调云函数，
 * 把返回的字符串缓存到本地 → 代码包加载完，这里用
 * wx.getBackgroundFetchData({ fetchType: 'pre' }) 把缓存取回来 → store 按 rev 采纳。
 *
 * 三个设计取舍：
 *   1. 只读不写、解析失败一律当没有：预拉取是「加速」，任何异常都必须安静降级到
 *      常规的 sync.pull，不能因为缓存脏了就让用户看到错误或空白。
 *   2. 需要 userId 匹配（在 store.applyPrefetched 里判定）：换微信号登录后，
 *      微信缓存里可能还是上一个人的数据，绝不能串号。
 *   3. 强制设置 BackgroundFetchToken：不设时微信用 code 代替 token，
 *      可能顺带刷新登录态（官方文档的提醒）；我们只想要数据，不想要这个副作用。
 */

const M = require('./model.js');
const CFG = require('./config.js');

const TOKEN_KEY = 'lgt.prefetch.token.v1';
const READ_TIMEOUT_MS = 300;

/**
 * 解析缓存体。入参可能是字符串（正常）或对象（测试/旧版本）。
 * 坏数据一律返回 null —— 调用方据此走常规拉取。
 */
function parse(raw) {
  let o = raw;
  if (typeof raw === 'string') {
    if (!raw) return null;
    try { o = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!o || typeof o !== 'object') return null;
  if (o.v !== 1) return null;
  if (typeof o.userId !== 'string' || !o.userId) return null;
  if (!o.shards || typeof o.shards !== 'object' || Array.isArray(o.shards)) return null;

  const shards = {};
  Object.keys(o.shards).forEach((k) => {
    if (!M.isKnownShardKey(k)) return;
    const s = o.shards[k];
    if (!s || typeof s !== 'object') return;
    if (typeof s.rev !== 'number' || !isFinite(s.rev) || s.rev < 1) return;
    if (!s.payload || typeof s.payload !== 'object') return;
    shards[k] = { rev: Math.floor(s.rev), payload: s.payload };
  });
  if (!Object.keys(shards).length) return null;

  const at = (typeof o.at === 'number' && isFinite(o.at) && o.at > 0) ? o.at : 0;
  return { v: 1, at: at, userId: o.userId, partial: o.partial === true, shards: shards };
}

/**
 * 取微信缓存的预拉取数据。
 * @returns {Promise<object|null>} 解析后的载荷；没有缓存 / 不支持 / 超时 → null
 */
function read() {
  return new Promise((resolve) => {
    if (typeof wx === 'undefined' || typeof wx.getBackgroundFetchData !== 'function') {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), READ_TIMEOUT_MS);

    try {
      wx.getBackgroundFetchData({
        fetchType: 'pre',
        success(res) {
          clearTimeout(timer);
          finish(parse(res && res.fetchedData));
        },
        fail() {
          clearTimeout(timer);
          finish(null);
        }
      });
    } catch (e) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * 给微信设置预拉取 token（本机随机串，服务端不校验，只用来避免 code 分支）。
 * 每次启动都可以调，微信会覆盖旧值。
 */
function ensureToken() {
  if (typeof wx === 'undefined' || typeof wx.setBackgroundFetchToken !== 'function') return;
  let token = '';
  try { token = wx.getStorageSync(TOKEN_KEY) || ''; } catch (e) { token = ''; }
  if (!token) {
    token = 'p1-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    try { wx.setStorageSync(TOKEN_KEY, token); } catch (e) { /* 写失败只是退化成 code 分支 */ }
  }
  try {
    wx.setBackgroundFetchToken({ token: token, fail() { /* 旧基础库没有这个能力，忽略 */ } });
  } catch (e) { /* 同上 */ }
}

/** 载荷是否足够新鲜，可以用来跳过登录后的全量拉取 */
function isFresh(payload, now) {
  if (!payload || !payload.at) return false;
  const age = (now || Date.now()) - payload.at;
  return age >= 0 && age <= CFG.TIMING.PREFETCH_FRESH_MS;
}

module.exports = {
  TOKEN_KEY: TOKEN_KEY,
  READ_TIMEOUT_MS: READ_TIMEOUT_MS,
  parse: parse,
  read: read,
  ensureToken: ensureToken,
  isFresh: isFresh
};
