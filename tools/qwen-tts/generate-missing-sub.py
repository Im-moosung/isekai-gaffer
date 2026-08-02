"""Generate the caster fragments omitted after tactic/substitution simulation."""
from __future__ import annotations

import argparse
import hashlib
import json
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
SPEED = 1.2
ROOT = Path(__file__).resolve().parents[2]
REF_AUDIO = ROOT / "docs/audio/tts-samples/qwen3tts-voice-options/caster-C3-정석.wav"
REF_TEXT = "자, 경기 시작됐습니다! 오른쪽 측면을 빠르게 돌파합니다. 크로스 올라갑니다! 슈팅! 골입니다! 홈 팬들이 열광합니다!"
CARRIERS = {
    "head": lambda text: f"{text.rstrip(',')} …… 지금 좋습니다.",
    "tail": lambda text: f"이 선수는 …… {text}",
    "plain": lambda text: text,
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
        role, cut, frequency, text = line.split("\t", 3)
        key = "l/" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
        jobs.append({
            "key": key,
            "role": role,
            "cut": cut,
            "frequency": int(frequency),
            "text": text,
        })
    if len(jobs) != 18 or len({job["key"] for job in jobs}) != 18:
        raise RuntimeError(f"sub 작업 수/키가 예상과 다름: {len(jobs)}")
    if any(job["role"] != "caster" or job["cut"] not in CARRIERS for job in jobs):
        raise RuntimeError("sub 목록은 caster/plain|head|tail이어야 함")
    return jobs


def silence_intervals(path: Path):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path),
         "-af", "silencedetect=noise=-40dB:d=0.18", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
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


def trim_segment(path: Path, cut: str):
    samples, sr = sf.read(path, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    duration = len(samples) / sr
    intervals = silence_intervals(path)
    leading = intervals[0] if intervals and intervals[0][0] <= 0.05 else None
    trailing = intervals[-1] if intervals and intervals[-1][1] >= duration - 0.05 else None
    if cut == "plain":
        start = leading[1] if leading else 0.0
        end = trailing[0] if trailing else duration
    else:
        internal = [item for item in intervals if item is not leading and item is not trailing]
        if not internal:
            return None
        # tail은 `이 선수는 …… {text}`의 첫 내부 무음이 캐리어 구분점이다.
        # 뒤 문장 자체의 마침표 무음이 더 길어도 그곳을 고르면 text 앞부분이 잘린다.
        pause = internal[0]
        if cut == "head":
            start = leading[1] if leading else 0.0
            end = pause[0]
        else:
            start = pause[1]
            end = trailing[0] if trailing else duration
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
        raise RuntimeError("volumedetect 결과 없음")
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
    parser.add_argument("--qc", type=Path, default=ROOT / "docs/audio/tts/qc-missing-sub.tsv")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--raw", type=Path, required=True)
    parser.add_argument("--batch", type=int, default=8)
    args = parser.parse_args()
    args.raw.mkdir(parents=True, exist_ok=True)
    jobs = parse_jobs(args.qc)

    torch.manual_seed(SEED)
    random.seed(SEED)
    np.random.seed(SEED)
    model = Qwen3TTSModel.from_pretrained(MODEL, device_map="mps", dtype=torch.float16)
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(REF_AUDIO), ref_text=REF_TEXT, x_vector_only_mode=False,
    )

    entries = []
    for cut in ("plain", "head", "tail"):
        group = [job for job in jobs if job["cut"] == cut]
        for start in range(0, len(group), args.batch):
            batch = group[start:start + args.batch]
            texts = [CARRIERS[cut](job["text"]) for job in batch]
            print(f"sub {cut} {start + 1}-{start + len(batch)}", flush=True)
            wavs, sr = model.generate_voice_clone(
                text=texts,
                language=["Korean"] * len(texts),
                voice_clone_prompt=prompt,
                do_sample=True,
                temperature=0.7,
                subtalker_temperature=0.7,
                max_new_tokens=768,
            )
            for job, wav in zip(batch, wavs):
                safe = job["key"].replace("/", "__")
                raw = args.raw / f"{safe}.raw.wav"
                sf.write(raw, np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
                trimmed = trim_segment(raw, cut)
                if trimmed is None:
                    raise RuntimeError(f"{cut} 절단 실패: {job['key']} {job['text']}")
                segment, seg_sr, trim_start, trim_end, raw_duration = trimmed
                work = args.raw / f"{safe}.trim.wav"
                sf.write(work, segment, seg_sr, subtype="PCM_16")
                final = output_path(args.out, job["key"])
                subprocess.run(
                    ["ffmpeg", "-y", "-v", "error", "-i", str(work),
                     "-filter:a", f"atempo={SPEED}", "-ar", "24000", "-ac", "1",
                     "-c:a", "pcm_s16le", str(final)], check=True,
                )
                final_samples, final_sr = sf.read(final, dtype="float32")
                entries.append({
                    "key": job["key"],
                    "text": job["text"],
                    "role": "caster",
                    "kind": "plain" if cut == "plain" else "frag",
                    "cut": cut,
                    "frequency": job["frequency"],
                    "speed": SPEED,
                    "durationSeconds": round(len(final_samples) / final_sr, 6),
                    "method": "direct-sub-plain" if cut == "plain" else f"carrier-sub-{cut}",
                    "generationText": texts[batch.index(job)],
                    "carrierText": texts[batch.index(job)] if cut != "plain" else None,
                    "trimBoundsSeconds": [round(trim_start, 6), round(trim_end, 6)],
                    "rawDurationSeconds": round(raw_duration, 6),
                    "audioCheck": loudness(final),
                })
    for entry in entries:
        if entry["cut"] == "plain":
            entry.pop("carrierText", None)
    failures = [
        entry["key"] for entry in entries
        if entry["audioCheck"]["nonzeroSamples"] <= 0 or entry["audioCheck"]["maxVolumeDb"] <= -70
    ]
    metadata = {
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
    (args.raw / "sub-missing-metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({
        "entries": len(entries),
        "failures": failures,
        "promptCount": 1,
        "byCut": {cut: sum(entry["cut"] == cut for entry in entries) for cut in CARRIERS},
        "maxVolumeDb": [min(e["audioCheck"]["maxVolumeDb"] for e in entries), max(e["audioCheck"]["maxVolumeDb"] for e in entries)],
        "meanVolumeDb": [min(e["audioCheck"]["meanVolumeDb"] for e in entries), max(e["audioCheck"]["meanVolumeDb"] for e in entries)],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
