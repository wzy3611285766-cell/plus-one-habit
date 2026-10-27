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
const DRAW_VERSION = 3;

Component({
  lifetimes: {
    ready() { this.initCanvas(); },
    detached() {
      if (this._timer) clearTimeout(this._timer);
      this._alive = false;
    }
  },

  methods: {
    initCanvas() {
      this._alive = true;
      const q = this.createSelectorQuery();
      q.select('#sc').fields({ node: true, size: true }).exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node || typeof node.getContext !== 'function') return;
        this._canvas = node;
        node.width = SC.W * DPR;
        node.height = SC.H * DPR;
        const ctx = node.getContext('2d');
        if (!ctx) return;
        ctx.scale(DPR, DPR);
        this._ctx = ctx;
        this.render();
      });
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
      const sig = DRAW_VERSION + '|' + JSON.stringify(s);
      if (sig === this._sig && this._path) return;

      try {
        SC.draw(this._ctx, s);
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
        if (DRAW_VERSION + '|' + JSON.stringify(SC.summarize(st)) !== this._sig) return '';
      } catch (e) { return ''; }
      return this._path;
    },

    title() {
      try { return SC.titleOf(store.get()); } catch (e) { return ''; }
    }
  }
});
