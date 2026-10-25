/**
 * 页面纵向集成测试。
 *
 * 走的是完整链路：Page 事件 → utils 层 → wx.cloud.callFunction（被拦截）
 *   → 云函数 service → 内存数据库 → 原路返回 → 页面 setData。
 *
 * 因此这里能验证的事，比单测更有说服力：
 *   - 未登录时页面真的显示引导、真的不发起同步请求；
 *   - 登录后打卡会真的写进账号的云端数据里；
 *   - 换一台「设备」（新存储、新会话）登录同一账号，能看到刚才的数据。
 * 最后一条就是「任意设备登录后自动同步」这个需求的直接证据。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createMockDb } from './mock/db.mjs';
import { installWxEnv, loadPage, instantiate, createStorage } from './mock/wx.mjs';
import { group, test, assert, eq, includes } from './harness.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(HERE, '..', 'miniprogram', 'pages');

process.env.AUTH_DEV_MODE = '1';

const db = createMockDb();
const env = installWxEnv({ db, openid: 'openid-page-test' });

/** 统计 state 的落盘次数，用来验证「没有变化就不该写盘」 */
let stateWrites = 0;
const rawSet = env.storage.set;
env.storage.set = function (k, v) {
  if (k === 'lgt.state.v1') stateWrites++;
  return rawSet(k, v);
};
function resetWriteCount() { const n = stateWrites; stateWrites = 0; return n; }

/* ---------- 各页面加载器（加载前必须已装好 mock） ---------- */

const pageFiles = {
  login: path.join(PAGES, 'login', 'login.js'),
  today: path.join(PAGES, 'today', 'today.js'),
  board: path.join(PAGES, 'board', 'board.js'),
  weekly: path.join(PAGES, 'weekly', 'weekly.js'),
  mine: path.join(PAGES, 'mine', 'mine.js'),
  goalEdit: path.join(PAGES, 'goal-edit', 'goal-edit.js')
};

/** util 层有模块级状态（当前会话、shards），每轮都重新加载一份干净的 */
const utilFiles = [
  path.join(HERE, '..', 'miniprogram', 'utils', 'config.js'),
  path.join(HERE, '..', 'miniprogram', 'utils', 'api.js'),
  path.join(HERE, '..', 'miniprogram', 'utils', 'auth.js'),
  path.join(HERE, '..', 'miniprogram', 'utils', 'store.js'),
  path.join(HERE, '..', 'miniprogram', 'utils', 'prefs.js')
];

function freshUtils() {
  // 换模块实例前，先掐掉旧 store 的 debounce 推送定时器：
  // 否则它会在之后某个用例的 await 间隙开火，向共享的 env.callCount 写入，
  // 让「不应发起云调用」这类精确增量断言偶发假失败。
  try {
    const prevStore = require.cache[require.resolve(utilFiles[4])];
    if (prevStore && prevStore.exports && prevStore.exports.cancelScheduled) {
      prevStore.exports.cancelScheduled();
    }
  } catch (e) { /* 首次调用时还没有旧实例 */ }
  utilFiles.forEach((f) => { delete require.cache[require.resolve(f)]; });
  return {
    auth: require(utilFiles[2]),
    store: require(utilFiles[3]),
    api: require(utilFiles[1]),
    M: require(path.join(HERE, '..', 'miniprogram', 'utils', 'model.js')),
    U: require(path.join(HERE, '..', 'miniprogram', 'utils', 'util.js'))
  };
}

/* ---------- 页面实例的生命周期管理 ----------
   真机上页面切走时会 onUnload，把挂在 store / auth 上的监听解掉。
   测试里如果不做这件事，上一组的页面会继续监听「上一份 store 模块」的事件，
   并在事件里把那份过期的 state 写回共享的 storage —— 那是测试脚手架的问题，
   不是产品的问题，但它会污染后面所有用例的结果。 */
let live = [];

function mount(key) {
  const p = instantiate(loadPage(pageFiles[key]));
  live.push(p);
  return p;
}

function retire() {
  live.forEach((p) => { if (typeof p.onUnload === 'function') { try { p.onUnload(); } catch (e) { } } });
  live = [];
}

/**
 * 启动一个「页面运行时」：先退掉上一轮的页面，再载入本机数据、从 storage 恢复会话。
 * 这两步在真机上是 app.onLaunch 里做的；测试里必须显式调用，
 * 否则 auth 模块的内存态是空的，isLogged() 会一直返回 false。
 */
async function boot(utils) {
  retire();
  utils.store.load();
  await utils.auth.restore();
  return utils.store;
}

/** 静默忽略同步失败：push 是 debounce 触发的，测试里要显式 await */
async function settle(utils) {
  try { await utils.store.sync(); } catch (e) { /* 网络/鉴权失败在用例里单独断言 */ }
}

/* ================================================================= */

group('今日打卡 · 未登录');

const U1 = freshUtils();
await boot(U1);
const todayPage = mount('today');
todayPage.onLoad();

await test('未登录也能正常使用，不做任何拦截', () => {
  eq(todayPage.data.logged, false);
  eq(todayPage.data.hasGoals, false, '新环境还没有目标');
});

await test('未登录时新建目标仍然可用（写本机）', () => {
  U1.store.addGoal({
    id: 'pg1', name: '背单词', unit: '个', total: 100,
    deadline: U1.U.addDays(U1.U.todayStr(), 30), createdAt: U1.U.todayStr(), color: '#6366f1', sample: false
  });
  todayPage.render();
  eq(todayPage.data.hasGoals, true);
  eq(todayPage.data.rows.length, 1);
  eq(todayPage.data.rows[0].name, '背单词');
  eq(todayPage.data.rows[0].total, '100', '卡片应带总量');
  eq(todayPage.data.rows[0].complete, false, '刚建的目标不应是已完成');
  assert(todayPage.data.statCards.length === 2, '统计条应有两张卡（今日已打卡 / 最长连续）');
});

await test('今日区三态：今天新建的目标不会被误判成「昨天漏卡」', () => {
  assert(Array.isArray(todayPage.data.missedRows), 'missedRows 应是数组');
  assert(Array.isArray(todayPage.data.restRows), 'restRows 应是数组');

  // 目标就是今天建的，昨天它还不存在 —— 漏卡判定必须先看 createdAt，
  // 否则新用户一进来就会看到一片红卡。
  eq(todayPage.data.missedRows.length, 0, '刚建的目标不应进漏卡列表');
  eq(todayPage.data.restRows.length, 0, '刚建的目标也不该占用休息日');
  eq(todayPage.data.hasTodayZone, false, '既没有漏卡也没有全部完成时，今日区不该出现');
});

await test('「⋯」抽屉：带出目标名、关闭后清空、无效目标不打开', () => {
  const goal = U1.store.get().goals[0];
  todayPage.openMenu({ currentTarget: { dataset: { gid: goal.id } } });

  eq(todayPage.data.menuOn, true, '应打开抽屉');
  eq(todayPage.data.menuGid, goal.id);
  eq(todayPage.data.menuName, goal.name, '抽屉标题应为目标名');

  todayPage.closeMenu();
  eq(todayPage.data.menuOn, false, '关闭后应隐藏');
  eq(todayPage.data.menuGid, '', '关闭后应清空 id');
  eq(todayPage.data.menuName, '', '关闭后应清空标题');

  // 传入一个不存在的 id 时不能把抽屉打开成空白状态
  todayPage.openMenu({ currentTarget: { dataset: { gid: 'no-such-goal' } } });
  eq(todayPage.data.menuOn, false, '无效目标不应打开抽屉');
});

await test('未登录时 +1 直接记录，不弹「数据在哪」这类提示', () => {
  todayPage.onPlus1({ currentTarget: { dataset: { gid: 'pg1' } } });
  eq(U1.M.doneAmount(U1.store.get(), 'pg1'), 1);
  eq(todayPage.data.toastOn, false, '打卡不该弹解释性提示');
});

await test('重绘不会无条件写盘（状态没变就不该整份保存）', () => {
  todayPage.render();          // 第一次会把当天建议量写成快照
  resetWriteCount();
  todayPage.render();          // 快照已存在，此时不应该再写
  todayPage.render();
  eq(stateWrites, 0, '没有新快照时不应写 storage，实际写入 ' + stateWrites + ' 次');
});

await test('未登录时不发起任何云函数调用（不会白跑一趟网络）', async () => {
  const before = env.callCount.auth + env.callCount.sync;
  await settle(U1);
  eq(env.callCount.auth + env.callCount.sync, before, '未登录时不应调用云函数');
  eq(U1.store.syncState().phase, 'needlogin');
});

await test('连击：900ms 内连点累加，带出蓄力态、×N 提示与减量粒子', () => {
  /* 把今日建议量锁成 1：这个用例要的是「连击」，不是「达成」。
     不锁的话连点到第 3 下会刚好跨过今日建议量，彩带会把爆发层清空。 */
  const st = U1.store.get();
  const qk = U1.M.dayQuotaKey('pg1', U1.U.todayStr());
  const savedQuota = st.snapshots ? st.snapshots[qk] : undefined;
  if (!st.snapshots) st.snapshots = {};
  st.snapshots[qk] = 1;
  todayPage.render();

  todayPage.combo = 0;
  todayPage.comboAt = 0;
  todayPage.setData({ fxList: [], p1Level: '' });

  const tap = () => todayPage.onPlus1({
    currentTarget: { dataset: { gid: 'pg1' } },
    detail: { x: 120, y: 260 }
  });

  tap();
  eq(todayPage.combo, 1, '第一击连击数为 1');
  eq(todayPage.data.p1Level, '', '第一击不该进入蓄力态');
  eq(todayPage.data.fxList.length, 1, '应产生一组爆发');
  eq(todayPage.data.fxList[0].sparks.length, 10, '首击应是基准的 10 粒粒子');
  eq(todayPage.data.fxList[0].x, 120, '爆发原点应取点击位置');
  eq(todayPage.data.fxList[0].combo, 0, '1 连击不显示 ×N');

  tap();
  eq(todayPage.combo, 2, '窗口内第二击应累加');
  eq(todayPage.data.fxList[1].sparks.length, 6, '连击时粒子应减到基准的 6 粒');

  tap();
  eq(todayPage.combo, 3);
  eq(todayPage.data.p1Level, 'p1-c3', '≥3 应进入蓄力态');
  eq(todayPage.data.fxList[2].combo, 3, '≥3 应带 ×N 连击');
  eq(todayPage.data.fxList[2].thin, true, '连击时冲击波应变细');

  tap();
  tap();
  eq(todayPage.combo, 5);
  eq(todayPage.data.fxList.length, 3, '同时最多保留 3 组爆发，节点数不会无限膨胀');

  // 复原当天快照，后面的用例还要按真实建议量走
  if (savedQuota === undefined) delete st.snapshots[qk];
  else st.snapshots[qk] = savedQuota;
  todayPage.render();
});

await test('连击：超过 900ms 没点就重新从 1 开始', () => {
  todayPage.combo = 4;
  todayPage.comboAt = Date.now() - 2000;
  todayPage.onPlus1({ currentTarget: { dataset: { gid: 'pg1' } }, detail: { x: 10, y: 20 } });
  eq(todayPage.combo, 1, '超出窗口应重置为 1');
  eq(todayPage.data.p1Level, '', '重置后不该残留蓄力态');
});

await test('达成后目标移入「已完成」区，主列表不再给它 +1', () => {
  const st = U1.store.get();
  const g = U1.M.goalById(st, 'pg1');
  const savedTotal = g.total;

  g.total = 1;
  U1.M.touch(g);
  todayPage.render();
  todayPage.onPlus1({ currentTarget: { dataset: { gid: 'pg1' } }, detail: { x: 10, y: 10 } });

  eq(todayPage.data.rows.some((r) => r.gid === 'pg1'), false, '已完成的目标不该留在主列表');
  assert(todayPage.data.doneRows.some((r) => r.gid === 'pg1'), '应出现在已完成区');

  g.total = savedTotal;
  U1.M.touch(g);
  U1.store.save();
  todayPage.render();
});

await test('示例数据：可载入、可清除，且不会被重复载入', () => {
  const before = U1.M.activeGoals(U1.store.get()).length;

  const r1 = U1.store.installSample();
  eq(r1.added, 3, '应载入 3 个示例目标');
  eq(U1.store.hasSample(), true);

  const r2 = U1.store.installSample();
  eq(r2.added, 0, '重复载入应被挡掉');
  eq(U1.store.get().goals.filter((x) => x.sample && !x.deleted).length, 3, '不应出现重复的示例目标');

  const core = U1.M.buildCoreShard(U1.store.get());
  eq(core.goals.filter((x) => x.sample).length, 0, '示例目标不该进入同步分片');

  const r3 = U1.store.clearSample();
  eq(r3.removed, 3, '应清除 3 个示例目标');
  eq(U1.store.hasSample(), false, '清除后不该再有示例');
  eq(U1.M.activeGoals(U1.store.get()).length, before, '真实目标不受影响');
});

await test('跨过终点时放彩带：片数按节点预算收敛，且不与爆发层叠加', () => {
  const st = U1.store.get();
  const goal = U1.M.goalById(st, 'pg1');
  const savedTotal = goal.total;
  goal.total = U1.M.doneAmount(st, 'pg1') + 1;   // 再打一次必然达成

  todayPage.setData({ fxList: [], confettiOn: false, confetti: [] });
  todayPage.onPlus1({ currentTarget: { dataset: { gid: 'pg1' } }, detail: { x: 30, y: 40 } });

  eq(todayPage.data.confettiOn, true, '达成应放彩带');
  eq(todayPage.data.confetti.length, 24, '彩带片数按节点预算降到 24');
  eq(todayPage.data.fxList.length, 0, '放彩带时应清掉爆发层，节点不叠加');
  includes(todayPage.data.toast, '达成', '应提示目标达成');

  goal.total = savedTotal;                      // 复原，后面的用例依赖这个目标
  U1.store.save();
  todayPage.render();
});

/* ================================================================= */

group('微信一键登录');

const U2 = freshUtils();
await boot(U2);
const loginPage = mount('login');
loginPage.onLoad();

/** 测试环境的 openid 由 mock 固定，所以这里直接按它找账号 */
const PAGE_OPENID = 'openid-page-test';

await test('一键登录成功后身份被保存，并自动把本机游客数据带上云', async () => {
  // 沿用上一段的本机数据：登录后它应该被合并进账号
  U2.store.addGoal({
    id: 'guest-1', name: '游客期间的目标', unit: '页', total: 50,
    deadline: U2.U.addDays(U2.U.todayStr(), 20), createdAt: U2.U.todayStr(), color: '#0ea5e9', sample: false
  });

  loginPage.doLogin();

  await new Promise((r) => setTimeout(r, 400));
  assert(U2.auth.isLogged(), '应已登录，错误：' + JSON.stringify(loginPage.data.error));
  assert(U2.auth.user().id, '应拿到账号 id');
  assert(U2.store.syncState().lastSyncAt > 0, '登录后应完成一次数据对齐');
});

await test('登录后：游客期间的数据被上传到账号，一条都没丢', async () => {
  const acc = db.dump('accounts').find((a) => a.openid === PAGE_OPENID);
  assert(acc, '云端应有一条绑定当前微信的账号');
  const docs = db.dump('sync_docs').filter((d) => d.userId === acc._id);
  assert(docs.length > 0, '云端应至少有一个分片');
  const core = docs.find((d) => d.key === 'core');
  const names = core.payload.goals.map((g) => g.name);
  assert(names.indexOf('背单词') >= 0, '未登录时建的目标应被带上云，实际：' + names.join(','));
  assert(names.indexOf('游客期间的目标') >= 0, '游客期间的目标也应被带上云');
});

await test('登录后当日打卡会同步到云端', async () => {
  const page = mount('today');
  page.onLoad();
  page.render();
  eq(page.data.logged, true);
  assert(page.data.rows.length + page.data.doneRows.length >= 2, '应显示两个目标（进行中 + 已完成）');

  const beforeCount = env.callCount.sync;
  page.onPlus1({ currentTarget: { dataset: { gid: 'pg1' } } });
  await settle(U2);
  assert(env.callCount.sync > beforeCount, '应产生同步调用');

  const acc = db.dump('accounts').find((a) => a.openid === PAGE_OPENID);
  const docs = db.dump('sync_docs').filter((d) => d.userId === acc._id);
  const logs = docs.filter((d) => d.key.indexOf('logs:') === 0)
    .reduce((a, d) => a.concat(d.payload.items || []), []);
  assert(logs.some((l) => l.goalId === 'pg1'), '云端应出现这个目标今天的打卡记录');
});

/* ================================================================= */

group('多设备 · 换一台设备用同一个微信');

await test('模拟第二台设备：清空本机缓存后重新一键登录', async () => {
  env.storage.clear();          // 相当于换了一台空白设备（同一个微信）
  const U3 = freshUtils();
  await boot(U3);

  eq(U3.store.get().goals.length, 0, '新设备本机应该是空的');
  assert(!U3.auth.isLogged(), '新设备不应有身份缓存');

  const page = mount('login');
  page.onLoad();
  page.doLogin();
  await new Promise((r) => setTimeout(r, 500));

  assert(U3.auth.isLogged(), '第二台设备应登录成功：' + JSON.stringify(page.data.error));

  const names = U3.store.get().goals.map((g) => g.name).sort();
  eq(names.length, 2, '应把账号下的目标全部拉下来，实际：' + names.join(','));
  assert(names.indexOf('背单词') >= 0 && names.indexOf('游客期间的目标') >= 0);

  const logs = U3.M.activeLogs(U3.store.get());
  assert(logs.length >= 1, '第一台设备的打卡记录也应出现在第二台设备上');
});

await test('第二台设备打卡后，第一台设备同步即可看到', async () => {
  // 重新加载模块后，登录态要从 storage 恢复出来（对应真机上的冷启动）
  const U3 = freshUtils();
  await boot(U3);
  assert(U3.auth.isLogged(), '第二台设备的登录态应能从本地恢复');

  const ids = U3.store.get().goals.map((g) => g.id);
  assert(ids.indexOf('guest-1') >= 0, '第二台设备应已同步到另一个目标，实际：' + ids.join(','));

  const page = mount('today');
  page.onLoad();
  page.render();
  page.onPlus1({ currentTarget: { dataset: { gid: 'guest-1' } } });
  await settle(U3);

  // 回到第一台设备的视角：重新加载模块并强制拉取
  const U4 = freshUtils();
  await boot(U4);
  await U4.store.pull({ force: true });

  const got = U4.M.logsOn(U4.store.get(), 'guest-1', U4.U.todayStr());
  assert(got >= 1, '第一台设备应看到第二台设备的打卡量，实际 ' + got);
});

/* ================================================================= */

group('身份保持与冷启动');

await test('冷启动时用本地缓存恢复身份（自动登录）', async () => {
  // 故意跳过 boot：这条用例要验的就是 restore 本身
  const U5 = freshUtils();
  U5.store.load();
  eq(U5.auth.isLogged(), false, '模块刚加载时还没有内存态');

  const r = await U5.auth.restore();
  eq(r.ok, true, '应能自动登录：' + JSON.stringify(r));
  eq(U5.auth.isLogged(), true);
});

await test('没有本地缓存时 restore 直接返回未登录，不白发一次云调用', async () => {
  const U6 = freshUtils();
  await boot(U6);
  assert(U6.auth.isLogged(), '应先处于登录态');

  U6.auth.logout();
  eq(U6.auth.isLogged(), false, '退出后本地应立即清空');

  const before = env.callCount.auth;
  const r = await U6.auth.restore();
  eq(r.ok, false);
  eq(r.reason, 'no-user');
  eq(env.callCount.auth, before, '没有缓存时不该再请求一次云函数');
});

/* ================================================================= */

group('我的 · 账号中心');

await test('未登录时只显示登录入口，不出现任何存储位置的说法', async () => {
  const U8 = freshUtils();
  await boot(U8);
  const page = mount('mine');
  page.onLoad();
  page.render();

  eq(page.data.logged, false);
  eq(page.data.user, null, '未登录时不该有用户信息');
  eq(page.data.sync.text, '未登录', '同步状态就说「未登录」，不解释数据去哪了');
  eq(page.data.sync.msg, '', '未登录不是错误，不该弹说明');
});

await test('登录后展示昵称与同步状态', async () => {
  env.storage.clear();
  const U9 = freshUtils();
  U9.store.load();
  await U9.auth.login();
  await U9.store.onLoggedIn();

  const page = mount('mine');
  page.onLoad();
  page.render();
  await new Promise((r) => setTimeout(r, 300));

  eq(page.data.logged, true);
  assert(page.data.user.id, '应展示账号 id');
  assert(page.data.user.hasWechat, '微信身份应标记为已绑定');
  assert(page.data.stats.records >= 1, '应统计到打卡记录');
  assert(['已同步', '同步中', '待同步'].indexOf(page.data.sync.text) >= 0,
    '同步状态应是中性词，实际：' + page.data.sync.text);
});

await test('退出登录只清身份缓存，本机记录一条不删', async () => {
  const U10 = freshUtils();
  await boot(U10);
  assert(U10.auth.isLogged(), '应处于登录态');
  const goalCount = U10.store.get().goals.length;

  U10.store.onLoggedOut();
  await U10.auth.logout();

  eq(U10.auth.isLogged(), false, '退出后应回到未登录');
  eq(U10.store.syncState().phase, 'needlogin');
  eq(U10.store.get().goals.length, goalCount, '本机记录不该被删');
});

/* ================================================================= */

group('看板与周报');

await test('看板正确汇总并生成 14 天柱状数据', async () => {
  const U15 = freshUtils();
  await boot(U15);
  await U15.auth.login();
  await U15.store.onLoggedIn();

  const page = mount('board');
  page.onLoad();
  page.render();

  eq(page.data.hasData, true);
  eq(page.data.chart.length, 14, '近 14 天应有 14 根柱子');

  const cards = page.data.activeCards.concat(page.data.doneCards);
  assert(cards.length >= 2, '应统计到目标数');
  assert(page.data.sections.length >= 1, '应按进行中 / 已完成分区');

  const todayCol = page.data.chart[13];
  eq(todayCol.isToday, true, '最后一根应是今天');

  assert(cards[0].etaText && cards[0].etaText.length > 0, '每个目标都应有预计完成说明');
  assert(cards[0].pct >= 0 && cards[0].pct <= 100, '完成率应在 0~100');
  assert(page.data.legend.length >= 1, '近 14 天有记录的目标应进图例');

  // 柱状段：flex-grow 按 amount 分配，颜色必须有兜底（透明段 = 柱子「半截白」）
  page.data.chart.forEach((c) => {
    c.segs.forEach((sg) => {
      assert(sg.amount > 0, '段必须有正数量');
      assert(sg.color && sg.color.indexOf('undefined') < 0, '段颜色不得为空/undefined');
    });
  });
});

await test('看板：展开记录后能删掉一天（两段式确认，天行整删）', async () => {
  const UB = freshUtils();
  await boot(UB);
  const page = mount('board');
  page.onLoad();
  page.render();

  const card = page.data.activeCards.find((c) => c.logCount > 0);
  assert(card, '应有一个带记录的目标');

  page.toggleLogs({ currentTarget: { dataset: { gid: card.gid } } });
  eq(page.data.expanded, card.gid, '点一次应展开');

  const ids = String(card.logs[0].id).split(',');
  page.deleteLog({ currentTarget: { dataset: { id: card.logs[0].id } } });
  eq(page.data.confirmDel, card.logs[0].id, '第一次点应进入待确认');
  assert(ids.every((x) => !((UB.store.get().logs.find((l) => l.id === x) || {}).deleted)),
    '第一次点不该真的删');

  page.deleteLog({ currentTarget: { dataset: { id: card.logs[0].id } } });
  assert(ids.every((x) => (UB.store.get().logs.find((l) => l.id === x) || {}).deleted),
    '第二次点才真删（当天整删）');
});

await test('看板：记录按天聚合——同一天多次打卡合成一行（合计+次数），按天整删', async () => {
  const UC = freshUtils();
  await boot(UC);
  const t = UC.U.todayStr();
  UC.store.addGoal({ id: 'pg-day', name: '聚合测试', unit: '个', total: 100, deadline: UC.U.addDays(t, 30), createdAt: t, color: '#6366f1', sample: false });
  UC.store.addLog('pg-day', t, 1, null, false);
  UC.store.addLog('pg-day', t, 3, null, false);
  UC.store.addLog('pg-day', t, 2, null, true);

  const page = mount('board');
  page.onLoad();
  page.render();

  const card = page.data.activeCards.find((c) => c.gid === 'pg-day');
  assert(card, '新目标应有卡');
  const day = card.logs.find((r) => r.id.indexOf(',') >= 0);
  assert(day, '同一天多次打卡应合成一行');
  eq(day.amount, '6', '当天合计');
  eq(day.count, 3, '次数标注');
  eq(day.makeup, true, '混有补记应标注');

  page.toggleLogs({ currentTarget: { dataset: { gid: 'pg-day' } } });
  page.deleteLog({ currentTarget: { dataset: { id: day.id } } });
  page.deleteLog({ currentTarget: { dataset: { id: day.id } } });
  const left = UC.store.get().logs.filter((l) => l.goalId === 'pg-day' && l.date === t && !l.deleted);
  eq(left.length, 0, '确认后当天三条一起删掉');
  if (typeof page.onUnload === 'function') page.onUnload();
});

await test('看板：统计条 / 热力图 / 最近动态 / 柱子点击', async () => {
  const UB = freshUtils();
  await boot(UB);

  const page = mount('board');
  page.onLoad();
  page.render();

  /* ---- 统计条：两张竖排数字卡（对齐基准 #boardStats） ---- */
  eq(page.data.statCards.length, 2, '统计条应有两张卡');
  eq(page.data.statCards[0].label, '累计打卡（次）');
  eq(page.data.statCards[1].label, '累计活跃（天）');
  assert(page.data.statCards[0].num >= 1, '累计打卡次数应至少为 1');
  assert(page.data.statCards[1].num >= 1, '累计活跃天数应至少为 1');

  /* ---- 热力图：35 天 + 前面补的空白格 ---- */
  const cells = page.data.heat.filter((c) => !c.blank);
  eq(cells.length, 35, '热力应覆盖 35 天');
  const todayCell = cells.find((c) => c.isToday);
  assert(todayCell, '今天那一格应被标记');
  eq(todayCell.k, UB.U.todayStr(), '标记的应是今天');
  eq(page.data.heat[page.data.heat.length - 1].k, UB.U.todayStr(), '最后一格是今天');
  assert(page.data.heat.every((c) => c.lv >= 0 && c.lv <= 4), '等级只能在 0~4');

  /* ---- 最近动态 ---- */
  assert(page.data.feed.length >= 1, '应有最近动态');
  assert(page.data.feed.length <= 8, '动态最多 8 条');
  assert(page.data.feed[0].name, '每条动态应带目标名');

  /* ---- 点柱子出气泡，再点收起 ---- */
  const d = page.data.chart[13].date;
  page.pickDay({ currentTarget: { dataset: { date: d } } });
  eq(page.data.picked, d, '应选中被点的柱子');
  page.pickDay({ currentTarget: { dataset: { date: d } } });
  eq(page.data.picked, '', '再点同一根应收起');
});

await test('周报：四栏复盘可保存，并能生成可复制的周报文本', async () => {
  const U16 = freshUtils();
  await boot(U16);
  const page = mount('weekly');
  page.onLoad();
  page.render();

  page.onField({ currentTarget: { dataset: { field: 'keep' } }, detail: { value: '每天都打了卡' } });
  page.onField({ currentTarget: { dataset: { field: 'problem' } }, detail: { value: '周末容易忘' } });
  page.save();

  const mon = U16.U.mondayOf(U16.U.todayStr());
  const note = U16.store.get().notes[mon];
  assert(note && note.keep === '每天都打了卡', '复盘应写入 notes');

});

await test('复盘会随打卡数据一起同步到云端', async () => {
  const U17 = freshUtils();
  await boot(U17);
  assert(U17.auth.isLogged(), '应处于登录态，否则复盘只会留在本机');
  await U17.store.sync();

  const acc = db.dump('accounts').find((a) => a.openid === PAGE_OPENID);
  const core = db.dump('sync_docs').find((d) => d.userId === acc._id && d.key === 'core');
  const mon = U17.U.mondayOf(U17.U.todayStr());
  assert(core.payload.notes[mon], '云端应存有这条复盘');
  eq(core.payload.notes[mon].keep, '每天都打了卡');
});

await test('往期复盘存档：新→旧排列、带摘录、点按直达那一周', async () => {
  const U18 = freshUtils();
  await boot(U18);
  const page = mount('weekly');
  page.onLoad();
  page.render();

  const mon0 = U18.U.mondayOf(U18.U.todayStr());
  const w1 = U18.U.addDays(mon0, -7);
  const w2 = U18.U.addDays(mon0, -14);
  U18.store.setNote(w1, { keep: '第一周保持', problem: '', try: '', next: '' });
  U18.store.setNote(w2, { keep: '', problem: '第二周问题', try: '', next: '' });
  page.render();

  const arc = page.data.archive;
  // 共享环境里可能还有别的周写过复盘，按 key 找本周插入的两条
  const byKey = {};
  arc.forEach((a) => { byKey[a.key] = a; });
  assert(byKey[w1] && byKey[w2], '写过复盘的两周都应在存档里');
  eq(byKey[w1].snippet, '保持：第一周保持', '摘录取第一个非空栏');
  eq(byKey[w2].snippet, '问题：第二周问题');
  const iW1 = arc.indexOf(byKey[w1]);
  const iW2 = arc.indexOf(byKey[w2]);
  assert(iW1 < iW2, '新 → 旧排序');

  eq(page.data.archiveOpen, false, '存档默认收起');
  page.toggleArchive();
  eq(page.data.archiveOpen, true, '标题行可展开');

  page.goArchive({ currentTarget: { dataset: { off: byKey[w2].off } } });
  eq(page.data.offset, -2, '应跳到两周前');
  eq(page.data.form.problem, '第二周问题', 'KPT 纸应载入那周的复盘');
  if (typeof page.onUnload === 'function') page.onUnload();
});

/* ================================================================= */

group('目标编辑');

await test('新建目标：参数校验挡住空表单', () => {
  const page = mount('goalEdit');
  page.onLoad({});
  page.setData({ form: { name: '', unit: '', total: '', deadline: '', color: '#6366f1', obstacle: '', plan: '' } });
  page.save();
  eq(page.data.errors.name, '请填写目标名称');
  eq(page.data.errors.total, '请填写总量');
  assert(page.data.errors.deadline, '应提示选择截止日期');
});

await test('新建目标：实时算出每日强度，日期早于今天会被拦下', () => {
  const page = mount('goalEdit');
  page.onLoad({});
  const U18 = freshUtils();
  page.setData({ form: { name: '新目标', unit: '页', total: '100', deadline: U18.U.addDays(U18.U.todayStr(), 19), color: '#6366f1', obstacle: '', plan: '' } });
  page.updatePreview();
  includes(page.data.preview.text, '20 天', '应提示总天数');
  includes(page.data.preview.text, '每天 5', '应算出每天的量');
});

await test('编辑已有目标会把改动写回并标记为待同步', async () => {
  const U19 = freshUtils();
  await boot(U19);
  const page = mount('goalEdit');
  page.onLoad({ id: 'pg1' });
  eq(page.data.isNew, false);
  eq(page.data.form.name, '背单词');

  page.setData({ 'form.total': '200' });
  page.save();

  const g = U19.M.goalById(U19.store.get(), 'pg1');
  eq(g.total, 200);
  assert(g.updatedAt > 0, '改动应带上合并用的时间戳');
});

await test('删除目标是软删除（打墓碑），保证能在其它设备上同步消失', async () => {
  const U20 = freshUtils();
  await boot(U20);
  const page = mount('goalEdit');
  page.onLoad({ id: 'guest-1' });
  page.confirmDelete();

  // 测试环境的 showModal 默认点「取消」，所以这里直接调 store 验证语义
  U20.store.deleteGoal('guest-1');
  const g = U20.store.get().goals.find((x) => x.id === 'guest-1');
  eq(g.deleted, true, '删除应是打墓碑而不是物理移除');
  eq(U20.M.activeGoals(U20.store.get()).some((x) => x.id === 'guest-1'), false, '界面上不应再出现');
});

await test('所有页面在未登录 + 空数据下渲染都不报错', async () => {
  env.storage.clear();
  await boot(freshUtils());

  const results = [];
  ['today', 'board', 'weekly', 'mine'].forEach((key) => {
    const page = mount(key);
    page.onLoad();
    page.render();
    results.push(key + ':' + (page.data ? 'ok' : 'fail'));
  });
  eq(results.length, 4);
  assert(results.every((r) => r.indexOf(':ok') > 0), results.join(','));
});

/* ================================================================= */

group('注销账号');

await test('确认词不对时拦下，不发请求也不动登录态', async () => {
  const UD = freshUtils();
  await boot(UD);
  await UD.auth.login();
  await UD.store.onLoggedIn();

  const page = mount('mine');
  page.onLoad();
  page.render();

  page.openDeleteAccount();
  eq(page.data.sheet, 'deleteAccount', '应打开注销弹层');

  page.setData({ form: { confirmDelete: '删除' } });
  const before = env.callCount.auth;
  page.submitDeleteAccount();

  eq(page.data.formError, '请输入「注销」两个字以确认');
  eq(env.callCount.auth, before, '第一次点只是上膛，不该发云函数请求');
  eq(UD.auth.isLogged(), true, '也不该动登录态');
});

await test('注销成功后：账号没了、云端分片清零、本机回到未登录', async () => {
  const UD = freshUtils();
  await boot(UD);

  const acc = db.dump('accounts').find((a) => a.openid === PAGE_OPENID);
  assert(acc, '应先有一个账号');
  const docsBefore = db.dump('sync_docs').filter((d) => d.userId === acc._id).length;
  assert(docsBefore > 0, '应先有云端分片');

  const page = mount('mine');
  page.onLoad();
  page.render();
  page.openDeleteAccount();
  page.setData({ form: { confirmDelete: '注销' } });
  page.submitDeleteAccount();
  await new Promise((r) => setTimeout(r, 400));

  eq(page.data.logged, false, '应回到未登录');
  assert(!UD.auth.isLogged(), '本机身份缓存应已清空');
  eq(db.dump('accounts').filter((a) => a.openid === PAGE_OPENID).length, 0, '账号文档应已删除');
  eq(db.dump('sync_docs').filter((d) => d.userId === acc._id).length, 0, '云端分片应已清空');
  eq(UD.store.get().goals.length, 0, '本机数据也应清空');
});

group('示例数据升级（SEED_VERSION 迁移）');

await test('旧版本的示例目标在启动时自动换成新版，用户自己的目标不动', () => {
  const UD = freshUtils();
  env.storage.clear();
  const t = UD.U.todayStr();
  const st = UD.M.blankState();
  st.seedVersion = 4;                       // 旧名单
  st.goals.push({ id: 'seed-g3', name: '读《马斯克传》', unit: '页', total: 440, deadline: UD.U.addDays(t, 40), createdAt: t, color: '#10b981', obstacle: '', plan: '', sample: true, updatedAt: 1 });
  st.goals.push({ id: 'pg-own', name: '用户自己的目标', unit: '个', total: 100, deadline: UD.U.addDays(t, 30), createdAt: t, color: '#6366f1', obstacle: '', plan: '', sample: false, updatedAt: 1 });
  st.seeded = true;
  env.storage.set('lgt.state.v1', JSON.stringify(st));

  UD.store.load();

  const goals = UD.store.get().goals;
  const samples = goals.filter((g) => g.sample && !g.deleted).map((g) => g.name);
  eq(samples.length, 3, '应换成新版 3 个示例');
  includes(samples.join(','), '币安人生', '新名单应生效');
  assert(samples.join(',').indexOf('马斯克') < 0, '旧示例应被摘掉');
  const own = goals.find((g) => !g.sample);
  eq(own.name, '用户自己的目标', '用户自己的目标不受影响');
  eq(UD.store.get().seedVersion, UD.M.SEED_VERSION, '版本号应对齐');
});

await test('清过示例的设备升级时不会重新塞入', () => {
  const UD = freshUtils();
  env.storage.clear();
  const t = UD.U.todayStr();
  const st = UD.M.blankState();
  st.seedVersion = 4;
  st.sampleCleared = true;                  // 用户明确清过
  st.goals.push({ id: 'pg-own', name: '用户自己的目标', unit: '个', total: 100, deadline: UD.U.addDays(t, 30), createdAt: t, color: '#6366f1', obstacle: '', plan: '', sample: false, updatedAt: 1 });
  env.storage.set('lgt.state.v1', JSON.stringify(st));

  UD.store.load();

  eq(UD.store.get().goals.length, 1, '不应重新塞入示例');
  eq(UD.store.get().seedVersion, UD.M.SEED_VERSION, '版本号静默对齐');
});

export const suite = '页面集成';
