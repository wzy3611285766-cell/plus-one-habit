"""
生成「界面轻触」音效的 WAV 文件。

参数照搬 v3_work/work.html 里的 SFX.tap()：
    tone("sine", 1174.66, 0.025, 0.038, 0, 0, null, null, 0.001)

    波形       sine（纯正弦）
    基频       1174.66 Hz   ≈ D6
    时长       0.025 s      = 25 毫秒
    起音       0.001 s      = 1 毫秒
    低通/滑音  无

包络（与 Web Audio 的 exponentialRampToValueAtTime 一致）：
    0 → 1ms     指数上升  0.0001  → 0.038
    1ms → 25ms  指数下降  0.038   → 0.0001

------------------------------------------------------------------
关于「基准」与「百分比」—— 这是两个概念，不要混：

    -3 dBFS 的那一版，是 100% 基准（REFERENCE_PEAK_DB）
    任何百分比，都是在基准上做「幅度 × 百分比」：
        新峰值(dBFS) = 基准(dBFS) + 20 * log10(百分比)
    例：60% → 20*log10(0.6) = -4.44 dB → -3 + (-4.44) = -7.44 dBFS

    注意这是「幅度百分比」，不是「听感响度百分比」。
    人耳对响度的感受更接近对数，所以 60% 幅度听起来大约是
    「轻了一点点」，而不是「音量只剩六成」。这在 UI 反馈音里正合适。

用法：
    python make_tap.py              生成 100% 基准 + 60% 默认两份
    python make_tap.py 40           额外生成 40% 的版本
"""

import math
import os
import sys
import wave
import array

# ---------- 合成参数（与 H5 一致，不要随百分比变化） ----------
SR = 44100              # 采样率
FREQ = 1174.66          # 基频 Hz
DUR = 0.025             # 发声时长 25ms
ATTACK = 0.001          # 起音 1ms
V_START = 0.0001        # 包络起点（Web Audio 的指数斜坡不能从 0 开始）
V_PEAK = 0.038          # 包络峰值
TAIL = 0.075            # 尾部静音，方便播放器与编辑器识别

# ---------- 电平 ----------
# 100% 基准的峰值。选 -3 dBFS 而不是贴到 0 dBFS，
# 是为了给「往上调」留余量，也避免在不同设备上削顶。
REFERENCE_PEAK_DB = -3.0
DEFAULT_PERCENT = 60    # 需要调小到的默认档位

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def envelope(t):
    """复刻 Web Audio 的两段指数斜坡。t 单位秒。"""
    if t < 0:
        return 0.0
    if t < ATTACK:
        return V_START * (V_PEAK / V_START) ** (t / ATTACK)
    if t < DUR:
        p = (t - ATTACK) / (DUR - ATTACK)
        return V_PEAK * (V_START / V_PEAK) ** p
    return 0.0


def build_shape():
    """生成归一化到 1.0 的波形（不带绝对电平），百分比只影响最后的缩放。"""
    n_sound = int(round(DUR * SR))
    n_tail = int(round(TAIL * SR))
    n_total = n_sound + n_tail

    raw = []
    for i in range(n_total):
        if i >= n_sound:
            raw.append(0.0)
            continue
        t = i / SR
        raw.append(math.sin(2 * math.pi * FREQ * t) * envelope(t))

    peak = max(abs(v) for v in raw) or 1.0
    return [v / peak for v in raw], n_total


def frames_at(shape, peak_amplitude):
    """把归一化波形缩放到指定的峰值幅度，转 16 位整数。"""
    out = array.array('h')
    for v in shape:
        s = max(-1.0, min(1.0, v * peak_amplitude))
        out.append(int(round(s * 32767)))
    return out


def write_wav(path, frames):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(frames.tobytes())


def peak_amplitude_for(percent):
    """percent 的相对电平 → 绝对峰值幅度。

    先算百分比带来的 dB 变化，再叠加到基准 dB 上，最后换算成线性幅度。
    """
    delta_db = 20.0 * math.log10(percent / 100.0)
    peak_db = REFERENCE_PEAK_DB + delta_db
    return 10 ** (peak_db / 20.0), delta_db, peak_db


def emit(shape, percent, filename):
    amp, delta_db, peak_db = peak_amplitude_for(percent)
    path = os.path.join(OUT_DIR, filename)
    write_wav(path, frames_at(shape, amp))
    print('  %-26s %5.1f%%   峰值 %6.2f dBFS   Δ %+.2f dB   文件 %5.1f KB'
          % (filename, percent, peak_db, delta_db, os.path.getsize(path) / 1024))


def main():
    extra = []
    for a in sys.argv[1:]:
        try:
            v = float(a.strip().rstrip('%'))
            if 0 < v <= 200:
                extra.append(v)
        except ValueError:
            pass

    shape, n_total = build_shape()

    print('「界面轻触」音效 · %.0f ms（发声 %.0f + 静音 %.0f）· %d Hz · 单声道 16 bit'
          % (n_total / SR * 1000, DUR * 1000, TAIL * 1000, SR))

    emit(shape, 100, '按键音效-轻触.wav')
    emit(shape, DEFAULT_PERCENT, '按键音效-轻触-%d.wav' % DEFAULT_PERCENT)
    for v in extra:
        emit(shape, v, '按键音效-轻触-%g.wav' % v)

    print()
    print('  100% 版是「基准」：用它当参照，或给带音量控制的宿主用。')
    print('  {}% 版是「默认档」：直接丢进没有音量控制的地方也合适。'.format(DEFAULT_PERCENT))


if __name__ == '__main__':
    main()
