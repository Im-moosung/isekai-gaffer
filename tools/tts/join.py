#!/usr/bin/env python3
"""조각을 이어 붙여 한 문장으로 만들고 배포 규격으로 굽는다.

이 프로젝트의 TTS 예산(사용자 승인):
  - 속도     atempo=1.15
  - 라우드니스 loudnorm=I=-16:TP=-1.5:LRA=11
  - 출력     mp3 128k (원본 24kHz 모노 PCM)

## 이음매(gap) 설계
조각을 0초로 붙이면 "이름끝+문장첫음"이 한 음절처럼 뭉개진다. 반대로 200ms를
주면 두 번 녹음한 티가 난다. 기본 90ms — 한국어 쉼표 휴지(80~150ms)의 아래끝이라
"이름, 문장" 형태에서 자연스럽다. 조사가 붙는 경우엔 조사를 **이름 조각에 포함**
시키므로(연음 보존) 이음매는 여전히 어절 경계에 놓인다.

    python3 tools/tts/join.py --out docs/audio/tts-proto/x.mp3 \
        --gap 0.09 a.wav b.wav [c.wav ...]
    python3 tools/tts/join.py --out y.mp3 --raw whole.wav   # 통문장도 같은 규격으로
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile

ATEMPO = 1.15
LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"
SR = 24000


# 조각 앞뒤에 남은 무음을 먼저 깎는다. 이걸 안 하면 --gap이 의미를 잃는다 —
# 잘라낸 조각마다 앞뒤 여백이 제각각이라 이음매 길이가 조각 조합마다 달라진다.
# 문턱을 -50dB로 두어 여린 어두 자음(ㅎ·ㅅ)을 깎지 않는다.
_TRIM = ("silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,"
         "areverse,"
         "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,"
         "areverse")


def build_filter(n: int, gap: float, atempo: float, loudnorm: bool, trim: bool) -> str:
    """조각 사이에 gap초 무음을 끼우고 concat → atempo → loudnorm."""
    parts = []
    labels = []
    pre = (_TRIM + ",") if trim else ""
    for i in range(n):
        parts.append(f"[{i}:a]{pre}aformat=sample_fmts=s16:sample_rates={SR}:channel_layouts=mono[a{i}]")
        labels.append(f"[a{i}]")
        if i < n - 1 and gap > 0:
            # 무음은 매 이음매마다 새 소스로 만든다 — 같은 라벨을 재사용하면 ffmpeg가 거부한다.
            parts.append(
                f"anullsrc=r={SR}:cl=mono,atrim=0:{gap:.3f},"
                f"aformat=sample_fmts=s16:sample_rates={SR}:channel_layouts=mono[g{i}]"
            )
            labels.append(f"[g{i}]")
    chain = "".join(parts and [";".join(parts), ";"] or [])
    chain += "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[c]"
    post = f"[c]atempo={atempo}"
    if loudnorm:
        post += f",{LOUDNORM}"
    post += "[out]"
    return chain + ";" + post


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--gap", type=float, default=0.09, help="조각 사이 무음(초)")
    ap.add_argument("--atempo", type=float, default=ATEMPO)
    ap.add_argument("--no-loudnorm", action="store_true")
    ap.add_argument("--raw", action="store_true",
                    help="조각이 하나뿐(통문장 대조군)일 때. gap 무시.")
    ap.add_argument("--no-trim", action="store_true", help="조각 앞뒤 무음 깎기를 끈다")
    ap.add_argument("clips", nargs="+")
    a = ap.parse_args()

    if a.raw and len(a.clips) != 1:
        sys.exit("--raw는 조각 하나만 받는다.")
    for c in a.clips:
        if not os.path.exists(c):
            sys.exit(f"없는 조각: {c}")

    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    gap = 0.0 if a.raw else a.gap
    filt = build_filter(len(a.clips), gap, a.atempo, not a.no_loudnorm, not a.no_trim)
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for c in a.clips:
        cmd += ["-i", c]
    cmd += ["-filter_complex", filt, "-map", "[out]",
            "-c:a", "libmp3lame", "-b:a", "128k", a.out]
    subprocess.run(cmd, check=True)
    print(f"{a.out}  ← 조각 {len(a.clips)}개, gap {gap * 1000:.0f}ms, "
          f"atempo {a.atempo}, {'loudnorm' if not a.no_loudnorm else 'raw level'}")


if __name__ == "__main__":
    main()
