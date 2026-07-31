# 배경음악 기획 — 장면별 필요 목록과 생성 프롬프트

## 먼저 정한 것: 경기 중에는 음악을 깔지 않는다

이미 소리가 셋 돌고 있다 — **관중 루프**(`public/sfx/crowd.mp3`), **골·실점·휘슬 원샷**,
**한국어 TTS 중계 2화자**(캐스터 + 해설위원). 여기에 음악을 얹으면 셋이 서로를 먹는다.

그리고 **실제 축구 중계는 경기 중 음악을 쓰지 않는다.** 관중 소리가 곧 음악이다.
우리 톤 정의가 *"화면은 FIFA 월드피드처럼 생기고, 말은 라노벨처럼 한다"*이므로
경기 화면은 방송 문법을 따른다.

**예외 하나**만 둔다 — 아래 `M09 클러치 베드`.

## 톤 방향

| | |
|---|---|
| **기본** | 방송 스포츠 — 오케스트라 + 일렉트로닉 하이브리드, 타악 중심, 보컬 없음 |
| **이세계 요소** | **랜딩 테마에만.** 제목이 노출되는 유일한 표면이라 거기서만 모험/판타지 색을 준다 |
| **금지** | 애니메이션풍 J-pop, 8비트 레트로, 가사 있는 보컬 |

## 필요 목록 — 루프 5 + 스팅 5 = 10곡

### 루프 (이음매 없이 반복)

| ID | 장면 | 길이 | 성격 |
|---|---|---|---|
| **M01** | 랜딩 | 60~90s | 테마. 밤 경기장, 제목, 첫인상 |
| **M02** | 허브(여정) | 90~120s | 경기 사이. 계획·기대. 낮은 존재감 |
| **M03** | 워룸(전술 설계) | 90~120s | 집중. 방해하지 않는 사고 배경 |
| **M04** | 작전판(감독 타임·브레이크) | 60~90s | 경기가 멈춘 긴장. 결정의 순간 |
| **M05** | 승부차기 | 60~90s | 최대 긴장. 심장박동 |

### 스팅 (한 번 재생)

| ID | 장면 | 길이 | 성격 |
|---|---|---|---|
| **M06** | 입장 연출 | **정확히 13.8s** | 터널 → 워크아웃 → 정렬 → 소개 → 흩어짐. 킥오프 휘슬로 끝난다 |
| **M07** | 하프타임 진입 | 4~6s | 전반 종료. 한숨 |
| **M08** | 풀타임 | 5~8s | 결과 확정 |
| **M10** | 엔딩 — 우승 | 15~25s | 정상. 이 게임의 유일한 완전한 승리 |
| **M11** | 엔딩 — 탈락 | 12~20s | 여정의 끝. 슬프되 비참하지 않게 |

### 선택 (판단 후)

| ID | 장면 | 길이 | 성격 |
|---|---|---|---|
| **M09** | 클러치 베드 | 60s 루프 | **80분 이후 + 1골 차 이내**에서만 아주 낮게 깔린다. 관중·중계 밑을 받치는 저역 |

M09는 유일하게 경기 중에 도는 음악이다. **−28 LUFS 이하로 아주 낮게**, 저역 위주로
중계 음성 대역(200Hz~4kHz)을 비워야 한다. 없어도 게임은 성립한다 — 만들어 보고 판단하자.

---

## 기술 규격

- `.mp3` 192kbps 이상 또는 `.opus`
- 48kHz 스테레오
- **루프는 이음매가 없어야 한다** — 앞뒤 페이드 금지, 첫 박과 끝 박이 이어지게
- **라우드니스**: 루프 **−20 LUFS**, 스팅 **−16 LUFS**, M09만 **−28 LUFS**
  (중계 TTS가 −16이므로 음악이 그보다 4dB 아래여야 말이 들린다)
- 스팅은 앞 무음 30ms 이내
- 파일명: `public/bgm/<ID>.mp3` (예: `public/bgm/M01.mp3`)

---

## 생성 프롬프트

음악 AI에 그대로 넣으면 된다. 영어로 쓴 이유는 대부분의 모델이 영어 프롬프트에서
장르·악기 지시를 더 정확히 따르기 때문이다.

### M01 — 랜딩 테마 (60~90s 루프)
```
Cinematic sports broadcast theme with a touch of fantasy adventure.
Orchestral strings and low brass over a driving electronic pulse.
Taiko-style low percussion, rising anticipation, wide reverb like a night stadium.
Hopeful but not triumphant — this is before anything has been won.
Seamless loop, no vocals, no lyrics. 90 BPM. Key of D minor lifting to F major.
```
**의도**: 제목 화면. 이세계 색이 허용되는 유일한 곡 — 판타지 모험 뉘앙스를 방송 스포츠 위에 얹는다.

### M02 — 허브 / 여정 (90~120s 루프)
```
Understated sports documentary underscore. Sparse piano and muted strings,
soft analog synth pad, light brushed percussion. Reflective and forward-looking,
the feeling of studying a map before a long journey.
Must sit far in the background — no dramatic swells, no loud hits.
Seamless loop, no vocals. 72 BPM. Warm minor key.
```
**의도**: 경기 사이 화면. **오래 켜져 있으므로 존재감이 낮아야 한다.**

### M03 — 워룸 / 전술 설계 (90~120s 루프)
```
Focused analytical underscore for a tactics room. Minimal pulsing synth arpeggio,
subtle low strings, occasional soft mallet accents. Steady, unhurried, cerebral.
No melody that draws attention — this plays while someone is thinking hard.
Seamless loop, no vocals, no drums. 84 BPM. Cool neutral tonality.
```
**의도**: 유저가 슬라이더를 만지며 오래 머무는 화면. **선율이 강하면 방해가 된다.**

### M04 — 작전판 / 감독 타임 (60~90s 루프)
```
Tense broadcast interlude. Muted staccato strings, low pulsing bass,
ticking percussion like a clock, restrained. The match is paused and a decision
must be made. Building pressure without releasing it.
Seamless loop, no vocals. 100 BPM. Dark minor key.
```
**의도**: 시간이 멈춘 상태. **해소되지 않는 긴장**이 핵심 — 절정으로 가지 않는다.

### M05 — 승부차기 (60~90s 루프)
```
Maximum tension sports drama. Sparse heartbeat kick drum, sustained dissonant
string cluster, distant choir-like pad, occasional metallic hit.
Almost unbearable stillness between beats. Very few notes.
Seamless loop, no vocals with lyrics. 60 BPM. Atonal / unresolved.
```
**의도**: 킥 사이의 정적이 핵심. **음이 적을수록 좋다.**

### M06 — 입장 연출 (정확히 13.8초 스팅)
```
Stadium entrance fanfare, exactly 13.8 seconds. Starts with a distant low drum
and crowd-like swell, builds through brass and strings, reaches a bright peak
around 11 seconds, then resolves cleanly at 13.8 seconds ready for a whistle.
Ceremonial, World Cup opening feeling. No vocals. Must end on a clean beat, not fade.
```
**의도**: 길이가 계약이다. `ENTRANCE_TOTAL_MS = 13800`. 끝에서 킥오프 휘슬이 이어진다.

### M07 — 하프타임 진입 (4~6초 스팅)
```
Short broadcast transition sting, 5 seconds. Descending brass phrase resolving
to a warm sustained chord. The feeling of a whistle ending the first half —
a pause for breath, not an ending. No vocals, no drums at the end.
```

### M08 — 풀타임 (5~8초 스팅)
```
Final whistle broadcast sting, 6 seconds. Full orchestral hit followed by a
sustained resolving chord with cymbal swell. Conclusive and neutral —
it must work whether the team won or lost. No vocals.
```
**의도**: **승패 어느 쪽에도 붙는다.** 감정을 단정하면 안 된다.

### M10 — 엔딩 · 우승 (15~25초 스팅)
```
Triumphant World Cup victory theme, 20 seconds. Full orchestra with soaring
strings and heroic brass, big timpani, choir-like pad swelling underneath.
Earned and overwhelming — the end of a long campaign. Resolves to a clean major chord.
No vocals with lyrics.
```

### M11 — 엔딩 · 탈락 (12~20초 스팅)
```
Bittersweet ending theme, 16 seconds. Solo piano with distant strings entering
halfway, restrained and dignified. The journey is over but it mattered.
Melancholy without despair — no crushing minor chords, no tragedy.
Resolves quietly. No vocals.
```
**의도**: 기획서가 **비하·비참함을 금지**한다. *"슬프되 비참하지 않게"*가 계약이다.

### M09 — 클러치 베드 (60초 루프, 선택)
```
Sub-bass tension bed for the final minutes of a close match, 60 seconds.
Almost entirely low frequency — deep pulsing drone, faint low string tremolo,
distant heartbeat. Nothing above 200Hz. It should be felt more than heard,
sitting underneath crowd noise and a commentator's voice.
Seamless loop, no vocals, no melody.
```
**의도**: **200Hz 이상을 비우는 것**이 핵심. 중계 음성 대역을 침범하면 실패다.

---

## 배선 시 지킬 것 (구현 메모)

- 기존 음소거 토글(`sfx.setMuted`)이 BGM도 함께 끊어야 한다. **별도 토글을 만들지 마라** — 컨트롤이 이미 7개다
- 화면 전환 시 **크로스페이드 300~500ms**. 하드 컷은 튄다
- **골·실점 순간에 BGM을 덕킹**하라(일시정지 작업이 관중음에 쓴 것과 같은 방식, 0.1배)
- 일시정지 중에는 BGM도 멈춘다 — `8a35662`가 관중음에 세운 규칙과 같게
- `prefers-reduced-motion`은 음악과 무관하다. 다만 **접근성상 자동재생은 유저 제스처 뒤**여야 한다(이미 `sfx.init()`이 킥오프 제스처에서 AudioContext를 연다)
