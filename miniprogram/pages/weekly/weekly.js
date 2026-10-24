/**
 * 周报复盘。
 *
 * 复盘用 KPT 四栏（保持 / 问题 / 尝试 / 下一步），存进 notes[周一日期]。
 * 复盘内容和其他打卡数据走同一套同步：在手机上写完，回到电脑上就能看到。
 * 「生成周报文本」把这一周的客观数据 + 复盘拼成一段可以直接贴出去的文本。
 */

const store = require('../../utils/store.js');
const auth = require('../../utils/auth.js');
const fork = require('../../utils/fork.js');
const M = require('../../utils/model.js');
const U = require('../../utils/util.js');
const prefs = require('../../utils/prefs.js');
const sfx = require('../../utils/sfx.js');

const FIELDS = ['keep', 'problem', 'try', 'next'];
const LABELS = { keep: '保持', problem: '问题', try: '尝试', next: '下周预案' };

Page({
  data: {
    themeClass: '',
    logged: false,
    offset: 0,                 // 0=本周，-1=上周…
    range: '',
    isCurrent: true,
    summary: [],
    totals: { sum: 0, days: 0, count: 0, prevCount: 0 },
    form: { keep: '', problem: '', try: '', next: '' },
    hasNote: false,
    dirty: false,
    report: '',
    hasReport: false,
    savedTip: ''
  },

  /** 转发卡片带目标模板：同学点开即可得到一份自己的副本（见 utils/fork.js） */
  onShareAppMessage() {
    return fork.shareConfig(store.get());
  },

  onLoad() {
    this.unsub = store.on((e) => { if (e.type === 'state') this.render(true); });
    this.render();
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) this.getTabBar().setActive('weekly');
    prefs.setStatusBarLight(true);
    this.render(true);
  },

  onUnload() { if (this.unsub) this.unsub(); },

  /* ================= 渲染 ================= */

  weekRange() {
    const mon = U.mondayOf(U.todayStr());
    const start = U.addDays(mon, this.data.offset * 7);
    return { start: start, end: U.addDays(start, 6) };
  },

  render(keepForm) {
    const st = store.get();
    if (!st) return;
    const r = this.weekRange();
    const cur = M.weekStats(st, r.start, r.end);
    const prev = M.weekStats(st, U.addDays(r.start, -7), U.addDays(r.start, -1));
    const goals = M.activeGoals(st);

    const summary = [];
    goals.forEach((g) => {
      const c = cur.per[g.id] || { sum: 0, days: 0, mins: 0 };
      const p = prev.per[g.id] || { sum: 0, days: 0, mins: 0 };
      // 已完成且本周没投入的目标不再占行，避免周报随历史完成数越滚越长
      if (M.isComplete(st, g) && c.days === 0) return;
      /* 文案对齐基准的 week-compare：不含「上周」前缀，由模板补 */
      const cmpParts = [];
      if (p.sum > 0 || p.days > 0) {
        if (p.sum > 0) cmpParts.push('+' + U.trimNum(p.sum) + ' ' + g.unit);
        cmpParts.push('打卡 ' + p.days + ' 天');
        if (p.mins > 0) cmpParts.push(p.mins + ' 分钟');
      }
      summary.push({
        gid: g.id,
        name: g.name,
        color: U.gcolor(g.color),
        unit: g.unit,
        sum: U.trimNum(c.sum),
        days: c.days,
        /* 累计完成率：周报文本里要写「（累计 68%）」，与基准一致 */
        pct: g.total > 0 ? Math.round(Math.min(100, M.doneAmount(st, g.id) / g.total * 100)) : 0,
        hasSum: c.sum > 0,
        hasMins: c.mins > 0,
        compare: cmpParts.length ? cmpParts.join(' · ') : ''
      });
    });

    /* 本周打卡次数：基准的「合计投入」按分钟算，本项目没有用时数据，
       所以合计行改成「合计打卡 N 次」—— 口径在卡片里不解释，只在文档里记。
       上周对比也同样按时长以外的口径（天数）给出。 */
    let weekCount = 0;
    let prevCount = 0;
    const prevStart = U.addDays(r.start, -7);
    const prevEnd = U.addDays(r.start, -1);
    st.logs.forEach((l) => {
      if (l.deleted) return;
      if (l.date >= r.start && l.date <= r.end) weekCount++;
      else if (l.date >= prevStart && l.date <= prevEnd) prevCount++;
    });

    const note = st.notes[r.start] && !st.notes[r.start].deleted ? st.notes[r.start] : null;

    const patch = {
      themeClass: prefs.themeClassOf(st.settings && st.settings.theme),
      logged: auth.isLogged(),
      range: U.fmtShort(r.start) + ' - ' + U.fmtShort(r.end),
      isCurrent: this.data.offset === 0,
      summary: summary,
      totals: {
        sum: U.trimNum(cur.totalSum),
        days: cur.activeDays,
        count: weekCount,
        prevCount: prevCount
      },
      hasNote: !!note
    };
    if (!keepForm) {
      patch.form = {
        keep: note ? note.keep : '',
        problem: note ? note.problem : '',
        try: note ? note.try : '',
        next: note ? note.next : ''
      };
      patch.dirty = false;
    }
    this.setData(patch);
  },

  /* ================= 周切换 ================= */

  prevWeek() {
    this.setData({ offset: this.data.offset - 1, savedTip: '' });
    this.render();
  },

  nextWeek() {
    if (this.data.offset >= 0) return;
    this.setData({ offset: this.data.offset + 1, savedTip: '' });
    this.render();
  },

  /* ================= 复盘表单 ================= */

  onField(e) {
    const f = e.currentTarget.dataset.field;
    const patch = { dirty: true, savedTip: '' };
    patch['form.' + f] = e.detail.value;
    this.setData(patch);
  },

  save() {
    const r = this.weekRange();
    const f = this.data.form;
    const empty = FIELDS.every((k) => !String(f[k] || '').trim());
    if (empty && !this.data.hasNote) { sfx.error(); this.toast('还没有填写内容'); return; }

    store.setNote(r.start, {
      keep: f.keep, problem: f.problem, try: f.try, next: f.next
    });
    sfx.saved();
    this.setData({ dirty: false, hasNote: !empty, savedTip: '已保存' });
    setTimeout(() => this.setData({ savedTip: '' }), 1600);
    this.toast(auth.isLogged() ? '已保存，正在同步' : '已保存');
  },

  /* ================= 生成周报 ================= */

  /**
   * 生成周报文本，格式对齐基准 buildReport：
   *   【学习周报】周一 - 周日
   *   - 目标：+N 单位，打卡 X 天（累计 P%）｜上周 +N 单位
   *   本周合计：N 次（上周 M 次）
   *   保持 / 问题 / 尝试 / 下周预案
   * 唯一的替换：基准的「本周总投入：N 分钟」→「本周合计：N 次」（没有用时数据）。
   */
  generate() {
    const s = this.data.totals;
    const lines = ['【学习周报】' + this.data.range];

    this.data.summary.forEach((row) => {
      let l = '- ' + row.name + '：+' + row.sum + ' ' + row.unit
        + '，打卡 ' + row.days + ' 天（累计 ' + row.pct + '%）';
      if (row.compare) l += '｜' + row.compare;
      lines.push(l);
    });

    if (s.count > 0) {
      let ml = '本周合计：' + s.count + ' 次';
      if (s.prevCount > 0) ml += '（上周 ' + s.prevCount + ' 次）';
      lines.push(ml);
    }

    FIELDS.forEach((k) => {
      const v = String(this.data.form[k] || '').trim();
      if (v) lines.push(LABELS[k] + '：' + v);
    });

    this.setData({ report: lines.join('\n'), hasReport: true });
  },

  copyReport() {
    if (!this.data.report) return;
    wx.setClipboardData({
      data: this.data.report,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
      fail: () => this.toast('复制失败，请长按选择文本')
    });
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  toast(msg, ms) {
    wx.showToast({ title: msg, icon: 'none', duration: ms || 1800 });
  }
});
