/**
 * 云函数 auth —— 微信一键登录。
 *
 * 这一层刻意做得极薄：只负责把云开发的运行时上下文（数据库、微信身份、时间）
 * 组装成 ctx，交给 lib/service.js，再把结果包成统一信封返回。
 * 所有业务规则都在 service.js 里，那样才能在本地用内存数据库完整跑单测。
 *
 * 不需要任何环境变量：没有验证码投递、没有密码加盐、没有会话策略。
 * 身份来自 cloud.getWXContext().OPENID —— 由微信注入，客户端无法伪造。
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
    // 绝不把异常直接抛给客户端：那样前端只能拿到一句没有信息量的 errMsg
    return toEnvelope(err);
  }
};
