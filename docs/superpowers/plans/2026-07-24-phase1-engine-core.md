# Phase 1: 스캐폴딩 + 시뮬 엔진 코어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vite+React+TS 프로젝트를 스캐폴딩하고, 결정론적 규칙 기반 경기 시뮬레이션 엔진(순수 TS, UI 무의존)을 TDD로 구축한다.

**Architecture:** 엔진은 `src/engine/`에 순수 함수로 격리(React 무의존, 시드 결정론). 경기는 "세그먼트 단위 시뮬레이션"(fromMinute→toMinute)으로 진행되어 UI가 세그먼트 사이에 사용자 결정(교체·지시 변경)을 끼워 넣는다. 실제 팀 데이터(JSON DB)가 오기 전까지 테스트 픽스처 팀으로 개발한다.

**Tech Stack:** Vite + React 18 + TypeScript(strict) + Vitest. 엔진은 라이브러리 의존 0.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-07-23-worldcup-manager-sim-design.md` §6, §6.1, §6.2 / 데이터 계약: `data/SCHEMA.md`
- **엔진 코드에서 `Math.random()` 사용 금지** — 반드시 시드 RNG(mulberry32) 주입 (결정론 요구, 스펙 §6)
- 엔진 디렉토리(`src/engine/`)는 React/DOM import 금지 (순수 TS)
- 능력치 범위 1~99, 포지션 적합도 계수: 주 1.0 / altPositions 0.85 / 비인접 0.65 / 극단 0.4 / 필드→GK 0.2 (스펙 §6.1)
- 전술 상성 효과 상한 ±15% (전술 리서치 권고: `docs/research/tactics-modern-football.md` §3)
- 캘리브레이션 계약: AI 기본 상태 시뮬 100회 평균이 statBaseline ±15% 이내 (SCHEMA.md)
- 커밋 메시지 말미: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o`

## File Structure

```
src/engine/
├── rng.ts          # 시드 PRNG (mulberry32) + 헬퍼
├── types.ts        # 엔진 도메인 타입 전체 (SCHEMA.md와 정합)
├── fitness.ts      # 포지션 적합도 + 실효 능력치
├── tactics.ts      # 포메이션 상성 행렬 + 지시 상호작용 모디파이어
├── strength.ts     # 존별(공/미/수) 팀 전력 집계
├── simulate.ts     # 분 단위 세그먼트 시뮬 + 인게임 커맨드
├── shootout.ts     # 승부차기
├── calibrate.ts    # 배치 시뮬 + 캘리브레이션 리포트
└── fixtures/testTeams.ts  # 테스트용 합성 팀 2개
src/engine/__tests__/*.test.ts
```

---

### Task 1: 프로젝트 스캐폴딩

**Files:**
- Create: Vite 프로젝트 루트 전체 (`package.json`, `tsconfig.json`, `vite.config.ts`, `src/`)
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: `npm test`로 Vitest 실행 가능한 TS strict 프로젝트

- [ ] **Step 1: Vite 프로젝트 생성** (기존 파일 보존 주의 — 루트에 docs/, data/, CLAUDE.md 존재)

```bash
cd /Users/moo/Projects/daker/MH_Soccer-Manager
npm create vite@latest . -- --template react-ts   # 기존 파일 덮어쓰기 질문 시 "Ignore files and continue" 선택
npm install
npm install -D vitest
```

- [ ] **Step 2: tsconfig strict 확인 + vitest 설정**

`tsconfig.json`(또는 tsconfig.app.json)의 `compilerOptions`에 `"strict": true` 확인(기본값). `vitest.config.ts` 생성:

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
```

`package.json`의 scripts에 추가: `"test": "vitest run", "test:watch": "vitest"`

- [ ] **Step 3: 빌드·테스트 파이프 검증**

Run: `npm run build && npm test`
Expected: build 성공, "No test files found" 또는 0 tests (에러 아님 — vitest는 `--passWithNoTests` 필요 시 스크립트에 추가)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: Vite+React+TS 스캐폴딩 및 Vitest 설정"
```

---

### Task 2: 시드 RNG

**Files:**
- Create: `src/engine/rng.ts`
- Test: `src/engine/__tests__/rng.test.ts`

**Interfaces:**
- Produces: `createRng(seed: number): Rng` — `Rng = { next(): number; int(min,max): number; chance(p): boolean; pick<T>(arr: T[]): T; weighted<T>(items: {item:T; w:number}[]): T }`

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/rng.test.ts
import { describe, it, expect } from 'vitest'
import { createRng } from '../rng'

describe('createRng', () => {
  it('같은 시드는 같은 수열을 낸다 (결정론)', () => {
    const a = createRng(42), b = createRng(42)
    const seqA = Array.from({ length: 100 }, () => a.next())
    const seqB = Array.from({ length: 100 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })
  it('다른 시드는 다른 수열', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next())
  })
  it('next()는 [0,1) 범위', () => {
    const r = createRng(7)
    for (let i = 0; i < 1000; i++) { const v = r.next(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })
  it('int(1,10)은 1~10 정수', () => {
    const r = createRng(7)
    for (let i = 0; i < 500; i++) { const v = r.int(1, 10); expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(10); expect(Number.isInteger(v)).toBe(true) }
  })
  it('weighted는 가중치 0 항목을 뽑지 않는다', () => {
    const r = createRng(7)
    for (let i = 0; i < 200; i++) expect(r.weighted([{ item: 'a', w: 0 }, { item: 'b', w: 1 }])).toBe('b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/rng.test.ts`
Expected: FAIL — "Cannot find module '../rng'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/engine/rng.ts
export interface Rng {
  next(): number
  int(min: number, max: number): number
  chance(p: number): boolean
  pick<T>(arr: T[]): T
  weighted<T>(items: { item: T; w: number }[]): T
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    weighted: (items) => {
      const total = items.reduce((s2, i) => s2 + i.w, 0)
      let roll = next() * total
      for (const { item, w } of items) { roll -= w; if (roll < 0 && w > 0) return item }
      return items.filter(i => i.w > 0).at(-1)!.item
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/rng.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 시드 결정론 RNG (mulberry32)"
```

---

### Task 3: 엔진 도메인 타입 + 테스트 픽스처

**Files:**
- Create: `src/engine/types.ts`
- Create: `src/engine/fixtures/testTeams.ts`
- Test: `src/engine/__tests__/types.test.ts`

**Interfaces:**
- Produces (이후 전 태스크가 사용):

```ts
export type Position = 'GK'|'CB'|'LB'|'RB'|'DM'|'CM'|'AM'|'LW'|'RW'|'ST'
export type Foot = 'L' | 'R' | 'B'
export interface FieldStats { shooting: number; passing: number; dribbling: number; defending: number; physical: number; pace: number }
export interface GkStats { saving: number; aerial: number; buildup: number }
export interface Player {
  id: string; number: number; name: { ko: string; en: string }
  position: Position; altPositions: Position[]; foot: Foot | null
  stats?: FieldStats; gkStats?: GkStats
  setPiece: number; penalty: number; stamina: number
}
export interface TeamStyle { possession: number; pressing: number; lineHeight: number; tempo: number } // 0~100
export interface TeamProfile {
  preferredFormations: FormationId[]; style: TeamStyle
  keyPlayers: { playerId: string; dependency: number }[]
  benchPattern: 'protect-lead' | 'chase-attack' | 'balanced'
}
export interface StatBaseline {
  possession: number; passAccuracy: number; shotsPerGame: number
  shotsOnTargetPerGame: number; foulsPerGame: number; cornersPerGame: number; xgPerGame: number | null
}
export interface Team {
  id: string; name: { ko: string; en: string }; fifaCode: string; fifaRanking: number; tier: number
  profile: TeamProfile; statBaseline: StatBaseline; squad: Player[]
}
export type FormationId = '4-3-3' | '4-2-3-1' | '4-4-2' | '3-5-2' | '4-1-4-1' | '5-4-1'
export interface Instructions { lineHeight: number; pressing: number; tempo: number; attackFocus: 'left'|'center'|'right'|'balanced' }
export interface LineupSlot { slot: Position; playerId: string }
export interface TacticState { formation: FormationId; lineup: LineupSlot[]; instructions: Instructions }
export type MatchEventType = 'kickoff'|'chance'|'shot'|'goal'|'save'|'miss'|'foul'|'yellow'|'red'|'corner'|'sub'|'halftime'|'fulltime'
export interface MatchEvent { minute: number; type: MatchEventType; teamId: string; playerId?: string; assistId?: string; detail?: string; xg?: number }
export interface SideStats { possession: number; passAccuracy: number; shots: number; shotsOnTarget: number; fouls: number; corners: number; xg: number }
export interface SideState {
  team: Team; tactics: TacticState
  staminaByPlayer: Record<string, number>   // 0~100
  moraleByPlayer: Record<string, number>    // 0~100
  subsUsed: number; sentOff: string[]
}
export interface MatchState {
  minute: number; score: [number, number]   // [home, away]
  home: SideState; away: SideState
  events: MatchEvent[]; stats: [SideStats, SideStats]
  momentum: number  // -1(away 우세)~+1(home 우세)
}
```

- 픽스처: `makeTestTeam(id: string, tierPower: number): Team` — 18인(GK2 + 필드16) 합성 팀. tierPower(60~90)가 전 능력치 기준값

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/types.test.ts
import { describe, it, expect } from 'vitest'
import { makeTestTeam } from '../fixtures/testTeams'

describe('makeTestTeam', () => {
  it('18인 스쿼드, GK 2명, 필드 스탯/GK 스탯 분리', () => {
    const t = makeTestTeam('alpha', 80)
    expect(t.squad).toHaveLength(18)
    const gks = t.squad.filter(p => p.position === 'GK')
    expect(gks).toHaveLength(2)
    gks.forEach(gk => { expect(gk.gkStats).toBeDefined(); expect(gk.stats).toBeUndefined() })
    t.squad.filter(p => p.position !== 'GK').forEach(p => expect(p.stats).toBeDefined())
  })
  it('tierPower가 능력치에 반영된다', () => {
    const strong = makeTestTeam('s', 88), weak = makeTestTeam('w', 62)
    const avg = (t: ReturnType<typeof makeTestTeam>) => {
      const fs = t.squad.filter(p => p.stats).map(p => p.stats!)
      return fs.reduce((s, x) => s + x.shooting + x.passing + x.defending, 0) / fs.length
    }
    expect(avg(strong)).toBeGreaterThan(avg(weak) + 30)
  })
  it('4-3-3 선발 11인을 구성할 수 있는 포지션 분포', () => {
    const t = makeTestTeam('alpha', 80)
    const need: Array<[string, number]> = [['GK',1],['CB',2],['LB',1],['RB',1],['CM',2],['DM',1],['LW',1],['RW',1],['ST',1]]
    for (const [pos, n] of need) {
      const have = t.squad.filter(p => p.position === pos || p.altPositions.includes(pos as never)).length
      expect(have).toBeGreaterThanOrEqual(n)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/types.test.ts`
Expected: FAIL — "Cannot find module '../fixtures/testTeams'"

- [ ] **Step 3: Write implementation** — `types.ts`는 위 Interfaces 블록 그대로. 픽스처:

```ts
// src/engine/fixtures/testTeams.ts
import type { Team, Player, Position, FieldStats } from '../types'

const LAYOUT: { pos: Position; alt: Position[]; count: number }[] = [
  { pos: 'GK', alt: [], count: 2 },
  { pos: 'CB', alt: ['DM'], count: 3 },
  { pos: 'LB', alt: ['LW'], count: 1 }, { pos: 'RB', alt: ['RW'], count: 1 },
  { pos: 'DM', alt: ['CB', 'CM'], count: 2 }, { pos: 'CM', alt: ['DM', 'AM'], count: 3 },
  { pos: 'AM', alt: ['CM', 'ST'], count: 1 },
  { pos: 'LW', alt: ['ST', 'RW'], count: 2 }, { pos: 'RW', alt: ['ST', 'LW'], count: 1 },
  { pos: 'ST', alt: ['LW', 'AM'], count: 2 },
]

function fieldStats(base: number, pos: Position, i: number): FieldStats {
  const v = (off: number) => Math.max(30, Math.min(95, base + off - i)) // i로 선수 간 편차
  const atk = ['LW', 'RW', 'ST', 'AM'].includes(pos)
  const def = ['CB', 'LB', 'RB', 'DM'].includes(pos)
  return {
    shooting: v(atk ? 5 : def ? -18 : -6), passing: v(0), dribbling: v(atk ? 4 : -8),
    defending: v(def ? 6 : atk ? -22 : -4), physical: v(def ? 3 : -2), pace: v(['LW','RW','LB','RB'].includes(pos) ? 5 : -3),
  }
}

export function makeTestTeam(id: string, tierPower: number): Team {
  const squad: Player[] = []
  let n = 1
  for (const { pos, alt, count } of LAYOUT) {
    for (let i = 0; i < count; i++) {
      const p: Player = {
        id: `p_${id}_${String(n).padStart(2, '0')}`, number: n,
        name: { ko: `${id}선수${n}`, en: `${id}-P${n}` },
        position: pos, altPositions: alt, foot: n % 4 === 0 ? 'L' : 'R',
        setPiece: tierPower - 10 + (n % 7), penalty: tierPower - 8 + (n % 9), stamina: 70 + (n % 20),
      }
      if (pos === 'GK') p.gkStats = { saving: tierPower - i * 6, aerial: tierPower - 4, buildup: tierPower - 12 }
      else p.stats = fieldStats(tierPower, pos, i)
      squad.push(p); n++
    }
  }
  return {
    id, name: { ko: id, en: id }, fifaCode: id.toUpperCase().slice(0, 3), fifaRanking: 100 - tierPower, tier: tierPower >= 85 ? 1 : tierPower >= 75 ? 2 : 3,
    profile: {
      preferredFormations: ['4-3-3'], style: { possession: tierPower >= 80 ? 65 : 45, pressing: 55, lineHeight: 50, tempo: 55 },
      keyPlayers: [{ playerId: `p_${id}_14`, dependency: 0.6 }], benchPattern: 'balanced',
    },
    statBaseline: { possession: 50, passAccuracy: 78 + (tierPower - 70) / 2, shotsPerGame: 12, shotsOnTargetPerGame: 4.5, foulsPerGame: 12, cornersPerGame: 5, xgPerGame: 1.3 },
    squad,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/types.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 도메인 타입 및 테스트 팀 픽스처"
```

---

### Task 4: 포지션 적합도 + 실효 능력치

**Files:**
- Create: `src/engine/fitness.ts`
- Test: `src/engine/__tests__/fitness.test.ts`

**Interfaces:**
- Consumes: `Player`, `Position` (Task 3)
- Produces:
  - `positionFitness(player: Player, slot: Position): number` — 1.0/0.85/0.65/0.4/0.2(필드→GK 또는 GK→필드)
  - `effectiveStats(player: Player, slot: Position, stamina: number): FieldStats` — 적합도×체력 반영 실효치
  - `ADJACENT: Record<Position, Position[]>` — 인접 포지션 정의

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/fitness.test.ts
import { describe, it, expect } from 'vitest'
import { positionFitness, effectiveStats } from '../fitness'
import { makeTestTeam } from '../fixtures/testTeams'

const team = makeTestTeam('t', 85)
const striker = team.squad.find(p => p.position === 'ST')!
const gk = team.squad.find(p => p.position === 'GK')!

describe('positionFitness', () => {
  it('주 포지션 = 1.0', () => expect(positionFitness(striker, 'ST')).toBe(1.0))
  it('altPositions = 0.85', () => expect(positionFitness(striker, 'LW')).toBe(0.85))
  it('인접(alt에 없어도 ADJACENT면) = 0.65', () => expect(positionFitness(striker, 'RW')).toBeGreaterThanOrEqual(0.65))
  it('공격수→CB 극단 미스매치 = 0.4', () => expect(positionFitness(striker, 'CB')).toBe(0.4))
  it('필드 선수→GK = 0.2 (파국)', () => expect(positionFitness(striker, 'GK')).toBe(0.2))
  it('GK→필드 = 0.2', () => expect(positionFitness(gk, 'ST')).toBe(0.2))
})

describe('effectiveStats', () => {
  it('미스매치 배치는 실효 능력치를 크게 깎는다', () => {
    const atST = effectiveStats(striker, 'ST', 100)
    const atCB = effectiveStats(striker, 'CB', 100)
    expect(atCB.defending).toBeLessThan(atST.defending * 0.5)
  })
  it('체력 50%면 pace·physical이 유의하게 감소', () => {
    const fresh = effectiveStats(striker, 'ST', 100)
    const tired = effectiveStats(striker, 'ST', 50)
    expect(tired.pace).toBeLessThan(fresh.pace * 0.85)
    expect(tired.shooting).toBeLessThan(fresh.shooting) // 전 스탯 감소하되
    expect(tired.shooting).toBeGreaterThan(fresh.shooting * 0.8) // pace보다 완만
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/fitness.test.ts`
Expected: FAIL — "Cannot find module '../fitness'"

- [ ] **Step 3: Write implementation**

```ts
// src/engine/fitness.ts
import type { Player, Position, FieldStats } from './types'

export const ADJACENT: Record<Position, Position[]> = {
  GK: [], CB: ['DM'], LB: ['LW', 'CB'], RB: ['RW', 'CB'],
  DM: ['CM', 'CB'], CM: ['DM', 'AM'], AM: ['CM', 'ST', 'LW', 'RW'],
  LW: ['ST', 'AM', 'LB'], RW: ['ST', 'AM', 'RB'], ST: ['LW', 'RW', 'AM'],
}

export function positionFitness(player: Player, slot: Position): number {
  const isGkPlayer = player.position === 'GK'
  if (isGkPlayer !== (slot === 'GK')) return 0.2
  if (player.position === slot) return 1.0
  if (player.altPositions.includes(slot)) return 0.85
  if (ADJACENT[player.position].includes(slot) || ADJACENT[slot].includes(player.position)) return 0.65
  return 0.4
}

const STAMINA_SENSITIVITY: Record<keyof FieldStats, number> = {
  pace: 0.5, physical: 0.45, dribbling: 0.35, shooting: 0.3, defending: 0.3, passing: 0.2,
}

export function effectiveStats(player: Player, slot: Position, stamina: number): FieldStats {
  const fit = positionFitness(player, slot)
  const base: FieldStats = player.stats ?? { shooting: 20, passing: 30, dribbling: 20, defending: 20, physical: 40, pace: 40 } // GK가 필드에 선 경우
  const fatigue = Math.max(0, (100 - stamina) / 100)
  const out = {} as FieldStats
  for (const k of Object.keys(base) as (keyof FieldStats)[]) {
    out[k] = base[k] * fit * (1 - STAMINA_SENSITIVITY[k] * fatigue)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/fitness.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 포지션 적합도 커브·실효 능력치 (미스매치 페널티)"
```

---

### Task 5: 전술 모디파이어 (포메이션 상성 + 지시 상호작용)

**Files:**
- Create: `src/engine/tactics.ts`
- Test: `src/engine/__tests__/tactics.test.ts`

**Interfaces:**
- Consumes: `FormationId`, `Instructions` (Task 3)
- Produces:
  - `formationEdge(a: FormationId, b: FormationId): number` — a 관점 상성 [-0.15, +0.15]
  - `instructionEffects(ins: Instructions): { chanceRate: number; chanceQuality: number; counterVulnerability: number; possessionBias: number; foulRate: number; staminaDrain: number }` — 각 1.0 기준 배율
  - 근거: `docs/research/tactics-modern-football.md` §3 (하이라인+맹렬압박=뒷공간 리스크 증폭 등 6대 결합 규칙)

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/tactics.test.ts
import { describe, it, expect } from 'vitest'
import { formationEdge, instructionEffects } from '../tactics'
import type { FormationId, Instructions } from '../types'

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']
const base: Instructions = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }

describe('formationEdge', () => {
  it('반대칭: edge(a,b) = -edge(b,a)', () => {
    for (const a of FORMATIONS) for (const b of FORMATIONS)
      expect(formationEdge(a, b)).toBeCloseTo(-formationEdge(b, a), 10)
  })
  it('상한 ±0.15', () => {
    for (const a of FORMATIONS) for (const b of FORMATIONS) {
      expect(Math.abs(formationEdge(a, b))).toBeLessThanOrEqual(0.15)
    }
  })
  it('3-5-2는 4-4-2 상대로 중원 수적 우위 (양수 edge)', () => {
    expect(formationEdge('3-5-2', '4-4-2')).toBeGreaterThan(0)
  })
})

describe('instructionEffects', () => {
  it('기준 지시(50/50/50)는 모든 효과 ≈ 1.0', () => {
    const e = instructionEffects(base)
    for (const v of Object.values(e)) expect(v).toBeCloseTo(1.0, 1)
  })
  it('하이라인+맹렬압박 → 역습 취약성 증폭 (결합이 개별 합보다 큼)', () => {
    const both = instructionEffects({ ...base, lineHeight: 85, pressing: 85 })
    const lineOnly = instructionEffects({ ...base, lineHeight: 85 })
    const pressOnly = instructionEffects({ ...base, pressing: 85 })
    expect(both.counterVulnerability).toBeGreaterThan(lineOnly.counterVulnerability * pressOnly.counterVulnerability)
  })
  it('맹렬압박은 체력 소모·파울 증가', () => {
    const e = instructionEffects({ ...base, pressing: 90 })
    expect(e.staminaDrain).toBeGreaterThan(1.2)
    expect(e.foulRate).toBeGreaterThan(1.15)
  })
  it('높은 템포는 찬스 빈도↑ 찬스 퀄리티↓', () => {
    const e = instructionEffects({ ...base, tempo: 90 })
    expect(e.chanceRate).toBeGreaterThan(1.1)
    expect(e.chanceQuality).toBeLessThan(1.0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/tactics.test.ts`
Expected: FAIL — "Cannot find module '../tactics'"

- [ ] **Step 3: Write implementation**

```ts
// src/engine/tactics.ts
import type { FormationId, Instructions } from './types'

// 상삼각만 정의, 반대칭으로 자동 완성. 근거: docs/research/tactics-modern-football.md §3
const EDGES: Partial<Record<FormationId, Partial<Record<FormationId, number>>>> = {
  '4-3-3':   { '4-2-3-1': 0.03, '4-4-2': 0.06, '3-5-2': -0.04, '4-1-4-1': 0.02, '5-4-1': 0.05 },
  '4-2-3-1': { '4-4-2': 0.04, '3-5-2': -0.03, '4-1-4-1': 0.02, '5-4-1': 0.04 },
  '4-4-2':   { '3-5-2': -0.08, '4-1-4-1': -0.03, '5-4-1': 0.03 },
  '3-5-2':   { '4-1-4-1': 0.04, '5-4-1': 0.02 },
  '4-1-4-1': { '5-4-1': 0.03 },
}

export function formationEdge(a: FormationId, b: FormationId): number {
  if (a === b) return 0
  const direct = EDGES[a]?.[b]
  if (direct !== undefined) return direct
  return -(EDGES[b]?.[a] ?? 0)
}

const lerp = (t: number, lo: number, hi: number) => lo + ((hi - lo) * t) / 100

export function instructionEffects(ins: Instructions) {
  const line = ins.lineHeight, press = ins.pressing, tempo = ins.tempo
  // 결합 증폭: 하이라인×하이프레스가 함께 갈 때 역습 취약성 초과 증가 (레스트 디펜스 부재 모델링)
  const comboBoost = line > 70 && press > 70 ? ((line - 70) / 30) * ((press - 70) / 30) * 0.5 : 0
  return {
    chanceRate: lerp(tempo, 0.8, 1.25) * lerp(press, 0.92, 1.12),
    chanceQuality: lerp(tempo, 1.1, 0.88) * lerp(line, 0.95, 1.06),
    counterVulnerability: lerp(line, 0.8, 1.3) * lerp(press, 0.95, 1.1) * (1 + comboBoost),
    possessionBias: lerp(tempo, 1.08, 0.92) * lerp(press, 0.95, 1.08),
    foulRate: lerp(press, 0.85, 1.3),
    staminaDrain: lerp(press, 0.85, 1.35) * lerp(tempo, 0.95, 1.12),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/tactics.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 포메이션 상성 행렬·지시 상호작용 모디파이어"
```

---

### Task 6: 존별 팀 전력 집계

**Files:**
- Create: `src/engine/strength.ts`
- Test: `src/engine/__tests__/strength.test.ts`

**Interfaces:**
- Consumes: `effectiveStats`, `positionFitness`(Task 4), `SideState`(Task 3)
- Produces:
  - `zoneStrength(side: SideState): { attack: number; midfield: number; defense: number; gk: number }` — 선발 11인의 실효 능력치를 존별 가중 평균(0~100 스케일). 퇴장 선수 제외 (keyPlayer 의존 가중은 Task 7 찬스 참여자 선정에서 반영 — 존 전력 미적용)

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/strength.test.ts
import { describe, it, expect } from 'vitest'
import { zoneStrength } from '../strength'
import { makeTestTeam } from '../fixtures/testTeams'
import { makeSideState, pickBestXI } from '../fixtures/testTeams'

describe('zoneStrength', () => {
  it('강팀이 약팀보다 전 존에서 우세', () => {
    const s = makeSideState(makeTestTeam('s', 88)), w = makeSideState(makeTestTeam('w', 62))
    const zs = zoneStrength(s), zw = zoneStrength(w)
    expect(zs.attack).toBeGreaterThan(zw.attack)
    expect(zs.defense).toBeGreaterThan(zw.defense)
    expect(zs.gk).toBeGreaterThan(zw.gk)
  })
  it('공격수를 CB에 배치하면 defense가 유의하게 하락', () => {
    const team = makeTestTeam('t', 80)
    const normal = makeSideState(team)
    const swapped = makeSideState(team)
    const st = team.squad.find(p => p.position === 'ST')!
    const cbSlot = swapped.tactics.lineup.find(l => l.slot === 'CB')!
    cbSlot.playerId = st.id
    expect(zoneStrength(swapped).defense).toBeLessThan(zoneStrength(normal).defense * 0.9)
  })
  it('퇴장 선수는 전력에서 제외된다', () => {
    const side = makeSideState(makeTestTeam('t', 80))
    const stSlot = side.tactics.lineup.find(l => l.slot === 'ST')!
    const before = zoneStrength(side).attack
    side.sentOff.push(stSlot.playerId)
    expect(zoneStrength(side).attack).toBeLessThan(before)
  })
})
```

`makeSideState`/`pickBestXI`는 픽스처에 추가한다 (Step 3에서 함께 구현).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/strength.test.ts`
Expected: FAIL — "makeSideState is not exported" 또는 module not found

- [ ] **Step 3: Write implementation** — 픽스처 확장 + strength:

```ts
// src/engine/fixtures/testTeams.ts 에 추가
import type { SideState, TacticState, Position } from '../types'

const XI_433: Position[] = ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST']

export function pickBestXI(team: Team): TacticState {
  const used = new Set<string>()
  const lineup = XI_433.map(slot => {
    const candidate = team.squad
      .filter(p => !used.has(p.id))
      .sort((a, b) => positionFitnessSort(b, slot) - positionFitnessSort(a, slot))[0]
    used.add(candidate.id)
    return { slot, playerId: candidate.id }
  })
  return { formation: '4-3-3', lineup, instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' } }
}
// 순환 import 회피용 로컬 정렬 키 (fitness.ts와 동일 로직의 단순화: 주=2, alt=1, 그 외=0)
function positionFitnessSort(p: Player, slot: Position): number {
  return p.position === slot ? 2 : p.altPositions.includes(slot) ? 1 : 0
}

export function makeSideState(team: Team): SideState {
  const staminaByPlayer: Record<string, number> = {}, moraleByPlayer: Record<string, number> = {}
  team.squad.forEach(p => { staminaByPlayer[p.id] = 100; moraleByPlayer[p.id] = 70 })
  return { team, tactics: pickBestXI(team), staminaByPlayer, moraleByPlayer, subsUsed: 0, sentOff: [] }
}
```

```ts
// src/engine/strength.ts
import type { SideState, Position } from './types'
import { effectiveStats, positionFitness } from './fitness'

const ZONE_OF: Record<Position, 'gk' | 'defense' | 'midfield' | 'attack'> = {
  GK: 'gk', CB: 'defense', LB: 'defense', RB: 'defense',
  DM: 'midfield', CM: 'midfield', AM: 'midfield', LW: 'attack', RW: 'attack', ST: 'attack',
}
const ZONE_WEIGHT: Record<'defense' | 'midfield' | 'attack', (keyof ReturnType<typeof effectiveStats>)[]> = {
  defense: ['defending', 'physical', 'pace'], midfield: ['passing', 'dribbling', 'defending'], attack: ['shooting', 'dribbling', 'pace'],
}

export function zoneStrength(side: SideState) {
  const zones = { attack: [] as number[], midfield: [] as number[], defense: [] as number[], gk: [] as number[] }
  for (const { slot, playerId } of side.tactics.lineup) {
    if (side.sentOff.includes(playerId)) continue
    const player = side.team.squad.find(p => p.id === playerId)!
    const stamina = side.staminaByPlayer[playerId]
    if (slot === 'GK') {
      const fit = positionFitness(player, 'GK')
      const gs = player.gkStats ?? { saving: 20, aerial: 25, buildup: 30 }
      zones.gk.push(((gs.saving * 0.6 + gs.aerial * 0.25 + gs.buildup * 0.15) * fit * (0.7 + 0.3 * stamina / 100)))
      continue
    }
    const es = effectiveStats(player, slot, stamina)
    const zone = ZONE_OF[slot] as 'defense' | 'midfield' | 'attack'
    const keys = ZONE_WEIGHT[zone]
    zones[zone].push(keys.reduce((s, k) => s + es[k], 0) / keys.length)
  }
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 10)
  // 수적 열세 페널티: 존 인원이 기대보다 적으면 평균에 그대로 반영됨(빈 슬롯 미포함) + 전체 10인 이하 시 추가 페널티
  const shortage = side.sentOff.length * 0.06
  return {
    attack: avg(zones.attack) * (1 - shortage), midfield: avg(zones.midfield) * (1 - shortage),
    defense: avg(zones.defense) * (1 - shortage), gk: avg(zones.gk),
  }
}
```

주의: 퇴장 테스트가 `attack` 감소를 요구한다 — 퇴장자가 lineup에서 제외되면 존 평균에서 빠지고 shortage 페널티가 적용되므로 감소가 보장된다.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/strength.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 존별 팀 전력 집계 (퇴장·미스매치 페널티 포함)"
```

---

### Task 7: 분 단위 세그먼트 시뮬레이션

**Files:**
- Create: `src/engine/simulate.ts`
- Test: `src/engine/__tests__/simulate.test.ts`

**Interfaces:**
- Consumes: Task 2~6 전부
- Produces:
  - `createMatch(home: Team, away: Team, opts: { seed: number; homeTactics?: TacticState; awayTactics?: TacticState }): MatchState`
  - `simulateSegment(state: MatchState, toMinute: number): MatchState` — state.minute부터 toMinute까지 진행한 **새 상태** 반환(불변성). 매 분: 점유 결정 → 찬스/파울/코너 이벤트 롤 → 스탯 대결 → 체력 감소 → 모멘텀 갱신
  - `applyCommand(state: MatchState, side: 'home'|'away', cmd: MatchCommand): MatchState` — `MatchCommand = { type:'sub'; out:string; in:string } | { type:'instructions'; instructions: Instructions } | { type:'formation'; tactics: TacticState }`

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/simulate.test.ts
import { describe, it, expect } from 'vitest'
import { createMatch, simulateSegment, applyCommand } from '../simulate'
import { makeTestTeam } from '../fixtures/testTeams'

const strong = makeTestTeam('str', 88), weak = makeTestTeam('wea', 62)
const even1 = makeTestTeam('ev1', 78), even2 = makeTestTeam('ev2', 78)

describe('simulateSegment', () => {
  it('결정론: 같은 시드는 같은 결과', () => {
    const run = () => simulateSegment(createMatch(even1, even2, { seed: 123 }), 90)
    const a = run(), b = run()
    expect(a.score).toEqual(b.score)
    expect(a.events).toEqual(b.events)
    expect(a.stats).toEqual(b.stats)
  })
  it('다른 시드는 (대부분) 다른 이벤트 흐름', () => {
    const a = simulateSegment(createMatch(even1, even2, { seed: 1 }), 90)
    const b = simulateSegment(createMatch(even1, even2, { seed: 2 }), 90)
    expect(a.events).not.toEqual(b.events)
  })
  it('스코어는 현실적 범위 (100경기에서 팀당 0~8골)', () => {
    for (let s = 0; s < 100; s++) {
      const r = simulateSegment(createMatch(even1, even2, { seed: s }), 90)
      expect(r.score[0]).toBeLessThanOrEqual(8)
      expect(r.score[1]).toBeLessThanOrEqual(8)
    }
  })
  it('강팀은 약팀에 100경기 중 60승 이상', () => {
    let wins = 0
    for (let s = 0; s < 100; s++) {
      const r = simulateSegment(createMatch(strong, weak, { seed: s }), 90)
      if (r.score[0] > r.score[1]) wins++
    }
    expect(wins).toBeGreaterThanOrEqual(60)
  })
  it('세그먼트 분할과 일괄 진행은 같은 결과 (45+45 = 90)', () => {
    const whole = simulateSegment(createMatch(even1, even2, { seed: 55 }), 90)
    let split = createMatch(even1, even2, { seed: 55 })
    split = simulateSegment(split, 45)
    split = simulateSegment(split, 90)
    expect(split.score).toEqual(whole.score)
    expect(split.events).toEqual(whole.events)
  })
  it('체력은 경기 진행에 따라 감소', () => {
    const r = simulateSegment(createMatch(even1, even2, { seed: 9 }), 90)
    const anyStarter = r.home.tactics.lineup[5].playerId
    expect(r.home.staminaByPlayer[anyStarter]).toBeLessThan(85)
  })
})

describe('applyCommand', () => {
  it('교체: out 선수가 라인업에서 빠지고 in 선수가 들어온다', () => {
    let st = simulateSegment(createMatch(even1, even2, { seed: 3 }), 45)
    const out = st.home.tactics.lineup.find(l => l.slot === 'ST')!.playerId
    const benchIn = st.home.team.squad.find(p => !st.home.tactics.lineup.some(l => l.playerId === p.id) && p.position === 'ST')!.id
    st = applyCommand(st, 'home', { type: 'sub', out, in: benchIn })
    expect(st.home.tactics.lineup.some(l => l.playerId === benchIn)).toBe(true)
    expect(st.home.tactics.lineup.some(l => l.playerId === out)).toBe(false)
    expect(st.home.subsUsed).toBe(1)
    expect(st.events.at(-1)).toMatchObject({ type: 'sub', teamId: even1.id })
  })
  it('교체 5회 초과는 에러', () => {
    let st = simulateSegment(createMatch(even1, even2, { seed: 3 }), 45)
    st = { ...st, home: { ...st.home, subsUsed: 5 } }
    const out = st.home.tactics.lineup[10].playerId
    const sub = st.home.team.squad.find(p => !st.home.tactics.lineup.some(l => l.playerId === p.id))!.id
    expect(() => applyCommand(st, 'home', { type: 'sub', out, in: sub })).toThrow()
  })
  it('지시 변경이 이후 시뮬에 반영된다 (맹렬압박 → 파울 증가 경향, 50시드 평균)', () => {
    let foulsHigh = 0, foulsBase = 0
    for (let s = 0; s < 50; s++) {
      const base = simulateSegment(createMatch(even1, even2, { seed: s }), 90)
      let pressed = createMatch(even1, even2, { seed: s })
      pressed = applyCommand(pressed, 'home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 95, tempo: 50, attackFocus: 'balanced' } })
      const r = simulateSegment(pressed, 90)
      foulsHigh += r.stats[0].fouls; foulsBase += base.stats[0].fouls
    }
    expect(foulsHigh).toBeGreaterThan(foulsBase * 1.1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/simulate.test.ts`
Expected: FAIL — "Cannot find module '../simulate'"

- [ ] **Step 3: Write implementation**

핵심 설계 — **분할 결정론**: RNG 상태를 MatchState에 시드+소비 카운트로 저장하지 않고, `분(minute)을 시드에 결합`한 파생 RNG를 매 분 생성한다(`createRng(seed * 10007 + minute)`). 세그먼트 분할 지점과 무관하게 같은 분은 같은 난수를 쓰므로 45+45 = 90 결정론이 보장된다.

```ts
// src/engine/simulate.ts
import { createRng, type Rng } from './rng'
import { zoneStrength } from './strength'
import { instructionEffects, formationEdge } from './tactics'
import { effectiveStats } from './fitness'
import type { Instructions, MatchEvent, MatchState, SideState, TacticState, Team } from './types'

export type MatchCommand =
  | { type: 'sub'; out: string; in: string }
  | { type: 'instructions'; instructions: Instructions }
  | { type: 'formation'; tactics: TacticState }

const MAX_SUBS = 5

export function createMatch(home: Team, away: Team, opts: { seed: number; homeTactics?: TacticState; awayTactics?: TacticState }): MatchState {
  const mkSide = (team: Team, tactics?: TacticState): SideState => {
    const staminaByPlayer: Record<string, number> = {}, moraleByPlayer: Record<string, number> = {}
    team.squad.forEach(p => { staminaByPlayer[p.id] = 100; moraleByPlayer[p.id] = 70 })
    return { team, tactics: tactics ?? defaultTactics(team), staminaByPlayer, moraleByPlayer, subsUsed: 0, sentOff: [] }
  }
  return {
    minute: 0, score: [0, 0], home: mkSide(home, opts.homeTactics), away: mkSide(away, opts.awayTactics),
    events: [{ minute: 0, type: 'kickoff', teamId: home.id }],
    stats: [emptyStats(), emptyStats()], momentum: 0,
    // seed는 상태에 보관 (분 파생 RNG용)
    ...( { seed: opts.seed } as object ),
  } as MatchState & { seed: number }
}

function emptyStats() { return { possession: 50, passAccuracy: 0, shots: 0, shotsOnTarget: 0, fouls: 0, corners: 0, xg: 0 } }

function defaultTactics(team: Team): TacticState {
  // 픽스처의 pickBestXI와 동일 로직 (프로필 선호 포메이션 4-3-3 가정; Phase 2에서 프로필 기반 확장)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { pickBestXI } = require('./fixtures/testTeams') as typeof import('./fixtures/testTeams')
  const t = pickBestXI(team)
  t.instructions = {
    lineHeight: team.profile.style.lineHeight, pressing: team.profile.style.pressing,
    tempo: team.profile.style.tempo, attackFocus: 'balanced',
  }
  return t
}

export function simulateSegment(state: MatchState, toMinute: number): MatchState {
  let st: MatchState & { seed: number } = structuredClone(state) as MatchState & { seed: number }
  while (st.minute < toMinute) {
    st.minute++
    const rng = createRng(st.seed * 10007 + st.minute)
    simulateMinute(st, rng)
    if (st.minute === 45) st.events.push({ minute: 45, type: 'halftime', teamId: st.home.team.id })
  }
  if (toMinute >= 90 && !st.events.some(e => e.type === 'fulltime'))
    st.events.push({ minute: 90, type: 'fulltime', teamId: st.home.team.id })
  return st
}

function simulateMinute(st: MatchState & { seed: number }, rng: Rng) {
  const zs = [zoneStrength(st.home), zoneStrength(st.away)]
  const fx = [instructionEffects(st.home.tactics.instructions), instructionEffects(st.away.tactics.instructions)]
  const edge = formationEdge(st.home.tactics.formation, st.away.tactics.formation)

  // 1) 이 분의 점유 팀: 미드필드 전력 + 프로필 점유 성향 + 지시 편향 + 포메이션 상성
  const possW0 = zs[0].midfield * (st.home.team.profile.style.possession / 50) * fx[0].possessionBias * (1 + edge)
  const possW1 = zs[1].midfield * (st.away.team.profile.style.possession / 50) * fx[1].possessionBias * (1 - edge)
  const atkIdx = rng.weighted([{ item: 0, w: possW0 }, { item: 1, w: possW1 }]) as 0 | 1
  const defIdx = (1 - atkIdx) as 0 | 1
  const atk = atkIdx === 0 ? st.home : st.away
  const def = defIdx === 0 ? st.home : st.away
  // 점유율 누적 (이동 평균)
  st.stats[atkIdx].possession = round1((st.stats[atkIdx].possession * (st.minute - 1) + 100) / st.minute)
  st.stats[defIdx].possession = round1(100 - st.stats[atkIdx].possession)

  // 2) 파울 롤 (수비 측): 베이스라인 캘리브레이션 (팀 실측 파울/90분)
  const foulP = (def.team.statBaseline.foulsPerGame / 90) * fx[defIdx].foulRate
  if (rng.chance(foulP)) {
    st.stats[defIdx].fouls++
    const fouler = randomLineupPlayer(def, rng, ['CB', 'DM', 'LB', 'RB', 'CM'])
    st.events.push({ minute: st.minute, type: 'foul', teamId: def.team.id, playerId: fouler })
    if (rng.chance(0.12)) st.events.push({ minute: st.minute, type: 'yellow', teamId: def.team.id, playerId: fouler })
  }

  // 3) 찬스 롤 (공격 측): 공격 전력 vs 수비 전력 + 템포 + 모멘텀
  const momentumBoost = atkIdx === 0 ? 1 + st.momentum * 0.15 : 1 - st.momentum * 0.15
  const chanceP = clamp(
    (atk.team.statBaseline.shotsPerGame / 90) * (zs[atkIdx].attack / Math.max(30, zs[defIdx].defense)) * fx[atkIdx].chanceRate * fx[defIdx].counterVulnerability * momentumBoost,
    0.02, 0.35,
  )
  if (rng.chance(chanceP)) resolveChance(st, atkIdx, defIdx, zs, fx, rng)

  // 4) 체력 감소
  for (const [idx, side] of [[0, st.home], [1, st.away]] as const) {
    const drain = 0.55 * fx[idx].staminaDrain
    for (const { playerId } of side.tactics.lineup) {
      if (side.sentOff.includes(playerId)) continue
      const p = side.team.squad.find(q => q.id === playerId)!
      side.staminaByPlayer[playerId] = Math.max(0, side.staminaByPlayer[playerId] - drain * (100 / Math.max(40, p.stamina)))
    }
  }
}

function resolveChance(st: MatchState & { seed: number }, atkIdx: 0 | 1, defIdx: 0 | 1, zs: ReturnType<typeof zoneStrength>[], fx: ReturnType<typeof instructionEffects>[], rng: Rng) {
  const atk = atkIdx === 0 ? st.home : st.away
  const def = defIdx === 0 ? st.home : st.away
  // 슈터 선정: 공격 포지션 가중 (keyPlayer 의존 반영)
  const shooters = atk.tactics.lineup
    .filter(l => !atk.sentOff.includes(l.playerId) && l.slot !== 'GK')
    .map(l => {
      const key = atk.team.profile.keyPlayers.find(k => k.playerId === l.playerId)
      const w = (['ST', 'LW', 'RW', 'AM'].includes(l.slot) ? 3 : ['CM', 'DM'].includes(l.slot) ? 1 : 0.3) * (key ? 1 + key.dependency : 1)
      return { item: l, w }
    })
  const shooterSlot = rng.weighted(shooters)
  const shooter = atk.team.squad.find(p => p.id === shooterSlot.playerId)!
  const es = effectiveStats(shooter, shooterSlot.slot, atk.staminaByPlayer[shooter.id])

  st.stats[atkIdx].shots++
  const gkSlot = def.tactics.lineup.find(l => l.slot === 'GK')!
  const gk = def.team.squad.find(p => p.id === gkSlot.playerId)!
  const gkSave = (gk.gkStats?.saving ?? 20) * (0.75 + 0.25 * def.staminaByPlayer[gk.id] / 100)

  // xG: 슈팅 능력·찬스 퀄리티 기반
  const xg = clamp((es.shooting / 100) * 0.35 * fx[atkIdx].chanceQuality, 0.02, 0.65)
  st.stats[atkIdx].xg = round2(st.stats[atkIdx].xg + xg)

  const onTargetP = clamp(es.shooting / 140, 0.25, 0.75)
  if (!rng.chance(onTargetP)) {
    st.events.push({ minute: st.minute, type: 'miss', teamId: atk.team.id, playerId: shooter.id, xg })
    if (rng.chance(0.35)) { st.stats[atkIdx].corners++; st.events.push({ minute: st.minute, type: 'corner', teamId: atk.team.id }) }
    return
  }
  st.stats[atkIdx].shotsOnTarget++
  const goalP = clamp(xg * (1.6 - gkSave / 100), 0.04, 0.55)
  if (rng.chance(goalP)) {
    st.score[atkIdx]++
    st.events.push({ minute: st.minute, type: 'goal', teamId: atk.team.id, playerId: shooter.id, xg })
    st.momentum = clamp(st.momentum + (atkIdx === 0 ? 0.35 : -0.35), -1, 1)
  } else {
    st.events.push({ minute: st.minute, type: 'save', teamId: def.team.id, playerId: gk.id, xg })
    if (rng.chance(0.45)) { st.stats[atkIdx].corners++; st.events.push({ minute: st.minute, type: 'corner', teamId: atk.team.id }) }
  }
}

function randomLineupPlayer(side: SideState, rng: Rng, prefer: string[]): string {
  const pool = side.tactics.lineup.filter(l => !side.sentOff.includes(l.playerId))
  const weightedPool = pool.map(l => ({ item: l.playerId, w: prefer.includes(l.slot) ? 3 : 1 }))
  return rng.weighted(weightedPool)
}

export function applyCommand(state: MatchState, sideKey: 'home' | 'away', cmd: MatchCommand): MatchState {
  const st = structuredClone(state) as MatchState & { seed: number }
  const side = st[sideKey]
  if (cmd.type === 'sub') {
    if (side.subsUsed >= MAX_SUBS) throw new Error(`교체 한도(${MAX_SUBS}회) 초과`)
    const slot = side.tactics.lineup.find(l => l.playerId === cmd.out)
    if (!slot) throw new Error('교체 대상이 라인업에 없음')
    if (side.tactics.lineup.some(l => l.playerId === cmd.in)) throw new Error('이미 출전 중인 선수')
    slot.playerId = cmd.in
    side.subsUsed++
    st.events.push({ minute: st.minute, type: 'sub', teamId: side.team.id, playerId: cmd.in, detail: `out:${cmd.out}` })
  } else if (cmd.type === 'instructions') {
    side.tactics.instructions = cmd.instructions
  } else {
    side.tactics = cmd.tactics
  }
  return st
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round1 = (v: number) => Math.round(v * 10) / 10
const round2 = (v: number) => Math.round(v * 100) / 100
```

구현 노트: `require('./fixtures/testTeams')`는 순환 참조 회피 임시책이다 — 테스트가 통과하면 `defaultTactics`의 XI 선정 로직을 `src/engine/lineup.ts`로 추출해 fixtures와 simulate가 공유하도록 리팩터링하라(같은 태스크 내 Step 5 전에 수행, 테스트 재실행으로 검증).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/simulate.test.ts`
Expected: PASS (9 tests). 확률 기반 테스트(60승/파울 증가)가 실패하면 상수(chanceP 범위, foulRate lerp)를 조정하되 다른 테스트가 깨지지 않는지 전체 재실행: `npm test`

- [ ] **Step 5: lineup.ts 추출 리팩터링 후 전체 테스트**

Run: `npm test`
Expected: 전체 PASS

- [ ] **Step 6: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 분 단위 세그먼트 시뮬 + 인게임 커맨드 (분할 결정론)"
```

---

### Task 8: 승부차기 모듈

**Files:**
- Create: `src/engine/shootout.ts`
- Test: `src/engine/__tests__/shootout.test.ts`

**Interfaces:**
- Consumes: `Rng`(Task 2), `Player`(Task 3)
- Produces:
  - `simulateShootout(opts: { seed: number; homeKickers: ShootoutKicker[]; awayKickers: ShootoutKicker[]; homeGk: Player; awayGk: Player }): ShootoutResult`
  - `ShootoutKicker = { player: Player; direction: 'left'|'center'|'right' }` (유저가 순서·방향 지정)
  - `ShootoutResult = { homeScore: number; awayScore: number; winner: 'home'|'away'; kicks: { side:'home'|'away'; playerId: string; scored: boolean; gkDove: 'left'|'center'|'right' }[] }`
  - 규칙: 5인 교대, 조기 확정 시 종료, 동점이면 서든데스(키커 목록 순환)

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/shootout.test.ts
import { describe, it, expect } from 'vitest'
import { simulateShootout, type ShootoutKicker } from '../shootout'
import { makeTestTeam } from '../fixtures/testTeams'

const a = makeTestTeam('a', 80), b = makeTestTeam('b', 80)
const kickers = (t: ReturnType<typeof makeTestTeam>): ShootoutKicker[] =>
  t.squad.filter(p => p.position !== 'GK').slice(0, 5).map((p, i) => ({ player: p, direction: (['left','center','right'] as const)[i % 3] }))
const gk = (t: ReturnType<typeof makeTestTeam>) => t.squad.find(p => p.position === 'GK')!

describe('simulateShootout', () => {
  it('결정론: 같은 시드 같은 결과', () => {
    const run = () => simulateShootout({ seed: 7, homeKickers: kickers(a), awayKickers: kickers(b), homeGk: gk(a), awayGk: gk(b) })
    expect(run()).toEqual(run())
  })
  it('승자가 반드시 결정된다 (동점 없음, 100시드)', () => {
    for (let s = 0; s < 100; s++) {
      const r = simulateShootout({ seed: s, homeKickers: kickers(a), awayKickers: kickers(b), homeGk: gk(a), awayGk: gk(b) })
      expect(r.homeScore).not.toBe(r.awayScore)
      expect(['home', 'away']).toContain(r.winner)
    }
  })
  it('GK가 키커 방향을 맞히면 세이브 확률이 크게 오른다 (통계 검증)', () => {
    let savedWhenGuessed = 0, savedWhenWrong = 0, guessed = 0, wrong = 0
    for (let s = 0; s < 300; s++) {
      const r = simulateShootout({ seed: s, homeKickers: kickers(a), awayKickers: kickers(b), homeGk: gk(a), awayGk: gk(b) })
      for (const k of r.kicks) {
        const kicker = [...kickers(a), ...kickers(b)].find(x => x.player.id === k.playerId)
        if (!kicker) continue
        if (k.gkDove === kicker.direction) { guessed++; if (!k.scored) savedWhenGuessed++ }
        else { wrong++; if (!k.scored) savedWhenWrong++ }
      }
    }
    expect(savedWhenGuessed / guessed).toBeGreaterThan((savedWhenWrong / wrong) * 2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/shootout.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```ts
// src/engine/shootout.ts
import { createRng } from './rng'
import type { Player } from './types'

export interface ShootoutKicker { player: Player; direction: 'left' | 'center' | 'right' }
export interface ShootoutKick { side: 'home' | 'away'; playerId: string; scored: boolean; gkDove: 'left' | 'center' | 'right' }
export interface ShootoutResult { homeScore: number; awayScore: number; winner: 'home' | 'away'; kicks: ShootoutKick[] }

const DIRS = ['left', 'center', 'right'] as const

export function simulateShootout(opts: {
  seed: number; homeKickers: ShootoutKicker[]; awayKickers: ShootoutKicker[]; homeGk: Player; awayGk: Player
}): ShootoutResult {
  const rng = createRng(opts.seed ^ 0x50c1a1)
  const kicks: ShootoutKick[] = []
  let hs = 0, as = 0
  const take = (side: 'home' | 'away', kicker: ShootoutKicker, gk: Player) => {
    const gkDove = rng.pick([...DIRS])
    const pk = kicker.player.penalty
    const saving = gk.gkStats?.saving ?? 20
    let scoreP = 0.62 + (pk - 70) / 200          // 기본 성공률: PK 성향 반영 (~0.5-0.75)
    if (gkDove === kicker.direction) scoreP -= (saving / 100) * 0.45  // 방향 적중 시 세이브 확률 급증
    const scored = rng.chance(Math.max(0.05, Math.min(0.95, scoreP)))
    kicks.push({ side, playerId: kicker.player.id, scored, gkDove })
    if (scored) side === 'home' ? hs++ : as++
  }
  // 정규 5라운드 + 조기 확정
  for (let round = 0; round < 5; round++) {
    take('home', opts.homeKickers[round % opts.homeKickers.length], opts.awayGk)
    if (decided(hs, as, round, 'afterHome')) break
    take('away', opts.awayKickers[round % opts.awayKickers.length], opts.homeGk)
    if (decided(hs, as, round, 'afterAway')) break
  }
  // 서든데스
  let i = 5
  while (hs === as) {
    take('home', opts.homeKickers[i % opts.homeKickers.length], opts.awayGk)
    take('away', opts.awayKickers[i % opts.awayKickers.length], opts.homeGk)
    i++
  }
  return { homeScore: hs, awayScore: as, winner: hs > as ? 'home' : 'away', kicks }
}

function decided(hs: number, as: number, round: number, phase: 'afterHome' | 'afterAway'): boolean {
  const remHome = 4 - round, remAway = phase === 'afterHome' ? 5 - round : 4 - round
  return hs > as + remAway || as > hs + remHome
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/shootout.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 승부차기 (키커 순서·방향 지정, GK 방향 대결)"
```

---

### Task 9: 캘리브레이션 하네스

**Files:**
- Create: `src/engine/calibrate.ts`
- Test: `src/engine/__tests__/calibrate.test.ts`

**Interfaces:**
- Consumes: `createMatch`, `simulateSegment`(Task 7), `Team`(Task 3)
- Produces:
  - `runBatch(home: Team, away: Team, n: number, seedBase?: number): BatchReport`
  - `BatchReport = { n: number; avg: { home: SideAvg; away: SideAvg }; homeWinRate: number; drawRate: number }`, `SideAvg = { goals: number; possession: number; shots: number; shotsOnTarget: number; fouls: number; corners: number; xg: number }`
  - `checkCalibration(report: BatchReport, home: Team, away: Team): { metric: string; side: 'home'|'away'; expected: number; actual: number; withinTolerance: boolean }[]` — statBaseline 대비 ±15% 판정 (SCHEMA.md 계약)

- [ ] **Step 1: Write the failing test**

```ts
// src/engine/__tests__/calibrate.test.ts
import { describe, it, expect } from 'vitest'
import { runBatch, checkCalibration } from '../calibrate'
import { makeTestTeam } from '../fixtures/testTeams'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)

describe('runBatch', () => {
  it('n경기 평균 리포트를 만든다', () => {
    const r = runBatch(a, b, 50)
    expect(r.n).toBe(50)
    expect(r.avg.home.possession + r.avg.away.possession).toBeCloseTo(100, 0)
    expect(r.homeWinRate + r.drawRate).toBeLessThanOrEqual(1)
  })
  it('동급 팀 평균 득점은 현실 범위 (0.8~2.2골/팀)', () => {
    const r = runBatch(a, b, 100)
    for (const g of [r.avg.home.goals, r.avg.away.goals]) {
      expect(g).toBeGreaterThan(0.8); expect(g).toBeLessThan(2.2)
    }
  })
})

describe('checkCalibration', () => {
  it('베이스라인 지표별 허용 오차 판정을 반환한다', () => {
    const r = runBatch(a, b, 100)
    const checks = checkCalibration(r, a, b)
    const metrics = new Set(checks.map(c => c.metric))
    for (const m of ['possession', 'shotsPerGame', 'foulsPerGame', 'cornersPerGame']) expect(metrics.has(m)).toBe(true)
    checks.forEach(c => expect(typeof c.withinTolerance).toBe('boolean'))
  })
  it('동급 팀·기본 지시에서 슈팅·파울은 베이스라인 ±15% 이내 (캘리브레이션 계약)', () => {
    const r = runBatch(a, b, 200)
    const checks = checkCalibration(r, a, b).filter(c => ['shotsPerGame', 'foulsPerGame'].includes(c.metric))
    const failed = checks.filter(c => !c.withinTolerance)
    expect(failed, JSON.stringify(failed, null, 2)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/calibrate.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```ts
// src/engine/calibrate.ts
import { createMatch, simulateSegment } from './simulate'
import type { Team } from './types'

export interface SideAvg { goals: number; possession: number; shots: number; shotsOnTarget: number; fouls: number; corners: number; xg: number }
export interface BatchReport { n: number; avg: { home: SideAvg; away: SideAvg }; homeWinRate: number; drawRate: number }

export function runBatch(home: Team, away: Team, n: number, seedBase = 1000): BatchReport {
  const sum = { home: zero(), away: zero() }
  let homeWins = 0, draws = 0
  for (let i = 0; i < n; i++) {
    const r = simulateSegment(createMatch(home, away, { seed: seedBase + i }), 90)
    for (const [key, idx] of [['home', 0], ['away', 1]] as const) {
      sum[key].goals += r.score[idx]
      sum[key].possession += r.stats[idx].possession
      sum[key].shots += r.stats[idx].shots
      sum[key].shotsOnTarget += r.stats[idx].shotsOnTarget
      sum[key].fouls += r.stats[idx].fouls
      sum[key].corners += r.stats[idx].corners
      sum[key].xg += r.stats[idx].xg
    }
    if (r.score[0] > r.score[1]) homeWins++
    else if (r.score[0] === r.score[1]) draws++
  }
  const div = (s: SideAvg): SideAvg => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v / n])) as unknown as SideAvg
  return { n, avg: { home: div(sum.home), away: div(sum.away) }, homeWinRate: homeWins / n, drawRate: draws / n }
}

const zero = (): SideAvg => ({ goals: 0, possession: 0, shots: 0, shotsOnTarget: 0, fouls: 0, corners: 0, xg: 0 })

const TOLERANCE = 0.15

export function checkCalibration(report: BatchReport, home: Team, away: Team) {
  const rows: { metric: string; side: 'home' | 'away'; expected: number; actual: number; withinTolerance: boolean }[] = []
  const push = (metric: string, side: 'home' | 'away', expected: number, actual: number) =>
    rows.push({ metric, side, expected, actual, withinTolerance: Math.abs(actual - expected) <= expected * TOLERANCE })
  for (const [side, team, avg] of [['home', home, report.avg.home], ['away', away, report.avg.away]] as const) {
    push('possession', side, team.statBaseline.possession, avg.possession)
    push('shotsPerGame', side, team.statBaseline.shotsPerGame, avg.shots)
    push('shotsOnTargetPerGame', side, team.statBaseline.shotsOnTargetPerGame, avg.shotsOnTarget)
    push('foulsPerGame', side, team.statBaseline.foulsPerGame, avg.fouls)
    push('cornersPerGame', side, team.statBaseline.cornersPerGame, avg.corners)
    if (team.statBaseline.xgPerGame != null) push('xgPerGame', side, team.statBaseline.xgPerGame, avg.xg)
  }
  return rows
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/calibrate.test.ts`
Expected: PASS (4 tests). 캘리브레이션 계약 테스트가 실패하면 **simulate.ts의 확률 상수를 조정**하라(찬스 롤의 statBaseline 결합 강도) — 이 테스트가 이 태스크의 존재 이유다. 조정 후 전체 재실행: `npm test`

- [ ] **Step 5: Commit**

```bash
git add src/engine && git commit -m "feat(engine): 배치 시뮬·캘리브레이션 하네스 (실측 ±15% 계약 검증)"
```

---

### Task 10: 전체 회귀 + 결정론 통합 검증

**Files:**
- Test: `src/engine/__tests__/integration.test.ts`

**Interfaces:**
- Consumes: 전 태스크

- [ ] **Step 1: Write the integration test**

```ts
// src/engine/__tests__/integration.test.ts
import { describe, it, expect } from 'vitest'
import { createMatch, simulateSegment, applyCommand } from '../simulate'
import { simulateShootout } from '../shootout'
import { makeTestTeam } from '../fixtures/testTeams'

describe('풀 매치 플로우 (하프타임 개입 포함)', () => {
  it('전반 관람 → 하프타임 교체+지시 변경 → 후반 → (무승부 시) 승부차기까지 결정론 유지', () => {
    const run = () => {
      const kor = makeTestTeam('kor', 76), opp = makeTestTeam('opp', 80)
      let st = simulateSegment(createMatch(kor, opp, { seed: 777 }), 45)
      const out = st.home.tactics.lineup.find(l => l.slot === 'CM')!.playerId
      const benchIn = st.home.team.squad.find(p => p.position === 'CM' && !st.home.tactics.lineup.some(l => l.playerId === p.id))!.id
      st = applyCommand(st, 'home', { type: 'sub', out, in: benchIn })
      st = applyCommand(st, 'home', { type: 'instructions', instructions: { lineHeight: 70, pressing: 75, tempo: 65, attackFocus: 'right' } })
      st = simulateSegment(st, 90)
      if (st.score[0] === st.score[1]) {
        const kickers = (t: typeof kor) => t.squad.filter(p => p.position !== 'GK').slice(0, 5).map(p => ({ player: p, direction: 'left' as const }))
        const so = simulateShootout({ seed: 777, homeKickers: kickers(kor), awayKickers: kickers(opp), homeGk: kor.squad.find(p => p.position === 'GK')!, awayGk: opp.squad.find(p => p.position === 'GK')! })
        return { score: st.score, events: st.events.length, so: so.winner }
      }
      return { score: st.score, events: st.events.length, so: null }
    }
    expect(run()).toEqual(run())
  })
})
```

- [ ] **Step 2: Run 전체 테스트**

Run: `npm test`
Expected: 전체 PASS (Task 2~10 모든 테스트)

- [ ] **Step 3: Commit + 태그**

```bash
git add -A && git commit -m "test(engine): 하프타임 개입 포함 풀 매치 통합 검증"
```

---

## 후속 계획 (이 플랜 범위 밖 — 별도 플랜으로 작성)

- **Phase 2**: 경기 UI(방송 스킨 2D 피치·감독 콘솔·드래그앤드롭 라인업), 캠페인 루프(브래킷·역사 스크립트 재생·관찰 노트·팀토크), 실제 JSON DB 연결(엔진의 statBaseline 캘리브레이션을 실제 데이터로 재검증), **역할 시스템·주발 효과**(인버티드 윙어 컷인 보너스, 세트피스 키커 — 스펙 §6.1의 잔여 항목, roles.json과 함께)
- **Phase 3**: AI 레이어(기자회견·코치·에필로그 + 폴백), Supabase 리더보드, 공유 카드
- **Phase 4**: 폴리시(사운드·TTS·연출), 3D 게이트(7/30), 데모 모드, 배포·크로스브라우저
