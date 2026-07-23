# Phase 2B: 캠페인 + 실데이터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox 문법.

**Goal:** 12개국 실데이터를 게임에 연결하고, 조별 3경기(역사 재현)→토너먼트(1·2위 경로)→엔딩의 캠페인 루프를 완성한다.

**Architecture:** `src/data/loader.ts`가 data/teams JSON을 타입 검증 로드(포메이션 매핑 포함). `campaignStore`가 캠페인 상태 머신(경기 결과 집계·진출 판정·경로·체력 이월)을 관리하고, 경기 자체는 기존 matchStore/MatchScreen 재사용. 조별 경기는 엔진의 신규 `firstHalfScript` 옵션으로 실제 전반을 재현한다.

**Tech Stack:** 기존 + `@dnd-kit/core`(라인업 드래그앤드롭)

## Global Constraints
- 기본 정보(선수 실명·등번호) 무결성: 로더는 JSON을 변형하지 않는다. 검증 실패 시 명시적 에러
- 역사 스크립트는 리서치 🟢 사실만 (스코어·득점자·득점 분): 체코 2-1(크레이치 59' / 황인범 67'·오현규 80'), 멕시코 0-1(로모 50'), 남아공 0-1(마세코 63') — 경기 순서: 체코→멕시코→남아공
- 진출 규칙: 조 1·2위만 (사용자 확정). 1위 경로: ecu→eng→nor→arg→esp / 2위: can→mar→fra→esp→arg
- 캠페인 결정론: campaignSeed에서 경기별 시드 파생 (`campaignSeed*31+matchIndex`)
- UI의 엔진 함수 직접 호출 금지(matchStore/campaignStore 경유), 커밋 트레일러 동일, `npm test`+`npm run build` 그린 유지

## File Structure
```
src/data/loader.ts              # JSON→Team 타입 로드+검증+포메이션 매핑
src/data/groupStage.ts          # 조별 3경기 역사 스크립트 (실측)
src/engine/types.ts             # Team.flag?: string 추가
src/engine/simulate.ts          # createMatch opts.firstHalfScript 지원
src/game/campaignStore.ts       # 캠페인 상태 머신
src/ui/lineup/LineupScreen.tsx  # 포메이션 선택+선수 배치(DnD+클릭 스왑)+적합도 경고
src/ui/campaign/HubScreen.tsx   # 캠페인 허브 (브래킷·다음 경기)
src/ui/campaign/EndingScreen.tsx# 라운드별 엔딩
src/App.tsx                     # 캠페인 플로우 라우팅
```

## 섹션: A=T1~3(데이터·엔진·캠페인 로직) / B=T4~6(UI) / C=T7~8(조립·검증)

---

### Task 1: 실데이터 로더 + 역사 스크립트 데이터
**Files:** Create `src/data/loader.ts`, `src/data/groupStage.ts` / Modify `src/engine/types.ts`(Team에 `flag?: string` 추가) / Test `src/data/__tests__/loader.test.ts`
**Interfaces:**
- `loadTeam(id: TeamId): Team` — data/teams JSON import(정적 import 12개), 검증(스쿼드≥18, 등번호 유니크, GK≥1, 스탯 1~99), `mapFormation(pref: string): FormationId`(미지원 포메이션→가장 가까운 지원 6종: '4-2-2-2'→'4-4-2', '3-4-2-1'→'3-5-2', '4-1-3-2'→'4-4-2', '3-1-4-2'→'3-5-2', 그 외 미지원→'4-4-2'), `TeamId = 'kor'|'cze'|...12종`
- `loadAllTeams(): Record<TeamId, Team>`
- `groupStage.ts`: `GROUP_MATCHES: { opponent: TeamId; realScore: [number,number]; koreaHome: boolean; firstHalfScript: ScriptEvent[] }[]` — `ScriptEvent = { minute: number; type: 'goal'; teamId: string; playerName: string }` (전반 이벤트만 — 3경기 모두 전반 0-0이므로 빈 배열이 사실. **주의: 실제 득점은 전부 후반(50'~80')이므로 firstHalfScript는 전부 []** — 후반은 유저가 시뮬로 바꾼다. realScore는 참고 표시용)
**TDD:** 12팀 전체 로드 성공·선수 총원 312·kor에 손흥민 #7 존재·포메이션 매핑 전 팀 FormationId 유니온 내·미지원 매핑 규칙·스크립트 3경기 순서(cze→mex→rsa)

### Task 2: 실데이터 캘리브레이션 재검증
**Files:** Test `src/engine/__tests__/realdata-calibration.test.ts`
**내용:** runBatch(loadTeam('kor'), loadTeam('cze'), 100) 등 조별 3매치업 + esp vs arg에 대해 checkCalibration의 shots·fouls 게이트 통과(±15%→**실팀은 ±25% 완화 게이트**: 서로 다른 베이스라인 팀 간 대전이라 계약보다 느슨하게 — 근거 주석 필수) + 스코어 현실성(팀당 0~8골) + esp가 kor에 100경기 55승 이상(전력 반영). 실패 시 simulate.ts 상수 조정 금지 — **베이스라인 결합이 실팀에서 어긋나면 보고 후 컨트롤러 판정** (Phase 1 계약이 동급팀 기준이었으므로)

### Task 3: campaignStore
**Files:** Create `src/game/campaignStore.ts` / Test `src/game/__tests__/campaignStore.test.ts`
**Interfaces:**
```ts
type CampaignStage = 'group1'|'group2'|'group3'|'r32'|'r16'|'qf'|'sf'|'final'|'ended'
interface MatchRecord { stage: CampaignStage; opponentId: TeamId; score: [number,number]; shootout?: [number,number] }
interface CampaignState {
  seed: number; stage: CampaignStage; records: MatchRecord[]
  groupRank: 1|2|3|null            // 조별 종료 후 산정
  path: 'first'|'second'|null
  fatigueCarry: Record<string, number>   // 경기 종료 시 스태미나 이월(다음 경기 시작 시 70% 회복)
  ending: { reached: CampaignStage; champion: boolean } | null
  startCampaign(seed: number): void
  currentOpponent(): TeamId
  matchSeed(): number              // seed*31+matchIndex
  recordResult(score: [number,number], staminaByPlayer: Record<string,number>, shootout?: [number,number]): void  // stage 전진+진출 판정
  reset(): void
}
```
- 조별 순위 산정(간이·실제 A조 재현): 유저 승점 vs 고정 기준 — 실제 A조 결과에서 타 팀 간 경기는 실측(멕시코 3승 조1위 확정 가정이 아니라: 멕시코-체코 3-0, 멕시코-남아공 1-0, 체코-남아공 스코어는 리서치 미확정이므로 **간이 규칙**: 유저 승점 7+=1위, 5~6=2위(단 멕시코 전승 시 유저 최대 2위 — 유저가 멕시코를 이기면 1위 가능), 4 이하=3위 탈락. 정확 구현: 멕시코·체코·남아공의 상호전적을 고정 테이블로 두고 유저 결과만 대입해 표준 승점·득실 순위 계산. 고정 테이블: mex 3-0 cze, mex 1-0 rsa, cze ? rsa → 리서치상 미확정이므로 1-1 무승부로 설정하고 주석에 "가상(미확정)" 명시)
- 토너먼트: 무승부 시 shootout 필수(recordResult에 shootout 없으면 throw), 패배 즉시 ending, final 승리 시 champion
**TDD:** 전승 캠페인 → 1위 경로 순서(ecu→eng→nor→arg→esp)·우승 / 조별 1승2패 → 3위 탈락 엔딩 / 2위 → can 경로 / 토너먼트 무승부에 shootout 누락 throw / matchSeed 결정론 / 체력 이월 70% 회복

### Task 4: 엔진 firstHalfScript + 조별 경기 모드
**Files:** Modify `src/engine/simulate.ts`, `src/engine/types.ts` / Test 추가
**Interfaces:** `createMatch(home, away, { seed, firstHalfScript?: { events: MatchEvent[]; score: [number,number] } })` — 지정 시 `simulateSegment(state, 45)`는 시뮬 대신 스크립트 이벤트를 그대로 배치(분 순), 스코어·스탯은 스크립트 기준(스탯은 statBaseline 절반 근사), minute=45로. 후반(45→90)은 기존 시뮬. **분할 결정론 유지**(후반 분 파생 RNG 불변)
**TDD:** 스크립트 경기 전반 결과 고정·후반 시뮬 결정론·스크립트 없으면 기존 동작 무변화(기존 테스트 그린)

### Task 5: LineupScreen
**Files:** Create `src/ui/lineup/LineupScreen.tsx`, lineup.css / deps `@dnd-kit/core` / Test 스모크+스왑 로직
**Interfaces:** `({ team, formation, lineup, onConfirm }: {...; onConfirm(t: TacticState): void })` — 포메이션 6종 선택 버튼(XI_SLOTS 재사용, 변경 시 적합도순 자동 재배치), 피치 미니뷰에 슬롯 배치(PitchView 좌표 재사용), 선발↔벤치 **드래그앤드롭 + 클릭 스왑 병행**, 슬롯별 적합도 색(초록≥0.85/노랑 0.65/빨강<0.65 — positionFitness), [라인업 확정]→onConfirm
**TDD:** 클릭 스왑 로직(순수 함수로 분리 `swapPlayers(lineup, a, b)`)·적합도 색 산출·스모크(11슬롯+벤치 렌더). DnD 자체는 수동 검증 항목

### Task 6: HubScreen + EndingScreen
**Files:** Create `src/ui/campaign/HubScreen.tsx`, `EndingScreen.tsx`, campaign.css / Test 스모크
**Interfaces:** Hub: 스테이지 진행 바(조별 3 + R32~결승), 지난 결과(records), 다음 상대 카드(국기·랭킹·styleNotes·preferredFormations — 워룸 간이판), [라인업 짜기] 버튼. Ending: 도달 라운드별 헤드라인 텍스트(우승/준우승/4강.../조별 탈락 — 템플릿, 실명 비하 금지), 기록 요약, [처음부터]

### Task 7: 캠페인 플로우 조립
**Files:** Modify `src/App.tsx`, `src/ui/match/MatchScreen.tsx`(캠페인 모드: 종료 시 onMatchEnd(score, stamina, shootout?) 콜백·조별 경기 firstHalfScript 전달·무승부 시 승부차기 UI 진입), Create `src/ui/match/ShootoutPanel.tsx`(키커 5인 순서 선택+방향 지정+GK 방향 → simulateShootout 결과 연출), `src/ui/match/TeamTalk.tsx`(하프타임 4톤 버튼 → moraleByPlayer 일괄 보정: 격노 -5~+10 랜덤 대신 **결정론**: 지고 있으면 격노 +8/이기면 -4 등 상태 조건 테이블)
**흐름:** App: 랜딩 [캠페인 시작]→Hub→Lineup→Match(조별=스크립트 전반+실제 스코어 참고 표시)→결과→recordResult→Hub ... →Ending. 데모 경기 버튼 유지
**TDD:** 스모크(캠페인 시작→허브 렌더), TeamTalk 보정 테이블, ShootoutPanel 로직(순서·방향 수집→simulateShootout 호출 파라미터)

### Task 8: 통합 검증
- 전체 스위트+빌드, **자동 캠페인 완주 테스트**(store 레벨: 시드 고정으로 조별→탈락 및 조작된 전승→우승 경로 완주), 컨트롤러 브라우저 E2E(캠페인 시작→조별 1경기→허브 복귀), 원장 기록

## Phase 3 이관 명시
관찰 노트 태깅 / 신문 1면·AI 기자회견 / 리더보드 / 데모 모드 개선 / a11y·성능 폴리시(2A 이관분 포함) / 퇴장 트리거·morale 시뮬 반영·미스매치 실수확률
