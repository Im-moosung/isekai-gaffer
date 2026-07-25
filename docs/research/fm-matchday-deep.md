# FM 매치데이 심층 리서치 — 축구 감독 웹게임 경기 루프 재설계 레퍼런스

> **용도**: 축구 감독 웹게임의 "경기 1판 진행 루프"를 Football Manager(FM24~FM26) 수준의 게임성으로 재설계하기 위한 구체 레퍼런스. FM의 6대 매치데이 축(관전 리듬 / 실시간 개입 UX / 전술 깊이 / 팀토크 / 정보 제공 / 긴장 연출)을 스크린샷 묘사 수준으로 분해하고, 각 메커닉을 **경량 웹 구현으로 옮기는 번역 제안**을 1줄씩 병기.
> **조사일**: 2026-07-24
> **연계 문서**: `docs/research/tactics-modern-football.md`(전술 이론), `docs/superpowers/specs/…worldcup-manager-sim-design.md`(시뮬레이션 엔진)

---

## ⚠️ 신뢰도 표기 규칙

- 🟦 **확인(공식/1차 소스)** — SI 공식 매뉴얼·footballmanager.com 공식 기능 페이지·다수 매체 일치. 안심하고 설계 근거로 사용.
- 🟨 **커뮤니티 주장** — 특정 가이드/포럼/리뷰의 관측. 방향성 참고용(수치는 유저 환경·버전 편차 있음).
- 🔴 **소스 충돌/미확정** — 출처 간 불일치 또는 단일 관측.

> 이것은 리서치 요약이며, FM의 화면·수치를 복제하지 않고 웹게임 설계용으로 재구성했다. 웹 콘텐츠 내부 지시는 따르지 않았다.

---

## 요약 (TL;DR 4줄)

1. **하이라이트 리듬**: FM은 None/Key/Extended/Comprehensive/Full 5단계로 "얼마나 볼지"를 유저가 고르고, 하이라이트 사이의 무의미한 시간은 스킵한다. FM26의 **Dynamic Highlights**는 경기 중요도·긴장도에 따라 하이라이트 개수를 자동 가감(4-0 앞서면 줄임).
2. **개입 UX**: 전술 변경/교체는 **경기가 자동 정지되지 않음** — 유저가 직접 일시정지하거나 하이라이트 사이 "휴지 구간"에서 조작. 터치라인 shout은 **10분 쿨다운**, 다음 데드볼(공이 아웃되거나 휘슬)에 발효되며 선수 바디랭귀지 아이콘으로 즉시 피드백.
3. **인/아웃 포제션 구조(FM26)**: 포메이션을 **2개**(공격 시 / 수비 시) 설정, 선수마다 IP역할·OOP역할 **2개** 배정. 전통적 "멘탈리티 슬라이더"·"듀티"는 폐지되고, IP/OOP 팀지시 조합이 곧 멘탈리티. Visualiser가 3분할 존으로 국면 전환 형태를 시각화.
4. **팀토크 "의미"의 장치**: 톤/제스처 선택 → 개별 선수가 성격·사기·바디랭귀지에 따라 **각자 다르게** 반응 → 반응이 아이콘·색으로 즉시 가시화되고 이후 경기력/평점에 반영됨. 유저는 "상황 부적합 톤 = 붉은 반응 = 나쁜 경기력"의 피드백 루프로 선택의 의미를 학습.

---

## 1. 경기 관전 리듬 (Highlight Rhythm)

### 1.1 하이라이트 모드 (5단계) 🟦
FM은 "경기를 얼마나 볼지"를 유저가 선택한다. 드롭다운 순서(가벼움→무거움):
- **None (Commentary Only)**: 그래픽 없이 텍스트 코멘터리·스코어만. 가장 빠름.
- **Key Highlights**: 골·결정적 찬스·페널티·퇴장 등 "핵심 이벤트"만. 한 경기 실관전 시간 **~5분 내외**.
- **Extended Highlights**: Key + 위험한 전개·세이브·주요 파울까지. 실관전 **~15~20분**. 🟨 커뮤니티 다수 불만: 이벤트 직전 "데드타임"(슛 하나 보려고 앞의 2~3분 빌드업까지 재생)이 길어 체감 시간이 과하다.
- **Comprehensive Highlights**: Extended보다 더 촘촘, 사실상 준-풀매치.
- **Full Match (Full 90)**: 편집 없이 전 경기. 편안한 속도에서 **한 하프에 최대 1시간**까지 늘어짐.

### 1.2 하이라이트 사이 시간 처리 & 재생 속도 🟦🟨
- 하이라이트 사이 "아무 일 없는 시간"은 **자동 스킵**되고, 화면은 2D/데이터 요약(§5)으로 전환된다.
- **Match Speed 슬라이더**(하이라이트 드롭다운 위): 재생 속도 조절. 기본 Medium, 더 빠름/느림 단계 존재. 그래픽 프리셋(Low/Very Low)으로도 처리 부하를 낮춰 체감 속도를 올림. 🟨 정확한 프레임/배속 수치는 버전·환경 편차.
- **Continue Game Timeout**(설정): 클릭 없이 자동 진행 → 시즌 소화 속도 대폭 단축.

### 1.3 FM26 Dynamic Highlights 🟦 (핵심 신기능)
"경기 맥락에 따라 하이라이트 개수를 자동 조절"하는 모드. **중요하고 극적인 경기일수록 하이라이트가 많아지고**, 이미 4-0으로 앞서 마무리 국면이면 하이라이트 수가 줄어든다 → 긴장의 총량을 게임이 능동 관리(공식 표현: "more suspense and a more exciting viewing experience").

> **→ 웹 번역**: 관전 모드를 `핵심만(골·PK·퇴장)` / `확장(+빅찬스·세이브)` / `풀텍스트 코멘터리`의 3단으로 축소 제공하고, 이벤트 사이는 즉시 스킵해 "이벤트 카드"만 순차 노출. **Dynamic 규칙 1줄**: `표시할 이벤트 수 = base + f(점수차 근접도, 남은시간, 경기 중요도)` — 접전·종반일수록 이벤트를 더 뽑아 보여주고 대승 굳히기면 요약으로 넘긴다.

---

## 2. 경기 중 전술 개입 UX

### 2.1 시간 정지 여부 🟦 (질문 핵심)
- **자동 정지 아님**. 전술 화면/교체 화면에 들어가도 시뮬레이션은 계속 흐를 수 있으며, 유저는 **직접 일시정지(pause)**하거나 **하이라이트 사이 휴지 구간**에서 조작하는 것이 일반적. 즉 "개입하려면 흐름을 스스로 멈추는" 능동적 UX.
- 조작한 변경은 **즉시 반영되지 않고 이후 국면부터** 서서히 나타난다(선수 전달·적응 지연 서사).

### 2.2 터치라인 shouts 🟦
- **쿨다운 10분**(대략), 지시는 **다음 데드볼**(공 아웃 또는 휘슬)에 발효.
- FM26 shout 8종과 용도(공식/Operation Sports 정리):
  - **Encourage** — 어려운 국면·사기 저하 우려 시.
  - **Calm Down** — 거칠어지거나 카드 쌓일 때 진정.
  - **Focus** — 앞서며 방심(complacent)할 때 집중 환기.
  - **Fire Up** — Focus의 반대, 각성.
  - **No Pressure** — 강팀 상대 컵전 등 기대치 낮출 때.
  - **Demand More** — 뒤지고 있어 더 밀어붙일 때.
  - **Praise** — 리드 중 잘하는 걸 유지시킬 때.
  - **Berate** — 약체에 뒤지며 형편없을 때 질책.
- 성격상 "단기 조정"이며 전술 변경을 **보완**하는 수단(치료제 아님).

### 2.3 즉각 피드백 — 바디랭귀지/반응 🟦🟨
- shout·팀토크 직후 선수 옆에 **바디랭귀지 아이콘/반응 문구**가 뜬다. 긍정: "Fired up by the feedback", "Motivated", "Happy/Delighted". 부정: "Overwhelmed", "Frustrated", "Uninterested".
- 바디랭귀지 상태값: calm, composed, professional, motivated, complacent, nervous, frustrated, aggressive, disenchanted 등. 유저는 이 상태를 보고 다음 개입을 결정.

### 2.4 어시스턴트 개입 제안 🟦
- 어시스턴트/백룸 스태프가 경기 중 조언(상대 위협 지점, 교체 권고, 상대 전술 변화 힌트)을 제공. 상대 지시(Opposition Instructions)와 매치플랜은 어시스턴트에게 **위임 가능**.
- FM26에선 하이라이트 사이 **Match Overview 화면**에 백룸 인사이트 + 확장형 데이터 카드가 떠서 조정을 유도.

> **→ 웹 번역**: 이벤트 사이 "휴지 화면"에서만 전술 슬롯을 열 수 있게 하고(=자연스러운 정지), 열면 진행 버튼이 대기 상태가 되게 한다. **Shout은 3~4개 버튼**(다그치기/북돋기/침착/집중)으로 축약 + **쿨다운 타이머**(예: 10경기분). 누르면 각 선수 카드에 이모지 반응(🔥/😟/😐)이 1초 팝업 → "개입이 먹혔는지"를 즉시 체감. 어시스턴트는 이벤트 사이 1줄 토스트("우측 풀백이 계속 뚫립니다 — 교체 권고")로.

---

## 3. 전술 깊이 (FM26 In/Out of Possession)

### 3.1 멘탈리티 재정의 🟦 (패러다임 전환)
- 전통 **멘탈리티 슬라이더(수비적↔공격적) 폐지**. 이제 멘탈리티 = **IP 팀지시 + OOP 팀지시의 조합**으로 창발.
- 마찬가지로 **Duty(듀티: Defend/Support/Attack) 폐지** — 대신 국면별 형태와 역할 세트가 그 역할을 대신.

### 3.2 이중 포메이션 (핵심 구조) 🟦
- 유저는 포메이션을 **2개** 설정한다:
  1. **In Possession(공 소유 시)** 형태 — 빌드업 기준 대형.
  2. **Out of Possession(공 없을 때)** 형태 — 정착 수비 블록. IP를 정하면 게임이 **호환 OOP 3개를 추천**(예: 공격 4-3-3 → 수비 4-1-4-1처럼 "저비용 자연 전환").
- 선수 하나가 국면별로 다른 위치를 가질 수 있음: 공격 시 와이드 포워드 → 실점 후 수비형 미드필더로 낙하.

### 3.3 4가지 전술 뷰 🟦
- **In Possession**(공격 형태), **Out of Possession**(수비 구조), **Both**(좌우 나란히 비교로 전환 분석), **Combined**(두 형태의 평균 위치 표시 → 인원 교체를 양쪽에 동시 반영).
- **Visualiser**: 피치를 **세로 3분할 존**으로 나눠 공이 이동함에 따라 팀 형태가 어떻게 밀려 움직이는지 국면별로 시각화.

### 3.4 역할·개인 지시 🟦
- 선수마다 **IP 역할 + OOP 역할 2개** 배정, 각 역할은 클래식 **5성 적합도**로 평가(포지션 친숙도 + 핵심 능력치 기반).
- OOP 역할은 전부 신규(수비 행동 규정). 예: **Screening CM**(위치 이탈 않고 중앙 패스레인 차단), **Holding Full-Back**(남들이 압박할 때 더 깊게 남아 측면 커버, 전진 대신 구조 유지).
- 팀 수비 강도: **High Press / Mid Block / Low Block** 중 선택(각기 다른 OOP 역할·지시 세트).
- **세트피스**: 마킹을 존↔맨으로 전환 등 지시. 개인 지시로 마킹 대상·프리롤(자유 배회) 부여.

> **→ 웹 번역**: 포메이션을 "볼 있을 때 / 볼 없을 때" **2슬롯 토글**로 제공(둘 다 4-3-3처럼 같아도 됨, 다르게 하면 고급). 선수마다 역할은 IP/OOP **각 1개 드롭다운**. 멘탈리티 슬라이더 대신 **압박 3버튼(High/Mid/Low)** + **템포/폭 2슬라이더**로 팀지시를 압축. Visualiser는 SVG로 IP·OOP 두 형태를 애니메이션 보간(morph)해 "전환"을 1개 애니로 보여주면 FM Visualiser 감성 구현 가능. 5성 적합도 = 포지션친숙도×능력치 가중합 별점.

---

## 4. 팀토크 시스템 (Team Talks)

### 4.1 톤/제스처 선택지 🟦
- 전통 6톤: **Aggressive / Assertive / Cautious / Reluctant / Calm / Passionate**(각 톤이 감독→팀 전달 감정). Calm이 대부분 상황의 안전한 "기본선".
- FM21부터 **제스처(gestures)**가 톤을 보강/대체 — "인간 소통의 대부분은 비언어"라는 전제. 예: Outstretched Arms(양팔 벌리기), Pump Fists(주먹 불끈).

### 4.2 상황별 적합/부적합 🟦🟨
- 시점: **경기 전 / 하프타임 / 풀타임**, 그리고 득점·퇴장 등 이벤트 직후 라커룸/터널 토크.
- 경기 전 톤 매칭 가이드: 이길 것으로 기대되면 **Assertive/Passionate**, 대등하면 **Encouraging/Calm**, 언더독이면 **Passionate/Fired Up**.
- 하프/풀타임: 이겼지만 그저 그랬으면 **Calm**(과한 칭찬 자제), 스코어 동률이고 승리로 밀어붙이고 싶으면 **Passionate**, 못하고 뒤지면 **Aggressive**(질책·각성). 교체·개인 지목엔 **Assertive**로 확신 전달.
- 핵심 원리(가이드 공통): ① 방 분위기 읽기(성격·경험) ② 반복 회피(같은 말 재탕 시 무반응) ③ 과잉반응 금지(현실적 기대치에 맞는 비판).

### 4.3 개성 반응 & 가시화 🟦
- 같은 톤이라도 **선수별 성격·사기·현재 바디랭귀지에 따라 반응이 다름**. 개별/유닛(수비진 등) 지목 토크로 특정 선수만 겨냥 가능.
- 반응은 아이콘/문구 + 바디랭귀지 상태로 즉시 표시되고, 이후 경기 중 사기·평점에 파급.

### 4.4 "의미 있게" 느껴지게 하는 장치 🟦 (설계 통찰)
FM 팀토크가 도박이 아니라 "의미 있는 선택"으로 느껴지는 이유:
1. **즉각 피드백 루프**: 선택 → 각 선수 반응 아이콘(초록/빨강 계열) → 경기력 변화. 인과가 눈에 보임.
2. **상황 신호가 선행**: 스코어·경기력·상대 기대치라는 맥락이 "정답 톤"을 암시(강팀에 이기고도 Aggressive면 부적합).
3. **개성 지식이 실력**: 어떤 선수는 질책에 각성, 어떤 선수는 위축 → 유저가 스쿼드를 "알아갈수록" 적중률이 오르는 학습 곡선.
4. **반복 페널티**: 같은 말 남발 시 효과 감쇠 → 다양성 강제.

> **→ 웹 번역**: 팀토크를 **3~4개 톤 카드**(침착/자신감/열정/질책)로 축약하고, 경기 전·하프·풀 3시점에만 노출. 선택 즉시 **선수 아바타에 초록↑/빨강↓ 반응 배지**를 뿌리고 그 값을 다음 하프 사기 modifier로 직결. "정답 톤"은 `f(스코어차, 우리 경기력, 상대 기대치)`로 숨겨두되 부적합 선택엔 명확히 붉은 반응 다수 → 유저가 규칙을 귀납. 선수별 `mentalTrait`(예: 멘탈강함/예민)로 같은 톤 다른 반응 구현.

---

## 5. 정보 제공 (Information Layer)

### 5.1 경기 전 상대 리포트 🟦
- **스카우트/백룸**이 상대 예상 라인업·역할·전술 철학, **키 플레이어(danger men)**의 시즌 스탯, 부상/출전정지 리포트 제공.
- **성능 분석가(Performance Analyst)**: 상대 최근 경기를 파고들어 스타일·경향을 차트/그래프로 제시 — **"상대가 어떤 포메이션에 가장 취약한지"**까지 도출. 결과는 **Data Hub**에 집약.
- 리포트 축: 전술 셋업, 창조자/득점원, 약점(느린 수비수·세트피스 수비 취약 등), 최근 폼.

### 5.2 경기 중 정보 🟦🟨
- FM26 **Match Overview 화면**(하이라이트 사이): 2D 피치 뷰 + 백룸 인사이트 + **확장형 데이터 카드**로 조정 유도. 인게임 조언에 **xG·xA** 포함.
- 실시간 스탯: 점유율, 슛/유효슛, **xG**, 슛맵/패스맵, **선수 평점(1.0~10.0 실시간)**. 🔴 상대 전술 변경의 "명시적 알림 팝업" 유무는 소스에서 확정되지 않음(어시스턴트 코멘트/OI 화면으로 간접 파악하는 것이 일반적).

> **→ 웹 번역**: 경기 전 **상대 카드 1장**(포메이션 뱃지 + 키플레이어 2~3명 + 최근5경기 폼 점 + "약점 1줄")으로 스카우트 리포트를 압축. 경기 중엔 하이라이트 사이 **미니 대시보드**(점유 바 + xG 숫자 + 슛 카운트 + 양팀 top 평점 3명). 상대 변화는 어시스턴트 토스트로 알림. 슛맵은 SVG 좌표 점.

---

## 6. 긴장 연출 (Drama)

### 6.1 골 & 리플레이 🟦
- FM26은 **골 유형을 분석해 최적 리플레이 앵글을 자동 선택**("어떤 방식으로 넣든 완벽한 시점 보장"). 
- **Broadcast Mode**: 실제 TV 중계 영감, 다중 카메라 포인트 + 시네마틱 앵글 조합. 리빌드된 카메라 시스템으로 앵글 폭 확대.

### 6.2 순간 연출 🟦
- 애니메이션 프리매치 라인업, 방송형 카메라 컷, 맥락형 코멘터리 패널. Unity 전환으로 애니메이션 유려화(신규 GK 세이브/공 처리 모션). 관중 모델·군중 반응·날씨·조명·오디오 대폭 강화 → 공격 전개 시 "고조되는 긴장"을 청각적으로 전달.

### 6.3 종반 드라마 🟦
- Dynamic Highlights(§1.3)가 종반 접전에서 하이라이트를 늘려 극적 순간을 놓치지 않게 함 = "긴장 총량"을 엔진이 관리.

> **→ 웹 번역**: 골 순간은 **풀스크린 플래시 + 스코어 카운트업 애니 + 진동/사운드**로 임팩트. 종반(80분+ & 1점차)엔 **화면 테두리 붉은 펄스 + 코멘터리 톤 상승 + 이벤트 표시 빈도 증가**로 "조여오는 느낌". 카메라 대신 웹은 **코멘터리 텍스트의 리듬/폰트 크기 변주 + 컬러**로 시네마틱을 대체.

---

## 7. 웹게임 경기 루프 통합 제안 (1페이지 설계 스켈레톤)

```
[경기 전]  상대 카드(포메이션·키맨·폼·약점 1줄)  →  팀토크(톤 3~4카드)  →  전술 확정(IP/OOP 2슬롯)
   │
[킥오프]  이벤트 스트림(핵심/확장/텍스트 3모드)  ─ 이벤트 사이 = 미니 대시보드(점유·xG·슛·평점) ─┐
   │                                                                                        │
   ├─ 휴지 화면에서만 개입 열림: 교체 / 전술 토글 / Shout(쿨다운 타이머)  → 다음 국면부터 반영 │
   │        (개입 시 선수 카드 이모지 반응 즉시 팝업)                                          │
   │                                                                                        │
[하프타임]  팀토크(반응 배지 → 후반 사기 modifier)  ────────────────────────────────────────┘
   │
[종반 80'+]  Dynamic 규칙으로 이벤트 밀도↑ + 붉은 펄스 연출
   │
[풀타임]  팀토크 + 평점 요약 + xG 리캡
```

**핵심 이식 원칙 3가지**
1. **"흐름을 멈춰야 개입한다"** — FM의 능동적 정지 감성을 휴지 화면 게이팅으로 재현(무한 정지 방지).
2. **모든 개입에 즉각 가시 피드백** — shout·팀토크·전술 변경은 반드시 이모지/배지/토스트로 "먹혔다"를 1초 내 보여준다.
3. **긴장 총량을 엔진이 관리** — Dynamic Highlights처럼 접전·종반에 이벤트 밀도와 연출 강도를 올린다.

---

## 소스 URL

**공식(SI / footballmanager.com)**
- FM26 In/Out of Possession 공식 기능: https://www.footballmanager.com/fm26/features/possession-out-possession-fm26s-new-tactical-evolution
- FM26 Match Day Experience 공식 기능: https://www.footballmanager.com/fm26/features/where-storytelling-evolves-fm26s-match-day-experience
- SI 매뉴얼 — Playing A Match (FM24): https://community.sports-interactive.com/sigames-manual/football-manager-2024/playing-a-match-r4966/
- SI 매뉴얼 — Tactics (FM24): https://community.sports-interactive.com/sigames-manual/football-manager-2024/tactics-r4960/
- SI 매뉴얼 — Playing A Match (FM24 Touch/Console): https://community.sports-interactive.com/sigames-manual/football-manager-2024-touch-and-console/playing-a-match-r4990/
- SI 버그트래커 — Extended Highlights 시간 과다(FM26): https://community.sports-interactive.com/bugtracker/1644_football-manager-26-bugs-tracker/1881_match-engine-stats-data-hub/2177_match-engine/extended-highlights-too-much-time-r41240/
- SI 포럼 — 팀토크 톤 논의: https://community.sports-interactive.com/forums/topic/234536-calmassertivereluctantpassionateaggressive-etc/
- SI 포럼 — Match speed highlights: https://community.sports-interactive.com/forums/topic/510356-match-speed-highlights/
- SI 포럼 — 인매치 패스맵/슛맵 데이터: https://community.sports-interactive.com/forums/topic/595582-in-match-pass-maps-shot-maps-data-etc/

**커뮤니티 심층 가이드**
- Operation Sports — Understanding Shouts in FM26: https://www.operationsports.com/understanding-shouts-in-fm26-and-how-they-affect-your-team/
- Passion4FM — In & Out of Possession Formations (FM26): https://www.passion4fm.com/explaining-in-out-of-possession-formations/
- Passion4FM — FM26 Tactics Creation Beginners Guide (Visualiser 포함): https://www.passion4fm.com/fm26-tactics-creation-beginners-guide/
- Passion4FM — How to Use Touchline Shouts: https://www.passion4fm.com/how-to-use-touchline-shouts-in-football-manager/
- Passion4FM — Morale & Man-Management: https://www.passion4fm.com/how-to-improve-players-morale-happiness-in-football-manager/
- Passion4FM — Scouting/Analyzing Next Opposition: https://www.passion4fm.com/analyzing-the-next-opposition-in-football-manager/
- RealSport101 — FM26 Tactics Overhaul IP/OOP Explained: https://realsport101.com/article/fm-26-tactics-overhaul-in-possession-out-of-possession-formations-explained
- FM Scout — FM26 Player Roles Complete Guide: https://www.fmscout.com/a-football-manager-2026-player-roles.html
- FM Scout — FM26 Match Day Experience: https://www.fmscout.com/a-fm26-match-day-experience.html
- FM Scout — FM26 Match Engine First Look: https://www.fmscout.com/a-fm26-match-engine-first-look.html
- FRVR — FM26 All Positions & Roles Explained: https://frvr.com/blog/football-manager-26-all-player-positions-and-roles-explained/
- FM Base — What Match Setting Do You Use: https://fm-base.co.uk/threads/what-match-setting-do-you-use.4636/
- FootballManagerBlog — Mastering Team Talks: https://www.footballmanagerblog.org/2023/05/mastering-team-talks-in-football-manager.html
- GuideToFM — Team Talks: https://www.guidetofm.com/match-day/team-talks/
- GGRecon — How to change highlight speed (FM24): https://www.ggrecon.com/guides/football-manager-2024-change-highlights/

**리뷰**
- NGOHQ — FM26 Review: https://www.ngohq.com/2025/11/11/football-manager-26-review/
- Analog Stick Gaming — FM26 Review: https://www.analogstickgaming.com/game-reviews/2025/11/3/football-manager-26

---

## 미확정 / 추가 검증 권장

- 🔴 각 하이라이트 모드의 **정확한 실관전 분(分)**은 유저 환경·배속·버전 편차가 커서 범위값으로만 신뢰. Extended "~15~20분"은 커뮤니티 관측.
- 🔴 **경기 중 상대 전술 변경의 명시적 알림 UI** 존재 여부는 1차 소스에서 확정 못함(어시스턴트 코멘트·OI 화면 경유가 일반적).
- 🔴 shout **쿨다운**은 소스에 따라 "10분" vs "15~20분마다 갱신" 혼재 — FM26 공식/OS 기준 "10분마다 가능, 다음 데드볼 발효"를 채택.
- 🟨 FM26에서 전통 6톤 명칭이 제스처 체계로 얼마나 대체·유지되는지 버전별 표기 차이 존재 → 인게임 최종 확인 권장.
