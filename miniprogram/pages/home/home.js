/**
 * 单页容器。
 *
 * 四个 tab 不再各自是一个页面，而是这里的四个视图：
 *   · 首屏只挂「今日」这一份，保证冷启动和以前一样快；
 *   · onReady 之后在空闲时间依次挂上另外三份（预热 mounted），
 *     用户第一次点底栏时它们已经是热的 —— 切换只剩显隐；
 *   · 挂载之后实例常驻，不再销毁：滚动位置、表单草稿、展开状态都还在；
 *   · 切 tab 只走 setData，没有页面创建、没有首帧绘制。
 *
 * 各视图的业务逻辑仍然是原来那四个页面（pages/*、*-logic.js），
 * 通过 components/tab-view/factory.js 适配成组件，改单页不需要重写业务。
 */

const store = require('../../utils/store.js');
const prefs = require('../../utils/prefs.js');
const shareCard = require('../../utils/share-card.js');
const fork = require('../../utils/fork.js');

const TAB_KEYS = ['today', 'board', 'weekly', 'mine'];

/* 预热节奏：首帧稳定后开始，每挂一份让出一段时间。
   三份视图合起来是几百个节点，连挂会把用户的第一次点击顶住。 */
const PREHEAT_START_MS = 400;
const PREHEAT_GAP_MS = 260;

Page({
  data: {
    tab: 'today',
    themeClass: '',
    /** 已挂载的视图：只增不减 */
    mounted: { today: true, board: false, weekly: false, mine: false }
  },

  onLoad(query) {
    const key = query && TAB_KEYS.indexOf(query.tab) >= 0 ? query.tab : 'today';
    const patch = { tab: key };
    patch['mounted.' + key] = true;
    this.setData(patch);
    /** 每个视图各自的滚动位置：常驻视图切回来要停在原地 */
    this._scrollTop = { today: 0, board: 0, weekly: 0, mine: 0 };
  },

  onReady() {
    this.preheat();
  },

  onShow() {
    prefs.setStatusBarLight(true);
    this.syncTheme();
    shareCard.refresh(this);
  },

  onUnload() {
    this._destroyed = true;
    if (this._preheatTimer) { clearTimeout(this._preheatTimer); this._preheatTimer = null; }
  },

  onPageScroll(e) {
    const key = this.data.tab;
    if (key && this._scrollTop) this._scrollTop[key] = (e && e.scrollTop) || 0;
  },

  /**
   * 预热：把还没挂载的视图逐个挂上。
   * 不用 wx:if 一次性全开，是因为三份视图同时创建会把主线程顶住几百毫秒，
   * 那正好是用户第一次滑动或点击的时候。
   */
  preheat() {
    const queue = TAB_KEYS.filter((k) => !this.data.mounted[k]);
    const step = () => {
      this._preheatTimer = null;
      if (this._destroyed) return;
      const key = queue.shift();
      if (!key) return;
      const patch = {};
      patch['mounted.' + key] = true;
      this.setData(patch, () => {
        if (this._destroyed) return;
        this._preheatTimer = setTimeout(step, PREHEAT_GAP_MS);
      });
    };
    this._preheatTimer = setTimeout(step, PREHEAT_START_MS);
  },

  syncTheme() {
    const st = store.get();
    const cls = prefs.themeClassOf(st && st.settings && st.settings.theme);
    if (this.data.themeClass !== cls) this.setData({ themeClass: cls });
  },

  /** 四个页签共用同一张分享卡（画的是当前数据，不区分页签） */
  onShareAppMessage() {
    return shareCard.decorate(fork.shareConfig(store.get()), this);
  },

  /** 底栏与视图内的跳转都走这里 */
  onSwitch(e) {
    const key = e && e.detail && e.detail.key;
    if (!key || TAB_KEYS.indexOf(key) < 0 || key === this.data.tab) return;

    const prevKey = this.data.tab;
    const patch = { tab: key };
    if (!this.data.mounted[key]) patch['mounted.' + key] = true;

    this.setData(patch, () => {
      /* pageLifetimes.show 只在「页面」显示时触发，页面内部换视图不会触发，
         所以这里手动对齐一次 onShow / onHide。 */
      const prev = this.pick('#v-' + prevKey);
      if (prev && prev.__hide) prev.__hide();

      const next = this.pick('#v-' + key);
      if (next && next.__show) next.__show();

      /* 常驻视图：回到各自的滚动位置，而不是一律回到顶部 */
      try {
        wx.pageScrollTo({ scrollTop: (this._scrollTop && this._scrollTop[key]) || 0, duration: 0 });
      } catch (err) { /* 旧基础库静默 */ }
    });
  },

  /** 取视图/底栏组件实例；基础库或测试环境拿不到时安静返回 null */
  pick(selector) {
    if (typeof this.selectComponent !== 'function') return null;
    try { return this.selectComponent(selector) || null; } catch (e) { return null; }
  },

  /** 「我的」页弹层打开时收起底栏（底栏在页面最外层，遮罩盖不住它） */
  onTabBarVisible(e) {
    const bar = this.pick('#tabbar');
    const visible = !!(e && e.detail && e.detail.visible);
    if (bar && bar.setVisible) bar.setVisible(visible);
  },

  /** 用户在「我的」里改外观：容器与底栏都要立刻跟上 */
  onTabBarTheme() {
    this.syncTheme();
    const bar = this.pick('#tabbar');
    if (bar && bar.refreshTheme) bar.refreshTheme();
  }
});
