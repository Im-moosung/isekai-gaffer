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

# ★ 이 파일은 tools/tts/ 아래에 있다. 저장소 루트는 **세 번** 올라가야 나온다
#   (live-package.py → tts → tools → repo). 두 번만 올라가면 ROOT가 `tools`가 되고,
#   os.chdir(ROOT) 뒤의 상대 경로가 전부 어긋난다(실측: mp3는 구워지는데
#   `public/tts/index.json`에서 FileNotFoundError). 다른 tools 스크립트는 대부분
#   루트에서 실행돼 이 계산이 드러나지 않았다.
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
    """EBU R128 integrated loudness. **0.4초 미만 클립에는 쓸 수 없다** — 아래 참조."""
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    m = re.findall(r"I:\s*(-?[0-9.]+) LUFS", r.stderr)
    return float(m[-1]) if m else None


def peak_db(path: str) -> float | None:
    """최대 진폭(dBFS). 길이와 무관하게 유효하므로 **무음 판정은 이 값으로 한다**.

    ★ 2026-08-02: 원래 이 스크립트는 무음도 loudness()로 판정했다. 그 결과
      "무음 25건"이라는 오진이 나왔고 코덱스에게 멀쩡한 클립 25개를 재생성시켰다.
      원인은 EBU R128의 **400ms 게이팅 블록**이다 — 0.4초 미만 파일은 게이트를
      통과하는 블록이 하나도 없어 측정 자체가 성립하지 않고 −70(무한소)이 나온다.
      그것은 "소리가 없다"가 아니라 "잴 수 없다"는 뜻이다.

      오진을 알아챈 단서는 경계가 지나치게 깨끗했다는 점이었다 — '복구됨' 6개가
      전부 0.40초 이상, '여전히 무음' 19개가 전부 0.39초 이하였다. 실제 오디오
      결함이 0.4초에서 칼같이 갈릴 리 없다. volumedetect로 다시 재니 25개 모두
      peak −3~−15dB로 멀쩡했다.

      경기 중계 클립은 `일.` `골!` 처럼 0.2초짜리가 흔하다. 이 경로에서 R128을
      무음 판정에 쓰는 것은 구조적으로 틀렸다.
    """
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", path,
         "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    m = re.search(r"max_volume:\s*(-?[0-9.]+) dB", r.stderr)
    return float(m.group(1)) if m else None


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


#: R128 integrated loudness가 성립하는 최소 길이. 게이팅 블록이 400ms다 —
#  이보다 짧으면 유효 블록이 0개라 측정값이 −70으로 떨어진다(peak_db 주석 참조).
R128_MIN_SEC = 0.45


def audit(jobs: list[dict]) -> None:
    """두 가지를 따로 본다. **무음은 길이와 무관한 peak로, 라우드니스는 R128로.**
    한 잣대로 뭉뚱그리면 짧은 클립이 전부 무음으로 오진된다(peak_db 주석 참조).

    라우드니스를 보는 이유는 이음매다 — 조각마다 음량이 뛰면 같은 사람이 아닌
    것처럼 들린다. 화자 고정의 마지막 축이다.
    """
    silent, loud_off, unmeasurable = [], [], 0
    for job in jobs:
        p = os.path.join(PUB, f"{job['key']}.mp3")
        if not os.path.exists(p):
            continue
        # ① 무음 — 이것만이 진짜 결함이다. 재생성해야 한다.
        pk = peak_db(p)
        if pk is None or pk < -50.0:
            silent.append((job["key"], job["text"], pk))
            continue
        # ② 라우드니스 — 길이가 되는 클립만. 짧으면 판정을 포기한다(오진보다 낫다).
        if duration(p) < R128_MIN_SEC:
            unmeasurable += 1
            continue
        lu = loudness(p)
        if lu is not None and abs(lu + 16.0) > 2.0:
            loud_off.append((job["key"], job["text"], lu))

    print(f"\n무음 감사(peak < −50dB): {len(silent)}건")
    for k, t, pk in silent:
        print(f"   peak {pk if pk is not None else float('nan'):6.1f} dB  {k}  {t!r}")
    print(f"라우드니스 감사(−16±2 LUFS): 이탈 {len(loud_off)}건"
          f" · 너무 짧아 판정 보류 {unmeasurable}건")
    for k, t, lu in sorted(loud_off, key=lambda x: x[2])[:20]:
        print(f"   {lu:6.1f} LUFS  {k}  {t!r}")


if __name__ == "__main__":
    main()
