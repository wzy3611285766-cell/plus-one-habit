/**
 * 任务暂停测试。
 *
 * 暂停最容易做错的地方是「语义」，而不是存储：
 *   · 暂停期到底算不算漏打？算的话连续天数一恢复就断，用户不会再用；
 *   · 恢复那天算不算打卡日？不算的话，用户想打卡会发现目标不见了；
 *   · 暂停中的目标该不该出现在今日清单 / 建议量 / 周报里？都不该。
 * 下面按这四条来断言。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { installWxEnv } from './mock/wx.mjs';
import { group, test, assert, eq, deepEq } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* store 在调用时才访问 wx，所以先装环境再 require */
installWxEnv({ openid: 'openid-pause-test' });

const require = createRequire(import.meta.url);
const M = require(path.join(HERE, '..', 'miniprogram', 'utils', 'model.js'));
const U = require(path.join(HERE, '..', 'miniprogram', 'utils', 'util.js'));
const store = require(path.join(HERE, '..', 'miniprogram', 'utils', 'store.js'));
const SH = require(path.join(HERE, '..', 'cloudfunctions', 'sync', 'lib', 'shard.js'));

const TODAY = U.todayStr();

function mg(over) {
  return M.normalizeGoal(Object.assign({
    id: 'g1', name: '背单词', unit: '个', total: 100,
    deadline: U.addDays(TODAY, 30), createdAt: U.addDays(TODAY, -30),
    color: '#6366f1'
  }, over));
}

function log(gid, date, amount) {
  return {
    id: 'l-' + gid + '-' + date, goalId: gid, date: date,
    amount: amount == null ? 1 : amount, minutes: null,
    makeup: false, ts: 1, updatedAt: 1
  };
}

group('任务暂停（语义：不要求，而不是禁止）');

await test('区间清洗：坏区间丢弃、按开始日排序、开区间保留', () => {
  const g = mg({
    pauses: [
      { f: '2026-11-05', t: '' },
      { f: '2026-11-01', t: '2026-11-03' },
      { f: '2026-11-09', t: '2026-11-08' },   // 结束早于开始
      { f: 'bad', t: '' }
    ]
  });
  deepEq(g.pauses, [
    { f: '2026-11-01', t: '2026-11-03' },
    { f: '2026-11-05', t: '' }
  ]);
});

await test('重叠的暂停区间被合并，不会重复计算天数', () => {
  const a = mg({ pauses: [{ f: '2026-11-01', t: '2026-11-05' }, { f: '2026-11-03', t: '2026-11-08' }] });
  deepEq(a.pauses, [{ f: '2026-11-01', t: '2026-11-08' }], '两段闭区间应合并成一段');

  const b = mg({ pauses: [{ f: '2026-11-01', t: '2026-11-05' }, { f: '2026-11-04', t: '' }] });
  deepEq(b.pauses, [{ f: '2026-11-01', t: '' }], '后一段没结束，整体应变成开区间');

  const c = mg({ pauses: [{ f: '2026-11-01', t: '2026-11-02' }, { f: '2026-11-05', t: '2026-11-06' }] });
  eq(c.pauses.length, 2, '不重叠的两段必须保留');
});

await test('isPausedOn：开始日与结束日都算暂停，恢复当天不算', () => {
  const g = mg({ pauses: [{ f: '2026-11-01', t: '2026-11-03' }, { f: '2026-11-05', t: '' }] });
  eq(M.isPausedOn(g, '2026-10-31'), false);
  eq(M.isPausedOn(g, '2026-11-01'), true);
  eq(M.isPausedOn(g, '2026-11-03'), true);
  eq(M.isPausedOn(g, '2026-11-04'), false);
  eq(M.isPausedOn(g, '2026-11-05'), true);
  eq(M.isPausedOn(g, '2027-01-01'), true);
  eq(M.isPaused(g), true);
  eq(M.pausedSince(g), '2026-11-05');
});

await test('连续天数穿过暂停期，不会一恢复就断', () => {
  const st = M.blankState();
  st.goals.push(mg({
    createdAt: U.addDays(TODAY, -12),
    pauses: [{ f: U.addDays(TODAY, -4), t: '' }]
  }));
  for (let i = 8; i >= 5; i--) st.logs.push(log('g1', U.addDays(TODAY, -i)));
  /* 暂停从今天前 4 天开始：今天到前 4 天都跳过，接着数前 5~8 天的 4 条 */
  eq(M.streak(st, 'g1'), 4);
});

await test('暂停中不排每日建议量，也不写配额快照', () => {
  const st = M.blankState();
  const g = mg({ pauses: [{ f: TODAY, t: '' }] });
  st.goals.push(g);
  const q = M.dailyQuota(st, g, { today: TODAY });
  eq(q.status, 'paused');
  eq(q.quota, 0);
  eq(st.snapshots[M.dayQuotaKey('g1', TODAY)], undefined);
});

await test('今日总览与运行中目标都排除暂停项', () => {
  const st = M.blankState();
  st.goals.push(mg({ id: 'g1', name: '背单词' }));
  st.goals.push(mg({ id: 'g2', name: '阅读', pauses: [{ f: TODAY, t: '' }] }));

  const ov = M.todayOverview(st);
  eq(ov.rows.length, 1);
  eq(ov.rows[0].goal.id, 'g1');
  eq(M.runningGoals(st).length, 1);
  eq(M.activeGoals(st).length, 2, '暂停不等于删除，目标仍在');
});

await test('预计完成日在暂停时返回 paused，而不是编一个「拖后」', () => {
  const st = M.blankState();
  const g = mg({ pauses: [{ f: TODAY, t: '' }] });
  st.goals.push(g);
  eq(M.eta(st, g).status, 'paused');
});

await test('暂停后今日页不再提示漏卡', () => {
  const st = M.blankState();
  const g = mg({ createdAt: U.addDays(TODAY, -6), pauses: [{ f: TODAY, t: '' }] });
  st.goals.push(g);
  /* 前 6 天一条记录都没有：如果暂停不算「已放下」，这里会被算成漏卡 */
  eq(M.streak(st, 'g1'), 0);
  eq(M.isTodayMet(st, g), false);
  eq(M.todayOverview(st).rows.length, 0);
});

await test('暂停期不产生欠账：恢复当天不会要求一次补完', () => {
  const st = M.blankState();
  const g = mg({
    total: 30,
    createdAt: U.addDays(TODAY, -20),
    deadline: U.addDays(TODAY, 10),
    pauses: [{ f: U.addDays(TODAY, -10), t: U.addDays(TODAY, -1) }]
  });
  st.goals.push(g);
  const q = M.dailyQuota(st, g, { today: TODAY });
  /* 31 天做 30 个 → 每天 1 个。暂停 10 天、活跃 11 天，欠 11 个、剩 11 天 → 仍是 1 个。
     如果把暂停期算进「应完成量」，这里会变成 2 个/天（恢复当天就被追债）。 */
  eq(q.quota, 1);
});

group('任务暂停（写入 / 恢复的边界）');

await test('暂停写入开区间，恢复把结束日补成昨天', () => {
  const st = M.blankState();
  st.goals.push(mg({ pauses: undefined }));
  store.replaceAll(st);

  store.pauseGoal('g1', U.addDays(TODAY, -3));
  const paused = store.get().goals[0];
  eq(paused.pauses.length, 1);
  eq(paused.pauses[0].f, U.addDays(TODAY, -3));
  eq(paused.pauses[0].t, '');
  eq(M.isPaused(paused), true);

  store.resumeGoal('g1', TODAY);
  const after = store.get().goals[0];
  eq(M.isPaused(after), false);
  eq(after.pauses[0].t, U.addDays(TODAY, -1));
  eq(M.isPausedOn(after, U.addDays(TODAY, -2)), true);
  eq(M.isPausedOn(after, TODAY), false, '恢复当天就算正常打卡日');
});

await test('当天暂停又当天恢复：不留下空区间', () => {
  const st = M.blankState();
  st.goals.push(mg({ pauses: undefined }));
  store.replaceAll(st);

  store.pauseGoal('g1', TODAY);
  store.resumeGoal('g1', TODAY);
  eq(store.get().goals[0].pauses, undefined);
});

await test('已完成的目标不能再暂停', () => {
  const st = M.blankState();
  st.goals.push(mg({ total: 1 }));
  st.logs.push(log('g1', TODAY, 1));
  store.replaceAll(st);

  eq(store.pauseGoal('g1', TODAY), null);
  eq(store.get().goals[0].pauses, undefined, '不应写入任何暂停区间');
});

await test('重复暂停是幂等的，不会叠出两段', () => {
  const st = M.blankState();
  st.goals.push(mg({ pauses: undefined }));
  store.replaceAll(st);

  store.pauseGoal('g1', U.addDays(TODAY, -2));
  store.pauseGoal('g1', TODAY);
  eq(store.get().goals[0].pauses.length, 1);
});

await test('恢复后重新开始排建议量', () => {
  const st = M.blankState();
  const g = mg({ createdAt: U.addDays(TODAY, -10), pauses: [{ f: U.addDays(TODAY, -3), t: U.addDays(TODAY, -1) }] });
  st.goals.push(g);
  const q = M.dailyQuota(st, g, { today: TODAY });
  assert(q.status !== 'paused', '恢复当天应回到正常配额');
  assert(q.quota >= 1, '应给出至少 1 的建议量');
});

group('任务暂停（跨设备同步）');

await test('云端 goal 白名单保留暂停区间，坏区间丢弃', () => {
  const payload = SH.sanitizeShard('core', {
    goals: [{
      id: 'g1', name: '背单词', unit: '个', total: 100,
      deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1',
      pauses: [
        { f: '2026-11-01', t: '' },
        { f: '2026-11-09', t: '2026-11-08' },
        { f: 'bad', t: '' }
      ]
    }],
    notes: {},
    settings: {}
  });
  eq(payload.goals.length, 1);
  deepEq(payload.goals[0].pauses, [{ f: '2026-11-01', t: '' }],
    '暂停状态必须能同步到另一台设备，否则那边会重新按漏卡计算');
});

group('任务暂停（持久化：重启 / 旧客户端回写）');

await test('暂停态落盘后重新解析仍在（冷启动不丢暂停）', () => {
  const st = M.blankState();
  st.goals.push(mg({ pauses: undefined }));
  store.replaceAll(st);
  store.pauseGoal('g1', TODAY);

  /* load() 走的就是这条路：storage 里的 JSON → parseState。
     以前这里没有用例，暂停是否「过夜还在」全靠运气。 */
  const saved = M.parseState(JSON.parse(JSON.stringify(store.get()))).state;
  eq(M.isPaused(saved.goals[0]), true, '重新载入后仍应是暂停中');
  eq(M.todayOverview(saved).rows.length, 0, '暂停目标不该回到今日待办');
});

await test('同时间戳时，旧客户端丢掉 pauses 的那一份不能赢', () => {
  const local = mg({ pauses: [{ f: TODAY, t: '' }], updatedAt: 1000 });
  /* 旧版本客户端不认识 pauses：它把目标原样同步回云端，只少了这个字段，
     updatedAt 一模一样。以前「打平取云端」会把暂停抹掉。 */
  const remote = mg({ pauses: undefined, updatedAt: 1000 });

  eq(M.isPaused(M.mergeGoals([local], [remote])[0]), true,
    '本机按下的暂停不能被旧客户端的回写抹掉');
  eq(M.isPaused(M.mergeGoals([remote], [local])[0]), true,
    '反过来合并也必须得到同一结果（收敛性不能破）');
});

await test('恢复过的区间不会因为合并被判回暂停', () => {
  /* 恢复是一次真实的写入（updatedAt 更新），LWW 必须让新的那份赢 */
  const resumed = mg({ pauses: [{ f: U.addDays(TODAY, -3), t: U.addDays(TODAY, -1) }], updatedAt: 2000 });
  const paused = mg({ pauses: [{ f: U.addDays(TODAY, -3), t: '' }], updatedAt: 1000 });

  eq(M.isPaused(M.mergeGoals([paused], [resumed])[0]), false, '恢复晚于暂停，应以恢复为准');
});
