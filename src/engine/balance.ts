// src/engine/balance.ts
// 밸런스 계측 전용 배치 시뮬. 프로덕션 번들에 포함되지 않도록 UI에서 import 금지.
// 목적: 지시 축이 "상대와 무관한 단조 지배 전략"이 되지 않았음을 회귀 테스트로 고정한다.
import type { TacticState } from './types'
import { loadTeam, type TeamId } from '../data/loader'
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
function batch(homeId: TeamId, awayId: TeamId, patch: Partial<TacticState>, n: number, seedBase: number) {
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
    // 전반·후반을 나눠 돌린다: firstHalfScript는 45분 도달 시 일괄 적용되는 구조라
    // 한 번에 90으로 가면 조별 스크립트 경로가 달라진다.
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
  homeId: TeamId, awayId: TeamId, axis: AxisKey, values: number[], n = 120,
): SweepCell[] {
  return values.map(value => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced', [axis]: value },
    }, n, 1000)
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
  homeId: TeamId, awayId: TeamId, plan: Partial<TacticState>, n = 200,
): { base: number; plan: number; deltaPp: number } {
  const base = batch(homeId, awayId, {
    instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  }, n, 2000)
  const p = batch(homeId, awayId, plan, n, 2000)
  return {
    base: base.winRate,
    plan: p.winRate,
    deltaPp: Math.round((p.winRate - base.winRate) * 1000) / 10,
  }
}
