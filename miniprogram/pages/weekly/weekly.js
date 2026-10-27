/**
 * 周报复盘。
 *
 * 复盘用 KPT 四栏（保持 / 问题 / 尝试 / 下一步），存进 notes[周一日期]。
 * 复盘内容和其他打卡数据走同一套同步：在手机上写完，回到电脑上就能看到。
 * 复盘只保存在小程序里（随账号同步），不做导出文本。
 */

const store = require('../../utils/store.js');
const auth = require('../../utils/auth.js');
const fork = require('../../utils/fork.js');
const shareCard = require('../../utils/share-card.js');
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
    savedTip: '',
    /** 往期复盘默认收起：主任务是写本周，存档按需展开 */
    archiveOpen: false,
  },

  /** 转发卡片带目标模板：同学点开即可得到一份自己的副本（见 utils/fork.js） */
  onShareAppMessage() {
    return shareCard.decorate(fork.shareConfig(store.get()), this);
  },

  onLoad() {
    this.unsub = store.on((e) => { if (e.type === 'state') this.render(true); });
    this.render();
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) this.getTabBar().setActive('weekly');
    prefs.setStatusBarLight(true);
    this.render(true);
    shareCard.refresh(this);
  },

  onUnload() {
    if (this.unsub) this.unsub();
    if (this.savedTipTimer) clearTimeout(this.savedTipTimer);
  },

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

    /* 往期复盘存档：写过内容的周，新 → 旧；摘录取第一个非空栏。
       用户翻旧复盘的真实动机是「回想当时写了什么」，列表直接给摘录（备忘录习惯），
       比一周一周盲翻、也比纯日期点标更省一跳。 */
    const mon0 = U.mondayOf(U.todayStr());
    const archive = Object.keys(st.notes)
      .filter((k) => {
        const n = st.notes[k];
        return n && !n.deleted && (n.keep || n.problem || n.try || n.next);
      })
      .sort(function (a, b) { return a < b ? 1 : -1; })
      .map((k) => {
        const n = st.notes[k];
        let snippet = '';
        for (let i = 0; i < FIELDS.length; i++) {
          const v = String(n[FIELDS[i]] || '').trim();
          if (v) { snippet = LABELS[FIELDS[i]] + '：' + v; break; }
        }
        return {
          key: k,
          off: Math.round(U.diffDays(mon0, k) / 7),
          label: U.fmtShort(k) + ' - ' + U.fmtShort(U.addDays(k, 6)),
          snippet: snippet.slice(0, 24)
        };
      });

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
      hasNote: !!note,
      archive: archive
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

  /** 切周前的统一闸门：表单有未保存内容时必须让用户明确丢弃，否则静默清空等于丢稿 */
  guardDirty(then) {
    if (!this.data.dirty) { then(); return; }
    wx.showModal({
      title: '复盘还没保存',
      content: '这周写的内容还没保存，切走会丢失。',
      confirmText: '丢弃',
      confirmColor: '#FF3B30',
      success: (res) => { if (res.confirm) then(); }
    });
  },

  prevWeek() {
    this.guardDirty(() => {
      this.setData({ offset: this.data.offset - 1, savedTip: '' });
      this.render();
    });
  },

  toggleArchive() {
    // 先切状态再发声：音频引擎在部分真机上的同步异常不能挡住展开
    this.setData({ archiveOpen: !this.data.archiveOpen });
    try { sfx.tap(); } catch (e) { /* 静默 */ }
  },

  /** 存档直达：按周一日期换算回 offset，跳到那一周 */
  goArchive(e) {
    const off = Number(e.currentTarget.dataset.off);
    if (isNaN(off)) return;
    this.guardDirty(() => {
      /* 即使就是当前周也执行：表单已清空，点存档行必须把内容装回 KPT 纸，
         并滚到纸面 —— 否则点按毫无可见反馈（「展开不了」的主因） */
      this.setData({ offset: off, savedTip: '' });
      this.render();
      try { wx.pageScrollTo({ selector: '#kpt-card', duration: 200 }); } catch (e) { /* 旧基础库静默 */ }
      try { sfx.tap(); } catch (e) { /* 静默 */ }
    });
  },

  nextWeek() {
    if (this.data.offset >= 0) return;
    this.guardDirty(() => {
      this.setData({ offset: this.data.offset + 1, savedTip: '' });
      this.render();
    });
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
    /* 四栏全空一律不落库：保存后表单会清空，误触保存绝不能把已存的复盘清成空 */
    if (empty) {
      try { sfx.error(); } catch (e) { /* 静默 */ }
      this.toast('还没有填写内容');
      return;
    }

    store.setNote(r.start, {
      keep: f.keep, problem: f.problem, try: f.try, next: f.next
    });

    /* 写完一篇的日记感：保存即入档，表单清空；
       内容从下方「往期复盘」列表点开回看或继续编辑 */
    this.setData({
      dirty: false,
      hasNote: true,
      savedTip: '已保存',
      form: { keep: '', problem: '', try: '', next: '' }
    });
    this.savedTipTimer = setTimeout(() => this.setData({ savedTip: '' }), 1600);
    try { sfx.saved(); } catch (e) { /* 静默：保存反馈不能被音频异常吞掉 */ }
    this.toast(auth.isLogged() ? '已保存，正在同步' : '已保存');
  },

  toast(msg, ms) {
    wx.showToast({ title: msg, icon: 'none', duration: ms || 1800 });
  }
});
