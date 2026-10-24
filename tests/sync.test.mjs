/**
 * 打卡数据多设备同步测试。
 *
 * 这里验的不是「接口通不通」，而是三件用户真正在意的事：
 *   1. 隔离   —— 我的打卡记录，别的账号一条都拿不到；
 *   2. 不丢   —— 两台设备各自打卡后，两边的记录最终都在；
 *   3. 收敛   —— 并发写入冲突后，两台设备最终算出完全相同的状态。
 */

import { createRequire } from 'node:module';
import { createMockDb } from './mock/db.mjs';
import { group, test, assert, eq, deepEq, rejectsWithCode } from './harness.mjs';

const require = createRequire(import.meta.url);
const { repo: authRepo } = require('../cloudfunctions/auth/lib/repo.js');
const authService = require('../cloudfunctions/auth/lib/service.js');
const { repo: syncRepo } = require('../cloudfunctions/sync/lib/repo.js');
const syncService = require('../cloudfunctions/sync/lib/service.js');

process.env.AUTH_DEV_MODE = '1';

const CLOCK = { now: Date.UTC(2026, 9, 13, 4, 0, 0) };
const db = createMockDb();

function authCtx(opts) {
  const o = opts || {};
  return {
    repo: authRepo(db),
    now: CLOCK.now,
    openid: o.openid || '',
    unionid: '',
    source: o.openid || '127.0.0.1'
  };
}

function syncCtx(opts) {
  const o = opts || {};
  return {
    repo: syncRepo(db),
    now: CLOCK.now,
    openid: o.openid || '',
    unionid: '',
    source: o.openid || '127.0.0.1'
  };
}

const AUTH = (action, payload, opts) => authService.handle(authCtx(opts), action, payload);

/**
 * sync 的每个动作都靠「当前微信的 openid」认身份，客户端不再传令牌。
 * 为了让下面的用例读起来仍然像「设备 1 / 设备 2 在做事」，
 * 这里保留 token 这个字段名，但它的值已经是 openid。
 */
const SYNC = (action, payload, opts) => {
  const p = Object.assign({}, payload);
  const openid = (opts && opts.openid) || p.token || '';
  delete p.token;
  return syncService.handle(syncCtx({ openid }), action, p);
};

/* ---------- 造两个微信、四台设备（同一微信两台设备） ---------- */

await AUTH('login', {}, { openid: 'openid-owner' });
await AUTH('login', {}, { openid: 'openid-other' });

const T_A1 = 'openid-owner';     // 账号 A · 设备 1
const T_A2 = 'openid-owner';     // 账号 A · 设备 2（同一个微信）
const T_B1 = 'openid-other';     // 账号 B · 设备 1

/* ---------- 构造数据分片 ---------- */

function goal(id, name, updatedAt) {
  return {
    id: id, name: name, unit: '个', total: 100, deadline: '2026-12-31',
    createdAt: '2026-10-01', color: '#6366f1', obstacle: '', plan: '',
    sample: false, updatedAt: updatedAt
  };
}

function log(id, goalId, date, amount, updatedAt) {
  return { id: id, goalId: goalId, date: date, amount: amount, minutes: null, makeup: false, ts: 1, updatedAt: updatedAt };
}

function corePayload(goals, notes, settingsUpdatedAt) {
  return {
    goals: goals,
    notes: notes || {},
    settings: { sound: true, volume: 80, theme: 'auto', updatedAt: settingsUpdatedAt || 1 }
  };
}

/* ================================================================= */

group('推送与拉取');

await test('首次推送 core 分片：云端版本号从 1 开始', async () => {
  const r = await SYNC('push', {
    token: T_A1,
    deviceId: 'phone-a',
    docs: [{ key: 'core', baseRev: 0, payload: corePayload([goal('g1', '背单词', 100)], {}, 100) }]
  });
  eq(r.applied.length, 1);
  eq(r.applied[0].key, 'core');
  eq(r.applied[0].rev, 1);
  eq(r.conflicts.length, 0);
});

await test('全量拉取能拿回刚刚推上去的分片', async () => {
  const r = await SYNC('pull', { token: T_A2, known: {} });
  eq(r.docs.length, 1);
  eq(r.docs[0].key, 'core');
  eq(r.docs[0].rev, 1);
  eq(r.docs[0].payload.goals[0].name, '背单词');
});

await test('增量拉取：本机版本号与云端一致时不重复下发', async () => {
  const r = await SYNC('pull', { token: T_A2, known: { core: 1 } });
  eq(r.docs.length, 0, '无变化时不应回传数据');
});

await test('一次推送多个分片（core + 两个月份）', async () => {
  const r = await SYNC('push', {
    token: T_A1,
    deviceId: 'phone-a',
    docs: [
      { key: 'core', baseRev: 1, payload: corePayload([goal('g1', '背单词', 200)], {}, 200) },
      { key: 'logs:2026-10', baseRev: 0, payload: { items: [log('l1', 'g1', '2026-10-13', 30, 200)] } },
      { key: 'logs:2026-09', baseRev: 0, payload: { items: [log('l0', 'g1', '2026-09-30', 20, 200)] } }
    ]
  });
  eq(r.applied.length, 3);
  eq(r.conflicts.length, 0);
  eq(r.applied.find((a) => a.key === 'core').rev, 2);
  eq(r.applied.find((a) => a.key === 'logs:2026-10').rev, 1);
});

await test('只回传发生变化的分片（增量同步的关键）', async () => {
  const r = await SYNC('pull', { token: T_A2, known: { core: 2, 'logs:2026-10': 1 } });
  eq(r.docs.length, 1, '只有 9 月分片是新的');
  eq(r.docs[0].key, 'logs:2026-09');
});

group('并发冲突与收敛');

await test('两台设备带同一个 baseRev 推送：先到的成功，后到的收到冲突', async () => {
  // 设备 1 先写
  const r1 = await SYNC('push', {
    token: T_A1,
    deviceId: 'phone-a',
    docs: [{ key: 'core', baseRev: 2, payload: corePayload([goal('g1', '背单词', 300), goal('g2', '设备1新增', 300)], {}, 300) }]
  });
  eq(r1.applied[0].rev, 3);
  eq(r1.conflicts.length, 0);

  // 设备 2 拿着一份已经过期的 baseRev
  const r2 = await SYNC('push', {
    token: T_A2,
    deviceId: 'pad-b',
    docs: [{ key: 'core', baseRev: 2, payload: corePayload([goal('g1', '背单词', 301), goal('g3', '设备2新增', 301)], {}, 301) }]
  });
  eq(r2.applied.length, 0);
  eq(r2.conflicts.length, 1);
  eq(r2.conflicts[0].rev, 3, '冲突时应回传服务端当前版本号');
  eq(r2.conflicts[0].payload.goals.length, 2, '并回传服务端的权威数据供客户端合并');
});

await test('客户端合并冲突数据后重推即可成功', async () => {
  const serverPayload = (await SYNC('pull', { token: T_A2, known: {} })).docs.find((d) => d.key === 'core').payload;
  // 模拟客户端 mergeGoals：按 id 取 updatedAt 更大的一份，并集
  const merged = {};
  serverPayload.goals.concat([goal('g1', '背单词', 301), goal('g3', '设备2新增', 301)]).forEach((g) => {
    if (!merged[g.id] || merged[g.id].updatedAt < g.updatedAt) merged[g.id] = g;
  });

  const r = await SYNC('push', {
    token: T_A2,
    deviceId: 'pad-b',
    docs: [{ key: 'core', baseRev: 3, payload: corePayload(Object.keys(merged).map((k) => merged[k]), {}, 302) }]
  });
  eq(r.applied[0].rev, 4);
  eq(r.conflicts.length, 0);

  const final = (await SYNC('pull', { token: T_A1, known: {} })).docs.find((d) => d.key === 'core').payload;
  eq(final.goals.length, 3, '两台设备各自新增的目标都应保留下来');
});

await test('打卡记录按 id 并集，两台设备分别打卡都不丢', async () => {
  await SYNC('push', {
    token: T_A1, deviceId: 'phone-a',
    docs: [{ key: 'logs:2026-10', baseRev: 1, payload: { items: [log('l1', 'g1', '2026-10-13', 30, 200), log('l2', 'g1', '2026-10-13', 10, 400)] } }]
  });

  // 注意：known 里只声明了 10 月分片，所以 core 也会被一起回传，
  // 必须按 key 精确取，不能拿 docs[0]
  const pulled = (await SYNC('pull', { token: T_A2, known: { 'logs:2026-10': 1 } })).docs;
  const remote = pulled.find((d) => d.key === 'logs:2026-10');
  assert(remote, '应能拉到 10 月分片');
  const union = {};
  remote.payload.items.concat([log('l3', 'g1', '2026-10-13', 5, 500)]).forEach((l) => { union[l.id] = l; });

  const r = await SYNC('push', {
    token: T_A2, deviceId: 'pad-b',
    docs: [{ key: 'logs:2026-10', baseRev: remote.rev, payload: { items: Object.keys(union).map((k) => union[k]) } }]
  });
  eq(r.applied.length, 1);

  const final = (await SYNC('pull', { token: T_A1, known: {} })).docs.find((d) => d.key === 'logs:2026-10').payload;
  eq(final.items.length, 3, '三台设备视角的记录应合成 3 条');
  eq(final.items.filter((l) => l.goalId === 'g1').reduce((s, l) => s + l.amount, 0), 45);
});

group('账号隔离与越权');

await test('B 账号拉不到 A 账号的任何数据', async () => {
  const r = await SYNC('pull', { token: T_B1, known: {} });
  eq(r.docs.length, 0, '新账号的云端应为空');
});

await test('B 账号推送自己的一份，不影响 A 账号', async () => {
  await SYNC('push', {
    token: T_B1, deviceId: 'pad-b',
    docs: [{ key: 'core', baseRev: 0, payload: corePayload([goal('bx1', 'B的目标', 900)], {}, 900) }]
  });
  const a = (await SYNC('pull', { token: T_A1, known: {} })).docs;
  const b = (await SYNC('pull', { token: T_B1, known: {} })).docs;
  assert(!a.some((d) => JSON.stringify(d.payload).indexOf('B的目标') >= 0), 'A 不应看到 B 的数据');
  assert(b.some((d) => JSON.stringify(d.payload).indexOf('B的目标') >= 0), 'B 应看到自己的数据');
  eq(a.length, 3, 'A 的分片数不受 B 影响');
});

await test('请求体里伪造 userId 无效：归属只认 openid', async () => {
  const accB = db.dump('accounts').find((a) => a.openid === 'openid-other');
  const accA = db.dump('accounts').find((a) => a.openid === 'openid-owner');

  // B 用 A 的 userId 去拉数据，仍然只能拿到自己的
  const r = await SYNC('pull', { token: T_B1, userId: accA._id, known: {} });
  const blob = JSON.stringify(r.docs);
  assert(blob.indexOf('背单词') < 0, '伪造 userId 不应拿到他人数据');
  eq(r.userId, accB._id, '响应里的 userId 应是会话对应的账号');
});

await test('拿不到微信身份、或这个微信没建过号，一律拒绝', async () => {
  await rejectsWithCode(() => SYNC('pull', { known: {} }), 'OPENID_MISSING');
  await rejectsWithCode(() => SYNC('push', { token: 'openid-never-logged-in', docs: [] }), 'NOT_REGISTERED');
  await rejectsWithCode(() => SYNC('stats', { token: 'openid-never-logged-in' }), 'NOT_REGISTERED');
  await rejectsWithCode(() => SYNC('wipe', { token: 'openid-never-logged-in', confirm: 'DELETE' }), 'NOT_REGISTERED');
});

group('载荷清洗');

await test('未知分片名被拒绝', async () => {
  await rejectsWithCode(
    () => SYNC('push', { token: T_A1, docs: [{ key: 'logs:2026-99', baseRev: 0, payload: {} }] }),
    'INVALID_INPUT'
  );
  await rejectsWithCode(
    () => SYNC('push', { token: T_A1, docs: [{ key: 'accounts', baseRev: 0, payload: {} }] }),
    'INVALID_INPUT'
  );
});

await test('白名单以外的字段会被丢弃，不会污染云端文档', async () => {
  await SYNC('push', {
    token: T_A1, deviceId: 'phone-a',
    docs: [{
      key: 'logs:2026-08', baseRev: 0,
      payload: {
        items: [Object.assign(log('lx', 'g1', '2026-08-01', 10, 1000), { evil: 'x'.repeat(5000), isAdmin: true })],
        extra: { injected: true }
      }
    }]
  });
  const doc = (await SYNC('pull', { token: T_A1, known: {} })).docs.find((d) => d.key === 'logs:2026-08');
  eq(doc.payload.items[0].evil, undefined, '未在白名单里的字段不应被保存');
  eq(doc.payload.items[0].isAdmin, undefined);
  eq(doc.payload.extra, undefined);
});

await test('字段超长会被截断到上限', async () => {
  await SYNC('push', {
    token: T_A1, deviceId: 'phone-a',
    docs: [{ key: 'core', baseRev: 4, payload: corePayload([goal('long', 'x'.repeat(200), 1100)], {}, 1100) }]
  });
  const doc = (await SYNC('pull', { token: T_A1, known: {} })).docs.find((d) => d.key === 'core');
  const g = doc.payload.goals.find((x) => x.id === 'long');
  eq(g.name.length, 30, '目标名应被截断到 30 字');
});

await test('归属月份对不上的打卡记录会被丢弃', async () => {
  await SYNC('push', {
    token: T_A1, deviceId: 'phone-a',
    docs: [{ key: 'logs:2026-07', baseRev: 0, payload: { items: [log('ok7', 'g1', '2026-07-15', 1, 1), log('bad', 'g1', '2026-10-15', 1, 1)] } }]
  });
  const doc = (await SYNC('pull', { token: T_A1, known: {} })).docs.find((d) => d.key === 'logs:2026-07');
  eq(doc.payload.items.length, 1);
  eq(doc.payload.items[0].id, 'ok7');
});

await test('单月记录条数超过上限时会被截断（而不是把账号的数据撑爆）', async () => {
  const many = [];
  for (let i = 0; i < 2500; i++) many.push(log('cap' + i, 'g1', '2026-06-01', 1, 1));
  await SYNC('push', { token: T_A1, docs: [{ key: 'logs:2026-06', baseRev: 0, payload: { items: many } }] });

  const doc = (await SYNC('pull', { token: T_A1, known: {} })).docs.find((d) => d.key === 'logs:2026-06');
  eq(doc.payload.items.length, 2000, '应被截断到单月上限');
});

await test('单次推送总量超过上限时拒绝，并给出明确错误而不是让同步神秘失败', async () => {
  // 攒一批接近单分片上限的月份分片，把总量顶过 2MB
  const dense = [];
  for (let i = 0; i < 2000; i++) dense.push(log('d' + i, 'g1', '2026-05-01', 123.456, 1760000000000));
  const docs = [];
  for (let m = 1; m <= 16; m++) {
    const month = '2025-' + String(m).padStart(2, '0');
    const items = dense.map((l) => Object.assign({}, l, { date: month + '-01' }));
    docs.push({ key: 'logs:' + month, baseRev: 0, payload: { items: items } });
  }
  await rejectsWithCode(() => SYNC('push', { token: T_A1, docs: docs }), 'PAYLOAD_TOO_LARGE');
});

await test('一次推送的分片数有上限', async () => {
  const docs = [];
  for (let i = 0; i < 50; i++) docs.push({ key: 'core', baseRev: 0, payload: corePayload([], {}, 1) });
  await rejectsWithCode(() => SYNC('push', { token: T_A1, docs: docs }), 'PAYLOAD_TOO_LARGE');
});

group('统计与清空');

await test('stats 返回分片数、记录数与占用字节', async () => {
  const r = await SYNC('stats', { token: T_A1 });
  assert(r.shardCount >= 3, '应至少有 3 个分片，实际 ' + r.shardCount);
  assert(r.logs >= 3, '应统计到打卡记录数，实际 ' + r.logs);
  assert(r.bytes > 0, '应统计出占用字节');
  assert(r.lastWriteAt > 0, '应返回最近写入时间');
});

await test('清空云端数据需要显式二次确认', async () => {
  await rejectsWithCode(() => SYNC('wipe', { token: T_A1 }), 'INVALID_INPUT');
  await rejectsWithCode(() => SYNC('wipe', { token: T_A1, confirm: 'yes' }), 'INVALID_INPUT');

  const r = await SYNC('wipe', { token: T_A1, confirm: 'DELETE' });
  assert(r.deleted >= 3, '应删除所有分片');

  const after = await SYNC('pull', { token: T_A1, known: {} });
  eq(after.docs.length, 0);
});

await test('清空只影响自己的账号', async () => {
  const b = await SYNC('pull', { token: T_B1, known: {} });
  eq(b.docs.length, 1, 'B 的数据应完好');
});

await test('云端被清空后客户端重推：baseRev 过旧也能重建', async () => {
  const r = await SYNC('push', {
    token: T_A1, deviceId: 'phone-a',
    docs: [{ key: 'core', baseRev: 4, payload: corePayload([goal('g1', '重建', 2000)], {}, 2000) }]
  });
  eq(r.applied.length, 1, '应直接重建而不是报冲突');
  eq(r.applied[0].rev, 1, '重建后版本号从未有文档的状态重新开始');
});

export const suite = '打卡数据同步';
