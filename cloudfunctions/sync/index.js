/**
 * 云函数 sync —— 打卡数据的多设备同步入口。
 *
 * 与 auth 的关系：sync 不做登录，只用「当前微信的 openid」换算成账号。
 * openid 由 cloud.getWXContext() 注入，客户端拿不到也改不了，
 * 所以这条链路不需要任何令牌 —— 客户端连 token 都不用存。
 *
 * 集合：sync_docs（一个账号一个 core 分片 + 每月一个 logs 分片）
 */

const cloud = require('wx-server-sdk');
const { repo } = require('./lib/repo.js');
const service = require('./lib/service.js');
const { toEnvelope, ok } = require('./lib/errors.js');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event, context) => {
  const wx = cloud.getWXContext() || {};
  const ctx = {
    repo: repo(db),
    now: Date.now(),
    openid: wx.OPENID || '',
    unionid: wx.UNIONID || ''
  };

  try {
    const data = await service.handle(ctx, event && event.action, event);
    return ok(data);
  } catch (err) {
    return toEnvelope(err);
  }
};
