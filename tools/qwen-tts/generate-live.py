"""경기 중 중계 조각 생성 — 작업 목록 → wav. **화자 고정이 전부다.**

`generate.py`(입장 소개 219클립을 만든 실행 기록)와 **같은 모델·같은 참조 음원·같은
시드·같은 ICL 설정**이다. 다른 것은 둘뿐이다:
  · 작업 목록이 인자다(하드코딩된 한 판이 아니라 여러 번 돌 수 있어야 한다)
  · 캐리어를 작업의 `cut`이 정한다(예전엔 쉼표 종결로 추측했다)

역할당 `create_voice_clone_prompt`를 **한 번만** 만들어 전량 재사용한다. 호출마다
새로 만들면 같은 참조 음원이어도 화자가 흩어진다(실측 16반음 — README 참조).
`x_vector_only_mode=False` + `ref_text`를 쓴다. 이 셋 중 하나라도 어기면 입장 소개와
경기 중계가 **다른 사람 목소리**가 된다 — 지금 고치려는 그 증상이다.

캐리어 모드는 조각이 문장 안 어디에 서는지에서 나온다(분해 설계가 이미 정했다):

    head   문중 억양이 필요하다   `{조각} …… 지금 좋습니다.`   → 앞부분을 잘라 쓴다
    tail   문말 하강이 필요하다   `이 선수는 …… {조각}`        → 뒷부분을 잘라 쓴다
    plain  그 자체로 완결 문장     캐리어 없이 직접 생성

    python tools/qwen-tts/generate-live.py --out /tmp/live-raw
    python tools/qwen-tts/process-live.py  --raw /tmp/live-raw --out /tmp/live-cut
"""
import argparse
import json
import os
import random

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

SEED = 20260806
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# 역할별 참조 음원과 그 **대본**. ref_text 없이(x_vector_only_mode=True) 돌리면 문서가
# 스스로 "cloning quality may be reduced"라고 적어 둔 축약 경로로 빠진다.
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

CARRIER = {
    "head": lambda t: f"{t.rstrip(',')} …… 지금 좋습니다.",
    "tail": lambda t: f"이 선수는 …… {t}",
    "plain": lambda t: t,
}


def cut_of(job):
    """캐리어 모드. `cut`이 없는 예전 목록은 쉼표 종결로 판정한다(219클립이 그 규칙)."""
    c = job.get("cut")
    return c if c in CARRIER else ("head" if job["text"].endswith(",") else "tail")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", default=f"{ROOT}/docs/audio/tts/qwen-jobs-live.json")
    ap.add_argument("--out", required=True, help="wav 출력 디렉터리")
    ap.add_argument("--batch", type=int, default=16, help="한 요청에 넣을 문장 수")
    ap.add_argument("--role", default=None, help="이 역할만 생성(caster|analyst)")
    ap.add_argument("--resume", action="store_true", help="이미 있는 wav는 건너뛴다")
    ap.add_argument("--limit", type=int, default=None,
                    help="앞에서부터 이 개수만 생성(파일럿용)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    torch.manual_seed(SEED)
    random.seed(SEED)
    np.random.seed(SEED)

    jobs = json.load(open(a.jobs, encoding="utf-8"))["jobs"]
    if a.role:
        jobs = [j for j in jobs if j["role"] == a.role]
    if a.limit is not None:
        jobs = jobs[:a.limit]
    if a.resume:
        jobs = [j for j in jobs
                if not os.path.exists(f"{a.out}/{j['key'].replace('/', '__')}.wav")]
    if not jobs:
        print("할 일이 없다.", flush=True)
        return

    model = Qwen3TTSModel.from_pretrained(
        "Qwen/Qwen3-TTS-12Hz-1.7B-Base", device_map="mps", dtype=torch.float16,
    )

    # ★ 역할당 프롬프트 **1개**. 배치를 나눠도 이 객체를 다시 만들지 않는다.
    prompts = {}
    for role in sorted({j["role"] for j in jobs}):
        ref_audio, ref_text = REFS[role]
        prompts[role] = model.create_voice_clone_prompt(
            ref_audio=ref_audio, ref_text=ref_text, x_vector_only_mode=False,
        )

    # 역할 × 캐리어 모드로 묶는다. 방식이 섞인 배치는 조각마다 억양이 달라진다
    # (`process-live.py`도 배치가 아니라 파일 단위로 자르므로 순서 의존이 없다).
    groups = {}
    for job in jobs:
        groups.setdefault((job["role"], cut_of(job)), []).append(job)

    done = 0
    for (role, cut), items in sorted(groups.items()):
        for start in range(0, len(items), a.batch):
            batch = items[start:start + a.batch]
            texts = [CARRIER[cut](j["text"]) for j in batch]
            print(f"generating {role}-{cut}-{start // a.batch + 1}: {len(batch)}", flush=True)
            wavs, sr = model.generate_voice_clone(
                text=texts,
                language=["Korean"] * len(texts),
                voice_clone_prompt=prompts[role],
                do_sample=True,
                temperature=0.7,
                subtalker_temperature=0.7,
                max_new_tokens=768,
            )
            for job, wav in zip(batch, wavs):
                safe = job["key"].replace("/", "__")
                sf.write(f"{a.out}/{safe}.wav", np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
                done += 1

    print(f"generated={done} prompts={len(prompts)} x_vector_only_mode=False seed={SEED}", flush=True)


if __name__ == "__main__":
    main()
