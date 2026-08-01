#!/usr/bin/env python3
"""Gemini TTS 한 요청 = 한 배치. 여러 문장을 한 번에 읽히고 무음으로 잘라 쓴다.

## 왜 배치인가
모델당 **RPD 10**이 유일한 병목이다(TPM 10K는 실측 92토큰이라 남아돈다).
문장 하나에 요청 하나를 쓰면 하루 20문장이 한계다. 그래서 한 요청에 여러 문장을
넣고, "각 문장 사이에 1초 이상 완전히 쉬어라"라고 지시한 뒤 silencedetect로 자른다.
실측: 지시하면 2.2~2.5초씩 쉬고 `noise=-40dB:d=0.6`으로 8/8 정확히 갈렸다.

## 화자별 모델 고정
- 캐스터   : Puck    / gemini-2.5-flash-preview-tts
- 해설위원 : Iapetus / gemini-3.1-flash-tts-preview
두 모델의 톤이 미세하게 달라, 같은 화자가 모델을 오가면 이질감이 난다.
부수 효과로 RPD가 모델별이라 로테이션 이득도 그대로 얻는다.

## 사용
    export GEMINI_API_KEY=...
    python3 tools/tts/gen.py --speaker caster --out out/batch.wav \
        --style "축구 중계 캐스터처럼" line1 line2 ...
    python3 tools/tts/gen.py --speaker caster --out out/batch.wav --lines-file lines.txt

원본은 24kHz 모노 s16le PCM으로 온다. 자르기 전에는 **무손실 wav로 둔다** —
mp3로 먼저 굽고 자르면 인코더 프레임 경계에서 앞뒤 무음이 새로 생긴다.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

SPEAKERS = {
    "caster": {
        "voice": "Puck",
        "model": "gemini-2.5-flash-preview-tts",
        "ko": "캐스터",
    },
    "analyst": {
        "voice": "Iapetus",
        "model": "gemini-3.1-flash-tts-preview",
        "ko": "해설위원",
    },
}

# 문장 사이에 확실한 무음을 남기게 하는 지시 — 잘라내기의 유일한 근거다.
# "번호는 읽지 마라"가 없으면 "일 번"을 읽어 첫 조각이 오염된다.
SPLIT_INSTRUCTION = (
    "각 문장 사이에는 반드시 1초 이상 완전히 쉬어라. 번호는 읽지 마라."
)


def require_key() -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        sys.exit(
            "GEMINI_API_KEY가 없다. `export GEMINI_API_KEY=...` 후 다시 실행하라.\n"
            "키를 파일이나 커밋에 남기지 마라."
        )
    return key


def build_prompt(lines: list[str], style: str | None) -> str:
    head = style.strip() if style else ""
    if len(lines) == 1:
        return f"{head}: {lines[0]}" if head else lines[0]
    head = f"{head} " if head else ""
    instr = f"{head}아래 문장들을 한 문장씩 또렷하게 읽어라. {SPLIT_INSTRUCTION}\n\n"
    return instr + "\n\n".join(f"{i + 1}. {l}" for i, l in enumerate(lines))


def synthesize(prompt: str, voice: str, model: str, key: str) -> bytes:
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}
            },
        },
    }
    req = urllib.request.Request(
        API.format(model=model),
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "X-goog-api-key": key},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        # 429는 재시도하지 마라 — RPD를 태울 뿐이다.
        sys.exit(f"HTTP {e.code} — 재시도 금지(RPD 소모). 응답: {detail}")
    dt = time.time() - t0
    part = d["candidates"][0]["content"]["parts"][0]["inlineData"]
    pcm = base64.b64decode(part["data"])
    print(
        f"  {model} / {voice}  {len(pcm) / 48000:6.2f}s  api {dt:4.1f}s  "
        f"({part['mimeType']})",
        file=sys.stderr,
    )
    return pcm


def pcm_to_wav(pcm: bytes, out: str) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    raw = out + ".pcm"
    with open(raw, "wb") as f:
        f.write(pcm)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "s16le", "-ar", "24000",
         "-ac", "1", "-i", raw, out],
        check=True,
    )
    os.remove(raw)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--speaker", required=True, choices=sorted(SPEAKERS))
    ap.add_argument("--out", required=True, help="출력 wav 경로(무손실 유지)")
    ap.add_argument("--style", default=None, help="프롬프트 앞머리 연기 지시")
    ap.add_argument("--lines-file", default=None, help="한 줄에 한 문장인 텍스트 파일")
    ap.add_argument("--dry-run", action="store_true", help="프롬프트만 찍고 요청하지 않는다")
    ap.add_argument("lines", nargs="*")
    a = ap.parse_args()

    lines = list(a.lines)
    if a.lines_file:
        with open(a.lines_file, encoding="utf-8") as f:
            lines += [l.strip() for l in f if l.strip() and not l.startswith("#")]
    if not lines:
        sys.exit("읽을 문장이 없다.")

    prompt = build_prompt(lines, a.style)
    if a.dry_run:
        print(prompt)
        print(f"\n--- 문장 {len(lines)}개 / 요청 1회 (dry-run, 소모 없음) ---", file=sys.stderr)
        return

    key = require_key()
    pcm = synthesize(prompt, SPEAKERS[a.speaker]["voice"], SPEAKERS[a.speaker]["model"], key)
    pcm_to_wav(pcm, a.out)
    # 조각 인덱스 ↔ 원문 대응은 split.py가 쓴다.
    with open(os.path.splitext(a.out)[0] + ".lines.json", "w", encoding="utf-8") as f:
        json.dump({"speaker": a.speaker, "style": a.style, "lines": lines}, f,
                  ensure_ascii=False, indent=1)
    print(f"{a.out}  ← 문장 {len(lines)}개 / 요청 1회")


if __name__ == "__main__":
    main()
