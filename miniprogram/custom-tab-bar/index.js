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
    /** 按住：只压下去，不弹 */
    holdKey: '',
    /** 松手：才播放回弹动画 */
    popKey: '',
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
     * 按下只做「压住」（is-hold），不弹。
     * 松手才挂 is-pop 播放回弹：轻点=按下→松手弹；长按=一直压着→松手才弹。
     * 这样长按不会在按下的瞬间先弹一下。
     */
    onPressStart(e) {
      if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
      const key = e.currentTarget.dataset.key;
      this._pressKey = key;
      const patch = { holdKey: key };
      if (this.data.popKey) patch.popKey = '';
      this.setData(patch);
    },

    onPressEnd() {
      if (!this._pressKey) return;
      const key = this._pressKey;
      this._pressKey = null;
      this.setData({ holdKey: '', popKey: key });
      if (this._pressTimer) clearTimeout(this._pressTimer);
      this._pressTimer = setTimeout(() => {
        this._pressTimer = null;
        if (this.data.popKey) this.setData({ popKey: '' });
      }, 320);   // 比 0.3s 动画多 20ms，保证播完再摘类
    },

    onPressCancel() {
      this._pressKey = null;
      if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
      this.setData({ holdKey: '', popKey: '' });
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
