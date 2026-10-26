/**
 * 微信身份层。
 *
 * 身份就是 openid —— 由云函数从调用上下文里取，客户端拿不到也存不了。
 * 所以这个模块里**没有任何凭据**：本地只缓存一份 user（昵称、加入时间）用来渲染，
 * 它不承担鉴权作用，删了也不影响下次能不能进。
 *
 * 于是「登录」只剩一个动作：调 auth 云函数的 login。
 *   第一次：服务端用当前 openid 建号；
 *   之后：同一个 openid 命中同一个账号，直接回来。
 *
 * 和以前邮箱账号最大的区别：换手机用同一个微信登录，数据还在；
 * 换微信号、微信被封，数据找不回来。这一点在登录页与「我的」页都写明了。
 */

const CFG = require('./config.js');
const api = require('./api.js');

const K = CFG.K;

let current = null;          // { user }
let listeners = [];
let loggingIn = null;        // 进行中的登录 Promise（防止连点发出多次建号请求）

/* ================= 事件 ================= */

function on(cb) { listeners.push(cb); return function off() { listeners = listeners.filter((f) => f !== cb); }; }
function emit(evt) { listeners.forEach((f) => { try { f(evt); } catch (e) { /* 单个监听器出错不影响其它 */ } }); }

/* ================= 本机缓存 ================= */

function readCached() {
  try {
    const raw = wx.getStorageSync(K.USER);
    if (!raw) return null;
    const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!o || !o.user || !o.user.id) return null;
    return o;
  } catch (e) { return null; }
}

function writeCached(user) {
  current = user ? { user: user } : null;
  try {
    if (user) wx.setStorageSync(K.USER, JSON.stringify({ user: user }));
    else wx.removeStorageSync(K.USER);
  } catch (e) { /* 存储写失败不阻塞登录流程 */ }
}

function clearCached() {
  current = null;
  try { wx.removeStorageSync(K.USER); } catch (e) { }
}

/* ================= 设备信息 ================= */

/**
 * 稳定设备 ID：只用于在同步统计里区分「这条分片最后是谁写的」，
 * 不再是登录设备管理的凭据（已经没有会话了）。
 */
let cachedDeviceId = null;
function deviceId() {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    let v = wx.getStorageSync('lgt.device.v1');
    if (!v) {
      v = 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
      wx.setStorageSync('lgt.device.v1', v);
    }
    cachedDeviceId = v;
  } catch (e) {
    cachedDeviceId = 'd-tmp-' + Math.random().toString(36).slice(2, 10);
  }
  return cachedDeviceId;
}

/* ================= 状态查询 ================= */

function isLogged() { return !!(current && current.user && current.user.id); }

function user() { return current ? current.user : null; }

/**
 * 同步地把本机身份缓存载入内存（不发网络请求）。
 *
 * 冷启动必须在 onLaunch 里、页面渲染之前调用：否则第一帧的 auth.isLogged()
 * 还是 false，老用户会先看到「登录」入口 / 「未登录」，等会话校验回来才翻过来。
 * 本地缓存的 user 只用于渲染，不承担鉴权；真正的身份仍由云函数侧的 openid 决定。
 */
function hydrate() {
  if (current) return user();
  const cached = readCached();
  if (cached) current = cached;
  return user();
}

/* ================= 动作 ================= */

/**
 * 微信一键登录。第一次会自动建号。
 * @returns {Promise<{user:object, isNewAccount:boolean}>}
 */
function login() {
  if (loggingIn) return loggingIn;
  loggingIn = api.callAuth('login', {})
    .then((data) => {
      writeCached(data.user);
      emit({ type: 'login', user: data.user, isNewAccount: !!data.isNewAccount });
      return data;
    })
    .then(
      (d) => { loggingIn = null; return d; },
      (e) => { loggingIn = null; throw e; }
    );
  return loggingIn;
}

/**
 * 冷启动 / 前台恢复。
 * 有本地缓存就先按已登录渲染（不等网络），再静默向云端核对一次：
 *   - 核对成功：以服务端返回的 user 为准（昵称可能在别的设备上改过）
 *   - 账号在服务端不存在（NOT_REGISTERED）：清掉本地缓存，回到未登录
 *   - 网络问题：保留本地缓存，绝不因为一次断网就把用户踢下线
 */
function restore() {
  const cached = readCached();
  if (!cached) return Promise.resolve({ ok: false, reason: 'no-user', user: null });
  current = cached;

  return api.callAuth('me', {})
    .then((data) => {
      writeCached(data.user);
      emit({ type: 'session', user: data.user });
      return { ok: true, user: data.user, cached: false };
    })
    .catch((e) => {
      if (api.isAuthError(e)) {
        clearCached();
        emit({ type: 'logout', reason: e.code });
        return { ok: false, reason: e.code, user: null };
      }
      return { ok: false, reason: 'network', keepLocal: true, user: cached.user, error: e };
    });
}

/**
 * 退出：只清本机的身份缓存，云端数据一条不动。
 * 没有密码也没有会话，所以「退出」的语义很轻 —— 再点一次一键登录就回来了。
 */
function logout() {
  clearCached();
  emit({ type: 'logout' });
  return Promise.resolve();
}

/**
 * 注销账号：永久删除账号与它的全部云端数据。
 * 成功后立刻清掉本地身份；本机记录由调用方决定要不要一起清
 * （「我的」页的注销流程会一并清空，否则会留下一个没有归属的游客副本）。
 */
function deleteAccount() {
  return api.callAuth('deleteAccount', { confirm: 'DELETE' })
    .then((r) => {
      clearCached();
      emit({ type: 'logout', reason: 'account-deleted' });
      return r;
    });
}

/** 更新昵称 */
function updateProfile(patch) {
  return api.callAuth('updateProfile', patch || {})
    .then((data) => {
      if (data.user) { writeCached(data.user); emit({ type: 'profile', user: data.user }); }
      return data;
    });
}

/** 同步失败时如果发现账号没了，清本地并广播登出 */
function requireLogin(promiseFactory) {
  return promiseFactory().catch((e) => {
    if (api.isAuthError(e)) {
      clearCached();
      emit({ type: 'logout', reason: e.code });
    }
    throw e;
  });
}

module.exports = {
  on: on,
  isLogged: isLogged,
  user: user,
  hydrate: hydrate,
  deviceId: deviceId,
  login: login,
  restore: restore,
  logout: logout,
  deleteAccount: deleteAccount,
  updateProfile: updateProfile,
  requireLogin: requireLogin,
  readCached: readCached,
  clearCached: clearCached
};
