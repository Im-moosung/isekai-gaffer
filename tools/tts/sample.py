#!/usr/bin/env python3
"""구워 둔 클립을 **런타임과 같은 규칙으로** 이어 붙여 들려줄 샘플을 만든다.

숫자로는 음역이 맞는지 판정할 수 없다 — `f0.py`는 numpy 없는 순수 파이썬
자기상관이라 짧은 조각에서 옥타브 배증 오검출이 나고, 실제로 이번 실측에서
기준 배치(C01)의 **자체** 산포가 6.4반음으로 나왔다(그럴 리 없다).
그래서 판정은 귀로 한다. 이 스크립트는 그 판정 재료를 만든다.

런타임(`src/audio/commentary-mp3.ts`)과 같은 규칙을 쓴다:
  · 한 줄 안의 조각 사이 = `index.json.gapMs`(90ms)
  · 줄과 줄 사이 = 입장 연출의 비트 간격(기본 260ms)

**배치 경계를 넘는 조합을 반드시 넣는다** — 같은 문장 뒤에 다른 요청에서 온
이름을 붙여야 "요청이 갈리면 딴사람이 되는가"를 들을 수 있다.

    python3 tools/tts/sample.py --outdir docs/audio/tts-samples
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

PUB = "public/tts"


def clips_for(index: dict, speech: str) -> list[str] | None:
    """commentary-mp3.ts의 resolveClips와 **같은 규칙**. 어긋나면 샘플이 거짓말이 된다."""
    s = speech.strip()
    c = index["clips"]
    if s in c:
        return [c[s]]
    i = s.find(", ")
    if i > 0:
        head, tail = c.get(s[: i + 1]), c.get(s[i + 2:])
        if head and tail:
            return [head, tail]
    return None


def build(index: dict, lines: list[str], out: str, beat_ms: int) -> bool:
    gap = index.get("gapMs", 90) / 1000
    files: list[str] = []
    gaps: list[float] = []
    for li, line in enumerate(lines):
        keys = clips_for(index, line)
        if not keys:
            print(f"  ! 클립 없음(건너뜀): {line}", file=sys.stderr)
            return False
        for ki, k in enumerate(keys):
            if files:
                gaps.append(gap if ki > 0 else beat_ms / 1000)
            files.append(os.path.join(PUB, f"{k}.mp3"))
    parts, labels = [], []
    for i, f in enumerate(files):
        parts.append(f"[{i}:a]aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=mono[a{i}]")
        labels.append(f"[a{i}]")
        if i < len(files) - 1:
            parts.append(f"anullsrc=r=24000:cl=mono,atrim=0:{gaps[i]:.3f},"
                         f"aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=mono[g{i}]")
            labels.append(f"[g{i}]")
    filt = ";".join(parts) + ";" + "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[out]"
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    for f in files:
        cmd += ["-i", f]
    cmd += ["-filter_complex", filt, "-map", "[out]", "-c:a", "libmp3lame", "-b:a", "96k", out]
    subprocess.run(cmd, check=True)
    return True


# 무엇을 듣는가를 파일명에 적는다 — 나중에 이 폴더만 보고도 판정 의도를 안다.
SAMPLES: list[tuple[str, str, list[str]]] = [
    ("01-한줄-이음매-같은배치", "`골키퍼,`(C03) + `김승규입니다.`(C03) — 한 줄 안의 이음매 하나", [
        "골키퍼, 김승규입니다.",
    ]),
    ("02-한줄-이음매-배치경계", "`골키퍼,`(C03) + `김태현입니다.`(**C04**) — 요청이 다른 두 조각", [
        "골키퍼, 김태현입니다.",
    ]),
    ("03-수비묶음-C03만", "그룹 도입(C01) + 이름 넷(C03) — 한 요청 안의 이름들", [
        "네 명의 수비가 출전합니다.", "이한범,", "이기혁,", "김민재,", "이한범입니다.",
    ]),
    ("04-수비묶음-C03과C04혼합", "같은 그룹 도입(C01) + **C03·C04가 섞인** 이름 다섯", [
        "네 명의 수비가 출전합니다.", "이한범,", "김태현,", "황인범,", "손흥민,", "백승호,",
    ]),
    ("05-입장-앞부분-통짜", "실제 입장 순서 그대로 — 팀 도입(C01) → 골키퍼 → 수비 묶음", [
        "대한민국 선발 라인업입니다. 사 이 삼 일 대형.",
        "골키퍼, 김승규입니다.",
        "네 명의 수비가 출전합니다.",
        "이한범,", "이기혁,", "김민재,", "김태현입니다.",
    ]),
    ("06-중원과-해설-마무리", "중원 묶음 + **해설위원**(A14, 다른 모델) 받는 말", [
        "중앙에는 다섯 명이 섭니다.",
        "황인범,", "손흥민,", "백승호,", "손흥민입니다.",
        "포백입니다. 좌우 풀백이 얼마나 올라오느냐를 보시죠.",
    ]),
    ("07-팀도입-연속", "팀 도입 문장만 연달아(C01·C02) — 문장끼리의 음역 대조군", [
        "대한민국 선발 라인업입니다. 사 삼 삼 대형.",
        "체코 선발 라인업입니다. 삼 오 이 대형.",
        "멕시코 선발 라인업입니다. 사 삼 삼 대형.",
        "프랑스 선발 라인업입니다. 사 삼 삼 대형.",
    ]),
    ("08-이름만-연속-두배치", "이름만 연달아 — C03 넷 → C04 넷. **여기서 갈리면 배치가 범인이다**", [
        "김승규,", "이한범,", "이기혁,", "김민재,",
        "김태현,", "황인범,", "손흥민,", "백승호,",
    ]),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="docs/audio/tts-samples")
    ap.add_argument("--beat-ms", type=int, default=260)
    a = ap.parse_args()

    with open(os.path.join(PUB, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    os.makedirs(a.outdir, exist_ok=True)

    rows = []
    for name, why, lines in SAMPLES:
        out = os.path.join(a.outdir, f"{name}.mp3")
        print(f"{out}")
        if build(index, lines, out, a.beat_ms):
            rows.append((name, why, lines))
        else:
            print(f"  (클립이 아직 없어 건너뛴다)")
    print(f"\n샘플 {len(rows)}개 / {a.outdir}")


if __name__ == "__main__":
    main()
