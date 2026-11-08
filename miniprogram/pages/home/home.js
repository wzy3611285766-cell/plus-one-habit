/**
 * 单页容器。
 *
 * 四个 tab 不再各自是一个页面，而是这里的四个视图：
 *   · 首次切到某个 tab 时才挂载（mounted），避免首屏一次创建四份节点；
 *   · 挂载之后只做 hidden 切换，组件实例常驻 —— 滚动位置、表单草稿、展开状态都还在；
 *   · 切 tab 只走 setData，不再有 wx.switchTab 的页面创建与首帧绘制。
 *
 * 各视图的业务逻辑仍然是原来那四个页面（pages/*、*-logic.js），
 * 通过 components/tab-view/factory.js 适配成组件，改单页不需要重写业务。
 */

const store = require('../../utils/store.js');
const prefs = require('../../utils/prefs.js');
const shareCard = require('../../utils/share-card.js');
const fork = require('../../utils/fork.js');

const TAB_KEYS = ['today', 'board', 'weekly', 'mine'];

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
  },

  onShow() {
    prefs.setStatusBarLight(true);
    this.syncTheme();
    shareCard.refresh(this);
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
      const prev = this.selectComponent('#v-' + prevKey);
      if (prev && prev.__hide) prev.__hide();

      const next = this.selectComponent('#v-' + key);
      if (next && next.__show) next.__show();

      /* 换视图后回到顶部：不同视图的滚动位置混在一起会很怪 */
      try { wx.pageScrollTo({ scrollTop: 0, duration: 0 }); } catch (err) { /* 旧基础库静默 */ }
    });
  },

  /** 「我的」页弹层打开时收起底栏（底栏在页面最外层，遮罩盖不住它） */
  onTabBarVisible(e) {
    const bar = this.selectComponent('#tabbar');
    const visible = !!(e && e.detail && e.detail.visible);
    if (bar && bar.setVisible) bar.setVisible(visible);
  },

  /** 用户在「我的」里改外观：容器与底栏都要立刻跟上 */
  onTabBarTheme() {
    this.syncTheme();
    const bar = this.selectComponent('#tabbar');
    if (bar && bar.refreshTheme) bar.refreshTheme();
  }
});
