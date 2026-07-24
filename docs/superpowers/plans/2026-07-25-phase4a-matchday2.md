# Phase 4A: 매치데이 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. 정본 스펙: specs/2026-07-23-...-design.md §17.

**Goal:** 경기 루프를 "하이드레이션 브레이크 개입 + 하이라이트 리듬 재생 + 실시간 전술 가시화"로 재구축 — 재미없는 시뮬을 감독 게임으로.

**Architecture:** matchStore가 "재생 세션" 상태 머신을 소유(브레이크 스케줄·동적 순간 감지·속도). MatchScreen은 오버레이 없이 배너+사이드 패널. 엔진 무변경 원칙(분 단위 stepping은 simulateSegment(state, m+1)로 이미 가능) — 단 동적 순간 감지는 이벤트 스트림 분석 순수 함수.

## Global Constraints
- 개입 중 시간 완전 정지·카운트다운 금지. 피치 가리는 오버레이 금지
- 1x 속도 = 총 재생 3~5분 (90분 기준), 토글 1x/1.5x/2x
- Date/Math.random 금지(UI 타이머는 setInterval 상수만), 기존 243 테스트 무손상(재생 방식 변경으로 기존 matchscreen 테스트는 재작성 허용 — 어서션 의도 유지)
- 커밋 트레일러 동일

## 섹션: A=T1~3(루프·속도·레이아웃) ✋플레이테스트 / B=T4~6(전술 확장·정보) ✋ / C=T7~8(연출·사운드·검증) ✋

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
- `playback.ts`: `minuteDwellMs(minute, events, speed): number` — 해당 분에 이벤트 있으면 dwell 크게(연출 시간: goal 4000ms/shot·save·miss 2500/foul·corner 1200), 없으면 300ms. speed 1/1.5/2로 나눔. **클러치 가중**(FM26 Dynamic Highlights 참조): 80'+ 스코어차≤1이면 무사건 dwell도 2배(긴장 유지). **1x 총합이 90분 기준 180~300초가 되게 상수 설계**(검증 테스트: 평균 이벤트 밀도(경기당 이벤트 25~40개 가정)에서 총 dwell 합 180k~300k ms)
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

### Task 4: 전술 확장 — 멘탈리티·페이즈 포메이션·부스트 (엔진+콘솔)
**Files:** Modify src/engine/{types,simulate,strength}.ts, src/ui/console/ConsolePanel.tsx / Test
**계약:**
- `TacticState`에 `mentality: 'ultra-def'|'def'|'balanced'|'atk'|'all-out'`(instructions 프리셋 매핑 + 찬스 퀄리티/역습 취약 모디파이어), `phaseFormations?: { attack?: FormationId; defense?: FormationId }` — 엔진: 점유 페이즈(atkIdx)면 attack 형태의 존 가중, 수비면 defense (zoneStrength에 phase 인자 추가), UI: 콘솔에 3슬롯(기본/공격/수비) 선택
- 개입 부스트: matchStore.boostUntil을 simulateSegment 지시 효과에 ×1.3 (엔진 opts로 전달 — createMatch가 아니라 segment 단위 오버라이드 인자 추가: `simulateSegment(state, to, { instructionBoost?: { side, until } })`)
- 결정론·기존 캘리브레이션 게이트 유지 (mentality 'balanced'+phaseFormations 미지정 = 기존과 동일 동작이 기본값 — 회귀 보장)
**TDD:** 프리셋 매핑 / phase 존 가중 반영 / 부스트 구간 효과 / 미사용 시 기존 결과 불변(시드 회귀)

### Task 5: 정보 노출 — 선수 카드·상대 열람·매치업 힌트
**Files:** Modify src/ui/console/SubPanel.tsx, src/ui/lineup/LineupScreen.tsx / Create src/ui/console/OppPanel.tsx, src/ui/common/PlayerCard.tsx / Test 스모크
**계약:**
- `PlayerCard`: 6축 미니 바 + 주발 아이콘(L/R/양발) + 체력·사기 게이지 + 역할 — 교체 패널·라인업(호버/선택 시)·상대 열람 공용
- `OppPanel`(콘솔 3번째 탭 "상대"): 상대 포메이션·선발 11(PlayerCard)·키 플레이어 강조(keyPlayers)·styleNotes·**매치업 힌트**(formationEdge 부호로 "중원 수적 우위/열세" 한 줄)
- 상대 전술 변경 통보: 엔진 이벤트에 상대 카운터 시 'opp-tactic' 이벤트 추가는 스코프 밖(Phase 4B) — 현 버전은 상대 포메이션 표시가 정적임을 주석
- LineupScreen: 선수 칩 클릭 시 PlayerCard 팝오버, 벤치 카드에 스탯 요약
**TDD:** PlayerCard 렌더(스탯 반영) / OppPanel 키 플레이어 강조·매치업 힌트 부호

### Task 6: 팀토크 의미화
**Files:** Modify src/ui/match/TeamTalk.tsx, src/game/matchStore.ts / Test
**계약:** 사기 평균 게이지+상태 문구 사전 표시 / 톤 버튼에 코치 힌트 툴팁(상황별 추천 — TEAM_TALK_TABLE 기반: 현 스코어 상황에서 최대 보정 톤에 "코치 추천" 뱃지) / 선택 후 반응 피드백: 팀 단위 문구 + **선수별 반응 아이콘 2~3명**(FM 방식 — 주장·키플레이어의 🔥/😰 개별 반응, 결정론) / 역효과 시 경고 문구(보정 음수) — matchStore.applyTeamTalk이 적용 결과(delta) 반환하도록 확장
**TDD:** 추천 뱃지가 상황별 최대 보정 톤에 / delta 반환·표시

### ✋ 섹션 B 플레이테스트 체크포인트

### Task 7: 연출 — 하이라이트 시퀀스·골 드라마·전술 반영 애니메이션
**Files:** Modify src/ui/pitch/PitchView.tsx·pitch.css, src/ui/match/MatchScreen.tsx·match.css / Create src/ui/pitch/choreography.ts(순수: 이벤트→도트·공 이동 키프레임) / Test(choreography 순수 로직)
**계약:**
- `choreography.ts`: 이벤트 타입별 2~4스텝 키프레임 생성(빌드업 도트 2~3개 이동→슛 궤적→결과) — 좌표는 slotCoords 기반+이벤트 존, 결정론(minute 해시)
- PitchView: 공(원) + 키프레임 CSS transition 재생, 전술 변경 시 도트가 새 slotCoords로 0.8s 이동(이미 좌표 기반이라 transition만), 페이즈 포메이션 전환 시 형태 변화
- 골 드라마: 화면 플래시 + "GOAL!" 대형 타이포 + 득점자 배너 + 스코어버그 펄스 (2.5s)
- 위험 순간: xG 0.25+ 찬스에서 비네팅+티커 강조
**TDD:** choreography 키프레임 수·결정론·좌표 범위. 시각은 스모크+플레이테스트

### Task 8: 사운드 + 통합 검증
**Files:** Create src/audio/sfx.ts, public/sfx/*(생성 — **Web Audio API 합성으로 자체 생성**: 함성 노이즈 루프·골 폭발·휘슬. 외부 음원 다운로드 금지(라이선스 리스크 0)) / Modify MatchScreen / Test(로직만)
**계약:** `sfx.ts`: AudioContext 합성(브라운 노이즈 함성 베이스, 골 시 화이트노이즈 버스트+피치 스윕, 휘슬 사각파) — 음소거 토글(기본 ON, localStorage 기억). 골·킥오프·풀타임·브레이크 휘슬 연결
통합: 전체 스위트+빌드, 자동 완주 회귀, 컨트롤러 E2E — 그 후 ✋ 사용자 최종 플레이테스트

## Phase 4B 이관: 상대 인게임 전술 변경 통보·benchPattern 교체 / 마킹·세트피스 지시 / 배포·시연영상 (기존 Phase 4 목록 유지)
