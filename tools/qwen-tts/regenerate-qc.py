"""QC 목록의 잘린 클립을 캐리어 없이 완결 문장으로 다시 생성한다."""
import argparse
import json
import os
import random
import re
import subprocess

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

SEED = 20260806
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEED = {"caster": 1.2, "analyst": 1.5}
REFS = {
    "caster": (
        f"{ROOT}/docs/audio/tts-samples/qwen3tts-voice-options/caster-C3-정석.wav",
        "자, 경기 시작됐습니다! 오른쪽 측면을 빠르게 돌파합니다. 크로스 올라갑니다! 슈팅! 골입니다! 홈 팬들이 열광합니다!",
    ),
    "analyst": (
        f"{ROOT}/docs/audio/tts-samples/qwen3tts-voice-options/analyst-A3-열정.wav",
        "이 장면은 오른쪽 풀백의 오버래핑이 핵심이었습니다. 수비 라인을 바깥으로 끌어낸 뒤, 중앙에 공간을 만들었고, 공격수가 그 틈을 정확히 파고들었습니다.",
    ),
}


def output_path(base, key):
    path = os.path.join(base, *key.split("/")) + ".wav"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def silences(path):
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path,
         "-af", "silencedetect=noise=-40dB:d=0.18", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    out, start = [], None
    for line in r.stderr.splitlines():
        m = re.search(r"silence_start:\s*([0-9.]+)", line)
        if m:
            start = float(m.group(1))
        m = re.search(r"silence_end:\s*([0-9.]+)", line)
        if m and start is not None:
            end = float(m.group(1))
            out.append((start, end))
            start = None
    return out


def trim_plain(path):
    y, sr = sf.read(path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    dur = len(y) / sr
    ints = silences(path)
    start = ints[0][1] if ints and ints[0][0] <= 0.05 else 0.0
    end = ints[-1][0] if ints and ints[-1][1] >= dur - 0.05 else dur
    seg = y[int(start * sr):int(end * sr)]
    nz = np.flatnonzero(np.abs(seg) > 0.005)
    if len(nz) == 0:
        raise RuntimeError("직접 생성 결과에 들리는 표본이 없다")
    pad = int(0.012 * sr)
    seg = seg[max(0, int(nz[0]) - pad):min(len(seg), int(nz[-1]) + pad + 1)]
    return seg, sr, start, end, dur


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qc", default=f"{ROOT}/docs/audio/tts/qc-truncated.tsv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--raw", required=True)
    a = ap.parse_args()
    os.makedirs(a.raw, exist_ok=True)
    work = os.path.join(a.out, ".qc-work")
    os.makedirs(work, exist_ok=True)

    jobs = []
    for line in open(a.qc, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        key, cut, role, length, syllables, rate, text = line.split("\t", 6)
        jobs.append({"key": key, "cut": cut, "role": role, "text": text,
                     "qcRate": float(rate), "qcSyllables": int(syllables.rstrip("음절"))})
    if len(jobs) != 16:
        raise RuntimeError(f"QC 작업 수가 16개가 아님: {len(jobs)}")

    torch.manual_seed(SEED)
    random.seed(SEED)
    np.random.seed(SEED)
    model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-Base", device_map="mps", dtype=torch.float16,
    )
    prompts = {}
    for role in sorted({j["role"] for j in jobs}):
        ref_audio, ref_text = REFS[role]
        prompts[role] = model.create_voice_clone_prompt(
            ref_audio=ref_audio, ref_text=ref_text, x_vector_only_mode=False,
        )

    entries = []
    for role in sorted({j["role"] for j in jobs}):
        items = [j for j in jobs if j["role"] == role]
        print(f"generating qc-direct {role}: {len(items)}", flush=True)
        wavs, sr = model.generate_voice_clone(
            text=[j["text"] for j in items],
            language=["Korean"] * len(items),
            voice_clone_prompt=prompts[role],
            do_sample=True,
            temperature=0.7,
            subtalker_temperature=0.7,
            max_new_tokens=768,
        )
        for job, wav in zip(items, wavs):
            safe = job["key"].replace("/", "__")
            raw = os.path.join(a.raw, safe + ".wav")
            sf.write(raw, np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
            seg, seg_sr, start, end, raw_dur = trim_plain(raw)
            work_path = os.path.join(work, safe + ".wav")
            out = output_path(a.out, job["key"])
            sf.write(work_path, seg, seg_sr, subtype="PCM_16")
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", work_path,
                 "-filter:a", f"atempo={SPEED[role]}", "-ar", "24000", "-ac", "1",
                 "-c:a", "pcm_s16le", out], check=True,
            )
            final, final_sr = sf.read(out, dtype="float32")
            entries.append({
                "key": job["key"], "text": job["text"], "role": role,
                "cut": job["cut"], "speed": SPEED[role],
                "durationSeconds": round(len(final) / final_sr, 6),
                "method": "direct-qc",
                "generationText": job["text"],
                "trimBoundsSeconds": [round(start, 6), round(end, 6)],
                "rawDurationSeconds": round(raw_dur, 6),
                "qcPreviousRate": job["qcRate"],
            })
    json.dump({"entries": entries, "failures": []},
              open(os.path.join(a.raw, "qc-metadata.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"entries={len(entries)} failures=0", flush=True)


if __name__ == "__main__":
    main()
