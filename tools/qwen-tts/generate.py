import json
import os
import random

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

SEED = 20260806
ROOT = "/Users/moo/Projects/daker/MH_Soccer-Manager"
OUT = "/tmp/qwen3tts-mps-test.OhlsNC/rest-icl-raw"
os.makedirs(OUT, exist_ok=True)

torch.manual_seed(SEED)
random.seed(SEED)
np.random.seed(SEED)

model = Qwen3TTSModel.from_pretrained(
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    device_map="mps",
    dtype=torch.float16,
)

ref_audio = f"{ROOT}/docs/audio/tts-samples/qwen3tts-voice-options/caster-C3-정석.wav"
ref_text = "자, 경기 시작됐습니다! 오른쪽 측면을 빠르게 돌파합니다. 크로스 올라갑니다! 슈팅! 골입니다! 홈 팬들이 열광합니다!"

# Reuse one ICL prompt for every batch in this 90-clip caster run.
prompt_caster = model.create_voice_clone_prompt(
    ref_audio=ref_audio,
    ref_text=ref_text,
    x_vector_only_mode=False,
)

jobs = json.load(open(f"{ROOT}/docs/audio/tts/qwen-jobs-rest.json"))["jobs"]
items = []
for job in jobs:
    item = dict(job)
    if job["text"].endswith(","):
        item["carrierText"] = f"{job['text'][:-1]} …… 지금 좋습니다."
        item["carrierMode"] = "head"
    else:
        item["carrierText"] = f"이 선수는 …… {job['text']}"
        item["carrierMode"] = "tail"
    items.append(item)

def save_batch(batch, index):
    texts = [item["carrierText"] for item in batch]
    print(f"generating caster-name-carrier-{index}: {len(batch)}", flush=True)
    wavs, sr = model.generate_voice_clone(
        text=texts,
        language=["Korean"] * len(texts),
        voice_clone_prompt=prompt_caster,
        do_sample=True,
        temperature=0.7,
        subtalker_temperature=0.7,
        max_new_tokens=768,
    )
    for item, wav in zip(batch, wavs):
        safe = item["key"].replace("/", "__")
        sf.write(f"{OUT}/{safe}.wav", np.asarray(wav, dtype=np.float32), sr, subtype="PCM_16")
    print(f"finished caster-name-carrier-{index}", flush=True)

# Same carrier-array size used for the approved name set, with one prompt object.
for start in range(0, len(items), 16):
    save_batch(items[start:start + 16], start // 16 + 1)

print(f"generated={len(items)} prompt_caster_count=1 batches={(len(items)+15)//16} x_vector_only_mode=False seed={SEED}", flush=True)
