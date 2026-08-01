import json
import os
import re
import subprocess

import numpy as np
import soundfile as sf

ROOT = "/Users/moo/Projects/daker/MH_Soccer-Manager"
RAW = "/tmp/qwen3tts-mps-test.OhlsNC/rest-icl-raw"
WORK = "/tmp/qwen3tts-mps-test.OhlsNC/rest-icl-work"
OUT = "/tmp/qwen3tts-mps-test.OhlsNC/rest-icl-processed"
os.makedirs(WORK, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

jobs = json.load(open(f"{ROOT}/docs/audio/tts/qwen-jobs-rest.json"))["jobs"]

def silences(path):
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path, "-af", "silencedetect=noise=-40dB:d=0.18", "-f", "null", "-"],
        capture_output=True, text=True, check=False,
    )
    out = []
    start = None
    for line in r.stderr.splitlines():
        m = re.search(r"silence_start:\s*([0-9.]+)", line)
        if m:
            start = float(m.group(1))
        m = re.search(r"silence_end:\s*([0-9.]+)", line)
        if m and start is not None:
            end = float(m.group(1))
            out.append((start, end, end - start))
            start = None
    return out

entries = []
failures = []
for job in jobs:
    safe = job["key"].replace("/", "__")
    raw = f"{RAW}/{safe}.wav"
    try:
        y, sr = sf.read(raw, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        duration = len(y) / sr
        ints = silences(raw)
        leading = ints[0] if ints and ints[0][0] <= 0.05 else None
        trailing = ints[-1] if ints and ints[-1][1] >= duration - 0.05 else None
        internal = [x for x in ints if x is not leading and x is not trailing]
        if not internal:
            raise RuntimeError("carrier has no internal silence")
        pause = max(internal, key=lambda x: x[2])
        if job["text"].endswith(","):
            start = leading[1] if leading else 0.0
            end = pause[0]
            method = "carrier-array-head"
            carrier = f"{job['text'][:-1]} …… 지금 좋습니다."
        else:
            start = pause[1]
            end = trailing[0] if trailing else duration
            method = "carrier-array-tail"
            carrier = f"이 선수는 …… {job['text']}"
        segment = y[int(start * sr):int(end * sr)]
        nz = np.flatnonzero(np.abs(segment) > 0.005)
        if len(nz) == 0:
            raise RuntimeError("no audible samples")
        pad = int(0.012 * sr)
        segment = segment[max(0, int(nz[0]) - pad):min(len(segment), int(nz[-1]) + pad + 1)]
        work = f"{WORK}/{safe}.wav"
        out = f"{OUT}/{safe}.wav"
        sf.write(work, segment, sr, subtype="PCM_16")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", work, "-filter:a", "atempo=1.2", "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", out], check=True)
        final, final_sr = sf.read(out, dtype="float32")
        entries.append({
            "key": job["key"], "text": job["text"], "role": job["role"], "kind": job["kind"],
            "speed": 1.2, "durationSeconds": round(len(final) / final_sr, 6), "method": method,
            "carrierText": carrier,
            "trimBoundsSeconds": [round(start, 6), round(end, 6)],
            "rawDurationSeconds": round(duration, 6),
        })
    except Exception as exc:
        failures.append({"key": job["key"], "reason": str(exc)})

json.dump({"entries": entries, "failures": failures}, open(f"{OUT}/metadata.json", "w"), ensure_ascii=False, indent=2)
print(f"entries={len(entries)} failures={len(failures)}")
