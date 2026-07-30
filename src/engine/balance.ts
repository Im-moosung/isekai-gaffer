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
import { FORMATION_POSTURE, MENTALITIES } from './tactics'

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
 *  **포메이션 축에만 아무 게이트도 없었다**. 착수 전 실측(n=3200, 중립 지시)에서 순위가
 *  8개 상대 **전부 동일**했다(3-5-2 > 4-4-2 > … > 5-4-1, 폭 0.061~0.123 · 페어드 SE
 *  0.012~0.018). 폭이 임계(0.30) 아래라 폭 게이트만으로는 이 고정 정답을 잡을 수 없다 —
 *  그래서 아래 formationSlope 기반 **부호 반전** 게이트가 함께 필요하다.
 *  수리 내용은 engine/tactics.ts의 'F1 포메이션 축 비단조성' 주석 참고. */
export function runFormationSweep(
  homeId: TeamId, awayId: TeamId, n = 120, seedBase = 1000,
): { formation: FormationId; winRate: number; points: number; gf: number; ga: number }[] {
  return FORMATION_IDS.map(formation => {
    const r = batch(homeId, awayId, {
      instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
      formation,
    }, n, seedBase)
    return { formation, ...r }
  })
}

/** 형태 축의 '기울기' — 가장 전진 배치(3-5-2, posture +0.55) 빼기 가장 후진 배치
 *  (5-4-1, −1.0)의 경기당 승점 차. 양수면 "앞에 사람을 더 두는 것이 유리".
 *
 *  argmax가 아니라 두 극단의 차이를 재는 이유는 지시·멘탈리티 게이트와 같다: 6셀 중
 *  최댓값 위치는 같은 posture 부호끼리(3-5-2/4-3-3, 5-4-1/4-1-4-1) 노이즈로 흔들린다.
 *  양 끝점은 효과 크기가 커서 훨씬 안정적이고, **두 arm이 같은 시드 대역을 쓰므로 차이가
 *  페어드**라 표준오차가 셀 단위 SE보다 작다(n=2400에서 약 0.018). */
export function formationSlope(homeId: TeamId, awayId: TeamId, n: number, seedBase = 1000): number {
  const ins = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' as const }
  const fwd = batch(homeId, awayId, { instructions: ins, formation: '3-5-2' }, n, seedBase)
  const back = batch(homeId, awayId, { instructions: ins, formation: '5-4-1' }, n, seedBase)
  return fwd.points - back.points
}

/** 승점 최대 형태. 동점이면 목록 앞쪽(결정론). */
export function bestFormation(cells: { formation: FormationId; points: number }[]): FormationId {
  return cells.reduce((a, b) => (a.points >= b.points ? a : b)).formation
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
 *   - 포메이션: 추천 형태와 **무게중심(posture)이 정반대 극단**인 형태.
 *     추천이 앞쪽(posture>0)이면 5-4-1, 뒤쪽이면 3-5-2다. 멘탈리티를 사다리의 반대 극단으로
 *     보내는 것과 정확히 같은 조작이며, F1 이후 형태 축의 내용이 바로 그 무게중심이다.
 *     ⚠ 두 번의 오답을 거쳐 이 정의에 왔다.
 *       (1) formationEdge argmin — F1 이전의 유일한 판별자였다. 지금은 상성이 형태 효과의
 *           일부일 뿐이라, vs 아르헨티나에서 상성 argmin이 추천과 **같은 형태**로 나왔다
 *           (게이트 값 +0.3pp).
 *       (2) formationPlanScore argmin — 점수는 argmax(추천)에 맞춰 조정된 1차 근사라
 *           **하위 서열까지 맞지는 않는다**. vs 아르헨티나 실측 최하위는 3-5-2(1.202)인데
 *           점수는 4-4-2(1.278)를 골랐고, 그 0.076 승점이 게이트를 +0.9pp로 밀었다.
 *     무게중심 반대 극단은 11개 상대 중 **10개에서 실측 최하위와 일치**한다(예외는 전력이
 *     대등해 축이 평평한 노르웨이: 최하위 4-4-2 1.587 vs 5-4-1 1.619).
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
    // 추천 형태의 무게중심 부호를 뒤집어 반대 극단으로 보낸다.
    const rec = FORMATION_POSTURE[plan.formation]
    out.formation = FORMATION_IDS.reduce((a, b) => {
      const pick = rec > 0 ? FORMATION_POSTURE[a] <= FORMATION_POSTURE[b] : FORMATION_POSTURE[a] >= FORMATION_POSTURE[b]
      return pick ? a : b
    })
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
