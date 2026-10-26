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
  /** 分享分叉记录：{ forked, at, welcomed, tpl } —— 见 utils/fork.js */
  FORK: 'lgt.fork.v1',
  LEGACY: ['goal_workspace_v1', 'learning-goal-tracker-v1']
};

/** 同步节奏 */
const TIMING = {
  /** 进入前台时的自动同步节流 */
  AUTO_SYNC_THROTTLE_MS: 20 * 1000,
  /** 写操作后的推送 debounce */
  PUSH_DEBOUNCE_MS: 600,
  /** 预拉取快照多久内算「刚拉过」，可以直接跳过登录后的全量 pull */
  PREFETCH_FRESH_MS: 10 * 60 * 1000
};

module.exports = { ENV_ID, AUTH_FN, SYNC_FN, K, TIMING };
