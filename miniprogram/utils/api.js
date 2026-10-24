/**
 * 云函数调用层。
 *
 * 所有云函数都返回统一的信封：
 *   成功 { ok:true,  data:{...} }
 *   失败 { ok:false, code:"XXX", message:"给人看的中文", retryAfter?:秒 }
 *
 * 本模块把这层信封拆开：成功 resolve(data)，失败 reject(ApiError)。
 * 上层只依赖 ApiError.code 做分支，不解析文案。
 */

const CFG = require('./config.js');

const CODES = [
  'NO_CLOUD',           // 未初始化云开发（ENV_ID 未填 / 基础库不支持）
  'NETWORK',            // 网络或云函数调用失败
  'BAD_RESPONSE',       // 云函数返回体不认识
  'INVALID_INPUT',
  'OPENID_MISSING',     // 云函数拿不到微信身份（非小程序环境）
  'NOT_REGISTERED',     // 这个微信还没建号
  'ACCOUNT_DISABLED',
  'PAYLOAD_TOO_LARGE',
  'CONFLICT',
  'SERVER_ERROR'
];

/**
 * 出现这些错误码时，本地的身份缓存已经不可信，应该清掉并回到未登录。
 * 只有 NOT_REGISTERED 符合：它表示「本地有缓存，但云端查不到这个微信的账号」。
 * 网络类错误绝不能列进来 —— 一次断网不等于没登录。
 */
const NEEDS_LOGIN = { NOT_REGISTERED: 1 };

function ApiError(code, message, extra) {
  const e = new Error(message || code);
  e.name = 'ApiError';
  e.code = code;
  e.apiMessage = message || '';
  e.retryAfter = (extra && extra.retryAfter) || 0;
  e.detail = (extra && extra.detail) || null;
  return e;
}

function isApiError(e) { return !!e && e.name === 'ApiError'; }

function isAuthError(e) { return isApiError(e) && !!NEEDS_LOGIN[e.code]; }

/** 是否值得自动重试（网络抖动 / 服务端 5xx） */
function isRetryable(e) { return isApiError(e) && (e.code === 'NETWORK' || e.code === 'SERVER_ERROR'); }

function cloudReady() {
  return typeof wx !== 'undefined' && !!wx.cloud && !!wx.cloud.callFunction && !!getApp().globalData.cloudReady;
}

/**
 * 调用云函数。
 * @param {string} name 云函数名
 * @param {object} data 入参（无需带 action，调用方自己带）
 * @returns {Promise<object>} data 字段
 */
function call(name, data) {
  return new Promise((resolve, reject) => {
    let app = null;
    try { app = getApp(); } catch (e) { app = null; }
    if (!app || !app.globalData || !app.globalData.cloudReady) {
      reject(ApiError('NO_CLOUD', '云开发尚未配置，账号功能不可用'));
      return;
    }
    wx.cloud.callFunction({
      name: name,
      data: data
    }).then((res) => {
      const r = res && res.result;
      if (!r || typeof r !== 'object') {
        reject(ApiError('BAD_RESPONSE', '服务返回格式异常'));
        return;
      }
      if (r.ok) { resolve(r.data || {}); return; }
      reject(ApiError(r.code || 'SERVER_ERROR', r.message || '操作失败', r));
    }).catch((err) => {
      // wx.cloud 自身失败：区分「函数不存在」与网络问题，便于排障
      const msg = (err && (err.errMsg || err.message)) || '';
      if (/FunctionName parameter could not be found|not found/i.test(msg)) {
        reject(ApiError('SERVER_ERROR', '云函数 ' + name + ' 尚未部署'));
        return;
      }
      reject(ApiError('NETWORK', '网络不可用，请稍后重试'));
    });
  });
}

function callAuth(action, payload) { return call(CFG.AUTH_FN, Object.assign({ action: action }, payload || {})); }

function callSync(action, payload) { return call(CFG.SYNC_FN, Object.assign({ action: action }, payload || {})); }

module.exports = {
  CODES: CODES,
  ApiError: ApiError,
  isApiError: isApiError,
  isAuthError: isAuthError,
  isRetryable: isRetryable,
  cloudReady: cloudReady,
  call: call,
  callAuth: callAuth,
  callSync: callSync
};
