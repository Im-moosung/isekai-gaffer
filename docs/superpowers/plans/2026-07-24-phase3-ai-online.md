# Phase 3: AI 서사 + 온라인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** AI 기자회견·신문 1면·리더보드·공유 카드로 참신성 축을 완성한다. 모든 AI/온라인 기능은 키 부재·장애 시 로컬 폴백으로 100% 동작(설계 §7 폴백 원칙).

**Architecture:** `src/ai/`(클라이언트+세이프가드+프롬프트), `api/narrate.ts`(Vercel 서버리스, 프로바이더 중립), `src/game/pressconf.ts`(결정 로그→질문·헤드라인 — 템플릿 정본, AI는 상위 레이어), `src/online/leaderboard.ts`(Supabase↔localStorage 폴백). 결정 로그는 matchStore가 수집해 campaignStore로 흐른다.

## Global Constraints
- **세이프가드 3단** (스펙 §7.1): AI 시스템 프롬프트 제약 + 출력 후처리 필터(src/ai/safeguard.ts) + 폴백 템플릿 사전 검수(사실 서술형만). 실존 인물 실명 비판·허위 인용 금지
- AI 호출 3초 타임아웃 → 템플릿 폴백. 키 부재 시 호출 시도 자체를 생략
- 신문 카드에 "대체역사 FICTION" 워터마크 (스펙 §9.1)
- 닉네임 금칙어 필터 + 길이 제한 + 기본 익명 (스펙 §11)
- 업셋 보너스 = FIFA 랭킹 차 기반 (data/SCHEMA.md 규칙)
- 새 deps: `@supabase/supabase-js`만. UI 엔진 격리·토큰·트레일러 규칙 기존과 동일

## 섹션: A=T1~3(로그·AI 인프라·기자회견 로직) / B=T4~6(UI·리더보드·엔진 이관분) / C=T7~8(조립·검증)

### Task 1: DecisionLog 수집
**Files:** Modify `src/game/matchStore.ts`, `src/engine/types.ts`(DecisionEntry) / Test
**계약:** `DecisionEntry = { minute: number; kind: 'instructions'|'sub'|'teamtalk'|'shootout-setup'; summary: string; detail?: Record<string, unknown> }`. matchStore에 `decisionLog: DecisionEntry[]` — submitCommand/applyTeamTalk 시 자동 append(summary는 한국어: "60' 압박 55→90", "HT 팀토크: 격려", "72' 교체: 오현규 IN, 조규성 OUT"). reset 시 초기화. MatchScreen onMatchEnd 시그니처에 `decisionLog` 추가 전달, campaignStore.recordResult에 저장(MatchRecord.decisions). TDD: 지시 변경·교체·팀토크 각각 로그 생성, summary 형식, 캠페인 기록 보존.

### Task 2: AI 인프라 (프록시·클라이언트·세이프가드)
**Files:** Create `api/narrate.ts`, `src/ai/aiClient.ts`, `src/ai/safeguard.ts`, `src/ai/prompts.ts` / Test(safeguard·aiClient)
**계약:**
- `api/narrate.ts` (Vercel 함수, 로컬 미실행 — 배포 시 활성): POST {task:'pressq'|'headline'|'epilogue', context}. 환경변수 `AI_PROVIDER`('gemini'|'anthropic') + `GEMINI_API_KEY`/`ANTHROPIC_API_KEY`. 프로바이더별 fetch(모델: gemini-flash-lite 계열/claude-haiku — 상수로 분리), 시스템 프롬프트에 세이프가드 제약(prompts.ts 공유), 2.5s 내부 타임아웃, 응답 {text}. 키 없으면 503
- `aiClient.ts`: `narrate(task, context): Promise<string|null>` — fetch('/api/narrate') 3s AbortController, 실패/503/필터 위반 → null (호출부가 템플릿 폴백). `safeguardFilter(text): boolean` 통과 필수
- `safeguard.ts`: 부정 표현 사전(비하 어휘 목록) + "실명+부정어 근접" 휴리스틱 → boolean. TDD: 안전 문장 통과·비하 문장 차단 케이스 10+
- `prompts.ts`: task별 프롬프트 빌더(결정 로그·경기 결과 주입, 제약문 포함) — 순수 함수 TDD(제약문 포함 여부)

### Task 3: 기자회견·헤드라인 로직 (템플릿 정본)
**Files:** Create `src/game/pressconf.ts` / Test
**계약:**
- `buildQuestions(record: MatchRecord, log: DecisionEntry[]): PressQuestion[]` — 3문항. 결정 로그 기반 다변형(예: 팀토크 격노+승리 → "라커룸의 분노가 통했다고 보나", 교체 후 골 → "교체가 적중했다", 로그 빈약 시 결과 기반 질문). `PressQuestion = { id, text, options: [공격적, 겸손, 유머] 3답변 }`. 결정론(record 기반 해시). 사실 서술·비하 금지
- `buildHeadline(record, answers: string[], teamName): Headline = { title, sub, quote }` — 결과(승/패/승부차기/업셋)×답변 톤 조합 템플릿. FICTION 표기는 UI 몫
- `buildEpilogue(records: MatchRecord[], ending): string[]` — 캠페인 여정 3~5문장
- TDD: 3문항 생성·결정론·금지어 스모크·헤드라인 결과별 분기·에필로그 라운드별

### Task 4: 기자회견·신문 UI
**Files:** Create `src/ui/press/PressConference.tsx`, `NewspaperCard.tsx`, `press.css` / Test 스모크
**계약:** PressConference({record, log, onDone(headline)}) — 기자 질문 순차 표시(타자 효과 선택), 답변 3택, 완료 시 buildHeadline→(키 있으면 aiClient.narrate('headline')로 대체 시도, null이면 템플릿)→onDone. NewspaperCard({headline, record, date}) — 신문 1면 레이아웃(제호 "리매치 타임스", 헤드라인·부제·어록·스코어박스·**"대체역사 FICTION" 워터마크**), [이미지 저장] 버튼 → **canvas 직접 드로잉으로 PNG 다운로드**(외부 라이브러리 금지, 폰트는 시스템). 스모크: 질문 3개 렌더→답변 클릭→onDone 헤드라인, 카드 워터마크 존재

### Task 5: 리더보드 (Supabase + 로컬 폴백)
**Files:** Create `src/online/leaderboard.ts`, `src/online/nickname.ts` / Modify EndingScreen / deps @supabase/supabase-js / Test
**계약:**
- `computeScore(records, ending, opponents: Record<TeamId, Team>): ScoreBreakdown` — 라운드 점수(group탈락 0/r32 100/r16 200/qf 350/sf 550/final 800/champion 1200) + 승점×10 + 득실×5 + **업셋 보너스**: 승리한 상대 중 fifaRanking < 25(한국보다 상위)면 `(25 - 상대랭킹) × 라운드 가중(조별1/토너먼트2)` + 무실점 경기당 30
- `submitScore(nickname, breakdown)` / `topScores(n)`: `VITE_SUPABASE_URL`+`VITE_SUPABASE_ANON_KEY` 있으면 supabase 테이블 'leaderboard'(insert/select), 없거나 실패 시 **localStorage 폴백**(동일 인터페이스, 'local' 플래그 반환)
- `nickname.ts`: `sanitizeNickname(raw): string` — 금칙어 목록 필터(비하·욕설), 2~12자, 위반/공백 시 '익명 감독'. TDD
- EndingScreen: 점수 브레이크다운 표시 + 닉네임 입력 + [기록 등록] → 순위 표시(로컬 모드 표기). TDD: computeScore 케이스(우승 풀보너스/조별 탈락/업셋), sanitize, 폴백 전환(mock)

### Task 6: 상대 AI 포메이션 프로필 반영 (Phase 2 이관)
**Files:** Modify `src/engine/lineup.ts`(pickBestXI에 formation 매개변수), `src/engine/simulate.ts`(defaultTactics가 profile.preferredFormations[0]→mapFormation 사용 — **주의: engine이 src/data/loader를 import하면 순환/계층 위반 → mapFormation을 src/engine/formations-map.ts로 이동하고 loader가 재수출**), `src/ui/pitch/formations.ts`의 XI_SLOTS를 엔진으로 이동(`src/engine/formations.ts`)·UI 재수출 / Test
**TDD:** esp defaultTactics가 4-3-3 아닌 esp 프로필 포메이션인지, XI 11인 유효, 기존 테스트 그린(픽스처 팀은 4-3-3 유지), types.ts 주석 정정

### Task 7: 플로우 조립 (기자회견 삽입 + 데모 정비)
**Files:** Modify `src/App.tsx`, `src/ui/match/MatchScreen.tsx`(캠페인: 결과 확정 후 PressConference→NewspaperCard→허브 복귀. 데모: 경기 후 기자회견 1회 체험 포함) / Test 스모크
- 데모 버튼 명칭 "바로 지휘하기"로 변경, 실팀(loadTeam kor vs esp) 사용, 종료 후 신문 카드까지 체험, "리더보드 미반영" 표기
- 캠페인 흐름: match → PressConference(3문항) → NewspaperCard(공유) → hub. ending 시 EndingScreen에 에필로그(buildEpilogue)+리더보드

### Task 8: 통합 검증
전체 스위트+빌드, 캠페인 자동 완주에 decisionLog 보존 확인 추가, 컨트롤러 브라우저 E2E(기자회견→신문→저장 버튼, 엔딩 리더보드 로컬 등록), 원장 기록

## Phase 4 이관: 관찰 노트(스크립트 전반 flavor 이벤트 필요) / 사운드·TTS / 3D 게이트 판정 / 배포(Vercel+Supabase 실키)·크로스브라우저 / 시연영상 / benchPattern AI 교체 / 승부차기 GK 방향
