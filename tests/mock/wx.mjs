/**
 * 小程序运行环境模拟。
 *
 * 关键在于 wx.cloud.callFunction 不是「返回一个假的成功」，
 * 而是把请求真的转给云函数目录下的 service.js，配上内存数据库。
 * 于是页面测试覆盖的是一条完整的纵向链路：
 *
 *   Page 事件 → utils 层 → wx.cloud.callFunction（此处拦截）
 *     → 云函数的 lib/service.js → 内存数据库 → 原路返回 → 页面 setData
 * （注意：注释里不要出现「星号 + 斜杠」的下接写法，它会把块注释提前闭合）
 *
 * 这样能抓到的 bug（页面里字段写错、错误码没处理、同步时机不对）
 * 是纯静态检查和单元测试都看不见的那一类。
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_CF = path.join(HERE, '..', '..', 'cloudfunctions');

/** 每个测试文件独立缓冲，避免用例之间互相影响 */
export function createStorage() {
  const map = new Map();
  return {
    map,
    get(k) { return map.has(k) ? map.get(k) : ''; },
    set(k, v) { map.set(k, v); },
    remove(k) { map.delete(k); },
    clear() { map.clear(); }
  };
}

/**
 * @param {object} opts { db, openid, storage }
 */
export function installWxEnv(opts) {
  const o = opts || {};
  const storage = o.storage || createStorage();
  const state = {
    db: o.db,
    openid: o.openid || 'openid-test',
    storage,
    callCount: { auth: 0, sync: 0 },
    log: [],
    app: null,
    pageStack: []
  };

  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    removeStorageSync: (k) => storage.remove(k),
    clearStorageSync: () => storage.clear(),

    showToast: (arg) => { state.log.push({ type: 'toast', title: arg && arg.title }); },
    hideToast: () => { },
    showLoading: () => { },
    hideLoading: () => { },
    showModal: (arg) => {
      state.log.push({ type: 'modal', title: arg && arg.title });
      // 默认「取消」：危险的破坏性操作不会被测试意外触发。
      // 测试需要走确认分支时，先设 state.modalAnswer = { confirm: true }。
      const ans = state.modalAnswer || { confirm: false, cancel: true };
      if (arg && arg.success) arg.success(ans);
    },
    setClipboardData: (arg) => { state.log.push({ type: 'copy', data: arg && arg.data }); if (arg && arg.success) arg.success(); },

    navigateTo: (arg) => { state.log.push({ type: 'navigateTo', url: arg && arg.url }); },
    redirectTo: (arg) => { state.log.push({ type: 'redirectTo', url: arg && arg.url }); },
    reLaunch: (arg) => { state.log.push({ type: 'reLaunch', url: arg && arg.url }); },
    switchTab: (arg) => { state.log.push({ type: 'switchTab', url: arg && arg.url }); },
    navigateBack: () => { state.log.push({ type: 'navigateBack' }); },
    hideTabBar: (arg) => { state.log.push({ type: 'hideTabBar' }); if (arg && arg.success) arg.success(); },
    showTabBar: (arg) => { state.log.push({ type: 'showTabBar' }); if (arg && arg.success) arg.success(); },
    stopPullDownRefresh: () => { },
    vibrateShort: (arg) => { state.log.push({ type: 'vibrate' }); if (arg && arg.fail) { /* 不调用 fail，模拟支持震动 */ } },
    setNavigationBarColor: () => { },

    /* 音频：桩实例把每次 play 时的 src 与 volume 记进日志，
       音效测试据此断言「60% 真的变成了 0.6 的增益」。
       真机上 src 指向代码包路径，volume 是 0~1。 */
    createInnerAudioContext: () => {
      const inst = {
        src: '',
        volume: 1,
        autoplay: false,
        loop: false,
        startTime: 0,
        _onError: null,
        play() { state.log.push({ type: 'audio', action: 'play', src: inst.src, volume: inst.volume }); },
        pause() { state.log.push({ type: 'audio', action: 'pause' }); },
        stop() { state.log.push({ type: 'audio', action: 'stop' }); },
        seek() { },
        destroy() { state.log.push({ type: 'audio', action: 'destroy' }); },
        onError(cb) { inst._onError = cb; },
        offError() { inst._onError = null; },
        onPlay() { }, onEnded() { }, onCanplay() { }
      };
      state.audio = state.audio || [];
      state.audio.push(inst);
      return inst;
    },

    /* WebAudio：只实现音效层用到的那几个节点，所有振荡器在 start() 时
       往日志里写一条 { type:'osc', wave, freq }，测试据此断言「音阶对不对」。 */
    createWebAudioContext: () => {
      const ctx = {
        state: 'running',
        currentTime: 0,
        destination: {
          __type: 'destination',
          __connected: [],
          _receive(node) { this.__connected.push(node); }
        },
        resume() { ctx.state = 'running'; },
        close() { ctx.state = 'closed'; },
        createGain() {
          const node = {
            __type: 'gain',
            gain: {
              value: 1,
              setValueAtTime(v) { node.gain.value = v; },
              exponentialRampToValueAtTime(v) { node.gain.value = v; },
              setTargetAtTime(v) { node.gain.value = v; },
              linearRampToValueAtTime(v) { node.gain.value = v; }
            },
            connect(target) {
              if (target && typeof target._receive === 'function') target._receive(node);
              return node;
            }
          };
          return node;
        },
        createOscillator() {
          const node = {
            __freq: 0,
            type: 'sine',
            frequency: {
              setValueAtTime(v) { node.__freq = v; },
              exponentialRampToValueAtTime(v) { node.__to = v; }
            },
            detune: { setValueAtTime() { } },
            connect() { return node; },
            start(t) {
              state.log.push({ type: 'osc', wave: node.type, freq: node.__freq, at: t || 0 });
            },
            stop() { }
          };
          return node;
        },
        createBiquadFilter() {
          return {
            type: 'lowpass',
            frequency: { setValueAtTime() { } },
            Q: { value: 0 },
            connect() { return this; }
          };
        }
      };
      state.audioCtxs = state.audioCtxs || [];
      state.audioCtxs.push(ctx);
      return ctx;
    },

    getDeviceInfo: () => ({ platform: 'devtools', brand: 'Apple', model: 'iPhone 15', system: 'iOS 17.5' }),
    getAppBaseInfo: () => ({ SDKVersion: '3.5.5' }),
    getSystemInfoSync: () => ({ platform: 'devtools', SDKVersion: '3.5.5' }),

    cloud: {
      init() { },
      callFunction(arg) {
        const name = arg && arg.name;
        if (name !== 'auth' && name !== 'sync') {
          return Promise.reject(new Error('unknown cloud function ' + name));
        }
        state.callCount[name]++;
        // 真正把请求交给云函数的 service 层
        const { repo: authRepo } = require(path.join(ROOT_CF, 'auth', 'lib', 'repo.js'));
        const { repo: syncRepo } = require(path.join(ROOT_CF, 'sync', 'lib', 'repo.js'));
        const authService = require(path.join(ROOT_CF, 'auth', 'lib', 'service.js'));
        const syncService = require(path.join(ROOT_CF, 'sync', 'lib', 'service.js'));

        const ctx = {
          repo: name === 'auth' ? authRepo(state.db) : syncRepo(state.db),
          now: Date.now(),
          openid: state.openid,
          unionid: '',
          source: state.openid,
          clientIp: '127.0.0.1'
        };
        const svc = name === 'auth' ? authService : syncService;

        return new Promise((resolve) => {
          let p;
          try { p = svc.handle(ctx, arg.data && arg.data.action, arg.data); }
          catch (e) { p = Promise.reject(e); }
          p.then(
            (data) => resolve({ result: { ok: true, data: data } }),
            (err) => resolve({ result: { ok: false, code: err.code || 'SERVER_ERROR', message: err.message || '失败' } })
          );
        });
      }
    }
  };

  globalThis.wx = wx;
  globalThis.App = (options) => { state.appOptions = options; return options; };
  globalThis.Page = (options) => { state.lastPage = options; return options; };
  globalThis.Component = (options) => options;
  globalThis.getApp = () => state.app || { globalData: { cloudReady: true, cloudError: '', bootPromise: Promise.resolve({ ok: false }), bootResult: null, dataReady: true } };
  globalThis.getCurrentPages = () => state.pageStack;

  return state;
}

/**
 * 加载一个页面模块并返回它的配置对象。
 * 小程序里 Page() 是在模块加载时调用的，所以每条用例都要清缓存重新加载，
 * 否则第二次拿到的还是第一次那份 data（用例之间会互相污染）。
 */
export function loadPage(absPath) {
  delete require.cache[require.resolve(absPath)];
  let captured = null;
  const prev = globalThis.Page;
  globalThis.Page = (options) => { captured = options; return options; };
  try {
    require(absPath);
  } finally {
    globalThis.Page = prev;
  }
  if (!captured) throw new Error('页面文件没有调用 Page()：' + absPath);
  return captured;
}

/**
 * 把页面配置实例化成可调用的对象：
 * 复制 data、实现 setData（支持 'a.b' 路径写法）、并绑定 this。
 */
export function instantiate(pageOptions) {
  const inst = Object.assign({}, pageOptions);
  inst.data = JSON.parse(JSON.stringify(pageOptions.data || {}));
  inst.setData = function (patch, cb) {
    Object.keys(patch).forEach((key) => {
      if (key.indexOf('.') < 0) { inst.data[key] = patch[key]; return; }
      const parts = key.split('.');
      let cur = inst.data;
      for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = patch[key];
    });
    if (cb) cb();
  };
  inst.getTabBar = function () { return null; };
  // 把所有方法绑定到实例上，模拟小程序的调用语义
  Object.keys(pageOptions).forEach((k) => {
    if (typeof pageOptions[k] === 'function') inst[k] = pageOptions[k].bind(inst);
  });
  return inst;
}
