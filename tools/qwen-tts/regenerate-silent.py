"""무음으로 판정된 짧은 조각을 직접 생성하고 파형을 검증한다."""
import argparse
import json
import math
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
            out.append((start, float(m.group(1))))
            start = None
    return out


def trim_plain(path):
    y, sr = sf.read(path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    dur = len(y) / sr
    intervals = silences(path)
    start = intervals[0][1] if intervals and intervals[0][0] <= 0.05 else 0.0
    end = intervals[-1][0] if intervals and intervals[-1][1] >= dur - 0.05 else dur
    seg = y[int(start * sr):int(end * sr)]
    nz = np.flatnonzero(np.abs(seg) > 0.005)
    if len(nz) == 0:
        return None
    pad = int(0.012 * sr)
    seg = seg[max(0, int(nz[0]) - pad):min(len(seg), int(nz[-1]) + pad + 1)]
    return seg, sr, start, end, dur


def trim_tail_carrier(path):
    y, sr = sf.read(path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    dur = len(y) / sr
    intervals = silences(path)
    leading = intervals[0] if intervals and intervals[0][0] <= 0.05 else None
    trailing = intervals[-1] if intervals and intervals[-1][1] >= dur - 0.05 else None
    internal = [x for x in intervals if x is not leading and x is not trailing]
    if not internal:
        return None
    pause = max(internal, key=lambda x: x[1] - x[0])
    start = pause[1]
    end = trailing[0] if trailing else dur
    seg = y[int(start * sr):int(end * sr)]
    nz = np.flatnonzero(np.abs(seg) > 0.005)
    if len(nz) == 0:
        return None
    pad = int(0.012 * sr)
    seg = seg[max(0, int(nz[0]) - pad):min(len(seg), int(nz[-1]) + pad + 1)]
    return seg, sr, start, end, dur


def stats(path):
    y, _ = sf.read(path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    rms = float(np.sqrt(np.mean(np.square(y)))) if len(y) else 0.0
    return {
        "peakDbfs": round(20 * math.log10(max(peak, 1e-12)), 3),
        "rmsDbfs": round(20 * math.log10(max(rms, 1e-12)), 3),
        "nonzeroSamples": int(np.count_nonzero(np.abs(y) > 0.005)),
    }


def write_final(seg, sr, work, out, tempo):
    sf.write(work, seg, sr, subtype="PCM_16")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", work,
         "-filter:a", f"atempo={tempo}", "-ar", "24000", "-ac", "1",
         "-c:a", "pcm_s16le", out], check=True,
    )
    return stats(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qc", default=f"{ROOT}/docs/audio/tts/qc-silent.tsv")
    ap.add_argument("--out", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--batch", type=int, default=16)
    a = ap.parse_args()
    os.makedirs(a.raw, exist_ok=True)
    work = os.path.join(a.out, ".silent-work")
    os.makedirs(work, exist_ok=True)

    jobs = []
    for line in open(a.qc, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#") or line.startswith("# key"):
            continue
        key, cut, role, length, text = line.split("\t", 4)
        jobs.append({"key": key, "cut": cut, "role": role, "text": text})
    if len(jobs) != 25:
        raise RuntimeError(f"무음 QC 작업 수가 25개가 아님: {len(jobs)}")

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

    by_key = {j["key"]: j for j in jobs}
    entries, pending, failures = [], [], []

    # 1차: 요청대로 정확한 텍스트를 직접 생성한다.
    for role in sorted({j["role"] for j in jobs}):
        items = [j for j in jobs if j["role"] == role]
        for start in range(0, len(items), a.batch):
            batch = items[start:start + a.batch]
            print(f"silent direct {role} {start + 1}-{start + len(batch)}", flush=True)
            wavs, sr = model.generate_voice_clone(
                text=[j["text"] for j in batch], language=["Korean"] * len(batch),
                voice_clone_prompt=prompts[role], do_sample=True,
                temperature=0.7, subtalker_temperature=0.7, max_new_tokens=768,
            )
            for job, wav in zip(batch, wavs):
                safe = job["key"].replace("/", "__")
                raw = os.path.join(a.raw, safe + ".direct.wav")
                sf.write(raw, np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
                cut = trim_plain(raw)
                if cut is None:
                    pending.append(job)
                    continue
                seg, seg_sr, start_s, end_s, raw_dur = cut
                out = output_path(a.out, job["key"])
                audio = write_final(seg, seg_sr,
                                    os.path.join(work, safe + ".wav"), out,
                                    SPEED[job["role"]])
                entries.append({
                    "key": job["key"], "text": job["text"], "role": job["role"],
                    "kind": "frag", "cut": job["cut"], "speed": SPEED[job["role"]],
                    "durationSeconds": round(sf.info(out).duration, 6),
                    "method": "direct-silent-qc", "generationText": job["text"],
                    "trimBoundsSeconds": [round(start_s, 6), round(end_s, 6)],
                    "rawDurationSeconds": round(raw_dur, 6), "audioCheck": audio,
                })

    # 2차: 구두점 때문에 무음이 된 짧은 조각은 구두점을 제거해 직접 생성한다.
    normalized = []
    for job in pending:
        text = job["text"].rstrip(" ,.!?…") or job["text"]
        normalized.append((job, text))
    still = []
    for role in sorted({j["role"] for j, _ in normalized}):
        items = [(j, t) for j, t in normalized if j["role"] == role]
        if not items:
            continue
        print(f"silent direct-normalized {role}: {len(items)}", flush=True)
        wavs, sr = model.generate_voice_clone(
            text=[t for _, t in items], language=["Korean"] * len(items),
            voice_clone_prompt=prompts[role], do_sample=True,
            temperature=0.7, subtalker_temperature=0.7, max_new_tokens=768,
        )
        for (job, generation_text), wav in zip(items, wavs):
            safe = job["key"].replace("/", "__")
            raw = os.path.join(a.raw, safe + ".normalized.wav")
            sf.write(raw, np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
            cut = trim_plain(raw)
            if cut is None:
                still.append((job, generation_text))
                continue
            seg, seg_sr, start_s, end_s, raw_dur = cut
            out = output_path(a.out, job["key"])
            audio = write_final(seg, seg_sr,
                                os.path.join(work, safe + ".wav"), out,
                                SPEED[job["role"]])
            entries.append({
                "key": job["key"], "text": job["text"], "role": job["role"],
                "kind": "frag", "cut": job["cut"], "speed": SPEED[job["role"]],
                "durationSeconds": round(sf.info(out).duration, 6),
                "method": "direct-normalized-silent-qc", "generationText": generation_text,
                "trimBoundsSeconds": [round(start_s, 6), round(end_s, 6)],
                "rawDurationSeconds": round(raw_dur, 6), "audioCheck": audio,
            })

    # 3차: 그래도 무음이면 target을 캐리어 끝에 두고 tail로 절단한다.
    for job, _ in still:
        carrier = f"이어서 말씀드립니다 …… {job['text']}"
        wavs, sr = model.generate_voice_clone(
            text=[carrier], language=["Korean"], voice_clone_prompt=prompts[job["role"]],
            do_sample=True, temperature=0.7, subtalker_temperature=0.7,
            max_new_tokens=768,
        )
        safe = job["key"].replace("/", "__")
        raw = os.path.join(a.raw, safe + ".carrier-tail.wav")
        sf.write(raw, np.asarray(wavs[0], dtype=np.float32), sr, subtype="PCM_16")
        cut = trim_tail_carrier(raw)
        if cut is None:
            failures.append({"key": job["key"], "text": job["text"],
                             "reason": "direct·구두점 제거·carrier-tail 모두 무음"})
            continue
        seg, seg_sr, start_s, end_s, raw_dur = cut
        out = output_path(a.out, job["key"])
        audio = write_final(seg, seg_sr,
                            os.path.join(work, safe + ".wav"), out,
                            SPEED[job["role"]])
        entries.append({
            "key": job["key"], "text": job["text"], "role": job["role"],
            "kind": "frag", "cut": job["cut"], "speed": SPEED[job["role"]],
            "durationSeconds": round(sf.info(out).duration, 6),
            "method": "carrier-tail-silent-qc", "carrierText": carrier,
            "trimBoundsSeconds": [round(start_s, 6), round(end_s, 6)],
            "rawDurationSeconds": round(raw_dur, 6), "audioCheck": audio,
        })

    json.dump({"entries": entries, "failures": failures,
               "counts": {"direct": sum(e["method"] == "direct-silent-qc" for e in entries),
                          "directNormalized": sum(e["method"] == "direct-normalized-silent-qc" for e in entries),
                          "carrierTail": sum(e["method"] == "carrier-tail-silent-qc" for e in entries),
                          "failures": len(failures)}},
              open(os.path.join(a.raw, "silent-metadata.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"entries={len(entries)} failures={len(failures)}", flush=True)


if __name__ == "__main__":
    main()
