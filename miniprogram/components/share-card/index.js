/**
 * 分享卡组件：页面里挂一个离屏 canvas，按当前数据生成 5:4 分享图。
 *
 * 页面只做三件事：
 *   <share-card id="shareCard" />            （WXML）
 *   shareCard.refresh(this)                   （onShow / 打卡后，让图跟上数据）
 *   shareCard.decorate(base, this)            （onShareAppMessage，补标题与 imageUrl）
 *
 * 生成失败、还没画完、基础库不支持 2D canvas —— 一律安静退回原配置，
 * 分享本身永远不被这张图卡住。
 */

const SC = require('../../utils/share-card.js');
const store = require('../../utils/store.js');

const DPR = 2;
/** 画法版本：改了排版就 +1，让旧缓存图失效 */
const DRAW_VERSION = 4;
/** 应用图标：打包在 assets 里，128×128 PNG（7KB） */
const ICON_SRC = '/assets/icon-app.png';

Component({
  data: {
    /** 画布延迟挂载：见 ready 里的说明 */
    mount: false
  },

  lifetimes: {
    /**
     * 首次绘制不跟页面首帧抢线程。
     *
     * 切到某个 tab 页时，页面要先完成「创建 + 首帧绘制」，而原生 2D canvas 的
     * 初始化（节点查询 → 建 backing store → 画 1000×800 → 导出临时文件）是一笔
     * 很重的同步开销。它挂在 ready 里，正好压在新页面首帧上 ——
     * 低端机上就是「切过去顿一下」。分享图没有任何实时性，等首帧和入场动画
     * 结束再画完全够用（用户看完内容才会点转发）。
     */
    ready() {
      this._alive = true;
      if (this._mountTimer) clearTimeout(this._mountTimer);
      this._mountTimer = setTimeout(() => {
        this._mountTimer = null;
        if (!this._alive) return;
        this.setData({ mount: true }, () => { if (this._alive) this.initCanvas(); });
      }, 600);
    },
    detached() {
      if (this._timer) clearTimeout(this._timer);
      if (this._mountTimer) { clearTimeout(this._mountTimer); this._mountTimer = null; }
      this._alive = false;
    }
  },

  methods: {
    initCanvas() {
      this._alive = true;
      const q = this.createSelectorQuery();
      q.select('#sc').fields({ node: true, size: true }).exec((res) => {
        /* 查询是异步的：页面可能在这之间被切走（tab 切换会 detach 组件） */
        if (!this._alive) return;
        const node = res && res[0] && res[0].node;
        if (!node || typeof node.getContext !== 'function') return;
        this._canvas = node;
        node.width = SC.W * DPR;
        node.height = SC.H * DPR;
        const ctx = node.getContext('2d');
        if (!ctx) return;
        ctx.scale(DPR, DPR);
        this._ctx = ctx;
        this.loadIcon(node);
        this.render();
      });
    },

    /** 预加载应用图标：加载完重画一次，失败就保持 +1 兜底 */
    loadIcon(node) {
      if (!node || typeof node.createImage !== 'function') return;
      try {
        const img = node.createImage();
        img.onload = () => {
          if (!this._alive) return;
          this._logo = img;
          this._sig = '';
          this.render();
        };
        img.onerror = () => { /* 图标加载失败不阻塞分享 */ };
        img.src = ICON_SRC;
      } catch (e) { /* 旧基础库不支持 createImage */ }
    },

    /** 页面调用：数据可能变了，重画（同步画，导出异步） */
    refresh() {
      if (!this._ctx) return;
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => { this._timer = null; this.render(); }, 80);
    },

    render() {
      if (!this._ctx || !this._canvas || !this._alive) return;
      const st = store.get();
      if (!st) return;

      const s = SC.summarize(st);
      const sig = DRAW_VERSION + '|' + (this._logo ? 'logo' : 'no-logo') + '|' + JSON.stringify(s);
      if (sig === this._sig && this._path) return;

      try {
        SC.draw(this._ctx, s, this._logo);
      } catch (e) {
        return;
      }

      wx.canvasToTempFilePath({
        canvas: this._canvas,
        x: 0,
        y: 0,
        width: SC.W * DPR,
        height: SC.H * DPR,
        destWidth: SC.W * DPR,
        destHeight: SC.H * DPR,
        fileType: 'jpg',
        quality: 0.92,
        success: (r) => {
          const old = this._path;
          this._path = r.tempFilePath;
          this._sig = sig;
          /* 旧临时文件及时清掉，避免攒一堆图占空间 */
          if (old && old !== this._path) {
            try { wx.getFileSystemManager().unlink({ filePath: old, fail() { } }); } catch (e) { }
          }
        },
        fail: () => { }
      }, this);
    },

    /** 当前可用的分享图；数据已经变了但还没画完时返回空，让微信用默认图 */
    image() {
      if (!this._path || !this._sig) return '';
      const st = store.get();
      if (!st) return '';
      try {
        const sig = DRAW_VERSION + '|' + (this._logo ? 'logo' : 'no-logo') + '|' + JSON.stringify(SC.summarize(st));
        if (sig !== this._sig) return '';
      } catch (e) { return ''; }
      return this._path;
    },

    title() {
      try { return SC.titleOf(store.get()); } catch (e) { return ''; }
    }
  }
});
