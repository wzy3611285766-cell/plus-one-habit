/**
 * 账号业务编排 —— 微信一键登录。
 *
 * 身份模型只有一句话：**openid 就是账号**。
 *   第一次调用 login：用当前微信的 openid 建号；
 *   之后每次调用：同一个 openid 命中同一个账号。
 *
 * 为什么不再需要密码 / 验证码 / 会话令牌：
 *   1. openid 由微信在云函数调用时注入（cloud.getWXContext），客户端拿不到、也改不了，
 *      这本身就比「客户端带一个 token」更强 —— token 是能泄露的，openid 不能伪造。
 *   2. 没有密码就没有爆破面，所以不需要锁定、失败计数、限流、验证码投递。
 *   3. 没有会话就没有过期、续期、轮换、设备列表。
 *
 * 代价（已在 README 与「我的」页写明）：账号跟着这个微信号走。
 * 换手机用同一个微信登录，数据还在；换微信号或微信被封，数据找不回来。
 */

const crypto = require('crypto');
const { AppError, CODES } = require('./errors.js');

const MAX_NICKNAME = 24;

/* ================= 小工具 ================= */

/** 内部账号 id。用随机串而不是 openid：openid 属于微信的身份标识，不该散落成业务主键 */
function newAccountId() {
  return 'u_' + crypto.randomBytes(9).toString('hex');
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return max && s.length > max ? s.slice(0, max) : s;
}

/** 昵称去掉控制字符与换行，长度按「字」算（emoji 不会被截成半个） */
function normalizeNickname(v) {
  const raw = str(v, 200).replace(/[\u0000-\u001F\u007F]/g, '');
  const chars = Array.from(raw);
  return chars.length > MAX_NICKNAME ? chars.slice(0, MAX_NICKNAME).join('') : raw;
}

/** 对外暴露的用户信息：不透出 openid、_openid 等微信侧标识 */
function publicUser(acc) {
  return {
    id: acc._id,
    nickname: acc.nickname || '',
    createdAt: acc.createdAt || 0,
    hasWechat: true
  };
}

/** 取当前微信对应的账号；没有就报 NOT_REGISTERED，让客户端去走一键登录 */
async function requireAccount(ctx) {
  if (!ctx.openid) {
    throw AppError(CODES.OPENID_MISSING, '拿不到微信身份，请在小程序内打开');
  }
  const account = await ctx.repo.findAccountByOpenid(ctx.openid);
  if (!account) throw AppError(CODES.NOT_REGISTERED, '还没有登录，请先微信一键登录');
  if (account.status !== 'active') throw AppError(CODES.ACCOUNT_DISABLED, '账号已被停用');
  return account;
}

/* ================= 动作 ================= */

const actions = {};

/**
 * 一键登录（顺带注册）。
 * 客户端不需要传任何凭据 —— openid 由云函数从调用上下文里取。
 * 返回值里的 isNewAccount 用来决定是否提示「欢迎」而不是「欢迎回来」。
 */
actions.login = async function (ctx, payload) {
  if (!ctx.openid) {
    throw AppError(CODES.OPENID_MISSING, '拿不到微信身份，请在小程序内打开');
  }

  let account = await ctx.repo.findAccountByOpenid(ctx.openid);
  if (account) {
    if (account.status !== 'active') throw AppError(CODES.ACCOUNT_DISABLED, '账号已被停用');
    await ctx.repo.updateAccount(account._id, { lastLoginAt: ctx.now });
    account.lastLoginAt = ctx.now;
    return { user: publicUser(account), isNewAccount: false };
  }

  const now = ctx.now;
  const doc = {
    _id: newAccountId(),
    openid: ctx.openid,
    unionid: ctx.unionid || '',
    nickname: normalizeNickname(payload && payload.nickname),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now
  };

  try {
    doc._id = (await ctx.repo.createAccount(doc)) || doc._id;
  } catch (e) {
    /* 两台设备同时首次打开时的竞态：唯一索引会挡住第二次插入，
       此时再查一次即可拿到对方刚建好的账号，不该把错误抛给用户。 */
    const again = await ctx.repo.findAccountByOpenid(ctx.openid);
    if (!again) throw e;
    return { user: publicUser(again), isNewAccount: false };
  }

  return { user: publicUser(doc), isNewAccount: true };
};

/** 当前微信的账号信息（冷启动时用来确认本地缓存是否还成立） */
actions.me = async function (ctx) {
  const account = await requireAccount(ctx);
  return { user: publicUser(account) };
};

/** 更新昵称 */
actions.updateProfile = async function (ctx, payload) {
  const account = await requireAccount(ctx);
  const patch = {};
  if (payload && payload.nickname !== undefined) patch.nickname = normalizeNickname(payload.nickname);
  if (!Object.keys(patch).length) throw AppError(CODES.INVALID_INPUT, '没有需要更新的内容');
  await ctx.repo.updateAccount(account._id, patch);
  Object.assign(account, patch);
  return { user: publicUser(account) };
};

/**
 * 注销账号：删掉账号文档，连同它的全部同步分片。
 *
 * 为什么放在 auth 而不是 sync：注销的对象是「账号」，数据只是它的附属物。
 * 拆成两次调用（先 wipe 再删账号）中间断了会留下孤儿数据，所以一次做完。
 *
 * 不可恢复，所以要求显式 confirm:'DELETE'（前端还要输入确认词）。
 */
actions.deleteAccount = async function (ctx, payload) {
  const account = await requireAccount(ctx);
  if (str(payload && payload.confirm, 20) !== 'DELETE') {
    throw AppError(CODES.INVALID_INPUT, '需要二次确认才能注销账号');
  }

  const removedShards = await ctx.repo.deleteSyncDocs(account._id);
  await ctx.repo.removeAccount(account._id);

  return { deleted: true, removedShards: removedShards };
};

/** 健康检查：部署后用来确认云函数与数据库是否就位 */
actions.ping = async function (ctx) {
  return { pong: true, now: ctx.now, hasOpenid: !!ctx.openid };
};

/* ================= 分发 ================= */

async function handle(ctx, action, payload) {
  const name = str(action, 40);
  // 白名单查表，不拼字符串求值：未注册的 action 一律拒绝
  const fn = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
  if (!fn) throw AppError(CODES.INVALID_INPUT, '不支持的操作：' + name);
  return fn(ctx, payload || {});
}

module.exports = {
  handle: handle,
  actions: actions,
  publicUser: publicUser,
  normalizeNickname: normalizeNickname,
  newAccountId: newAccountId,
  MAX_NICKNAME: MAX_NICKNAME
};
