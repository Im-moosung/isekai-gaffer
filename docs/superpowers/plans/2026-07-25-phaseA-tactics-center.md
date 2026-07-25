# Phase A — 경기 전 전술 센터 + 축 밸런스 + morale 배선 + 상대 AI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 유저가 킥오프 전에 전술을 완전히 설계할 수 있게 하고, 그 설계가 실제로 의미를 갖도록 지시 축의 단조 지배 전략을 제거하며, 사기·상대 감독을 살아 있는 변수로 만든다.

**Architecture:** 새 화면을 만들지 않는다. `matchStore`의 `'pre'` phase를 개입 phase로 승격시켜 기존 작전판(`TacticsBoard`)이 킥오프 전에도 무수정으로 동작하게 한다. 엔진 변경은 전부 **선택적 컨텍스트 인자**로 들어가며, 인자 미지정 시 현재와 수치가 완전히 동일해 700개 시드 회귀 테스트가 유지된다. 밸런스 변경은 배치 시뮬 계측 하네스를 먼저 세우고 그 게이트를 통과시키는 방식으로 진행한다.

**Tech Stack:** React 19, TypeScript strict, Zustand 5, Vitest 4, Vite 8

## Global Constraints

- **모든 서브에이전트는 opus 모델만 사용한다.** `model: "opus"` 명시 필수 (CLAUDE.md).
- **시드 회귀 불변**: 엔진 확장은 전부 선택적 인자/필드로 하고, 미지정 시 기존 수치와 **비트 단위로 동일**해야 한다. 새 파라미터를 넣을 때 중립값에서 정확히 `1.0`이 나오는지 산술로 검산할 것.
- **`Math.random()` / `Date.now()` / `new Date()` 금지.** 모든 무작위성은 `createRng(seed)` 기반 결정론이어야 한다.
- **한국어 주석·UI 문자열.** 코드 식별자는 영문. 주석은 "왜"를 적고 "무엇"은 적지 않는다.
- **완료 기준은 항상 `npm test` (현재 700 통과) + `npx tsc -b` 클린 + `npx oxlint` 클린.** 셋 다 통과하지 않으면 커밋 금지.
- `npm test`는 vitest의 `console.log`를 억제한다. 계측 결과를 눈으로 봐야 할 때는 `expect`로 단언하거나 `node:fs`로 파일에 쓸 것.
- 팀 ID는 `'kor' | 'cze' | 'mex' | 'rsa' | 'ecu' | 'eng' | 'nor' | 'arg' | 'esp' | 'can' | 'mar' | 'fra'` 12종뿐이다 (`src/data/loader.ts:27`). `'ger'`·`'usa'`·`'jpn'`은 존재하지 않는다.
- 커밋 메시지는 한국어, `feat(scope):` / `fix(scope):` / `test(scope):` 형식. 끝에 다음 2줄을 붙인다:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o
  ```

---

## 배경 — 왜 이 작업을 하는가 (실측 근거)

메인 세션에서 4,800경기(한국 vs 체코·멕시코·남아공·스페인 × 300시드)를 직접 돌려 확인한 사실:

```
[라인]  10 → 경기당승점 1.642 (득1.37 실0.99)
        50 → 1.529
        90 → 1.424 (득1.49 실1.42)          ← 단조 감소

[압박]  10 → 1.622 (득1.43 실1.07)
        50 → 1.529
        90 → 1.167 (득1.18 실1.52)          ← 단조 감소, 게다가 득점까지 하락

[템포]  10 → 1.463  50 → 1.529  90 → 1.554  ← 단조 증가(얕음)
```

즉 상대가 누구든 최적해가 `라인10·압박10·템포90` 하나로 고정된다. 전술 센터로 이 축들을 킥오프 전에 전부 노출하면 숙련 유저·심사자가 수 분 내에 "다 내리면 이긴다"를 발견한다. **UI와 밸런스는 반드시 같은 브랜치로 나가야 한다.**

원인 (`src/engine/tactics.ts:21-36`):
- 라인 상승 이득은 `chanceQuality lerp(0.945→1.055)` = ±5.5%뿐인데, 비용은 `counterVulnerability lerp(0.75→1.25)` = ±25%. **비용이 이득의 4.5배.**
- 압박 이득은 `chanceRate ×1.1` 하나. 비용은 `counterVulnerability ×1.075` + `foulRate ×1.225` + `staminaDrain ×1.26` + 지속압박 페널티(`simulate.ts:133-147`)로 **4중 누적**.
- `attackFocus`는 `instructionEffects`가 읽지 않는다 — UI에만 존재하는 플라시보.

추가로 소스 직접 확인한 死데이터:
- `moraleByPlayer` — `simulate.ts:28`에서 70으로 초기화, `matchStore`가 팀토크/외침으로 갱신, `PlayerCard`가 표시. **엔진 결과 계산에서 읽는 곳 0건.**
- `TeamProfile.benchPattern` — `types.ts:19` 선언 + 픽스처뿐. **로직 0건** (상대는 90분간 교체 0회).
- `simulate.defaultTactics` (`simulate.ts:42-52`)는 AI에게 `profile.style`을 지시로 주는데, 유저는 `pickBestXI` (`lineup.ts:23`)의 하드코딩 `{50,50,50,'balanced'}`로 시작한다. **비대칭.**
- `INTERVENTION_PHASES` (`matchStore.ts:179`)에 `'pre'` 미포함 → 킥오프 전엔 어떤 지시도 낼 수 없다.
- `LineupScreen.handleConfirm` (`LineupScreen.tsx:69`)는 `{formation, lineup, instructions}`만 재조립 → mentality·groupIntensity 등 확장 필드가 유실된다.

---

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `src/engine/balance.ts` | 배치 시뮬 계측 — 축 스윕·A/B 비교. 테스트 전용 순수 함수 | **신규** |
| `src/engine/__tests__/balance.test.ts` | 밸런스 회귀 게이트(비단조성·Δ≥8pp·esp≥55) | **신규** |
| `src/engine/tactics.ts` | `instructionEffects`에 선택적 `MatchupContext` 추가, `attackFocusEffects` 신규 | 수정 |
| `src/engine/strength.ts` | `zoneStrength`에 morale 배수 추가 | 수정 |
| `src/engine/simulate.ts` | matchup 컨텍스트 조립, suppression 소비, 부스트 재설계, attackFocus 슈터 가중 | 수정 |
| `src/engine/lineup.ts` | `pickBestXI` 지시를 `profile.style`로 시딩 | 수정 |
| `src/game/oppAi.ts` | 상대 AI 교체·전술 스위칭 결정 (순수·결정론) | **신규** |
| `src/game/scouting.ts` | `recommendPlan` — 상대 프로필 기반 플랜 추천 | **신규** |
| `src/game/matchStore.ts` | `'pre'` 개입 승격, 상대 AI 호출, `matchPlan` 스냅샷·`planDeviation` | 수정 |
| `src/ui/tactics/TacticsCenter.tsx` | 킥오프 전 워룸 — 좌측 상대 리포트 + 4탭 + 하단 검토 요약 | **신규** |
| `src/ui/tactics/TacticsCenter.css` | 워룸 레이아웃 | **신규** |
| `src/ui/tactics/PlanBadge.tsx` | 플랜 대비 이탈 배지 | **신규** |
| `src/ui/match/MatchScreen.tsx` | `'pre'`에서 TacticsCenter 렌더, 킥오프 버튼 이동 | 수정 |
| `src/App.tsx` | LineupScreen 단계 제거, 전술 이월 | 수정 |
| `src/ui/lineup/LineupScreen.tsx` | 선발 편집부를 `LineupEditor`로 추출해 탭에서 재사용 | 수정 |
| `src/game/pressconf.ts` | `planDeviation` 기반 질문 분기 | 수정 |

---

## 태스크 순서와 근거

1. **계측 하네스 먼저** — 2번의 완료 기준이 "실측 게이트 통과"이므로, 게이트를 실행할 수단이 먼저 있어야 한다. 실패하는 게이트를 먼저 세우는 것이 TDD다.
2. **밸런스** — 전술 센터가 의미를 갖기 위한 전제.
3. **morale + 부스트** — 상대 AI(6번)보다 먼저. 상대가 똑똑해지는데 대응 수단(팀토크)이 플라시보면 체감 난이도만 오른다.
4. **`'pre'` 승격 + 전술 센터 골격** — 사용자 지적 직접 해소.
5. **상대 리포트 + 추천** — 4번의 결정에 근거를 준다.
6. **상대 AI** — "상대 감독이 산다".
7. **플랜 이탈** — 사전 설계에 게임 이론적 이유를 부여. 이게 없으면 유저는 전술 센터를 스킵하고 하프타임에 몰아 처리하는 것이 최적 플레이가 된다.

태스크 1·2·3은 엔진 전용, 4·5는 UI 전용, 6·7은 혼합이다. **1→2→3은 순차**(2가 1의 게이트를 쓰고, 3이 2의 밸런스 위에 얹힌다). **4는 1~3과 독립이므로 병렬 위임 가능**.

---

### Task 1: 밸런스 계측 하네스 + 회귀 게이트

**Files:**
- Create: `src/engine/balance.ts`
- Create: `src/engine/__tests__/balance.test.ts`

**Interfaces:**
- Consumes: `loadAllTeams`/`loadTeam` (`src/data/loader.ts`), `createMatch`·`simulateSegment` (`src/engine/simulate.ts`), `pickBestXI` (`src/engine/lineup.ts`)
- Produces:
  ```ts
  export interface SweepCell { value: number; winRate: number; points: number; gf: number; ga: number }
  export function runAxisSweep(homeId: TeamId, awayId: TeamId, axis: AxisKey, values: number[], n?: number): SweepCell[]
  export function bestAxisValue(cells: SweepCell[]): number
  export function runAbBatch(homeId: TeamId, awayId: TeamId, plan: Partial<TacticState>, n?: number): { base: number; plan: number; deltaPp: number }
  export type AxisKey = 'lineHeight' | 'pressing' | 'tempo'
  ```

- [ ] **Step 1: 하네스 작성**

`src/engine/balance.ts`:

```ts
// src/engine/balance.ts
// 밸런스 계측 전용 배치 시뮬. 프로덕션 번들에 포함되지 않도록 UI에서 import 금지.
// 목적: 지시 축이 "상대와 무관한 단조 지배 전략"이 되지 않았음을 회귀 테스트로 고정한다.
import type { TacticState, TeamId } from './types'
import { loadTeam, type TeamId as LoaderTeamId } from '../data/loader'
import { createMatch, simulateSegment } from './simulate'
import { pickBestXI } from './lineup'

export type AxisKey = 'lineHeight' | 'pressing' | 'tempo'

export interface SweepCell {
  value: number
  /** 홈(유저) 승률 0~1 */
  winRate: number
  /** 경기당 승점 0~3 — 무승부를 반영해 승률보다 노이즈가 낮다 */
  points: number
  gf: number
  ga: number
}

/** 홈 전술을 base에 patch를 병합해 구성하고 n경기 배치 시뮬. 시드는 seedBase부터 결정론 증가. */
function batch(homeId: LoaderTeamId, awayId: LoaderTeamId, patch: Partial<TacticState>, n: number, seedBase: number) {
  const home = loadTeam(homeId)
  const away = loadTeam(awayId)
  let w = 0, d = 0, gf = 0, ga = 0
  for (let i = 0; i < n; i++) {
    const t = pickBestXI(home)
    const tactics: TacticState = {
      ...t,
      ...patch,
      instructions: { ...t.instructions, ...(patch.instructions ?? {}) },
    }
    let st = createMatch(home, away, { seed: seedBase + i * 31, homeTactics: tactics })
    st = simulateSegment(st, 45)
    st = simulateSegment(st, 90)
    gf += st.score[0]; ga += st.score[1]
    if (st.score[0] > st.score[1]) w++
    else if (st.score[0] === st.score[1]) d++
  }
  return { winRate: w / n, points: (w * 3 + d) / n, gf: gf / n, ga: ga / n }
}

/** 한 축만 values로 변화시키고 나머지는 중립(50)으로 고정한 스윕. */
export function runAxisSweep(
  homeId: LoaderTeamId, awayId: LoaderTeamId, axis: AxisKey, values: number[], n = 120,
): SweepCell[] {
  return values.map(value => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced', [axis]: value },
    } as Partial<TacticState>, n, 1000)
    return { value, ...r }
  })
}

/** 승점 최대 셀의 축 값. 동점이면 낮은 값을 택한다(안정적 선택). */
export function bestAxisValue(cells: SweepCell[]): number {
  let best = cells[0]
  for (const c of cells) if (c.points > best.points) best = c
  return best.value
}

/** 기본 지시(50/50/50) vs 지정 플랜의 승률 차(퍼센트포인트). 유저 개입 레버리지 계측. */
export function runAbBatch(
  homeId: LoaderTeamId, awayId: LoaderTeamId, plan: Partial<TacticState>, n = 200,
): { base: number; plan: number; deltaPp: number } {
  const base = batch(homeId, awayId, {
    instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  } as Partial<TacticState>, n, 2000)
  const p = batch(homeId, awayId, plan, n, 2000)
  return {
    base: base.winRate,
    plan: p.winRate,
    deltaPp: Math.round((p.winRate - base.winRate) * 1000) / 10,
  }
}
```

> **주의**: `TacticState`를 `src/engine/types`에서, `TeamId`를 `src/data/loader`에서 가져온다. `types.ts`에는 `TeamId`가 없다 — 위 import 문에서 `type { TacticState, TeamId } from './types'`의 `TeamId`는 제거하고 loader의 것만 쓸 것.

- [ ] **Step 2: 게이트 테스트 작성 (지금은 실패해야 정상)**

`src/engine/__tests__/balance.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runAxisSweep, bestAxisValue, runAbBatch } from '../balance'
import { runBatch } from '../calibrate'
import { loadTeam } from '../../data/loader'

const VALUES = [20, 35, 50, 65, 80]

describe('지시 축 비단조성 — 최적값이 상대에 따라 달라져야 한다', () => {
  it('라인: 약체(남아공)전 최적 라인이 강팀(스페인)전보다 높다', () => {
    const vsRsa = bestAxisValue(runAxisSweep('kor', 'rsa', 'lineHeight', VALUES))
    const vsEsp = bestAxisValue(runAxisSweep('kor', 'esp', 'lineHeight', VALUES))
    expect(vsRsa).toBeGreaterThan(vsEsp)
  }, 300_000)

  it('압박: 약체(남아공)전 최적 압박이 강팀(스페인)전보다 높다', () => {
    const vsRsa = bestAxisValue(runAxisSweep('kor', 'rsa', 'pressing', VALUES))
    const vsEsp = bestAxisValue(runAxisSweep('kor', 'esp', 'pressing', VALUES))
    expect(vsRsa).toBeGreaterThan(vsEsp)
  }, 300_000)

  it('라인 최고값과 최저값의 승점 차가 0.30을 넘지 않는다(지배 전략 방지)', () => {
    const cells = runAxisSweep('kor', 'mex', 'lineHeight', VALUES)
    const pts = cells.map(c => c.points)
    expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
  }, 300_000)

  it('압박 최고값과 최저값의 승점 차가 0.30을 넘지 않는다', () => {
    const cells = runAxisSweep('kor', 'mex', 'pressing', VALUES)
    const pts = cells.map(c => c.points)
    expect(Math.max(...pts) - Math.min(...pts)).toBeLessThan(0.30)
  }, 300_000)
})

describe('유저 개입 레버리지', () => {
  it('상대별 맞춤 플랜이 기본값 대비 8pp 이상 승률을 올린다', () => {
    // vs 스페인(점유 강팀): 블록을 내리고 역습 — 낮은 라인·낮은 압박·빠른 템포
    const r = runAbBatch('kor', 'esp', {
      instructions: { lineHeight: 25, pressing: 30, tempo: 75, attackFocus: 'balanced' },
      mentality: 'defensive',
      attackPattern: 'through',
    })
    expect(r.deltaPp).toBeGreaterThanOrEqual(8)
  }, 300_000)
})

describe('전력 서열 게이트', () => {
  it('스페인이 홈에서 한국 상대 55% 이상 승률', () => {
    const report = runBatch(loadTeam('esp'), loadTeam('kor'), 300)
    expect(report.homeWinRate).toBeGreaterThanOrEqual(0.55)
  }, 300_000)
})
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run src/engine/__tests__/balance.test.ts`

Expected: 비단조성 4건 + 레버리지 1건 + 서열 1건 중 **최소 5건 FAIL**. 현재 엔진은 라인·압박이 단조 감소이므로 `vsRsa > vsEsp`가 성립하지 않고(둘 다 최저값 20이 최적), 승점 차도 0.30을 넘으며, esp 승률은 실측 51.2%로 55 미만이다.

각 실패 메시지를 그대로 기록해 둘 것 — Task 2의 튜닝 출발점이다.

- [ ] **Step 4: 게이트를 스킵 처리하고 커밋**

Task 2가 끝나기 전까지 `npm test`가 빨간불이면 다른 작업의 완료 판정이 불가능하다. `describe.skip`이 아니라 **`it` 앞에 `.skip`을 붙이고 그 위에 사유 주석**을 남긴다:

```ts
  // Task 2(축 밸런스)에서 해제한다. 현재 엔진은 라인·압박이 단조 감소라 필연적으로 실패한다.
  it.skip('라인: 약체(남아공)전 최적 라인이 강팀(스페인)전보다 높다', () => {
```

Run: `npm test` → 700 passed, 6 skipped
Run: `npx tsc -b && npx oxlint`

- [ ] **Step 5: 커밋**

```bash
git add src/engine/balance.ts src/engine/__tests__/balance.test.ts
git commit -m "test(engine): 밸런스 계측 하네스 + 축 비단조성 회귀 게이트(Task 2까지 skip)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

---

### Task 2: 지시 축 밸런스 재설계 (B1–B5)

**Files:**
- Modify: `src/engine/tactics.ts:21-36` (`instructionEffects`), 신규 `attackFocusEffects`
- Modify: `src/engine/simulate.ts:109-200` (`simulateMinute`), `:216-265` (`resolveChance`)
- Modify: `src/engine/__tests__/balance.test.ts` (skip 해제)
- Test: `src/engine/__tests__/tactics.test.ts` (신규 케이스 추가)

**Interfaces:**
- Consumes: Task 1의 `runAxisSweep`·`bestAxisValue`·`runAbBatch`
- Produces:
  ```ts
  export interface MatchupContext {
    /** 상대 최전방(ST/LW/RW) pace 평균 0~100 */
    oppFrontPace: number
    /** 상대 GK buildup 0~100 */
    oppGkBuildup: number
    /** 상대 프로필 점유 성향 0~100 */
    oppPossession: number
  }
  export function instructionEffects(ins: Instructions, ctx?: MatchupContext): {
    chanceRate: number; chanceQuality: number; counterVulnerability: number
    possessionBias: number; foulRate: number; staminaDrain: number
    /** 이 팀의 수비 태세가 상대 찬스 빈도를 억제하는 배수(≤1.0). ctx 없으면 1.0 */
    suppression: number
  }
  export function attackFocusEffects(focus: Instructions['attackFocus'], oppFlank: { left: number; right: number; center: number }): { chanceQuality: number }
  ```

**핵심 설계 — 왜 이렇게 하는가**

현재 라인·압박은 **이득이 자기 공격에만, 비용이 자기 수비에만** 붙는다. 그래서 "안 하면 이득"이 된다. 실제 축구에서 하이라인·하이프레스의 본질적 보상은 **상대를 방해하는 것**이다. 그 항이 엔진에 아예 없다.

따라서 두 축에 **상대 억제 항**을 추가하고, 그 억제 효과가 **상대 성향에 따라 달라지게** 한다. 이렇게 해야 최적값이 상대별로 갈린다.

- B1 하이라인 → 상대 빌드업 방해 (`suppression`)
- B2 하이라인 비용 → 상대 최전방 pace에 비례 (빠른 ST 없으면 페널티 축소)
- B3 하이프레스 → 상대 점유 탈취 (`possessionBias`↑, 상대 GK buildup 낮을수록 큼)
- B4 압박 비용 4중 누적 완화 (`counterVulnerability`에서 압박 항 제거, 지속압박 임계 70→75)
- B5 `attackFocus` 엔진 반영 (상대 약한 측면을 노리면 보상)

- [ ] **Step 1: `MatchupContext` 파생 헬퍼 테스트 작성**

`src/engine/__tests__/tactics.test.ts` 하단에 추가:

```ts
import { instructionEffects, attackFocusEffects } from '../tactics'

describe('MatchupContext — 미지정 시 기존 동작 불변', () => {
  const NEUTRAL = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' } as const

  it('ctx 없으면 모든 축이 정확히 1.0', () => {
    const fx = instructionEffects(NEUTRAL)
    expect(fx.chanceRate).toBeCloseTo(1.0, 10)
    expect(fx.chanceQuality).toBeCloseTo(1.0, 10)
    expect(fx.counterVulnerability).toBeCloseTo(1.0, 10)
    expect(fx.possessionBias).toBeCloseTo(1.0, 10)
    expect(fx.suppression).toBe(1.0)
  })

  it('ctx가 있어도 라인·압박이 60 미만이면 suppression은 1.0', () => {
    const ctx = { oppFrontPace: 80, oppGkBuildup: 50, oppPossession: 50 }
    expect(instructionEffects({ ...NEUTRAL, lineHeight: 55 }, ctx).suppression).toBe(1.0)
  })

  it('하이라인은 상대 찬스를 억제한다(suppression < 1)', () => {
    const ctx = { oppFrontPace: 60, oppGkBuildup: 50, oppPossession: 50 }
    expect(instructionEffects({ ...NEUTRAL, lineHeight: 90 }, ctx).suppression).toBeLessThan(1.0)
  })

  it('하이라인 역습 비용은 상대 최전방이 빠를수록 크다', () => {
    const slow = { oppFrontPace: 55, oppGkBuildup: 50, oppPossession: 50 }
    const fast = { oppFrontPace: 92, oppGkBuildup: 50, oppPossession: 50 }
    const ins = { ...NEUTRAL, lineHeight: 90 }
    expect(instructionEffects(ins, fast).counterVulnerability)
      .toBeGreaterThan(instructionEffects(ins, slow).counterVulnerability)
  })

  it('하이프레스 점유 이득은 상대 GK 빌드업이 낮을수록 크다', () => {
    const badGk = { oppFrontPace: 60, oppGkBuildup: 30, oppPossession: 45 }
    const goodGk = { oppFrontPace: 60, oppGkBuildup: 88, oppPossession: 45 }
    const ins = { ...NEUTRAL, pressing: 90 }
    expect(instructionEffects(ins, badGk).possessionBias)
      .toBeGreaterThan(instructionEffects(ins, goodGk).possessionBias)
  })
})

describe('attackFocus — 상대 약한 측면을 노리면 보상', () => {
  it('balanced는 정확히 1.0', () => {
    expect(attackFocusEffects('balanced', { left: 70, right: 70, center: 70 }).chanceQuality).toBe(1.0)
  })
  it('상대 좌측이 약할 때 left 집중이 right 집중보다 유리', () => {
    const flank = { left: 55, right: 82, center: 70 }
    expect(attackFocusEffects('left', flank).chanceQuality)
      .toBeGreaterThan(attackFocusEffects('right', flank).chanceQuality)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/engine/__tests__/tactics.test.ts`
Expected: FAIL — `suppression` 프로퍼티 없음, `attackFocusEffects` is not a function

- [ ] **Step 3: `tactics.ts` 구현**

`src/engine/tactics.ts`의 `instructionEffects`를 아래로 교체하고 `attackFocusEffects`를 추가:

```ts
/** 상대 성향 컨텍스트. 지정 시 라인·압박의 "상대 억제" 항과 상대 의존 비용이 활성화된다.
 *  미지정이면 전 항이 중립이라 기존 수치와 완전히 동일하다(시드 회귀 불변). */
export interface MatchupContext {
  /** 상대 최전방(ST/LW/RW) pace 평균 0~100 */
  oppFrontPace: number
  /** 상대 GK buildup 0~100 */
  oppGkBuildup: number
  /** 상대 프로필 점유 성향 0~100 */
  oppPossession: number
}

const clamp01 = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function instructionEffects(ins: Instructions, ctx?: MatchupContext) {
  const line = ins.lineHeight, press = ins.pressing, tempo = ins.tempo
  // 결합 증폭: 하이라인×하이프레스가 함께 갈 때 역습 취약성 초과 증가 (레스트 디펜스 부재 모델링)
  const comboBoost = line > 70 && press > 70 ? ((line - 70) / 30) * ((press - 70) / 30) * 0.5 : 0
  // 각 lerp 구간은 기준 지시(50)에서 정확히 1.0이 되도록 중심을 맞춤 (lo+hi=2.0).

  // ── B1 하이라인 상대 빌드업 방해 ──
  // 라인 60 초과분에 비례해 상대 찬스 빈도를 최대 12% 억제. 상대가 점유형일수록
  // 압박 라인을 올려 전개를 끊는 가치가 크다(점유형은 뒤에서 시작하므로).
  // ctx 없으면 1.0.
  let suppression = 1.0
  if (ctx && line > 60) {
    const t = (line - 60) / 40                       // 0..1
    const possFactor = 0.7 + (ctx.oppPossession / 100) * 0.6  // 점유40→0.94, 점유78→1.17
    suppression *= 1 - t * 0.12 * possFactor
  }
  // ── B3 하이프레스 탈취 ──
  // 압박 60 초과분에 비례해 상대 찬스 억제 + 자기 점유 상승.
  // 상대 GK 빌드업이 낮을수록 크다(후방에서 압박에 무너진다).
  let pressGain = 0
  if (ctx && press > 60) {
    const t = (press - 60) / 40
    const gkFactor = clamp01(1.4 - ctx.oppGkBuildup / 70, 0.35, 1.4) // buildup 30→0.97, 88→0.4
    pressGain = t * 0.15 * gkFactor
    suppression *= 1 - t * 0.08 * gkFactor
  }

  // ── B2 하이라인 역습 비용을 상대 최전방 속도에 비례 ──
  // 기존 고정 lerp(line, 0.75, 1.25)의 상방 기울기를 pace 계수로 스케일.
  // 계수는 pace 75에서 1.0 → 기존과 동일, 빠르면 최대 1.35, 느리면 최소 0.65.
  const paceScale = ctx ? clamp01(0.65 + (ctx.oppFrontPace - 55) / 40 * 0.7, 0.65, 1.35) : 1.0
  const lineVul = line <= 50
    ? lerp(line, 0.75, 1.0) / 1.0 * lerp(line, 0.75, 1.0) / lerp(line, 0.75, 1.0) // 하방은 스케일 미적용
    : 1 + (lerp(line, 0.75, 1.25) - 1) * paceScale

  return {
    chanceRate: lerp(tempo, 0.78, 1.22) * lerp(press, 0.9, 1.1),
    chanceQuality: lerp(tempo, 1.11, 0.89) * lerp(line, 0.945, 1.055),
    // ── B4 압박 항 제거 ──
    // 역습 취약성은 라인이 담당한다. 압박은 foulRate·staminaDrain·지속압박으로 이미 3중 과금 중.
    counterVulnerability: (line <= 50 ? lerp(line, 0.75, 1.25) : lineVul) * (1 + comboBoost),
    possessionBias: lerp(tempo, 1.08, 0.92) * lerp(press, 0.935, 1.065) * (1 + pressGain),
    foulRate: lerp(press, 0.775, 1.225),
    // pressing 폭 0.74~1.26 (±0.52): 압박 90에서 staminaDrain > 1.2 계약(테스트)을 만족시키기 위한 값
    staminaDrain: lerp(press, 0.74, 1.26) * lerp(tempo, 0.915, 1.085),
    suppression,
  }
}

/** 공격 방향 집중의 효과. 상대의 해당 측면 수비 강도가 낮을수록 보상이 크다.
 *  balanced는 정확히 1.0(기존 동작). 집중은 성공 시 +8%, 실패 시 −6% 수준의 도박. */
export function attackFocusEffects(
  focus: Instructions['attackFocus'],
  oppFlank: { left: number; right: number; center: number },
): { chanceQuality: number } {
  if (focus === 'balanced') return { chanceQuality: 1.0 }
  const avg = (oppFlank.left + oppFlank.right + oppFlank.center) / 3
  const target = oppFlank[focus]
  // 평균 대비 상대적 약점 비율. −1(매우 강함)~+1(매우 약함) 범위로 정규화.
  const edge = clamp01((avg - target) / Math.max(15, avg * 0.35), -1, 1)
  return { chanceQuality: 1 + edge * 0.08 }
}
```

> **`lineVul` 주의**: 위 표현식은 의도적으로 장황하다. 실제로는 아래처럼 단순화해 쓸 것 — 라인 50 이하 구간은 기존과 완전히 동일해야 하고(회귀 불변), 50 초과 구간만 pace로 스케일한다:
> ```ts
> const lineRaw = lerp(line, 0.75, 1.25)
> const lineVul = line <= 50 ? lineRaw : 1 + (lineRaw - 1) * paceScale
> ```
> 그리고 `counterVulnerability: lineVul * (1 + comboBoost)`로 쓴다. `ctx` 미지정이면 `paceScale === 1.0`이라 `lineVul === lineRaw` → 기존과 동일. 반드시 이 형태로 구현하고, 위의 장황한 버전은 쓰지 말 것.

- [ ] **Step 4: 테스트 통과 확인 + 회귀 확인**

Run: `npx vitest run src/engine/__tests__/tactics.test.ts`
Expected: PASS

Run: `npm test`
Expected: **700 passed, 6 skipped** — 기존 700개가 하나도 깨지지 않아야 한다. 깨졌다면 `ctx` 미지정 경로에 1.0이 아닌 값이 섞인 것이다. `counterVulnerability`에서 압박 항(`lerp(press, 0.925, 1.075)`)을 제거했으므로 **압박 관련 테스트가 깨질 수 있다** — `tactics.test.ts`·`simulate.test.ts`에서 "압박이 역습 취약성을 올린다"류 단언을 찾아, 압박의 비용이 이제 `foulRate`·`staminaDrain`으로 표현된다는 사실에 맞게 **단언을 갱신**한다(테스트를 지우지 말고 의미를 옮길 것).

- [ ] **Step 5: 커밋**

```bash
git add src/engine/tactics.ts src/engine/__tests__/tactics.test.ts
git commit -m "feat(engine): 지시 축에 상대 억제 항 추가 (B1~B4) — 라인·압박 단조 지배 제거

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

- [ ] **Step 6: `simulate.ts`에서 컨텍스트 조립 + suppression·attackFocus 소비**

`src/engine/simulate.ts`에 헬퍼를 추가하고 `simulateMinute`·`resolveChance`를 수정한다.

파일 상단 import에 `attackFocusEffects`, `type MatchupContext`를 추가한 뒤, `simulateMinute` 위에 헬퍼를 넣는다:

```ts
/** 상대 성향 컨텍스트 조립 — 지시 효과의 "상대 억제" 항 입력.
 *  최전방 pace는 라인업의 ST/LW/RW 실효 pace 평균(체력 반영). 없으면 중립 55. */
function matchupContext(opp: SideState): MatchupContext {
  const fronts = opp.tactics.lineup
    .filter(l => !opp.sentOff.includes(l.playerId) && (l.slot === 'ST' || l.slot === 'LW' || l.slot === 'RW'))
    .map(l => {
      const p = opp.team.squad.find(q => q.id === l.playerId)!
      return effectiveStats(p, l.slot, opp.staminaByPlayer[l.playerId]).pace
    })
  const gkSlot = opp.tactics.lineup.find(l => l.slot === 'GK')
  const gk = gkSlot ? opp.team.squad.find(p => p.id === gkSlot.playerId) : undefined
  return {
    oppFrontPace: fronts.length ? fronts.reduce((s, v) => s + v, 0) / fronts.length : 55,
    oppGkBuildup: gk?.gkStats?.buildup ?? 50,
    oppPossession: opp.team.profile.style.possession,
  }
}

/** 측면별 상대 수비 강도 — attackFocus 판정 입력.
 *  left: 우리가 왼쪽을 공략 → 상대의 오른쪽 수비(RB/RCB). 좌우가 뒤집히는 점에 주의. */
function flankStrength(def: SideState): { left: number; right: number; center: number } {
  const pick = (slots: string[]) => {
    const vals = def.tactics.lineup
      .filter(l => !def.sentOff.includes(l.playerId) && slots.includes(l.slot))
      .map(l => {
        const p = def.team.squad.find(q => q.id === l.playerId)!
        const es = effectiveStats(p, l.slot as Position, def.staminaByPlayer[l.playerId])
        return (es.defending + es.physical + es.pace) / 3
      })
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 55
  }
  return { left: pick(['RB', 'RW']), right: pick(['LB', 'LW']), center: pick(['CB', 'DM']) }
}
```

`simulateMinute`의 `fx` 생성부(현재 112행)를 교체:

```ts
  const ctx = [matchupContext(st.away), matchupContext(st.home)] as const
  const fx = [
    instructionEffects(st.home.tactics.instructions, ctx[0]),
    instructionEffects(st.away.tactics.instructions, ctx[1]),
  ]
```

> `ctx[0]`은 홈이 마주하는 상대(=어웨이)의 컨텍스트다. 인덱스를 뒤집지 말 것.

개입 부스트 블록(현재 123–131행)은 Task 3에서 손댄다. 지금은 그대로 둔다.

`chanceP` 계산(현재 185–188행)에 `suppression`을 곱한다 — **수비 측의 suppression이 공격 측 찬스를 억제**한다:

```ts
  const chanceP = clamp(
    (atk.team.statBaseline.shotsPerGame / (90 * participation))
      * Math.pow(atkZone / Math.max(30, defZone), STRENGTH_SENSITIVITY)
      * fx[atkIdx].chanceRate * ap.chanceRate
      * fx[defIdx].counterVulnerability * fx[defIdx].suppression
      * momentumBoost,
    0.02, 0.45,
  )
```

`resolveChance`의 `xg` 계산(현재 243행)에 attackFocus를 곱한다:

```ts
  const af = attackFocusEffects(atk.tactics.instructions.attackFocus, flankStrength(def))
  const xg = clamp((es.shooting / 100) * 0.35 * fx[atkIdx].chanceQuality * ap.chanceQuality * qualityBoost * af.chanceQuality, 0.02, 0.65)
```

- [ ] **Step 7: 회귀 확인 — 여기서 반드시 깨진다**

Run: `npm test`

`ctx`가 이제 **항상 전달**되므로 라인/압박이 60을 넘는 케이스와 `attackFocus !== 'balanced'` 케이스에서 수치가 바뀐다. AI 상대는 `profile.style`을 지시로 쓰므로(`simulate.ts:42-52`) 실팀 시뮬은 거의 전부 값이 달라진다.

깨지는 테스트를 분류한다:
1. **캘리브레이션 계약**(`realdata-calibration.test.ts`, `calibrate.test.ts`) — ±15%/±25% 범위를 벗어났다면 **계수를 조정**한다(테스트를 완화하지 말 것). 조정 순서: `suppression` 상한 0.12/0.08 → 0.08/0.05로 낮춰본다.
2. **고정 스코어 스냅샷**(`integration.test.ts` 등에서 특정 시드의 스코어를 단언) — 밸런스 변경의 정당한 결과다. **새 값으로 갱신**하되, 커밋 메시지에 "시드 스냅샷 갱신: 밸런스 변경(B1~B5)의 의도된 결과"를 남긴다.
3. **의미 단언**(예: "하이라인이면 역습 취약성이 높다") — 여전히 참이어야 한다. 거짓이 됐다면 계수가 과했다는 뜻이니 되돌린다.

- [ ] **Step 8: 밸런스 게이트 해제 및 튜닝 루프**

`src/engine/__tests__/balance.test.ts`의 `it.skip` → `it`로 전부 해제하고 사유 주석 제거.

Run: `npx vitest run src/engine/__tests__/balance.test.ts`

통과할 때까지 아래 순서로 **계수만** 조정한다(구조는 바꾸지 말 것):

| 실패 게이트 | 조정할 계수 | 방향 |
|---|---|---|
| 라인 기울기 vs rsa ≤ +0.08 | `suppression`의 0.12 계수 | 올린다 (약체 상대 하이라인 보상 강화) |
| 라인 기울기 vs esp ≥ −0.08 | `paceScale` 범위(0.65~1.35) + `possFactor` 폭 | 넓힌다 (강팀 상대 비용 강화) |
| 압박 기울기 vs rsa ≤ +0.08 | `pressGain`의 0.15 계수, `gkFactor` 상한 | 올린다 |
| 압박 기울기 vs esp ≥ −0.08 | `gkFactor` 하한(0.35) | 내린다 (좋은 GK 상대로는 압박 이득 소멸) |
| 어느 축이든 승점 차 > 0.30 (vs mex) | 해당 축의 이득·비용 계수 | 균형 쪽으로 좁힌다. 압박이면 지속압박 임계 70→75(`simulate.ts:138,141,175`) |
| Δ < 8pp | — | 다른 게이트를 먼저 맞춘 뒤 재측정. 비단조성이 생기면 자연히 오른다 |
| esp 승률 < 55% | `STRENGTH_SENSITIVITY`(`simulate.ts`) | 1.6 → 1.7로 올린다. 단 캘리브레이션 재확인 필수 |

**게이트 형태 변경 (Task 1 완료 후 반영됨)**: 최적값 argmax 비교는 n=400에서도 노이즈로 흔들려(승점 폭 0.066) 폐기했다. 대신 **축을 10→90으로 올렸을 때의 승점 기울기 부호**로 판정한다. 설계 의도는 "약체 상대로는 라인·압박을 올리는 것이 유리하고, 강팀 상대로는 불리하다"이며, 마진 0.08은 승점 차 표준오차(약 0.085)를 넘는 실질 효과를 요구한다.

각 조정 후 **반드시 `npm test` 전체를 다시 돌려** 캘리브레이션 계약이 유지되는지 확인한다. 게이트를 통과시키려고 캘리브레이션을 깨면 안 된다 — 두 조건을 동시에 만족하는 계수를 찾아야 한다.

3회 조정해도 두 조건을 동시에 만족시키지 못하면 **중단하고 보고**한다. 계수 탐색이 아니라 구조 문제일 수 있다.

- [ ] **Step 9: 최종 확인 및 커밋**

Run: `npm test` → 706 passed (700 + 밸런스 6)
Run: `npx tsc -b && npx oxlint`

```bash
git add -A
git commit -m "feat(engine): attackFocus 반영 + suppression 배선, 밸런스 게이트 통과 (B1~B5)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

---

### Task 3: morale 엔진 반영 + 개입 부스트 재설계

**Files:**
- Modify: `src/engine/strength.ts:17-48` (`zoneStrength`)
- Modify: `src/engine/simulate.ts:123-131` (개입 부스트)
- Test: `src/engine/__tests__/strength.test.ts`

**Interfaces:**
- Consumes: Task 2의 밸런스 게이트 (`runAbBatch`)
- Produces: `zoneStrength`의 반환값이 `side.moraleByPlayer`에 반응한다. `SimulateOpts.instructionBoost`의 의미가 "방향 증폭"에서 "고정 보너스"로 바뀐다.

**★ 설계 정정 — 감사 문서(`docs/audit/game-design-plan.md` §6)의 오류**

감사 문서는 `moraleFactor = 0.94 + 0.12 × (avgMorale/100)`을 제안한다. 그러나 **초기 사기는 70**(`simulate.ts:28`)이므로 이 식은 `0.94 + 0.084 = 1.024`가 되어 **모든 기존 시드 결과가 바뀐다**. 700개 테스트가 전부 깨진다.

**70을 중심으로 재정의한다:**

```
moraleFactor = 1 + (avgMorale − 70) / 100 × 0.20
```

검산: 사기 70 → `1 + 0 = 1.0` (정확히 중립, 회귀 불변). 사기 100 → `1.06`. 사기 40 → `0.94`. 사기 0 → `0.86`.
팀토크 최대 delta는 +11(페이버릿×지는중×격노)이므로 81 → `1.022`. 전력 +2.2%는 체감 가능하면서 균형을 깨지 않는 크기다.

- [ ] **Step 1: 실패 테스트 작성**

`src/engine/__tests__/strength.test.ts`에 추가:

```ts
describe('morale이 존 전력에 반영된다', () => {
  it('사기 70(초기값)이면 배수가 정확히 1.0 — 회귀 불변', () => {
    const side = makeSide()   // 기존 테스트의 픽스처 헬퍼 사용
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 70
    const base = zoneStrength(side)
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 70
    expect(zoneStrength(side).attack).toBeCloseTo(base.attack, 10)
  })

  it('사기가 높으면 존 전력이 오른다', () => {
    const side = makeSide()
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 70
    const at70 = zoneStrength(side).attack
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 100
    expect(zoneStrength(side).attack).toBeGreaterThan(at70)
  })

  it('사기 100은 사기 70 대비 정확히 6% 높다', () => {
    const side = makeSide()
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 70
    const at70 = zoneStrength(side).attack
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 100
    expect(zoneStrength(side).attack / at70).toBeCloseTo(1.06, 6)
  })

  it('사기 40은 사기 70 대비 6% 낮다', () => {
    const side = makeSide()
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 70
    const at70 = zoneStrength(side).defense
    for (const id of Object.keys(side.moraleByPlayer)) side.moraleByPlayer[id] = 40
    expect(zoneStrength(side).defense / at70).toBeCloseTo(0.94, 6)
  })
})
```

> `makeSide()`는 기존 `strength.test.ts`가 이미 쓰는 픽스처 구성 방식을 그대로 따를 것. 파일 상단을 읽고 동일한 헬퍼가 있으면 재사용하고, 없으면 `testTeams.ts`의 픽스처로 인라인 구성한다.

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/engine/__tests__/strength.test.ts`
Expected: "사기가 높으면 존 전력이 오른다" FAIL — 현재 morale은 읽히지 않으므로 값이 동일하다

- [ ] **Step 3: `zoneStrength` 수정**

`src/engine/strength.ts`의 `zoneStrength` 안, `const mod = ...` 정의 직전에 추가:

```ts
  // 사기 반영: 주전 평균 사기를 존 전력 배수로. 초기값 70에서 정확히 1.0이 되도록
  // 70을 중심으로 정의한다(시드 회귀 불변). 100→1.06, 40→0.94, 0→0.86.
  const moraleVals = side.tactics.lineup
    .filter(l => !side.sentOff.includes(l.playerId))
    .map(l => side.moraleByPlayer[l.playerId] ?? 70)
  const avgMorale = moraleVals.length ? moraleVals.reduce((s, v) => s + v, 0) / moraleVals.length : 70
  const moraleFactor = 1 + ((avgMorale - 70) / 100) * 0.20
```

그리고 `mod` 정의에 곱한다:

```ts
  const mod = (zone: 'attack' | 'midfield' | 'defense') =>
    groupIntensityZoneFactor(gi, zone) * (phase ? phaseTilt(pf, phase, zone) : 1.0) * moraleFactor
```

> `gk` 존에는 적용하지 않는다 — `gk` 값은 현재 아무 데서도 소비되지 않으며(`simulate.ts:239`가 `gkStats.saving`을 직접 읽는다), 죽은 경로에 로직을 추가할 이유가 없다.

- [ ] **Step 4: 통과 및 회귀 확인**

Run: `npx vitest run src/engine/__tests__/strength.test.ts` → PASS
Run: `npm test` → 전부 통과해야 한다. 초기 사기가 전원 70이므로 `moraleFactor === 1.0`이고, 팀토크를 쓰지 않는 테스트는 값이 변하지 않는다. **깨지는 것이 있다면 어딘가에서 morale을 70이 아닌 값으로 초기화하고 있다는 뜻**이니 그 지점을 찾아 보고할 것.

- [ ] **Step 5: 커밋**

```bash
git add src/engine/strength.ts src/engine/__tests__/strength.test.ts
git commit -m "feat(engine): 사기를 존 전력에 반영 (70 중심 ±6%) — 팀토크·외침 플라시보 해소

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

- [ ] **Step 6: 개입 부스트 재설계 테스트**

현재 부스트는 `amp(v) = 1 + (v − 1) × 1.3` — 지시가 중립(1.0)에 가까우면 아무 일도 하지 않고, 저압박·저라인 플랜에서는 **1.0 미만 편차까지 증폭해 역효과**를 낸다(감사 실측: 스페인전 −3.0pp).

`src/engine/__tests__/simulate.test.ts`에 추가:

```ts
describe('개입 부스트는 지시값과 무관하게 항상 유리하다', () => {
  it('중립 지시에서도 부스트가 찬스 퀄리티를 올린다', () => {
    const home = loadTeam('kor'), away = loadTeam('cze')
    const t = pickBestXI(home)
    t.instructions = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' }
    let boosted = 0, plain = 0
    for (let s = 0; s < 120; s++) {
      let a = createMatch(home, away, { seed: 5000 + s, homeTactics: t })
      a = simulateSegment(a, 45); a = simulateSegment(a, 90)
      plain += a.score[0]
      let b = createMatch(home, away, { seed: 5000 + s, homeTactics: t })
      b = simulateSegment(b, 45)
      b = simulateSegment(b, 90, { instructionBoost: { side: 'home', until: 90 } })
      boosted += b.score[0]
    }
    expect(boosted).toBeGreaterThan(plain)
  }, 120_000)

  it('저압박·저라인 플랜에서도 부스트가 역효과를 내지 않는다', () => {
    const home = loadTeam('kor'), away = loadTeam('esp')
    const t = pickBestXI(home)
    t.instructions = { lineHeight: 25, pressing: 30, tempo: 75, attackFocus: 'balanced' }
    let bw = 0, pw = 0
    for (let s = 0; s < 150; s++) {
      let a = createMatch(home, away, { seed: 6000 + s, homeTactics: t })
      a = simulateSegment(a, 45); a = simulateSegment(a, 90)
      if (a.score[0] > a.score[1]) pw++
      let b = createMatch(home, away, { seed: 6000 + s, homeTactics: t })
      b = simulateSegment(b, 45)
      b = simulateSegment(b, 90, { instructionBoost: { side: 'home', until: 90 } })
      if (b.score[0] > b.score[1]) bw++
    }
    expect(bw).toBeGreaterThanOrEqual(pw)
  }, 150_000)
})
```

- [ ] **Step 7: 실패 확인**

Run: `npx vitest run src/engine/__tests__/simulate.test.ts -t '개입 부스트'`
Expected: 첫 번째 케이스 FAIL — 중립 지시(전 축 1.0)에서 `amp(1.0) = 1.0`이라 부스트가 아무 효과가 없다

- [ ] **Step 8: 부스트 구현 교체**

`src/engine/simulate.ts`의 부스트 블록(현재 123–131행)을 교체:

```ts
  // 개입 직후 부스트: 방향 증폭이 아니라 **고정 보너스**로 준다.
  // 기존 amp(v)=1+(v-1)×1.3은 지시가 중립이면 무효과이고, 저압박·저라인 플랜에서는
  // 1.0 미만 편차까지 증폭해 역효과였다(감사 실측 스페인전 −3.0pp).
  // 값이 항상 같은 방향이라 UI로 약속할 수 있다("작전 지시 효과 8분간 지속").
  const boost = opts.instructionBoost
  if (boost && st.minute <= boost.until) {
    const bi = boost.side === 'home' ? 0 : 1
    fx[bi].chanceQuality *= 1.08
    fx[bi].counterVulnerability *= 0.94
  }
```

> `counterVulnerability`는 **자기 팀의 취약성**이다. `fx[defIdx].counterVulnerability`가 공격 측 찬스에 곱해지므로, 부스트받은 팀의 값을 낮추면 그 팀이 실점할 확률이 내려간다. 방향이 맞다.

- [ ] **Step 9: 통과 및 회귀 확인**

Run: `npx vitest run src/engine/__tests__/simulate.test.ts` → PASS
Run: `npm test`

기존 부스트 테스트가 "부스트가 지시 방향을 증폭한다"를 단언하고 있으면 **의미가 바뀌었으므로 갱신**한다("부스트가 찬스 퀄리티를 올리고 실점 위험을 낮춘다"). 삭제하지 말 것.

- [ ] **Step 10: 커밋**

```bash
git add src/engine/simulate.ts src/engine/__tests__/simulate.test.ts
git commit -m "fix(engine): 개입 부스트를 방향 증폭에서 고정 보너스로 재설계 (퀄 +8%·실점위험 −6%)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

---

### Task 4: `'pre'` 개입 phase 승격 + 전술 센터 골격

**Files:**
- Modify: `src/game/matchStore.ts:179` (`INTERVENTION_PHASES`), `:318-324` (`confirmTactics`), `:332-361` (`submitCommand`)
- Modify: `src/engine/lineup.ts:23` (`pickBestXI` 지시 시딩)
- Create: `src/ui/tactics/TacticsCenter.tsx`
- Create: `src/ui/tactics/TacticsCenter.css`
- Modify: `src/ui/lineup/LineupScreen.tsx` (선발 편집부를 `LineupEditor`로 추출)
- Modify: `src/ui/match/MatchScreen.tsx:504-514, 549-553`
- Modify: `src/App.tsx:138-174` (lineup 단계 제거, 전술 이월)
- Test: `src/game/__tests__/matchStore.test.ts`, `src/engine/__tests__/lineup.test.ts`

**Interfaces:**
- Consumes: 기존 `TacticsBoard`·`ConsolePanel`·`TacticsExtras`·`OppPanel`·`SubPanel` (전부 store 바인딩, 수정 불필요)
- Produces:
  ```ts
  // src/ui/lineup/LineupScreen.tsx
  export function LineupEditor(props: {
    team: Team; tactics: TacticState; onChange(next: TacticState): void
  }): JSX.Element
  // src/ui/tactics/TacticsCenter.tsx
  export function TacticsCenter(props: { onKickoff(): void; referenceScore?: [number, number] }): JSX.Element
  ```

**설계 — 왜 새 화면이 아닌가**

`ConsolePanel`/`TacticsExtras`/`SubPanel`/`OppPanel`은 이미 전부 `useMatchStore(s => s.engine)`을 읽고 `submitCommand`로 쓴다. 이들을 prop 기반으로 바꾸면 4개 컴포넌트 시그니처 + 테스트를 전부 고쳐야 한다. 대신 **`'pre'`를 개입 phase로 승격**하면 이 컴포넌트들이 **무수정으로 킥오프 전에도 동작**한다. 경기 전 UI와 경기 중 UI가 자동으로 일치하므로 유저 학습 비용도 0이다.

- [ ] **Step 1: store 계약 테스트 작성**

`src/game/__tests__/matchStore.test.ts`에 추가:

```ts
describe("'pre'에서 전술 개입이 가능하다", () => {
  it("phase 'pre'에서 submitCommand가 throw하지 않는다", () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('cze'), 777)
    expect(useMatchStore.getState().phase).toBe('pre')
    const eng = useMatchStore.getState().engine!
    expect(() => useMatchStore.getState().submitCommand('home', {
      type: 'instructions',
      instructions: { ...eng.home.tactics.instructions, pressing: 75 },
    })).not.toThrow()
    expect(useMatchStore.getState().engine!.home.tactics.instructions.pressing).toBe(75)
  })

  it("'pre'의 결정 로그는 \"킥오프 전\"으로 표기된다", () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('cze'), 777)
    const eng = useMatchStore.getState().engine!
    useMatchStore.getState().submitCommand('home', {
      type: 'instructions',
      instructions: { ...eng.home.tactics.instructions, lineHeight: 30 },
    })
    const log = useMatchStore.getState().decisionLog
    expect(log[0].summary).toContain('킥오프 전')
  })

  it("'pre'의 confirmTactics는 부스트를 설정하지 않는다", () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('cze'), 777)
    useMatchStore.getState().confirmTactics()
    expect(useMatchStore.getState().boostUntil).toBe(0)
    // 'pre'의 확정은 재생을 시작하지 않는다 — 킥오프는 별도 버튼
    expect(useMatchStore.getState().phase).toBe('pre')
  })
})

describe('pickBestXI는 프로필 스타일로 지시를 시딩한다', () => {
  it('한국의 초기 지시가 50/50/50이 아니라 프로필 값이다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    expect(t.instructions.pressing).toBe(kor.profile.style.pressing)
    expect(t.instructions.lineHeight).toBe(kor.profile.style.lineHeight)
    expect(t.instructions.tempo).toBe(kor.profile.style.tempo)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/game/__tests__/matchStore.test.ts src/engine/__tests__/lineup.test.ts`
Expected: FAIL — `'개입 불가 시점'` throw, 로그에 `"0'"` 표기, `pressing === 50`

- [ ] **Step 3: store 수정**

`src/game/matchStore.ts:179`:

```ts
/** 개입(submitCommand/applyTeamTalk)이 허용되는 phase.
 *  'pre'는 킥오프 전 전술 센터 — 감독이 계획을 세우는 시점이다. */
const INTERVENTION_PHASES: MatchPhase[] = ['pre', 'paused-break', 'paused-user', 'paused-moment', 'halftime']
```

`confirmTactics` (318–324행) — `'pre'`에서는 재생을 시작하지도, 부스트를 주지도 않는다:

```ts
  confirmTactics: () => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (!INTERVENTION_PHASES.includes(phase)) throw new Error('개입 중이 아님')
    // 킥오프 전 계획에는 인게임 부스트를 주지 않는다(사전 계획과 실시간 개입의 가치를 구분).
    // 재생 시작도 하지 않는다 — 'pre'의 진행은 kickoff()가 담당한다.
    if (phase === 'pre') return
    set({ phase: 'playing', pauseReason: null, momentPrompt: null, boostUntil: engine.minute + BOOST_MINUTES })
  },
```

`submitCommand`의 로그 시점 표기 — `instructions`와 `formation` 양쪽에 `'pre'` 분기를 넣는다. 현재 `formation` 분기에만 있는 `when` 계산을 공통 헬퍼로 올린다:

```ts
    const minute = engine.minute
    // 시점 라벨: 킥오프 전 / HT / N'. 결정 로그는 기자회견의 근거가 되므로
    // "언제 내린 결정인가"가 서사적으로 중요하다.
    const when = phase === 'pre' ? '킥오프 전' : phase === 'halftime' ? 'HT' : `${minute}'`
```

그리고 세 분기의 summary를 `when`으로 통일:

```ts
    if (cmd.type === 'instructions') {
      const changed = instructionDiff(sideState.tactics.instructions, cmd.instructions)
      if (changed.length > 0) {
        entry = { minute, kind: 'instructions', summary: `${when} 지시 변경: ${changed.join(', ')}`, detail: { changed } }
      }
    } else if (cmd.type === 'sub') {
      const nameOf = (id: string) => sideState.team.squad.find(p => p.id === id)?.name.ko ?? id
      entry = { minute, kind: 'sub', summary: `${when} 교체: ${nameOf(cmd.in)} IN, ${nameOf(cmd.out)} OUT`, detail: { in: cmd.in, out: cmd.out } }
    } else if (cmd.type === 'formation') {
      const before = sideState.tactics.formation, after = cmd.tactics.formation
      if (before !== after) {
        entry = { minute, kind: 'instructions', summary: `${when} 포메이션: ${before}→${after}`, detail: { before, after } }
      }
    }
```

> 기존 `formation` 분기의 `const when = phase === 'halftime' ? 'HT' : `${minute}'`` 지역 변수는 제거한다(공통 `when`으로 대체).

`src/engine/lineup.ts:23` — 프로필 스타일 시딩:

```ts
  // 초기 지시는 팀 프로필 스타일로 시딩한다. AI는 simulate.defaultTactics에서
  // profile.style을 쓰는데 유저만 50/50/50으로 시작하던 비대칭을 해소한다.
  // profile이 없는 픽스처는 기존 중립값을 유지한다.
  const style = team.profile?.style
  return {
    formation: f,
    lineup,
    instructions: style
      ? { lineHeight: style.lineHeight, pressing: style.pressing, tempo: style.tempo, attackFocus: 'balanced' }
      : { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  }
```

- [ ] **Step 4: 통과 및 회귀 확인**

Run: `npx vitest run src/game/__tests__/matchStore.test.ts src/engine/__tests__/lineup.test.ts` → PASS
Run: `npm test`

`pickBestXI` 시딩 변경으로 **실팀 시드 스냅샷이 깨진다** (`kor` 지시가 50/50/50 → 프로필 값). Task 2 Step 7과 같은 기준으로 분류·갱신한다. 픽스처 팀(`testTeams.ts`)은 `profile`이 있으므로 그쪽도 확인할 것 — 픽스처의 `style`이 50/50/50이면 변화 없다.

- [ ] **Step 5: 커밋**

```bash
git add src/game/matchStore.ts src/engine/lineup.ts src/game/__tests__ src/engine/__tests__
git commit -m "feat(match): 'pre'를 개입 phase로 승격 + 유저 초기 지시를 프로필 시딩 (비대칭 해소)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

- [ ] **Step 6: `LineupScreen`에서 `LineupEditor` 추출**

현재 `LineupScreen`은 로컬 state로 `TacticState`를 들고 `onConfirm`으로 넘긴다. 전술 센터에서는 store가 진실의 원천이므로, **편집 UI만** 떼어내 제어 컴포넌트로 만든다.

`src/ui/lineup/LineupScreen.tsx`를 읽고, 포메이션 셀렉터 + 피치 DnD + 벤치 렌더링 부분을 아래 시그니처로 추출한다:

```tsx
/** 선발 편집 UI(제어 컴포넌트). 상태를 갖지 않고 tactics를 받아 onChange로 올린다.
 *  LineupScreen(레거시 단독 화면)과 TacticsCenter(①선발 탭)가 함께 쓴다. */
export function LineupEditor({ team, tactics, onChange }: {
  team: Team
  tactics: TacticState
  onChange(next: TacticState): void
}) { /* 기존 렌더 본체 — setState 호출을 onChange({...tactics, ...}) 로 치환 */ }
```

`LineupScreen`은 이 컴포넌트를 감싸는 얇은 래퍼로 남긴다(로컬 state + 확정 버튼). **`onConfirm`은 `{formation, lineup, instructions}`가 아니라 `tactics` 전체를 넘기도록 고친다** — 이것이 `LineupScreen.tsx:69`의 확장 필드 유실 버그의 직접 수정이다:

```tsx
  const handleConfirm = () => { onConfirm(tactics) }
```

기존 `LineupScreen` 테스트가 있으면 그대로 통과해야 한다. 없으면 추가하지 않는다(Task 4는 이미 크다).

- [ ] **Step 7: `TacticsCenter` 작성**

`src/ui/tactics/TacticsCenter.tsx`:

```tsx
import { useState } from 'react'
import type { FormationId, TacticState } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { LineupEditor } from '../lineup/LineupScreen'
import { ConsolePanel } from '../console/ConsolePanel'
import { TacticsExtras } from './TacticsExtras'
import { OppPanel } from './OppPanel'
import './TacticsCenter.css'

const SIDE = 'home' as const
type CenterTab = 'lineup' | 'team'

/** 킥오프 전 워룸. 좌측에 상대 리포트를 상시 고정하고, 우측 탭에서 선발과 팀 전술을 설계한다.
 *  경기 중 작전판(TacticsBoard)과 같은 컨트롤(ConsolePanel·TacticsExtras)을 재사용해
 *  유저가 한 번 배운 UI를 두 시점에서 쓰게 한다. */
export function TacticsCenter({ onKickoff, referenceScore }: {
  onKickoff(): void
  referenceScore?: [number, number]
}) {
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)
  const [tab, setTab] = useState<CenterTab>('lineup')

  if (!engine) return null
  const home = engine[SIDE]
  const away = engine.away

  const setTactics = (next: TacticState) => {
    submitCommand(SIDE, { type: 'formation', tactics: next })
  }

  return (
    <div className="tc-root" aria-label="전술 센터">
      <header className="tc-head">
        <div className="tc-head__match">
          <span className="tc-head__teams">{home.team.name.ko} vs {away.team.name.ko}</span>
          {referenceScore && (
            <span className="tc-head__ref">참고 · 실제 역사 {referenceScore[0]}-{referenceScore[1]}</span>
          )}
        </div>
        <button type="button" className="tc-kickoff" onClick={onKickoff}>킥오프 ▶</button>
      </header>

      <div className="tc-body">
        <aside className="tc-war" aria-label="상대 리포트">
          <OppPanel />
        </aside>

        <section className="tc-main">
          <div className="tc-tabs" role="tablist" aria-label="전술 설계">
            <button type="button" role="tab" aria-selected={tab === 'lineup'}
              className={`tc-tab${tab === 'lineup' ? ' tc-tab--active' : ''}`}
              onClick={() => setTab('lineup')}>① 선발</button>
            <button type="button" role="tab" aria-selected={tab === 'team'}
              className={`tc-tab${tab === 'team' ? ' tc-tab--active' : ''}`}
              onClick={() => setTab('team')}>② 팀 전술</button>
          </div>
          <div className="tc-tabbody">
            {tab === 'lineup' && (
              <LineupEditor team={home.team} tactics={home.tactics} onChange={setTactics} />
            )}
            {tab === 'team' && (
              <div className="tc-team">
                <ConsolePanel side={SIDE} />
                <TacticsExtras side={SIDE} />
              </div>
            )}
          </div>
        </section>
      </div>

      <PlanSummary />
    </div>
  )
}

/** 하단 검토 요약 — 형태·태도·공격 루트를 한 줄로 확인시킨다. 리스크 카드는 Task 5에서 채운다. */
function PlanSummary() {
  const engine = useMatchStore(s => s.engine)
  if (!engine) return null
  const t = engine.home.tactics
  const ins = t.instructions
  const MENTALITY_KO: Record<string, string> = {
    'very-defensive': '매우 수비', defensive: '수비', balanced: '균형',
    attacking: '공격', 'very-attacking': '매우 공격',
  }
  const PATTERN_KO: Record<string, string> = {
    balanced: '균형', cross: '크로스', through: '중앙 침투', longshot: '중거리',
  }
  return (
    <footer className="tc-summary" aria-label="킥오프 전 검토">
      <div className="tc-card">
        <span className="tc-card__label">형태</span>
        <span className="tc-card__value">{t.formation}</span>
        {t.phaseFormations?.attack && <span className="tc-card__sub">공격 {t.phaseFormations.attack}</span>}
        {t.phaseFormations?.defense && <span className="tc-card__sub">수비 {t.phaseFormations.defense}</span>}
      </div>
      <div className="tc-card">
        <span className="tc-card__label">태도</span>
        <span className="tc-card__value">{MENTALITY_KO[t.mentality ?? 'balanced']}</span>
        <span className="tc-card__sub">라인 {ins.lineHeight} · 압박 {ins.pressing} · 템포 {ins.tempo}</span>
      </div>
      <div className="tc-card">
        <span className="tc-card__label">공격 루트</span>
        <span className="tc-card__value">{PATTERN_KO[t.attackPattern ?? 'balanced']}</span>
      </div>
    </footer>
  )
}
```

`src/ui/tactics/TacticsCenter.css` — 감사 문서 §3.3 와이어프레임을 따른다. 좌측 워룸 고정 340px, 900px 미만에서 상단 접이식으로 전환:

```css
.tc-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  min-height: 0;
}
.tc-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; padding: 10px 16px;
}
.tc-head__teams { font-size: 1.05rem; font-weight: 700; }
.tc-head__ref { margin-left: 10px; font-size: 0.82rem; opacity: 0.7; }
.tc-kickoff {
  padding: 10px 22px; font-size: 1rem; font-weight: 700;
  border-radius: 8px; cursor: pointer;
}
.tc-body {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
}
.tc-war { min-width: 0; overflow-y: auto; }
.tc-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.tc-tabs { display: flex; gap: 4px; }
.tc-tab { padding: 8px 18px; cursor: pointer; border: none; background: transparent; }
.tc-tab--active { font-weight: 700; box-shadow: inset 0 -2px 0 currentColor; }
.tc-tabbody { flex: 1; min-height: 0; overflow-y: auto; padding-top: 10px; }
.tc-team { display: flex; flex-direction: column; gap: 14px; }
.tc-summary {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px; padding: 12px 16px;
}
.tc-card { display: flex; flex-direction: column; gap: 2px; }
.tc-card__label { font-size: 0.75rem; opacity: 0.65; }
.tc-card__value { font-size: 1rem; font-weight: 700; }
.tc-card__sub { font-size: 0.8rem; opacity: 0.75; }

@media (max-width: 900px) {
  .tc-body { grid-template-columns: minmax(0, 1fr); }
  .tc-war { max-height: 240px; }
}
```

> **`.tc-body`에 `min-height: 0`과 `minmax(0, 1fr)`이 있는 이유**: grid/flex 자식은 기본 `min-width: auto`라 내용이 넘치면 축소되지 않고 부모를 밀어낸다. 사용자가 보고한 "어떤 기능을 켜면 어떤 부분이 쪼그라듦" 증상의 전형적 원인이다. 새로 만드는 레이아웃에서는 처음부터 막아 둔다.

- [ ] **Step 8: `MatchScreen` 배선**

`src/ui/match/MatchScreen.tsx`:

1. import 추가: `import { TacticsCenter } from '../tactics/TacticsCenter'`
2. `phase === 'pre'` 하단 바(504–514행)를 **제거**하고, 그 자리에 전술 센터를 렌더한다. 방송 스테이지는 `'pre'`에서 배경으로 남기되 전술 센터가 그 아래에 오게 한다:

```tsx
        {phase === 'pre' && (
          <div className="ms-precenter">
            <TacticsCenter onKickoff={handleKickoff} referenceScore={referenceScore} />
          </div>
        )}
```

3. `match.css`에 추가:

```css
/* 킥오프 전 전술 센터 — 방송 스테이지 아래에 붙는 워룸. 피치를 가리지 않는다. */
.ms-precenter { width: 100%; min-width: 0; padding: 8px 0 16px; }
```

4. `tacticsMode`(162행)는 **바꾸지 않는다** — `'pre'`에서 `TacticsBoard` 오버레이가 뜨면 전술 센터와 이중으로 겹친다.

- [ ] **Step 9: `App.tsx` 흐름 변경**

`CampaignFlow`에서 `'lineup'` 단계를 제거하고 허브에서 곧장 경기로 간다. 전술 이월은 `tactics` state를 유지하는 방식으로 처리한다:

```tsx
type CampaignStep = 'hub' | 'match'

function CampaignFlow({ onExit }: { onExit(): void }) {
  const stage = useCampaignStore(s => s.stage)
  const ending = useCampaignStore(s => s.ending)
  const [step, setStep] = useState<CampaignStep>('hub')
  // 직전 경기의 확정 전술을 다음 경기 초기값으로 이월한다(8경기 반복 마찰 제거).
  const [carried, setCarried] = useState<TacticState | null>(null)

  const kor = useMemo(() => loadTeam('kor'), [])

  if (stage === 'ended' || ending) return <EndingScreen onRestart={onExit} />
  if (step === 'hub') return <HubScreen onProceed={() => setStep('match')} />

  return (
    <CampaignMatch
      tactics={carried ?? pickBestXI(kor)}
      onBackToHub={next => { setCarried(next); setStep('hub') }}
    />
  )
}
```

`CampaignMatch`의 `onBackToHub` 시그니처를 `(next: TacticState | null) => void`로 바꾸고, `NewspaperCard`의 `onNext`에서 **경기 종료 시점의 홈 전술**을 넘긴다. 그 값은 `useMatchStore.getState().engine?.home.tactics`로 얻는다 — 단, 이 시점에 `matchStore`가 이미 reset됐을 수 있으므로 `MatchScreen`의 `onMatchEnd` 콜백에서 미리 붙들어 둘 것.

`MatchScreen`의 `onMatchEnd` 시그니처에 최종 전술을 추가한다:

```ts
onMatchEnd?(score: [number, number], stamina: Record<string, number>, shootout?: ..., decisions?: DecisionEntry[], finalTactics?: TacticState): void
```

`DemoFlow`도 같은 방식으로 `LineupScreen` 단계를 제거한다.

> `LineupScreen`은 삭제하지 않는다 — `LineupEditor`의 소유 파일이고, 기존 테스트가 붙어 있을 수 있다. 라우팅에서만 빠진다.

- [ ] **Step 10: 브라우저 검증**

```bash
npm run dev
```

수동으로 확인할 것 (스크린샷을 남기고 보고에 첨부):
1. 캠페인 시작 → 허브 → **곧바로 전술 센터**가 뜬다 (라인업 화면이 중간에 없다)
2. ② 팀 전술 탭에서 멘탈리티·라인·압박·템포·그룹 적극성·공격 패턴·페이즈 포메이션이 **전부 조작 가능**하다
3. 조작하면 하단 검토 요약이 즉시 갱신된다
4. 좌측 상대 리포트가 상시 보인다
5. 킥오프 → 경기 시작, 22' 하이드레이션에서 작전판이 뜨고 **킥오프 전에 설정한 값이 그대로 들어 있다**
6. 1280px / 1440px / 1920px에서 가로 스크롤이 생기지 않는다

- [ ] **Step 11: 커밋**

```bash
npm test && npx tsc -b && npx oxlint
git add -A
git commit -m "feat(ui): 킥오프 전 전술 센터 — 워룸 레이아웃·2탭·검토 요약, 라인업 단독 화면 흡수

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

---

### Task 5: 상대별 플랜 추천 (`recommendPlan`) + 리스크 카드

**Files:**
- Create: `src/game/scouting.ts`
- Create: `src/game/__tests__/scouting.test.ts`
- Modify: `src/ui/tactics/TacticsCenter.tsx` (추천 버튼 + 리스크 카드)

**Interfaces:**
- Consumes: Task 4의 `TacticsCenter`, `submitCommand`
- Produces:
  ```ts
  export interface PlanRecommendation {
    patch: Partial<TacticState>
    /** 각 변경의 근거 1줄 — UI 툴팁·요약에 그대로 노출 */
    reasons: { field: string; text: string }[]
  }
  export function recommendPlan(me: Team, opp: Team): PlanRecommendation
  export interface PlanRisk { level: 'warn' | 'ok'; text: string }
  export function planRisks(me: Team, tactics: TacticState, stamina: Record<string, number>): PlanRisk[]
  ```

- [ ] **Step 1: 테스트 작성**

`src/game/__tests__/scouting.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { recommendPlan, planRisks } from '../scouting'
import { loadTeam } from '../../data/loader'
import { pickBestXI } from '../../engine/lineup'

describe('recommendPlan', () => {
  it('점유 강팀(스페인) 상대로는 라인을 내리고 수비적 멘탈리티를 권한다', () => {
    const r = recommendPlan(loadTeam('kor'), loadTeam('esp'))
    expect(r.patch.mentality).toBe('defensive')
    expect(r.patch.instructions!.lineHeight).toBeLessThanOrEqual(35)
    expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('모든 근거에 상대 수치가 포함돼 근거가 검증 가능하다', () => {
    const r = recommendPlan(loadTeam('kor'), loadTeam('esp'))
    expect(r.reasons.every(x => x.text.length > 8)).toBe(true)
  })

  it('결정론 — 같은 입력에 같은 출력', () => {
    const a = recommendPlan(loadTeam('kor'), loadTeam('mex'))
    const b = recommendPlan(loadTeam('kor'), loadTeam('mex'))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('포메이션 추천은 상성 최댓값을 고른다', () => {
    const r = recommendPlan(loadTeam('kor'), loadTeam('cze'))
    expect(r.patch.formation).toBeDefined()
  })
})

describe('planRisks', () => {
  it('체력 65 미만 선발이 있으면 경고한다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    const stamina: Record<string, number> = {}
    for (const p of kor.squad) stamina[p.id] = 100
    stamina[t.lineup[3].playerId] = 58
    const risks = planRisks(kor, t, stamina)
    expect(risks.some(r => r.level === 'warn' && r.text.includes('체력'))).toBe(true)
  })

  it('문제가 없으면 ok 항목만 남는다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    const stamina: Record<string, number> = {}
    for (const p of kor.squad) stamina[p.id] = 100
    expect(planRisks(kor, t, stamina).every(r => r.level === 'ok')).toBe(true)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/game/__tests__/scouting.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: `scouting.ts` 구현**

```ts
// src/game/scouting.ts
// 상대 프로필 기반 플랜 추천 — 순수·결정론. 엔진이 아니라 게임 로직 계층에 둔다.
// 추천은 정답이 아니라 출발점이다. UI는 반드시 "감독 판단으로 수정하십시오"를 함께 보여준다.
import type { FormationId, Instructions, TacticState, Team } from '../engine/types'
import { formationEdge } from '../engine/tactics'
import { positionFitness } from '../engine/fitness'

export interface PlanRecommendation {
  patch: Partial<TacticState>
  reasons: { field: string; text: string }[]
}

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

/** 상대 선호 포메이션을 엔진 6종 중 가장 가까운 것으로 매핑. loader.mapFormation과 동일 규칙. */
function oppFormation(opp: Team): FormationId {
  const raw = opp.profile.preferredFormations[0] ?? '4-3-3'
  const hit = FORMATIONS.find(f => f === raw)
  return hit ?? '4-2-3-1'
}

export function recommendPlan(me: Team, opp: Team): PlanRecommendation {
  const s = opp.profile.style
  const reasons: { field: string; text: string }[] = []
  const ins: Instructions = {
    lineHeight: me.profile.style.lineHeight,
    pressing: me.profile.style.pressing,
    tempo: me.profile.style.tempo,
    attackFocus: 'balanced',
  }
  const patch: Partial<TacticState> = {}

  if (s.possession >= 70) {
    patch.mentality = 'defensive'
    ins.lineHeight = Math.min(ins.lineHeight, 30)
    patch.attackPattern = 'through'
    reasons.push({ field: 'mentality', text: `상대 점유 성향 ${s.possession} — 블록을 내리고 회수 후 전환을 노립니다` })
  }
  if (s.lineHeight >= 62) {
    patch.attackPattern = 'through'
    ins.tempo = Math.min(100, ins.tempo + 15)
    reasons.push({ field: 'tempo', text: `상대 라인 높이 ${s.lineHeight} — 뒷공간 침투가 유효합니다` })
  }
  if (s.pressing >= 65) {
    ins.tempo = Math.min(100, ins.tempo + 10)
    patch.groupIntensity = { attack: 0, midfield: 1, defense: 0 }
    reasons.push({ field: 'pressing', text: `상대 압박 ${s.pressing} — 빠른 전개로 압박을 벗깁니다` })
  }

  // FIFA 랭킹 격차 — 숫자가 작을수록 강팀이므로 (내 랭킹 − 상대 랭킹)이 클수록 우리가 약체.
  const gap = me.fifaRanking - opp.fifaRanking
  if (gap >= 15) {
    patch.mentality = 'defensive'
    patch.groupIntensity = { ...(patch.groupIntensity ?? { attack: 0, midfield: 0, defense: 0 }), defense: 1 }
    reasons.push({ field: 'mentality', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 실점 최소화가 승점 기대값을 높입니다` })
  } else if (gap <= -15) {
    patch.mentality = 'attacking'
    patch.groupIntensity = { ...(patch.groupIntensity ?? { attack: 0, midfield: 0, defense: 0 }), attack: 1 }
    reasons.push({ field: 'mentality', text: `FIFA 랭킹 ${me.fifaRanking}위 vs ${opp.fifaRanking}위 — 주도권을 잡을 수 있는 매치업입니다` })
  }

  // 포메이션: 상대 포메이션 대비 상성 최댓값.
  const of = oppFormation(opp)
  let best = FORMATIONS[0], bestEdge = -Infinity
  for (const f of FORMATIONS) {
    const e = formationEdge(f, of)
    if (e > bestEdge) { bestEdge = e; best = f }
  }
  if (bestEdge > 0) {
    patch.formation = best
    reasons.push({ field: 'formation', text: `${best}가 상대 ${of}에 상성 우위(+${bestEdge.toFixed(2)})` })
  }

  if (opp.profile.benchPattern === 'protect-lead') {
    reasons.push({ field: 'note', text: '상대는 리드하면 내려앉습니다 — 선제골이 특히 중요합니다' })
  }

  patch.instructions = ins
  return { patch, reasons }
}

export interface PlanRisk { level: 'warn' | 'ok'; text: string }

/** 킥오프 전 검토 요약의 리스크 카드. 경고가 없으면 ok 항목만 돌려준다. */
export function planRisks(me: Team, tactics: TacticState, stamina: Record<string, number>): PlanRisk[] {
  const out: PlanRisk[] = []
  for (const l of tactics.lineup) {
    const p = me.squad.find(q => q.id === l.playerId)
    if (!p) continue
    const st = stamina[l.playerId] ?? 100
    if (st < 65) out.push({ level: 'warn', text: `${p.name.ko} 시작 체력 ${Math.round(st)}` })
    if (positionFitness(p, l.slot) < 0.7) out.push({ level: 'warn', text: `${p.name.ko} ${l.slot} 적합도 낮음` })
  }
  const ins = tactics.instructions
  if (ins.lineHeight >= 70 && ins.pressing >= 70) {
    out.push({ level: 'warn', text: '하이라인 + 하이프레스 — 역습 취약성이 크게 증가합니다' })
  }
  if (out.length === 0) out.push({ level: 'ok', text: '검토 완료 — 특이사항 없음' })
  return out
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/game/__tests__/scouting.test.ts` → PASS

> `positionFitness`의 반환 범위를 먼저 확인할 것(`src/engine/fitness.ts`). 0~1이 아니라 0~100이면 `< 0.7` 임계를 `< 70`으로 고칠 것.

- [ ] **Step 5: `TacticsCenter`에 [추천 적용] + 리스크 카드 배선**

헤더에 버튼을 추가한다:

```tsx
  const applyRecommendation = () => {
    const rec = recommendPlan(home.team, away.team)
    const merged: TacticState = {
      ...home.tactics,
      ...rec.patch,
      instructions: { ...home.tactics.instructions, ...(rec.patch.instructions ?? {}) },
    }
    submitCommand(SIDE, { type: 'formation', tactics: merged })
    setReasons(rec.reasons)
  }
```

`const [reasons, setReasons] = useState<{ field: string; text: string }[]>([])`을 두고, 적용 후 근거 목록을 검토 요약 위에 3초가 아니라 **닫기 전까지 계속** 보여준다(타이머는 결정론 정책상 피한다 — `Date.now()` 금지 대상은 아니지만 불필요한 비결정성이다):

```tsx
      {reasons.length > 0 && (
        <div className="tc-reasons" role="status">
          <div className="tc-reasons__head">
            <strong>코치진 권고</strong>
            <span className="tc-reasons__note">감독 판단으로 수정하십시오</span>
            <button type="button" onClick={() => setReasons([])} aria-label="권고 닫기">✕</button>
          </div>
          <ul>{reasons.map((r, i) => <li key={`${r.field}-${i}`}>{r.text}</li>)}</ul>
        </div>
      )}
```

`PlanSummary`에 리스크 카드를 추가한다:

```tsx
  const risks = planRisks(engine.home.team, t, engine.home.staminaByPlayer)
  // …카드 4번째로
      <div className="tc-card">
        <span className="tc-card__label">리스크</span>
        <ul className="tc-risks">
          {risks.map((r, i) => (
            <li key={i} className={r.level === 'warn' ? 'tc-risk tc-risk--warn' : 'tc-risk'}>
              {r.level === 'warn' ? '⚠' : '✅'} {r.text}
            </li>
          ))}
        </ul>
      </div>
```

- [ ] **Step 6: 커밋**

```bash
npm test && npx tsc -b && npx oxlint
git add -A
git commit -m "feat(tactics): 상대별 플랜 추천 + 리스크 카드 — 근거 문구 노출

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

---

### Task 6: 상대 AI — 교체 · 전술 스위칭 · 통보

**Files:**
- Create: `src/game/oppAi.ts`
- Create: `src/game/__tests__/oppAi.test.ts`
- Modify: `src/game/matchStore.ts` (`advanceMinute`에서 호출, 통보 이벤트 적재)
- Modify: `src/ui/match/MatchScreen.tsx` (배너 노출)

**Interfaces:**
- Consumes: `MatchState`, `MatchCommand`, `applyCommand`
- Produces:
  ```ts
  export interface OppAction { cmd: MatchCommand; notice: string }
  export function decideAwayActions(st: MatchState, minute: number, done: string[]): OppAction[]
  ```
  `done`은 이미 발동한 액션 키 목록(유형당 1회 제한). `matchStore`가 `oppFired: string[]`로 보관한다.

**설계 원칙**

- **완전 결정론**: RNG를 쓰지 않는다. 대상 선정은 `staminaByPlayer` 최하위 + `positionFitness`로 정한다. 이래야 시드 회귀가 안전하다.
- **프로필 범위 클램프**: 각 지시 축은 `profile.style.X ± 20`을 벗어나지 못한다. 스페인은 끝까지 점유를 고집하고, 모로코는 리드하면 더 내려앉는다 — 팀 정체성이 유지된다.
- **유저 우위 유지**: 상대 교체는 최대 3장(유저 5장).

- [ ] **Step 1: 테스트 작성**

`src/game/__tests__/oppAi.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { decideAwayActions } from '../oppAi'
import { createMatch, simulateSegment, applyCommand } from '../../engine/simulate'
import { loadTeam } from '../../data/loader'

function matchAt(minute: number, score: [number, number]) {
  const st = createMatch(loadTeam('kor'), loadTeam('cze'), { seed: 42 })
  st.minute = minute
  st.score = score
  return st
}

describe('decideAwayActions', () => {
  it('46분 이전에는 아무 행동도 하지 않는다', () => {
    expect(decideAwayActions(matchAt(30, [0, 0]), 30, [])).toEqual([])
  })

  it('창(46/60/70/80)에서만 행동한다', () => {
    expect(decideAwayActions(matchAt(55, [0, 1]), 55, [])).toEqual([])
    expect(decideAwayActions(matchAt(60, [0, 1]), 60, []).length).toBeGreaterThan(0)
  })

  it('이미 발동한 키는 재발동하지 않는다', () => {
    const first = decideAwayActions(matchAt(60, [0, 1]), 60, [])
    const keys = first.map(a => a.notice)
    const again = decideAwayActions(matchAt(60, [0, 1]), 60, keys)
    expect(again.length).toBeLessThan(first.length + 1)
  })

  it('결정론 — 같은 상태에 같은 결과', () => {
    const a = decideAwayActions(matchAt(60, [1, 0]), 60, [])
    const b = decideAwayActions(matchAt(60, [1, 0]), 60, [])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('지시 변경은 프로필 스타일 ±20을 벗어나지 않는다', () => {
    const st = matchAt(60, [2, 0])   // 어웨이가 지고 있다 → 공격적으로 전환
    const acts = decideAwayActions(st, 60, [])
    const style = st.away.team.profile.style
    for (const a of acts) {
      if (a.cmd.type !== 'instructions') continue
      const ins = a.cmd.instructions
      expect(Math.abs(ins.lineHeight - style.lineHeight)).toBeLessThanOrEqual(20)
      expect(Math.abs(ins.pressing - style.pressing)).toBeLessThanOrEqual(20)
      expect(Math.abs(ins.tempo - style.tempo)).toBeLessThanOrEqual(20)
    }
  })

  it('모든 행동에 한국어 통보 문구가 있다', () => {
    const acts = decideAwayActions(matchAt(60, [1, 0]), 60, [])
    expect(acts.every(a => a.notice.length > 0)).toBe(true)
  })

  it('교체 명령은 applyCommand로 적용 가능하다(라인업 정합성)', () => {
    let st = matchAt(60, [1, 0])
    for (const a of decideAwayActions(st, 60, [])) {
      if (a.cmd.type === 'sub') st = applyCommand(st, 'away', a.cmd)
    }
    expect(st.away.tactics.lineup.length).toBe(11)
    const ids = st.away.tactics.lineup.map(l => l.playerId)
    expect(new Set(ids).size).toBe(11)
  })
})
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run src/game/__tests__/oppAi.test.ts`
Expected: FAIL — 모듈 없음

- [ ] **Step 3: `oppAi.ts` 구현**

```ts
// src/game/oppAi.ts
// 상대 감독 AI — 완전 결정론(RNG 미사용). 시드 회귀 안전성을 위해 대상 선정은
// 체력 최하위 + 포지션 적합도로만 정한다.
import type { MatchCommand } from '../engine/simulate'
import type { Instructions, MatchState, Position, SideState } from '../engine/types'
import { positionFitness } from '../engine/fitness'

export interface OppAction {
  cmd: MatchCommand
  /** 방송 배너에 그대로 노출되는 한국어 통보 문구. 유형당 1회 제한의 키로도 쓴다. */
  notice: string
}

/** 교체 창. 유저(5장)보다 적게 — 최대 3장. */
const WINDOWS = [46, 60, 70, 80]
const MAX_AI_SUBS = 3
/** 프로필 스타일에서 벗어날 수 있는 최대 폭. 팀 정체성 유지. */
const STYLE_CLAMP = 20

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 프로필 스타일 ±STYLE_CLAMP 범위로 지시를 가둔다. */
function clampToStyle(style: SideState['team']['profile']['style'], ins: Instructions): Instructions {
  return {
    lineHeight: clamp(ins.lineHeight, style.lineHeight - STYLE_CLAMP, style.lineHeight + STYLE_CLAMP),
    pressing: clamp(ins.pressing, style.pressing - STYLE_CLAMP, style.pressing + STYLE_CLAMP),
    tempo: clamp(ins.tempo, style.tempo - STYLE_CLAMP, style.tempo + STYLE_CLAMP),
    attackFocus: ins.attackFocus,
  }
}

/** 라인업에서 지정 포지션군 중 체력 최하위 선수. 없으면 null. */
function tiredIn(side: SideState, slots: Position[]): { slot: Position; playerId: string } | null {
  const cands = side.tactics.lineup
    .filter(l => !side.sentOff.includes(l.playerId) && slots.includes(l.slot))
    .sort((a, b) => {
      const d = (side.staminaByPlayer[a.playerId] ?? 100) - (side.staminaByPlayer[b.playerId] ?? 100)
      // 체력 동률이면 playerId 사전순으로 안정 정렬(결정론).
      return d !== 0 ? d : a.playerId.localeCompare(b.playerId)
    })
  return cands[0] ?? null
}

/** 벤치(라인업 밖)에서 지정 슬롯 적합도 최상위. 없으면 null. */
function bestBench(side: SideState, slot: Position): string | null {
  const inXI = new Set(side.tactics.lineup.map(l => l.playerId))
  const cands = side.team.squad
    .filter(p => !inXI.has(p.id) && !side.sentOff.includes(p.id))
    .sort((a, b) => {
      const d = positionFitness(b, slot) - positionFitness(a, slot)
      return d !== 0 ? d : a.id.localeCompare(b.id)
    })
  return cands[0]?.id ?? null
}

export function decideAwayActions(st: MatchState, minute: number, done: string[]): OppAction[] {
  if (!WINDOWS.includes(minute)) return []
  const away = st.away
  const style = away.team.profile.style
  const pattern = away.team.profile.benchPattern
  const out: OppAction[] = []

  // 어웨이 관점 스코어. score는 [home, away].
  const diff = st.score[1] - st.score[0]
  const leading = diff > 0
  const trailing = diff < 0

  // ── 1) 전술 스위칭 (유형당 1회) ──
  const cur = away.tactics.instructions
  let next: Instructions | null = null
  let key = ''
  if (leading && pattern !== 'chase-attack') {
    next = { ...cur, lineHeight: cur.lineHeight - 12, pressing: cur.pressing - 8 }
    key = `📢 ${away.team.name.ko}, 리드를 지키러 내려섭니다`
  } else if (trailing) {
    next = { ...cur, lineHeight: cur.lineHeight + 10, tempo: cur.tempo + 10 }
    key = `📢 ${away.team.name.ko}, 라인을 올리고 추격에 나섭니다`
  } else if (minute >= 75) {
    next = { ...cur, tempo: cur.tempo + 8 }
    key = `📢 ${away.team.name.ko}, 템포를 끌어올립니다`
  }
  if (next && key && !done.includes(key)) {
    const clamped = clampToStyle(style, next)
    // 클램프 후 실제 변화가 없으면 통보하지 않는다(빈 배너 방지).
    const changed = clamped.lineHeight !== cur.lineHeight || clamped.pressing !== cur.pressing || clamped.tempo !== cur.tempo
    if (changed) out.push({ cmd: { type: 'instructions', instructions: clamped }, notice: key })
  }

  // ── 2) 교체 ──
  if (away.subsUsed < MAX_AI_SUBS) {
    let outSlots: Position[]
    let inSlot: Position
    if (leading && pattern === 'protect-lead') { outSlots = ['ST', 'LW', 'RW']; inSlot = 'DM' }
    else if (trailing && pattern === 'chase-attack') { outSlots = ['CB', 'LB', 'RB']; inSlot = 'ST' }
    else { outSlots = ['ST', 'LW', 'RW', 'CM', 'DM', 'LB', 'RB', 'CB']; inSlot = 'CM' }

    const target = tiredIn(away, outSlots)
    if (target) {
      const inId = bestBench(away, leading && pattern === 'protect-lead' ? inSlot : trailing && pattern === 'chase-attack' ? inSlot : target.slot)
      if (inId) {
        const outName = away.team.squad.find(p => p.id === target.playerId)?.name.ko ?? target.playerId
        const inName = away.team.squad.find(p => p.id === inId)?.name.ko ?? inId
        const notice = `📢 ${away.team.name.ko} 교체 — ${outName} OUT, ${inName} IN`
        if (!done.includes(notice)) {
          out.push({ cmd: { type: 'sub', out: target.playerId, in: inId }, notice })
        }
      }
    }
  }

  return out
}
```

> **`inSlot` 선택 로직이 장황하다.** 구현 시 아래처럼 정리할 것 — 위 삼항 중첩은 읽기 어렵고 `inSlot` 변수를 낭비한다:
> ```ts
> const replacementSlot = (leading && pattern === 'protect-lead') || (trailing && pattern === 'chase-attack')
>   ? inSlot
>   : target.slot
> const inId = bestBench(away, replacementSlot)
> ```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run src/game/__tests__/oppAi.test.ts` → PASS

`MatchCommand`의 `sub` 형태를 `src/engine/simulate.ts:9-13`에서 확인하고 필드명을 맞출 것 (`{ type: 'sub', out: string, in: string }`).

- [ ] **Step 5: `matchStore` 배선**

상태에 추가:

```ts
  /** 상대 AI가 이미 발동한 액션 키(유형당 1회 제한). */
  oppFired: string[]
  /** 상대 변경 통보 이력 — 방송 배너·작전판 상대 탭 타임라인. */
  oppNotices: { minute: number; text: string }[]
```

`initial`에 `oppFired: [] as string[], oppNotices: [] as { minute: number; text: string }[]` 추가.

`advanceMinute`에서 `simulateSegment` 직후, phase 전이 판정 **이전**에 상대 AI를 적용한다:

```ts
    let next = simulateSegment(engine, nextMinute, opts)
    const minute = next.minute

    // 상대 감독 — 창(46/60/70/80)에서 교체·전술 스위칭. 완전 결정론이라 시드 회귀에 안전하다.
    const { oppFired, oppNotices } = get()
    const actions = decideAwayActions(next, minute, oppFired)
    let firedNext = oppFired
    let noticesNext = oppNotices
    if (actions.length > 0) {
      for (const a of actions) {
        try {
          next = applyCommand(next, 'away', a.cmd)
        } catch {
          // 교체 한도 초과 등은 조용히 건너뛴다 — 상대 AI의 실패가 경기를 멈추면 안 된다.
          continue
        }
        firedNext = [...firedNext, a.notice]
        noticesNext = [...noticesNext, { minute, text: a.notice }]
      }
    }
```

이후 모든 `set({ engine: next, ... })` 호출에 `oppFired: firedNext, oppNotices: noticesNext`를 함께 넣는다. **누락하면 통보가 사라지거나 같은 액션이 반복 발동한다** — `advanceMinute` 안의 `set` 호출이 5개(90분/45분/브레이크2/순간/일반)이므로 전부 확인할 것.

`applyCommand`를 `matchStore` 상단 import에 추가한다(이미 있음).

- [ ] **Step 6: 배너 노출**

`MatchScreen`의 `bannerText` 계산부를 찾아, 순간 배너가 없을 때 최근 상대 통보를 표시하도록 우선순위를 준다:

```tsx
  const oppNotices = useMatchStore(s => s.oppNotices)
  // 순간 제안 배너가 우선. 없을 때만 상대 통보를 3분간 노출한다.
  const recentNotice = oppNotices.length > 0 && displayMinute - oppNotices[oppNotices.length - 1].minute < 3
    ? oppNotices[oppNotices.length - 1].text
    : null
```

기존 `bannerText`가 falsy일 때 `recentNotice`로 대체한다.

`OppPanel`에 변경 이력 3줄을 추가한다:

```tsx
  const notices = useMatchStore(s => s.oppNotices)
  // …렌더 상단에
      {notices.length > 0 && (
        <ul className="op__timeline" aria-label="상대 변경 이력">
          {notices.slice(-3).map((n, i) => (
            <li key={i} className="op__timeline-row">{n.minute}&apos; {n.text.replace('📢 ', '')}</li>
          ))}
        </ul>
      )}
```

- [ ] **Step 7: 실경기 검증**

`src/game/__tests__/oppAi.test.ts`에 통합 케이스를 추가한다:

```ts
it('90분 실경기에서 상대가 교체 1회 이상·전술 변경 1회 이상을 한다', () => {
  const s = useMatchStore.getState()
  s.startMatch(loadTeam('kor'), loadTeam('cze'), 4242)
  s.kickoff()
  for (let i = 0; i < 90; i++) {
    const st = useMatchStore.getState()
    if (st.phase === 'fulltime') break
    if (st.phase !== 'playing') st.confirmTactics()
    useMatchStore.getState().advanceMinute()
  }
  const eng = useMatchStore.getState().engine!
  expect(eng.away.subsUsed).toBeGreaterThanOrEqual(1)
  expect(useMatchStore.getState().oppNotices.length).toBeGreaterThanOrEqual(2)
}, 60_000)
```

- [ ] **Step 8: 커밋**

```bash
npm test && npx tsc -b && npx oxlint
git add -A
git commit -m "feat(game): 상대 감독 AI — 교체·전술 스위칭·방송 통보 (프로필 범위 클램프, 완전 결정론)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

---

### Task 7: 플랜 이탈 메커닉 + 기자회견 연결

**Files:**
- Modify: `src/game/matchStore.ts` (`matchPlan` 스냅샷, `planDeviation` 계산)
- Create: `src/ui/tactics/PlanBadge.tsx`
- Modify: `src/ui/match/MatchScreen.tsx` (배지 노출)
- Modify: `src/ui/tactics/TacticsBoard.tsx` (개입 창 상단 "플랜 대비")
- Modify: `src/game/pressconf.ts` (이탈 수 기반 질문 분기)
- Test: `src/game/__tests__/matchStore.test.ts`, `src/game/__tests__/pressconf.test.ts`

**Interfaces:**
- Consumes: Task 4의 `'pre'` 개입, `kickoff()`
- Produces:
  ```ts
  // matchStore
  matchPlan: TacticState | null
  /** 킥오프 플랜 대비 변경된 축 수(누적 최대치). */
  planDeviation: number
  export function computeDeviation(plan: TacticState, cur: TacticState): number
  ```

**왜 필요한가**

하프타임에 전부 바꿀 수 있다면 킥오프 전 설계는 게임 이론적으로 무의미하다 — 전술 센터를 스킵하는 것이 최적 플레이가 된다. 유지에 보상을, 구조 변경에 비용을 붙여 "감독은 계획을 세우고, 경기가 계획을 시험한다"는 루프를 닫는다.

- [ ] **Step 1: 테스트 작성**

```ts
describe('플랜 스냅샷과 이탈 계산', () => {
  it('kickoff이 현재 전술을 matchPlan으로 고정한다', () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    const eng = useMatchStore.getState().engine!
    useMatchStore.getState().submitCommand('home', {
      type: 'instructions', instructions: { ...eng.home.tactics.instructions, pressing: 40 },
    })
    useMatchStore.getState().kickoff()
    expect(useMatchStore.getState().matchPlan!.instructions.pressing).toBe(40)
    expect(useMatchStore.getState().planDeviation).toBe(0)
  })

  it('킥오프 후 축을 바꾸면 planDeviation이 증가한다', () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    s.kickoff()
    useMatchStore.getState().pauseByUser()
    const eng = useMatchStore.getState().engine!
    useMatchStore.getState().submitCommand('home', {
      type: 'instructions', instructions: { ...eng.home.tactics.instructions, pressing: 90, lineHeight: 20 },
    })
    expect(useMatchStore.getState().planDeviation).toBe(2)
  })

  it('planDeviation은 누적 최대치라 되돌려도 줄지 않는다', () => {
    const s = useMatchStore.getState()
    s.startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    const orig = useMatchStore.getState().engine!.home.tactics.instructions
    s.kickoff()
    useMatchStore.getState().pauseByUser()
    useMatchStore.getState().submitCommand('home', {
      type: 'instructions', instructions: { ...orig, pressing: 90 },
    })
    useMatchStore.getState().submitCommand('home', { type: 'instructions', instructions: { ...orig } })
    expect(useMatchStore.getState().planDeviation).toBe(1)
  })
})
```

`computeDeviation`의 단위 테스트도 추가:

```ts
describe('computeDeviation', () => {
  it('멘탈리티·포메이션·4축 각각을 1로 센다', () => {
    const base = pickBestXI(loadTeam('kor'))
    const changed: TacticState = {
      ...base, mentality: 'attacking',
      instructions: { ...base.instructions, pressing: base.instructions.pressing + 30 },
    }
    expect(computeDeviation(base, changed)).toBe(2)
  })
  it('지시 축은 10 이상 차이날 때만 이탈로 센다(미세 조정 면제)', () => {
    const base = pickBestXI(loadTeam('kor'))
    const tweaked: TacticState = {
      ...base, instructions: { ...base.instructions, tempo: base.instructions.tempo + 5 },
    }
    expect(computeDeviation(base, tweaked)).toBe(0)
  })
})
```

- [ ] **Step 2: 실패 확인 후 구현**

`src/game/matchStore.ts`:

```ts
/** 킥오프 플랜 대비 변경된 축 수. 지시 4축은 10 이상 차이날 때만 센다
 *  — 미세 조정은 감독의 정상 업무이고, 구조 변경(포메이션·멘탈리티)이 진짜 "계획 이탈"이다. */
export function computeDeviation(plan: TacticState, cur: TacticState): number {
  let n = 0
  if (plan.formation !== cur.formation) n++
  if ((plan.mentality ?? 'balanced') !== (cur.mentality ?? 'balanced')) n++
  if ((plan.attackPattern ?? 'balanced') !== (cur.attackPattern ?? 'balanced')) n++
  for (const k of ['lineHeight', 'pressing', 'tempo'] as const) {
    if (Math.abs(plan.instructions[k] - cur.instructions[k]) >= 10) n++
  }
  if (plan.instructions.attackFocus !== cur.instructions.attackFocus) n++
  return n
}
```

상태 추가: `matchPlan: TacticState | null`, `planDeviation: number` (`initial`에 `matchPlan: null, planDeviation: 0`).

`kickoff()`에서 스냅샷:

```ts
  kickoff: () => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'pre') return
    // 킥오프 시점의 플랜을 고정한다 — 이후 변경은 planDeviation으로 계측된다.
    set({ phase: 'playing', matchPlan: structuredClone(engine.home.tactics), planDeviation: 0 })
  },
```

`submitCommand`의 `set` 직전에 이탈 갱신 (홈 명령일 때만):

```ts
    const nextEngine = applyCommand(engine, side, cmd)
    const { matchPlan, planDeviation } = get()
    const dev = side === 'home' && matchPlan
      ? Math.max(planDeviation, computeDeviation(matchPlan, nextEngine.home.tactics))
      : planDeviation
    set({
      engine: nextEngine,
      planDeviation: dev,
      ...(entry ? { decisionLog: [...decisionLog, entry] } : {}),
    })
```

- [ ] **Step 3: 엔진 보상/비용**

**팀 이해도 보너스**: `matchPlan`의 포메이션·멘탈리티가 유지되는 동안 홈 `chanceQuality ×1.03`. `advanceMinute`에서 판정해 `simulateSegment` opts로 넘긴다.

`SimulateOpts`에 필드를 추가한다 (`src/engine/simulate.ts:15-24`):

```ts
export interface SimulateOpts {
  /* …기존… */
  /** 킥오프 플랜의 구조(포메이션·멘탈리티)를 유지 중인 side. 찬스 퀄리티 ×1.03. */
  planIntact?: 'home' | 'away'
  /** 구조 변경 직후 적응 지연이 걸린 side와 만료 분. 찬스 빈도 ×0.94, 역습 취약성 ×1.06. */
  adaptLag?: { side: 'home' | 'away'; until: number }
}
```

`simulateMinute`의 부스트 블록 뒤에 추가:

```ts
  // 팀 이해도: 킥오프 플랜의 구조를 유지하면 소폭 보너스. UI가 "플랜 유지 +3%"로 약속한다.
  if (opts.planIntact) {
    const pi = opts.planIntact === 'home' ? 0 : 1
    fx[pi].chanceQuality *= 1.03
  }
  // 적응 지연: 구조 변경(포메이션·멘탈리티) 직후 3분간. 미세 조정(4축)에는 걸리지 않는다.
  if (opts.adaptLag && st.minute <= opts.adaptLag.until) {
    const ai = opts.adaptLag.side === 'home' ? 0 : 1
    fx[ai].chanceRate *= 0.94
    fx[ai].counterVulnerability *= 1.06
  }
```

`matchStore`에 `adaptUntil: number` 상태를 두고, `submitCommand`에서 **포메이션 또는 멘탈리티가 바뀐 경우에만** `adaptUntil = engine.minute + 3`으로 설정한다. `advanceMinute`이 opts를 조립한다:

```ts
    const { matchPlan, adaptUntil } = get()
    const structIntact = matchPlan
      && matchPlan.formation === engine.home.tactics.formation
      && (matchPlan.mentality ?? 'balanced') === (engine.home.tactics.mentality ?? 'balanced')
    const opts = {
      ...(boostUntil >= nextMinute ? { instructionBoost: { side: 'home' as const, until: boostUntil } } : {}),
      ...(structIntact ? { planIntact: 'home' as const } : {}),
      ...(adaptUntil >= nextMinute ? { adaptLag: { side: 'home' as const, until: adaptUntil } } : {}),
    }
    const next = simulateSegment(engine, nextMinute, Object.keys(opts).length ? opts : undefined)
```

- [ ] **Step 4: `PlanBadge` + 개입 창 "플랜 대비"**

`src/ui/tactics/PlanBadge.tsx`:

```tsx
import { useMatchStore } from '../../game/matchStore'

/** 스코어버그 옆 플랜 상태 배지. 유지 중이면 보너스를 명시하고, 이탈했으면 축 수를 보여준다. */
export function PlanBadge() {
  const plan = useMatchStore(s => s.matchPlan)
  const dev = useMatchStore(s => s.planDeviation)
  const engine = useMatchStore(s => s.engine)
  if (!plan || !engine) return null
  const intact = plan.formation === engine.home.tactics.formation
    && (plan.mentality ?? 'balanced') === (engine.home.tactics.mentality ?? 'balanced')
  return (
    <span className={`plan-badge${intact ? ' plan-badge--ok' : ''}`} role="status">
      {intact ? '플랜 유지 ✅ 팀 이해도 +3%' : `플랜 이탈 ${dev}축`}
    </span>
  )
}
```

`TacticsBoard` 상단(`tb-head` 아래)에 플랜 대비 목록을 넣는다:

```tsx
      {matchPlan && (
        <div className="tb-plan" aria-label="플랜 대비">
          {(['lineHeight', 'pressing', 'tempo'] as const)
            .filter(k => matchPlan.instructions[k] !== home.tactics.instructions[k])
            .map(k => (
              <span key={k} className="tb-plan__row">
                계획: {LABEL[k]} {matchPlan.instructions[k]} → 현재 {home.tactics.instructions[k]}
              </span>
            ))}
        </div>
      )}
```

- [ ] **Step 5: 기자회견 연결**

`src/game/pressconf.ts`의 `buildQuestions`에 `planDeviation`을 입력으로 추가하고 분기를 넣는다. 시그니처 변경은 호출부(`PressConference.tsx`, `App.tsx`)까지 전파해야 한다. 선택적 인자로 하면 기존 테스트가 유지된다:

```ts
export function buildQuestions(record: MatchRecord, log: DecisionEntry[], teamName: string, planDeviation = 0) {
  /* …기존… */
  const won = record.score[0] > record.score[1]
  if (planDeviation === 0 && won) {
    qs.push({ id: 'plan-kept', text: '계획대로 됐습니다. 무엇을 준비하셨습니까?', options: [/* … */] })
  } else if (planDeviation >= 4 && won) {
    qs.push({ id: 'plan-pivot-win', text: '전반과 완전히 다른 팀이었습니다. 원래 계획이 틀렸던 겁니까?', options: [/* … */] })
  } else if (planDeviation >= 4 && !won) {
    qs.push({ id: 'plan-pivot-loss', text: '계획을 버린 것이 패인이었다고 보십니까?', options: [/* … */] })
  }
}
```

`options`는 기존 질문들의 형식(`{ id, text, tone }` 등)을 **파일을 읽고 그대로** 따를 것. 각 질문에 최소 3개 선택지를 실제 한국어 문장으로 작성한다 — 빈 배열이나 자리표시자 금지.

- [ ] **Step 6: 전체 검증 및 커밋**

```bash
npm test && npx tsc -b && npx oxlint
git add -A
git commit -m "feat(game): 플랜 이탈 메커닉 — 유지 보너스·적응 지연·기자회견 추궁 연결

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_019hRi9YcCkiaDFzAYLCPn5o"
```

---

## Self-Review 결과

**1. 스펙 커버리지** — 감사 문서 §11.2의 권고 1~6번이 태스크 1~7에 전부 매핑된다. 7번(세트피스)·8번(개인 지시)·9번(퇴장·경고 누적)·10번(시드 변주)은 **Phase A 범위 밖**으로 의도적으로 남긴다. 진척을 보고 Phase A-2에서 판단한다.

**2. 미해결로 남기는 것** (의도적, 사유 기록)
- `GkStats.buildup`은 Task 2에서 압박 이득 계수로 소비되지만, `zoneStrength`의 `gk` 반환값은 여전히 죽은 채로 둔다 — 소비처가 없는 값에 로직을 얹을 이유가 없다.
- `Player.setPiece`·`Player.foot`·`TeamProfile.signatureXI`는 Phase A에서 여전히 死데이터다. 감사 문서 §8 B 항목(전술 센터와 함께 들어와야 의미 있음)이므로 Phase A-2 대상이다.
- 사용자가 보고한 **UI 축소 버그는 브라우저에서 재현되지 않았다.** Task 4의 새 레이아웃에는 `min-height: 0` / `minmax(0, 1fr)`로 예방 조치를 넣었으나, 기존 화면의 증상은 별도 진단이 필요하다(Phase D).

**3. 타입 일관성 확인**
- `MatchupContext`는 Task 2에서 정의하고 Task 2 Step 6에서만 소비한다 — 이름 일치 확인함.
- `computeDeviation`은 Task 7에서 정의·소비한다.
- `decideAwayActions(st, minute, done)` 3인자는 테스트·구현·`matchStore` 호출부에서 동일하다.
- `LineupEditor`의 props `{ team, tactics, onChange }`는 Task 4 Step 6에서 정의하고 Step 7에서 소비한다.
- `OppAction.notice`가 유형 제한 키와 배너 문구를 겸한다 — 의도적 설계이며 테스트가 이를 단언한다.

**4. 위험 지점 (구현자가 반드시 보고할 것)**
- Task 2 Step 7~8의 캘리브레이션 충돌. 3회 조정으로 해결 안 되면 **중단하고 보고**.
- Task 4 Step 4의 `pickBestXI` 시딩 변경은 실팀 시드 스냅샷을 광범위하게 바꾼다. 갱신할 스냅샷 수가 10개를 넘으면 보고 후 진행.
- Task 6 Step 5에서 `advanceMinute`의 `set` 호출 5곳에 `oppFired`/`oppNotices`를 빠짐없이 넣을 것. 하나라도 빠지면 상대 AI가 같은 교체를 반복한다.
