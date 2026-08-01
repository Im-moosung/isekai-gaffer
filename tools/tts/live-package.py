#!/usr/bin/env python3
"""경기 중 중계 조각 wav를 배포 규격 mp3로 굽고 `public/tts/index.json`을 갱신한다.

입력은 코덱스 세션이 만든 wav다(`tools/qwen-tts/generate.py` → `process.py`).
여기서 하는 일은 **라우드니스 · 인코딩 · 조회표** 셋뿐이고, 자르기는 이미 끝나 있다.

    wav ──loudnorm(I=-16)──▶ 24kHz 모노 ──mp3 64k──▶ public/tts/l/<hash>.mp3
                                                     public/tts/index.json

## 왜 클립마다 loudnorm인가
`assemble.py`(Gemini 배치 경로)는 **자르기 전 배치 전체에** loudnorm을 건다 —
0.5초 조각에 걸면 측정 구간이 모자라 게인이 튀기 때문이다. Qwen 경로는 조각이
이미 파일 단위로 나뉘어 있어 그 수가 없다. 대신 **이미 구운 219클립이 클립마다
−16 LUFS로 맞춰져 있으므로**(실측 −16.3~−16.5) 새 조각도 같은 방식이어야 두 벌이
같은 크기로 들린다. 방식을 섞으면 입장 소개와 경기 중계 사이에서 음량이 뛴다.
튀는 놈은 `--audit`이 잡는다(±2 LU 밖).

## 길이 감시
조각 수가 맞아도 **내용이 어긋날 수 있다**. 한국어 발화는 5.6음절/초라 음절 수로
상한을 세운다 — 실제로 이 검사가 잘못 잘린 클립을 잡은 전례가 있다
(`docs/audio/tts/qwen-tts README` 알려진 함정).

사용:
    python3 tools/tts/live-package.py --raw <wav 디렉터리> [--dry-run] [--audit]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JOBS = "docs/audio/tts/qwen-jobs-live.json"
PLAN = "docs/audio/tts/live-plan.json"
PUB = "public/tts"
INDEX = os.path.join(PUB, "index.json")

# `tools/tts/join.py`와 같은 문자열이어야 한다 — 입장 소개가 그걸로 구워졌다.
LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"
SR = 24000
BITRATE = "64k"
#  문장 안 이음매의 무음(ms). 대본(입장 소개)의 gapMs=90보다 짧다 —
#  근거는 src/audio/commentary-mp3.ts DEFAULT_LIVE_GAP_MS 주석.
LIVE_GAP_MS = 40


def ff(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def syllables(text: str) -> int:
    return sum(1 for ch in text if 0xAC00 <= ord(ch) <= 0xD7A3)


def duration(path: str) -> float:
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        capture_output=True, text=True, check=True,
    )
    return float(r.stdout.strip())


def loudness(path: str) -> float | None:
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    m = re.findall(r"I:\s*(-?[0-9.]+) LUFS", r.stderr)
    return float(m[-1]) if m else None


def find_raw(raw_dir: str, key: str) -> str | None:
    """코덱스 산출물의 파일명 규칙이 두 가지다 — `l/<hash>.wav`와 `l__<hash>.wav`."""
    for cand in (os.path.join(raw_dir, f"{key}.wav"),
                 os.path.join(raw_dir, key.replace("/", "__") + ".wav")):
        if os.path.exists(cand):
            return cand
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, help="코덱스가 만든 wav 디렉터리")
    ap.add_argument("--jobs", default=JOBS)
    ap.add_argument("--plan", default=PLAN)
    ap.add_argument("--dry-run", action="store_true", help="public/ 를 건드리지 않는다")
    ap.add_argument("--audit", action="store_true", help="구운 mp3의 라우드니스를 잰다(느리다)")
    a = ap.parse_args()
    os.chdir(ROOT)

    jobs = json.load(open(a.jobs, encoding="utf-8"))["jobs"]
    plan = json.load(open(a.plan, encoding="utf-8"))

    missing, made, bad = [], 0, []
    for job in jobs:
        src = find_raw(a.raw, job["key"])
        if src is None:
            missing.append(job)
            continue
        # 길이 감시 — 조각이 통째로 엉뚱한 것일 때 여기서 죽는다.
        syl = syllables(job["text"])
        span = duration(src)
        hi = max(2.0, syl / 5.6 * 2.5 + 1.2)
        if span > hi:
            bad.append((job["key"], job["text"], syl, span, hi))
            continue
        if a.dry_run:
            made += 1
            continue
        out = os.path.join(PUB, f"{job['key']}.mp3")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        ff(["-i", src, "-af", LOUDNORM, "-ar", str(SR), "-ac", "1",
            "-c:a", "libmp3lame", "-b:a", BITRATE, out])
        made += 1

    if bad:
        print("\n! 길이가 음절 수에 비해 과하다 — 조각이 어긋났다는 신호다:", file=sys.stderr)
        for k, t, syl, span, hi in bad[:10]:
            print(f"   {k}  {t!r} {syl}음절 {span:.1f}s (상한 {hi:.1f}s)", file=sys.stderr)
    if missing:
        print(f"\n! wav가 없는 작업 {len(missing)}건 — 그 조각은 조회표에 싣지 않는다.", file=sys.stderr)
        for j in missing[:10]:
            print(f"   {j['key']}  {j['text']!r}", file=sys.stderr)

    print(f"\nmp3 {made}개 (실패 {len(bad)} · 누락 {len(missing)})")
    if a.dry_run:
        print("dry-run — public/ 를 건드리지 않았다.")
        return

    write_index(jobs, plan)
    if a.audit:
        audit(jobs)


def write_index(jobs: list[dict], plan: dict) -> None:
    """조회표를 갱신한다. **실재하는 mp3만 싣는다** — 없는 항목은 런타임이 그 문장만
    speechSynthesis로 떨어뜨린다(전부 아니면 전무는 대본에만 적용된다).

    입장 소개 항목은 **지우지 않고 병합**한다. 두 벌은 같은 화자·같은 시드로 구운
    한 세트이고, 조회표가 곧 커버리지 계약이다(`src/audio/__tests__/tts-coverage.test.ts`).
    """
    idx = json.load(open(INDEX, encoding="utf-8"))
    clips: dict[str, str] = dict(idx["clips"])
    have = {}
    for job in jobs:
        if os.path.exists(os.path.join(PUB, f"{job['key']}.mp3")):
            clips[job["text"]] = job["key"]
            have[job["text"]] = job["key"]

    # `warm` — 입장 연출 동안 미리 받아 둘 순서. 코퍼스 **빈도 내림차순**이라
    # 늦게 도착해도 자주 쓰는 것부터 준비된다(commentary-mp3.warmLive).
    warm: list[str] = []
    seen = set()
    for c in plan["clips"]:
        k = have.get(c["text"]) or clips.get(c["text"])
        if k and k not in seen:
            seen.add(k)
            warm.append(k)

    idx = {"v": 1, "gapMs": idx.get("gapMs", 90), "liveGapMs": LIVE_GAP_MS,
           "clips": clips, "warm": warm}
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, separators=(",", ":"))

    total = sum(os.path.getsize(os.path.join(PUB, f"{k}.mp3"))
                for k in set(clips.values())
                if os.path.exists(os.path.join(PUB, f"{k}.mp3")))
    print(f"{INDEX} — 조회 항목 {len(clips)}개 / 클립 {len(set(clips.values()))}개"
          f" · warm {len(warm)}개 · 총 {total / 1024 / 1024:.2f} MB")


def audit(jobs: list[dict]) -> None:
    """라우드니스가 −16 LUFS에서 ±2 LU 밖인 클립을 보고한다. 이음매에서 음량이
    뛰면 조각이 다른 사람처럼 들린다 — 화자 고정의 마지막 축이다."""
    out = []
    for job in jobs:
        p = os.path.join(PUB, f"{job['key']}.mp3")
        if not os.path.exists(p):
            continue
        lu = loudness(p)
        if lu is not None and abs(lu + 16.0) > 2.0:
            out.append((job["key"], job["text"], lu))
    print(f"\n라우드니스 감사: 이탈 {len(out)}건")
    for k, t, lu in sorted(out, key=lambda x: x[2])[:20]:
        print(f"   {lu:6.1f} LUFS  {k}  {t!r}")


if __name__ == "__main__":
    main()
