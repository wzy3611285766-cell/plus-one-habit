/**
 * 统一错误码。
 *
 * 约定：
 *   - 云函数永远返回 { ok:false, code, message }，不把异常直接抛给客户端
 *     （否则客户端只能拿到一个没有信息量的 errMsg）。
 *   - message 是给人看的中文，前端可以直接展示，不需要再维护一份文案映射。
 *   - code 是给程序分支用的稳定标识。
 *
 * 本文件在 auth 与 sync 两个云函数里各有一份副本，且必须逐字节相同
 * （微信云函数无法跨目录 require）。由 tests/shared-kernel.test.mjs 守着。
 */

const CODES = {
  INVALID_INPUT: 'INVALID_INPUT',

  /* ---- 微信身份 ---- */
  OPENID_MISSING: 'OPENID_MISSING',   // 云函数拿不到 OPENID（非微信环境调用）
  NOT_REGISTERED: 'NOT_REGISTERED',   // 这个微信还没有账号，需要先走一次一键登录
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',

  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  CONFLICT: 'CONFLICT',
  SERVER_ERROR: 'SERVER_ERROR'
};

function AppError(code, message, extra) {
  const e = new Error(message || code);
  e.name = 'AppError';
  e.code = code;
  e.retryAfter = (extra && extra.retryAfter) || 0;
  return e;
}

/** 把任意异常统一成对外的信封结构 */
function toEnvelope(err) {
  if (err && err.name === 'AppError') {
    const out = { ok: false, code: err.code, message: err.message };
    if (err.retryAfter) out.retryAfter = err.retryAfter;
    return out;
  }
  // 未预期的异常：日志留全量，对外只给一句通用提示
  console.error('[cloud] unexpected error', err && (err.stack || err.message || err));
  return { ok: false, code: CODES.SERVER_ERROR, message: '服务暂时不可用，请稍后重试' };
}

function ok(data) { return { ok: true, data: data || {} }; }

module.exports = { CODES: CODES, AppError: AppError, toEnvelope: toEnvelope, ok: ok };
