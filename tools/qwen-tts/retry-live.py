"""실패한 경기 중계 조각의 자동 재시도.

표준 캐리어에서 내부 무음이 나오지 않은 작업만 대상으로 한다.
1) 말줄임표 위치를 유지하되 캐리어를 조금 길게 바꿔 한 번 재생성
2) 그래도 절단선이 없으면 같은 화자 프롬프트로 직접 생성해 폴백

두 단계 모두 피치 보정·라우드니스 정규화 없이 역할별 속도만 적용한다.
"""
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


def safe_key(key):
    return key.replace("/", "__")


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
            out.append((start, end, end - start))
            start = None
    return out


def carrier_text(job):
    text = job["text"]
    mode = job.get("cut")
    if mode == "head":
        return f"{text.rstrip(',')} …… 그리고 지금 좋습니다."
    if mode == "tail":
        return f"이 선수의 움직임을 보세요 …… {text}"
    return text


def direct_generation_text(job):
    """짧은 담화표지가 구두점만으로 무음이 되는 경우의 마지막 폴백."""
    text = job["text"]
    stripped = text.rstrip(" ,.!?…")
    return stripped if stripped else text


def trim(path, mode):
    y, sr = sf.read(path, dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    dur = len(y) / sr
    ints = silences(path)
    leading = ints[0] if ints and ints[0][0] <= 0.05 else None
    trailing = ints[-1] if ints and ints[-1][1] >= dur - 0.05 else None
    internal = [x for x in ints if x is not leading and x is not trailing]
    if mode == "plain":
        start = leading[1] if leading else 0.0
        end = trailing[0] if trailing else dur
    else:
        if not internal:
            return None
        pause = max(internal, key=lambda x: x[2])
        if mode == "head":
            start, end = (leading[1] if leading else 0.0), pause[0]
        else:
            start, end = pause[1], (trailing[0] if trailing else dur)
    seg = y[int(start * sr):int(end * sr)]
    nz = np.flatnonzero(np.abs(seg) > 0.005)
    if len(nz) == 0:
        return None
    pad = int(0.012 * sr)
    seg = seg[max(0, int(nz[0]) - pad):min(len(seg), int(nz[-1]) + pad + 1)]
    return seg, sr, start, end, dur


def write_final(seg, sr, work, out, tempo):
    os.makedirs(os.path.dirname(work), exist_ok=True)
    sf.write(work, seg, sr, subtype="PCM_16")
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", work,
         "-filter:a", f"atempo={tempo}", "-ar", "24000", "-ac", "1",
         "-c:a", "pcm_s16le", out], check=True,
    )
    fin, fsr = sf.read(out, dtype="float32")
    return round(len(fin) / fsr, 6)


def generate(model, prompts, role, items, texts):
    wavs, sr = model.generate_voice_clone(
        text=texts,
        language=["Korean"] * len(texts),
        voice_clone_prompt=prompts[role],
        do_sample=True,
        temperature=0.7,
        subtalker_temperature=0.7,
        max_new_tokens=768,
    )
    return [(job, np.asarray(wav, dtype=np.float32), sr)
            for job, wav in zip(items, wavs)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", default=f"{ROOT}/docs/audio/tts/qwen-jobs-live.json")
    ap.add_argument("--metadata", required=True,
                    help="process-live.py가 남긴 실패 목록")
    ap.add_argument("--out", required=True, help="최종 WAV 디렉터리")
    ap.add_argument("--raw", required=True, help="재시도 원본 WAV 디렉터리")
    a = ap.parse_args()
    os.makedirs(a.raw, exist_ok=True)
    work = os.path.join(a.out, ".retry-work")

    jobs = json.load(open(a.jobs, encoding="utf-8"))["jobs"]
    failures = json.load(open(a.metadata, encoding="utf-8")).get("failures", [])
    by_key = {j["key"]: j for j in jobs}
    pending = [by_key[f["key"]] for f in failures if f["key"] in by_key]
    pending = [j for j in pending if not os.path.exists(output_path(a.out, j["key"]))]
    if not pending:
        print("재시도할 실패 작업이 없다.", flush=True)
        json.dump({"entries": [], "failures": [], "retrySummary": {}},
                  open(os.path.join(a.raw, "retry-metadata.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=1)
        return

    torch.manual_seed(SEED)
    random.seed(SEED)
    np.random.seed(SEED)
    model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-Base", device_map="mps", dtype=torch.float16,
    )
    prompts = {}
    for role in sorted({j["role"] for j in pending}):
        ref_audio, ref_text = REFS[role]
        prompts[role] = model.create_voice_clone_prompt(
            ref_audio=ref_audio, ref_text=ref_text, x_vector_only_mode=False,
        )

    entries, carrier_entries, final_failures, direct_items = [], [], [], []
    groups = {}
    for j in pending:
        groups.setdefault((j["role"], j.get("cut", "plain")), []).append(j)

    # 1차 재시도: 말줄임표 앞뒤에 의미 보존형 캐리어를 조금 길게 둔다.
    for (role, mode), items in sorted(groups.items()):
        print(f"retry carrier {role}-{mode}: {len(items)}", flush=True)
        generated = generate(model, prompts, role, items, [carrier_text(j) for j in items])
        for job, wav, sr in generated:
            raw = os.path.join(a.raw, safe_key(job["key"]) + ".carrier-retry.wav")
            sf.write(raw, wav, sr, subtype="PCM_16")
            cut = trim(raw, mode)
            if cut is None:
                direct_items.append(job)
                continue
            seg, seg_sr, start, end, dur = cut
            out = output_path(a.out, job["key"])
            duration = write_final(seg, seg_sr,
                                   os.path.join(work, safe_key(job["key"]) + ".wav"),
                                   out, SPEED[job["role"]])
            entry = {
                "key": job["key"], "text": job["text"], "role": job["role"],
                "kind": job.get("kind"), "cut": mode, "speed": SPEED[job["role"]],
                "durationSeconds": duration, "method": "carrier-retry",
                "carrierText": carrier_text(job),
                "trimBoundsSeconds": [round(start, 6), round(end, 6)],
                "rawDurationSeconds": round(dur, 6),
            }
            entries.append(entry)
            carrier_entries.append(entry)

    # 2차 폴백: 캐리어를 버리고 같은 역할 프롬프트로 직접 생성한다.
    direct_groups = {}
    for job in direct_items:
        direct_groups.setdefault(job["role"], []).append(job)
    for role, items in sorted(direct_groups.items()):
        print(f"retry direct-fallback {role}: {len(items)}", flush=True)
        generated = generate(model, prompts, role, items,
                             [direct_generation_text(j) for j in items])
        for job, wav, sr in generated:
            raw = os.path.join(a.raw, safe_key(job["key"]) + ".direct-fallback.wav")
            sf.write(raw, wav, sr, subtype="PCM_16")
            cut = trim(raw, "plain")
            if cut is None:
                final_failures.append({"key": job["key"], "text": job["text"],
                                       "reason": "carrier-retry와 direct-fallback 모두 무음 트림 실패"})
                continue
            seg, seg_sr, start, end, dur = cut
            out = output_path(a.out, job["key"])
            duration = write_final(seg, seg_sr,
                                   os.path.join(work, safe_key(job["key"]) + ".wav"),
                                   out, SPEED[job["role"]])
            entries.append({
                "key": job["key"], "text": job["text"], "role": job["role"],
                "kind": job.get("kind"), "cut": job.get("cut"),
                "speed": SPEED[job["role"]], "durationSeconds": duration,
                "method": "direct-fallback", "carrierText": None,
                "generationText": direct_generation_text(job),
                "trimBoundsSeconds": [round(start, 6), round(end, 6)],
                "rawDurationSeconds": round(dur, 6),
            })

    summary = {
        "attempted": len(pending), "carrierRetry": len(carrier_entries),
        "directFallback": len([e for e in entries if e["method"] == "direct-fallback"]),
        "failed": len(final_failures),
    }
    json.dump({"entries": entries, "failures": final_failures,
               "retrySummary": summary},
              open(os.path.join(a.raw, "retry-metadata.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
