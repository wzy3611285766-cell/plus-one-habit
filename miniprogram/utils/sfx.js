/**
 * 音效层 —— Web Audio 现场合成，零音频文件。
 *
 * 参数逐条取自 design-baseline.html 的 SFX 对象（第 3802–3886 行）。
 * 基准用 window.AudioContext；小程序对应的是 wx.createWebAudioContext()，
 * 两边 API 形状一致（createOscillator / createGain / createBiquadFilter），
 * 所以合成逻辑几乎是逐行移植，而不是「听起来差不多」的重写。
 *
 * 增益：输入先 ×MASTER_BOOST（补足音色绝对幅度），再过压缩器兜峰，
 *   最后乘「音量」增益（volume/100，线性，25%~100% → 0.25~1）。
 *   音量增益必须放在压缩器**后面**：放在前面会被压缩器把 25% 与 100%
 *   压成几乎一样的响度（用户 2026-10-27 反馈「只有试听音会变」的真因）。
 *   音色里的 vol 是 H5 基准的绝对幅度（0.03~0.11），不要为了调小声去改它 ——
 *   改了以后所有用户的听感都会跟着漂移。
 *
 * 兜底：极少数机型拿不到 WebAudio（或拿到的是坏的），此时 tap() 会退回
 *   InnerAudioContext + assets/sounds/tap.wav（同一个 1174.66Hz 正弦短音）。
 *   其它互动音效在兜底模式下静音 —— 宁可少一个音，也不要让打卡流程报错。
 */

const store = require('./store.js');

/** 兜底音频（只在 WebAudio 不可用时用） */
const FALLBACK_SRC = '/assets/sounds/tap.wav';

/** 音量档位下限。不给 0：滑到 0 会让人以为音效坏了 */
const MIN_PCT = 25;
const MAX_PCT = 100;

/**
 * 主增益补益：音色振幅是 H5 基准的绝对幅度，手机扬声器上偏小，
 * 这里在 WebAudio 主增益上一级补齐（×4 ≈ +12 dB）。
 * 只作用于合成链路 —— 兜底 wav 的 InnerAudioContext.volume 上限是 1，
 * 不吃补益（否则映射不单调）。
 */
const MASTER_BOOST = 4;


/** 连击音阶：C 大调五声音阶向上走一轮（基准 COMBO_STEPS） */
const COMBO_STEPS = [0, 2, 4, 7, 9, 12, 14, 16];

/** 连击基频：E5（基准 659.25） */
const BASE_HZ = 659.25;

/* ================= 纯函数（方便测试，不依赖 wx） ================= */

function gainFromVolume(pct) {
  const n = typeof pct === 'number' && isFinite(pct) ? pct : MAX_PCT;
  return Math.max(0, Math.min(MAX_PCT, n)) / MAX_PCT;
}

/** 压缩器之后的最终音量增益（线性 0.25~1；100% = 不过衰减） */
function masterGain(pct) {
  return gainFromVolume(pct);
}

function clampVolume(pct) {
  const n = typeof pct === 'number' && isFinite(pct) ? pct : MAX_PCT;
  return Math.max(MIN_PCT, Math.min(MAX_PCT, Math.round(n)));
}

/** 第 combo 击对应的基频：走完一轮八度后回落重走，不会无限爬高 */
function comboFreq(combo) {
  const c = Math.max(1, Math.floor(combo || 1));
  const semi = COMBO_STEPS[(c - 1) % COMBO_STEPS.length];
  return BASE_HZ * Math.pow(2, semi / 12);
}

/** 第 combo 击的主音音量：每击 +0.004，最多 +0.032 后恒定 */
function comboVolume(combo) {
  const c = Math.max(1, Math.floor(combo || 1));
  return 0.105 + Math.min(c - 1, 8) * 0.004;
}

/* ================= 读取当前设置 ================= */

function settings() {
  const st = store.get();
  return (st && st.settings) || {};
}

function soundEnabled() {
  return settings().sound !== false;
}

function volumePct() {
  return clampVolume(settings().volume);
}

/* ================= WebAudio 上下文 ================= */

let ACTX = null;
/** 输入增益：固定 ×MASTER_BOOST，所有音色先汇到这里 */
let MASTER = null;
let MASTER_CTX = null;
/** 音量增益：挂在压缩器之后，真正随滑块变化的就是它 */
let VOLUME = null;
let VOLUME_CTX = null;
let COMP = null;
let COMP_CTX = null;
let webBroken = false;
/** 连击停手 2.4s 后的落音定时器 */
let comboFallTimer = null;

function audioCtx() {
  if (ACTX) return ACTX;
  if (webBroken) return null;
  if (typeof wx === 'undefined' || typeof wx.createWebAudioContext !== 'function') {
    webBroken = true;
    return null;
  }
  try {
    ACTX = wx.createWebAudioContext();
    if (!ACTX) { webBroken = true; return null; }
    MASTER = null;
    MASTER_CTX = null;
    VOLUME = null;
    VOLUME_CTX = null;
    COMP = null;
    COMP_CTX = null;
  } catch (e) {
    webBroken = true;
    ACTX = null;
  }
  return ACTX;
}

/** 音频链路：音色 → 输入增益(×4) → 压缩器 → 音量增益 → destination。
 *  音量必须放在压缩器之后：放在前面会被压缩器把 25% 与 100% 压成同一响度，
 *  用户拖滑块只会听到试听音变化，实际 +1 听不出区别（2026-10-27 反馈）。
 *  没有压缩器时退回「输入增益 → 音量增益 → destination」，不影响出声。 */
function masterOf(ctx) {
  if (MASTER && MASTER_CTX === ctx) return MASTER;
  try {
    const dest = ctx.destination || null;

    // 1) 音量增益（最终输出，压缩器之后）
    const vol = ctx.createGain();
    if (vol && vol.gain) {
      try { vol.gain.value = masterGain(volumePct()); } catch (e) { /* 只读实现 */ }
    }
    if (vol && dest) vol.connect(dest);

    // 2) 压缩器：兜住拉满时的和弦叠峰，接在音量增益之前
    let tail = vol;
    if (typeof ctx.createDynamicsCompressor === 'function') {
      const comp = ctx.createDynamicsCompressor();
      if (comp) {
        try {
          comp.threshold.value = -4;
          comp.knee.value = 8;
          comp.ratio.value = 8;
          if (comp.attack) comp.attack.value = 0.002;
          if (comp.release) comp.release.value = 0.12;
        } catch (e0) { /* 只读实现 */ }
        if (comp.connect && vol) comp.connect(vol);
        tail = comp;
        COMP = comp;
        COMP_CTX = ctx;
      }
    }

    // 3) 输入增益：固定补益，所有音色汇入这里
    const input = ctx.createGain();
    if (input && input.gain) {
      try { input.gain.value = MASTER_BOOST; } catch (e) { /* 只读实现 */ }
    }
    if (input && tail) input.connect(tail);

    MASTER = input;
    MASTER_CTX = ctx;
    VOLUME = vol;
    VOLUME_CTX = ctx;
  } catch (e) {
    MASTER = null;
    VOLUME = null;
  }
  return MASTER || (ctx.destination || null);
}

/** 每次发声前把「压缩器之后的音量」对齐当前滑块（用户可能刚拖过） */
function applyGain(ctx, pct) {
  if (!VOLUME || VOLUME_CTX !== ctx) masterOf(ctx);
  const g = VOLUME;
  const target = masterGain(typeof pct === 'number' && isFinite(pct) ? pct : volumePct());
  if (!g || !g.gain) return;
  try {
    if (typeof g.gain.setTargetAtTime === 'function' && typeof ctx.currentTime === 'number') {
      g.gain.setTargetAtTime(target, ctx.currentTime, 0.01);
    } else {
      g.gain.value = target;
    }
  } catch (e) {
    try { g.gain.value = target; } catch (e2) { /* 放弃 */ }
  }
}

/**
 * 预热：提前创建 WebAudio 上下文与主增益，但不发声。
 * app 启动时静默调用一次，首个 +1 就不用付「上下文创建 + 首节点连图」的成本。
 */
function preload() {
  const ctx = audioCtx();
  if (ctx) masterOf(ctx);
  return !!ctx;
}

/** iOS 要求在手势里解锁音频上下文；每次发声前调一次没有副作用 */
function unlock() {
  const ctx = audioCtx();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
  } catch (e) { /* 解锁失败不影响后续尝试 */ }
  return !!ACTX;
}

/**
 * 单个音符。参数与基准 tone() 一致：
 *   type 波形 / freq 基频 / dur 时长 / vol 音量 / delay 延迟
 *   slideTo 滑音终点 / filtHz 低通截止 / filtQ 谐振 / atk 起音 / slideDur 滑音时长
 * @returns {boolean} 是否真的排上了一个音
 */
function tone(type, freq, dur, vol, delay, slideTo, filtHz, filtQ, atk, slideDur) {
  const ctx = audioCtx();
  if (!ctx) return false;
  if (ctx.state === 'closed') return false;

  /* 试听可能传入临时音量（滑块还没落库）：优先用它；
     平时每次发声前都把音量增益对齐当前设置。 */
  applyGain(ctx, FORCE_PCT == null ? undefined : FORCE_PCT);

  const now = typeof ctx.currentTime === 'number' ? ctx.currentTime : 0;
  const t0 = now + (delay || 0);
  const a = atk == null ? 0.008 : atk;

  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    if (!osc || !gain) return false;

    osc.type = type || 'sine';
    if (osc.frequency && typeof osc.frequency.setValueAtTime === 'function') {
      osc.frequency.setValueAtTime(freq, t0);
    }
    if (slideTo && slideTo !== freq && osc.frequency &&
        typeof osc.frequency.exponentialRampToValueAtTime === 'function') {
      const sd = slideDur == null ? Math.min(dur, 0.06) : slideDur;
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + Math.min(sd, dur));
    }

    if (gain.gain) {
      /* 起音 0.0001 而不是 0：exponentialRamp 不接受 0，直接写 0 会抛错 */
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol == null ? 0.2 : vol), t0 + a);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    }

    let out = gain;
    if (filtHz && typeof ctx.createBiquadFilter === 'function') {
      const f = ctx.createBiquadFilter();
      if (f) {
        f.type = 'lowpass';
        if (f.frequency) f.frequency.setValueAtTime(filtHz, t0);
        if (f.Q) f.Q.value = filtQ == null ? 0.7 : filtQ;
        gain.connect(f);
        out = f;
      }
    }

    osc.connect(gain);
    const dest = masterOf(ctx);
    if (dest && typeof out.connect === 'function') out.connect(dest);

    osc.start(t0);
    if (typeof osc.stop === 'function') osc.stop(t0 + dur + 0.03);
    return true;
  } catch (e) {
    /* 某个机型缺 API：静默放弃这个音，绝不让打卡流程跟着报错 */
    return false;
  }
}

/* ================= 兜底：InnerAudioContext ================= */

let wavCtx = null;
let wavBroken = false;
/** 试听临时音量：只在 preview() 的同步调用期间有效，不写设置 */
let FORCE_PCT = null;

function ensureWav() {
  if (wavCtx) return wavCtx;
  if (wavBroken) return null;
  if (typeof wx === 'undefined' || typeof wx.createInnerAudioContext !== 'function') {
    wavBroken = true;
    return null;
  }
  try {
    wavCtx = wx.createInnerAudioContext();
    wavCtx.src = FALLBACK_SRC;
    wavCtx.autoplay = false;
    wavCtx.loop = false;
    wavCtx.volume = gainFromVolume(volumePct());
    wavCtx.onError(function (e) {
      wavBroken = true;
      if (wavCtx) { try { wavCtx.destroy(); } catch (x) { } wavCtx = null; }
      console.warn('[音效] 兜底音频失败，已停用：', (e && (e.errMsg || e.errCode)) || e);
    });
  } catch (e) {
    wavBroken = true;
    wavCtx = null;
  }
  return wavCtx;
}

function playWav(force, pct) {
  if (!force && !soundEnabled()) return false;
  const c = ensureWav();
  if (!c) return false;
  /* 兜底 wav 与合成链路共用同一条线性音量：两边拖滑块的变化量一致 */
  c.volume = gainFromVolume(typeof pct === 'number' && isFinite(pct) ? pct : volumePct());
  try { c.stop(); } catch (e) { /* 首次播放前 stop 会抛错 */ }
  try { c.play(); return true; } catch (e) { return false; }
}

/* ================= 音色 ================= */

/**
 * ① +1 单击。连击越高音越高（五声音阶一轮）、越「实」（音量 +0.004/击），
 * 但不无限爬高：一轮走完回落重走，永远不会变尖。
 */
function plus1(combo) {
  if (!soundEnabled()) return false;
  unlock();
  const c = Math.max(1, Math.floor(combo || 1));
  const base = comboFreq(c);
  const v = comboVolume(c);

  /* 极短的低频「哒」，模拟机械键帽到底 */
  tone('sine', 220, 0.035, 0.042, 0, 180, null, null, 0.002);
  tone('triangle', base, 0.09, v, 0, base, null, 2600, 0.7, 0.003, 0.05);
  tone('sine', base * 2, 0.05, 0.038, 0, base * 2, null, null, 0.002);
  if (c >= 4) tone('sine', base * 1.5, 0.10, 0.045, 0.02, base * 1.5, null, 2600, 0.7, 0.004);
  if (c >= 8) tone('sine', base * 2, 0.15, 0.028, 0.03, base * 2, null, null, 0.004);
  if (c % 8 === 0) tone('sine', base * 3, 0.18, 0.03, 0.05, base * 3, null, null, 0.006);

  /* 停手 2.4s 后一个轻轻的落音收束 */
  if (comboFallTimer) clearTimeout(comboFallTimer);
  comboFallTimer = setTimeout(function () {
    if (!soundEnabled()) return;
    tone('sine', 523.25, 0.12, 0.05, 0, null, null, null, 0.006);
  }, 2400);

  return !!ACTX;
}

/** ② 目标达成：C-E-G-C 上行琶音，90ms 间隔，尾部一记泛音化开 */
function achieve() {
  if (!soundEnabled()) return false;
  unlock();
  const ns = [[523.25, 0.42, 0.13], [659.25, 0.40, 0.12], [783.99, 0.38, 0.11], [1046.50, 0.62, 0.10]];
  for (let i = 0; i < ns.length; i++) {
    tone('sine', ns[i][0], ns[i][1], ns[i][2], i * 0.09, null, null, null, 0.008);
  }
  tone('sine', 2093, 0.5, 0.028, 0.40, 2093, null, null, 0.02);
  return !!ACTX;
}

/** ③ 保存成功：两音轻点，比 +1 收敛 */
function saved() {
  if (!soundEnabled()) return false;
  unlock();
  tone('sine', 880, 0.11, 0.075, 0, null, null, null, 0.005);
  tone('sine', 1174.66, 0.13, 0.055, 0.07, null, null, null, 0.005);
  return !!ACTX;
}

/** ④ 休息日：比 +1 低一个大三度，音区更低 */
function rest() {
  if (!soundEnabled()) return false;
  unlock();
  tone('sine', 392, 0.20, 0.095, 0, null, null, null, 0.008);
  tone('sine', 587.33, 0.22, 0.07, 0.09, null, null, null, 0.008);
  return !!ACTX;
}

/** ⑤ 错误：两声柔和的下行小三度，全程低通 */
function error() {
  if (!soundEnabled()) return false;
  unlock();
  tone('sine', 392, 0.17, 0.10, 0, 349.23, 900, 0.6, 0.006);
  tone('sine', 311.13, 0.22, 0.09, 0.11, 293.66, 900, 0.6, 0.006);
  return !!ACTX;
}

/**
 * ⑥ 界面轻触：25ms 一声极轻的正弦。
 * 合成失败才退回 wav —— 两条路是互斥的，不会同时响。
 */
function tap() {
  if (!soundEnabled()) return false;
  unlock();
  const ok = tone('sine', 1174.66, 0.025, 0.038, 0, null, null, null, 0.001);
  if (ok) return true;
  return playWav(false);
}

/** ⑦ 开关切换：开就上行，关就下行 */
function toggle(on) {
  if (!soundEnabled()) return false;
  unlock();
  if (on) tone('sine', 880, 0.055, 0.045, 0, 1174.66, null, null, 0.003);
  else tone('sine', 1174.66, 0.065, 0.05, 0, 880, null, null, 0.003);
  return !!ACTX;
}

/** ⑧ 撤销：+1 的镜像，G5 落回 E5 */
function undo() {
  if (!soundEnabled()) return false;
  unlock();
  tone('sine', 783.99, 0.10, 0.082, 0, 783.99, null, 2400, 0.7, 0.004);
  tone('sine', 659.25, 0.14, 0.062, 0.075, 659.25, null, 2000, 0.7, 0.005);
  return !!ACTX;
}

/** ⑨ 今日达标：C-E-G 三音，音区更高、尾巴更短，和 achieve 一耳朵分得开 */
function todayDone() {
  if (!soundEnabled()) return false;
  unlock();
  tone('sine', 659.25, 0.24, 0.105, 0, 659.25, null, null, 0.006);
  tone('sine', 783.99, 0.24, 0.095, 0.075, 783.99, null, null, 0.006);
  tone('sine', 1046.50, 0.44, 0.090, 0.15, 1046.50, null, null, 0.008);
  return !!ACTX;
}

/* ================= 试听 ================= */

/**
 * 试听：与 +1 第一击完全同一套合成音色和音量链路。
 *
 * 不再走 wav：wav 与合成音是两套响度基准，试听会明显比实际按键响
 * （2026-10-27 用户反馈「展示音量比实际大」）。用合成音后，试听听到的
 * 就是实际 +1 的响度；临时音量通过 FORCE_PCT 传入，不写设置。
 */
function preview(pct) {
  const v = clampVolume(typeof pct === 'number' && isFinite(pct) ? pct : volumePct());
  const ctx = audioCtx();
  if (!ctx) return playWav(true, v);

  unlock();
  FORCE_PCT = v;
  try {
    tone('sine', 220, 0.035, 0.042, 0, 180, null, null, 0.002);
    tone('triangle', 659.25, 0.09, 0.105, 0, 659.25, null, 2600, 0.7, 0.003);
    tone('sine', 1318.5, 0.05, 0.038, 0, 1318.5, null, null, 0.002);
  } finally {
    FORCE_PCT = null;
  }
  return !!ACTX;
}

/** 释放资源 */
function destroy() {
  if (comboFallTimer) { clearTimeout(comboFallTimer); comboFallTimer = null; }
  if (wavCtx) {
    try { wavCtx.destroy(); } catch (e) { /* 已销毁 */ }
    wavCtx = null;
  }
  if (ACTX) {
    try { ACTX.close(); } catch (e) { /* 已关闭 */ }
    ACTX = null; MASTER = null; MASTER_CTX = null; VOLUME = null; VOLUME_CTX = null; COMP = null; COMP_CTX = null;
  }
}

module.exports = {
  /* 音色 */
  plus1: plus1,
  achieve: achieve,
  saved: saved,
  rest: rest,
  error: error,
  tap: tap,
  toggle: toggle,
  undo: undo,
  todayDone: todayDone,
  preview: preview,
  preload: preload,
  destroy: destroy,

  /* 纯函数（测试与 UI 用） */
  gainFromVolume: gainFromVolume,
  masterGain: masterGain,
  clampVolume: clampVolume,
  volumePct: volumePct,
  soundEnabled: soundEnabled,
  comboFreq: comboFreq,
  comboVolume: comboVolume,

  MIN_PCT: MIN_PCT,
  MAX_PCT: MAX_PCT,
  COMBO_STEPS: COMBO_STEPS,
  BASE_HZ: BASE_HZ
};
