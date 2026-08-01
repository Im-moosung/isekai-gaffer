"""캐리어 문장에서 조각을 잘라내고 속도를 건다. `process.py`의 일반화판이다.

    raw.wav ──silencedetect──▶ 조각 ──atempo(역할별)──▶ out.wav
                                                        └▶ metadata.json

## 왜 무음으로 자르는가
캐리어(`{조각} …… 지금 좋습니다.`)의 `……`가 모델에게 **한 박자 쉬라**는 지시가 되고,
그 쉼이 파형에서 가장 긴 내부 무음으로 나온다. 그 지점이 곧 절단선이다. 내부 무음이
하나도 없으면 모델이 캐리어를 무시하고 이어 읽었다는 뜻이라 **실패로 남긴다** —
조용히 통째로 쓰면 `지금 좋습니다.`가 방송에 나간다.

`cut=plain`은 캐리어가 없으므로 앞뒤 무음만 턴다.

## 속도
역할별 배속을 여기서 굽는다(캐스터 1.2× · 해설 1.5×). 런타임의 재생 속도
토글(1x/1.5x/2x)은 그 **위에** 곱해진다.

    python tools/qwen-tts/process-live.py --raw /tmp/live-raw --out /tmp/live-cut
    python3 tools/tts/live-package.py --raw /tmp/live-cut --audit
"""
import argparse
import json
import os
import re
import subprocess

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPEED = {"caster": 1.2, "analyst": 1.5}
CARRIER = {
    "head": lambda t: f"{t.rstrip(',')} …… 지금 좋습니다.",
    "tail": lambda t: f"이 선수는 …… {t}",
    "plain": lambda t: t,
}


def cut_of(job):
    c = job.get("cut")
    return c if c in CARRIER else ("head" if job["text"].endswith(",") else "tail")


def silences(path):
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path, "-af", "silencedetect=noise=-40dB:d=0.18",
         "-f", "null", "-"],
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", default=f"{ROOT}/docs/audio/tts/qwen-jobs-live.json")
    ap.add_argument("--raw", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    work = os.path.join(a.out, ".work")
    os.makedirs(work, exist_ok=True)

    jobs = json.load(open(a.jobs, encoding="utf-8"))["jobs"]
    entries, failures = [], []
    for job in jobs:
        safe = job["key"].replace("/", "__")
        raw = os.path.join(a.raw, f"{safe}.wav")
        if not os.path.exists(raw):
            failures.append({"key": job["key"], "reason": "raw wav 없음"})
            continue
        mode = cut_of(job)
        try:
            y, sr = sf.read(raw, dtype="float32")
            if y.ndim > 1:
                y = y.mean(axis=1)
            dur = len(y) / sr
            ints = silences(raw)
            leading = ints[0] if ints and ints[0][0] <= 0.05 else None
            trailing = ints[-1] if ints and ints[-1][1] >= dur - 0.05 else None
            internal = [x for x in ints if x is not leading and x is not trailing]
            if mode == "plain":
                start = leading[1] if leading else 0.0
                end = trailing[0] if trailing else dur
            else:
                if not internal:
                    raise RuntimeError("캐리어에 내부 무음이 없다 — 모델이 이어 읽었다")
                pause = max(internal, key=lambda x: x[2])
                if mode == "head":
                    start = leading[1] if leading else 0.0
                    end = pause[0]
                else:
                    start = pause[1]
                    end = trailing[0] if trailing else dur
            seg = y[int(start * sr):int(end * sr)]
            nz = np.flatnonzero(np.abs(seg) > 0.005)
            if len(nz) == 0:
                raise RuntimeError("들리는 표본이 없다")
            pad = int(0.012 * sr)
            seg = seg[max(0, int(nz[0]) - pad):min(len(seg), int(nz[-1]) + pad + 1)]
            wpath = os.path.join(work, f"{safe}.wav")
            opath = os.path.join(a.out, f"{safe}.wav")
            sf.write(wpath, seg, sr, subtype="PCM_16")
            tempo = SPEED[job["role"]]
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", wpath, "-filter:a", f"atempo={tempo}",
                 "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", opath], check=True,
            )
            fin, fsr = sf.read(opath, dtype="float32")
            entries.append({
                "key": job["key"], "text": job["text"], "role": job["role"], "cut": mode,
                "speed": tempo, "durationSeconds": round(len(fin) / fsr, 6),
                "carrierText": CARRIER[mode](job["text"]),
                "trimBoundsSeconds": [round(start, 6), round(end, 6)],
                "rawDurationSeconds": round(dur, 6),
            })
        except Exception as exc:  # noqa: BLE001 — 실패는 목록으로 남기고 계속 간다
            failures.append({"key": job["key"], "text": job["text"], "reason": str(exc)})

    # 음절당 초가 중앙에서 크게 벗어나면 오생성 신호다(README 알려진 함정).
    if entries:
        rates = []
        for e in entries:
            syl = sum(1 for ch in e["text"] if 0xAC00 <= ord(ch) <= 0xD7A3)
            if syl:
                rates.append((e["durationSeconds"] / syl, e))
        rates.sort(key=lambda x: x[0])
        med = rates[len(rates) // 2][0]
        odd = [e for r, e in rates if r < med * 0.45 or r > med * 2.2]
        print(f"음절당 {med:.3f}s 중앙 · 이상치 {len(odd)}건")
        for e in odd[:10]:
            print(f"   {e['key']}  {e['text']!r}")

    json.dump({"entries": entries, "failures": failures},
              open(os.path.join(a.out, "metadata.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print(f"entries={len(entries)} failures={len(failures)}")
    for f in failures[:10]:
        print(f"   ! {f['key']}  {f.get('text', '')!r}  {f['reason']}")


if __name__ == "__main__":
    main()
