/**
 * 云函数 prefetch —— 数据预拉取（个人主体只能走云开发环境）。
 *
 * 部署后还要去小程序后台做两件事（缺一不可）：
 *   开发 → 开发管理 → 开发设置 → 数据预拉取 → 开启
 *   → 数据来源「云开发」→ 选环境 → 选本函数 prefetch
 *
 * 这个入口没有 action 分发，也不返回 { ok, data } 信封：
 * 微信要的是「整个返回值就是缓存体」，客户端自己 JSON.parse。
 * 所以出错时也返回一个合法的空载荷字符串，让客户端安静地退回常规 pull。
 */

const cloud = require('wx-server-sdk');
const { repo } = require('./lib/repo.js');
const service = require('./lib/service.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const started = Date.now();
  const wx = cloud.getWXContext() || {};
  const ctx = {
    repo: repo(db),
    now: started,
    openid: wx.OPENID || ''
  };

  try {
    /* 只打字段名，不打值：首次配置后能在云函数日志里确认微信实际传了哪些字段
       （不同基础库对 openId 的大小写/层级有过差异）。 */
    console.log('[prefetch] event keys=' + Object.keys(event || {}).join(','));
    return await service.build(ctx, event || {});
  } catch (e) {
    // 预拉取失败不能影响打开小程序：返回空载荷，客户端照常走 sync.pull
    console.log('[prefetch] 失败，返回空载荷：' + ((e && e.message) || e));
    return JSON.stringify(service.emptyPayload(started));
  }
};
