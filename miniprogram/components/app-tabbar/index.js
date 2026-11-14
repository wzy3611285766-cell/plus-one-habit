/**
 * 单页容器里的底部导航。
 *
 * 和 custom-tab-bar 的区别只有一条，但很关键：
 *   它不再是「每个 tab 页各一份」，而是容器里唯一的一份；
 *   点按不再 wx.switchTab，只把 key 抛给容器。
 * 于是切 tab 从「创建页面 + 跑页面 JS + 首帧」变成「容器换一个视图」，
 * 这是单页方案唯一的收益来源，也是它存在的理由。
 *
 * 视觉与手势逻辑（按压、回弹、毛玻璃、主题、首帧去模糊）与 custom-tab-bar 完全一致。
 */

const store = require('../../utils/store.js');
const prefs = require('../../utils/prefs.js');
const sfx = require('../../utils/sfx.js');

Component({
  properties: {
    /** 当前选中的页签，由容器传入 */
    active: { type: String, value: 'today' }
  },

  data: {
    /** 弹层打开时由容器置真 */
    hidden: false,
    holdKey: '',
    popKey: '',
    themeClass: '',
    /** 首帧先关掉毛玻璃：切页时整条栏是新建的，blur 是最贵的一笔 */
    glass: false,
    list: [
      { key: 'today', text: '今日打卡' },
      { key: 'board', text: '进度看板' },
      { key: 'weekly', text: '周报复盘' },
      { key: 'mine', text: '我的' }
    ]
  },

  attached() {
    this.refreshTheme();
    this.enableGlass();
  },

  detached() {
    if (this._pressTimer) clearTimeout(this._pressTimer);
    if (this._glassTimer) { clearTimeout(this._glassTimer); this._glassTimer = null; }
  },

  methods: {
    enableGlass() {
      if (this.data.glass || this._glassTimer) return;
      this._glassTimer = setTimeout(() => {
        this._glassTimer = null;
        if (!this.data.glass) this.setData({ glass: true });
      }, 160);
    },

    setVisible(visible) {
      if (this.data.hidden === !visible) return;
      this.setData({ hidden: !visible });
    },

    refreshTheme() {
      const st = store.get();
      const cls = prefs.themeClassOf(st && st.settings && st.settings.theme);
      if (this.data.themeClass !== cls) this.setData({ themeClass: cls });
    },

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
      }, 320);
    },

    onPressCancel() {
      this._pressKey = null;
      if (this._pressTimer) { clearTimeout(this._pressTimer); this._pressTimer = null; }
      this.setData({ holdKey: '', popKey: '' });
    },

    onTap(e) {
      const key = e.currentTarget.dataset.key;
      if (!key || key === this.data.active) return;
      this.triggerEvent('switch', { key: key });
      /* 声音放在切换之后另起一拍：音频建链是同步的，压在事件里会顶住视图切换 */
      setTimeout(() => { try { sfx.tap(); } catch (e) { /* 音效失败不影响切换 */ } }, 0);
    }
  }
});
