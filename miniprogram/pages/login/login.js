/**
 * 微信一键登录。
 *
 * 没有表单、没有密码、没有验证码 —— 整个页面只有一个按钮。
 * openid 由云函数从调用上下文里取，用户不需要输入任何东西，
 * 第一次点会顺手把账号建好（服务端 isNewAccount 标记）。
 *
 * 页面只有一个按钮，不写隐私说明、不解释数据流向 ——
 * 那些属于文档，不属于界面。2026-10-25 起登录是必经步骤（app 登录闸门）：
 * 未登录进不来任何 tab 页，本页就是入口。
 */

const auth = require('../../utils/auth.js');
const api = require('../../utils/api.js');
const store = require('../../utils/store.js');
const prefs = require('../../utils/prefs.js');

Page({
  data: {
    themeClass: '',
    busy: false,
    busyText: '',
    error: '',
    cloudReady: true,
    cloudError: ''
  },

  onLoad() {
    // 二级页有系统浅色导航栏，状态栏要回到黑字（tab 页的 hero 把它是白的）
    prefs.setStatusBarLight(false);

    const app = getApp();
    const st = store.get();
    this.setData({
      themeClass: prefs.themeClassOf(st && st.settings && st.settings.theme),
      cloudReady: !!(app.globalData && app.globalData.cloudReady),
      cloudError: (app.globalData && app.globalData.cloudError) || ''
    });
    // 已经登录的人不该再看到登录页
    if (auth.isLogged()) {
      wx.switchTab({ url: '/pages/today/today' });
    }
  },

  /* ================= 登录 ================= */

  doLogin() {
    if (this.data.busy) return;
    if (!this.data.cloudReady) {
      this.setData({ error: this.data.cloudError || '云开发还没配置好，账号功能暂不可用' });
      return;
    }

    this.setData({ busy: true, busyText: '正在获取微信身份…', error: '' });

    auth.login()
      .then((r) => {
        this.setData({ busyText: '正在同步你的打卡数据…' });
        return store.onLoggedIn().then(
          () => ({ isNew: !!(r && r.isNewAccount), synced: true }),
          // 数据对齐失败不影响登录本身：本机已经可用，后台会自动重试
          () => ({ isNew: !!(r && r.isNewAccount), synced: false })
        );
      })
      .then((r) => {
        this.setData({ busy: false, busyText: '' });
        wx.showToast({
          title: r.isNew ? '账号已创建' : (r.synced ? '已登录' : '已登录，稍后自动同步'),
          icon: 'none',
          duration: 1200
        });
        setTimeout(() => wx.switchTab({ url: '/pages/today/today' }), 500);
      })
      .catch((e) => {
        this.setData({ busy: false, busyText: '' });
        this.setData({ error: (e && (e.apiMessage || e.message)) || '登录失败，请重试' });
      });
  },

});
