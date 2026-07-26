// src/engine/balance.ts
// 밸런스 계측 전용 배치 시뮬. 프로덕션 번들에 포함되지 않도록 UI에서 import 금지.
// 목적: 지시 축이 "상대와 무관한 단조 지배 전략"이 되지 않았음을 회귀 테스트로 고정한다.
import type { FormationId, Mentality, TacticState, Team } from './types'
import { loadTeam, type TeamId } from '../data/loader'
import { createMatch, simulateSegment, flankStrength } from './simulate'
import { pickBestXI } from './lineup'
import { mapFormation } from './formations'
import { MENTALITIES, formationEdge } from './tactics'

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

/** 멘탈리티 5단 스윕. 지시는 중립(50/50/50)으로 고정해 태세 축만 분리한다.
 *  지시 축 스윕(runAxisSweep)과 시드·n 규약을 맞춰 두 축의 수치를 직접 비교할 수 있게 했다. */
export function runMentalitySweep(
  homeId: TeamId, awayId: TeamId, n = 120,
): { mentality: Mentality; winRate: number; points: number; gf: number; ga: number }[] {
  return MENTALITIES.map(mentality => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
      mentality,
    }, n, 1000)
    return { mentality, ...r }
  })
}

/** 추천 플랜을 "정반대"로 뒤집는다 — 감독의 나쁜 판단을 재현하는 표준 정의.
 *  추천이 **상대를 보고 정한 축 전부**를 반대로 읽는다. 일부만 뒤집으면 "거꾸로 읽었는데
 *  포메이션 상성과 공격 방향은 정확히 골랐다"는 혼종이 되고, 그 남은 정답들이 공짜 이득
 *  (실측 합계 3~5pp)으로 들어와 게이트가 "나쁜 판단인데 이득"을 통과시킨다.
 *   - 라인·압박: 100 − x (가둬야 할 상대에게 물러서고, 벗겨질 상대에게 달려든다)
 *   - 템포: 100 − x
 *   - 멘탈리티: 사다리의 반대 극단 (index 4 − i)
 *   - 그룹 적극성: 공격 라인과 수비 라인을 맞바꾼다
 *   - 공격 방향: 상대의 **가장 강한** 지역으로 몬다 (추천은 argmin, 여기선 argmax)
 *   - 포메이션: 상대 포메이션에 상성이 **가장 나쁜** 형태 (추천은 argmax, 여기선 argmin)
 *  공격 패턴은 그대로 둔다 — 4종에 뚜렷한 반대 극이 없어(cross↔through가 대칭이 아니다)
 *  "뒤집었다"고 부를 만한 사상이 정의되지 않는다. */
export function invertPlan(plan: Partial<TacticState>, opp: Team): Partial<TacticState> {
  const out: Partial<TacticState> = { ...plan }
  if (plan.instructions) {
    const oppXI = pickBestXI(opp)
    const stamina: Record<string, number> = {}
    for (const p of opp.squad) stamina[p.id] = 100
    const flanks = flankStrength(oppXI.lineup, opp.squad, stamina)
    const strongest = (['left', 'right', 'center'] as const).reduce((a, b) => (flanks[a] >= flanks[b] ? a : b))
    out.instructions = {
      ...plan.instructions,
      lineHeight: 100 - plan.instructions.lineHeight,
      pressing: 100 - plan.instructions.pressing,
      tempo: 100 - plan.instructions.tempo,
      attackFocus: strongest,
    }
  }
  const mi = MENTALITIES.indexOf(plan.mentality ?? 'balanced')
  out.mentality = MENTALITIES[MENTALITIES.length - 1 - mi]
  if (plan.groupIntensity) {
    out.groupIntensity = { ...plan.groupIntensity, attack: plan.groupIntensity.defense, defense: plan.groupIntensity.attack }
  }
  if (plan.formation) {
    const of = mapFormation(opp.profile.preferredFormations[0] ?? '4-3-3')
    out.formation = FORMATION_IDS.reduce((a, b) => (formationEdge(a, of) <= formationEdge(b, of) ? a : b))
  }
  return out
}

const FORMATION_IDS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

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
