/**
 * 微信一键登录（跑在内存数据库上）。
 *
 * 覆盖的是这个身份模型的全部承诺：
 *   同一个微信永远是同一个账号 / 不同微信互不可见 / 第一次自动建号 /
 *   没有 openid 一律拒绝 / 停用账号被拦下 / 对外不泄露 openid。
 *
 * 这里刻意不再有密码、验证码、会话、锁定的用例 —— 那些机制已经整体删除了。
 * 如果哪天有人把它们加回来，应该同时补回对应用例，而不是留着空壳。
 */

import { createRequire } from 'node:module';
import { createMockDb } from './mock/db.mjs';
import { group, test, assert, eq, rejectsWithCode } from './harness.mjs';

const require = createRequire(import.meta.url);
const { repo } = require('../cloudfunctions/auth/lib/repo.js');
const service = require('../cloudfunctions/auth/lib/service.js');

const CLOCK = { now: Date.UTC(2026, 9, 21, 4, 0, 0) };
const db = createMockDb();

function ctxOf(openid) {
  return {
    repo: repo(db),
    now: CLOCK.now,
    openid: openid || '',
    unionid: ''
  };
}

function call(action, payload, openid) {
  return service.handle(ctxOf(openid), action, payload);
}

function accountsOf(openid) {
  return db.dump('accounts').filter((a) => a.openid === openid);
}

/* ================================================================= */

group('一键登录');

await test('第一次登录自动建号，并标记 isNewAccount', async () => {
  const r = await call('login', {}, 'openid-alice');
  assert(r.user && r.user.id, '应返回用户 id');
  eq(r.isNewAccount, true, '第一次应标记为新账号');
  eq(r.user.nickname, '', '新账号昵称默认为空');
  eq(accountsOf('openid-alice').length, 1, '库里应恰好有一条账号');
});

await test('同一个微信再次登录复用同一个账号', async () => {
  const first = accountsOf('openid-alice')[0];
  const r = await call('login', {}, 'openid-alice');
  eq(r.isNewAccount, false, '第二次不该再建号');
  eq(r.user.id, first._id, '应命中同一个账号');
  eq(accountsOf('openid-alice').length, 1, '不得重复建号');
});

await test('不同微信是不同账号，互相看不到', async () => {
  const a = (await call('login', {}, 'openid-alice')).user;
  const b = (await call('login', {}, 'openid-bob')).user;
  assert(a.id !== b.id, '两个微信号必须是两个账号');
  eq(accountsOf('openid-bob').length, 1);
});

await test('拿不到 openid 时拒绝登录（不能在非小程序环境调用）', async () => {
  await rejectsWithCode(() => call('login', {}, ''), 'OPENID_MISSING');
});

await test('对外不泄露 openid：用户信息里只有自己的 id', async () => {
  const r = await call('login', {}, 'openid-alice');
  const keys = Object.keys(r.user);
  assert(keys.indexOf('openid') < 0, '不能把 openid 返回给客户端');
  assert(keys.indexOf('_openid') < 0, '不能返回 _openid');
  assert(keys.indexOf('unionid') < 0, '不能返回 unionid');
});

/* ================================================================= */

group('账号状态');

await test('账号被停用后无法登录', async () => {
  await call('login', {}, 'openid-disabled');
  const acc = accountsOf('openid-disabled')[0];
  await repo(db).updateAccount(acc._id, { status: 'disabled' });
  await rejectsWithCode(() => call('login', {}, 'openid-disabled'), 'ACCOUNT_DISABLED');
});

await test('停用的账号也读不到自己的资料', async () => {
  await rejectsWithCode(() => call('me', {}, 'openid-disabled'), 'ACCOUNT_DISABLED');
});

/* ================================================================= */

group('资料');

await test('me 返回当前微信的账号；没建过号则报 NOT_REGISTERED', async () => {
  const r = await call('me', {}, 'openid-alice');
  eq(r.user.id, accountsOf('openid-alice')[0]._id);
  await rejectsWithCode(() => call('me', {}, 'openid-never-seen'), 'NOT_REGISTERED');
});

await test('更新昵称', async () => {
  await call('login', {}, 'openid-nick');
  const r = await call('updateProfile', { nickname: '  小明  ' }, 'openid-nick');
  eq(r.user.nickname, '小明', '首尾空白应被去掉');
  eq((await call('me', {}, 'openid-nick')).user.nickname, '小明', '应已落库');
});

await test('昵称超长会被截断，不会把数据库撑大', async () => {
  const long = '很长的昵称'.repeat(20);
  const r = await call('updateProfile', { nickname: long }, 'openid-nick');
  assert(Array.from(r.user.nickname).length <= 24, '昵称应截断到 24 字以内，实际 ' + Array.from(r.user.nickname).length);
});

await test('空更新被拒绝', async () => {
  await rejectsWithCode(() => call('updateProfile', {}, 'openid-nick'), 'INVALID_INPUT');
});

await test('没登录过的微信改不了资料', async () => {
  await rejectsWithCode(() => call('updateProfile', { nickname: 'x' }, 'openid-never-seen'), 'NOT_REGISTERED');
  await rejectsWithCode(() => call('updateProfile', { nickname: 'x' }, ''), 'OPENID_MISSING');
});

/* ================================================================= */

group('注销账号');

await test('没有确认词不能注销（大小写也不放过）', async () => {
  await call('login', {}, 'openid-bye');
  await rejectsWithCode(() => call('deleteAccount', {}, 'openid-bye'), 'INVALID_INPUT');
  await rejectsWithCode(() => call('deleteAccount', { confirm: 'delete' }, 'openid-bye'), 'INVALID_INPUT');
  eq(accountsOf('openid-bye').length, 1, '账号不该被删');
});

let deletedAccountId = '';

await test('注销会同时删掉账号与它的全部同步分片', async () => {
  const acc = accountsOf('openid-bye')[0];
  deletedAccountId = acc._id;
  await db.collection('sync_docs').add({ data: { userId: acc._id, key: 'core', rev: 1, payload: {} } });
  await db.collection('sync_docs').add({ data: { userId: acc._id, key: 'logs:2026-10', rev: 1, payload: {} } });

  const r = await call('deleteAccount', { confirm: 'DELETE' }, 'openid-bye');

  eq(r.deleted, true);
  eq(r.removedShards, 2, '应删掉两份分片');
  eq(accountsOf('openid-bye').length, 0, '账号应已删除');
  eq(db.dump('sync_docs').filter((d) => d.userId === acc._id).length, 0, '云端分片应已清空');
});

await test('注销后再来一次：报 NOT_REGISTERED，而不是静默成功', async () => {
  await rejectsWithCode(() => call('deleteAccount', { confirm: 'DELETE' }, 'openid-bye'), 'NOT_REGISTERED');
  await rejectsWithCode(() => call('me', {}, 'openid-bye'), 'NOT_REGISTERED');
});

await test('注销只影响自己，别的微信的账号还在', async () => {
  eq(accountsOf('openid-alice').length, 1, 'alice 的账号不该被牵连');
});

await test('注销后同一个微信再登录，是一个全新的空账号', async () => {
  const r = await call('login', {}, 'openid-bye');
  eq(r.isNewAccount, true, '应重新建号');
  assert(r.user.id !== deletedAccountId, '不应复用被删掉的账号 id');
  eq(r.user.nickname, '', '新账号不该带旧资料');
});

/* ================================================================= */

group('分发与健康检查');

await test('未知 action 被拒绝', async () => {
  await rejectsWithCode(() => call('dropTable', {}, 'openid-alice'), 'INVALID_INPUT');
});

await test('ping 能报告是否拿到了微信身份', async () => {
  const r = await call('ping', {}, 'openid-alice');
  eq(r.pong, true);
  eq(r.hasOpenid, true);
  const noOpenid = await call('ping', {}, '');
  eq(noOpenid.hasOpenid, false, '没有 openid 时应如实报告');
});

await test('账号里只有身份字段，没有任何密码类字段', async () => {
  const acc = accountsOf('openid-alice')[0];
  ['passwordHash', 'passwordSalt', 'passwordAlgoTag', 'email', 'phone', 'failCount', 'lockedUntil']
    .forEach((k) => {
      assert(!(k in acc), '账号文档不应再有 ' + k + ' 字段');
    });
});

export const suite = '微信一键登录';
