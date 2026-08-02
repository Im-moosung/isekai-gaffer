"""Generate the three late-match theatre-goal commentary fragments."""
from __future__ import annotations

import argparse
import hashlib
import json
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


def carrier(cut, text):
    if cut == "head":
        return f"{text.rstrip(',')} …… 지금 좋습니다."
    if cut == "tail":
        return f"이 선수는 …… {text}"
    return text


def output_path(base, key):
    path = base.joinpath(*key.split("/")).with_suffix(".wav")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def intervals(path):
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(path),
         "-af", "silencedetect=noise=-40dB:d=0.18", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    out, start = [], None
    for line in result.stderr.splitlines():
        m = re.search(r"silence_start:\s*([0-9.]+)", line)
        if m:
            start = float(m.group(1))
        m = re.search(r"silence_end:\s*([0-9.]+)", line)
        if m and start is not None:
            out.append((start, float(m.group(1))))
            start = None
    return out


def trim(path, cut):
    samples, sr = sf.read(path, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    duration = len(samples) / sr
    silence = intervals(path)
    leading = silence[0] if silence and silence[0][0] <= 0.05 else None
    trailing = silence[-1] if silence and silence[-1][1] >= duration - 0.05 else None
    internal = [x for x in silence if x is not leading and x is not trailing]
    if not internal:
        return None
    # head text can contain its own sentence pause; the carrier delimiter is
    # the last internal pause before “지금 좋습니다.”. Tail uses the first.
    pause = internal[-1] if cut == "head" else internal[0]
    start = (leading[1] if leading else 0.0) if cut == "head" else pause[1]
    end = pause[0] if cut == "head" else (trailing[0] if trailing else duration)
    segment = samples[int(start * sr):int(end * sr)]
    nz = np.flatnonzero(np.abs(segment) > 0.005)
    if len(nz) == 0:
        return None
    pad = int(0.012 * sr)
    segment = segment[max(0, int(nz[0]) - pad):min(len(segment), int(nz[-1]) + pad + 1)]
    return segment, sr, start, end, duration


def volumedetect(path):
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
    parser.add_argument("--qc", type=Path, default=ROOT / "docs/audio/tts/qc-missing-late.tsv")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--raw", type=Path, required=True)
    args = parser.parse_args()
    args.raw.mkdir(parents=True, exist_ok=True)
    jobs = []
    for line in args.qc.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        role, cut, text = line.split("\t", 2)
        jobs.append({
            "key": "l/" + hashlib.sha1(text.encode("utf-8")).hexdigest()[:10],
            "role": role, "cut": cut, "text": text,
        })
    if len(jobs) != 3 or any(j["role"] != "caster" for j in jobs):
        raise RuntimeError(f"late 작업 불일치: {len(jobs)}")
    torch.manual_seed(SEED)
    random.seed(SEED)
    np.random.seed(SEED)
    model = Qwen3TTSModel.from_pretrained(MODEL, device_map="mps", dtype=torch.float16)
    prompt = model.create_voice_clone_prompt(
        ref_audio=str(REF_AUDIO), ref_text=REF_TEXT, x_vector_only_mode=False,
    )
    texts = [carrier(j["cut"], j["text"]) for j in jobs]
    print("late carrier head/tail 1-3", flush=True)
    wavs, sr = model.generate_voice_clone(
        text=texts,
        language=["Korean"] * len(texts),
        voice_clone_prompt=prompt,
        do_sample=True,
        temperature=0.7,
        subtalker_temperature=0.7,
        max_new_tokens=768,
    )
    entries = []
    for job, text, wav in zip(jobs, texts, wavs):
        safe = job["key"].replace("/", "__")
        raw = args.raw / f"{safe}.raw.wav"
        sf.write(raw, np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
        trimmed = trim(raw, job["cut"])
        if trimmed is None:
            raise RuntimeError(f"절단 실패: {job['key']} {job['text']}")
        segment, seg_sr, start, end, raw_duration = trimmed
        work = args.raw / f"{safe}.trim.wav"
        sf.write(work, segment, seg_sr, subtype="PCM_16")
        final = output_path(args.out, job["key"])
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(work),
             "-filter:a", f"atempo={SPEED}", "-ar", "24000", "-ac", "1",
             "-c:a", "pcm_s16le", str(final)], check=True,
        )
        samples, final_sr = sf.read(final, dtype="float32")
        entry = {
            "key": job["key"], "text": job["text"], "role": "caster",
            "kind": "frag", "cut": job["cut"], "speed": SPEED,
            "durationSeconds": round(len(samples) / final_sr, 6),
            "method": f"carrier-late-{job['cut']}",
            "generationText": text, "carrierText": text,
            "trimBoundsSeconds": [round(start, 6), round(end, 6)],
            "rawDurationSeconds": round(raw_duration, 6),
            "audioCheck": volumedetect(final),
        }
        entries.append(entry)
    failures = [e["key"] for e in entries if e["audioCheck"]["maxVolumeDb"] <= -70 or e["audioCheck"]["nonzeroSamples"] <= 0]
    metadata = {
        "source": str(args.qc.relative_to(ROOT)), "model": MODEL, "seed": SEED,
        "xVectorOnlyMode": False, "refTextUsed": True, "voiceClonePromptReuse": True,
        "speed": SPEED, "pitchShift": False, "loudnessNormalization": False,
        "entries": entries, "failures": failures,
    }
    (args.raw / "late-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "entries": len(entries), "failures": failures,
        "maxVolumeDb": [min(e["audioCheck"]["maxVolumeDb"] for e in entries), max(e["audioCheck"]["maxVolumeDb"] for e in entries)],
        "meanVolumeDb": [min(e["audioCheck"]["meanVolumeDb"] for e in entries), max(e["audioCheck"]["meanVolumeDb"] for e in entries)],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
