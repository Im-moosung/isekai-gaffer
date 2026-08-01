#!/usr/bin/env python3
"""**배치 크기가 음역을 얼마나 흩뜨리는가**를 잰다. API를 부르지 않는다.

## 왜 이걸 재는가
프로토가 이미 반증했다 — 캐리어 16개를 한 요청에 넣으면 조각마다 중앙 F0가
템플릿 기준 **3.2~13.2반음**으로 흩어져, `--match-register`가 당길 수 있는
±5반음 밖으로 **12/16이 나가** 구제 불가였다. 2~4개에서는 2반음 이내였다.
5~15는 아무도 안 재 본 구간이라, 그 구간을 실제 배치로 재는 게 이 도구다.

자르기가 정확한 것과 음역이 맞는 것은 **다른 문제**다. 32/32로 갈렸다는 것은
조각 경계가 맞다는 뜻이지 조각들이 같은 사람 목소리로 들린다는 뜻이 아니다.

## 판정
`f0.py`는 numpy 없는 환경의 순수 파이썬 자기상관이라 짧은 조각에서 옥타브
배증 오검출이 난다. 그래서 **절대 Hz가 아니라 같은 추정기·같은 조건의 상대
비교**만 본다 — 프로토의 A/B 판정도 같은 근거로 유효했다.

    python3 tools/tts/register.py                 # 받아 둔 배치 전부
    python3 tools/tts/register.py --only C03,C04
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import split as sp  # noqa: E402
import join as jn  # noqa: E402

MANIFEST = "docs/audio/tts/manifest.json"
RAW_DIR = "out/tts/raw"
WORK_DIR = "out/tts/work"

# `--match-register`가 당길 수 있는 한도. 이 밖은 다시 뽑는 수밖에 없다.
LIMIT = 5.0


def norm_path(bid: str) -> str:
    """loudnorm만 건 배치. 자르기·재기 둘 다 이 파일에서 한다."""
    out = os.path.join(WORK_DIR, f"{bid}.norm.wav")
    if not os.path.exists(out):
        os.makedirs(WORK_DIR, exist_ok=True)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(RAW_DIR, f"{bid}.wav"),
             "-af", jn.LOUDNORM, "-ar", "24000", "-ac", "1", out],
            check=True,
        )
    return out


def pieces(bid: str, batch: dict, min_sil: float, noise: str):
    """조각별 (라벨, 중앙 F0). 조각 수가 기대와 다르면 그대로 알린다."""
    path = norm_path(bid)
    segs = sp.segments(path, noise, min_sil)
    exp = batch["pieces"] * len(batch["lines"])
    total = sp.duration(path)
    out = []
    for i, (s, e) in enumerate(segs):
        cutf = os.path.join(WORK_DIR, f"{bid}.f0.{i:03d}.wav")
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
             "-ss", f"{max(0.0, s - 0.03):.3f}", "-to", f"{min(total, e + 0.03):.3f}",
             "-c", "copy", cutf], check=True,
        )
        out.append((i, jn.median_f0(cutf), e - s))
    return out, segs, exp


def dur_of(bid: str) -> float:
    return sp.duration(os.path.join(RAW_DIR, f"{bid}.wav"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--only", default=None)
    ap.add_argument("--min-sil", type=float, default=0.35)
    ap.add_argument("--noise", default="-40dB")
    a = ap.parse_args()

    with open(a.manifest, encoding="utf-8") as f:
        man = json.load(f)
    only = set(a.only.split(",")) if a.only else None

    ready = [b for b in man["batches"]
             if os.path.exists(os.path.join(RAW_DIR, f"{b['id']}.wav"))
             and (not only or b["id"] in only)]
    if not ready:
        sys.exit("받아 둔 배치가 없다.")

    # 기준 음역 = 캐스터 plain 배치의 조각 중앙값. 템플릿이 정본이다.
    target = 0.0
    data = {}
    for b in ready:
        rows, segs, exp = pieces(b["id"], b, a.min_sil, a.noise)
        data[b["id"]] = (b, rows, len(segs), exp)
        if target == 0.0 and b["speaker"] == "caster" and b["kind"] == "plain":
            vals = sorted(r[1] for r in rows if r[1] > 0)
            target = vals[len(vals) // 2] if vals else 0.0
    if target <= 0:
        sys.exit("기준을 잴 캐스터 plain 배치가 없다.")

    # ★ 옥타브 접기. f0.py는 numpy 없는 순수 파이썬 자기상관이라 **짧은 조각에서
    #   옥타브 배증 오검출**이 난다(프로토 README가 스스로 적어 둔 한계다). 이름 조각은
    #   0.5~1초라 정확히 그 구간이다. 기준의 1.5배를 넘으면 반으로 접어 같은 옥타브에서
    #   비교한다 — 접기 전후를 나란히 찍어 사람이 판정할 수 있게 둔다.
    def fold(v: float) -> float:
        while v > target * 1.5:
            v /= 2
        while v < target / 1.5:
            v *= 2
        return v

    print(f"\n# 배치 크기 ↔ 음역 흩어짐 실측\n")
    print(f"기준 음역(캐스터 plain 배치의 조각 중앙값) **{target:.1f} Hz**")
    print(f"판정선: 기준과 **±{LIMIT:.0f}반음** 안이면 `--match-register`로 구제된다.\n")
    print("| 배치 | 문장 | 조각/기대 | 길이 | 옥타브 접은 뒤 5반음 내 | 배치 오프셋 | **배치 내 산포** |")
    print("|---|---:|---|---:|---|---:|---:|")
    for bid, (b, rows, nseg, exp) in data.items():
        vals = [fold(r[1]) for r in rows if r[1] > 0]
        if not vals:
            continue
        devs = [abs(12 * math.log2(v / target)) for v in vals]
        inside = sum(1 for d in devs if d <= LIMIT)
        med = sorted(vals)[len(vals) // 2]
        offset = 12 * math.log2(med / target)
        # ★ 배치 내 산포 = **한 번의 균일 이동으로는 없앨 수 없는** 부분.
        #   오프셋은 --match-register가 통째로 당겨 준다. 이 값이 진짜 위험 지표다.
        spread = 12 * math.log2(max(vals) / min(vals))
        ok = nseg == exp
        print(f"| {bid} | {b['kind']} {len(b['lines'])} | {nseg}/{exp} {'✓' if ok else '**✗**'} "
              f"| {dur_of(bid):.0f}s | **{inside}/{len(devs)}** ({inside / len(devs) * 100:.0f}%) "
              f"| {offset:+.1f}반음 | **{spread:.1f}반음** |")

    for bid, (b, rows, nseg, exp) in data.items():
        if b["kind"] != "carrier":
            continue
        print(f"\n## {bid} — 캐리어 {len(b['lines'])}개, 조각별 편차")
        print("| # | 쓰는 조각 | 텍스트 | F0 | 편차 |")
        print("|---:|---|---|---:|---:|")
        for i, (idx, f0v, dur) in enumerate(rows):
            # 매니페스트가 이 조각을 쓰는가(head/tail)
            item = None
            for k, it in enumerate(b["items"]):
                want = k * 2 + (1 if it["cut"] == "tail" else 0)
                if want == idx:
                    item = it
                    break
            fv = fold(f0v) if f0v > 0 else 0.0
            dev = abs(12 * math.log2(fv / target)) if fv > 0 else float("nan")
            mark = "" if item is None else ("✓" if dev <= LIMIT else "**✗**")
            print(f"| {idx} | {mark or '·'} | {item['text'] if item else '(버리는 조각)'} "
                  f"| {f0v:.0f}→{fv:.0f} | {dev:.1f} |")


if __name__ == "__main__":
    main()
