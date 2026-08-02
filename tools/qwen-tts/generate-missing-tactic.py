"""Generate the fixed tactic/commentary lines omitted from the live corpus."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


SEED = 20260806
MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
SPEED = {"caster": 1.2, "analyst": 1.5}
ROOT = Path(__file__).resolve().parents[2]
REFS = {
    "caster": (
        ROOT / "docs/audio/tts-samples/qwen3tts-voice-options/caster-C3-정석.wav",
        "자, 경기 시작됐습니다! 오른쪽 측면을 빠르게 돌파합니다. 크로스 올라갑니다! 슈팅! 골입니다! 홈 팬들이 열광합니다!",
    ),
    "analyst": (
        ROOT / "docs/audio/tts-samples/qwen3tts-voice-options/analyst-A3-열정.wav",
        "이 장면은 오른쪽 풀백의 오버래핑이 핵심이었습니다. 수비 라인을 바깥으로 끌어낸 뒤, 중앙에 공간을 만들었고, 공격수가 그 틈을 정확히 파고들었습니다.",
    ),
}


def output_path(base: Path, key: str) -> Path:
    path = base.joinpath(*key.split("/")).with_suffix(".wav")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def parse_jobs(path: Path):
    jobs = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        role, source_line, text = line.split("\t", 2)
        key = "l/" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
        jobs.append({
            "key": key,
            "role": role,
            "sourceLine": int(source_line),
            "text": text,
        })
    if len(jobs) != 41 or len({job["key"] for job in jobs}) != 41:
        raise RuntimeError(f"누락 전술 작업 수/키가 예상과 다름: {len(jobs)}")
    if any(job["role"] not in SPEED for job in jobs):
        raise RuntimeError("알 수 없는 role이 있음")
    return jobs


def silences(path: Path):
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-i", str(path),
            "-af", "silencedetect=noise=-40dB:d=0.18", "-f", "null", "-",
        ], capture_output=True, text=True, check=False,
    )
    intervals = []
    start = None
    for line in result.stderr.splitlines():
        found = re.search(r"silence_start:\s*([0-9.]+)", line)
        if found:
            start = float(found.group(1))
        found = re.search(r"silence_end:\s*([0-9.]+)", line)
        if found and start is not None:
            intervals.append((start, float(found.group(1))))
            start = None
    return intervals


def trim_plain(path: Path):
    samples, sr = sf.read(path, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    duration = len(samples) / sr
    intervals = silences(path)
    start = intervals[0][1] if intervals and intervals[0][0] <= 0.05 else 0.0
    end = intervals[-1][0] if intervals and intervals[-1][1] >= duration - 0.05 else duration
    segment = samples[int(start * sr):int(end * sr)]
    nonzero = np.flatnonzero(np.abs(segment) > 0.005)
    if len(nonzero) == 0:
        return None
    pad = int(0.012 * sr)
    segment = segment[
        max(0, int(nonzero[0]) - pad):min(len(segment), int(nonzero[-1]) + pad + 1)
    ]
    return segment, sr, start, end, duration


def loudness(path: Path):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    mean = re.search(r"mean_volume:\s*(-?[0-9.]+) dB", result.stderr)
    peak = re.search(r"max_volume:\s*(-?[0-9.]+) dB", result.stderr)
    if not mean or not peak:
        raise RuntimeError("volumedetect가 mean/max volume을 반환하지 않음")
    samples, _ = sf.read(path, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return {
        "meanVolumeDb": float(mean.group(1)),
        "maxVolumeDb": float(peak.group(1)),
        "nonzeroSamples": int(np.count_nonzero(np.abs(samples) > 0.005)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--qc", type=Path, default=ROOT / "docs/audio/tts/qc-missing-tactic.tsv")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--batch", type=int, default=16)
    args = parser.parse_args()
    args.raw.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)
    jobs = parse_jobs(args.qc)

    torch.manual_seed(SEED)
    random.seed(SEED)
    np.random.seed(SEED)
    model = Qwen3TTSModel.from_pretrained(MODEL, device_map="mps", dtype=torch.float16)
    prompts = {}
    for role in sorted({job["role"] for job in jobs}):
        ref_audio, ref_text = REFS[role]
        prompts[role] = model.create_voice_clone_prompt(
            ref_audio=str(ref_audio), ref_text=ref_text, x_vector_only_mode=False,
        )

    entries = []
    for role in ("analyst", "caster"):
        role_jobs = [job for job in jobs if job["role"] == role]
        for start in range(0, len(role_jobs), args.batch):
            batch = role_jobs[start:start + args.batch]
            print(f"tactic direct {role} {start + 1}-{start + len(batch)}", flush=True)
            wavs, sr = model.generate_voice_clone(
                text=[job["text"] for job in batch],
                language=["Korean"] * len(batch),
                voice_clone_prompt=prompts[role],
                do_sample=True,
                temperature=0.7,
                subtalker_temperature=0.7,
                max_new_tokens=768,
            )
            for job, wav in zip(batch, wavs):
                safe = job["key"].replace("/", "__")
                raw = args.raw / f"{safe}.direct.wav"
                sf.write(raw, np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
                trimmed = trim_plain(raw)
                if trimmed is None:
                    raise RuntimeError(f"생성 후 파형이 비어 있음: {job['key']}")
                segment, seg_sr, trim_start, trim_end, raw_duration = trimmed
                work = args.raw / f"{safe}.trim.wav"
                sf.write(work, segment, seg_sr, subtype="PCM_16")
                final = output_path(args.out, job["key"])
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-i", str(work),
                     "-filter:a", f"atempo={SPEED[role]}", "-ar", "24000", "-ac", "1",
                     "-c:a", "pcm_s16le", str(final)], check=True,
                )
                final_samples, final_sr = sf.read(final, dtype="float32")
                entries.append({
                    "key": job["key"],
                    "text": job["text"],
                    "role": role,
                    "kind": "plain",
                    "cut": "plain",
                    "sourceLine": job["sourceLine"],
                    "speed": SPEED[role],
                    "durationSeconds": round(len(final_samples) / final_sr, 6),
                    "method": "direct-tactic-missing",
                    "generationText": job["text"],
                    "trimBoundsSeconds": [round(trim_start, 6), round(trim_end, 6)],
                    "rawDurationSeconds": round(raw_duration, 6),
                    "audioCheck": loudness(final),
                })

    if len(entries) != len(jobs):
        raise RuntimeError(f"생성 수 불일치: {len(entries)} != {len(jobs)}")
    failures = [
        entry["key"] for entry in entries
        if entry["audioCheck"]["nonzeroSamples"] <= 0 or entry["audioCheck"]["maxVolumeDb"] <= -70
    ]
    report = {
        "source": str(args.qc.relative_to(ROOT)),
        "model": MODEL,
        "seed": SEED,
        "xVectorOnlyMode": False,
        "refTextUsed": True,
        "voiceClonePromptReuse": True,
        "speed": SPEED,
        "pitchShift": False,
        "loudnessNormalization": False,
        "entries": entries,
        "failures": failures,
    }
    (args.raw / "tactic-missing-metadata.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "entries": len(entries),
        "failures": failures,
        "prompts": len(prompts),
        "maxVolumeDb": [min(e["audioCheck"]["maxVolumeDb"] for e in entries), max(e["audioCheck"]["maxVolumeDb"] for e in entries)],
        "meanVolumeDb": [min(e["audioCheck"]["meanVolumeDb"] for e in entries), max(e["audioCheck"]["meanVolumeDb"] for e in entries)],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
