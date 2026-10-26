/**
 * 音效层测试。
 *
 * 三件事值得用测试钉住：
 *   1. **设置里的 60 必须真的变成 1.8 的主增益**（百分比 0.6 × 补益 3）。
 *   2. **连击音阶必须是基准那张表**（E5 起，五声音阶一轮后回落），
 *      不是「听起来差不多」的自由发挥。
 *   3. **开关关掉就绝不能发声**，而试听要无视开关。
 *
 * WebAudio 用 mock 顶替：振荡器在 start() 时把波形与频率写进日志，
 * 于是「点了三下，音高是不是 659 → 740 → 831」是可断言的。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createMockDb } from './mock/db.mjs';
import { installWxEnv } from './mock/wx.mjs';
import { group, test, assert, eq } from './harness.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UTILS = path.join(HERE, '..', 'miniprogram', 'utils');

const db = createMockDb();
const env = installWxEnv({ db, openid: 'openid-sfx-test' });

/** 重新加载一整套 util 模块，拿到干净的模块级状态 */
function fresh() {
  ['config.js', 'api.js', 'auth.js', 'store.js', 'prefs.js', 'sfx.js'].forEach((f) => {
    delete require.cache[require.resolve(path.join(UTILS, f))];
  });
  const store = require(path.join(UTILS, 'store.js'));
  store.load();
  return { sfx: require(path.join(UTILS, 'sfx.js')), store: store };
}

function near(actual, expected, tol, msg) {
  assert(Math.abs(actual - expected) <= (tol || 0.5),
    (msg || '数值不符') + '：期望 ' + expected + '±' + (tol || 0.5) + '，实际 ' + actual);
}

/** 取最近一次发声产生的振荡器 */
function oscs(since) {
  return env.log.slice(since).filter((x) => x.type === 'osc');
}

/** 取最近创建的音频上下文 */
function lastCtx() {
  const list = env.audioCtxs || [];
  return list[list.length - 1] || null;
}

/** 主增益节点 = 唯一连到 destination 的那个 gain */
function masterGain(ctx) {
  const list = ctx && ctx.destination && ctx.destination.__connected;
  return list && list.length ? list[0] : null;
}

function audioLog(since) {
  return env.log.slice(since).filter((x) => x.type === 'audio' && x.action === 'play');
}

group('音效：百分比 → 播放增益');

const { sfx, store } = fresh();

await test('100% 对应增益 1.0（基准电平）', () => {
  eq(sfx.gainFromVolume(100), 1);
});

await test('60% 对应增益 0.6（不是 0.6 dB，是幅度比 0.6 倍）', () => {
  eq(sfx.gainFromVolume(60), 0.6);
});

await test('25% 对应增益 0.25', () => {
  eq(sfx.gainFromVolume(25), 0.25);
});

await test('越界与非法值被夹紧，不会产生 >1 或 NaN 的增益', () => {
  eq(sfx.gainFromVolume(-10), 0);
  eq(sfx.gainFromVolume(0), 0);
  eq(sfx.gainFromVolume(200), 1);
  eq(sfx.gainFromVolume(NaN), 1);
  eq(sfx.gainFromVolume(undefined), 1);
});

await test('档位夹紧：下限 25、上限 100，避免滑到 0 让人以为音效坏了', () => {
  eq(sfx.clampVolume(0), 25);
  eq(sfx.clampVolume(10), 25);
  eq(sfx.clampVolume(200), 100);
  eq(sfx.clampVolume(60), 60);
});

group('音效：连击音阶（参数取自基准 COMBO_STEPS）');

await test('第一击是 E5 659.25Hz', () => {
  near(sfx.comboFreq(1), 659.25, 0.01);
});

await test('第二击上行一个全音（+2 半音）', () => {
  near(sfx.comboFreq(2), 739.99, 0.05);
});

await test('第三击 +4 半音、第四击 +7 半音（五声音阶）', () => {
  near(sfx.comboFreq(3), 830.61, 0.05);
  near(sfx.comboFreq(4), 987.77, 0.05);
});

await test('第八击走到 +16 半音（两个八度的舒适上限）', () => {
  near(sfx.comboFreq(8), 1661.22, 0.2);
});

await test('第九击回落重走，不会无限爬高变尖', () => {
  near(sfx.comboFreq(9), 659.25, 0.01);
  near(sfx.comboFreq(17), 659.25, 0.01);
});

await test('音量随连击只推 4 音分，到第 9 击后恒定', () => {
  eq(sfx.comboVolume(1), 0.105);
  near(sfx.comboVolume(2), 0.109, 1e-9);
  near(sfx.comboVolume(9), 0.137, 1e-9);
  near(sfx.comboVolume(50), 0.137, 1e-9, '再往上不该继续变响');
});

group('音效：合成参数与开关');

await test('默认音量是 60（相对基准的百分比）', () => {
  store.updateSettings({ sound: true, volume: 60 });
  eq(sfx.volumePct(), 60);
});

await test('音量真的落到主增益上：60% → √0.6 × 补益 4 ≈ 3.098（2026-10-26 幂曲线调响）', () => {
  sfx.plus1(1);
  const ctx = lastCtx();
  assert(ctx, '应已创建 WebAudio 上下文');
  const master = masterGain(ctx);
  assert(master, '主增益应已连到 destination');
  near(master.gain.value, Math.sqrt(0.6) * 4, 1e-6, '主增益');
});

await test('改音量后下一次发声就跟着变：40% → √0.4 × 4 ≈ 2.530；纯函数映射保持 0.4 不变', () => {
  store.updateSettings({ volume: 40 });
  sfx.plus1(1);
  const master = masterGain(lastCtx());
  near(master.gain.value, Math.sqrt(0.4) * 4, 1e-6, '主增益');
  eq(sfx.gainFromVolume(40), 0.4, 'gainFromVolume 仍是纯百分比映射');
});

await test('+1 一次会叠出「哒」+ 主音 + 高八度三个音', () => {
  store.updateSettings({ volume: 60 });
  const before = env.log.length;
  sfx.plus1(1);
  const list = oscs(before).map((o) => Math.round(o.freq));
  assert(list.indexOf(220) >= 0, '应有低频「哒」，实际 ' + list.join(','));
  assert(list.indexOf(659) >= 0, '应有 E5 主音，实际 ' + list.join(','));
  assert(list.indexOf(1319) >= 0, '应有高八度叠音，实际 ' + list.join(','));
});

await test('+1 的主音用的是三角波（基准如此，正弦会太软）', () => {
  const before = env.log.length;
  sfx.plus1(2);
  const waves = oscs(before).filter((o) => Math.round(o.freq) === 740).map((o) => o.wave);
  assert(waves.length, '应产生 740Hz 附近的音');
  assert(waves.indexOf('triangle') >= 0, '主音应是 triangle，实际 ' + waves.join(','));
});

await test('连击 ≥4 加纯五度叠音，≥8 加长尾', () => {
  const before = env.log.length;
  sfx.plus1(4);
  const four = oscs(before).map((o) => Math.round(o.freq));
  assert(four.length >= 4, '4 连击应比首击多一个音，实际 ' + four.join(','));

  const before2 = env.log.length;
  sfx.plus1(8);
  const eight = oscs(before2).map((o) => Math.round(o.freq));
  assert(eight.length >= 5, '8 连击应再加一记长尾，实际 ' + eight.join(','));
});

await test('目标达成：C-E-G-C 四个音依次落', () => {
  const before = env.log.length;
  sfx.achieve();
  const list = oscs(before).map((o) => Math.round(o.freq));
  [523, 659, 784, 1047].forEach((f) => {
    assert(list.indexOf(f) >= 0, '应包含 ' + f + 'Hz，实际 ' + list.join(','));
  });
});

await test('今日达标：C-E-G 三个音，和整目标达成区分开', () => {
  const before = env.log.length;
  sfx.todayDone();
  const list = oscs(before).map((o) => Math.round(o.freq));
  [659, 784, 1047].forEach((f) => {
    assert(list.indexOf(f) >= 0, '应包含 ' + f + 'Hz，实际 ' + list.join(','));
  });
  assert(list.indexOf(523) < 0, '不该出现 C5 —— 那是整目标达成的起始音');
});

await test('撤销：G5 落回 E5', () => {
  const before = env.log.length;
  sfx.undo();
  const list = oscs(before).map((o) => Math.round(o.freq));
  assert(list.indexOf(784) >= 0 && list.indexOf(659) >= 0, '实际 ' + list.join(','));
});

await test('保存成功与错误各有自己的音', () => {
  const b1 = env.log.length;
  sfx.saved();
  assert(oscs(b1).length >= 2, '保存应是两音');

  const b2 = env.log.length;
  sfx.error();
  const list = oscs(b2).map((o) => Math.round(o.freq));
  assert(list.indexOf(392) >= 0 && list.indexOf(311) >= 0, '错误应是下行小三度，实际 ' + list.join(','));
});

await test('开关切换：开上行、关下行', () => {
  const b1 = env.log.length;
  sfx.toggle(true);
  const up = oscs(b1).map((o) => Math.round(o.freq));
  assert(up.indexOf(880) >= 0, '开启应带 880Hz');

  const b2 = env.log.length;
  sfx.toggle(false);
  const down = oscs(b2).map((o) => Math.round(o.freq));
  assert(down.indexOf(1175) >= 0, '关闭应带 1175Hz');
});

await test('音效关闭时一个音都不发（含 +1 与达成）', () => {
  store.updateSettings({ sound: false });

  const before = env.log.length;
  eq(sfx.plus1(1), false);
  eq(sfx.achieve(), false);
  eq(sfx.tap(), false);
  eq(oscs(before).length, 0, '关闭状态下不应产生任何振荡器');
});

await test('音效关闭时试听仍然发声（否则用户没法判断要不要打开）', () => {
  store.updateSettings({ sound: false, volume: 60 });

  const before = env.log.length;
  const ok = sfx.preview();

  eq(ok, true, 'preview 应无视开关');
  eq(audioLog(before).length, 1, '试听走 wav，应有一次播放');
});

await test('重新打开音效后 +1 恢复发声', () => {
  store.updateSettings({ sound: true, volume: 60 });

  const before = env.log.length;
  eq(sfx.plus1(1), true);
  assert(oscs(before).length >= 3, '应重新发声');
});

await test('音频上下文只创建一次，不会每点一下都新建', () => {
  const countBefore = (env.audioCtxs || []).length;
  sfx.plus1(1);
  sfx.tap();
  sfx.saved();
  const countAfter = (env.audioCtxs || []).length;
  eq(countAfter, countBefore, '上下文数量不应增加，实际 ' + countBefore + ' → ' + countAfter);
});

/* ================================================================= */

group('音效：WebAudio 不可用时的兜底');

/**
 * 放到最后：webBroken 一旦置位，模块在这一份加载里就不再尝试 WebAudio，
 * 所以必须先删 API、再重新加载模块，才能验证「退回 wav」这条路径。
 */
await test('拿不到 WebAudio 时 tap() 退回 assets/sounds/tap.wav', () => {
  const real = globalThis.wx.createWebAudioContext;
  delete globalThis.wx.createWebAudioContext;

  try {
    const f = fresh();
    f.store.updateSettings({ sound: true, volume: 50 });

    const before = env.log.length;
    const ok = f.sfx.tap();

    eq(ok, true, '兜底路径也应该响');
    const plays = audioLog(before);
    eq(plays.length, 1, '应播放一次 wav');
    eq(plays[0].src, '/assets/sounds/tap.wav');
    near(plays[0].volume, Math.sqrt(0.5), 1e-6, '兜底播放也应遵守音量百分比（幂曲线）');
  } finally {
    globalThis.wx.createWebAudioContext = real;
  }
});

await test('兜底模式下 plus1 安静失败，不会影响打卡流程', () => {
  const real = globalThis.wx.createWebAudioContext;
  delete globalThis.wx.createWebAudioContext;

  try {
    const f = fresh();
    f.store.updateSettings({ sound: true, volume: 60 });
    eq(f.sfx.plus1(1), false, '没有合成能力时应如实返回 false');
  } finally {
    globalThis.wx.createWebAudioContext = real;
  }
});
