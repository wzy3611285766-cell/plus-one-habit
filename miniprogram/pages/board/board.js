/**
 * 进度看板 —— 结构对齐 design-baseline.html 的 #panel-board。
 *
 * 页面顺序（与基准一致）：
 *   统计条（2 张卡）→ 目标卡网格 → 已完成分区 → 14 天堆叠图 + 图例 → 热力 → 最近动态
 *
 * 图表用 flex 柱而不是 SVG：
 *   WXML 没有 svg 标签，canvas 是原生组件会盖住弹层，flex 柱天然自适应且跟随主题。
 *   代价是拿不到基准的 <title> 悬浮提示，改成点击出气泡（移动端本来也没有 hover）。
 */

const store = require('../../utils/store.js');
const auth = require('../../utils/auth.js');
const fork = require('../../utils/fork.js');
const M = require('../../utils/model.js');
const U = require('../../utils/util.js');
const prefs = require('../../utils/prefs.js');

const LOG_ROWS = 10;   // 按天聚合后：仅显示最近 10 天

Page({
  data: {
    themeClass: '',
    logged: false,

    /* 统计条：累计打卡 / 累计活跃 */
    statCards: [],

    /* 目标卡：进行中在前，已完成单独分区 */
    sections: [],
    activeCards: [],
    doneCards: [],
    hasData: false,

    /* 近 14 天堆叠图 */
    chart: [],
    chartMax: 1,
    legend: [],
    picked: '',

    /* 近 35 天热力 */
    heat: [],
    weekdays: ['一', '二', '三', '四', '五', '六', '日'],

    /* 最近动态 */
    feed: [],

    /** 当前展开记录的目标；空串表示都收起 */
    expanded: '',
    /** 正在等待二次确认删除的记录 id */
    confirmDel: ''
  },

  /** 转发卡片带目标模板：同学点开即可得到一份自己的副本（见 utils/fork.js） */
  onShareAppMessage() {
    return fork.shareConfig(store.get());
  },

  onLoad() {
    this.unsub = store.on((e) => { if (e.type === 'state') this.render(); });
    this.render();
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) this.getTabBar().setActive('board');
    const gate = getApp();
    if (gate && typeof gate.ensureLoginGate === 'function') gate.ensureLoginGate();
    prefs.setStatusBarLight(true);
    this.render();
  },

  onUnload() {
    if (this.unsub) this.unsub();
    if (this.confirmTimer) clearTimeout(this.confirmTimer);
  },

  render() {
    const st = store.get();
    if (!st) return;

    const today = U.todayStr();
    const goals = M.activeGoals(st);
    const logs = M.activeLogs(st);

    /* ---------- 目标卡 ---------- */
    const buildCard = (g) => {
      const done = M.doneAmount(st, g.id);
      const pct = g.total > 0 ? Math.min(100, done / g.total * 100) : 0;
      const streak = M.streak(st, g.id);
      const e = M.eta(st, g);

      let etaText = '';
      if (e.status === 'done') etaText = '已达成';
      else if (e.status === 'unknown') etaText = '近 7 天无记录，暂无推算';
      else if (e.status === 'overdue') etaText = '已过截止日，仍差 ' + U.trimNum(g.total - done) + ' ' + g.unit;
      else if (e.diff >= 0) etaText = U.fmtShort(e.date) + ' · 提前 ' + e.diff + ' 天';
      else etaText = U.fmtShort(e.date) + ' · 拖后 ' + (-e.diff) + ' 天';

      /* 记录按天聚合：一行 = 这一天在该目标上的合计（连点几次的 +1 不再逐条刷屏）。
         复盘要看的是「哪天加了多少」；删除也按天整删（ids 串，两段式确认不变）。 */
      const byDay = {};
      logs.forEach((l) => {
        if (l.goalId !== g.id) return;
        const d = byDay[l.date] || (byDay[l.date] = { date: l.date, amount: 0, count: 0, minutes: 0, makeup: false, ids: [] });
        d.amount += l.amount;
        d.count += 1;
        d.minutes += l.minutes || 0;
        if (l.makeup) d.makeup = true;
        d.ids.push(l.id);
      });
      const rows = Object.keys(byDay)
        .sort((a, b) => (a < b ? 1 : -1))
        .slice(0, LOG_ROWS)
        .map((date) => {
          const d = byDay[date];
          return {
            id: d.ids.join(','),
            date: U.fmtShort(date),
            amount: U.trimNum(d.amount),
            count: d.count,
            minutes: d.minutes,
            makeup: d.makeup
          };
        });

      return {
        gid: g.id,
        name: g.name,
        color: U.gcolor(g.color),
        sample: !!g.sample,
        isDone: M.isComplete(st, g),
        unit: g.unit,
        done: U.trimNum(done),
        total: U.trimNum(g.total),
        pct: Math.round(pct),
        streak: streak,
        etaText: etaText,
        etaAhead: e.status === 'ok' && e.diff >= 0,
        etaBehind: e.status === 'ok' && e.diff < 0,
        plan: g.plan || '',
        obstacle: g.obstacle || '',
        logCount: Object.keys(byDay).length,
        logs: rows
      };
    };

    const activeCards = goals.filter((g) => !M.isComplete(st, g)).map(buildCard);
    const doneCards = goals.filter((g) => M.isComplete(st, g)).map(buildCard);

    /* ---------- 统计条：累计打卡 / 累计活跃 ---------- */
    const daySet = {};
    logs.forEach((l) => { daySet[l.date] = 1; });
    const statCards = [
      { k: 'logs', num: logs.length, label: '累计打卡（次）', tone: 'is-amber' },
      { k: 'days', num: Object.keys(daySet).length, label: '累计活跃（天）', tone: 'is-brand' }
    ];

    /* ---------- 近 14 天堆叠图 ---------- */
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = U.addDays(today, -i);
      const segs = [];
      let total = 0;
      goals.forEach((g) => {
        const v = M.logsOn(st, g.id, d);
        if (v > 0) segs.push({ key: g.id, name: g.name, unit: g.unit, color: U.gcolor(g.color || M.COLORS[0]), amount: v });
        total += v;
      });
      days.push({ date: d, label: String(Number(d.slice(8, 10))), isToday: d === today, total: total, segs: segs });
    }

    const chartMax = Math.max(1, days.reduce((mx, d) => Math.max(mx, d.total), 0));
    const chart = days.map((d) => ({
      date: d.date,
      label: d.label,
      isToday: d.isToday,
      pct: Math.round(d.total / chartMax * 100),
      tipDate: U.fmtShort(d.date) + ' ' + U.weekdayCN(d.date),
      tipRows: d.segs.slice(0, 4).map((s) => ({
        k: s.key, name: s.name, unit: s.unit, amount: U.trimNum(s.amount), color: s.color
      })),
      /* 段高不再用百分比：柱身已按 total/chartMax 定高，段内用 flex-grow 按
         数量比例分配即可精确填满 —— 嵌套百分比（段% × 柱%）会被二次缩放，
         取整误差还会让最高那根溢出裁切或填不满（线上柱子半截的根因）。 */
      segs: d.segs.map((s) => ({ key: s.key, color: s.color, amount: s.amount }))
    }));

    /* 图例：只列近 14 天真的出现过的目标（基准 usedGoals 的口径） */
    const used = {};
    days.forEach((d) => d.segs.forEach((s) => { used[s.key] = 1; }));
    const legend = goals
      .filter((g) => used[g.id])
      .map((g) => ({ key: g.id, name: g.name, color: U.gcolor(g.color) }));

    /* ---------- 近 35 天热力 ---------- */
    const heatStart = U.addDays(today, -34);
    const pad = U.diffDays(U.mondayOf(heatStart), heatStart);
    const perDay = {};
    logs.forEach((l) => { perDay[l.date] = (perDay[l.date] || 0) + 1; });

    const heat = [];
    for (let i = 0; i < pad; i++) heat.push({ k: 'pad' + i, lv: 0, blank: true, isToday: false });
    for (let i = 0; i < 35; i++) {
      const d = U.addDays(heatStart, i);
      const n = perDay[d] || 0;
      const lv = n <= 0 ? 0 : (n === 1 ? 1 : (n <= 3 ? 2 : (n <= 6 ? 3 : 4)));
      heat.push({ k: d, lv: lv, blank: false, isToday: d === today });
    }

    /* ---------- 最近动态 ---------- */
    const feed = logs
      .slice()
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .map((l) => {
        const g = M.goalById(st, l.goalId);
        if (!g) return null;
        return {
          k: l.id,
          name: g.name,
          amount: U.trimNum(l.amount),
          unit: g.unit,
          color: U.gcolor(g.color),
          date: l.date === today ? '今天'
            : (l.date === U.addDays(today, -1) ? '昨天' : U.fmtShort(l.date))
        };
      })
      .filter(Boolean)
      .slice(0, 8);

    /* 分区：进行中在前，已完成单独一段；没有卡片的分区不渲染 */
    const sections = [];
    if (activeCards.length) sections.push({ key: 'active', title: '', count: 0, cards: activeCards });
    if (doneCards.length) sections.push({ key: 'done', title: '已完成', count: doneCards.length, cards: doneCards });

    this.setData({
      themeClass: prefs.themeClassOf(st.settings && st.settings.theme),
      logged: auth.isLogged(),
      statCards: statCards,
      sections: sections,
      activeCards: activeCards,
      doneCards: doneCards,
      hasData: goals.length > 0,
      chart: chart,
      chartMax: chartMax,
      legend: legend,
      heat: heat,
      feed: feed
    });
  },

  /* ================= 交互 ================= */

  /** 点柱子：同一根再点收起 */
  pickDay(e) {
    const date = e.currentTarget.dataset.date;
    if (!date) return;
    this.setData({ picked: this.data.picked === date ? '' : date });
  },

  /** 「查看 N 条记录」：一次只展开一个 */
  toggleLogs(e) {
    const gid = e.currentTarget.dataset.gid;
    this.setData({ expanded: this.data.expanded === gid ? '' : gid, confirmDel: '' });
  },

  /**
   * 删除一条记录：两段式确认（第一次变红，3 秒内再点才真删）。
   * 基准用的是同一套「点一次变色、再点确认」的交互，不是长按。
   */
  deleteLog(e) {
    const raw = String(e.currentTarget.dataset.id || '');
    if (!raw) return;

    if (this.data.confirmDel !== raw) {
      this.setData({ confirmDel: raw });
      if (this.confirmTimer) clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => this.setData({ confirmDel: '' }), 3000);
      return;
    }

    if (this.confirmTimer) clearTimeout(this.confirmTimer);
    // 行是「天」，id 是当天的记录 id 串：按天整删
    let ok = false;
    raw.split(',').forEach((id) => { if (store.deleteLog(id)) ok = true; });
    this.setData({ confirmDel: '' });
    if (ok) {
      this.render();
      wx.showToast({ title: '已删除', icon: 'none' });
    }
  },

  goToday() { wx.switchTab({ url: '/pages/today/today' }); }
});
