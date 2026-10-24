/**
 * 设备本地偏好。
 *
 * 与 store 里的 settings 的区别：
 *   settings 属于「账号」，跟数据一起同步（音效、音量、外观）。
 *   这里的东西属于「这台设备」，刻意不上云 —— 手机想震动、平板不想，
 *   这是合理诉求，不应该被同步成同一种行为。
 */

const HAPTIC_KEY = 'lgt.haptic.v1';

function read(key, dflt) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === undefined || v === null ? dflt : v;
  } catch (e) { return dflt; }
}

function write(key, v) {
  try { wx.setStorageSync(key, v); } catch (e) { /* 写失败就用默认值，不阻塞交互 */ }
}

function haptic() { return !!read(HAPTIC_KEY, true); }

function setHaptic(on) { write(HAPTIC_KEY, !!on); }

/* ================= 外观 =================
   小程序没有「强制指定配色方案」的官方 API，所以三档是这样落地的：
     auto  → 什么都不做，由 app.json 的 darkmode + WXSS 的媒体查询跟随系统
     dark  → 页面根容器加 .theme-dark（app.wxss 里重声明了一套深色 token）
     light → 页面根容器加 .theme-light
   导航栏与自定义 tabBar 不在页面容器内，需要另外同步。 */

function themeClassOf(pref) {
  if (pref === 'dark') return 'theme-dark';
  if (pref === 'light') return 'theme-light';
  return '';
}

/** 当前系统是否为深色 */
function systemDark() {
  try {
    if (wx.getAppBaseInfo) {
      const info = wx.getAppBaseInfo();
      if (info && info.theme) return info.theme === 'dark';
    }
    if (wx.getSystemInfoSync) {
      const info = wx.getSystemInfoSync();
      if (info && info.theme) return info.theme === 'dark';
    }
  } catch (e) { /* 取不到就按浅色处理 */ }
  return false;
}

/** 实际生效的外观（auto 时返回系统当前值） */
function effectiveDark(pref) {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return systemDark();
}

/**
 * 状态栏文字颜色。
 * 四个 tab 页用了自绘 hero（深蓝渐变），状态栏必须白字才看得见；
 * 二级页（登录 / 编辑目标）有系统浅色导航栏，要回到黑字。
 * 与 applyNavTheme 的区别：那个跟随深浅主题，这个是「页面头部是什么颜色」决定的。
 */
function setStatusBarLight(light) {
  try {
    wx.setNavigationBarColor({
      frontColor: light ? '#ffffff' : '#000000',
      backgroundColor: light ? '#0B2A5B' : '#F2F2F7'
    });
  } catch (e) { /* 不支持就忽略，不影响功能 */ }
}

function applyNavTheme(pref) {
  const dark = effectiveDark(pref);
  try {
    wx.setNavigationBarColor({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: dark ? '#0B0B0F' : '#F2F2F7'
    });
  } catch (e) { /* 部分基础库不支持，不影响页面内容 */ }
}

/** 系统外观变化时回调（仅在 auto 档下需要响应） */
function watchSystemTheme(cb) {
  if (typeof wx.onThemeChange !== 'function') return function () { };
  const handler = (res) => cb(res && res.theme === 'dark');
  wx.onThemeChange(handler);
  return function off() {
    if (typeof wx.offThemeChange === 'function') wx.offThemeChange(handler);
  };
}

/** 统一的触觉反馈入口：关闭时静默，开启时也不因为失败打断主流程 */
function feedback(type) {
  if (!haptic()) return;
  try {
    wx.vibrateShort({ type: type || 'light', fail: () => { } });
  } catch (e) { /* 部分机型不支持震动 */ }
}

module.exports = {
  haptic: haptic,
  setHaptic: setHaptic,
  feedback: feedback,
  themeClassOf: themeClassOf,
  systemDark: systemDark,
  effectiveDark: effectiveDark,
  applyNavTheme: applyNavTheme,
  setStatusBarLight: setStatusBarLight,
  watchSystemTheme: watchSystemTheme
};
