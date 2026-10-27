/**
 * 小程序入口：初始化云开发 → 载入本机数据 → 采纳预拉取快照 → 恢复会话。
 *
 * 启动顺序是有讲究的（决定了用户看到什么）：
 *   1. 先 load 本机数据 —— 无论有没有网、有没有登录，界面都要能立刻渲染；
 *   2. 再读微信的预拉取缓存 —— 冷启动前就拿到的云端快照，按 rev/dirty 闸门采纳；
 *   3. 最后 restore 会话 —— 有本地身份就静默校验；命中新鲜快照时跳过全量拉取，
 *      只推本机真正脏的分片，失败也不影响前两步的结果。
 */

const CFG = require('./utils/config.js');
const store = require('./utils/store.js');
const auth = require('./utils/auth.js');
const prefs = require('./utils/prefs.js');
const sfx = require('./utils/sfx.js');
const prefetch = require('./utils/prefetch.js');

App({
  globalData: {
    cloudReady: false,
    cloudError: '',
    envId: CFG.ENV_ID,
    /** 冷启动恢复会话的 Promise，页面可以 await 它再决定渲染成登录态还是游客态 */
    bootPromise: null,
    /** 会话恢复结果：{ ok, reason } */
    bootResult: null,
    /** 是否已完成一次数据加载 */
    dataReady: false,
    /** 本次冷启动采纳的预拉取快照：{ userId, at, partial, shards } */
    prefetch: null,
    /** 自定义导航栏尺寸：状态栏高度 / 导航高度 / 右侧胶囊留白（由 measureNav 填充） */
    nav: { statusBar: 20, navH: 44, rightPad: 96 }
  },

  onLaunch(options) {
    this.measureNav();
    this.initCloud();
    this.loadLocal();
    this.enforceFeedbackDefaults();
    // 先把本机身份缓存同步载入内存：页面第一帧就要是登录态，不能等网络
    auth.hydrate();
    this.handleShareEntry(options);
    this.applyTheme();
    // 预拉取是本地同步读微信缓存，很快；放在 restoreSession 之前，
    // 让「拉会话」和「采纳快照」串成一次启动，页面只需要等一个 bootPromise。
    this.globalData.bootPromise = this.boot();
    // 悄悄预热音效引擎（不发声）：等首屏渲染稳定后再做，不跟启动抢主线程
    setTimeout(() => {
      try { sfx.preload(); } catch (e) { /* 预热失败不影响任何功能 */ }
    }, 500);
  },

  /**
   * 音效开关与震动固定开启（2026-10-27 用户决定移除两个开关）。
   * 音量仍由「我的 → 音效音量」调节，这里绝不能重置 volume ——
   * 否则用户每次冷启动都会被拉回 60%。
   */
  enforceFeedbackDefaults() {
    try {
      const st = store.get();
      const s = st && st.settings;
      if (!s || s.sound !== true) {
        store.updateSettings({ sound: true });
      }
      if (prefs.haptic() !== true) prefs.setHaptic(true);
    } catch (e) { /* 默认值修不回来也不能影响启动 */ }
  },

  /** 启动：先采纳微信缓存的预拉取快照，再恢复会话 */
  boot() {
    prefetch.ensureToken();
    return prefetch.read()
      .then((payload) => {
        if (!payload) return null;
        const r = store.applyPrefetched(payload);
        if (r && r.applied) {
          this.globalData.prefetch = {
            userId: payload.userId,
            at: r.at || payload.at || 0,
            partial: !!payload.partial,
            shards: r.applied
          };
        }
        return r;
      })
      .catch(() => null)
      .then(() => this.restoreSession());
  },

  /** 预拉取快照是否新鲜到可以跳过登录后的全量拉取（partial 快照不跳） */
  prefetchFresh() {
    const p = this.globalData.prefetch;
    if (!p || p.partial) return false;
    if (!prefetch.isFresh({ at: p.at })) return false;
    const u = auth.user();
    return !!(u && u.id === p.userId);
  },

  /**
   * 量一次自定义导航栏的尺寸。
   * hero 是自绘的（navigationStyle: custom），没有系统导航栏兜底，
   * 状态栏高度和右上角胶囊的位置都必须自己算 —— 算错的表现是标题被胶囊压住。
   */
  measureNav() {
    let statusBar = 20;
    let navH = 44;
    let rightPad = 96;

    try {
      const info = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
      if (info && info.statusBarHeight) statusBar = info.statusBarHeight;
      const winW = (info && info.windowWidth) || 375;

      const menu = (typeof wx.getMenuButtonBoundingClientRect === 'function')
        ? wx.getMenuButtonBoundingClientRect()
        : null;

      if (menu && menu.height && menu.top >= statusBar) {
        navH = (menu.top - statusBar) * 2 + menu.height;
        rightPad = Math.max(16, winW - menu.left + 8);
      }
    } catch (e) {
      /* 拿不到就用默认值：顶部会多一点留白，但不会错位 */
    }

    this.globalData.nav = { statusBar: statusBar, navH: navH, rightPad: rightPad };
  },

  /**
   * 应用外观偏好。
   * 页面内容的深色由页面根容器上的 .theme-dark / .theme-light 负责（见 app.wxss），
   * 这里额外处理两件容器管不到的事：导航栏配色，以及「跟随系统」时对系统切换的响应。
   */
  applyTheme() {
    const st = store.get();
    const pref = (st && st.settings && st.settings.theme) || 'auto';
    prefs.applyNavTheme(pref);

    if (this._themeWatcher) { this._themeWatcher(); this._themeWatcher = null; }
    if (pref === 'auto') {
      // 只有跟随系统时才有必要监听；固定深/浅色时系统怎么变都不该影响
      this._themeWatcher = prefs.watchSystemTheme(() => prefs.applyNavTheme('auto'));
    }
  },

  onShow(options) {
    // 从后台切回来：另一台设备可能刚改过数据，静默对齐一次（store 内部有 20s 节流）
    if (this.globalData.dataReady && auth.isLogged()) {
      store.pull().catch(() => { });
    }
    // 热启动也可能带着新的分享参数（点了另一张分享卡片）
    this.handleShareEntry(options);
  },

  /**
   * 分享卡片进入口。冷启动（onLaunch）与热启动（onShow）都会走这里；
   * store.applyShareQuery 内部自带闸门（已登录 / 已分叉 / 已有进度都不动），
   * 重复调用天然幂等。
   */
  handleShareEntry(options) {
    if (!this.globalData.dataReady) return;
    if (!options || !options.query) return;
    try {
      const r = store.applyShareQuery(options.query, auth.isLogged());
      if (r && r.applied) {
        console.log('[分享] 已为这位访客复制目标模板：' + r.goals + ' 个');
      }
    } catch (e) { /* 模板有问题就当普通打开处理，不阻断启动 */ }
  },

  /** 初始化云开发。ENV_ID 未配置时不报错，只是把云端能力整体降级 */
  initCloud() {
    if (!CFG.ENV_ID) {
      this.globalData.cloudReady = false;
      this.globalData.cloudError = '云开发环境尚未配置';
      return;
    }
    if (typeof wx === 'undefined' || !wx.cloud) {
      this.globalData.cloudReady = false;
      this.globalData.cloudError = '当前基础库不支持云开发';
      return;
    }
    try {
      wx.cloud.init({ env: CFG.ENV_ID, traceUser: true });
      this.globalData.cloudReady = true;
    } catch (e) {
      this.globalData.cloudReady = false;
      this.globalData.cloudError = (e && e.message) || '云开发初始化失败';
    }
  },

  loadLocal() {
    let r = { migrated: false };
    try { r = store.load(); } catch (e) { /* 数据损坏时 store 内部已回退到空白状态 */ }
    this.globalData.dataReady = true;
    if (r.migrated) {
      console.log('[启动] 已从网页版本迁移本机数据：目标 ' + r.goals + ' 个，记录 ' + r.logs + ' 条');
    }
  },

  /**
   * 恢复登录态（自动登录）。
   * 网络异常时保留本地会话，不把用户踢下线 —— 离线打开也能看到自己的数据。
   */
  restoreSession() {
    if (!this.globalData.cloudReady) {
      this.globalData.bootResult = { ok: false, reason: 'no-cloud' };
      return Promise.resolve(this.globalData.bootResult);
    }
    return auth.restore().then((r) => {
      this.globalData.bootResult = r;
      if (r && r.ok) {
        return store.onLoggedIn({ skipPull: this.prefetchFresh() }).then(() => r, () => r);
      }
      /* 网络失败不等于登出：本机身份还在（auth.restore 保留了缓存），
         这时清分片基线会丢掉待推送标记，也会把界面写成「未登录」。 */
      if (r && r.keepLocal) {
        store.setOffline('网络不可用，稍后自动同步');
        return r;
      }
      store.onLoggedOut();
      return r;
    }).then((r) => {
      this.globalData.bootResult = r;
      return r;
    }).catch(() => {
      this.globalData.bootResult = { ok: false, reason: 'error' };
      return this.globalData.bootResult;
    });
  },

  /* 不做登录闸门（2026-10-26 提审驳回后撤销）：
     未登录也能完整使用今日打卡 / 看板 / 周报，登录只在「同步到账号」时才需要。
     审核规则要求先体验功能、再自行选择授权，进入即跳登录页会被驳回。 */

  /** 供页面在需要时手动重试启动流程 */
  retryBoot() {
    this.globalData.bootPromise = this.restoreSession();
    return this.globalData.bootPromise;
  }
});
