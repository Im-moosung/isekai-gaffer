# Qwen3-TTS — 한국어 중계 음성 생성

`public/tts/*.mp3`(219클립)를 만든 파이프라인이다. **런타임에는 모델을 쓰지 않는다** —
빌드 타임에 구운 mp3를 브라우저가 fetch해 Web Audio로 재생할 뿐이다. 그래서 배포물에
API 키가 필요 없고(해커톤 규정 §외부 API), 심사자가 아무 설정 없이 소리를 들을 수 있다.

## 구조

```
[로컬 생성]                                  [배포물]
Qwen3-TTS-12Hz-1.7B-Base (4.2GB, HF 캐시)  →  public/tts/<key>.mp3   219개 2.5MB
Apple Silicon MPS · float16                   public/tts/index.json  발화 문자열 → 클립 키
                                                    ↓
                                       src/audio/commentary-mp3.ts 가 재생
                                       (없으면 speechSynthesis 로 조용히 폴백)
```

## 화자 고정이 전부다

VoiceDesign(설명으로 목소리를 설계)은 **호출마다 다른 화자**를 만든다. 실측에서 캐스터
7클립의 중앙 F0가 92.7~242.4Hz(16반음)로 흩어졌고 사용자가 "다른 사람의 음성을 이어
붙인 느낌"이라고 반려했다.

Base 모델 + **음성 복제**로 바꿨다. 문서가 `x_vector_only_mode=True`를 두고
"cloning quality may be reduced"라고 명시한다 — 그 축약 경로를 쓰지 않고 `ref_audio`와
**`ref_text`(참조 음원의 대본)**를 함께 넣는다. `create_voice_clone_prompt`는
**역할당 한 번만** 만들어 전량 재사용한다.

| 역할 | 참조 음원 | 속도 |
|---|---|---|
| 캐스터 | `docs/audio/tts-samples/qwen3tts-voice-options/caster-C3-정석.wav` | 1.2× |
| 해설위원 | `…/analyst-A3-열정.wav` | 1.5× |

참조 대본은 같은 폴더 `README.md`에 전문이 있다. 시드는 `20260806`.

## 이름 조각은 캐리어 문장에서 잘라낸다

`김승규,`를 단독 생성하면 문장 끝 억양(하강)이 붙어 이어 붙일 때 튄다. 캐리어 문장
안에서 읽히고 앞부분만 잘라낸다. 82개 전부 같은 방식이어야 한다 — 방식이 섞이면
이름마다 톤이 달라진다.

## 실행

```bash
python3 -m venv /tmp/qwen3tts-env && /tmp/qwen3tts-env/bin/pip install \
  torch soundfile numpy git+https://github.com/QwenLM/Qwen3-TTS

/tmp/qwen3tts-env/bin/python tools/qwen-tts/generate.py   # 작업 목록 → wav
/tmp/qwen3tts-env/bin/python tools/qwen-tts/process.py    # 캐리어 절단 → 최종 wav
```

작업 목록은 `docs/audio/tts/qwen-jobs*.json`(key·text·role·kind)이고, 결과 기록은
`docs/audio/tts/qwen-out/report.json`이다. 원본 wav는 `.gitignore` 대상 — 산출물은
`public/tts`의 mp3이고 원본은 이 스크립트로 재생성한다.

## 패키징

mp3로 굽고 조회표를 쓰는 단계는 저장소 쪽 몫이다(라우드니스 **−16 LUFS**, 프로젝트
TTS 예산). `src/audio/__tests__/tts-coverage.test.ts`가 12개국 입장 대본이 통째로
덮이는지 검사한다 — **전부 아니면 전무**라 한 줄만 빠져도 대본 전체가 폴백하고,
화면은 멀쩡하고 소리만 나빠지므로 사람 눈으로는 안 잡힌다.

## 알려진 함정

- **경로가 절대경로로 박혀 있다**(`ROOT`). 다른 기기에서 돌리려면 고쳐야 한다.
- 생성 환경을 `/tmp`에 두면 재부팅 때 사라진다. 모델 캐시는 `~/.cache/huggingface`라 남는다.
- 음절당 초가 중앙값에서 **−2SD** 밖이면 오생성 신호다. 실제로 이 검사가 잘못 잘린
  클립 2건을 잡았다(0.057·0.062 vs 중앙 0.135).
