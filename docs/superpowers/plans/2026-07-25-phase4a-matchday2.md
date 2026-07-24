# Phase 4A: 매치데이 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. 정본 스펙: specs/2026-07-23-...-design.md §17.

**Goal:** 경기 루프를 "하이드레이션 브레이크 개입 + 하이라이트 리듬 재생 + 실시간 전술 가시화"로 재구축 — 재미없는 시뮬을 감독 게임으로.

**Architecture:** matchStore가 "재생 세션" 상태 머신을 소유(브레이크 스케줄·동적 순간 감지·속도). MatchScreen은 오버레이 없이 배너+사이드 패널. 엔진 무변경 원칙(분 단위 stepping은 simulateSegment(state, m+1)로 이미 가능) — 단 동적 순간 감지는 이벤트 스트림 분석 순수 함수.

## Global Constraints
- 개입 중 시간 완전 정지·카운트다운 금지. 피치 가리는 오버레이 금지
- 1x 속도 = 총 재생 3~5분 (90분 기준), 토글 1x/1.5x/2x
- Date/Math.random 금지(UI 타이머는 setInterval 상수만), 기존 243 테스트 무손상(재생 방식 변경으로 기존 matchscreen 테스트는 재작성 허용 — 어서션 의도 유지)
- 커밋 트레일러 동일

## 섹션: A=T1~3(루프·속도·레이아웃) ✋완료 / B=T4~8(모드 분리·전술 확장·외침·선수카드·팀토크) ✋ / C=T9~10(연출·사운드·검증) ✋

### Task 1: matchStore 재생 세션 재설계
**Files:** Modify src/game/matchStore.ts / Create src/game/matchSession.ts(순수 로직) / Test
**계약:**
- `matchSession.ts` 순수 함수: `breakSchedule(seed): { firstHydration: number; secondHydration: number }` (30±2', 75±2' — 시드 결정론), `detectMoment(events, minute, score, prevScore, staminaFloor): DecisionMoment | null` — 유형: 'conceded'(실점 직후)|'momentum-lost'(최근 10분 상대 슛 3+)|'scored'(득점 직후)|'clutch'(80'+ 스코어차≤1)|'fatigue'(주전 stamina<35). 같은 유형 경기당 1회
- matchStore 재설계: `phase: 'pre'|'playing'|'paused-break'|'paused-user'|'paused-moment'|'halftime'|'fulltime'`, `pauseReason: { kind: 'hydration1'|'halftime'|'hydration2'|'moment'|'user'; moment?: DecisionMoment } | null`, `advanceMinute(): void` (simulateSegment(engine, minute+1) 1분 스텝 — UI 타이머가 호출. 브레이크 분·하프타임 도달 시 자동 pause, 동적 순간 감지 시 'paused-moment'가 아니라 **momentPrompt 세팅**(재생은 계속 — 유저가 응하면 pause)), `pauseByUser()/confirmTactics()`(재개 — 모든 pause 공통), `momentPrompt: DecisionMoment | null` + `acceptMoment()/dismissMoment()`
- submitCommand는 **모든 paused 상태 + halftime에서 허용** (playing 중 금지 유지)
- 개입 부스트: confirmTactics 시 `boostUntil = minute + 8` 저장 — 엔진 전달은 Task 4에서 (이번엔 상태만)
- 기존 playTo/decisionMinutes(0xdec1) 제거·대체. 데모/캠페인 어댑터(App·MatchScreen 호출부)는 Task 3에서 — 이 태스크는 스토어+순수 로직+테스트만 (기존 UI가 일시적으로 구버전 API를 쓰면 컴파일 깨짐 → **호환 셔징 금지, Task 3까지 같은 브랜치에서 순차 진행하므로 이 태스크에서 MatchScreen의 최소 컴파일 수정 허용**, 동작 재작성은 Task 3)
**TDD:** breakSchedule 결정론·범위 / detectMoment 유형별 트리거·유형당 1회 / advanceMinute가 30'±2 창에서 자동 pause / confirmTactics 재개 / 카운트다운 부재(타이머 없음 구조 확인은 Task 3)

### Task 2: 하이라이트 리듬 + 속도 시스템 (UI 재생 루프)
**Files:** Modify src/ui/match/MatchScreen.tsx / Create src/ui/match/playback.ts(순수) / Test
**계약:**
- `playback.ts`: `minuteDwellMs(minute, events, speed): number` — 해당 분에 이벤트 있으면 dwell 크게(연출 시간: goal 4000ms/shot·save·miss 2500/foul·corner 1200), 없으면 300ms. speed 1/1.5/2로 나눔. **클러치 가중**(FM26 Dynamic Highlights 참조): 80'+ 스코어차≤1이면 무사건 dwell도 2배(긴장 유지). **블로우아웃 가속**: 3골차 이상이면 전체 dwell ×0.6 (Task 9에서 소급 적용 가능). **1x 총합이 90분 기준 180~300초가 되게 상수 설계**(검증 테스트: 평균 이벤트 밀도(경기당 이벤트 25~40개 가정)에서 총 dwell 합 180k~300k ms)
- MatchScreen: setInterval 고정 200ms 대신 **분당 가변 setTimeout 체인** — advanceMinute() 호출 → dwell 계산 → 다음 스텝. 속도 토글 UI(1x/1.5x/2x, 스코어버그 옆). pause 상태면 체인 정지, confirmTactics로 재개
- 시계 빨리감기 연출: 무사건 분은 분 숫자가 빠르게 넘어가는 시각 효과(CSS)
**TDD:** minuteDwellMs 수치·1x 총합 범위 / fake timers로 재생→pause→재개

### Task 3: 레이아웃 재구축 — 오버레이 폐지
**Files:** Modify src/ui/match/MatchScreen.tsx·match.css, src/ui/match/TeamTalk.tsx 위치 이동, App 데모/캠페인 어댑터 / Test 재작성
**계약:**
- 피치 가리는 오버레이 전부 제거. 대체: **상단 방송 배너**(브레이크: "🧊 하이드레이션 브레이크 — 벤치가 분주합니다" / 순간 제안: "⚡ 실점 직후 — 감독 타임을 쓰시겠습니까? [사용] [흘려보낸다]" / 골: 대형 배너는 Task 7) + **우측 콘솔이 개입 허브로 전환**(paused 시 강조 테두리+ [전술 확정] 버튼 콘솔 하단 고정)
- 하프타임: 배너 + 콘솔 개입 + TeamTalk을 콘솔 상단 카드로 (피치는 계속 보임)
- 킥오프·풀타임 패널은 피치 밖(하단 바 확장)으로
- pre 단계: 데모도 LineupScreen 먼저 (App 데모 플로우에 삽입)
- 기존 matchscreen 테스트 재작성 (의도 유지: 스포일러 방지·LIVE·onDone 1회 등)
**TDD:** 스모크 — paused-break에서 피치(svg) 렌더 유지+콘솔 활성, momentPrompt 배너 [사용]→pause [흘려보낸다]→계속, 풀타임 하단 바

### ✋ 섹션 A 플레이테스트 체크포인트 (dev 서버 열어 사용자 확인)

### Task 4: 모드 분리 — 방송 관전 ↔ 작전 지시 (아키텍처)
**Files:** Modify src/ui/match/MatchScreen.tsx·match.css / Create src/ui/tactics/TacticsBoard.tsx·tactics.css / Test
**계약:**
- MatchScreen 2모드: **'broadcast'**(관전 — 피치+스코어버그+티커+외침 버튼만, 콘솔 패널 제거) ↔ **'tactics'**(작전 지시 — 풀스크린 작전판). pause(브레이크/HT/감독타임/순간수락) 시 **전환 연출**(0.6s — 방송 화면이 어두워지며 작전판이 올라옴, "작전 타임" 라벨) → TacticsBoard / [전술 확정] 시 역연출로 방송 복귀. **시뮬 중인지 지시 중인지 절대 헷갈리지 않는 시각 정체성**: 방송=그린 피치·라이브 그래픽 / 작전판=다크 보드·전술 다이어그램 톤(초크/라인 스타일)
- TacticsBoard 레이아웃: 중앙 대형 보드(편집 가능한 피치 다이어그램 — 도트+이름 라벨) / 우측 지시 패널(탭: 전술·교체·상대) / 하단 [전술 확정] 대형 버튼 + 현재 정지 사유 표시
- **실시간 보드 반영**: 포메이션·멘탈리티·페이즈 변경 즉시 보드 도트가 새 위치로 0.5s 애니메이션 (변경→시각 피드백 루프)
- broadcast 모드: 기존 우측 콘솔 완전 제거(외침 바만 — Task 5), 피치 와이드
**TDD:** pause→tactics 모드 렌더(보드+확정 버튼)·confirm→broadcast 복귀 / 포메이션 변경 시 도트 좌표 변경 / 스모크

### Task 5: 전술 지시 확장 + 트레이드오프 (엔진+작전판)
**Files:** Modify src/engine/{types,simulate,tactics,strength}.ts, src/ui/tactics/TacticsBoard.tsx / Test
**계약 (엔진):**
- `TacticState` 확장: `mentality`(5프리셋 — 기존 계획 유지), `phaseFormations`(공격 시/수비 시 — 기존 계획 유지), **`groupIntensity: { attack: -1|0|1; midfield: -1|0|1; defense: -1|0|1 }`**(라인별 적극성 — 존 전력·체력 소모에 반영), **`attackPattern: 'balanced'|'cross'|'through'|'longshot'`**(크로스=코너·헤더 찬스↑ 컷인↓ / 중앙 침투=through 찬스 퀄↑ 인터셉트 리스크↑ / 중거리=슛 빈도↑ xG↓), **`gkPowerplay: boolean`**(85'+ & 지는 중에만 유효 — 세트피스·코너에서 GK 전진: 해당 찬스 퀄 +40% & 상대 역습 시 빈 골문 실점 확률 3배 — 극적 도박)
- **지속 압박 페널티 ★**: 압박 70+ 유지 시 분당 체력 소모 누적 가중(10분마다 +15%씩 — "90분 내내 압박 100" 물리적으로 불가), **팀 평균 체력<55면 압박 실효 반감+파울·경고 확률 1.5배**(지친 압박은 파울이 된다). 하이라인 기존 counterVulnerability 유지
- 개입 부스트 ×1.3 (기존 계획 유지 — simulateSegment opts)
- 회귀 보장: 신규 필드 전부 기본값(balanced/0/false)이면 기존 결과 불변 (시드 회귀 테스트)
**계약 (작전판 UI):** 멘탈리티 5버튼 / 4축 슬라이더에 **비용 표시**(압박 옆 ⚡"체력 소모 +40% · 지치면 파울 증가", 라인 옆 ⚠"뒷공간 노출") / 그룹 적극성 3줄 토글 / 공격 패턴 4택 / GK 파워플레이 토글(조건 미충족 시 잠금+사유) / 페이즈 포메이션 3슬롯
**TDD:** 각 지시의 엔진 효과 방향 / 지속 압박 누적·저체력 반전 / GK 파워플레이 양면 효과 / 기본값 회귀 불변

### Task 6: 터치라인 외침 + 코치 제안 카드 (FM 이식)
**Files:** Modify src/game/matchStore.ts, src/ui/match/MatchScreen.tsx / Create src/game/coach.ts(순수), src/ui/match/ShoutBar.tsx / Test
**계약:**
- **외침(Shouts)**: broadcast 모드 하단 4버튼 [독려][더 뛰어][침착][칭찬] — 정지 없이 즉시, **10분 쿨다운**(진행 바 표시), 효과: 사기/템포/침착 소폭 보정(결정론 테이블 — 상황 부적합 시 역효과: 이기는데 [더 뛰어]=피로 가중 등). decisionLog 기록
- **코치 제안 카드**: 브레이크·HT 진입 시 `coach.ts`가 실측 이벤트 분석(최근 실점 존·상대 슛 분포·체력 하위 3인·점유 열세)으로 **제안 1~2개 생성** — "상대 공격 60%가 우리 왼쪽 — 수비 라인 -10 또는 왼쪽 보강 추천" + **[제안 적용]** 원클릭(해당 지시 자동 세팅, 유저가 확정 전 수정 가능). TacticsBoard 상단 카드로 표시. 결정론·사실 기반(비하 금지)
**TDD:** 쿨다운·상황별 보정 부호 / coach 제안이 이벤트 분포 반영(왼쪽 실점 몰림 픽스처→왼쪽 언급)·적용 시 지시 변경

### Task 7: 선수 카드 2.0 — 육각 레이더·보드 하이라이트·교체 UX
**Files:** Create src/ui/common/PlayerCard.tsx(육각 레이더 SVG·아바타), Modify src/ui/tactics/TacticsBoard.tsx, src/ui/lineup/LineupScreen.tsx, src/ui/console/OppPanel.tsx(신설 — 상대 탭) / Test
**계약:**
- **PlayerCard**: 이니셜 아바타(팀 컬러) + 이름·등번호·포지션·역할 + **육각형 레이더 차트**(SVG — 슈팅/패스/드리블/수비/피지컬/스피드, GK는 3축 변형) + 주발 아이콘 + 체력·사기 게이지. 어디서든 재사용
- **보드 하이라이트**: 작전판·라인업에서 선수(도트·이름·벤치 카드 어디든) 클릭 → 보드 위 해당 도트 **발광 링 + 카드 팝오버**. 교체 플로우: 출전 선수 선택 → 보드에서 포지션 링 강조 → 벤치 선수 선택 → **들어갈 자리 미리보기(고스트 도트)** → [교체 확정]. "이 선수가 어디 포지션인지 안 보임" 해소
- **상대 탭**(OppPanel — 작전판 내): 상대 포메이션·선발 11(카드)·키 플레이어 강조·styleNotes·매치업 힌트(formationEdge)
**TDD:** 레이더 SVG 스탯 반영(포인트 좌표) / 클릭→하이라이트 상태 / 교체 미리보기→확정 흐름 / OppPanel 키 플레이어·힌트

### Task 8: 팀토크 의미화 (+FM 반복 감쇠·기대치)
**Files:** Modify src/ui/match/TeamTalk.tsx, src/game/matchStore.ts / Test
**계약:** 기존 계획(사기 게이지 사전 표시·코치 추천 뱃지·선수별 반응 아이콘 2~3명·delta 표시) + **FM 확장**: ① 같은 톤 반복 시 효과 반감(캠페인 저장 — campaignStore.lastTeamTalkTone) ② **상대 기대치 반영**: FIFA 랭킹 차로 언더독/favorite 판정 → TEAM_TALK_TABLE 보정(언더독이 0-1로 지는 중엔 "침착" 유효, favorite가 지는 중엔 "격노" 유효 등 — 결정론 테이블 확장)
**TDD:** 반복 감쇠 / 기대치별 추천 톤 변화 / 기존 케이스 유지

### ✋ 섹션 B 플레이테스트 체크포인트

### Task 9: 연출 — 하이라이트 시퀀스·골 드라마 (데드타임 금지: 시퀀스는 액션 직전 시작, 빌드업 3초 이내 — FM 교훈)
**Files:** Modify src/ui/pitch/PitchView.tsx·pitch.css, src/ui/match/MatchScreen.tsx·match.css / Create src/ui/pitch/choreography.ts(순수: 이벤트→도트·공 이동 키프레임) / Test(choreography 순수 로직)
**계약:**
- `choreography.ts`: 이벤트 타입별 2~4스텝 키프레임 생성(빌드업 도트 2~3개 이동→슛 궤적→결과) — 좌표는 slotCoords 기반+이벤트 존, 결정론(minute 해시)
- PitchView: 공(원) + 키프레임 CSS transition 재생, 전술 변경 시 도트가 새 slotCoords로 0.8s 이동(이미 좌표 기반이라 transition만), 페이즈 포메이션 전환 시 형태 변화
- 골 드라마: 화면 플래시 + "GOAL!" 대형 타이포 + 득점자 배너 + 스코어버그 펄스 (2.5s)
- 위험 순간: xG 0.25+ 찬스에서 비네팅+티커 강조
**TDD:** choreography 키프레임 수·결정론·좌표 범위. 시각은 스모크+플레이테스트

### Task 10: 사운드 + 통합 검증
**Files:** Create src/audio/sfx.ts, public/sfx/*(생성 — **Web Audio API 합성으로 자체 생성**: 함성 노이즈 루프·골 폭발·휘슬. 외부 음원 다운로드 금지(라이선스 리스크 0)) / Modify MatchScreen / Test(로직만)
**계약:** `sfx.ts`: AudioContext 합성(브라운 노이즈 함성 베이스, 골 시 화이트노이즈 버스트+피치 스윕, 휘슬 사각파) — 음소거 토글(기본 ON, localStorage 기억). 골·킥오프·풀타임·브레이크 휘슬 연결
통합: 전체 스위트+빌드, 자동 완주 회귀, 컨트롤러 E2E — 그 후 ✋ 사용자 최종 플레이테스트

## Phase 4B 이관: 상대 인게임 전술 변경 통보·benchPattern 교체 / 마킹·세트피스 지시 / 배포·시연영상 (기존 Phase 4 목록 유지)
