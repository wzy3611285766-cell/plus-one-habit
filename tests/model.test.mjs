/**
 * 客户端数据模型测试。
 *
 * 两块内容：
 *   A. 统计口径 —— 必须和 H5 版算出同一个数字（同一份数据迁移过来不能变样）；
 *   B. 合并算法 —— 多设备同步的正确性最终由这里的纯函数保证：
 *      任意两台设备用任意顺序合并，必须收敛到同一份数据。
 *      B 组是整套同步方案里最值得测的部分。
 */

import { createRequire } from 'node:module';
import { group, test, assert, eq, deepEq } from './harness.mjs';

const require = createRequire(import.meta.url);
const M = require('../miniprogram/utils/model.js');
const U = require('../miniprogram/utils/util.js');

/* ================================================================= */

group('数据清洗（parseState）');

await test('完整的合法数据被原样接受', () => {
  const raw = {
    goals: [{ id: 'g1', name: '背单词', unit: '个', total: 100, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1' }],
    logs: [{ id: 'l1', goalId: 'g1', date: '2026-10-13', amount: 20, minutes: 15, makeup: false, ts: 1 }],
    notes: { '2026-10-12': { keep: '不错', problem: '', try: '', next: '' } },
    settings: { sound: false, volume: 50, theme: 'dark' }
  };
  const r = M.parseState(raw);
  eq(r.state.goals.length, 1);
  eq(r.state.logs.length, 1);
  eq(r.state.settings.volume, 50);
  eq(r.dropped.goals, 0);
});

await test('坏数据被丢弃并计数，不影响合法数据', () => {
  const raw = {
    goals: [
      { id: 'g1', name: '好的', unit: '个', total: 10, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1' },
      { id: 'bad id!', name: '非法 id', total: 10, deadline: '2026-12-31' },
      { id: 'g3', name: '总量非法', total: -5, deadline: '2026-12-31' },
      { id: 'g1', name: '重复 id', unit: '个', total: 10, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1' }
    ],
    logs: [
      { id: 'l1', goalId: 'g1', date: '2026-10-13', amount: 5 },
      { id: 'l2', goalId: 'g1', date: '不是日期', amount: 5 }
    ],
    notes: { 'not-a-date': { keep: 'x' } }
  };
  const r = M.parseState(raw);
  eq(r.state.goals.length, 1, '只应保留 1 个合法目标');
  eq(r.state.logs.length, 1);
  eq(r.dropped.goals, 3);
  eq(r.dropped.logs, 1);
  eq(r.dropped.notes, 1);
});

await test('完全无效的输入回退到空白状态而不是抛异常', () => {
  eq(M.parseState(null).state.goals.length, 0);
  eq(M.parseState('字符串').state.goals.length, 0);
  eq(M.parseState(undefined).ok, false);
});

await test('能读入 H5 版本的 state 结构（迁移兼容）', () => {
  const h5 = {
    version: 2, seedVersion: 4,
    goals: [{ id: 'seed-g1', name: '背英语四级单词', unit: '个', total: 1200, deadline: '2026-12-20', createdAt: '2026-09-01', color: '#6366f1', obstacle: '', plan: '', sample: true }],
    logs: [{ id: 'id-abc', goalId: 'seed-g1', date: '2026-10-12', amount: 30, minutes: 25, makeup: false, ts: 1760000000000 }],
    notes: { '2026-10-05': { keep: 'a', problem: 'b', try: 'c', next: 'd' } },
    snapshots: { 'seed-g1|2026-10-12': 18 },
    settings: { sound: true, volume: 100 },
    seeded: true, sampleCleared: false, createdAt: '2026-09-01'
  };
  const r = M.parseState(h5);
  eq(r.state.goals.length, 1);
  eq(r.state.goals[0].id, 'seed-g1');
  eq(r.state.logs[0].amount, 30);
  eq(r.state.snapshots['seed-g1|2026-10-12'], 18);
  eq(r.state.seeded, true);
});

/* ================================================================= */

group('统计口径（与 H5 保持一致）');

function stWith(goals, logs) {
  const st = M.blankState();
  st.goals = goals.map((g) => Object.assign({
    unit: '个', createdAt: '2026-10-01', color: '#6366f1', obstacle: '', plan: '', sample: false, updatedAt: 1
  }, g));
  st.logs = logs.map((l, i) => Object.assign({ minutes: null, makeup: false, ts: i, updatedAt: 1 }, l));
  return st;
}

await test('累计完成量按目标汇总', () => {
  const st = stWith(
    [{ id: 'g1', name: 'A', total: 100, deadline: '2026-12-31' }],
    [{ id: 'l1', goalId: 'g1', date: '2026-10-12', amount: 30 }, { id: 'l2', goalId: 'g1', date: '2026-10-13', amount: 12 }]
  );
  eq(M.doneAmount(st, 'g1'), 42);
  eq(M.logsOn(st, 'g1', '2026-10-13'), 12);
  eq(M.isComplete(st, st.goals[0]), false);
});

await test('删除目标会连带把它的记录标为墓碑，统计随之归零', () => {
  const st = stWith(
    [{ id: 'g1', name: 'A', total: 100, deadline: '2026-12-31' }],
    [{ id: 'l1', goalId: 'g1', date: '2026-10-13', amount: 30 }]
  );
  eq(M.doneAmount(st, 'g1'), 30);
  st.goals[0].deleted = true;
  st.logs[0].deleted = true;
  eq(M.doneAmount(st, 'g1'), 0);
  eq(M.activeGoals(st).length, 0);
});

await test('连续天数：今天没打则从昨天往前数', () => {
  const today = U.todayStr();
  const st = stWith(
    [{ id: 'g1', name: 'A', total: 1000, deadline: U.addDays(today, 100) }],
    [
      { id: 'l1', goalId: 'g1', date: U.addDays(today, -1), amount: 1 },
      { id: 'l2', goalId: 'g1', date: U.addDays(today, -2), amount: 1 },
      { id: 'l3', goalId: 'g1', date: U.addDays(today, -3), amount: 1 }
    ]
  );
  eq(M.streak(st, 'g1'), 3);
});

await test('连续天数：本周首个漏打日算休息日，不会断连续', () => {
  const today = U.todayStr();
  const mon = U.mondayOf(today);
  const st = stWith(
    [{ id: 'g1', name: 'A', total: 1000, deadline: U.addDays(today, 100), createdAt: mon }],
    [{ id: 'l1', goalId: 'g1', date: today, amount: 1 }]
  );
  // 本周一只打了周二，周一是本周首个漏打 → 视为休息日，连续为 1 而不是 0
  eq(M.streak(st, 'g1'), 1);
});

await test('预计完成日：按近 7 天平均速度外推', () => {
  const today = U.todayStr();
  const logs = [];
  for (let i = 0; i < 7; i++) logs.push({ id: 'l' + i, goalId: 'g1', date: U.addDays(today, -i), amount: 10 });
  const st = stWith([{ id: 'g1', name: 'A', total: 200, deadline: U.addDays(today, 100) }], logs);
  const e = M.eta(st, st.goals[0]);
  eq(e.status, 'ok');
  eq(e.date, U.addDays(today, 13), '还剩 130，每天 10 → 13 天');
  assert(e.diff > 0, '应比截止日期提前');
});

await test('预计完成日：新建当天就打卡，不会因为固定除以 7 被算成「拖后」', () => {
  const today = U.todayStr();
  const st = stWith(
    [{ id: 'g1', name: 'A', total: 1200, deadline: U.addDays(today, 30), createdAt: today }],
    [{ id: 'l1', goalId: 'g1', date: today, amount: 100 }]
  );
  const e = M.eta(st, st.goals[0]);
  eq(e.status, 'ok');
  eq(e.date, U.addDays(today, 11), '按 100/天算：还剩 1100 → 11 天');
  assert(e.diff > 0, '这个速度应该提前，而不是拖后');

  // 旧口径（固定 /7）会把它算成 77 天、拖后 47 天 —— 明确拦住这个回归
  assert(e.date !== U.addDays(today, 77), '不能被 7 天窗口稀释');
});

await test('预计完成日：建档 2 天只用 2 天做分母，满 7 天后恢复 7 天窗口', () => {
  const today = U.todayStr();
  const young = stWith(
    [{ id: 'g1', name: 'A', total: 1200, deadline: U.addDays(today, 30), createdAt: U.addDays(today, -1) }],
    [{ id: 'l1', goalId: 'g1', date: today, amount: 100 }]
  );
  const e1 = M.eta(young, young.goals[0]);
  eq(e1.date, U.addDays(today, 22), '2 天窗口 → 50/天，剩 1100 → 22 天');
  assert(e1.diff > 0, '仍是提前');

  const old = stWith(
    [{ id: 'g1', name: 'A', total: 1200, deadline: U.addDays(today, 100), createdAt: U.addDays(today, -9) }],
    [{ id: 'l1', goalId: 'g1', date: today, amount: 100 }]
  );
  const e2 = M.eta(old, old.goals[0]);
  eq(e2.date, U.addDays(today, 77), '建档超过 7 天回到 7 天窗口（与基准一致）');
});

await test('预计完成日：最近没打卡时返回 unknown 而不是编一个日期', () => {
  const st = stWith([{ id: 'g1', name: 'A', total: 200, deadline: '2026-12-31' }], []);
  eq(M.eta(st, st.goals[0]).status, 'unknown');
});

await test('预计完成日文案：跨年补年份，拖后超过一年不再报天数', () => {
  const L = require('../miniprogram/utils/eta-label.js');
  const today = '2026-10-27';

  eq(L.label({ status: 'ok', date: '2026-12-04', diff: 22 }, today), '12月4日 · 提前 22 天');
  eq(L.label({ status: 'ok', date: '2027-02-06', diff: -10 }, today), '2027年2月6日 · 拖后 10 天');
  eq(L.label({ status: 'ok', date: '2030-02-06', diff: -1131 }, today), '按目前速度，截止前完不成',
    '三年后的日期没有参考价值，直接说结论');
  eq(L.label({ status: 'done' }, today), '', '已达成由页面自己说');
});

await test('每日建议量：建档当天算定后不再随打卡缩水', () => {
  const today = U.todayStr();
  const st = stWith([{ id: 'g1', name: 'A', total: 120, deadline: U.addDays(today, 59), createdAt: today }], []);
  const q1 = M.dailyQuota(st, st.goals[0]);
  eq(q1.quota, Math.ceil(120 / 60));

  // 打了一半的量后，当天的建议量必须不变（快照已锁定）
  st.logs.push({ id: 'l1', goalId: 'g1', date: today, amount: Math.floor(q1.quota / 2), minutes: null, makeup: false, ts: 1, updatedAt: 1 });
  const q2 = M.dailyQuota(st, st.goals[0]);
  eq(q2.quota, q1.quota, '当天建议量不应因为已打卡而变小');
  eq(q2.locked, true);
});

await test('每日建议量：落后时会追缴，但不超过实际剩余量', () => {
  const today = U.todayStr();
  // 建档 10 天前，总量 100，到今天应完成约 16，但一条没打 → 欠账要摊到剩余天数
  const st = stWith([{ id: 'g1', name: 'A', total: 100, deadline: U.addDays(today, 50), createdAt: U.addDays(today, -10) }], []);
  const q = M.dailyQuota(st, st.goals[0]);
  assert(q.quota >= Math.ceil(100 / 60), '追缴后的建议量不应低于基准');
  assert(q.quota <= q.remain, '建议量不得超过实际剩余量');
});

await test('每日建议量：逾期后返回 overdue', () => {
  const today = U.todayStr();
  const st = stWith([{ id: 'g1', name: 'A', total: 100, deadline: U.addDays(today, -3), createdAt: U.addDays(today, -30) }], []);
  eq(M.dailyQuota(st, st.goals[0]).status, 'overdue');
});

await test('周汇总：按目标统计次数、天数与分钟', () => {
  const st = stWith(
    [{ id: 'g1', name: 'A', total: 1000, deadline: '2026-12-31' }, { id: 'g2', name: 'B', total: 1000, deadline: '2026-12-31' }],
    [
      { id: 'l1', goalId: 'g1', date: '2026-10-12', amount: 10, minutes: 20 },
      { id: 'l2', goalId: 'g1', date: '2026-10-13', amount: 15, minutes: 25 },
      { id: 'l3', goalId: 'g2', date: '2026-10-13', amount: 3, minutes: 5 }
    ]
  );
  const w = M.weekStats(st, '2026-10-12', '2026-10-18');
  eq(w.per.g1.sum, 25);
  eq(w.per.g1.days, 2);
  eq(w.per.g1.mins, 45);
  eq(w.per.g2.sum, 3);
  eq(w.totalMin, 50);
  eq(w.activeDays, 2);
});

await test('今日总览：区分已达标与未达标', () => {
  const today = U.todayStr();
  const st = stWith(
    [{ id: 'g1', name: 'A', total: 100, deadline: U.addDays(today, 9), createdAt: today },
      { id: 'g2', name: 'B', total: 100, deadline: U.addDays(today, 9), createdAt: today }],
    []
  );
  const q1 = M.dailyQuota(st, st.goals[0]).quota;
  const q2 = M.dailyQuota(st, st.goals[1]).quota;
  st.logs.push({ id: 'l1', goalId: 'g1', date: today, amount: q1, minutes: null, makeup: false, ts: 1, updatedAt: 1 });
  st.logs.push({ id: 'l2', goalId: 'g2', date: today, amount: Math.max(1, q2 - 1), minutes: null, makeup: false, ts: 2, updatedAt: 1 });

  const o = M.todayOverview(st);
  eq(o.total, 2);
  eq(o.met, 1, '只有一个目标达标');
  eq(o.rows.find((r) => r.goal.id === 'g1').met, true);
  eq(o.rows.find((r) => r.goal.id === 'g2').met, false);
});

/* ================================================================= */

group('跨设备合并（同步正确性的核心）');

function goalOf(id, name, updatedAt, deleted) {
  const g = { id: id, name: name, unit: '个', total: 100, deadline: '2026-12-31', createdAt: '2026-10-01', color: '#6366f1', obstacle: '', plan: '', sample: false, updatedAt: updatedAt };
  if (deleted) g.deleted = true;
  return g;
}
function logOf(id, goalId, date, amount, updatedAt, deleted) {
  const l = { id: id, goalId: goalId, date: date, amount: amount, minutes: null, makeup: false, ts: 1, updatedAt: updatedAt };
  if (deleted) l.deleted = true;
  return l;
}
function stateOf(goals, logs, notes) {
  const st = M.blankState();
  st.goals = goals || [];
  st.logs = logs || [];
  st.notes = notes || {};
  return st;
}
/** 只比较业务内容，忽略数组顺序（并集操作天然不保证顺序） */
function norm(st) {
  return {
    goals: st.goals.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((g) => [g.id, g.name, g.updatedAt, !!g.deleted]),
    logs: st.logs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((l) => [l.id, l.amount, l.updatedAt, !!l.deleted]),
    notes: Object.keys(st.notes).sort().map((k) => [k, st.notes[k].keep, st.notes[k].updatedAt])
  };
}

await test('同一分片的新旧版本按 updatedAt 取新', () => {
  const merged = M.mergeGoals([goalOf('g1', '旧名字', 100)], [goalOf('g1', '新名字', 200)]);
  eq(merged.length, 1);
  eq(merged[0].name, '新名字');
});

await test('两台设备各自新增的目标合并后都在', () => {
  const merged = M.mergeGoals([goalOf('g1', 'A', 100), goalOf('g2', 'A新增', 100)], [goalOf('g1', 'A', 100), goalOf('g3', 'B新增', 100)]);
  eq(merged.length, 3);
});

await test('删除以墓碑形式传播：远端删除后本机也会消失', () => {
  const local = stateOf([goalOf('g1', 'A', 100), goalOf('g2', 'B', 100)], []);
  M.mergeRemoteShards(local, [{ key: 'core', rev: 2, payload: { goals: [goalOf('g1', 'A', 200, true)], notes: {}, settings: {} } }]);
  eq(M.activeGoals(local).length, 1);
  eq(M.activeGoals(local)[0].id, 'g2');
});

await test('打卡记录按 id 并集，删除同样按墓碑生效', () => {
  const local = [logOf('l1', 'g1', '2026-10-13', 10, 100), logOf('l2', 'g1', '2026-10-13', 20, 100)];
  const remote = [logOf('l2', 'g1', '2026-10-13', 20, 100, true), logOf('l3', 'g1', '2026-10-13', 30, 100)];
  const merged = M.mergeLogs(local, remote);
  const ids = merged.map((l) => l.id).sort();
  deepEq(ids, ['l1', 'l2', 'l3']);
  eq(merged.find((l) => l.id === 'l2').deleted, true, '删除标记应被保留，而不是被并集覆盖成「还在」');
});

await test('分片按月份切分，同月记录落在一起', () => {
  const st = stateOf([], [
    logOf('a', 'g1', '2026-10-01', 1, 1),
    logOf('b', 'g1', '2026-10-31', 1, 1),
    logOf('c', 'g1', '2026-11-01', 1, 1)
  ]);
  const shards = M.buildLogShards(st);
  deepEq(Object.keys(shards), ['2026-10', '2026-11']);
  eq(shards['2026-10'].items.length, 2);
  eq(shards['2026-11'].items.length, 1);
});

await test('core 分片不包含本机派生数据（snapshots）', () => {
  const st = stateOf([goalOf('g1', 'A', 1)], [], { '2026-10-13': { keep: 'a', problem: '', try: '', next: '', updatedAt: 5 } });
  st.snapshots = { 'g1|2026-10-13': 12 };
  const core = M.buildCoreShard(st);
  eq(core.snapshots, undefined, 'snapshots 是每台设备各自算的展示缓存，不该上云');
  eq(Object.keys(core.notes).length, 1);
});

await test('空的复盘不会占用云端空间', () => {
  const st = stateOf([], [], {
    '2026-10-05': { keep: '', problem: '', try: '', next: '', updatedAt: 1 },
    '2026-10-12': { keep: '有内容', problem: '', try: '', next: '', updatedAt: 1 }
  });
  eq(Object.keys(M.buildCoreShard(st).notes).length, 1);
});

/* ---------- 收敛性：这是整套同步方案的地基 ---------- */

await test('并发分叉：两台设备用不同顺序合并，最终状态完全一致', () => {
  // 共同起点
  const base = [goalOf('g1', '共同目标', 100)];

  // 设备 A：改了目标 g1、新增 g2、删了 g3（g3 在 base 之外，表示 A 端早先有的）
  const aLocal = base.concat([goalOf('g2', 'A的目标', 200), goalOf('g3', 'A删掉的', 300, true)]);
  // 设备 B：也改了 g1（更晚）、新增 g4
  const bLocal = base.concat([goalOf('g1', '共同目标', 250), goalOf('g4', 'B的目标', 260)]);

  // A 收到 B 的分片
  const stA = stateOf(aLocal.map((g) => Object.assign({}, g)), []);
  M.mergeRemoteShards(stA, [{ key: 'core', rev: 5, payload: { goals: bLocal.map((g) => Object.assign({}, g)), notes: {}, settings: {} } }]);

  // B 收到 A 的分片
  const stB = stateOf(bLocal.map((g) => Object.assign({}, g)), []);
  M.mergeRemoteShards(stB, [{ key: 'core', rev: 5, payload: { goals: aLocal.map((g) => Object.assign({}, g)), notes: {}, settings: {} } }]);

  deepEq(norm(stA), norm(stB), '两端必须收敛到同一份数据');
  eq(stA.goals.find((g) => g.id === 'g1').name, '共同目标');
  eq(stA.goals.find((g) => g.id === 'g1').updatedAt, 250, '取 updatedAt 更大的一份');
  eq(M.activeGoals(stA).length, 3, 'g1 + g2 + g4 存活，g3 是墓碑');
});

await test('合并是幂等的：同一份云端数据反复合并不会产生变化', () => {
  const remote = [{ key: 'core', rev: 9, payload: { goals: [goalOf('g1', 'A', 500)], notes: {}, settings: {} } }];
  const st = stateOf([goalOf('g1', 'A', 100)], []);
  M.mergeRemoteShards(st, remote);
  const first = norm(st);
  M.mergeRemoteShards(st, remote);
  M.mergeRemoteShards(st, remote);
  deepEq(norm(st), first);
});

await test('合并不会把本机更新的版本降级成云端旧版本', () => {
  const st = stateOf([goalOf('g1', '本机最新', 900)], []);
  M.mergeRemoteShards(st, [{ key: 'core', rev: 3, payload: { goals: [goalOf('g1', '云端较旧', 100)], notes: {}, settings: {} } }]);
  eq(st.goals[0].name, '本机最新');
});

await test('日志分片只影响对应月份，其它月份不受牵连', () => {
  const st = stateOf([], [
    logOf('oct-1', 'g1', '2026-10-05', 10, 1),
    logOf('nov-1', 'g1', '2026-11-05', 20, 1)
  ]);
  M.mergeRemoteShards(st, [{ key: 'logs:2026-10', rev: 2, payload: { items: [logOf('oct-2', 'g1', '2026-10-06', 30, 2)] } }]);
  eq(st.logs.filter((l) => M.monthOf(l.date) === '2026-10').length, 2);
  eq(st.logs.filter((l) => M.monthOf(l.date) === '2026-11').length, 1);
  eq(st.logs.find((l) => l.id === 'nov-1').amount, 20, '11 月的数据不应被 10 月的合并动到');
});

await test('未知分片直接忽略，不会污染本地状态', () => {
  const st = stateOf([goalOf('g1', 'A', 1)], []);
  const before = norm(st);
  M.mergeRemoteShards(st, [{ key: '恶意:分片', rev: 1, payload: { goals: [goalOf('evil', 'X', 9999)] } }]);
  deepEq(norm(st), before);
});

await test('删除超过 90 天的墓碑会被清理，不会无限堆积', () => {
  const old = U.addDays(U.todayStr(), -200);
  const oldStamp = U.parseDate(old).getTime();
  const merged = M.mergeGoals([goalOf('g-old-deleted', 'X', oldStamp, true), goalOf('g1', '活的', 100)], []);
  eq(merged.length, 1);
  eq(merged[0].id, 'g1');
});

await test('完整一轮同步的载荷能通过服务端的清洗（前后端契约一致）', () => {
  const st = M.blankState();
  st.goals = [goalOf('g1', '目标', 100)];
  st.logs = [logOf('l1', 'g1', '2026-10-13', 5, 100)];
  st.notes = { '2026-10-12': { keep: 'a', problem: 'b', try: 'c', next: 'd', updatedAt: 100 } };

  const core = M.buildCoreShard(st);
  eq(typeof core.goals[0].id, 'string');
  eq(typeof core.settings.sound, 'boolean');
  assert(M.isCoreKey('core'));
  const shards = M.buildLogShards(st);
  Object.keys(shards).forEach((m) => {
    assert(M.isLogsShardKey(M.logsShardKey(m)), '生成的日志分片名必须通过合法性校验');
  });
});

export const suite = '客户端数据模型';
