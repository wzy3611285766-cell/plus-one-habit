/**
 * 今日打卡。
 *
 * 产品主张：+1 是这一页唯一的主操作。页面从上到下只有三件事 ——
 * 今天做到哪了、点一下、以及每个目标的明细。
 *
 * 未登录时的取舍：
 *   允许继续打卡（写本机），不封锁任何功能 —— 一上来就要求登录
 *   是这类工具最大的流失点。登录入口只占头部一个小按钮，
 *   不拿整张卡片向用户解释「数据去哪了」：那是文档的事，不是界面的。
 *   一旦登录，本机数据会自动合并进账号（store.onLoggedIn 负责）。
 */

const store = require('../../utils/store.js');
const auth = require('../../utils/auth.js');
const M = require('../../utils/model.js');
const U = require('../../utils/util.js');
const prefs = require('../../utils/prefs.js');
const sfx = require('../../utils/sfx.js');
const CFG = require('../../utils/config.js');

/* ================= 打卡反馈的常量 =================
   数值取自设计基准的 plus1Burst / celebrate。
   唯一改动是彩带条数：基准 110 片是给桌面 DOM 写的，小程序每一片都是真实节点，
   按「同时存在的节点 ≤ 40」这条预算降到 24 片（外加 1 层顶部柔光）。 */
const COMBO_WINDOW = 900;   // 连击窗口，基准：now - plus1Stamp < 900
const FX_MAX = 3;           // 同时存在的爆发组上限，峰值 3 × 13 = 39 个节点
const SPARK_N = 10;         // 首击粒子数（基准 10）
const SPARK_N_COMBO = 6;    // 连击时减量（基准 combo>=2 时 6 粒）
const CONFETTI_N = 24;      // 彩带片数
const CONFETTI_COLORS = ['#7c5cff', '#6366f1', '#0ea5e9', '#14b8a6', '#8b5cf6', '#fbbf24', '#34d399'];

Page({
  data: {
    themeClass: '',
    logged: false,
    user: null,
    loggedHint: '',
    syncText: '',
    syncDot: 'off',
    syncTime: '',
    dateText: '',
    greeting: '',
    rows: [],
    doneRows: [],
    hasGoals: false,
    statCards: [],
    rhythm: [],
    rhythmTotal: 0,

    /* 过审模式：新建目标是「选预设」而不是「填表单」 */
    safeMode: CFG.SAFE_MODE,
    presets: CFG.PRESETS,
    presetOn: false,
    toast: '',
    toastOn: false,

    // 「⋯」目标操作抽屉（对应基准的 #goalMenu）
    menuOn: false,
    menuGid: '',
    menuName: '',
    menuOverdue: false,

    /* ---------- +1 打卡反馈（对齐基准的 plus1Burst） ----------
       fxList：每次点击一组爆发，最多同时 3 组（第 4 组进来时挤掉最旧的）。
               每组 = 1 道冲击波 + 6~10 粒粒子 + 1 个浮动 +1（连击 ≥3 再 +1 行 ×N 连击），
               所以峰值节点数 3 × 13 = 39，压在 40 以内。
       popClass：回弹动画。两个同名不同 keyframe 的类交替，切一次就重播一次 ——
               小程序没有 DOM，做不到基准的 void offsetWidth 强制重排。
       p1Level：连击蓄力态，对应基准的 p1-c3 / p1-c6。 */
    fxList: [],
    popClass: '',
    p1Level: '',
    confettiOn: false,
    confetti: []
  },

  onLoad() {
    this.unsub = store.on((e) => { if (e.type === 'state' || e.type === 'sync') this.render(); });
    this.unsubAuth = auth.on(() => this.render());
    this.render();
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) this.getTabBar().setActive('today');
    prefs.setStatusBarLight(true);   // hero 是深蓝底，状态栏要白字
    // 回到页面时对齐一次云端（store 内部有 20 秒节流）
    if (auth.isLogged()) {
      store.pull().then(() => this.render()).catch(() => this.render());
    }
    this.render();
  },

  onUnload() {
    if (this.unsub) this.unsub();
    if (this.unsubAuth) this.unsubAuth();
    [this.toastTimer, this.bumpTimer, this.comboTimer, this.confettiTimer].forEach((t) => {
      if (t) clearTimeout(t);
    });
    (this.fxTimers || []).forEach((t) => clearTimeout(t));
    this.fxTimers = [];
  },

  /* 特效层是 position:fixed（视口坐标），而 tap 事件给的是页面坐标，
     所以要自己记住滚动量。onPageScroll 只在发生滚动时触发，开销可以忽略。 */
  onPageScroll(e) {
    this.scrollTop = (e && e.scrollTop) || 0;
  },

  onPullDownRefresh() {
    const done = () => { this.render(); wx.stopPullDownRefresh(); };
    if (!auth.isLogged()) { wx.stopPullDownRefresh(); this.toast('未登录'); return; }
    store.sync({ force: true }).then(done, done);
  },

  /* ================= 渲染 ================= */

  render() {
    const st = store.get();
    if (!st) return;
    const logged = auth.isLogged();
    const ov = M.todayOverview(st);
    const sync = store.syncState();

    /* 每张目标卡需要的全部字段都在这里算好，WXML 只负责摆位置。
       两条进度条含义不同：
         pct      —— 整目标完成度（基准 .mini-progress 的用法）
         todayPct —— 今天这一档（基准 .goal-action-side 里的 cp-bar） */
    const rows = ov.rows.map((r) => {
      const doneAmount = M.doneAmount(st, r.goal.id);
      const totalPct = r.goal.total > 0 ? Math.min(100, Math.round(doneAmount / r.goal.total * 100)) : 0;
      const todayPct = r.quota > 0
        ? Math.min(100, Math.round(r.got / r.quota * 100))
        : (r.status === 'done' ? 100 : 0);

      /* 示例目标优先标记：它靠琥珀底与「示例」徽标和真实目标区分，
         基准的顺序也是 .sample 写在 .done / .overdue 之后（后写覆盖）。 */
      let rowClass = '';
      let badge = '';
      let badgeClass = '';
      if (r.goal.sample) { rowClass = 'is-sample'; badge = '示例'; badgeClass = 'badge-sample'; }
      else if (r.status === 'done') { rowClass = 'is-done'; badge = '已达成'; badgeClass = 'badge-done'; }
      else if (r.status === 'overdue') { rowClass = 'is-overdue'; badge = '已逾期'; badgeClass = 'badge-overdue'; }
      else if (r.met) { badge = '今日已打卡'; badgeClass = 'badge-today'; }

      return {
        gid: r.goal.id,
        name: r.goal.name,
        color: U.gcolor(r.goal.color),
        unit: r.goal.unit,
        rowClass: rowClass,
        badge: badge,
        badgeClass: badgeClass,
        sample: !!r.goal.sample,

        done: U.trimNum(doneAmount),
        total: U.trimNum(r.goal.total),
        pct: totalPct,

        deadline: U.fmtShort(r.goal.deadline),
        streakNum: r.streak,
        quotaNum: r.status === 'done' ? '0' : U.trimNum(r.quota),

        got: U.trimNum(r.got),
        gotNum: r.got,
        todayPct: todayPct,
        complete: r.status === 'done'
      };
    });

    /* ---------- 今日区的三态：漏卡 / 休息日 / 全部完成 ----------
       判定口径照着设计基准来：
         · 昨天没打卡，且昨天不是本周已用掉的休息日 → 真漏卡（红卡，带「立即打卡」）
         · 昨天没打卡，但昨天能用休息日           → 已用休息日（黄卡，连续天数保住）
         · 两者都没有、今天也没待打卡             → 今天全部打卡（绿条）
         · 所有目标都已完成                       → 全部达成（绿条）
       isRestDay 的语义是「本周首个漏打日」，所以拿昨天去试：
       为真就说明昨天那次漏打已经被休息日抵掉了。 */
    const todayStr = U.todayStr();
    const yesterday = U.addDays(todayStr, -1);
    const rowMap = {};
    rows.forEach((r) => { rowMap[r.gid] = r; });

    const missedRows = [];
    const restRows = [];
    const activeList = M.activeGoals(st);

    activeList.forEach((g) => {
      const dates = M.dateSetOf(st, g.id);
      if (dates[yesterday]) return;             // 昨天打过卡
      if (yesterday < g.createdAt) return;      // 昨天这个目标还不存在

      const row = rowMap[g.id] || {};
      const left = U.diffDays(todayStr, g.deadline);   // 负数表示已过期
      const item = {
        gid: g.id,
        name: g.name,
        unit: g.unit,
        quotaText: row.quotaText || '',
        overdue: left < 0,
        overdueDays: left < 0 ? -left : 0
      };
      if (M.isRestDay(st, g.id, yesterday, dates)) restRows.push(item);
      else missedRows.push(item);
    });

    // 今天一笔没记、且不属于漏卡/休息日的目标数量
    let pendingCount = 0;
    activeList.forEach((g) => {
      if (M.logsOn(st, g.id, todayStr) > 0) return;
      if (missedRows.some((x) => x.gid === g.id)) return;
      if (restRows.some((x) => x.gid === g.id)) return;
      pendingCount++;
    });

    let allDoneText = '';
    if (activeList.length === 0 && st.goals.length > 0) {
      allDoneText = '所有目标都已达成。去「进度看板」回顾成果，或新建目标继续。';
    } else if (st.goals.length > 0 && !missedRows.length && !restRows.length && pendingCount === 0) {
      allDoneText = '今天全部目标都已打卡，保持住这个节奏。';
    }

    /* ---------- 已完成区 ----------
       M.activeGoals() 本身就不含已完成的目标，所以 ov.rows 里永远不会有它们，
       必须从全部 goals 里单独筛一遍再构造卡片。
       已完成区只需要「叫什么、做了多少、什么时候截止」，不需要进度条与 +1。 */
    const activeRows = rows;
    const doneRows = st.goals
      .filter((g) => !g.deleted && M.isComplete(st, g))
      .map((g) => ({
        gid: g.id,
        name: g.name,
        color: U.gcolor(g.color),
        unit: g.unit,
        done: U.trimNum(M.doneAmount(st, g.id)),
        total: U.trimNum(g.total),
        deadline: U.fmtShort(g.deadline),
        /* 示例目标即使已完成，也优先用琥珀态标记 */
        rowClass: g.sample ? 'is-sample' : 'is-done',
        badge: g.sample ? '示例' : '已达成',
        badgeClass: g.sample ? 'badge-sample' : 'badge-done',
        sample: !!g.sample
      }));

    /* ---------- 统计条：四张竖排数字卡（对齐基准 #todayStats） ----------
       基准第二张是「今日投入（分钟）」；用时只在基准的「补记」弹窗里录，
       本项目没有补记入口，所以改成「今日记录（次）」—— 形状一致，口径不同。 */
    const hitCount = activeRows.filter((r) => r.gotNum > 0).length;
    const bestStreak = activeRows.reduce((mx, r) => Math.max(mx, r.streakNum || 0), 0);
    let todayCount = 0;
    st.logs.forEach((l) => { if (!l.deleted && l.date === todayStr) todayCount++; });

    const statCards = [
      { k: 'hit', num: hitCount + '/' + activeRows.length, label: '今日已打卡', tone: 'is-brand' },
      { k: 'logs', num: todayCount, label: '今日记录（次）', tone: 'is-amber' },
      { k: 'goals', num: activeRows.length, label: '进行中目标', tone: 'is-green' },
      { k: 'flame', num: bestStreak + ' 天', label: '最长连续', tone: 'is-amber' }
    ];

    /* ---------- 本周节奏（周一 → 周日，按当天记录次数） ---------- */
    const rhythm = [];
    let rhythmTotal = 0;
    const monday = U.mondayOf(todayStr);
    const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];
    for (let i = 0; i < 7; i++) {
      const d = U.addDays(monday, i);
      let n = 0;
      st.logs.forEach((l) => { if (!l.deleted && l.date === d) n++; });
      rhythmTotal += n;
      const future = d > todayStr;
      rhythm.push({
        d: d,
        label: WEEK_CN[i],
        hit: n > 0,
        dot: (!future && n === 0) ? '·' : '',
        cls: (n > 0 ? 'hit' : '') + (d === todayStr ? ' today' : '') + (future ? ' future' : '')
      });
    }

    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 6 ? '夜深了' : (hour < 11 ? '早上好' : (hour < 14 ? '中午好' : (hour < 18 ? '下午好' : '晚上好')));

    this.setData({
      themeClass: prefs.themeClassOf(st.settings && st.settings.theme),
      logged: logged,
      user: auth.user(),
      syncText: this.syncLabel(sync.phase),
      syncDot: this.syncDot(sync.phase),
      syncTime: U.fmtAgo(sync.lastSyncAt),
      dateText: U.fmtShort(todayStr) + ' ' + U.weekdayCN(todayStr),
      greeting: greeting,
      rows: activeRows,
      doneRows: doneRows,
      hasGoals: rows.length > 0,
      statCards: statCards,
      rhythm: rhythm,
      rhythmTotal: rhythmTotal,

      // 今日区三态
      missedRows: missedRows,
      restRows: restRows,
      allDoneText: allDoneText,
      hasTodayZone: !!(missedRows.length || restRows.length || allDoneText)
    });
    /* 只有当天建议量的快照真的被写入了才落盘。
       这一页会因为同步事件被反复重绘，无条件 save 等于每次同步都整份写一次本地存储。 */
    if (ov.snapshotsWritten) store.save();
  },

  syncLabel(phase) {
    return {
      idle: '待同步', syncing: '同步中', synced: '已同步',
      error: '同步失败', needlogin: '未登录', offline: '离线'
    }[phase] || '待同步';
  },

  syncDot(phase) {
    return { synced: 'ok', syncing: 'sync', error: 'err', needlogin: 'off', offline: 'off', idle: 'off' }[phase] || 'off';
  },

  /* ================= 打卡 ================= */

  onPlus1(e) {
    const gid = e.currentTarget.dataset.gid;
    const st = store.get();
    const goal = M.goalById(st, gid);
    if (!goal) return;
    if (M.isComplete(st, goal)) { this.toast('这个目标已经完成了'); return; }

    /* 达成判定必须发生在写入之前：写完之后再看，就分不清
       「本来就已经达成」和「这一下刚刚跨过终点」了。 */
    const wasComplete = M.isComplete(st, goal);
    const wasTodayMet = M.isTodayMet(st, goal);

    const log = store.addLog(gid, U.todayStr(), 1, null, false);
    if (!log) return;

    prefs.feedback();
    this.render();
    this.bump(gid);
    this.strike(e, goal);

    const after = store.get();
    const justComplete = !wasComplete && M.isComplete(after, goal);
    const justMet = !wasTodayMet && M.isTodayMet(after, goal);

    /* 彩带一次点击只放一次，两种达成互斥 —— 与基准的判定顺序一致：
       整体达成优先，其次才是今日建议量达标。 */
    if (justComplete) {
      this.celebrate();
      sfx.achieve();
      this.toast('目标「' + goal.name + '」达成');
    } else if (justMet) {
      this.celebrate();
      sfx.todayDone();
      this.toast('今日目标完成，可以收工了');
    }
  },

  /* ================= +1 爆发：对齐基准 plus1Burst =================
     ① 按键回弹 + 内发光脉冲（popClass 两个类交替）
     ② 环形冲击波
     ③ 6~10 粒粒子（连击时减到 6 粒，避免糊屏）
     ④ 浮动 +1；连击 ≥3 再补一行 ×N 连击
     ⑤ 连击蓄力态 p1-c3 / p1-c6
     基准靠 document.createElement 往 body 追加节点，小程序没有 document，
     所以换成「一组对象 + setData」：wx:for 渲染，950ms 后从数组里摘掉。 */
  strike(e, goal) {
    const now = Date.now();
    const last = this.comboAt || 0;
    this.combo = (now - last < COMBO_WINDOW) ? (this.combo || 0) + 1 : 1;
    this.comboAt = now;

    const combo = this.combo;
    const color = U.gcolor(goal.color);
    const pt = this.fxPoint(e);

    const n = combo >= 2 ? SPARK_N_COMBO : SPARK_N;
    const seed = 'fx' + now + '_' + combo;
    const sparks = [];
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 / n) * i + Math.random() * 0.5;
      const dist = 56 + Math.random() * 44;
      sparks.push({
        k: seed + '_' + i,
        dx: Math.round(Math.cos(ang) * dist),
        dy: Math.round(Math.sin(ang) * dist),
        bg: i % 3 === 0 ? '#fbbf24' : color,
        delay: Math.round(Math.random() * 70)
      });
    }

    const fx = {
      k: seed,
      x: pt.x,
      y: pt.y,
      color: color,
      thin: combo >= 3,
      combo: combo >= 3 ? combo : 0,
      sparks: sparks
    };
    const list = this.data.fxList.concat([fx]).slice(-FX_MAX);

    this.setData({
      fxList: list,
      popClass: this.data.popClass === 'p1-pop-a' ? 'p1-pop-b' : 'p1-pop-a',
      p1Level: combo >= 6 ? 'p1-c6' : (combo >= 3 ? 'p1-c3' : '')
    });

    /* 音高这条线交给音效层：连击越高越「实」，一轮之后回落重走。
       触摸反馈（震动）在 onPlus1 里已经给过了，这里只补声音。 */
    sfx.plus1(combo);

    /* 回弹只跑 0.42s，结束后必须把类摘掉：
       否则它和 p1-c6 抢同一个 animation 属性，蓄力呼吸永远起不来。 */
    if (this.popTimer) clearTimeout(this.popTimer);
    this.popTimer = setTimeout(() => this.setData({ popClass: '' }), 430);

    /* 连击断链后收掉蓄力态，否则按钮会一直闪 */
    if (this.comboTimer) clearTimeout(this.comboTimer);
    this.comboTimer = setTimeout(() => {
      this.combo = 0;
      this.comboAt = 0;
      this.setData({ p1Level: '' });
    }, COMBO_WINDOW + 300);

    const key = fx.k;
    this.fxTimers = this.fxTimers || [];
    /* 定时器执行时把自己从列表里摘掉，否则长按连打会让这个数组一直变长 */
    const timer = setTimeout(() => {
      this.fxTimers = (this.fxTimers || []).filter((t) => t !== timer);
      const rest = this.data.fxList.filter((v) => v.k !== key);
      if (rest.length !== this.data.fxList.length) this.setData({ fxList: rest });
    }, 950);
    this.fxTimers.push(timer);
  },

  /* 爆发的原点。tap 事件的 detail 带的是页面坐标，特效层是 position:fixed 的视口坐标，
     所以减掉当前滚动量。拿不到坐标时（键盘/无障碍触发、测试里直接调 onPlus1）
     退回屏幕中心 —— 位置会偏，但不会报错。 */
  fxPoint(e) {
    const d = (e && e.detail) || {};
    if (typeof d.x === 'number' && isFinite(d.x) && typeof d.y === 'number' && isFinite(d.y)) {
      return { x: d.x, y: d.y - (this.scrollTop || 0) };
    }
    let w = 375;
    let h = 600;
    try {
      const info = (typeof wx.getWindowInfo === 'function') ? wx.getWindowInfo() : wx.getSystemInfoSync();
      if (info) { w = info.windowWidth || w; h = info.windowHeight || h; }
    } catch (err) {
      /* 没有窗口信息就用默认值 */
    }
    return { x: w / 2, y: h / 2 };
  },

  /* ================= 达成彩带：对齐基准 celebrate =================
     尺寸、漂移、翻转、逐片延迟照抄；只把片数从 110 降到 24（节点预算）。
     放彩带前先清空 fxList：同一时刻只保留一种特效，节点数不叠加。 */
  celebrate() {
    const bits = [];
    for (let i = 0; i < CONFETTI_N; i++) {
      const w = 6 + Math.random() * 9;
      const bias = Math.random();
      const drift = bias < 0.22 ? -(40 + Math.random() * 90)
        : (bias > 0.78 ? (40 + Math.random() * 90) : (Math.random() * 26 - 13));
      bits.push({
        k: 'cf' + i,
        left: Math.round(Math.random() * 1000) / 10,
        w: Math.round(w * 10) / 10,
        h: Math.round(w * (0.38 + Math.random() * 0.42) * 10) / 10,
        bg: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        round: Math.random() < 0.34,
        drift: Math.round(drift * 10) / 10,
        dur: Math.round((1.9 + Math.random() * 1.6) * 100) / 100,
        delay: Math.round(Math.random() * 75) / 100
      });
    }

    this.setData({ fxList: [], confetti: bits, confettiOn: true });
    if (this.confettiTimer) clearTimeout(this.confettiTimer);
    this.confettiTimer = setTimeout(() => this.setData({ confettiOn: false, confetti: [] }), 4400);
  },

  /** 给刚被点的卡片加一次「闪光」，让手指的动作有落点 */
  bump(gid) {
    const key = 'bumpGid';
    this.setData({ [key]: gid });
    if (this.bumpTimer) clearTimeout(this.bumpTimer);
    this.bumpTimer = setTimeout(() => { if (this.data[key] === gid) this.setData({ [key]: '' }); }, 420);
  },

  onUndo(e) {
    const gid = e.currentTarget.dataset.gid;
    wx.showModal({
      title: '撤销这次打卡？',
      content: '会删掉今天该目标最后一条记录',
      confirmText: '撤销',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return;
        const l = store.undoLastLog(gid, U.todayStr());
        this.render();
        if (l) sfx.undo(); else sfx.error();
        this.toast(l ? '已撤销' : '今天还没有记录');
      }
    });
  },

  /* ================= 导航 ================= */

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  /** 顶部状态条点进来：同步明细在「我的」页 */
  goSync() { wx.switchTab({ url: '/pages/mine/mine' }); },

  /**
   * 过审模式：不跳编辑页（那里全是输入框），改成弹预设列表。
   * 用户只需要挑一个，不需要打字。
   */
  goNewGoal() {
    if (CFG.SAFE_MODE) { this.setData({ presetOn: true }); return; }
    wx.navigateTo({ url: '/pages/goal-edit/goal-edit' });
  },

  closePreset() { this.setData({ presetOn: false }); },

  pickPreset(e) {
    const idx = Number(e.currentTarget.dataset.i);
    const p = CFG.PRESETS[idx];
    if (!p) return;

    const t = U.todayStr();
    store.addGoal({
      id: 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
      name: p.name,
      unit: p.unit,
      total: p.total,
      deadline: U.addDays(t, p.days),
      createdAt: t,
      color: p.color,
      sample: false,
      obstacle: '',
      plan: ''
    });

    this.setData({ presetOn: false });
    this.render();
    sfx.saved();
    this.toast('已添加「' + p.name + '」');
  },

  goEditGoal(e) {
    const gid = e.currentTarget.dataset.gid;
    wx.navigateTo({ url: '/pages/goal-edit/goal-edit?id=' + encodeURIComponent(gid) });
  },

  /* ================= 「⋯」目标操作抽屉 =================
     对齐设计基准的 #goalMenu：遮罩模糊 + 底部磨砂玻璃抽屉 + 顶部拖拽条，
     弹出动画 gmUp .26s cubic-bezier(.22,1,.36,1)。
     菜单项与基准一致：编辑目标 / 调整计划（仅逾期时出现）/ 删除目标 / 取消。
     基准里另外还有「本次用时」输入框和「补记 / 批量录入」，这两项本轮未做，
     原因见交付说明的申报清单。 */

  openMenu(e) {
    const gid = e.currentTarget.dataset.gid;
    const g = M.goalById(store.get(), gid);
    if (!g) return;
    sfx.tap();
    this.setData({
      menuOn: true,
      menuGid: gid,
      menuName: g.name,
      menuOverdue: U.diffDays(U.todayStr(), g.deadline) < 0
    });
  },

  closeMenu() {
    this.setData({ menuOn: false, menuGid: '', menuName: '', menuOverdue: false });
  },

  /** 抽屉内容区自己消化点击，别冒泡到遮罩把抽屉关掉 */
  noopMenu() { },

  menuEdit() {
    const gid = this.data.menuGid;
    this.setData({ menuOn: false });
    wx.navigateTo({ url: '/pages/goal-edit/goal-edit?id=' + encodeURIComponent(gid) });
  },

  /** 删除的确认文案与 goal-edit 页逐字一致，避免同一操作出现两种说法 */
  menuDelete() {
    const gid = this.data.menuGid;
    const st = store.get();
    const done = M.doneAmount(st, gid);
    const count = st.logs.filter((l) => l.goalId === gid && !l.deleted).length;
    wx.showModal({
      title: '删除这个目标？',
      content: '连同它的 ' + count + ' 条打卡记录（共 ' + U.trimNum(done) + '）一起删除，所有设备同步生效。',
      confirmText: '删除',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return;
        store.deleteGoal(gid);
        this.setData({ menuOn: false, menuGid: '', menuName: '', menuOverdue: false });
        this.render();
        this.toast('已删除');
      }
    });
  },

  /* ================= 提示 ================= */

  toast(msg, ms) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.setData({ toast: msg, toastOn: true });
    this.toastTimer = setTimeout(() => this.setData({ toastOn: false }), ms || 1800);
  }
});
