/**
 * 云函数 auth —— 账号系统入口。
 *
 * 这一层刻意做得极薄：只负责把云开发的运行时上下文（数据库、微信身份、时间）
 * 组装成 ctx，交给 lib/service.js，再把结果包成统一信封返回。
 * 所有业务规则都在 service.js 里，那样才能在本地用内存数据库完整跑单测。
 *
 * 环境变量（在云开发控制台 → 云函数 → auth → 配置 里设置，全部可选）：
 *   AUTH_DEV_MODE=1            开发模式：验证码不真发，直接回传，便于联调
 *   AUTH_MAIL_WEBHOOK=<url>    邮箱验证码投递地址，POST JSON { to, subject, text, code }
 *   AUTH_SMS_WEBHOOK=<url>     短信验证码投递地址，POST JSON { phone, code, text }
 *   AUTH_WEBHOOK_TOKEN=<token> 上面两个地址的 Bearer 令牌
 *   AUTH_PEPPER=<随机长串>      密码额外加盐（启用后务必离线备份，丢失即全员无法登录）
 *   AUTH_APP_NAME=<应用名>     出现在邮件/短信正文里
 *   AUTH_REQUIRE_VERIFY=1      注册时要求邮箱/手机号验证码
 *   AUTH_RESET_REVEAL=1        找回密码时明确提示「该账号未注册」（默认关闭，防枚举）
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
    unionid: wx.UNIONID || '',
    appid: wx.APPID || '',
    // 限流的「来源」维度：优先用 openid（同一微信），没有则退回客户端 IP
    source: wx.OPENID || wx.CLIENTIP || 'anonymous',
    clientIp: wx.CLIENTIP || '',
    event: event || {}
  };

  try {
    const data = await service.handle(ctx, event && event.action, event);
    return ok(data);
  } catch (err) {
    // 绝不把异常直接抛给客户端：那样前端只能拿到一句没有信息量的 errMsg
    return toEnvelope(err);
  }
};
