/**
 * 顶部 hero（对齐 final17.html 的 .hero）
 *
 * 手机上的形态：一行标题 + 一排横向滚动的 chips。
 * chips 是这个页面里唯一常驻的「概览」，数据变了要跟着变，
 * 所以组件自己订阅 store，而不是让四个页面各算一遍。
 *
 * 自绘导航栏要自己处理两件事（由 app.js 的 measureNav 提供）：
 *   · 状态栏高度 —— 各机型 20~59px 不等；
 *   · 右上角胶囊 —— 系统按钮永远在最上层，标题必须让位。
 */

const store = require('../../utils/store.js');
const M = require('../../utils/model.js');
const U = require('../../utils/util.js');

Component({
  properties: {
    /** 主标题。四个页签统一是「PLus one habit」 */
    title: { type: String, value: 'PLus one habit' }
  },

  data: {
    statusBar: 20,
    navH: 44,
    rightPad: 96,
    chips: [],
    /** 会话恢复 + 首次对齐期间亮加载点（数据本身已在本机，这只标记后台窗口） */
    booting: false
  },

  lifetimes: {
    attached() {
      let nav = null;
      try {
        const app = getApp();
        nav = app && app.globalData && app.globalData.nav;
      } catch (e) {
        nav = null;
      }
      if (nav && typeof nav.statusBar === 'number') {
        this.setData({ statusBar: nav.statusBar, navH: nav.navH, rightPad: nav.rightPad });
      }

      // 启动加载点：bootPromise 落定即隐。测试环境没有 bootPromise 就当已启动
      try {
        const boot = getApp().globalData.bootPromise;
        if (boot && typeof boot.then === 'function') {
          this.setData({ booting: true });
          const done = () => { this.setData({ booting: false }); };
          boot.then(done, done);
        }
      } catch (e2) { /* 忽略 */ }

      this.buildChips();
      this.unsub = store.on((e) => { if (e.type === 'state') this.buildChips(); });
    },

    detached() {
      if (this.unsub) this.unsub();
    }
  },

  methods: {
    /** chips 的内容：今日进度 / 今日记录 / 连续天数 / 进行中目标 */
    buildChips() {
      const st = store.get();
      if (!st) return;

      const today = U.todayStr();
      const goals = M.activeGoals(st);
      const logs = M.activeLogs(st);

      let hit = 0;
      goals.forEach((g) => { if (M.logsOn(st, g.id, today) > 0) hit++; });

      let todayCount = 0;
      logs.forEach((l) => { if (l.date === today) todayCount++; });

      const chips = [
        { k: 'hit', label: '今日', value: hit + '/' + goals.length },
        { k: 'logs', label: '记录', value: todayCount + ' 次' },
        { k: 'streak', label: '连续', value: M.globalStreak(st) + ' 天' },
        { k: 'goals', label: '进行中', value: goals.length + ' 个' }
      ];
      // store 一次动作连发 state+sync 两个事件，签名相同就只渲染一次
      const sig = JSON.stringify(chips);
      if (sig === this._chipsSig) return;
      this._chipsSig = sig;
      this.setData({ chips: chips });
    }
  }
});
