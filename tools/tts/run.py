#!/usr/bin/env python3
"""매니페스트대로 배치를 굽는다. **재개 가능** — 이미 받은 배치는 건너뛴다.

## 왜 재개가 필수인가
모델당 RPD 10이 하드 리밋이고, 실측에서 HTTP 500도 났다. 중간에 끊기면
처음부터 다시 도는 스크립트는 그 자체로 한도를 태운다. 그래서 **원본 wav가
곧 체크포인트**다 — `out/raw/{배치}.wav`가 있으면 그 배치는 요청하지 않는다.
자르기·붙이기가 실패해도 API는 다시 부르지 않는다(assemble.py가 wav만 다시 읽는다).

## 사용
    # API를 부르지 않고 전 과정을 검증한다(프롬프트·조각 수·출력 경로)
    python3 tools/tts/run.py --dry-run

    # 실제 생성. 한도가 남은 만큼만 돌린다.
    export GEMINI_API_KEY=...
    python3 tools/tts/run.py --max-caster 10 --max-analyst 10
    python3 tools/tts/run.py --only C03,C04     # 특정 배치만

429/500이 나면 그 배치에서 **멈춘다**. 재시도는 하지 않는다 — 재시도가 한도를
태우는 게 가장 비싼 실패다. 다시 부르면 남은 배치부터 이어 간다.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen  # noqa: E402

MANIFEST = "docs/audio/tts/manifest.json"
RAW_DIR = "out/tts/raw"


def prompt_for(batch: dict) -> str:
    """gen.build_prompt와 같은 규칙 + 캐리어 배치의 말줄임표 지시."""
    style = batch["style"]
    if batch["extra"]:
        style = f"{style}. {batch['extra']}"
    return gen.build_prompt(batch["lines"], style)


def raw_path(bid: str) -> str:
    return os.path.join(RAW_DIR, f"{bid}.wav")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--dry-run", action="store_true", help="API를 부르지 않고 전 과정을 찍는다")
    ap.add_argument("--only", default=None, help="쉼표로 구분한 배치 id")
    ap.add_argument("--max-caster", type=int, default=10)
    ap.add_argument("--max-analyst", type=int, default=10)
    a = ap.parse_args()

    with open(a.manifest, encoding="utf-8") as f:
        man = json.load(f)
    only = set(a.only.split(",")) if a.only else None

    os.makedirs(RAW_DIR, exist_ok=True)
    used = {"caster": 0, "analyst": 0}
    limit = {"caster": a.max_caster, "analyst": a.max_analyst}
    planned, skipped, blocked = [], [], []

    for b in man["batches"]:
        bid, sp = b["id"], b["speaker"]
        if only and bid not in only:
            continue
        if os.path.exists(raw_path(bid)):
            skipped.append(bid)
            continue
        if used[sp] >= limit[sp]:
            blocked.append(bid)
            continue
        used[sp] += 1
        planned.append(b)

    ko = {s: man["speakers"][s]["ko"] for s in man["speakers"]}
    print(f"매니페스트 {a.manifest} — 배치 {len(man['batches'])}개")
    if skipped:
        print(f"  이미 받음(건너뜀): {', '.join(skipped)}")
    if blocked:
        print(f"  한도 초과로 미실행: {', '.join(blocked)}")
    print(f"  이번에 부를 요청: {len(planned)}회 "
          f"({', '.join(f'{ko[s]} {used[s]}' for s in used)})")

    total_clips = 0
    for b in planned:
        exp = b["pieces"] * len(b["lines"])
        total_clips += len(b["items"])
        print(f"\n── {b['id']}  {ko[b['speaker']]} / {b['voice']} / {b['model']}")
        print(f"   종류 {b['kind']}  문장 {len(b['lines'])}  기대 조각 {exp}  "
              f"클립 {len(b['items'])}")
        print(f"   원본 → {raw_path(b['id'])}")
        if a.dry_run:
            print("   ─ 프롬프트 ─")
            for line in prompt_for(b).splitlines():
                print(f"   | {line}")
            print("   ─ 클립 ─")
            for it in b["items"]:
                cut = f" [{it['cut']}]" if it["cut"] else ""
                print(f"   | public/tts/{it['key']}.mp3{cut}  ← {it['text']}")

    print(f"\n합계: 요청 {len(planned)}회 / 클립 {total_clips}개")
    if a.dry_run:
        print("dry-run — API를 부르지 않았다(한도 소모 0).")
        return

    key = gen.require_key()
    for b in planned:
        print(f"\n>>> {b['id']} 요청 중…", file=sys.stderr)
        pcm = gen.synthesize(prompt_for(b), b["voice"], b["model"], key)
        out = raw_path(b["id"])
        gen.pcm_to_wav(pcm, out)
        with open(os.path.splitext(out)[0] + ".lines.json", "w", encoding="utf-8") as f:
            json.dump({"speaker": b["speaker"], "batch": b["id"], "lines": b["lines"]},
                      f, ensure_ascii=False, indent=1)
        print(f"{out}  ← 문장 {len(b['lines'])}개")

    print("\n끝. 이어서 `python3 tools/tts/assemble.py`로 자르고 굽는다.")


if __name__ == "__main__":
    main()
