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

/**
 * 路由 → 页签名。
 * tabBar 是「每个 tab 页各一份实例」，切页时新页面这份会重新 attached。
 * 如果 active 写死成 'today'，那么每次切到 board / weekly / mine 都会先
 * 把「今日打卡」点亮一帧，再被页面的 onShow 改成正确项 —— 肉眼就是底栏闪一下。
 * 所以初值必须按所在页面算出来。
 */
const KEY_BY_ROUTE = {
  'pages/today/today': 'today',
  'pages/board/board': 'board',
  'pages/weekly/weekly': 'weekly',
  'pages/mine/mine': 'mine'
};

function currentKey() {
  try {
    const pages = getCurrentPages();
    const cur = pages[pages.length - 1];
    const route = cur && cur.route ? String(cur.route).replace(/^\//, '') : '';
    return KEY_BY_ROUTE[route] || '';
  } catch (e) {
    /* 启动早期页面栈还取不到，交给 attached 再校正 */
    return '';
  }
}

/** 首帧就要是对的主题：深色下晚一帧上色，底栏会先白一瞬 */
function currentThemeClass() {
  try {
    const st = store.get();
    return prefs.themeClassOf(st && st.settings && st.settings.theme);
  } catch (e) {
    return '';
  }
}

Component({
  data: {
    active: currentKey() || 'today',
    /** 弹层打开时由页面置真：自定义 tabBar 的显隐只能自己控制，
        wx.hideTabBar 对 custom:true 的 tabBar 无效（官方文档明示） */
    hidden: false,
    /** 按住：只压下去，不弹 */
    holdKey: '',
    /** 松手：才播放回弹动画 */
    popKey: '',
    themeClass: currentThemeClass(),
    /** 首帧先关掉毛玻璃：切页时新页面要重建整条栏，blur 是安卓上最贵的一笔 */
    glass: false,
    list: [
      { key: 'today', text: '今日打卡', path: '/pages/today/today' },
      { key: 'board', text: '进度看板', path: '/pages/board/board' },
      { key: 'weekly', text: '周报复盘', path: '/pages/weekly/weekly' },
      { key: 'mine', text: '我的', path: '/pages/mine/mine' }
    ]
  },

  attached() {
    /* 模块求值时页面栈可能还是空的，这里补一次校正（在首帧之前，不会再闪） */
    const key = currentKey();
    if (key && key !== this.data.active) this.setData({ active: key });
    this.refreshTheme();
    this.enableGlass();
  },

  /**
   * 所属页面每次 show 都自己校正一次选中态。
   *
   * 为什么不能只靠页面的 onShow：
   *   切 tab 时新页面这份组件挂载得比页面 onShow 早，attached 里
   *   getCurrentPages() 取到的可能还是上一个页面；而页面 onShow 里
   *   getTabBar() 有时还没就绪，setActive 被跳过 —— 两种时序都会让
   *   底栏停在上一页的高亮上（例如人在周报页，「进度看板」却亮着）。
   *   pageLifetimes.show 由框架在页面显示时触发，此时页面一定已入栈。
   */
  pageLifetimes: {
    show() {
      const key = currentKey();
      if (key && key !== this.data.active) this.setData({ active: key });
      this.refreshTheme();
      this.enableGlass();
    }
  },

  detached() {
    if (this._pressTimer) clearTimeout(this._pressTimer);
    if (this._glassTimer) { clearTimeout(this._glassTimer); this._glassTimer = null; }
  },

  methods: {
    /**
     * 首帧先不给毛玻璃，等新页面画完（160ms）再把 blur 挂回来。
     *
     * 为什么：切 tab 时新页面这份组件要整条重建，backdrop-filter 会立刻
     * 触发一次「读取底图 + 高斯模糊」；低端安卓上这一下就是肉眼可见的顿挫。
     * 纯色底在 160ms 内几乎看不出差别（页面本身也在渲染），
     * 但省掉的是切页瞬间最贵的一次合成。
     */
    enableGlass() {
      if (this.data.glass || this._glassTimer) return;
      this._glassTimer = setTimeout(() => {
        this._glassTimer = null;
        if (!this.data.glass) this.setData({ glass: true });
      }, 160);
    },

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
      this.setData({ active: key });
      wx.switchTab({ url: path });
      /* 发声放在 switchTab 之后、且另起一拍：WebAudio 首次建链（createWebAudioContext
         + 节点连图）是同步的，压在点击事件里会顶住跳转 ——
         用户看到的就是「按下去先卡一下，页面才切过去」。 */
      setTimeout(() => { try { sfx.tap(); } catch (e) { /* 音效失败不影响切页 */ } }, 0);
    }
  }
});
