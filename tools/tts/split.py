#!/usr/bin/env python3
"""배치 wav를 무음 기준으로 조각내고, gen.py가 남긴 원문과 짝지어 이름을 붙인다.

`silencedetect=noise=-40dB:d=0.6` — 실측에서 문장 사이 쉼이 2.2~2.5초라
0.6초 문턱이면 문장 내부의 쉼표 쉼(≲0.3초)과 확실히 갈린다. 8/8 정확히 갈렸다.

조각 수가 원문 수와 다르면 **조용히 넘어가지 않고 실패한다** — 어긋난 채로
붙이면 엉뚱한 이름이 나가고, 그건 재생 시점에야 들킨다.

    python3 tools/tts/split.py out/batch.wav --outdir out/clips [--trim 0.04]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

NOISE = "-40dB"
MIN_SIL = 0.6


def duration(path: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())


def silences(path: str, noise: str, d: float) -> list[tuple[float, float]]:
    r = subprocess.run(
        ["ffmpeg", "-i", path, "-af", f"silencedetect=noise={noise}:d={d}",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    starts = [float(m) for m in re.findall(r"silence_start: ([\d.]+)", r.stderr)]
    ends = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    if len(ends) < len(starts):  # 끝이 무음으로 끝나면 silence_end가 없다
        ends.append(duration(path))
    return list(zip(starts, ends))


def segments(path: str, noise: str, d: float) -> list[tuple[float, float]]:
    """발화 구간 [(start, end)]. 앞뒤 무음은 버린다."""
    total = duration(path)
    sil = silences(path, noise, d)
    segs: list[tuple[float, float]] = []
    cursor = 0.0
    for s, e in sil:
        if s - cursor > 0.15:  # 0.15초 미만 조각은 파열음 잔향이지 문장이 아니다
            segs.append((cursor, s))
        cursor = e
    if total - cursor > 0.15:
        segs.append((cursor, total))
    return segs


def slug(text: str, i: int) -> str:
    s = re.sub(r"[^\w가-힣]+", "_", text).strip("_")[:24]
    return f"{i:02d}_{s or 'seg'}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--noise", default=NOISE)
    ap.add_argument("--min-sil", type=float, default=MIN_SIL)
    ap.add_argument("--trim", type=float, default=0.03,
                    help="조각 앞뒤로 남길 여유(초). 0이면 어두 자음이 깎일 수 있다.")
    ap.add_argument("--names", nargs="*", default=None, help="조각 파일명을 직접 지정")
    a = ap.parse_args()

    segs = segments(a.wav, a.noise, a.min_sil)
    meta_path = os.path.splitext(a.wav)[0] + ".lines.json"
    lines = None
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            lines = json.load(f)["lines"]

    print(f"조각 {len(segs)}개 검출" + (f" / 원문 {len(lines)}개" if lines else ""))
    for i, (s, e) in enumerate(segs):
        print(f"  {i:02d}  {s:6.2f}–{e:6.2f}  ({e - s:4.2f}s)"
              + (f"  {lines[i]}" if lines and i < len(lines) else ""))

    if lines is not None and len(segs) != len(lines):
        sys.exit(
            f"\n조각 수({len(segs)}) != 원문 수({len(lines)}). 붙이면 엉뚱한 소리가 나간다.\n"
            f"--noise / --min-sil을 조정해 다시 시도하라. **재생성(API 요청)은 마지막 수단이다.**"
        )

    os.makedirs(a.outdir, exist_ok=True)
    total = duration(a.wav)
    for i, (s, e) in enumerate(segs):
        name = (a.names[i] if a.names and i < len(a.names)
                else slug(lines[i] if lines else "", i))
        out = os.path.join(a.outdir, f"{name}.wav")
        ss = max(0.0, s - a.trim)
        to = min(total, e + a.trim)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", a.wav,
             "-ss", f"{ss:.3f}", "-to", f"{to:.3f}", "-c", "copy", out],
            check=True,
        )
        print(f"  -> {out}")


if __name__ == "__main__":
    main()
