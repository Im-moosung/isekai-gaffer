// src/engine/balance.ts
// 밸런스 계측 전용 배치 시뮬. 프로덕션 번들에 포함되지 않도록 UI에서 import 금지.
// 목적: 지시 축이 "상대와 무관한 단조 지배 전략"이 되지 않았음을 회귀 테스트로 고정한다.
//
// ⚠ 이 하네스가 재는 것과 실제 경기의 차이(2026-07-30 점검). 게이트를 읽을 때 전제로 삼아라.
//  1. **감독 개입이 없는 경기다.** batch()는 킥오프 전술을 그대로 90분 돌린다. 하프타임
//     팀토크·터치라인 외침·개입 부스트(boostUntil)·플랜 유지 보너스(planIntact)·구조 변경
//     적응 지연(adaptLag)은 전부 game/matchStore 계층이라 여기 들어오지 않는다.
//  2. **상대 AI도 적응하지 않는다.** 실경기의 상대 감독(game/oppAi.decideAwayActions, 46·60·
//     70·80분 교체/전술 스위칭)은 matchStore가 돌린다. 여기선 원정팀이 킥오프 전술로 고정이다.
//     → 즉 여기 수치는 "플랜만의 순효과"다. 두 arm 모두 같은 조건이라 비교는 유효하지만,
//       유저가 체감하는 절대 승률은 아니다. 게이트 임계를 이 수치로 정할 때 이 점을 기억하라.
//  3. **기준선(base)의 지시 50/50/50은 게임의 실제 기본값이 아니다.** App은 pickBestXI(kor)로
//     시작하고 그 지시는 팀 프로필 스타일(라인 50·압박 62·템포 55)이다. 여기 base는 "중립
//     지시"라는 기준점일 뿐 "아무것도 안 했을 때"가 아니다. Δpp를 그렇게 읽으면 안 된다.
//  4. XI는 patch.formation을 반영해 다시 세운다(batch 주석 참고). 여기가 실제로 게이트를
//     오염시키던 구멍이었다.
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

/** 홈 전술을 base에 patch를 병합해 구성하고 n경기 배치 시뮬. 시드는 seedBase부터 결정론 증가.
 *
 *  ⚠ XI는 **패치된 포메이션 기준**으로 세운다. 이전엔 팀 기본 포메이션(kor 4-2-3-1)의 XI에
 *  patch.formation만 덮어써서, "포메이션은 4-4-2인데 슬롯 배치는 4-2-3-1"인 유저가 만들 수
 *  없는 전술을 재고 있었다. 실측(n=800, 나쁜 판단 페널티 게이트)에서 이 구멍은 상대별로
 *  0.8~3.2pp를 왜곡했다 — 대칭이 아니다. 기준선 arm은 포메이션을 패치하지 않아 영향이 없고
 *  패치 arm만 값이 바뀌기 때문이다.
 *  UI 워룸은 포메이션 변경 시 autoFill로 XI를 재배치하는데, kor·6포메이션 전수에서
 *  pickBestXI(team, f)와 autoFill 결과의 적합도 합이 같다(실측 확인). 그래서 엔진 계층에서
 *  UI 함수를 끌어오지 않고 pickBestXI에 포메이션을 넘기는 것으로 충분하다.
 *  호출자가 patch.lineup을 명시하면 그쪽이 이긴다(아래 `...patch`). */
function batch(homeId: TeamId, awayId: TeamId, patch: Partial<TacticState>, n: number, seedBase: number) {
  const home = loadTeam(homeId)
  const away = loadTeam(awayId)
  // XI 구성은 결정론이라 경기마다 다시 세울 이유가 없다(루프 밖으로 뺀 순수 최적화).
  const t = pickBestXI(home, patch.formation)
  const tactics: TacticState = {
    ...t,
    ...patch,
    instructions: { ...t.instructions, ...(patch.instructions ?? {}) },
  }
  let w = 0, d = 0, gf = 0, ga = 0
  for (let i = 0; i < n; i++) {
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

/** 포메이션 6종 스윕. 지시는 중립(50/50/50), 태세는 미지정으로 고정해 형태 축만 분리한다.
 *  XI는 batch()가 포메이션별로 다시 세운다 — 유저가 워룸에서 포메이션을 바꿨을 때와 같다.
 *
 *  이 스윕이 뒤늦게 추가된 이유: 지시·멘탈리티에는 지배 전략 방지 게이트가 있었는데
 *  **포메이션 축에만 아무 게이트도 없었다**. 실측(n=400, 중립 지시)에서 형태는 상대와 무관한
 *  이득을 싣고 있다 — 4-4-2·3-5-2가 mex·rsa·esp 전부에서 상위 둘이다. 승점 폭 자체는
 *  다른 축의 임계(0.30) 아래지만(mex 0.137 · rsa 0.058 · esp 0.185), 그 사실을 아무도
 *  재고 있지 않았다는 것이 문제였다. */
export function runFormationSweep(
  homeId: TeamId, awayId: TeamId, n = 120,
): { formation: FormationId; winRate: number; points: number; gf: number; ga: number }[] {
  return FORMATION_IDS.map(formation => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
      formation,
    }, n, 1000)
    return { formation, ...r }
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
 *     ⚠ 상성만 뒤집힐 뿐 형태 자체의 값은 뒤집히지 않는다. kor 기준 argmin은 11개 상대 중
 *     9개에서 4-4-2인데, 4-4-2는 우리 스쿼드엔 기본 4-2-3-1보다 잘 맞아 상대와 무관하게
 *     +2.2~2.5pp를 돌려준다(n=3200 실측). 오판 페널티가 프랑스전에서 −1pp까지 얇아지는
 *     이유가 이것이다 — 정의의 결함이 아니라 형태 축이 실어 나르는 상대 무관 이득이다.
 *     그 크기는 '포메이션 축 지배 방지' 게이트(runFormationSweep)가 따로 감시한다.
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
