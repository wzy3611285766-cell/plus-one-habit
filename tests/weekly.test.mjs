/**
 * 周报自动生成测试。
 *
 * 这块最容易出问题的地方不是排版，而是「说得不对」：
 *   · 本周没过完就跟整周比 —— 周一打开就被告知「比上周少 8 次」；
 *   · 只有一条记录却说「保持这个节奏」—— 空话；
 *   · 掉队的目标不点名，用户看完不知道要改什么。
 * 所以下面按「事实是否成立」来断言，不测文案的字面全文。
 */

import { createRequire } from 'node:module';
import { group, test, assert, eq, includes } from './harness.mjs';

const require = createRequire(import.meta.url);
const WR = require('../miniprogram/utils/weekly-report.js');

/* 2026-11-02 是周一；11-07 是周六 —— 本周过了 6 天 */
const WEEK_START = '2026-11-02';
const WEEK_END = '2026-11-08';
const TODAY = '2026-11-07';

function goal(id, name, total, createdAt) {
  return {
    id: id, name: name, unit: '次', total: total || 100,
    deadline: '2026-12-31', createdAt: createdAt || '2026-10-01',
    color: '#6366f1', restDays: []
  };
}

let seq = 0;
function log(goalId, date, amount) {
  seq++;
  return {
    id: 'l' + seq, goalId: goalId, date: date,
    amount: amount == null ? 1 : amount, minutes: 0, makeup: false, ts: seq
  };
}

function state(goals, logs) {
  return { goals: goals, logs: logs, notes: {}, snapshots: {}, settings: {} };
}

group('周报自动生成（结论 / 同期对比 / 建议）');

await test('空周给出「怎么开始」，不硬凑洞察', () => {
  const r = WR.build(state([goal('g1', '背单词', 100)], []), WEEK_START, WEEK_END, TODAY);
  eq(r.tone, 'empty');
  includes(r.headline, '还没有打卡记录');
  eq(r.lines.length, 1);
  eq(r.lines[0].kind, 'try');
  includes(r.lines[0].text, '+1');
});

await test('本周没过完时用「上周同期」对比，而不是整周', () => {
  const st = state([goal('g1', '背单词', 100)], [
    log('g1', '2026-11-02'), log('g1', '2026-11-03'),
    log('g1', '2026-11-04'), log('g1', '2026-11-05'),
    /* 上周整周有 5 天，但同期（前 6 天）只有 3 天 */
    log('g1', '2026-10-26'), log('g1', '2026-10-27'), log('g1', '2026-10-28'),
    log('g1', '2026-11-01')
  ]);
  const r = WR.build(st, WEEK_START, WEEK_END, TODAY);
  includes(r.headline, '这周 6 天');
  includes(r.headline, 'PLus one 4 次');
  includes(r.headline, '活跃 4 天');
  includes(r.headline, '比上周同期多 1 次');
  assert(r.headline.indexOf('打卡') < 0, '口径统一成 PLus one，不再混用「打卡」');
  eq(r.tone, 'good');
  eq(r.remaining, 1);
});

await test('连续天数优先于「投入最多」：连续 4 天要说连续', () => {
  const st = state([goal('g1', '背单词', 100)], [
    log('g1', '2026-11-02'), log('g1', '2026-11-03'),
    log('g1', '2026-11-04'), log('g1', '2026-11-05')
  ]);
  const r = WR.build(st, WEEK_START, WEEK_END, TODAY);
  const keep = r.lines.filter((x) => x.kind === 'keep')[0];
  assert(keep, '应有一行「保持」');
  includes(keep.text, '连续 4 天没断');
});

await test('掉队的目标被点名，并给出可执行的下一步', () => {
  const st = state([goal('g1', '背单词', 100), goal('g2', '阅读', 100)], [
    log('g1', '2026-11-02'), log('g1', '2026-11-03'),
    log('g2', '2026-11-04'),
    /* 阅读上周同期 3 天 */
    log('g2', '2026-10-26'), log('g2', '2026-10-27'), log('g2', '2026-10-28')
  ]);
  const r = WR.build(st, WEEK_START, WEEK_END, TODAY);
  const watch = r.lines.filter((x) => x.kind === 'watch')[0];
  assert(watch, '应有一行「注意」');
  includes(watch.text, '阅读');
  includes(watch.text, '上周同期 3 天');
  const tryLine = r.lines.filter((x) => x.kind === 'try')[0];
  assert(tryLine, '应有一行「下周」');
  includes(tryLine.text, '阅读');
});

await test('没有掉队时，推离完成最近的目标', () => {
  const g = goal('g1', '背单词', 10);
  const st = state([g], [
    log('g1', '2026-10-01', 3), log('g1', '2026-10-02', 3),
    log('g1', '2026-11-02', 1), log('g1', '2026-11-03', 1)
  ]);
  const r = WR.build(st, WEEK_START, WEEK_END, TODAY);
  const tryLine = r.lines.filter((x) => x.kind === 'try')[0];
  assert(tryLine, '应有一行「下周」');
  includes(tryLine.text, '累计 80%');
  includes(tryLine.text, '再推 2 次');
});

await test('周末空白会在没有更具体建议时被点出来', () => {
  const st = state([goal('g1', '背单词', 100)], [
    log('g1', '2026-11-02'), log('g1', '2026-11-03')
  ]);
  const r = WR.build(st, WEEK_START, WEEK_END, TODAY);
  const tryLine = r.lines.filter((x) => x.kind === 'try')[0];
  includes(tryLine.text, '周六日');
});

await test('本周暂停过的目标不被点名掉队', () => {
  /* 阅读上周同期 3 天、本周只 1 天 —— 但本周周一到周三在暂停。
     暂停是用户主动按的，周报不该把它说成「掉队」。 */
  const g1 = goal('g1', '阅读', 100);
  g1.pauses = [{ f: '2026-11-02', t: '2026-11-04' }];
  const st = state([g1, goal('g2', '背单词', 100)], [
    log('g2', '2026-11-02'), log('g2', '2026-11-03'),
    log('g2', '2026-11-04'), log('g2', '2026-11-05'),
    log('g1', '2026-11-06'),
    log('g1', '2026-10-26'), log('g1', '2026-10-27'), log('g1', '2026-10-28')
  ]);
  const r = WR.build(st, WEEK_START, WEEK_END, TODAY);
  eq(r.lines.filter((x) => x.kind === 'watch').length, 0, '暂停期不该被算成掉队');
});

await test('往期周只回看、不指导「下周」', () => {
  const st = state([goal('g1', '背单词', 100)], [
    log('g1', '2026-10-19'), log('g1', '2026-10-20')
  ]);
  const r = WR.build(st, '2026-10-19', '2026-10-25', TODAY);
  eq(r.remaining, -1);
  eq(r.lines.filter((x) => x.kind === 'try').length, 0);
  assert(r.lines.filter((x) => x.kind === 'keep').length === 1, '往期周仍要给出最稳的一项');
});

await test('已完成的目标不再被要求「保持」', () => {
  const st = state([goal('g1', '背单词', 2)], [
    log('g1', '2026-11-02', 2)
  ]);
  const r = WR.build(st, WEEK_START, WEEK_END, TODAY);
  eq(r.lines.filter((x) => x.kind === 'keep').length, 0);
});
