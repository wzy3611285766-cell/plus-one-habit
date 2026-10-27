/**
 * 分享卡：只测「数据与文案」，画布本身在真机/模拟器上验证。
 *
 * 这些断言决定收卡片的人第一眼看到什么：
 *   - 今天完成几个目标、记了几次；
 *   - 我有哪些目标、各自进度；
 *   - 没目标 / 全达成时也不能出现空白或负数。
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { group, test, assert, eq, includes } from './harness.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const M = require('../miniprogram/utils/model.js');
const U = require('../miniprogram/utils/util.js');
const SC = require('../miniprogram/utils/share-card.js');

group('分享卡 · 数据提炼');

const today = U.todayStr();

function stWith(goals, logs) {
  const st = M.blankState();
  st.goals = goals.map((g, i) => Object.assign({
    id: 'g' + (i + 1),
    name: '目标' + (i + 1),
    unit: '个',
    total: 100,
    deadline: U.addDays(today, 10),
    createdAt: U.addDays(today, -2),
    color: '#6366f1',
    deleted: false,
    updatedAt: 1
  }, g));
  st.logs = (logs || []).map((l, i) => Object.assign({
    id: 'l' + i,
    amount: 1,
    minutes: null,
    makeup: false,
    ts: i,
    updatedAt: 1,
    deleted: false
  }, l));
  return st;
}

await test('一个目标都没建：不出现 0/0，给下一步动作', () => {
  const s = SC.summarize(stWith([], []));
  eq(s.goals, 0);
  eq(s.hit, 0);
  eq(s.top.length, 0);
  eq(s.headline, '从第一个目标开始');
  includes(s.title, '开始第一个目标');
  assert(s.sub.indexOf('0/0') < 0, '不能出现 0/0 这种无意义数字');
});

await test('部分完成：标题和主文案都要有「今天完成了多少」', () => {
  const st = stWith(
    [{ id: 'g1', total: 100 }, { id: 'g2', total: 50 }],
    [{ goalId: 'g1', date: today, amount: 10 }]
  );
  const s = SC.summarize(st);
  eq(s.goals, 2);
  eq(s.hit, 1);
  eq(s.todayLogs, 1);
  eq(s.top.length, 2);

  const first = s.top.filter((g) => g.name === '目标1')[0];
  eq(first.done, 10);
  eq(first.pct, 10);
  eq(first.today, 10);

  eq(s.headline, '今天完成 1 / 2 个目标');
  includes(s.title, '1/2');
  includes(s.sub, '记录 1 次');
});

await test('全部打卡：主文案切换成「全部目标都打卡了」', () => {
  const st = stWith(
    [{ id: 'g1', total: 100 }, { id: 'g2', total: 50 }],
    [
      { goalId: 'g1', date: today, amount: 3 },
      { goalId: 'g2', date: today, amount: 1 }
    ]
  );
  const s = SC.summarize(st);
  eq(s.allDone, true);
  eq(s.hit, 2);
  eq(s.headline, '今天全部目标都打卡了');
  includes(s.title, '2 个目标全打卡了');
});

await test('所有目标都已完成：不再说「待打卡」，也不出现空列表', () => {
  const st = stWith(
    [{ id: 'g1', total: 10 }, { id: 'g2', total: 10 }],
    [
      { goalId: 'g1', date: today, amount: 10 },
      { goalId: 'g2', date: today, amount: 10 }
    ]
  );
  const s = SC.summarize(st);
  eq(s.goals, 0, '已完成的目标不算进行中');
  eq(s.totalGoals, 2);
  eq(s.top.length, 0);
  eq(s.headline, '所有目标都已达成');
});

await test('目标超过 3 个：卡片只放前 3 个，剩余用 more 计数', () => {
  const goals = [1, 2, 3, 4, 5].map((n) => ({ id: 'g' + n, name: '目标' + n }));
  const s = SC.summarize(stWith(goals, []));
  eq(s.top.length, 3);
  eq(s.more, 2);
  eq(s.title.indexOf('NaN'), -1);
});

await test('删除的目标与别的日期的记录不会混进来', () => {
  const st = stWith(
    [{ id: 'g1', total: 100, deleted: true }, { id: 'g2', total: 1000 }],
    [
      { goalId: 'g2', date: today, amount: 5 },
      { goalId: 'g2', date: U.addDays(today, -1), amount: 99 }
    ]
  );
  const s = SC.summarize(st);
  eq(s.goals, 1, '删除的目标不算');
  eq(s.hit, 1);
  eq(s.todayLogs, 1, '只统计今天');
  eq(s.top[0].done, 104, '累计进度包含以前的记录');
  eq(s.top[0].today, 5, '今天的量单独统计');
});

group('分享卡 · 页面胶水');

await test('decorate：保留原路径，只补标题与图片', () => {
  const base = { title: '旧标题', path: '/pages/today/today?fr=x' };
  const card = { title: () => '今天完成 2/3 个目标', image: () => 'wxfile://share.jpg' };
  const out = SC.decorate(base, { selectComponent: () => card });
  eq(out.path, '/pages/today/today?fr=x', '分叉路径不能被分享卡改掉');
  eq(out.title, '今天完成 2/3 个目标');
  eq(out.imageUrl, 'wxfile://share.jpg');
});

await test('decorate：卡片没准备好/抛错时安静退回原配置，绝不阻塞分享', () => {
  const base = { title: '原配置', path: '/p' };
  const noCard = SC.decorate(base, { selectComponent: () => null });
  eq(noCard.title, '原配置');
  eq(noCard.imageUrl, undefined);

  const broken = { title: () => { throw new Error('boom'); }, image: () => 'x' };
  const out = SC.decorate({ title: '原配置', path: '/p' }, { selectComponent: () => broken });
  eq(out.title, '原配置');
  eq(out.path, '/p');
});

export const suite = '分享卡（今日总结）';
