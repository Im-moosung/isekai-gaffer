#!/usr/bin/env python3
"""받아 둔 배치 wav를 조각내 배포 규격 mp3로 굽고 `public/tts/index.json`을 쓴다.

## 순서와 그 이유
    raw.wav ──loudnorm──▶ norm.wav ──silencedetect──▶ 조각 ──음역정렬─▶ atempo ─▶ mp3

  · **loudnorm을 자르기 전에** 건다. 0.5초짜리 조각에 loudnorm을 걸면 측정 구간이
    모자라 조각마다 게인이 튄다. 배치 전체(30~70초)에 한 번 걸면 같은 게인이
    모든 조각에 균일하게 적용된다.
  · **자르기는 원본 타이밍에서** 한다. atempo를 먼저 걸면 문장 사이 쉼도 함께
    줄어 `--min-sil` 문턱이 흔들린다.
  · **음역 정렬은 조각 단위**다. 배치를 키우면 조각마다 중앙 F0가 흩어지는데
    (실측 3.2~13.2반음), 캐스터 템플릿 배치의 중앙값을 기준으로 당긴다.
    ±5반음을 넘으면 당기지 않고 경고한다 — 그건 다른 사람 목소리가 된다.

## 조각 수가 안 맞으면 죽는다
`split.py`와 같은 계약이다. 조용히 어긋난 채 붙이면 **엉뚱한 이름이 방송된다**.
API를 다시 부르지 않고 `--min-sil`만 바꿔 재시도할 수 있게 원본 wav는 남는다.

    python3 tools/tts/assemble.py --dry-run
    python3 tools/tts/assemble.py [--min-sil 0.35] [--only C03]
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
PUB_DIR = "public/tts"
SR = 24000
#  mp3 비트레이트. 24kHz 모노 음성이라 64k로도 128k와 청감 차이가 없고,
#  클립이 수백 개라 총 용량이 절반이 된다(3MB 예산).
BITRATE = "64k"


def ff(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def loudnorm(src: str, dst: str) -> None:
    ff(["-i", src, "-af", jn.LOUDNORM, "-ar", str(SR), "-ac", "1", dst])


def cut(src: str, dst: str, s: float, e: float) -> None:
    ff(["-ss", f"{s:.3f}", "-to", f"{e:.3f}", "-i", src, "-c", "copy", dst])


def bake(src: str, dst: str, shift: float, atempo: float) -> None:
    """조각 하나를 배포 규격으로. 앞뒤 무음 제거 → 음역 정렬 → 속도."""
    chain = [jn._TRIM]
    if abs(shift - 1.0) > 1e-3:
        chain.append(jn.shift_filter(shift))
    chain.append(f"atempo={atempo}")
    ff(["-i", src, "-af", ",".join(chain), "-c:a", "libmp3lame", "-b:a", BITRATE, dst])


def split_exact(path: str, noise: str, exp: int, fine: float):
    """발화 구간을 정확히 `exp`개로 가른다.

    ## 왜 문턱 사냥을 그만뒀나
    `silencedetect`의 문턱 하나로 맞추려 하면 배치마다 값이 다르다. 실측에서
    C03은 0.35~1.5 전 구간에서 16/16이었는데 C04는 (-40dB, 0.4~1.2)에서
    78·53·30·22·15·13·12·10으로 **16이 아예 없었다** — 문턱을 아무리 훑어도
    맞는 값이 없는 배치가 있다.

    ## 대신 구조를 쓴다
    우리는 조각 수를 **알고 있다**(문장 N개 × 조각 2). 그래서 일부러 잘게 자른 뒤
    **간격이 가장 좁은 경계부터 도로 붙여** exp개로 수렴시킨다. 남는 경계는 언제나
    *가장 크게 벌어진* 자리 — 즉 문장 사이 쉼과 말줄임표 쉼이다. 문턱 값이 아니라
    "가장 크게 쉰 자리 exp-1개"라는 구조가 판정 근거가 된다.

    조각이 exp개보다 **적게** 나오면 붙일 것이 없으므로 실패다(호출부가 죽는다).
    """
    segs = sp.segments(path, noise, fine)
    if len(segs) < exp:
        return None
    segs = [list(s) for s in segs]
    while len(segs) > exp:
        # 인접 조각 사이 간격이 가장 좁은 곳을 붙인다.
        i = min(range(len(segs) - 1), key=lambda k: segs[k + 1][0] - segs[k][1])
        segs[i][1] = segs[i + 1][1]
        del segs[i + 1]
    return [(s, e) for s, e in segs]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default=None)
    ap.add_argument("--min-sil", type=float, default=0.25,
                    help="잘게 자를 때의 무음 길이. 여기서 나온 조각을 기대 개수로 다시 붙인다.")
    ap.add_argument("--noise", default="-40dB")
    ap.add_argument("--no-align", action="store_true",
                    help="음역 정렬을 끈다. 추정기를 못 믿을 때 A/B로 들어 보기 위한 것.")
    ap.add_argument("--target", type=float, default=0.0,
                    help="음역 기준 F0(Hz). 0이면 캐스터 plain 배치에서 잰다.")
    a = ap.parse_args()

    with open(a.manifest, encoding="utf-8") as f:
        man = json.load(f)
    only = set(a.only.split(",")) if a.only else None
    atempo = man["atempo"]

    os.makedirs(WORK_DIR, exist_ok=True)
    ready, missing = [], []
    for b in man["batches"]:
        if only and b["id"] not in only:
            continue
        (ready if os.path.exists(os.path.join(RAW_DIR, f"{b['id']}.wav")) else missing).append(b)

    print(f"배치 {len(ready)}개 조립 가능 / {len(missing)}개 원본 없음"
          + (f" ({', '.join(b['id'] for b in missing)})" if missing else ""))

    if a.dry_run:
        n = 0
        for b in man["batches"]:
            if only and b["id"] not in only:
                continue
            have = os.path.exists(os.path.join(RAW_DIR, f"{b['id']}.wav"))
            print(f"  {b['id']} {'✓' if have else '·'} 조각 {b['pieces'] * len(b['lines'])} "
                  f"→ mp3 {len(b['items'])}개")
            for it in b["items"]:
                print(f"      {PUB_DIR}/{it['key']}.mp3   {it['text']}")
                n += 1
        print(f"\ndry-run — mp3 {n}개가 계획됐다. ffmpeg를 돌리지 않았다.")
        # ★ dry-run은 public/을 건드리지 않는다. 없는 mp3를 가리키는 index.json을
        #   배포물에 심으면 런타임이 폴백하지 못하고 무음이 된다.
        write_index(man, verify=False, outdir=WORK_DIR)
        return

    # 음역 기준은 **화자마다 따로** 잰다. 캐스터(Puck)와 해설위원(Iapetus)은 다른
    # 모델·다른 목소리라, 해설위원을 캐스터 음역에 맞추면 그건 정렬이 아니라 변조다.
    target = {}
    if a.target > 0:
        target = {"caster": a.target, "analyst": a.target}
    else:
        for b in ready:
            if b["kind"] != "plain" or b["speaker"] in target:
                continue
            norm = os.path.join(WORK_DIR, f"{b['id']}.norm.wav")
            src = os.path.join(RAW_DIR, f"{b['id']}.wav")
            if not os.path.exists(norm) or os.path.getmtime(norm) < os.path.getmtime(src):
                loudnorm(src, norm)
            target[b["speaker"]] = jn.median_f0(norm)
    for sp_ in ("caster", "analyst"):
        if target.get(sp_, 0) <= 0:
            print(f"! {sp_} 기준 배치가 없다 — 그 화자는 정렬하지 않는다.", file=sys.stderr)

    made = 0
    for b in ready:
        bid = b["id"]
        raw = os.path.join(RAW_DIR, f"{bid}.wav")
        norm = os.path.join(WORK_DIR, f"{bid}.norm.wav")
        # ★ 캐시 무효화. 원본이 더 새로우면 다시 만든다 — 배치를 다시 뽑았는데 캐시가
        #   남아 **폐기한 요청의 오디오로 조각을 냈다**(탐침 12개짜리 194초 wav가
        #   8개짜리 52초 wav 자리에 그대로 쓰여 17초짜리 "이름" 클립이 나왔다).
        if not os.path.exists(norm) or os.path.getmtime(norm) < os.path.getmtime(raw):
            loudnorm(raw, norm)
        exp = b["pieces"] * len(b["lines"])
        segs = split_exact(norm, a.noise, exp, a.min_sil)
        if segs is None:
            got = len(sp.segments(norm, a.noise, a.min_sil))
            sys.exit(
                f"\n── {bid}: 조각이 기대보다 적다({got} < {exp}).\n"
                f"붙이면 엉뚱한 이름이 나간다. --min-sil을 더 낮추거나 이 배치만 다시 뽑아라.\n"
                f"**원본 wav는 남아 있다 — 다른 배치 때문에 API를 다시 부르지 마라.**"
            )
        gaps = [segs[i + 1][0] - segs[i][1] for i in range(len(segs) - 1)]
        print(f"\n── {bid}: 조각 {len(segs)} / 기대 {exp}  "
              f"(남은 경계 쉼 최소 {min(gaps):.2f}s)" if gaps else f"\n── {bid}: 조각 {len(segs)}")
        total = sp.duration(norm)
        for i, it in enumerate(b["items"]):
            idx = i if b["pieces"] == 1 else i * 2 + (1 if it["cut"] == "tail" else 0)
            s, e = segs[idx]
            piece = os.path.join(WORK_DIR, f"{bid}.{idx:03d}.wav")
            cut(norm, piece, max(0.0, s - 0.03), min(total, e + 0.03))
            shift = 1.0
            tgt = target.get(b["speaker"], 0.0)
            if tgt > 0 and not a.no_align:
                m = jn.median_f0(piece)
                r = tgt / m if m > 0 else 1.0
                # ★ 옥타브 접기. f0.py는 numpy 없는 순수 파이썬 자기상관이라 0.5초짜리
                #   이름 조각에서 옥타브 배증 오검출이 난다(프로토 README가 적어 둔 한계).
                #   접지 않으면 "12반음 높다"고 잘못 읽고 정렬을 포기한다.
                while r < 0.5:
                    r *= 2
                while r > 2.0:
                    r /= 2
                if jn._SHIFT_MIN <= r <= jn._SHIFT_MAX:
                    shift = r
                else:
                    print(f"   ! {it['text']}: {m:.0f}→{tgt:.0f}Hz는 "
                          f"{abs(12 * math.log2(r)):.1f}반음이라 당기지 않는다.", file=sys.stderr)
            # ★ 길이 감시 — 조각 수가 맞아도 **내용이 어긋날 수 있다**. 실제로 캐시
            #   무효화 버그로 17초짜리 "이름" 클립이 나왔고, 조각 수는 16/16이었다.
            #   한국어 발화는 5.6음절/초라, 음절 수로 상한을 세워 조용한 사고를 막는다.
            syl = sum(1 for ch in it["text"] if 0xAC00 <= ord(ch) <= 0xD7A3)
            span = e - s
            hi = max(2.0, syl / 5.6 * 2.5 + 1.2)
            if span > hi:
                sys.exit(
                    f"\n── {bid}: `{it['text']}`({syl}음절) 조각이 {span:.1f}초다(상한 {hi:.1f}초).\n"
                    f"조각 수는 맞지만 내용이 어긋났다는 뜻이다. out/tts/work를 지우고 다시 돌려라."
                )
            out = os.path.join(PUB_DIR, f"{it['key']}.mp3")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            bake(piece, out, shift, atempo)
            made += 1
            print(f"   {out}  ×{shift:5.3f}  {it['text']}")

    print(f"\nmp3 {made}개.")
    write_index(man, verify=True)


def write_index(man: dict, verify: bool, outdir: str = PUB_DIR) -> None:
    """런타임 조회표. **실제로 존재하는 mp3만 싣는다** — 없는 항목은 런타임이
    speechSynthesis로 떨어진다. verify=False면 계획 전체를 싣는다(배선 미리보기)."""
    lines: dict[str, str] = {}
    for b in man["batches"]:
        for it in b["items"]:
            path = os.path.join(PUB_DIR, f"{it['key']}.mp3")
            if verify and not os.path.exists(path):
                continue
            lines[it["text"]] = it["key"]
    os.makedirs(outdir, exist_ok=True)
    idx = {"v": 1, "gapMs": man["gapMs"], "clips": lines}
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, separators=(",", ":"))
    total = sum(os.path.getsize(os.path.join(PUB_DIR, f"{k}.mp3"))
                for k in lines.values() if os.path.exists(os.path.join(PUB_DIR, f"{k}.mp3")))
    print(f"{outdir}/index.json — 클립 {len(lines)}개"
          + (f", 총 {total / 1024 / 1024:.2f} MB" if total else " (오디오 미생성)"))


if __name__ == "__main__":
    main()
