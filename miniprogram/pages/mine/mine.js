/**
 * 我的 —— 身份、偏好、其他。
 *
 * 页面只回答「我现在是什么状态」和「我能改什么」，不谈数据存在哪里：
 * 用户不需要理解本机 / 云端的区别，只需要知道「这台手机上的记录被清掉了」
 * 或者「账号被注销了」。技术词出现在界面上只会制造焦虑，不会增加掌控感。
 *
 * 破坏性操作仍然要二次确认 —— 不是为了吓人，是因为它们不可逆。
 */

const store = require('../../utils/store.js');
const auth = require('../../utils/auth.js');
const fork = require('../../utils/fork.js');
const api = require('../../utils/api.js');
const M = require('../../utils/model.js');
const U = require('../../utils/util.js');
const prefs = require('../../utils/prefs.js');
const sfx = require('../../utils/sfx.js');

Page({
  data: {
    themeClass: '',
    cloudReady: true,
    cloudError: '',
    logged: false,
    user: null,
    joinedDays: 0,
    hasSample: false,
    /* 分叉态（未登录 + 从分享卡片种入过目标）才显示「重新载入」入口 */
    forked: false,
    themeOn: false,
    stats: { records: 0, streak: 0, goals: 0, logs: 0 },

    sync: { dot: 'off', text: '未登录', time: '', msg: '' },

    theme: 'auto',
    themeText: '跟随系统',
    haptic: true,

    soundOn: true,
    volume: 60,
    minVol: sfx.MIN_PCT,
    maxVol: sfx.MAX_PCT,

    // 弹层
    sheet: '',            // '' | 'nickname' | 'deleteAccount'
    busy: false,
    form: { nickname: '', confirmDelete: '' },
    formError: '',

    toast: '',
    toastOn: false
  },

  onLoad() {
    const app = getApp();
    this.setData({
      cloudReady: !!app.globalData.cloudReady,
      cloudError: app.globalData.cloudError || ''
    });
    this.unsub = store.on((e) => {
      if (e.type === 'state' || e.type === 'sync') this.render();
    });
    this.unsubAuth = auth.on(() => this.render());
    this.render();
  },

  onShow() {
    if (this.getTabBar && this.getTabBar()) this.getTabBar().setActive('mine');
    prefs.setStatusBarLight(true);
    this.render();
    if (auth.isLogged()) {
      store.pull().then(() => this.render()).catch(() => this.render());
    }
  },

  onUnload() {
    if (this.unsub) this.unsub();
    if (this.unsubAuth) this.unsubAuth();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.setTabBarVisible(true);
  },

  onHide() {
    // 弹层开着时若用户点底栏切走了（底栏可能浮在遮罩之上），
    // 回来时不应还挂着弹层，tabBar 也要恢复
    if (this.data.sheet) this.setData({ sheet: '' });
    this.setTabBarVisible(true);
  },

  /**
   * 弹层期间隐藏自定义 tabBar：真机上它的渲染层级不完全受页面 z-index 控制，
   * 压住弹层底部确认按钮是已知问题；官方 hide/showTabBar 跨机型稳定。
   */
  setTabBarVisible(visible) {
    try {
      const fn = visible ? wx.showTabBar : wx.hideTabBar;
      if (typeof fn === 'function') fn({ animated: false });
    } catch (e) { /* 非 tab 页 / 重复隐藏等场景静默 */ }
  },

  /* ================= 渲染 ================= */

  render() {
    const st = store.get();
    if (!st) return;
    const logged = auth.isLogged();
    const user = auth.user();
    const sync = store.syncState();
    const goals = M.activeGoals(st);
    const logs = M.activeLogs(st);

    let joinedDays = 0;
    if (user && user.createdAt) {
      joinedDays = Math.max(1, Math.round((Date.now() - user.createdAt) / 86400000));
    }

    this.setData({
      themeClass: prefs.themeClassOf(this.themePref()),
      theme: this.themePref(),
      themeText: this.themeText(this.themePref()),
      logged: logged,
      user: user,
      joinedDays: joinedDays,
      hasSample: store.hasSample(),
      forked: !logged && store.forkInfo().forked,
      stats: {
        records: logs.length,
        streak: M.globalStreak(st),
        goals: goals.length,
        logs: logs.length
      },
      sync: {
        dot: this.dotOf(logged ? sync.phase : 'needlogin'),
        /* 未登录就是「未登录」，不要写成「待同步」——那会让用户以为
           有个任务在等着他，而其实只是没登录 */
        text: logged ? this.labelOf(sync.phase) : '未登录',
        time: U.fmtAgo(sync.lastSyncAt),
        /* 只在真的失败时说明一句；「未登录」不解释，那是状态不是错误 */
        msg: sync.phase === 'error' ? (sync.message || '同步失败，稍后会自动重试') : ''
      },
      themeOn: this.themePref() === 'dark',
      theme: this.themePref(),
      themeText: this.themeText(this.themePref()),
      haptic: this.hapticPref(),
      soundOn: sfx.soundEnabled(),
      volume: sfx.volumePct()
    });
  },

  dotOf(p) { return { synced: 'ok', syncing: 'sync', error: 'err', needlogin: 'off', offline: 'off' }[p] || 'off'; },
  labelOf(p) {
    return { idle: '待同步', syncing: '同步中', synced: '已同步', error: '同步失败', needlogin: '未登录', offline: '离线' }[p] || '待同步';
  },

  /* ================= 登录 / 登出 ================= */

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }); },

  /* ================= 分享分叉 ================= */

  /** 「分享给同学」按钮（open-type="share"）走这里，与右上角 ⋯ 转发同一条路 */
  onShareAppMessage() {
    return fork.shareConfig(store.get());
  },

  /**
   * 重新载入分享时的那份数据（仅分叉态可见）。
   * 确认方式与「重置这台手机」一致：系统弹窗两段式，不用输入框。
   */
  refork() {
    wx.showModal({
      title: '重新载入分享的目标？',
      content: '这台手机上的目标和打卡记录会丢失，换成分享时复制来的那份。',
      confirmText: '重新载入',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return;
        const r = store.reforkFromShare();
        this.render();
        this.toast(r.ok ? '已重新载入' : '分享的数据不完整，没有载入');
      }
    });
  },

  logout() {
    wx.showModal({
      title: '退出登录？',
      content: '退出后停止同步，本机记录保留。',
      confirmText: '退出',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return;
        auth.logout().then(() => {
          store.onLoggedOut();
          this.render();
          this.toast('已退出登录');
        });
      }
    });
  },

  /* ================= 同步 ================= */

  resync() {
    if (!auth.isLogged()) { this.goLogin(); return; }
    if (this.data.busy) return;
    this.setData({ busy: true });
    store.sync({ force: true })
      .then(() => { this.setData({ busy: false }); this.render(); this.toast('已同步'); })
      .catch((e) => {
        this.setData({ busy: false });
        this.render();
        this.toast(e && e.apiMessage ? e.apiMessage : '同步失败，请检查网络');
      });
  },

  /* ================= 修改昵称 ================= */

  openNickname() {
    if (!this.data.logged) { this.goLogin(); return; }
    this.setTabBarVisible(false);
    this.setData({
      sheet: 'nickname',
      formError: '',
      form: Object.assign({}, this.data.form, { nickname: (this.data.user && this.data.user.nickname) || '' })
    });
  },

  submitNickname() {
    const v = String(this.data.form.nickname || '').trim();
    if (!v) { this.setData({ formError: '昵称不能为空' }); return; }
    this.setData({ busy: true, formError: '' });
    auth.updateProfile({ nickname: v })
      .then(() => { this.setTabBarVisible(true); this.setData({ busy: false, sheet: '' }); this.render(); this.toast('已更新'); })
      .catch((e) => { this.setData({ busy: false, formError: (e && e.apiMessage) || '更新失败' }); });
  },

  /* ================= 危险操作 ================= */

  /* ================= 注销账号 =================
     确认词用中文「注销」，不是一个英文单词 ——
     英文确认词在中文界面里像一道技术门槛，中文词是「你确实要这么做」的意思。 */

  openDeleteAccount() {
    if (!this.data.logged) { this.goLogin(); return; }
    this.setTabBarVisible(false);
    this.setData({
      sheet: 'deleteAccount',
      formError: '',
      form: Object.assign({}, this.data.form, { confirmDelete: '' })
    });
  },

  submitDeleteAccount() {
    if (String(this.data.form.confirmDelete || '').trim() !== '注销') {
      this.setData({ formError: '请输入「注销」两个字以确认' });
      return;
    }
    this.setData({ busy: true, formError: '' });

    auth.deleteAccount()
      .then((r) => {
        // 云端已经删干净了，本机这两份也不该留着
        store.clearLocalOnly();
        store.onLoggedOut();
        this.setTabBarVisible(true);
        this.setData({ busy: false, sheet: '' });
        this.render();
        this.toast('账号已注销');
      })
      .catch((e) => {
        this.setData({ busy: false, formError: (e && e.apiMessage) || '注销失败，请稍后重试' });
      });
  },

  /* ================= 示例数据 ================= */

  loadSample() {
    const r = store.installSample();
    this.render();
    this.toast(r.added ? ('已载入 ' + r.added + ' 个示例目标') : '示例数据已经在里面了');
  },

  clearSample() {
    const r = store.clearSample();
    this.render();
    this.toast(r.removed ? '示例数据已清除' : '没有示例数据');
  },

  clearLocal() {
    wx.showModal({
      title: '重置这台手机？',
      content: this.data.logged
        ? '这台手机上的记录会清掉，账号里的记录不受影响。'
        : '这台手机上的记录会清掉，无法恢复。',
      confirmText: '重置',
      confirmColor: '#FF3B30',
      success: (res) => {
        if (!res.confirm) return;
        store.clearLocalOnly();
        this.render();
        this.toast('已重置');
      }
    });
  },

  resetFromCloud() {
    if (!this.data.logged) { this.goLogin(); return; }
    wx.showModal({
      title: '恢复此账号的数据？',
      content: '会以账号里最新的记录为准，这台手机上还没同步的改动会丢失。',
      confirmText: '恢复',
      success: (res) => {
        if (!res.confirm) return;
        store.resetToRemote().then(() => {
          this.render();
          this.toast('已恢复');
        }).catch(() => this.toast('网络不太好，稍后再试'));
      }
    });
  },

  /* ================= 偏好 ================= */

  themePref() {
    const st = store.get();
    return (st && st.settings && st.settings.theme) || 'auto';
  },

  themeText(t) { return { auto: '跟随系统', dark: '深色', light: '浅色' }[t] || '跟随系统'; },

  /** 三态循环：跟随系统 → 深色 → 浅色 */
  /** 深色开关：开 = 始终深色，关 = 跟随系统（基准的 .switch 只有两态） */
  toggleTheme() {
    const next = this.themePref() === 'dark' ? 'auto' : 'dark';
    store.updateSettings({ theme: next });

    const app = getApp();
    if (app && typeof app.applyTheme === 'function') app.applyTheme();
    else prefs.applyNavTheme(next);

    this.render();
    this.syncTabBarTheme();
  },

  cycleTheme() {
    const order = ['auto', 'dark', 'light'];
    const cur = this.data.theme;
    const next = order[(order.indexOf(cur) + 1) % order.length];
    store.updateSettings({ theme: next });
    const app = getApp();
    // 导航栏 + 系统监听交给 app 统一处理，避免页面与 app 各管一半
    if (app && typeof app.applyTheme === 'function') app.applyTheme();
    else prefs.applyNavTheme(next);
    this.render();
    this.syncTabBarTheme();
    this.toast('外观：' + this.themeText(next));
  },

  hapticPref() { return prefs.haptic(); },

  toggleHaptic() {
    const next = !this.data.haptic;
    prefs.setHaptic(next);
    this.setData({ haptic: next });
    if (next) prefs.feedback();   // 打开时立刻给一次，让用户知道「这就是那个反馈」
  },

  /* ---------- 音效 ---------- */

  toggleSound(e) {
    const next = !!(e && e.detail ? e.detail.value : !this.data.soundOn);
    store.updateSettings({ sound: next });
    this.setData({ soundOn: next });
    // 打开时立刻响一下：用户能马上确认「就是这个音」。
    // 关闭时不响 —— 用户刚关掉声音，再补一声反而冒犯。
    if (next) sfx.toggle(true);
  },

  /**
   * 拖动滑块时实时试听。
   * 这里只改界面、不写库（写库放在 change 里）：
   * 拖动一次会触发几十次 changing，每次都落盘是没必要的开销。
   * 所以把当前值直接作为 override 传给 preview，而不是让它去读还没更新的设置。
   */
  onVolumeChanging(e) {
    const v = e.detail.value;
    this.setData({ volume: v });

    const now = Date.now();
    if (now - (this._volPreviewAt || 0) < 110) return;   // 节流，别每像素播一次
    this._volPreviewAt = now;
    sfx.preview(v);
  },

  onVolumeChange(e) {
    const v = e.detail.value;
    store.updateSettings({ volume: v });
    this.setData({ volume: v });
    sfx.preview(v);
  },

  previewSound() {
    if (!sfx.preview(this.data.volume)) this.toast('这台设备无法播放音频');
  },

  /* ================= 弹层通用 ================= */

  onInput(e) {
    const f = e.currentTarget.dataset.field;
    const patch = { formError: '' };
    patch['form.' + f] = e.detail.value;
    this.setData(patch);
  },

  closeSheet() {
    if (this.data.busy) return;
    this.setData({ sheet: '' });
    this.setTabBarVisible(true);
  },
  noop() { },

  /** tabBar 是独立组件，外观变了要主动通知它一次 */
  syncTabBarTheme() {
    const bar = this.getTabBar && this.getTabBar();
    if (bar && typeof bar.refreshTheme === 'function') bar.refreshTheme();
  },

  toast(msg, ms) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.setData({ toast: msg, toastOn: true });
    this.toastTimer = setTimeout(() => this.setData({ toastOn: false }), ms || 2000);
  }
});
