/**
 * 全局配置。部署时唯一需要改动的文件。
 *
 * ENV_ID：微信云开发环境 ID。填写后 app.js 才会调用 wx.cloud.init。
 *   留空时小程序进入「本地模式」——微信登录不可用，
 *   打卡仍可离线记录在本机，并在「我的」页给出明确的配置提示。
 */
const ENV_ID = 'demo-d4ggmg7lf4736fb7c';

/** 云函数名 */
const AUTH_FN = 'auth';
const SYNC_FN = 'sync';

/** 本机存储键（统一前缀，避免与其它数据冲突） */
const K = {
  /** 微信身份缓存：{ user } —— 只用于渲染，不承担鉴权作用 */
  USER: 'lgt.wxuser.v1',
  STATE: 'lgt.state.v1',
  SHARDS: 'lgt.shards.v1',
  PENDING: 'lgt.pending.v1',
  LEGACY: ['goal_workspace_v1', 'learning-goal-tracker-v1']
};

/**
 * 过审精简模式。
 *
 * 微信审核对「用户自定义输入」卡得很死（尤其被归到互动类目时）。
 * 打开后，界面上**不再有任何需要打字的入口**，全部换成预设选项 + 点击：
 *   · 新建目标 → 从下面 4 个预设里挑一个
 *   · 周报复盘 → 只读自动汇总，四栏输入隐藏
 *   · 昵称     → 不可编辑
 * 打卡、看板、统计、同步完全不受影响。
 *
 * 过了审想恢复完整版，把它改成 false 即可，不需要改别的代码。
 */
const SAFE_MODE = true;

/**
 * 预设目标。过审模式的「新建目标」只认这四项：
 * 名称 / 单位 / 总量 / 周期都是定死的，用户不能改，也不能输入。
 */
const PRESETS = [
  { name: '背单词', unit: '个', total: 600, days: 30, color: '#6366f1' },
  { name: '读书', unit: '页', total: 300, days: 30, color: '#0ea5e9' },
  { name: '做习题', unit: '道', total: 200, days: 30, color: '#10b981' },
  { name: '运动', unit: '分钟', total: 900, days: 30, color: '#f59e0b' }
];

/** 同步节奏 */
const TIMING = {
  /** 进入前台时的自动同步节流 */
  AUTO_SYNC_THROTTLE_MS: 20 * 1000,
  /** 写操作后的推送 debounce */
  PUSH_DEBOUNCE_MS: 600
};

module.exports = { ENV_ID, AUTH_FN, SYNC_FN, K, TIMING, SAFE_MODE, PRESETS };
