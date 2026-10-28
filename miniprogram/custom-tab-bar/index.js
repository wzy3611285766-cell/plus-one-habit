/**
 * 自定义 tabBar。
 *
 * 为什么不用原生 tabBar：原生 tabBar 的图标必须是本地 PNG 文件，
 * 而本项目的资源约束是「不引入任何位图资源」。这里用纯 WXSS 画几何图标
 * （圆环 / 柱条 / 页面 / 人形），既零资源又完全跟随主题变量。
 *
 * 主题：tabBar 是独立组件，渲染在页面容器之外，拿不到页面根节点上的
 * .theme-dark / .theme-light，所以要把外观偏好算成自己的 class。
 * 页面切换（setActive）与用户在「我的」里改外观时都会刷新它。
 */

const store = require('../utils/store.js');
const prefs = require('../utils/prefs.js');
const sfx = require('../utils/sfx.js');

Component({
  data: {
    active: 'today',
    /** 弹层打开时由页面置真：自定义 tabBar 的显隐只能自己控制，
        wx.hideTabBar 对 custom:true 的 tabBar 无效（官方文档明示） */
    hidden: false,
    /** 当前按下的页签：点一下就触发回弹，不再依赖 long press 的 hover */
    pressKey: '',
    themeClass: '',
    list: [
      { key: 'today', text: '今日打卡', path: '/pages/today/today' },
      { key: 'board', text: '进度看板', path: '/pages/board/board' },
      { key: 'weekly', text: '周报复盘', path: '/pages/weekly/weekly' },
      { key: 'mine', text: '我的', path: '/pages/mine/mine' }
    ]
  },

  attached() {
    this.refreshTheme();
  },

  detached() {
    if (this._pressTimer) clearTimeout(this._pressTimer);
  },

  methods: {
    /** 供页面在弹层开合时调用：收起 / 恢复整条栏 */
    setVisible(visible) {
      if (this.data.hidden === !visible) return;
      this.setData({ hidden: !visible });
    },

    /** 供页面在 onShow 里调用，同时同步选中态与外观 */
    setActive(key) {
      const patch = {};
      if (this.data.active !== key) patch.active = key;
      const st = store.get();
      const cls = prefs.themeClassOf(st && st.settings && st.settings.theme);
      if (this.data.themeClass !== cls) patch.themeClass = cls;
      if (Object.keys(patch).length) this.setData(patch);
    },

    /** 用户在「我的」里切换外观后立即生效 */
    refreshTheme() {
      const st = store.get();
      const cls = prefs.themeClassOf(st && st.settings && st.settings.theme);
      if (this.data.themeClass !== cls) this.setData({ themeClass: cls });
    },

    /**
     * 按下立刻挂 is-press，动画自己播完再摘。
     * 之前用 hover-class：轻点一下 touchend 立刻把类摘掉，0.24s 的回弹被截断，
     * 只有长按才看得到。
     */
    onPressStart(e) {
      if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
      this._pressAt = Date.now();
      const key = e.currentTarget.dataset.key;
      if (this.data.pressKey !== key) this.setData({ pressKey: key });
    },

    onPressEnd() {
      const elapsed = Date.now() - (this._pressAt || 0);
      const wait = Math.max(0, 300 - elapsed);   // 保证 0.3s 动画播完
      if (this._pressTimer) clearTimeout(this._pressTimer);
      this._pressTimer = setTimeout(() => {
        this._pressTimer = null;
        if (this.data.pressKey) this.setData({ pressKey: '' });
      }, wait);
    },

    onTap(e) {
      const key = e.currentTarget.dataset.key;
      const path = e.currentTarget.dataset.path;
      if (key === this.data.active) return;
      // 先发声再切页：switchTab 之后可能有好几帧的白，声音先到才跟手
      sfx.tap();
      this.setData({ active: key });
      wx.switchTab({ url: path });
    }
  }
});
