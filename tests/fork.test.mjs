/**
 * 分享分叉测试（模仿 H5 第 17 轮「公开链接改成分叉副本」）。
 *
 * 三层：
 *   A. 编解码 —— base64url + UTF-8 的往返必须无损（中文、emoji、代理对）；
 *   B. 模板 —— state → 紧凑数组 → 新手机上的目标，天数/配色/文案都要活着到对岸；
 *   C. 入站闸门与 store 集成 —— 谁能分叉、谁不能分叉、登录/重置后记录归零。
 *
 * 判定顺序本身就是产品语义（见 fork.planIncoming 的注释），
 * 这里每个分支都有一条例子钉住。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createMockDb } from './mock/db.mjs';
import { installWxEnv, loadPage, instantiate } from './mock/wx.mjs';
import { group, test, assert, eq, includes } from './harness.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UTILS = path.join(HERE, '..', 'miniprogram', 'utils');

process.env.AUTH_DEV_MODE = '1';

const env = installWxEnv({ db: createMockDb(), openid: 'openid-fork-test' });

const utilFiles = ['config.js', 'api.js', 'auth.js', 'fork.js', 'store.js', 'prefs.js']
  .map((f) => path.join(UTILS, f));

function freshUtils() {
  utilFiles.forEach((f) => { delete require.cache[require.resolve(f)]; });
  return {
    auth: require(utilFiles[2]),
    fork: require(utilFiles[3]),
    store: require(utilFiles[4]),
    M: require(path.join(UTILS, 'model.js')),
    U: require(path.join(UTILS, 'util.js'))
  };
}

const MODEL = require(path.join(UTILS, 'model.js'));
function blankWith(goals) {
  // 只借无状态的 model：不要在这里 freshUtils()，它会删掉 store 的缓存条目，
  // 之后挂载页面时 require 到的是一份没 load 过的新 store，渲染出空页面。
  const st = MODEL.blankState();
  goals.forEach((g, i) => { g.order = i + 1; st.goals.push(g); });
  return st;
}

function goal(name, opts) {
  const o = opts || {};
  return {
    id: o.id || ('g-' + name),
    name: name,
    unit: o.unit || '个',
    total: o.total || 100,
    deadline: o.deadline || '2026-12-31',
    createdAt: o.createdAt || '2026-10-01',
    color: o.color || '#6366f1',
    obstacle: o.obstacle || '',
    plan: o.plan || '',
    sample: !!o.sample,
    deleted: !!o.deleted,
    updatedAt: 1
  };
}

/* ================================================================= */

group('分叉 · 编解码');

const D = freshUtils();

await test('UTF-8 往返：中文 / emoji / 代理对 / 混合', () => {
  const cases = [
    '背英语四级单词',
    '读《马斯克传》',
    'a,b:c d/e=f+?&#!',
    '颜色 #6366f1 与 #10b981',
    '打卡🎉与📚（emoji 走代理对）',
    '𝐀𝐁 数学字母（另一种代理对）',
    ''
  ];
  cases.forEach((s) => {
    eq(D.fork.utf8Decode(D.fork.utf8Encode(s)), s, 'utf8 往返失败：' + s);
  });
});

await test('base64url 往返，且不含 URL 保留字符', () => {
  const bytes = D.fork.utf8Encode('打卡量：600 个，备注（测试）');
  const s = D.fork.b64FromBytes(bytes);
  assert(!/[+/=]/.test(s), 'base64url 不应出现 + / =');
  const back = D.fork.bytesFromB64(s);
  eq(D.fork.utf8Decode(back), '打卡量：600 个，备注（测试）');
  eq(D.fork.bytesFromB64('!!!'), null, '非法字符应返回 null');
});

await test('模板串往返：encodeTpl(decodeTpl(x)) 逐字节一致', () => {
  const tpl = { v: 1, g: [['背单词', '个', 600, 30, 0, '晚上容易困', '早上通勤先背 20 个']] };
  const s = D.fork.encodeTpl(tpl);
  eq(D.fork.encodeTpl(D.fork.decodeTpl(s)), s);
});

await test('坏输入一律拒收，不抛异常', () => {
  ['', 'x', '!!!!', 'YWJj', D.fork.b64FromBytes(D.fork.utf8Encode('not json'))]
    .forEach((s) => eq(D.fork.decodeTpl(s), null, '应拒绝：' + s));
  eq(D.fork.decodeTpl(D.fork.b64FromBytes(D.fork.utf8Encode(JSON.stringify({ v: 2, g: [] })))), null, '版本不对要拒');
});

/* ================================================================= */

group('分叉 · 模板（state → 卡片 → 同学的手机）');

await test('tplFromState：示例与已删除的目标不上车', () => {
  const st = blankWith([
    goal('背单词'),
    goal('示例目标', { sample: true }),
    goal('已删的目标', { deleted: true })
  ]);
  const tpl = D.fork.tplFromState(st);
  eq(tpl.g.length, 1);
  eq(tpl.g[0][0], '背单词');
});

await test('tplFromState：最多 8 个，按 order 取前几个', () => {
  const list = [];
  for (let i = 0; i < 10; i++) list.push(goal('目标' + i));
  const tpl = D.fork.tplFromState(blankWith(list));
  eq(tpl.g.length, D.fork.MAX_GOALS);
  eq(tpl.g[0][0], '目标0');
  eq(tpl.g[7][0], '目标7');
});

await test('goalsFromTpl：天数照搬、今天起算、id 全新、配色保序', () => {
  const today = D.U.todayStr();
  const st = blankWith([goal('读书', { createdAt: '2026-01-01', deadline: '2026-01-31', color: '#f59e0b' })]);
  const goals = D.fork.goalsFromTpl(D.fork.decodeTpl(D.fork.encodeTpl(D.fork.tplFromState(st))));

  eq(goals.length, 1);
  const g = goals[0];
  eq(g.createdAt, today, '同学的进度从他的今天开始');
  eq(g.deadline, D.U.addDays(today, 30), '原计划 31 天（01-01→01-31），给同学的也是 31 天');
  eq(g.color, '#f59e0b');
  assert(g.id !== 'g-读书', 'id 必须重新生成，不能撞分享者的');
  assert(D.M.normalizeGoal(g), '种出来的目标必须过 normalizeGoal');
});

await test('goalsFromTpl：坏行丢弃、好行保留', () => {
  const tpl = { v: 1, g: [
    ['正常', '个', 100, 20, 1],
    ['', '个', 100, 20, 1],           // 没名字
    ['没总量', '个', 0, 20, 1],        // total 非法
    'not-a-row',                       // 不是数组
    ['没天数', '个', 100, 0, 1]        // days 非法
  ] };
  const goals = D.fork.goalsFromTpl(tpl);
  eq(goals.length, 1);
  eq(goals[0].name, '正常');
});

await test('encodeTplFit：超长模板先丢文案再丢目标，绝不超限', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(['很长很长的目标名字第' + i + '个要占不少字符', '单位', 9999, 99, 3, '障碍描述也要占一截字符', '预案描述同样占一截字符']);
  const s = D.fork.encodeTplFit({ v: 1, g: rows });
  assert(s.length <= D.fork.MAX_ENCODED, '裁剪后仍超限');
  const back = D.fork.decodeTpl(s);
  assert(back.g.length >= 1, '至少保住一个目标');
});

/* ================================================================= */

group('分叉 · 入站闸门（planIncoming）');

function freshVirgin() {
  // 模块缓存与共享存储都要清：否则上一条用例留下的目标/分叉记录会让
  // 本条用例一睁眼就「已有进度」或「已分叉过」，闸门全走偏。
  env.storage.clear();
  const UD = freshUtils();
  UD.store.load();
  return UD;
}

await test('没有 fr 参数：按普通打开处理', () => {
  const UD = freshVirgin();
  eq(UD.fork.planIncoming({}, false, UD.store.get()).reason, 'no-query');
});

await test('已登录不分叉：他有自己的账号', () => {
  const UD = freshVirgin();
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词')])));
  eq(UD.fork.planIncoming({ fr: enc }, true, UD.store.get()).reason, 'logged');
});

await test('坏模板不分叉', () => {
  const UD = freshVirgin();
  eq(UD.fork.planIncoming({ fr: '###' }, false, UD.store.get()).reason, 'bad-tpl');
});

await test('已有自己的进度不分叉：那份数据比模板重要', () => {
  const UD = freshVirgin();
  const st = UD.store.get();
  st.goals.push(goal('我自己建的目标'));
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('别人的目标')])));
  eq(UD.fork.planIncoming({ fr: enc }, false, st).reason, 'own-progress');
});

await test('只有示例目标也算「没有进度」：模板整体接管', () => {
  const UD = freshVirgin();
  const st = UD.store.get();
  st.goals.push(goal('示例', { sample: true }));
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词'), goal('读书')])));
  const plan = UD.fork.planIncoming({ fr: enc }, false, st);
  eq(plan.apply, true);
  eq(plan.goals.length, 2);
});

await test('已分叉过就不再分叉：换一张卡片也不覆盖（H5 第 17 轮同款闸门）', () => {
  const UD = freshVirgin();
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词')])));
  UD.fork.write({ forked: true, at: 1, welcomed: true, tpl: enc });
  const enc2 = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('另一个人的目标')])));
  eq(UD.fork.planIncoming({ fr: enc2 }, false, UD.store.get()).reason, 'already');
  UD.fork.clear();
});

/* ================================================================= */

group('分叉 · store 集成（落地 / 横幅 / 重载 / 记录归零）');

await test('游客首次打开分享卡片：种入目标、欢迎横幅待打、示例不混入', () => {
  const UD = freshVirgin();
  UD.store.installSample();                     // 先载入示例：分叉必须整体接管而不是叠加
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词', { createdAt: '2026-10-01', deadline: '2026-11-30' })])));

  const r = UD.store.applyShareQuery({ fr: enc }, false);
  eq(r.applied, true);
  const st = UD.store.get();
  eq(st.goals.length, 1, '示例目标应被模板顶掉（模板是唯一来源）');
  eq(st.goals[0].name, '背单词');
  eq(UD.store.forkWelcomePending(), true, '欢迎横幅应处于待打状态');

  UD.store.forkMarkWelcomed();
  eq(UD.store.forkWelcomePending(), false);
});

await test('再点开别的分享卡片：进度已属于这位同学，忽略', () => {
  const UD = freshVirgin();
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词')])));
  UD.store.applyShareQuery({ fr: enc }, false);

  const enc2 = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('别人的目标')])));
  const r2 = UD.store.applyShareQuery({ fr: enc2 }, false);
  eq(r2.applied, false);
  eq(r2.reason, 'already');
  eq(UD.store.get().goals[0].name, '背单词');
});

await test('打卡之后重新载入：丢掉改动、模板原样回来、横幅不再弹', () => {
  const UD = freshVirgin();
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词', { total: 600 })])));
  UD.store.applyShareQuery({ fr: enc }, false);
  UD.store.forkMarkWelcomed();

  const gid = UD.store.get().goals[0].id;
  UD.store.addLog(gid, UD.U.todayStr(), 20, null, false);   // 同学自己打了卡
  UD.store.addGoal(goal('同学自己加的目标'));
  eq(UD.store.get().logs.length, 1);

  const r = UD.store.reforkFromShare();
  eq(r.ok, true);
  eq(r.goals, 1);
  const st = UD.store.get();
  eq(st.logs.length, 0, '打卡记录应丢掉（重新复制一份的语义）');
  eq(st.goals.length, 1);
  eq(st.goals[0].name, '背单词');
  assert(st.goals[0].id !== gid, '重新种入的目标是新的一套 id');
  eq(UD.store.forkWelcomePending(), false, '欢迎横幅一辈子只打一次');
});

await test('登录后分叉记录归零：数据从此跟账号走', async () => {
  const UD = freshVirgin();
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词')])));
  UD.store.applyShareQuery({ fr: enc }, false);
  eq(UD.store.forkInfo().forked, true);

  await UD.auth.login();
  await UD.store.onLoggedIn();
  eq(UD.store.forkInfo().forked, false, '登录即完成分叉的使命');
  eq(UD.store.get().goals.length, 1, '目标本身不丢：并入账号');
});

await test('重置这台手机：分叉记录一并归零', () => {
  const UD = freshVirgin();
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词')])));
  UD.store.applyShareQuery({ fr: enc }, false);
  UD.store.clearLocalOnly();
  eq(UD.store.forkInfo().forked, false);
});

/* ================================================================= */

group('分叉 · 转发卡片与今日页横幅');

await test('shareConfig：路径指向今日页，fr 解开就是当前目标', () => {
  const UD = freshVirgin();
  UD.store.addGoal(goal('背单词', { createdAt: '2026-10-01', deadline: '2026-12-30' }));
  const cfg = UD.fork.shareConfig(UD.store.get());

  assert(cfg.path.indexOf('/pages/today/today?fr=') === 0, '路径应指向今日页并带 fr');
  const enc = cfg.path.split('fr=')[1];
  const tpl = UD.fork.decodeTpl(enc);
  eq(tpl.g.length, 1);
  eq(tpl.g[0][0], '背单词');
  assert(cfg.path.length <= 2048, '路径要留得住微信的长度限制');
});

await test('今日页：分叉后渲染出欢迎横幅，点「知道了」收起', () => {
  const UD = freshVirgin();
  const enc = UD.fork.encodeTpl(UD.fork.tplFromState(blankWith([goal('背单词')])));
  UD.store.applyShareQuery({ fr: enc }, false);

  const page = instantiate(loadPage(path.join(HERE, '..', 'miniprogram', 'pages', 'today', 'today.js')));
  page.onLoad();
  page.render();
  eq(page.data.forkBanner, true, '分叉后今日页应显示欢迎横幅');
  includes(page.data.rows.map((r) => r.name).join(','), '背单词');

  page.dismissForkBanner();
  eq(page.data.forkBanner, false);
  if (typeof page.onUnload === 'function') page.onUnload();
});

await test('普通打开（无 fr）：不横幅、不种目标', () => {
  const UD = freshVirgin();
  const r = UD.store.applyShareQuery({}, false);
  eq(r.applied, false);
  eq(UD.store.get().goals.length, 0);
  eq(UD.store.forkWelcomePending(), false);
});

/* ================================================================= */

group('分叉 · app 层入口（handleShareEntry）');

/**
 * 此前 app 层只有语法检查，分享卡片的核心接线没有行为测试。
 * 这里手动驱动 app 的启动切片：measureNav → initCloud → loadLocal → handleShareEntry。
 */
await test('冷启动带 fr：种入目标；不带 fr：不动；重复点同一张卡：幂等', () => {
  env.storage.clear();
  const MP_ROOT = path.join(HERE, '..', 'miniprogram');
  // app.js 与整条 utils 链换新实例（和 app.js 实际 require 到的是同一批）
  ['config.js', 'api.js', 'auth.js', 'fork.js', 'store.js', 'prefs.js', 'util.js', 'model.js', 'sfx.js']
    .forEach((f) => {
      const p = path.join(UTILS, f);
      if (require.cache[require.resolve(p)]) delete require.cache[require.resolve(p)];
    });
  if (require.cache[require.resolve(path.join(MP_ROOT, 'app.js'))]) {
    delete require.cache[require.resolve(path.join(MP_ROOT, 'app.js'))];
  }
  require(path.join(MP_ROOT, 'app.js'));   // 副作用：mock App() 捕获配置
  const app = env.appOptions;
  assert(app && typeof app.handleShareEntry === 'function', '应捕获到 App 配置');

  const fork2 = require(path.join(UTILS, 'fork.js'));
  const store2 = require(path.join(UTILS, 'store.js'));

  app.measureNav();
  app.initCloud();
  // dataReady 还是 false：入口必须直接返回，什么都不种
  const tplState = { goals: [goal('背单词')], logs: [] };
  app.handleShareEntry({ query: { fr: fork2.encodeTpl(fork2.tplFromState(tplState)) } });
  const virgin = store2.get();
  eq(virgin ? virgin.goals.length : 0, 0, 'loadLocal 之前不得动数据');

  app.loadLocal();
  const enc = fork2.encodeTpl(fork2.tplFromState(tplState));
  app.handleShareEntry({ query: { fr: enc } });
  eq(store2.get().goals.length, 1, '带 fr 的冷启动应种入目标');
  eq(fork2.read().forked, true, '应写下分叉记录');

  app.handleShareEntry({ query: {} });
  eq(store2.get().goals.length, 1, '不带 fr 不得动数据');

  app.handleShareEntry({ query: { fr: enc } });
  eq(store2.get().goals.length, 1, '同一张卡重复打开应被「已分叉」闸门挡住');
});

export const suite = '分享分叉（模仿 H5 第 17 轮）';
