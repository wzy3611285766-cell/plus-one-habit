/**
 * 打卡数据的同步服务。
 *
 * 对外三个动作：
 *   pull  —— 增量拉取。客户端把「本机各分片的 rev」传上来，服务端只回传 rev 更大的。
 *   push  —— 乐观并发推送。每个分片带 baseRev，服务端用原子条件更新做 CAS：
 *             成功 → rev + 1，返回新 rev
 *             失败 → 说明别的设备先改了，把服务端权威数据回传，客户端合并后重推
 *   stats —— 统计（分片数、记录数、占用字节），给「我的 → 数据与同步」展示
 *   wipe  —— 抹掉当前账号的全部云端数据（需要账号密码二次确认的替代方案：要求 confirm 字段）
 *
 * 一致性保证：
 *   pull 与 push 都以「分片」为最小单位，分片内部由客户端做记录级合并（并集 / LWW）。
 *   因此两台设备并发写入同一分片时不会互相覆盖：后到的那个会先合并再写，
 *   最终两份数据收敛到同一结果。这一点由 model.js 的 merge* 纯函数保证。
 *
 * 隔离保证：
 *   userId 一律由「当前微信的 openid」查 accounts 得到，请求体里任何 userId / _id / key
 *   都不会被当作归属依据。openid 由微信在调用上下文里注入，客户端伪造不了。
 */

const { AppError, CODES } = require('./errors.js');
const SH = require('./shard.js');
const { docId } = require('./repo.js');

function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

const DEVICE_LIMIT = 64;

/** 把 openid 换算成账号；没登录过就让客户端先去走一键登录 */
async function requireAccount(ctx) {
  if (!ctx.openid) {
    throw AppError(CODES.OPENID_MISSING, '拿不到微信身份，请在小程序内打开');
  }
  const account = await ctx.repo.findAccountByOpenid(ctx.openid);
  if (!account) throw AppError(CODES.NOT_REGISTERED, '还没有登录，请先微信一键登录');
  if (account.status !== 'active') throw AppError(CODES.ACCOUNT_DISABLED, '账号已被停用');
  return account;
}

/**
 * 拉取。
 * known 是 { 分片key: 本机rev }；force=true（或 known 为空）时全量返回。
 */
async function pull(ctx, payload) {
  const account = await requireAccount(ctx);

  const known = payload.known && typeof payload.known === 'object' ? payload.known : {};
  const rows = await ctx.repo.listDocs(account._id, 200);

  const docs = [];
  rows.forEach((d) => {
    if (!SH.isKey(d.key)) return;                    // 历史脏数据直接忽略
    const localRev = typeof known[d.key] === 'number' ? known[d.key] : -1;
    if (d.rev > localRev) {
      docs.push({
        key: d.key,
        rev: d.rev,
        payload: d.payload || null,
        updatedAt: d.updatedAt || 0
      });
    }
  });

  // 分片数量不大（1 个 core + 最多 36 个月），一次全带回比多次分页更简单也更省调用
  return {
    docs: docs,
    serverTime: ctx.now,
    userId: account._id,
    hasMore: false
  };
}

/**
 * 推送。逐分片 CAS，返回成功与冲突两组。
 * 客户端把 conflicts 合并进本机后重推，通常一次就能收敛。
 */
async function push(ctx, payload) {
  const account = await requireAccount(ctx);

  const docs = Array.isArray(payload.docs) ? payload.docs : [];
  if (!docs.length) return { applied: [], conflicts: [], serverTime: ctx.now };
  if (docs.length > SH.LIMITS.MAX_DOCS_PER_PUSH) {
    throw AppError(CODES.PAYLOAD_TOO_LARGE, '一次最多同步 ' + SH.LIMITS.MAX_DOCS_PER_PUSH + ' 个数据分片');
  }

  const deviceId = str(payload.deviceId, DEVICE_LIMIT) || 'unknown';
  const userId = account._id;

  let totalBytes = 0;
  const prepared = [];
  docs.forEach((d) => {
    const key = str(d && d.key, 40);
    const cleaned = SH.sanitizeShard(key, d && d.payload);
    const bytes = SH.sizeOf(cleaned);
    totalBytes += bytes;
    if (totalBytes > SH.LIMITS.MAX_PUSH_BYTES) {
      throw AppError(CODES.PAYLOAD_TOO_LARGE, '本次同步的数据量过大，请分批重试');
    }
    prepared.push({
      key: key,
      baseRev: typeof d.baseRev === 'number' && d.baseRev >= 0 ? Math.floor(d.baseRev) : 0,
      payload: cleaned,
      bytes: bytes
    });
  });

  // 同一个分片在一次请求里出现两次时只保留最后一条，避免自相冲突
  const byKey = {};
  prepared.forEach((p) => { byKey[p.key] = p; });
  const list = Object.keys(byKey).map((k) => byKey[k]);

  const applied = [];
  const conflicts = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const id = docId(userId, item.key);
    const existing = await ctx.repo.getDoc(id);

    if (!existing) {
      // 客户端以为云端已有（baseRev > 0）但实际没有：典型的「云端被清空」场景，
      // 直接以本次推送为准重建，不必让客户端空跑一轮冲突
      await ctx.repo.createDoc(id, {
        userId: userId,
        key: item.key,
        rev: 1,
        payload: item.payload,
        deviceId: deviceId,
        createdAt: ctx.now,
        updatedAt: ctx.now
      });
      applied.push({ key: item.key, rev: 1, bytes: item.bytes });
      continue;
    }

    if (existing.rev !== item.baseRev) {
      conflicts.push({ key: item.key, rev: existing.rev, payload: existing.payload || null });
      continue;
    }

    const nextRev = existing.rev + 1;
    const updated = await ctx.repo.casUpdate(id, existing.rev, {
      payload: item.payload,
      rev: nextRev,
      deviceId: deviceId,
      updatedAt: ctx.now
    });

    if (updated) {
      applied.push({ key: item.key, rev: nextRev, bytes: item.bytes });
    } else {
      // CAS 落空：在我们读取与写入之间，另一台设备抢先写入了
      const again = await ctx.repo.getDoc(id);
      conflicts.push({ key: item.key, rev: again ? again.rev : 0, payload: again ? again.payload : null });
    }
  }

  return { applied: applied, conflicts: conflicts, serverTime: ctx.now };
}

/** 统计：给「我的 → 数据与同步」展示云端占用与最近写入设备 */
async function stats(ctx, payload) {
  const account = await requireAccount(ctx);
  const rows = await ctx.repo.listDocs(account._id, 200);

  const shards = [];
  let bytes = 0;
  let goals = 0;
  let logs = 0;
  let notes = 0;

  rows.forEach((d) => {
    if (!SH.isKey(d.key)) return;
    const b = SH.sizeOf(d.payload);
    bytes += b;
    if (d.key === SH.CORE) {
      goals = (d.payload && Array.isArray(d.payload.goals)) ? d.payload.goals.filter((g) => !g.deleted).length : 0;
      notes = (d.payload && d.payload.notes) ? Object.keys(d.payload.notes).filter((k) => !(d.payload.notes[k] || {}).deleted).length : 0;
    } else {
      const items = (d.payload && Array.isArray(d.payload.items)) ? d.payload.items : [];
      logs += items.filter((x) => !x.deleted).length;
    }
    shards.push({ key: d.key, rev: d.rev, bytes: b, updatedAt: d.updatedAt || 0, deviceId: d.deviceId || '' });
  });

  shards.sort((a, b) => (a.key < b.key ? -1 : 1));
  const latest = shards.reduce((mx, s) => Math.max(mx, s.updatedAt || 0), 0);

  return {
    shardCount: shards.length,
    bytes: bytes,
    goals: goals,
    logs: logs,
    notes: notes,
    lastWriteAt: latest,
    shards: shards,
    serverTime: ctx.now
  };
}

/**
 * 抹掉当前账号的全部云端数据。
 * 这一步不可逆，因此要求客户端显式带上 confirm:'DELETE'（前端会做二次确认），
 * 并且必须处于登录态 —— 光有 token 不够，避免误触。
 */
async function wipe(ctx, payload) {
  const account = await requireAccount(ctx);
  if (str(payload.confirm, 20) !== 'DELETE') {
    throw AppError(CODES.INVALID_INPUT, '需要二次确认才能清空云端数据');
  }
  const count = await ctx.repo.deleteDocs(account._id);
  return { deleted: count, serverTime: ctx.now };
}

const actions = { pull: pull, push: push, stats: stats, wipe: wipe };

async function handle(ctx, action, payload) {
  const name = str(action, 40);
  const fn = Object.prototype.hasOwnProperty.call(actions, name) ? actions[name] : null;
  if (!fn) throw AppError(CODES.INVALID_INPUT, '不支持的操作：' + name);
  return fn(ctx, payload || {});
}

module.exports = {
  handle: handle,
  actions: actions,
  makeDocId: docId
};
