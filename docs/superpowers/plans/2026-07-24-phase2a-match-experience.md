# Phase 2A: 경기 경험 코어 (방송 UI + 감독 콘솔 + 경기 플로우) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1 엔진 위에 "실시간 중계되는 감독 콘솔" 경기 화면을 구축 — 킥오프→세그먼트 재생→돌발 개입→풀타임까지 플레이 가능한 단일 경기 경험.

**Architecture:** 상태는 Zustand 스토어(`matchStore`)가 엔진(simulateSegment/applyCommand)을 구동하고, UI는 스토어만 구독한다(엔진 직접 호출 금지). 경기는 "재생 구간(세그먼트) ↔ 개입 창(pause)"의 상태 머신. 방송 스킨은 디자인 토큰 CSS 변수 기반. 캠페인/라인업/실데이터 연결은 Phase 2B로 분리.

**Tech Stack:** React 19 + Zustand + CSS(토큰 변수, Tailwind 미도입 — 의존 최소화 판정) + SVG 피치 + vitest(+jsdom, @testing-library/react — 로직·스모크만)

## Global Constraints

- 엔진 호출은 오직 `src/game/matchStore.ts`에서만 — UI 컴포넌트의 `src/engine/*` 직접 import 금지 (렌더용 타입 import는 허용)
- 스토어 로직은 TDD 필수. UI 컴포넌트는 스모크 테스트(렌더 크래시·핵심 표시) + 수동 검증 체크리스트
- 방송 그래픽 전부 오리지널 (스펙 §9.1 — 엠블럼·FIFA 트레이드드레스 금지, 팀 식별 국기 이모지+국가명)
- 해설 텍스트: 실존 인물 비하 금지 (스펙 §7.1) — 템플릿은 사실 서술형만
- `npm run build` + `npm test` 그린 유지, 커밋 트레일러 2줄 (기존과 동일)
- 새 의존성은 이 계획에 명시된 것만: `zustand`, `jsdom`, `@testing-library/react`(dev)

## File Structure

```
src/game/matchStore.ts        # 경기 상태 머신 + 엔진 구동 (Zustand)
src/game/commentary.ts        # 이벤트→한국어 해설 텍스트 (결정론 템플릿)
src/ui/tokens.css             # 방송 디자인 토큰 (다크 중계 테마)
src/ui/broadcast/Scorebug.tsx # 스코어버그 (팀·스코어·시계·LIVE)
src/ui/broadcast/Ticker.tsx   # 하단 해설 티커
src/ui/pitch/PitchView.tsx    # SVG 피치 + 포메이션 도트 + 이벤트 마커
src/ui/console/ConsolePanel.tsx   # 감독 콘솔 (지시 슬라이더 4축)
src/ui/console/SubPanel.tsx       # 교체 패널 (선수 카드·체력바)
src/ui/match/MatchScreen.tsx      # 조립: 경기 플로우 전체
src/game/__tests__/*.test.ts      # 스토어·해설 TDD
src/ui/__tests__/*.test.tsx       # 스모크
```

## 섹션 구성 (사용자 체크포인트)

- **섹션 A**: Task 1(의존성+토큰) + Task 2(matchStore) + Task 3(commentary) — 로직 완성 ✋체크포인트
- **섹션 B**: Task 4(Scorebug/Ticker) + Task 5(PitchView) + Task 6(ConsolePanel/SubPanel) ✋체크포인트
- **섹션 C**: Task 7(MatchScreen 조립 + 데모 라우트) + Task 8(전체 검증·수동 체크리스트) ✋체크포인트

---

### Task 1: 의존성 + 디자인 토큰 + 테스트 환경

**Files:**
- Modify: `package.json` (deps), `vitest.config.ts` (jsdom 환경 분리)
- Create: `src/ui/tokens.css`

**Interfaces:**
- Produces: CSS 변수 `--bc-*` 토큰 세트, `.tsx` 테스트용 jsdom 환경

- [ ] **Step 1: 의존성 설치**

```bash
npm install zustand
npm install -D jsdom @testing-library/react
```

- [ ] **Step 2: vitest 설정 — tsx 테스트만 jsdom**

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
  },
})
```
(environmentMatchGlobs가 현 vitest 버전에서 deprecated면 `// @vitest-environment jsdom` 파일 주석 방식으로 대체 — 보고서에 명시)

- [ ] **Step 3: 디자인 토큰**

`src/ui/tokens.css`:
```css
/* 방송 중계 다크 테마 — 오리지널 디자인 (스펙 §9.1) */
:root {
  --bc-bg: #0b1220;          /* 스튜디오 배경 */
  --bc-panel: #121c30;       /* 패널 */
  --bc-panel-2: #1a2742;
  --bc-line: #2a3a5c;
  --bc-text: #e8edf6;
  --bc-text-dim: #8fa0bd;
  --bc-accent: #c8f542;      /* 라이브 라임 (경기 화면 한정) */
  --bc-danger: #ff5d5d;
  --bc-pitch: #1e7a3c;       /* 피치 그린 */
  --bc-pitch-line: rgba(255,255,255,0.55);
  --bc-home: #e63946;        /* 홈 도트 */
  --bc-away: #4895ef;        /* 어웨이 도트 */
  --bc-font: "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif;
}
```

- [ ] **Step 4: 빌드·테스트 확인 후 커밋**

Run: `npm run build && npm test` → 기존 44개 그린 유지
```bash
git add package.json package-lock.json vitest.config.ts src/ui/tokens.css
git commit -m "chore(ui): zustand·jsdom·testing-library 도입 + 방송 디자인 토큰"
```

---

### Task 2: matchStore — 경기 상태 머신 (Phase 2A의 심장)

**Files:**
- Create: `src/game/matchStore.ts`
- Test: `src/game/__tests__/matchStore.test.ts`

**Interfaces:**
- Consumes: `createMatch`, `simulateSegment`, `applyCommand`, `MatchCommand` (src/engine/simulate), `Team`, `MatchState` (src/engine/types)
- Produces (UI 전체가 이 계약만 사용):

```ts
export type MatchPhase = 'pre' | 'playing' | 'decision' | 'halftime' | 'fulltime'
export interface DecisionPrompt { id: string; minute: number; title: string; timeLimitSec: number }
export interface MatchUIState {
  phase: MatchPhase
  engine: MatchState | null          // 현재 엔진 상태 (읽기 전용으로 취급)
  displayMinute: number              // 재생 커서 (엔진 minute까지 따라감)
  pendingDecision: DecisionPrompt | null
  // actions
  startMatch(home: Team, away: Team, seed: number): void
  playTo(minute: number): void       // 세그먼트 시뮬 실행 (phase: playing→halftime/fulltime/decision)
  tickDisplay(): void                // displayMinute += 1 (재생 애니메이션용, engine.minute 상한)
  submitCommand(side: 'home'|'away', cmd: MatchCommand): void
  resumeFromDecision(): void
  reset(): void
}
export const useMatchStore: UseBoundStore<StoreApi<MatchUIState>>
```

규칙:
- `playTo(45)` 후 `phase='halftime'`, `playTo(90)` 후 `'fulltime'`
- **돌발 결정**: `playTo`는 목표 분까지 가기 전, 결정 트리거 분(초기 버전: 시드 결정론으로 60분대·75분대 각 1회 — `createRng(seed^0xDEC1)`로 분 산출)에서 멈추고 `phase='decision'` + `pendingDecision` 세팅. `resumeFromDecision()`이 재개
- `submitCommand`는 `applyCommand` 호출 후 engine 교체 (halftime/decision phase에서만 허용, 아니면 throw)
- 결정론: 같은 (팀, 시드) → 같은 결정 트리거 분

- [ ] **Step 1: Write the failing test**

```ts
// src/game/__tests__/matchStore.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore } from '../matchStore'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

describe('matchStore 상태 머신', () => {
  it('startMatch → pre에서 playing 준비, engine 생성', () => {
    store().startMatch(a, b, 42)
    expect(store().engine).not.toBeNull()
    expect(store().phase).toBe('pre')
  })
  it('playTo(45) → halftime, engine.minute=45', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    expect(store().phase).toBe('halftime')
    expect(store().engine!.minute).toBe(45)
  })
  it('후반 진행 중 결정 트리거에서 decision으로 멈춘다 (결정론)', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    store().playTo(90)
    const stopped1 = store().engine!.minute
    expect(store().phase).toBe('decision')
    expect(store().pendingDecision).not.toBeNull()
    expect(stopped1).toBeGreaterThan(45); expect(stopped1).toBeLessThan(90)
    // 같은 시드 재실행 = 같은 정지 분
    store().reset(); store().startMatch(a, b, 42); store().playTo(45); store().playTo(90)
    expect(store().engine!.minute).toBe(stopped1)
  })
  it('resumeFromDecision 후 계속 → 두 번째 결정 → 최종 fulltime', () => {
    store().startMatch(a, b, 42)
    store().playTo(45); store().playTo(90)
    store().resumeFromDecision(); store().playTo(90)
    if (store().phase === 'decision') { store().resumeFromDecision(); store().playTo(90) }
    expect(store().phase).toBe('fulltime')
    expect(store().engine!.minute).toBe(90)
  })
  it('halftime에 submitCommand(지시 변경)가 엔진에 반영된다', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    const before = store().engine!.home.tactics.instructions.pressing
    store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(90)
    expect(before).not.toBe(90)
  })
  it('playing 중 submitCommand는 throw', () => {
    store().startMatch(a, b, 42)
    expect(() => store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })).toThrow()
  })
  it('tickDisplay는 engine.minute을 넘지 않는다', () => {
    store().startMatch(a, b, 42)
    store().playTo(45)
    for (let i = 0; i < 60; i++) store().tickDisplay()
    expect(store().displayMinute).toBe(45)
  })
})
```

- [ ] **Step 2: RED 확인** — `npx vitest run src/game/__tests__/matchStore.test.ts`

- [ ] **Step 3: 구현**

```ts
// src/game/matchStore.ts
import { create } from 'zustand'
import { createMatch, simulateSegment, applyCommand, type MatchCommand } from '../engine/simulate'
import { createRng } from '../engine/rng'
import type { MatchState, Team } from '../engine/types'

export type MatchPhase = 'pre' | 'playing' | 'decision' | 'halftime' | 'fulltime'
export interface DecisionPrompt { id: string; minute: number; title: string; timeLimitSec: number }

function decisionMinutes(seed: number): number[] {
  const rng = createRng(seed ^ 0xdec1)
  return [rng.int(55, 68), rng.int(72, 84)]
}

interface MatchUIState {
  phase: MatchPhase
  engine: MatchState | null
  displayMinute: number
  pendingDecision: DecisionPrompt | null
  decisionsFired: number[]
  startMatch(home: Team, away: Team, seed: number): void
  playTo(minute: number): void
  tickDisplay(): void
  submitCommand(side: 'home' | 'away', cmd: MatchCommand): void
  resumeFromDecision(): void
  reset(): void
}

const initial = { phase: 'pre' as MatchPhase, engine: null, displayMinute: 0, pendingDecision: null, decisionsFired: [] as number[] }

export const useMatchStore = create<MatchUIState>((set, get) => ({
  ...initial,
  startMatch: (home, away, seed) => set({ ...initial, engine: createMatch(home, away, { seed }) }),
  playTo: (minute) => {
    const { engine, decisionsFired } = get()
    if (!engine) throw new Error('경기 미시작')
    const triggers = decisionMinutes((engine as MatchState & { seed: number }).seed)
      .filter(m => m > engine.minute && m < minute && !decisionsFired.includes(m))
    const stopAt = triggers.length ? Math.min(...triggers) : minute
    const next = simulateSegment(engine, stopAt)
    if (triggers.length && stopAt < minute) {
      set({ engine: next, phase: 'decision', decisionsFired: [...decisionsFired, stopAt],
        pendingDecision: { id: `dec-${stopAt}`, minute: stopAt, title: '벤치의 결정이 필요합니다', timeLimitSec: 20 } })
      return
    }
    set({ engine: next, phase: next.minute >= 90 ? 'fulltime' : next.minute >= 45 ? 'halftime' : 'playing', pendingDecision: null })
  },
  tickDisplay: () => set(s => ({ displayMinute: Math.min(s.engine?.minute ?? 0, s.displayMinute + 1) })),
  submitCommand: (side, cmd) => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'halftime' && phase !== 'decision') throw new Error('개입 불가 시점')
    set({ engine: applyCommand(engine, side, cmd) })
  },
  resumeFromDecision: () => set(s => ({ phase: s.engine && s.engine.minute >= 45 ? 'playing' : s.phase, pendingDecision: null })),
  reset: () => set({ ...initial }),
}))
```

- [ ] **Step 4: GREEN + 전체 스위트** — `npm test` (기존 44 + 신규 7)
- [ ] **Step 5: Commit** — `feat(game): 경기 상태 머신 스토어 (세그먼트 재생·결정 창·개입)`

---

### Task 3: commentary — 이벤트→한국어 해설 (결정론 템플릿)

**Files:**
- Create: `src/game/commentary.ts`
- Test: `src/game/__tests__/commentary.test.ts`

**Interfaces:**
- Consumes: `MatchEvent`, `Team` (engine/types)
- Produces: `commentate(e: MatchEvent, home: Team, away: Team): string` — 이벤트당 한 줄 해설. 같은 이벤트 = 같은 문장(시드: minute×type 해시로 변형 선택). 선수 실명은 name.ko 사용, **사실 서술형만** (비하·조롱 금지 — 스펙 §7.1)

- [ ] **Step 1: Write the failing test**

```ts
// src/game/__tests__/commentary.test.ts
import { describe, it, expect } from 'vitest'
import { commentate } from '../commentary'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import type { MatchEvent } from '../../engine/types'

const home = makeTestTeam('kor', 78), away = makeTestTeam('opp', 78)
const goal: MatchEvent = { minute: 67, type: 'goal', teamId: 'kor', playerId: home.squad[15].id, xg: 0.3 }

describe('commentate', () => {
  it('골 이벤트에 선수 한글 이름과 분이 들어간다', () => {
    const line = commentate(goal, home, away)
    expect(line).toContain(home.squad[15].name.ko)
    expect(line).toContain('67')
  })
  it('결정론: 같은 이벤트 = 같은 문장', () => {
    expect(commentate(goal, home, away)).toBe(commentate(goal, home, away))
  })
  it('모든 이벤트 타입에 대해 비어있지 않은 문장을 낸다', () => {
    const types: MatchEvent['type'][] = ['kickoff','goal','save','miss','foul','yellow','corner','sub','halftime','fulltime']
    for (const type of types) {
      const line = commentate({ minute: 10, type, teamId: 'kor', playerId: home.squad[3].id }, home, away)
      expect(line.length).toBeGreaterThan(3)
    }
  })
  it('금지 표현이 없다 (세이프가드 스모크)', () => {
    const banned = ['최악', '한심', '형편없', '멍청']
    const types: MatchEvent['type'][] = ['goal','save','miss','foul','yellow','corner']
    for (const type of types) for (let m = 1; m <= 90; m += 7) {
      const line = commentate({ minute: m, type, teamId: 'opp', playerId: away.squad[m % 18].id }, home, away)
      for (const w of banned) expect(line).not.toContain(w)
    }
  })
})
```

- [ ] **Step 2: RED 확인**
- [ ] **Step 3: 구현** — 타입별 변형 2~3개 템플릿 배열, `(minute * 31 + type.length)` 해시로 변형 선택. 팀명은 `name.ko`, 선수는 squad 조회(미발견 시 팀명으로 대체). 전 문장 사실 서술형 (예: 골 = "{분}' {선수}, 골망을 흔듭니다!", 파울 = "{선수}의 파울로 흐름이 끊깁니다"). 완전한 구현 코드는 구현자가 위 계약대로 작성 (문장 수 10~15개 수준, 창작 재량 허용 — 단 세이프가드 테스트 통과 필수)
- [ ] **Step 4: GREEN + 전체 스위트**
- [ ] **Step 5: Commit** — `feat(game): 이벤트 해설 템플릿 (결정론·세이프가드)`

---

### Task 4: Scorebug + Ticker (방송 컴포넌트)

**Files:**
- Create: `src/ui/broadcast/Scorebug.tsx`, `src/ui/broadcast/Ticker.tsx`, `src/ui/broadcast/broadcast.css`
- Test: `src/ui/__tests__/broadcast.test.tsx`

**Interfaces:**
- `Scorebug({ home, away, score, minute, live }: { home: Team; away: Team; score: [number, number]; minute: number; live: boolean })` — 국기 이모지+FIFA 코드+스코어+시계, live 시 LIVE 뱃지
- `Ticker({ lines }: { lines: string[] })` — 최근 해설 1줄 표시(마지막 항목), 이전 줄 페이드

- [ ] **Step 1: 스모크 테스트** (렌더 크래시 없음, 스코어·분·팀 코드 표시)

```tsx
// src/ui/__tests__/broadcast.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

describe('broadcast components', () => {
  it('Scorebug: 팀 코드·스코어·분 표시', () => {
    render(<Scorebug home={makeTestTeam('kor', 78)} away={makeTestTeam('esp', 88)} score={[1, 2]} minute={67} live />)
    expect(screen.getByText(/KOR/)).toBeTruthy()
    expect(screen.getByText(/1/)).toBeTruthy()
    expect(screen.getByText(/67/)).toBeTruthy()
    expect(screen.getByText(/LIVE/)).toBeTruthy()
  })
  it('Ticker: 마지막 해설 라인 표시', () => {
    render(<Ticker lines={['첫 해설', '두 번째 해설']} />)
    expect(screen.getByText('두 번째 해설')).toBeTruthy()
  })
})
```

- [ ] **Step 2: RED → 구현 → GREEN** — 방송 스킨: 토큰 변수 사용, 스코어버그는 좌상단 고정 바(팀 칩 2 + 스코어 + 분 + LIVE 도트 펄스), Ticker는 하단 바. 구현 재량 허용(계약: 위 props, 토큰 사용, 인라인 스타일 금지)
- [ ] **Step 3: 전체 스위트 + 빌드 → Commit** — `feat(ui): 스코어버그·티커 방송 컴포넌트`

---

### Task 5: PitchView (SVG 피치)

**Files:**
- Create: `src/ui/pitch/PitchView.tsx`, `src/ui/pitch/formations.ts`
- Test: `src/ui/__tests__/pitch.test.tsx`

**Interfaces:**
- `formations.ts`: `slotCoords(formation: FormationId, slotIndex: number, side: 'home'|'away'): { x: number; y: number }` — 0~100 좌표계, 홈=좌→우 공격. 6종 포메이션 슬롯 좌표 테이블 (lineup 슬롯 순서와 동일 인덱스)
- `PitchView({ state, lastEvent }: { state: MatchState; lastEvent?: MatchEvent })` — SVG 105×68 비율 피치(외곽선·센터서클·박스), 양팀 11 도트(홈 `--bc-home`/어웨이 `--bc-away`, 등번호 텍스트), lastEvent 위치에 마커 펄스(goal=⚽ 링, shot/miss=×, foul=▲ — 좌표는 이벤트 타입별 근사 존)

- [ ] **Step 1: 테스트** — `slotCoords`: 6종 포메이션 × 11슬롯이 전부 0~100 내, GK가 최후방(x 최소/최대), 홈·어웨이 미러 검증 (TDD). PitchView: 스모크(도트 22개 렌더)
- [ ] **Step 2: RED → 구현 → GREEN** — 좌표 테이블은 구현자가 포메이션 상식대로 작성 (예: 4-3-3 홈 = GK x6 / 백4 x20 / 미드3 x45 / 쓰리톱 x72)
- [ ] **Step 3: 전체 + 빌드 → Commit** — `feat(ui): SVG 피치 뷰·포메이션 좌표`

---

### Task 6: ConsolePanel + SubPanel (감독 콘솔)

**Files:**
- Create: `src/ui/console/ConsolePanel.tsx`, `src/ui/console/SubPanel.tsx`, `src/ui/console/console.css`
- Test: `src/ui/__tests__/console.test.tsx`

**Interfaces:**
- `ConsolePanel({ side }: { side: 'home'|'away' })` — 스토어 구독. 지시 4축 슬라이더(라인/압박/템포 0~100 + 공격방향 select). phase가 halftime/decision일 때만 "지시 적용" 버튼 활성 → `submitCommand(side, {type:'instructions',...})`. playing 중엔 disabled + "다음 개입 창까지 잠김" 표시
- `SubPanel({ side })` — 라인업 11인 카드(이름·번호·포지션·체력바 stamina %), 벤치 목록, 아웃/인 선택 → phase 허용 시 `submitCommand(side, {type:'sub',...})`. `subsUsed/5` 표시

- [ ] **Step 1: 스모크+행동 테스트** — jsdom: (a) playing 중 버튼 disabled (b) halftime 상태로 스토어 세팅 후 슬라이더 변경→적용 클릭→스토어 engine 지시 반영 (c) SubPanel에서 교체 실행 시 subsUsed 증가
- [ ] **Step 2: RED → 구현 → GREEN**
- [ ] **Step 3: 전체 + 빌드 → Commit** — `feat(ui): 감독 콘솔 (지시 4축·교체 패널)`

---

### Task 7: MatchScreen 조립 + 데모 진입

**Files:**
- Create: `src/ui/match/MatchScreen.tsx`, `src/ui/match/match.css`
- Modify: `src/App.tsx` (데모 경기 진입 버튼 → MatchScreen), `src/main.tsx`(tokens.css import)

**Interfaces:**
- `MatchScreen({ home, away, seed })` — 레이아웃: 좌 70% (Scorebug + PitchView + Ticker) / 우 30% (ConsolePanel + SubPanel 탭). 플로우: [킥오프] 버튼 → `playTo(45)` 실행 후 200ms 간격 `tickDisplay()`로 분 재생(displayMinute 기준 이벤트를 Ticker에 누적, commentate 사용) → halftime 오버레이("전반 종료 — 콘솔 개입 가능" + [후반 시작]) → `playTo(90)` → decision 오버레이(pendingDecision.title + 카운트다운 + [지시 확정/그대로 간다]) → fulltime 오버레이(최종 스코어+스탯 비교 표)
- App.tsx: 픽스처 팀(kor 76 vs esp 88, seed=Date.now()%100000 — **UI 계층이라 Math.random 계열 허용, 단 엔진 시드로만 전달**) "데모 경기 시작" 버튼

- [ ] **Step 1: 스모크 테스트** — MatchScreen 렌더 → 킥오프 버튼 존재, 클릭 후 phase 전환(fake timers로 tick 진행) 크래시 없음
- [ ] **Step 2: 구현 → GREEN**
- [ ] **Step 3: 전체 + 빌드 → Commit** — `feat(ui): 경기 화면 조립·데모 진입`

---

### Task 8: 전체 검증 + 수동 체크리스트

- [ ] **Step 1: 전체 스위트 + 빌드** — `npm test && npm run build`
- [ ] **Step 2: dev 서버 수동 검증 체크리스트 작성·수행** (구현자가 `npm run dev` 후 확인, 결과를 보고서에 기록):
  - [ ] 킥오프→전반 재생이 티커에 해설 누적하며 진행
  - [ ] 하프타임: 압박 슬라이더 90으로 → 적용 → 후반 파울·점유 변화 체감
  - [ ] 돌발 결정 오버레이 등장·재개
  - [ ] 교체 실행 → 피치 도트/카드 갱신, subsUsed 증가
  - [ ] 풀타임 스탯 표 (점유·슛·xG·파울)
  - [ ] 콘솔이 playing 중 잠김
- [ ] **Step 3: Commit** — `test(ui): Phase 2A 통합 검증`

---

## 후속 (Phase 2B — 별도 계획)
캠페인 허브·브래킷 / 라인업 드래그앤드롭·미스매치 경고 / 실데이터(data/teams) 로딩+포메이션 매핑+캘리브레이션 재검증 / 조별 역사 스크립트 재생·관찰 노트 / 팀토크 / 퇴장 트리거·morale 배선·미스매치 실수확률 (Phase 1 이관분)
