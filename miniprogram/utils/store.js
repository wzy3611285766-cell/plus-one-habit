/**
 * 数据层 + 同步引擎。
 *
 * 一、本机状态
 *   state 的形态与 H5 版完全一致（goals / logs / notes / snapshots / settings），
 *   冷启动时优先读本机缓存，界面立刻可渲染；随后再与云端对齐。
 *
 * 二、同步的分片模型
 *   整份数据按「分片(shard)」上传，每个分片独立持有服务端版本号 rev：
 *     core            → { goals, notes, settings }
 *     logs:<YYYY-MM>  → { items:[...] }   （按自然月切分，单文档体量可控）
 *   这样做的两个理由：
 *     1. 打卡记录是只增的长列表，按月切分后单次同步只搬动变化的那一两个月；
 *     2. 服务端 rev 是单调自增整数（不依赖设备时钟），冲突检测才可靠。
 *
 * 三、冲突处理
 *   客户端乐观并发：推送时带上 baseRev。服务端发现 baseRev ≠ 当前 rev 就拒绝，
 *   把权威数据回传；客户端先合并再重推。合并规则见 model.js 的 merge* 系列：
 *     打卡记录 → 按 id 并集（记录本身不可变，天然无冲突）
 *     目标/复盘 → 带 updatedAt 的 LWW，删除记为墓碑而不是物理删除
 *   两台设备并发改动最终必然收敛到同一份数据。
 *
 * 四、未登录时
 *   照常写入本机，分片标 dirty 但不上传。登录成功后第一次同步会自动把这些
 *   本机数据合并进账号，不会丢失。
 */

const CFG = require('./config.js');
const M = require('./model.js');
const U = require('./util.js');
const api = require('./api.js');
const auth = require('./auth.js');
const fork = require('./fork.js');

const K = CFG.K;

/* ================= 内存态 ================= */

let state = null;
let shards = {};                 // { key: { rev:number, dirty:bool } }
let listeners = [];
let pushTimer = null;
let pulling = false;
let pushing = false;

let syncInfo = {
  phase: 'idle',                 // idle | syncing | synced | error | offline | needlogin
  message: '',
  lastSyncAt: 0,
  lastError: null
};

/* ================= 事件 ================= */

function on(cb) { listeners.push(cb); return function off() { listeners = listeners.filter((f) => f !== cb); }; }

function emit(evt) {
  listeners.forEach((f) => { try { f(evt); } catch (e) { /* 隔离监听器异常 */ } });
}

function syncState() { return syncInfo; }

function setPhase(phase, message) {
  syncInfo.phase = phase;
  if (message !== undefined) syncInfo.message = message;
  emit({ type: 'sync', phase: phase, message: syncInfo.message });
}

/* ================= 本机持久化 ================= */

function readRaw(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return v === '' || v === undefined || v === null ? fallback : v;
  } catch (e) { return fallback; }
}

function save() {
  try { wx.setStorageSync(K.STATE, JSON.stringify(state)); } catch (e) { /* 配额满等异常不阻塞交互 */ }
}

function saveShards() {
  try { wx.setStorageSync(K.SHARDS, JSON.stringify(shards)); } catch (e) { }
}

function shard(key) {
  if (!shards[key]) shards[key] = { rev: 0, dirty: false };
  return shards[key];
}

/**
 * 冷启动载入。
 * 迁移顺序：现有缓存 → H5 版遗留键 → 空白。
 * H5 遗留数据只在首次迁移时读取，迁移后立刻标记 dirty，
 * 用户登录后这批数据会自动带上云。
 */
function load() {
  const rawShards = U.safeJson(readRaw(K.SHARDS, ''), null);
  if (rawShards && typeof rawShards === 'object') {
    Object.keys(rawShards).forEach((k) => {
      if (!M.isKnownShardKey(k)) return;
      const s = rawShards[k];
      shards[k] = { rev: U.finiteNumber(s && s.rev, 0, 1e15) ? s.rev : 0, dirty: !!(s && s.dirty) };
    });
  }

  const rawState = U.safeJson(readRaw(K.STATE, ''), null);
  if (rawState) {
    state = M.parseState(rawState).state;
    return { migrated: false };
  }

  // 从 H5 版迁移（同一份数据结构，直接可读）
  for (let i = 0; i < K.LEGACY.length; i++) {
    const legacy = U.safeJson(readRaw(K.LEGACY[i], ''), null);
    if (legacy && typeof legacy === 'object') {
      const parsed = M.parseState(legacy);
      state = parsed.state;
      save();
      Object.keys(shards).forEach((k) => { shards[k].dirty = true; });
      shard(M.CORE_KEY).dirty = true;
      saveShards();
      return { migrated: true, goals: state.goals.length, logs: state.logs.length };
    }
  }

  state = M.blankState();
  save();
  return { migrated: false };
}

function get() { return state; }

/** 供页面在 render 后回写：只有真正改动了 state 的路径才应该调用 */
function commit(opts) {
  save();
  if (!(opts && opts.silent)) emit({ type: 'state' });
}

/* ================= 变更入口（业务层只走这几个函数） ================= */

function markCore() { shard(M.CORE_KEY).dirty = true; saveShards(); schedulePush(); }
function markLogs(month) { shard(M.logsShardKey(month)).dirty = true; saveShards(); schedulePush(); }

function addGoal(goal) {
  M.touch(goal);
  const order = M.activeGoals(state).reduce((mx, g) => Math.max(mx, typeof g.order === 'number' ? g.order : 0), 0);
  goal.order = order + 1;
  state.goals.push(goal);
  markCore();
  commit();
  return goal;
}

function updateGoal(id, patch) {
  const g = M.goalById(state, id);
  if (!g) return null;
  Object.assign(g, patch);
  M.touch(g);
  markCore();
  commit();
  return g;
}

/** 目标下的打卡记录一并打墓碑，避免留下悬空 logs */
function deleteGoal(id) {
  const g = M.goalById(state, id);
  if (!g) return false;
  g.deleted = true;
  M.touch(g);
  const months = {};
  state.logs.forEach((l) => {
    if (l.goalId !== id || l.deleted) return;
    l.deleted = true;
    M.touch(l);
    months[M.monthOf(l.date)] = 1;
  });
  markCore();
  Object.keys(months).forEach(markLogs);
  commit();
  return true;
}

function addLog(goalId, date, amount, minutes, makeup) {
  const log = {
    id: U.uid(),
    goalId: goalId,
    date: date || U.todayStr(),
    amount: amount,
    minutes: minutes === undefined || minutes === null ? null : minutes,
    makeup: !!makeup,
    ts: Date.now()
  };
  M.touch(log);
  state.logs.push(log);
  markLogs(M.monthOf(log.date));
  commit();
  return log;
}

/** 删一条指定记录（看板的「查看记录」里用）。软删除，跨设备同步消失。 */
function deleteLog(id) {
  const l = state.logs.find((x) => x.id === id && !x.deleted);
  if (!l) return false;
  l.deleted = true;
  M.touch(l);
  markLogs(M.monthOf(l.date));
  commit();
  return true;
}

/** 撤销：把该目标当天最新一条记录打墓碑 */
function undoLastLog(goalId, date) {
  const d = date || U.todayStr();
  for (let i = state.logs.length - 1; i >= 0; i--) {
    const l = state.logs[i];
    if (l.goalId === goalId && l.date === d && !l.deleted) {
      l.deleted = true;
      M.touch(l);
      markLogs(M.monthOf(l.date));
      commit();
      return l;
    }
  }
  return null;
}

function setNote(weekStart, note) {
  const n = M.normalizeNote(note) || M.normalizeNote({});
  n.updatedAt = U.nextStamp();
  state.notes[weekStart] = n;
  markCore();
  commit();
  return n;
}

function updateSettings(patch) {
  Object.assign(state.settings, patch);
  state.settings.updatedAt = U.nextStamp();
  markCore();
  commit();
}

function replaceAll(nextState) {
  state = nextState;
  shard(M.CORE_KEY).dirty = true;
  Object.keys(M.buildLogShards(state)).forEach((m) => markLogs(m));
  commit();
}

/* ================= 同步 ================= */

function scheduled() { return !!pushTimer; }

/** 取消尚未触发的 debounce 推送。测试换模块实例前调用，避免旧实例的
 *  定时器在共享 mock 上开火污染后续用例的调用计数。 */
function cancelScheduled() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (!auth.isLogged()) { setPhase('needlogin', '未登录'); return; }
    push().catch(() => { /* push 内部已记录错误 */ });
  }, CFG.TIMING.PUSH_DEBOUNCE_MS);
}

function dirtyKeys() {
  return Object.keys(shards).filter((k) => shards[k].dirty && M.isKnownShardKey(k));
}

/** 把本机分片打包成推送载荷 */
function shardPayload(key) {
  if (M.isCoreKey(key)) return M.buildCoreShard(state);
  const month = key.slice(M.LOGS_PREFIX.length);
  const items = state.logs.filter((l) => M.monthOf(l.date) === month);
  return { items: items };
}

/**
 * 推送本机脏分片。
 * 冲突时：先把服务端权威数据合并进来（这一步只增不减），再重推一次。
 * 只重试一次，避免两边持续互为冲突时打转。
 */
function push(retried) {
  if (pushing) {
    // 正在推的时候又有新改动：等这一轮结束后补一次，别把改动晾在本机
    schedulePush();
    return Promise.resolve({ skipped: 'busy' });
  }
  if (!auth.isLogged()) { setPhase('needlogin', '未登录'); return Promise.resolve({ skipped: 'guest' }); }

  const keys = dirtyKeys();
  if (!keys.length) return Promise.resolve({ skipped: 'clean' });

  pushing = true;
  setPhase('syncing', '正在保存…');

  const docs = keys.map((k) => ({ key: k, baseRev: shard(k).rev, payload: shardPayload(k) }));

  /* 不带任何凭据：云函数从调用上下文里取 openid 来认定身份 */
  return api.callSync('push', { docs: docs, deviceId: auth.deviceId() })
    .then((data) => {
      (data.applied || []).forEach((a) => {
        shard(a.key).rev = a.rev;
        shard(a.key).dirty = false;
      });
      saveShards();

      const conflicts = data.conflicts || [];
      if (conflicts.length) {
        M.mergeRemoteShards(state, conflicts);
        conflicts.forEach((c) => {
          shard(c.key).rev = c.rev;
          shard(c.key).dirty = true;
        });
        save();
        saveShards();
        emit({ type: 'state' });
      }

      pushing = false;

      if (conflicts.length && !retried) return push(true);

      syncInfo.lastSyncAt = Date.now();
      setPhase('synced', conflicts.length ? '已合并其它设备的改动' : '已同步');
      emit({ type: 'state' });
      return { applied: (data.applied || []).length, conflicts: conflicts.length };
    })
    .catch((e) => {
      pushing = false;
      syncInfo.lastError = e;
      if (api.isAuthError(e)) setPhase('needlogin', '登录已过期，请重新登录');
      else setPhase('error', e.apiMessage || '同步失败，稍后会自动重试');
      throw e;
    });
}

/**
 * 拉取云端变更。
 * known 传本机持有的各分片 rev；服务端只回传 rev 更大的分片。
 * force=true 时清空 known，做一次全量对齐。
 */
function pull(opts) {
  if (pulling) return Promise.resolve({ skipped: 'busy' });
  if (!auth.isLogged()) { setPhase('needlogin', '未登录'); return Promise.resolve({ skipped: 'guest' }); }

  const force = !!(opts && opts.force);
  if (!force && syncInfo.lastSyncAt && Date.now() - syncInfo.lastSyncAt < CFG.TIMING.AUTO_SYNC_THROTTLE_MS) {
    return Promise.resolve({ skipped: 'throttled' });
  }

  pulling = true;
  if (syncInfo.phase !== 'syncing') setPhase('syncing', '正在同步…');

  const known = {};
  if (!force) Object.keys(shards).forEach((k) => { if (M.isKnownShardKey(k)) known[k] = shards[k].rev; });

  return api.callSync('pull', { known: known })
    .then((data) => {
      pulling = false;
      const docs = data.docs || [];
      docs.forEach((d) => {
        if (!M.isKnownShardKey(d.key)) return;
        // 本机还有未推的改动时保留 dirty，不能让拉取把待推送标记抹掉
        shard(d.key).rev = d.rev;
      });
      const r = M.mergeRemoteShards(state, docs);
      save();
      saveShards();
      syncInfo.lastSyncAt = Date.now();
      setPhase('synced', '已同步');
      emit({ type: 'state' });
      return { changed: r.changed, count: docs.length };
    })
    .catch((e) => {
      pulling = false;
      syncInfo.lastError = e;
      if (api.isAuthError(e)) setPhase('needlogin', '登录已过期，请重新登录');
      else setPhase('error', e.apiMessage || '拉取失败，请检查网络');
      throw e;
    });
}

/** 完整同步：先推本机改动，再拉云端变更 */
function sync(opts) {
  if (!auth.isLogged()) { setPhase('needlogin', '未登录'); return Promise.resolve({ guest: true }); }
  setPhase('syncing', '正在同步…');
  return push()
    .then(() => pull({ force: !!(opts && opts.force) }))
    .then((r) => { emit({ type: 'state' }); return r; })
    .catch((e) => { throw e; });
}

/**
 * 登录成功后的首次对齐。
 * 顺序很关键：先全量拉（把账号已有的数据并进来），再把本机数据推上去。
 * 这样「游客期间打的卡」和「账号里原有的数据」都会保留。
 */
function onLoggedIn() {
  setPhase('syncing', '正在与账号数据对齐…');
  // 分叉记录到此完成使命：游客期的目标与打卡并入账号，此后数据跟账号走
  fork.clearOnLogin();
  return pull({ force: true })
    .then(() => {
      // 本机全部标脏，确保合并后的结果完整回传
      Object.keys(shards).forEach((k) => { if (M.isKnownShardKey(k)) shards[k].dirty = true; });
      shard(M.CORE_KEY).dirty = true;
      Object.keys(M.buildLogShards(state)).forEach((m) => { shard(M.logsShardKey(m)).dirty = true; });
      saveShards();
      return push();
    })
    .then(() => { emit({ type: 'state' }); return { ok: true }; });
}

function onLoggedOut() {
  // 只清同步元信息，不清本机数据：
  // 用户登出后仍应能看到自己的打卡记录（只是不再上传）。
  shards = {};
  saveShards();
  syncInfo.lastSyncAt = 0;
  syncInfo.lastError = null;
  setPhase('needlogin', '未登录');
  emit({ type: 'state' });
}

function resetToRemote() {
  if (!auth.isLogged()) return Promise.resolve(false);
  shards = {};
  saveShards();
  state = M.blankState();
  save();
  return pull({ force: true }).then(() => { emit({ type: 'state' }); return true; });
}

function clearLocalOnly() {
  state = M.blankState();
  shards = {};
  save();
  saveShards();
  // 「重置这台手机」对分叉记录同样成立：回到全新状态，之后的分享卡片可以重新分叉
  fork.clear();
  emit({ type: 'state' });
}

/* ================= 分享分叉（模仿 H5 第 17 轮） ================= */

/** 把模板种成这位同学自己的目标。只写本机（同 installSample 的取向）：
 *  游客期不标记脏分片，登录时 onLoggedIn 会统一补推。 */
function seedForkGoals(goals) {
  goals.forEach((g, i) => {
    g.order = i + 1;
    M.touch(g);
    state.goals.push(g);
  });
  commit();
}

/**
 * 处理一次带 ?fr= 的打开（分享卡片进入）。
 * 判定逻辑在 fork.planIncoming（纯函数），这里只负责落地：
 * 先回到空白再种入 —— 模板是唯一来源，本机残留的示例目标不混进来
 * （对齐 H5 第 17 轮 C 补丁「首次分叉前清掉本机残留」）。
 */
function applyShareQuery(query, logged) {
  const plan = fork.planIncoming(query, logged, state);
  if (!plan.apply) return { applied: false, reason: plan.reason };

  state = M.blankState();
  shards = {};
  save();
  saveShards();
  seedForkGoals(plan.goals);
  fork.write({ forked: true, at: Date.now(), welcomed: false, tpl: plan.tpl });
  return { applied: true, goals: plan.goals.length };
}

/**
 * 重新载入分享时的那份数据：丢弃这台手机上的全部改动，重新种一次模板。
 * 欢迎横幅不再弹（H5 同款：一辈子只打一次招呼）。
 */
function reforkFromShare() {
  if (auth.isLogged()) return { ok: false };
  const rec = fork.read();
  if (!rec || !rec.tpl) return { ok: false };
  const goals = fork.goalsFromTpl(fork.decodeTpl(rec.tpl));
  if (!goals.length) return { ok: false };

  state = M.blankState();
  shards = {};
  save();
  saveShards();
  seedForkGoals(goals);
  fork.write({ forked: true, at: Date.now(), welcomed: true, tpl: rec.tpl });
  return { ok: true, goals: goals.length };
}

function forkWelcomePending() { return fork.pendingWelcome(); }
function forkMarkWelcomed() { fork.markWelcomed(); }
function forkInfo() { return fork.info(); }

/* ================= 演示数据 =================
   示例目标带 sample:true：卡片显示琥珀底与「示例」徽标，和真实目标一眼分得开。
   重复载入会被挡掉；清除用软删除，同步到其它设备后也会一起消失。 */

function installSample() {
  if (state.goals.some((g) => g.sample && !g.deleted)) return { added: 0 };
  const data = M.seedData();
  const base = M.activeGoals(state).reduce((mx, g) => Math.max(mx, typeof g.order === 'number' ? g.order : 0), 0);

  data.goals.forEach((g, i) => {
    g.order = base + i + 1;
    state.goals.push(g);
  });
  state.seeded = true;
  state.sampleCleared = false;

  /* 刻意不调用 markCore()：示例数据只活在这台设备上。
     推上云端会把演示内容混进真实账号，换设备时还会看到一堆不属于自己的目标。 */
  commit();
  return { added: data.goals.length };
}

function clearSample() {
  let removed = 0;
  state.goals.forEach((g) => {
    if (!g.sample || g.deleted) return;
    g.deleted = true;
    M.touch(g);
    removed++;
  });
  if (removed) {
    state.sampleCleared = true;
    commit();   // 同样只写本机，不推云端
  }
  return { removed: removed };
}

function hasSample() {
  return state.goals.some((g) => g.sample && !g.deleted);
}

module.exports = {
  installSample: installSample,
  clearSample: clearSample,
  hasSample: hasSample,

  on: on,
  load: load,
  get: get,
  save: save,
  commit: commit,
  syncState: syncState,
  sync: sync,
  pull: pull,
  push: push,
  onLoggedIn: onLoggedIn,
  onLoggedOut: onLoggedOut,
  resetToRemote: resetToRemote,
  clearLocalOnly: clearLocalOnly,
  scheduled: scheduled,
  cancelScheduled: cancelScheduled,

  applyShareQuery: applyShareQuery,
  reforkFromShare: reforkFromShare,
  forkWelcomePending: forkWelcomePending,
  forkMarkWelcomed: forkMarkWelcomed,
  forkInfo: forkInfo,

  addGoal: addGoal,
  updateGoal: updateGoal,
  deleteGoal: deleteGoal,
  addLog: addLog,
  deleteLog: deleteLog,
  undoLastLog: undoLastLog,
  setNote: setNote,
  updateSettings: updateSettings,
  replaceAll: replaceAll
};
