/**
 * 数据预拉取（微信冷启动缓存 → 本机分片）的测试。
 *
 * 分两层：
 *   服务端（cloudfunctions/prefetch）：身份来源、只读隔离、体积上限与裁剪顺序；
 *   客户端（utils/prefetch + store.applyPrefetched）：坏数据降级、换号不串数据、
 *     本机未推送改动不被快照覆盖、以及「快照够新时跳过全量 pull」。
 */

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createMockDb } from './mock/db.mjs';
import { installWxEnv } from './mock/wx.mjs';
import { group, test, assert, eq } from './harness.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MP = path.join(HERE, '..', 'miniprogram');

const { repo: pfRepo } = require('../cloudfunctions/prefetch/lib/repo.js');
const PF = require('../cloudfunctions/prefetch/lib/service.js');

const NOW = Date.UTC(2026, 9, 26, 2, 0, 0);

function ctxOf(db, openid) {
  return { repo: pfRepo(db), now: NOW, openid: openid || '' };
}

function seedAccount(db, id, openid, status) {
  db.collection('accounts').add({ data: { _id: id, openid: openid, status: status || 'active' } });
}

function seedDoc(db, userId, key, rev, payload) {
  db.collection('sync_docs').add({ data: { _id: 'd_' + userId + '_' + key, userId: userId, key: key, rev: rev, payload: payload } });
}

function parseBody(body) {
  assert(typeof body === 'string', '预拉取返回值必须是字符串');
  return JSON.parse(body);
}

/* ================================================================= */

group('预拉取云函数 · 身份与隔离');

await test('微信预拉取调用（无 ctx.openid）从 event.openId 认出用户', async () => {
  const db = createMockDb();
  seedAccount(db, 'u_alice', 'openid-alice');
  seedDoc(db, 'u_alice', 'core', 4, { goals: [{ id: 'g1' }], notes: {}, settings: {} });

  const body = await PF.build(ctxOf(db, ''), { openId: 'openid-alice', token: 'x', path: 'pages/today/today' });
  const o = parseBody(body);
  eq(o.v, 1);
  eq(o.userId, 'u_alice');
  eq(o.shards.core.rev, 4);
  eq(o.partial, false);
  assert(o.at > 0, '应带服务端时间戳');
});

await test('客户端直接调用时只认 ctx.openid，event 里伪造的 openId 无效', async () => {
  const db = createMockDb();
  seedAccount(db, 'u_alice', 'openid-alice');
  seedAccount(db, 'u_bob', 'openid-bob');
  seedDoc(db, 'u_alice', 'core', 7, { goals: [{ id: 'alice-secret' }], notes: {}, settings: {} });
  seedDoc(db, 'u_bob', 'core', 2, { goals: [{ id: 'bob-own' }], notes: {}, settings: {} });

  // bob 在小程序里直接调 prefetch，企图读 alice 的数据
  const body = await PF.build(ctxOf(db, 'openid-bob'), { openId: 'openid-alice' });
  const o = parseBody(body);
  eq(o.userId, 'u_bob', '只能拿到自己的账号');
  eq(o.shards.core.rev, 2);
  assert(body.indexOf('alice-secret') < 0, '不得带出别人的目标');
});

await test('没建号 / 账号停用 / 没身份来源，一律返回空载荷而不是报错', async () => {
  const db = createMockDb();
  seedAccount(db, 'u_off', 'openid-off', 'disabled');
  seedDoc(db, 'u_off', 'core', 1, { goals: [], notes: {}, settings: {} });

  const noId = parseBody(await PF.build(ctxOf(db, ''), {}));
  eq(noId.userId, '');
  eq(Object.keys(noId.shards).length, 0);

  const off = parseBody(await PF.build(ctxOf(db, ''), { openId: 'openid-off' }));
  eq(off.userId, '', '停用账号不预拉取');

  const nobody = parseBody(await PF.build(ctxOf(db, ''), { openId: 'openid-ghost' }));
  eq(nobody.userId, '');
});

await test('只带当前账号的分片，别人家的不混进来', async () => {
  const db = createMockDb();
  seedAccount(db, 'u_a', 'oa');
  seedAccount(db, 'u_b', 'ob');
  seedDoc(db, 'u_a', 'core', 2, { goals: [], notes: {}, settings: {} });
  seedDoc(db, 'u_b', 'core', 9, { goals: [{ id: 'b1' }], notes: {}, settings: {} });

  const o = parseBody(await PF.build(ctxOf(db, ''), { openId: 'oa' }));
  eq(Object.keys(o.shards).length, 1);
  eq(o.shards.core.rev, 2);
  assert(JSON.stringify(o).indexOf('b1') < 0, '不得带出别人的目标');
});

/* ================================================================= */

group('预拉取云函数 · 体积上限');

await test('超过 200KB 时按「core 优先、月份从新到旧」裁剪并标记 partial', async () => {
  const db = createMockDb();
  seedAccount(db, 'u_big', 'obig');
  seedDoc(db, 'u_big', 'core', 3, { goals: [{ id: 'g1' }], notes: {}, settings: {} });

  const fat = (tag) => {
    const items = [];
    for (let i = 0; i < 200; i++) {
      items.push({ id: tag + '-' + i, goalId: 'g1', date: tag, amount: 1, note: 'x'.repeat(600) });
    }
    return { items: items };
  };
  // 三个月份各 ~140KB，core 之外最多再放得下一个月份
  seedDoc(db, 'u_big', 'logs:2026-08', 1, fat('2026-08-01'));
  seedDoc(db, 'u_big', 'logs:2026-09', 1, fat('2026-09-01'));
  seedDoc(db, 'u_big', 'logs:2026-10', 1, fat('2026-10-01'));

  const body = await PF.build(ctxOf(db, ''), { openId: 'obig' });
  const o = parseBody(body);
  assert(Buffer.byteLength(body, 'utf8') <= PF.MAX_BODY_BYTES, '实际输出超过预算：' + Buffer.byteLength(body, 'utf8'));
  eq(o.partial, true, '裁掉了分片就必须标 partial');
  assert(o.shards.core, 'core 永远优先保留');
  assert(o.shards['logs:2026-10'], '最新月份应优先保留');
  assert(!o.shards['logs:2026-08'], '最旧月份应被裁掉');
});

await test('core 单分片就超预算时返回空载荷，绝不发超过 256KB 的 body', async () => {
  const db = createMockDb();
  seedAccount(db, 'u_fat', 'ofat');
  seedDoc(db, 'u_fat', 'core', 1, { goals: [{ id: 'g1', name: 'x'.repeat(300 * 1024) }], notes: {}, settings: {} });

  const body = await PF.build(ctxOf(db, ''), { openId: 'ofat' });
  const o = parseBody(body);
  assert(Buffer.byteLength(body, 'utf8') < 256 * 1024, '绝不能超过微信的 256KB 上限');
  eq(o.partial, true);
  eq(Object.keys(o.shards).length, 0, '宁可不预拉取，也不能截断 core');
});

await test('未知分片键与坏 rev 被忽略', async () => {
  const db = createMockDb();
  seedAccount(db, 'u_k', 'ok');
  seedDoc(db, 'u_k', 'core', 1, { goals: [], notes: {}, settings: {} });
  seedDoc(db, 'u_k', 'hack:evil', 5, { items: [] });
  seedDoc(db, 'u_k', 'logs:2026-13', 2, { items: [] });

  const o = parseBody(await PF.build(ctxOf(db, ''), { openId: 'ok' }));
  eq(Object.keys(o.shards).join(','), 'core');
});

/* ================================================================= */

group('预拉取客户端 · 解析与降级');

const PFClient = require(path.join(MP, 'utils', 'prefetch.js'));

await test('正常字符串可解析；坏 JSON / 版本不对 / 空分片一律返回 null', () => {
  const good = JSON.stringify({
    v: 1, at: NOW, userId: 'u_a', partial: false,
    shards: { core: { rev: 2, payload: { goals: [] } } }
  });
  const p = PFClient.parse(good);
  assert(p, '正常载荷应解析成功');
  eq(p.userId, 'u_a');
  eq(p.shards.core.rev, 2);

  eq(PFClient.parse('not-json'), null);
  eq(PFClient.parse(JSON.stringify({ v: 2, userId: 'u_a', shards: { core: { rev: 1, payload: {} } } })), null);
  eq(PFClient.parse(JSON.stringify({ v: 1, userId: '', shards: {} })), null);
  eq(PFClient.parse(JSON.stringify({ v: 1, userId: 'u_a', shards: {} })), null);
  eq(PFClient.parse(JSON.stringify({ v: 1, userId: 'u_a', shards: { hack: { rev: 1, payload: {} } } })), null);
});

await test('微信没有缓存时 read() 安静返回 null', async () => {
  const env = installWxEnv({ db: createMockDb(), openid: 'oa' });
  env.prefetchData = null;
  const r = await PFClient.read();
  eq(r, null);
});

await test('有缓存时 read() 返回解析后的载荷', async () => {
  const env = installWxEnv({ db: createMockDb(), openid: 'oa' });
  env.prefetchData = JSON.stringify({
    v: 1, at: NOW, userId: 'u_a', partial: false,
    shards: { core: { rev: 3, payload: { goals: [] } } }
  });
  const r = await PFClient.read();
  assert(r, '应读到缓存');
  eq(r.shards.core.rev, 3);
});

await test('isFresh：10 分钟内算新，超时或没时间戳算旧', () => {
  eq(PFClient.isFresh({ at: NOW }, NOW + 60 * 1000), true);
  eq(PFClient.isFresh({ at: NOW }, NOW + 11 * 60 * 1000), false);
  eq(PFClient.isFresh({ at: 0 }, NOW), false);
  eq(PFClient.isFresh(null, NOW), false);
});

/* ================================================================= */

group('预拉取客户端 · 采纳与闸门');

/** 每个用例一套全新的模块与存储（store/auth 都是模块级单例） */
function freshRuntime() {
  const utilNames = ['config.js', 'util.js', 'model.js', 'api.js', 'auth.js', 'fork.js', 'prefetch.js', 'store.js'];
  utilNames.forEach((f) => { delete require.cache[require.resolve(path.join(MP, 'utils', f))]; });
  const db = createMockDb();
  const env = installWxEnv({ db: db, openid: 'oa' });
  const mods = {
    env: env,
    db: db,
    auth: require(path.join(MP, 'utils', 'auth.js')),
    store: require(path.join(MP, 'utils', 'store.js')),
    prefetch: require(path.join(MP, 'utils', 'prefetch.js')),
    M: require(path.join(MP, 'utils', 'model.js'))
  };
  return mods;
}

function payloadOf(userId, rev, goals, extra) {
  const o = {
    v: 1, at: NOW, userId: userId, partial: false,
    shards: { core: { rev: rev, payload: { goals: goals || [], notes: {}, settings: { sound: true, volume: 60, theme: 'auto' } } } }
  };
  Object.assign(o, extra || {});
  return o;
}

await test('快照属于当前账号：合并进 state、写入 rev、不标 dirty', async () => {
  const rt = freshRuntime();
  seedAccount(rt.db, 'u_a', 'oa');
  await rt.auth.login();
  rt.store.load();

  const goal = { id: 'g9', name: '背单词', unit: '个', total: 10, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1', deleted: false, updatedAt: NOW };
  const r = rt.store.applyPrefetched(payloadOf('u_a', 5, [goal]));

  eq(r.applied, 1);
  eq(rt.store.get().goals.length, 1);
  eq(rt.store.get().goals[0].id, 'g9');
  const shardMeta = JSON.parse(rt.env.storage.get('lgt.shards.v1'));
  eq(shardMeta.core.rev, 5);
  eq(shardMeta.core.dirty, false, '云端来的快照不该被当成待推送');
});

await test('冷启动时序：restore 还没跑（内存态无账号）也能按本机缓存采纳', async () => {
  const rt = freshRuntime();
  // 只写本机身份缓存，不调用 auth.login / restore —— 复刻 app.onLaunch 的真实顺序
  rt.env.storage.set('lgt.wxuser.v1', JSON.stringify({ user: { id: 'u_a', nickname: '' } }));
  rt.store.load();

  const goal = { id: 'g7', name: '错题', unit: '道', total: 5, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1', deleted: false, updatedAt: NOW };
  const r = rt.store.applyPrefetched(payloadOf('u_a', 8, [goal]));
  eq(r.applied, 1, '应回退读本机缓存的 user 来认账号');
  eq(rt.store.get().goals[0].id, 'g7');
});

await test('快照不属于当前账号（换微信号）时整份丢弃', async () => {
  const rt = freshRuntime();
  seedAccount(rt.db, 'u_a', 'oa');
  await rt.auth.login();
  rt.store.load();

  const r = rt.store.applyPrefetched(payloadOf('u_other', 5, [{ id: 'leak', name: 'x', unit: '个', total: 1, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1' }]));
  eq(r.applied, 0);
  eq(r.reason, 'other-account');
  eq(rt.store.get().goals.length, 0);
});

await test('本机有未推送改动时，快照不得覆盖该分片', async () => {
  const rt = freshRuntime();
  seedAccount(rt.db, 'u_a', 'oa');
  await rt.auth.login();
  rt.store.load();

  rt.store.addGoal({ id: 'local1', name: '本机目标', unit: '个', total: 3, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1' });
  const before = JSON.parse(rt.env.storage.get('lgt.shards.v1'));
  eq(before.core.dirty, true);

  // 云端 rev 更大，但本机这一份还没推上去 → 跳过，等 push 的 CAS 去收敛
  const r = rt.store.applyPrefetched(payloadOf('u_a', 99, []));
  eq(r.applied, 0);
  eq(rt.store.get().goals.length, 1);
  eq(rt.store.get().goals[0].id, 'local1');
  const after = JSON.parse(rt.env.storage.get('lgt.shards.v1'));
  eq(after.core.rev, 0, 'rev 不该被快照抬高');
  eq(after.core.dirty, true);
});

await test('rev 不比本机新的分片被忽略；坏载荷安静退化为 0', async () => {
  const rt = freshRuntime();
  seedAccount(rt.db, 'u_a', 'oa');
  await rt.auth.login();
  rt.store.load();

  eq(rt.store.applyPrefetched(payloadOf('u_a', 5, [])).applied, 1);
  eq(rt.store.applyPrefetched(payloadOf('u_a', 4, [])).applied, 0);
  eq(rt.store.applyPrefetched(null).applied, 0);
  eq(rt.store.applyPrefetched({ v: 1, userId: 'u_a', shards: { core: { rev: 9, payload: null } } }).applied, 0);
});

await test('快照新鲜时登录后跳过全量 pull，只推真正脏的分片', async () => {
  const rt = freshRuntime();
  seedAccount(rt.db, 'u_a', 'oa');
  await rt.auth.login();
  rt.store.load();

  const goal = { id: 'g1', name: '背单词', unit: '个', total: 10, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1', deleted: false, updatedAt: NOW };
  rt.store.applyPrefetched(payloadOf('u_a', 2, [goal]));

  const before = rt.env.callCount.sync;
  await rt.store.onLoggedIn({ skipPull: true });
  eq(rt.env.callCount.sync, before, '不该再发 sync.pull（快照已经是云端最新）');
  eq(rt.store.get().goals.length, 1);
});

await test('app 启动顺序（集成）：先采纳快照 → 再恢复会话 → 跳过全量 pull', async () => {
  const rt = freshRuntime();
  seedAccount(rt.db, 'u_a', 'oa');
  rt.env.storage.set('lgt.wxuser.v1', JSON.stringify({ user: { id: 'u_a', nickname: '' } }));

  const goal = { id: 'g-app', name: '预拉取目标', unit: '个', total: 9, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1', deleted: false, updatedAt: NOW };
  const body = JSON.stringify({
    v: 1, at: Date.now(), userId: 'u_a', partial: false,
    shards: { core: { rev: 3, payload: { goals: [goal], notes: {}, settings: { sound: true, volume: 60, theme: 'auto' } } } }
  });
  rt.env.prefetchData = body;

  const appPath = path.join(MP, 'app.js');
  delete require.cache[require.resolve(appPath)];
  require(appPath);
  const app = rt.env.appOptions;
  assert(app && app.boot, 'app.js 应导出 boot()');

  app.onLaunch({});
  await app.globalData.bootPromise;

  eq(rt.store.get().goals.length, 1, '首屏数据应来自预拉取快照');
  eq(rt.store.get().goals[0].id, 'g-app');
  eq(rt.env.callCount.sync, 0, '快照新鲜时不应再发 sync 调用');
});

await test('快照过期路径：没有 skipPull 时仍然照常全量拉取', async () => {
  const rt = freshRuntime();
  seedAccount(rt.db, 'u_a', 'oa');
  await rt.auth.login();
  rt.store.load();

  const before = rt.env.callCount.sync;
  await rt.store.onLoggedIn();
  assert(rt.env.callCount.sync > before, '常规登录必须 pull 一次');
});
