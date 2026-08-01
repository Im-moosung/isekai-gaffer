#!/usr/bin/env python3
"""이름 클립의 **끝 억양**을 수치로 잰다 — 귀 판정에 붙일 객관 근거.

## 왜 필요한가
이름을 단독으로 읽히면 문장 끝처럼 어조가 **내려간다**. 그 이름을 문장 앞이나
중간에 붙이면 "이름에서 한 번 끝났다가 다시 시작"하는 소리가 난다. 이게 이음매의
핵심 결함이라, "내려갔는가"를 귀 말고 숫자로도 확인해야 A안/B안을 가를 수 있다.

## 방법
ffmpeg로 8kHz 모노 s16le로 뽑아 자기상관(autocorrelation)으로 프레임별 F0를 낸다.
numpy가 없는 환경이라 순수 파이썬이다 — 8kHz·프레임 512·홉 128이면 충분히 빠르다.
유성음 프레임만 남기고, 클립 끝 `--tail`초 구간의 F0를 반음(semitone) 기울기로 낸다.

판정 기준(경험칙):
  - 끝 기울기 **≤ -2 반음**  종결 하강. 문장 앞/중간에 붙이면 이음매가 들린다.
  - **-2 ~ +1 반음**        평탄. 이어 붙이기에 적합.
  - **≥ +1 반음**           상승. 연속(continuation) 어조 — 붙이기에 가장 좋다.

    python3 tools/tts/f0.py clip.wav [clip2.wav ...] [--tail 0.35]
"""
from __future__ import annotations

import argparse
import array
import math
import subprocess
import sys

SR = 8000
FRAME = 512
HOP = 128
F0_MIN, F0_MAX = 70.0, 320.0
LAG_MIN = int(SR / F0_MAX)   # 25
LAG_MAX = int(SR / F0_MIN)   # 114


def load(path: str) -> array.array:
    r = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ar", str(SR),
         "-ac", "1", "-"],
        capture_output=True, check=True,
    )
    a = array.array("h")
    a.frombytes(r.stdout)
    return a


def f0_track(x: array.array) -> list[tuple[float, float, float]]:
    """[(시각초, F0Hz 또는 0, RMS)] — F0=0이면 무성음/무음."""
    out = []
    n = len(x)
    for start in range(0, max(0, n - FRAME), HOP):
        f = x[start:start + FRAME]
        energy = sum(v * v for v in f)
        rms = math.sqrt(energy / FRAME)
        if rms < 200:  # 무음
            out.append((start / SR, 0.0, rms))
            continue
        mean = sum(f) / FRAME
        f = [v - mean for v in f]
        r0 = sum(v * v for v in f) or 1.0
        best_lag, best_r = 0, 0.0
        for lag in range(LAG_MIN, LAG_MAX + 1):
            s = 0.0
            for i in range(FRAME - lag):
                s += f[i] * f[i + lag]
            r = s / r0
            if r > best_r:
                best_r, best_lag = r, lag
        # 0.30은 자기상관 정규화 문턱 — 이하면 유성음으로 보지 않는다.
        out.append((start / SR, SR / best_lag if best_r > 0.30 and best_lag else 0.0, rms))
    return out


def tail_slope(track: list[tuple[float, float, float]], tail: float) -> tuple[float, int, float]:
    """끝 tail초 구간 유성 프레임의 반음 기울기(전체 구간 변화량), 프레임 수, 중앙 F0."""
    if not track:
        return 0.0, 0, 0.0
    end = track[-1][0]
    # 끝의 무음 꼬리는 빼고 마지막 유성 프레임을 기준으로 삼는다.
    voiced_all = [t for t in track if t[1] > 0]
    if len(voiced_all) < 4:
        return 0.0, len(voiced_all), 0.0
    end = voiced_all[-1][0]
    seg = [t for t in voiced_all if t[0] >= end - tail]
    if len(seg) < 4:
        seg = voiced_all[-4:]
    # 옥타브 오검출 제거: 중앙값의 0.6~1.7배만 남긴다
    fs = sorted(t[1] for t in seg)
    med = fs[len(fs) // 2]
    seg = [t for t in seg if 0.6 * med <= t[1] <= 1.7 * med]
    if len(seg) < 3:
        return 0.0, len(seg), med
    xs = [t[0] for t in seg]
    ys = [12 * math.log2(t[1] / med) for t in seg]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs) or 1e-9
    slope_per_s = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den
    return slope_per_s * (xs[-1] - xs[0]), len(seg), med


def verdict(st: float) -> str:
    if st <= -2.0:
        return "종결 하강 — 이어 붙이면 이음매가 들린다"
    if st >= 1.0:
        return "상승(연속 어조) — 붙이기 좋다"
    return "평탄 — 붙이기 적합"


def max_jump(track: list[tuple[float, float, float]]) -> tuple[float, float]:
    """이웃한 유성 프레임 사이의 최대 F0 도약(반음, 절댓값)과 그 시각.

    이어 붙인 파일에서 이음매는 **음높이가 튀는 지점**으로 나타난다. 통문장
    대조군에도 자연스러운 도약은 있으므로, 둘을 비교해야 의미가 있다.
    옥타브 오검출을 걸러내려고 12반음(=2배) 이상 도약은 무시한다.
    """
    v = [t for t in track if t[1] > 0]
    best, at = 0.0, 0.0
    for (t0, f0a, _), (t1, f0b, _) in zip(v, v[1:]):
        if t1 - t0 > 0.20:  # 무성 구간을 건너뛴 쌍은 이음매 판단에 못 쓴다
            continue
        d = abs(12 * math.log2(f0b / f0a))
        if d > 12:
            continue
        if d > best:
            best, at = d, t1
    return best, at


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="+")
    ap.add_argument("--tail", type=float, default=0.35, help="끝 몇 초를 볼지")
    ap.add_argument("--jump", action="store_true", help="최대 음높이 도약(이음매 지표)도 낸다")
    a = ap.parse_args()
    for c in a.clips:
        tr = f0_track(load(c))
        st, n, med = tail_slope(tr, a.tail)
        name = c.rsplit("/", 1)[-1]
        line = (f"{name:44s} 중앙F0 {med:5.1f}Hz  끝{a.tail:.2f}s 기울기 "
                f"{st:+5.2f}반음 (n={n:2d})")
        if a.jump:
            j, at = max_jump(tr)
            line += f"  최대도약 {j:5.2f}반음 @{at:5.2f}s"
        else:
            line += f"  {verdict(st)}"
        print(line)


if __name__ == "__main__":
    main()
