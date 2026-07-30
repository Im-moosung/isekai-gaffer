// src/engine/simulate.ts
import { createRng, type Rng } from './rng'
import { zoneStrength } from './strength'
import { instructionEffects, formationEdge, formationEffects, phaseFormationEffects, groupIntensityEffects, mentalityEffects, attackPatternEffects, groupIntensityStaminaFactor, attackFocusEffects, footEffects, groupIntensityZoneFactor, setPieceEffects, markingFactor, type MatchupContext } from './tactics'
import { effectiveStats } from './fitness'
import { pickBestXI } from './lineup'
import type { Instructions, MatchEvent, MatchState, Player, Position, SideState, SideStats, TacticState, Team } from './types'

export type MatchCommand =
  | { type: 'sub'; out: string; in: string }
  | { type: 'instructions'; instructions: Instructions }
  | { type: 'formation'; tactics: TacticState }

/** simulateSegment 옵션. 미지정이면 기존 동작(회귀 불변). */
export interface SimulateOpts {
  /** 개입 직후 부스트: 지정 side에 until 분까지 고정 보너스(찬스 퀄 +8%·실점 위험 −6%). */
  instructionBoost?: { side: 'home' | 'away'; until: number }
  /** 킥오프 플랜의 구조(포메이션·멘탈리티)를 유지 중인 side. 찬스 퀄리티 ×1.03. */
  planIntact?: 'home' | 'away'
  /** 구조 변경 직후 적응 지연이 걸린 side와 만료 분. 찬스 빈도 ×0.94, 역습 취약성 ×1.06. */
  adaptLag?: { side: 'home' | 'away'; until: number }
}

/** 경기당 교체 인원 상한 — IFAB Law 3(2026) 기준 5명. */
export const MAX_SUBS = 5
/** 경기당 교체 기회 상한 — IFAB Law 3(2026)의 substitution opportunity, 3회.
 *  ⚠ UI 표기는 반드시 "교체 기회"로 쓴다 — 한국어에서 "교체 창"은 교체 패널(UI 창)로 읽혀
 *  "패널을 몇 번 더 열 수 있다"로 오해된다. 코드 식별자만 window를 유지한다.
 *  같은 분에 이뤄진 복수 교체는 한 번의 기회로 묶고, 하프타임(45분) 교체는 기회를 소모하지 않는다
 *  (실제 규정도 하프타임 교체를 기회로 세지 않는다 — 그래서 하프타임의 가치가 올라간다).
 *  우리 게임은 90분 후 바로 승부차기라 연장전 추가 교체/기회 규정은 해당 없다.
 *
 *  ★ 설계 의도: 감독 타임(pauseByUser)에는 횟수 제한이 없지만 교체 기회는 3회뿐이라,
 *  아무 때나 멈춰 선수를 바꾸면 스스로 자원을 태운다. 인위적인 "정지 N회 제한" 없이
 *  규정 자체가 개입의 절제를 강제하는 구조다. */
export const MAX_SUB_WINDOWS = 3
// 전력 차 민감도 — 동급 팀은 비율 1이라 캘리브레이션 계약 무영향, 비대칭 매치업의 승률 분화 담당.
// 실데이터 검증(esp≥55승) 기준으로 튜닝.
// 이 값은 '기회의 양'만 늘린다. 슛 수는 ±15%(동급)/±25%(실팀) 캘리브레이션 계약에 묶여 있어
// 여기만 올리면 전력 서열 게이트와 정면충돌한다. 그래서 전력 차의 나머지 절반은
// XG_STRENGTH가 '기회의 질'로 싣는다 — 슛 수를 건드리지 않고 서열을 벌리는 축이다.
export const STRENGTH_SENSITIVITY = 1.6
/** F2: 찬스 빈도 전력비에 미드필드가 섞이는 가중. 근거는 simulateMinute의 F2 주석.
 *  추천 계층(game/scouting)이 형태를 고를 때 같은 혼합을 재현해야 하므로 내보낸다. */
export const W_MID = 0.22

/** 찬스 빈도 전력비에 들어가는 실효 공격·수비 전력(F2 미드필드 혼합). 엔진과 추천이
 *  같은 수식을 쓰도록 여기 한 벌만 둔다. */
export const effectiveAttack = (z: { attack: number; midfield: number }) =>
  (1 - W_MID) * z.attack + W_MID * z.midfield
export const effectiveDefense = (z: { defense: number; midfield: number }) =>
  (1 - W_MID) * z.defense + W_MID * z.midfield

export function createMatch(home: Team, away: Team, opts: { seed: number; homeTactics?: TacticState; awayTactics?: TacticState; firstHalfScript?: { events: MatchEvent[]; score: [number, number] } }): MatchState {
  const mkSide = (team: Team, tactics?: TacticState): SideState => {
    const staminaByPlayer: Record<string, number> = {}, moraleByPlayer: Record<string, number> = {}
    team.squad.forEach(p => { staminaByPlayer[p.id] = 100; moraleByPlayer[p.id] = 70 })
    return { team, tactics: tactics ?? defaultTactics(team), staminaByPlayer, moraleByPlayer, subsUsed: 0, sentOff: [], sustainedPressMinutes: 0 }
  }
  return {
    minute: 0, score: [0, 0], home: mkSide(home, opts.homeTactics), away: mkSide(away, opts.awayTactics),
    events: [{ minute: 0, type: 'kickoff', teamId: home.id }],
    stats: [emptyStats(), emptyStats()], momentum: 0,
    seed: opts.seed,
    ...(opts.firstHalfScript ? { firstHalfScript: opts.firstHalfScript } : {}),
  }
}

function emptyStats(): SideStats {
  return { possession: 50, passAccuracy: 0, passesAttempted: 0, passesCompleted: 0, shots: 0, shotsOnTarget: 0, fouls: 0, corners: 0, xg: 0 }
}

function defaultTactics(team: Team): TacticState {
  // pickBestXI가 team.profile.preferredFormations[0]을 FormationId로 매핑해 XI·formation을 정한다
  // (AI가 자기 시그니처 포메이션으로 출전 → tactics.formation도 그 값이라 formationEdge가 실제 발동).
  // 프로필 스타일은 지시(instructions)로 반영.
  const t = pickBestXI(team)
  t.instructions = {
    lineHeight: team.profile.style.lineHeight, pressing: team.profile.style.pressing,
    tempo: team.profile.style.tempo, attackFocus: 'balanced',
  }
  return t
}

export function simulateSegment(state: MatchState, toMinute: number, opts: SimulateOpts = {}): MatchState {
  const st: MatchState = structuredClone(state)

  // 스크립트("실제 전반 재현") 모드: 전반(≤45)은 시뮬하지 않고 스크립트를 일괄 적용한다.
  // 채택한 45 분할 방식: toMinute<45 이면 minute만 전진하고 이벤트는 미적용, 45 도달 시 일괄 적용.
  //   → 어느 분할 지점(예: 30→45)에서도 전반 결과가 동일해 분할 결정론이 유지된다.
  // 후반(45→90)은 기존 시뮬 그대로이며 분 파생 RNG(seed*10007+minute)도 불변이다.
  //
  // ⚠ 현재 App에서 미사용 — F1 B안으로 배선 해제(2026-07-26).
  // 이유: 조별 3경기가 1~44분에 simulateMinute을 한 번도 돌지 않아 22' 하이드레이션 시점에
  // 체력 100·슛 0·xG 0·점유율 50%였고, 전술 센터에서 설계한 플랜이 전반 45분 동안
  // 결과에 아무 영향도 주지 않았다(Phase A 간판 기능이 꺼짐).
  // 기능 자체는 되돌릴 수 있게 남긴다 — 아래 분기는 엔진/스토어 테스트에서만 진입한다.
  // (App.tsx는 더 이상 firstHalfScript를 MatchScreen에 넘기지 않는다.)
  if (st.firstHalfScript && st.minute < 45) {
    if (toMinute < 45) { st.minute = toMinute; return st }
    applyFirstHalfScript(st)
  }

  while (st.minute < toMinute) {
    st.minute++
    // 분 파생 RNG: 세그먼트 분할 지점과 무관하게 같은 분은 같은 난수 → 45+45=90 결정론
    const rng = createRng(st.seed * 10007 + st.minute)
    simulateMinute(st, rng, opts)
    if (st.minute === 45) st.events.push({ minute: 45, type: 'halftime', teamId: st.home.team.id })
  }
  if (toMinute >= 90 && !st.events.some(e => e.type === 'fulltime'))
    st.events.push({ minute: 90, type: 'fulltime', teamId: st.home.team.id })
  return st
}

// 전반 스크립트 일괄 적용: 시뮬 대신 실제 전반 데이터를 재현한다.
function applyFirstHalfScript(st: MatchState) {
  const script = st.firstHalfScript!
  // 이벤트: 분 순서로 정렬해 기존 kickoff 뒤에 배치 (동일 분은 입력 순서 유지 = 안정 정렬)
  const sorted = script.events.map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.minute - b.e.minute || a.i - b.i)
    .map(x => x.e)
  st.events.push(...sorted)
  st.score = [script.score[0], script.score[1]]
  // 스탯: 실제 전반 세부 데이터가 없으므로 statBaseline 기반 '절반 근사'.
  //  - 슛/유효슛/파울/코너: 각 팀 90분 baseline × 0.5 반올림
  //  - 점유율: 두 팀 baseline.possession 비율로 정규화 (합 100)
  //  - 패스 정확도: baseline 그대로
  //  - xG: 실제 전반 xG가 없어 (골 수 × 0.35)로 근사
  const half = (v: number) => Math.round(v * 0.5)
  const bl = [st.home.team.statBaseline, st.away.team.statBaseline]
  const possTotal = bl[0].possession + bl[1].possession
  // 전반 45분치 패스 시도 근사 — 분당 (점유 8 + 비점유 3)/2를 45분 누적한 값.
  const scriptAttempts = Math.round(45 * (PASS_ATTEMPTS_ON_BALL + PASS_ATTEMPTS_OFF_BALL) / 2)
  st.stats = ([0, 1] as const).map(i => ({
    possession: round1(possTotal > 0 ? (bl[i].possession / possTotal) * 100 : 50),
    passAccuracy: bl[i].passAccuracy,
    passesAttempted: scriptAttempts,
    passesCompleted: Math.round(scriptAttempts * bl[i].passAccuracy / 100),
    shots: half(bl[i].shotsPerGame),
    shotsOnTarget: half(bl[i].shotsOnTargetPerGame),
    fouls: half(bl[i].foulsPerGame),
    corners: half(bl[i].cornersPerGame),
    xg: round2(st.score[i] * 0.35),
  })) as [SideStats, SideStats]
  st.minute = 45
  // halftime 이벤트 push (기존 로직 유지)
  st.events.push({ minute: 45, type: 'halftime', teamId: st.home.team.id })
}

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
 *  left: 우리가 왼쪽을 공략 → 상대의 오른쪽 수비(RB/RW)를 만난다. 좌우가 뒤집히는 점에 주의.
 *
 *  SideState가 아니라 조각으로 받는 이유: 추천 계층(game/scouting)이 킥오프 **전에**
 *  같은 판별자로 attackFocus를 고를 수 있어야 하는데, 그 시점엔 SideState가 없다.
 *  수식을 복제하는 대신 여기서 내보내 한 벌만 유지한다. */
export function flankStrength(
  lineup: readonly { slot: Position; playerId: string }[],
  squad: readonly Player[],
  staminaByPlayer: Readonly<Record<string, number>>,
  sentOff: readonly string[] = [],
): { left: number; right: number; center: number } {
  const pick = (slots: string[]) => {
    const vals = lineup
      .filter(l => !sentOff.includes(l.playerId) && slots.includes(l.slot))
      .map(l => {
        const p = squad.find(q => q.id === l.playerId)!
        const es = effectiveStats(p, l.slot, staminaByPlayer[l.playerId])
        return (es.defending + es.physical + es.pace) / 3
      })
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 55
  }
  return { left: pick(['RB', 'RW']), right: pick(['LB', 'LW']), center: pick(['CB', 'DM']) }
}

/** 가장 약한 측면(=공략 대상). attackFocusEffects의 edge는 (평균 − 대상)에 비례하므로
 *  argmin을 고르면 보상이 음수가 될 수 없다. 동점이면 left → right → center 순(결정론). */
export function weakestFlank(f: { left: number; right: number; center: number }): 'left' | 'right' | 'center' {
  return (['left', 'right', 'center'] as const).reduce((a, b) => (f[a] <= f[b] ? a : b))
}

// E1: 멘탈리티 위험 항의 상대 의존 스케일.
// "뒷공간을 내주는 대가는 그 공간을 쓸 상대가 있을 때만 발생한다."
//
// 판별자는 **매치업 우위**(edge) — 두 방향 전력비의 곱이다:
//   edge = (우리 공격/상대 수비) × (우리 수비/상대 공격)
// 한 방향 비만 쓰면 부호를 가르지 못한다. 실팀 12팀의 존 전력이 73~82로 압축돼 있어
// 단방향 비의 폭이 kor 기준 0.97~1.10뿐이었고, 제곱해도 rsa 0.98 / esp 1.15로
// 실측 기울기가 거의 움직이지 않았다(1차 조정 실패). 비의 비는 두 방향의 차이가 곱으로
// 합쳐져 폭이 두 배가 되고(0.90~1.10), 체력 저하처럼 양 팀에 공통으로 걸리는 요인은
// 분자·분모에서 상쇄돼 경기 중에도 안정적이다.
//
// 지수 −10: 폭 ±10%를 실제 태세 판단이 갈리는 스케일(0.4~2.0)로 펴기 위한 값이다.
// (kor 기준 실측 edge: rsa 1.095 → 0.39 · mex 1.045 → 0.64 · eng 0.928 → 2.06 · esp 0.956 → 1.55)
// 동급(edge 1.0)이면 정확히 1.0이라 캘리브레이션 계약(동급 팀)에 무영향.
// clamp는 퇴장·극단 라인업에서 발산을 막는다.
const RISK_SENSITIVITY = 10

/** 매치업 우위 — 두 방향 전력비의 곱. 1.0이 대등, >1이면 우리가 우위다.
 *  추천 계층(game/scouting·game/coach)이 태세를 고를 때 같은 값을 읽는다. */
export function matchupEdge(
  ours: { attack: number; defense: number },
  theirs: { attack: number; defense: number },
): number {
  return (ours.attack / Math.max(30, theirs.defense)) * (ours.defense / Math.max(30, theirs.attack))
}

/** 뒷공간을 내주는 선택(공격적 태세 E1 · 전진 배치 형태 F1)의 **위험 항** 스케일.
 *  대등(edge 1.0)하면 정확히 1.0. 우리가 우위면 <1(공짜에 가깝다), 열세면 >1(아프다).
 *  두 축이 같은 판별자를 공유해야 "무엇을 걸고 나가는가"가 한 벌의 규칙으로 설명된다.
 *  추천 계층(game/scouting)이 형태를 고를 때도 이 값을 읽는다. */
export const counterRiskScale = (
  ours: { attack: number; defense: number },
  theirs: { attack: number; defense: number },
) => clamp(Math.pow(matchupEdge(ours, theirs), -RISK_SENSITIVITY), 0.35, 2.5)

function simulateMinute(st: MatchState, rng: Rng, opts: SimulateOpts = {}) {
  const zs = [zoneStrength(st.home), zoneStrength(st.away)]
  const sides = [st.home, st.away] as const
  // ctx[0]은 홈이 마주하는 상대(=어웨이)의 컨텍스트다. 인덱스를 뒤집지 말 것.
  const ctx = [matchupContext(st.away), matchupContext(st.home)] as const
  const fx = [
    instructionEffects(st.home.tactics.instructions, ctx[0]),
    instructionEffects(st.away.tactics.instructions, ctx[1]),
  ]

  // 멘탈리티(5프리셋): instructionEffects 위에 곱. 'balanced'는 전 축 1.0 → 회귀 불변.
  for (const i of [0, 1] as const) {
    const m = mentalityEffects(sides[i].tactics.mentality)
    const risk = counterRiskScale(zs[i], zs[(1 - i) as 0 | 1])
    // F1 포메이션: 상성(상대 형태 의존) + 태세(상대 전력 의존). 둘 다 찬스 질 경로라
    // 슛 수 캘리브레이션 계약은 건드리지 않는다. 근거는 tactics.formationEffects 주석.
    const ff = formationEffects(sides[i].tactics.formation, sides[(1 - i) as 0 | 1].tactics.formation, risk)
    fx[i].chanceQuality *= ff.chanceQuality
    fx[i].concedeQuality *= ff.concedeQuality
    // P1 페이즈 포메이션 · P2 그룹 적극성: 존 가중 이동(strength.ts)이 주는 **보상의 대가**다.
    // 둘 다 미선언이면 전 축 1.0이라 회귀 불변. 근거는 tactics.phaseFormationEffects·
    // groupIntensityEffects 주석 참고.
    const pf = phaseFormationEffects(sides[i].tactics.phaseFormations, risk)
    const gi = groupIntensityEffects(sides[i].tactics.groupIntensity, risk)
    fx[i].chanceQuality *= pf.chanceQuality * gi.chanceQuality
    fx[i].concedeQuality *= pf.concedeQuality * gi.concedeQuality
    fx[i].staminaDrain *= pf.staminaDrain
    // P3 공격 패턴: 크로스는 풀백을 라인 위로 올린다 — 걷어낸 크로스가 역습 개시점이 된다.
    // cross 이외 패턴과 ctx 없는 경로에서는 정확히 1.0.
    fx[i].counterVulnerability *= attackPatternEffects(sides[i].tactics.attackPattern, {
      oppLineHeight: sides[(1 - i) as 0 | 1].team.profile.style.lineHeight, risk,
    }).counterVulnerability
    fx[i].chanceRate *= m.chanceRate
    fx[i].chanceQuality *= m.chanceQuality
    fx[i].possessionBias *= m.possessionBias
    // E1: 태세의 **이득**은 그대로, **위험**만 상대 역습 능력에 비례해 물린다.
    // 1.0으로부터의 편차에 risk를 곱하므로 balanced(전 축 1.0)는 여전히 완전 불변이다.
    fx[i].counterVulnerability *= 1 + (m.counterVulnerability - 1) * risk
    fx[i].concedeQuality *= 1 + (m.concedeQuality - 1) * risk
    fx[i].staminaDrain *= m.staminaDrain
  }

  // 개입 부스트: 방향 증폭이 아니라 고정 보너스로 준다.
  // 구 설계 amp(v)=1+(v−1)×1.3은 지시가 중립이면 무효과였고, 저압박·저라인 플랜에서는
  // 1.0 미만 편차까지 증폭해 역효과였다(감사 실측 스페인전 −3.0pp).
  // 고정값이면 무엇을 지시했든 항상 같은 방향이라 UI로 약속할 수 있다("작전 지시 효과 8분간 지속").
  // counterVulnerability는 '자기 팀의 취약성'이고 fx[defIdx]가 공격 측 찬스에 곱해지므로,
  // 낮추면 부스트받은 팀의 실점 확률이 내려간다.
  const boost = opts.instructionBoost
  if (boost && st.minute <= boost.until) {
    const bi = boost.side === 'home' ? 0 : 1
    fx[bi].chanceQuality *= 1.08
    fx[bi].counterVulnerability *= 0.94
  }

  // 팀 이해도: 킥오프 플랜의 구조(포메이션·멘탈리티)를 유지하면 소폭 보너스.
  // 하프타임에 전부 갈아엎는 것이 항상 최적이면 킥오프 전 설계가 무의미해지므로, 유지에 값을 붙인다.
  // UI(PlanBadge)가 "플랜 유지 ✅ 팀 이해도 +3%"로 유저에게 약속하는 수치가 이 값이다.
  if (opts.planIntact) {
    const pi = opts.planIntact === 'home' ? 0 : 1
    fx[pi].chanceQuality *= 1.03
  }
  // 적응 지연: 구조 변경 직후 몇 분간 선수들이 새 배치에 적응하는 비용.
  // 지시 4축 미세 조정에는 걸리지 않는다 — 그건 감독의 정상 업무이고, 오히려 개입 부스트의 대상이다.
  // 부스트(찬스 퀄·역습 취약성)와 축이 겹치지 않게 찬스 '빈도'를 깎아 상충을 피한다.
  if (opts.adaptLag && st.minute <= opts.adaptLag.until) {
    const ai = opts.adaptLag.side === 'home' ? 0 : 1
    fx[ai].chanceRate *= 0.94
    fx[ai].counterVulnerability *= 1.06
  }

  // 지속 압박 페널티: 압박 70+ 유지 분 추적 → 10분마다 체력 소모 가중.
  // 가중은 임계 초과분(press-70)/30에 비례하고 +30%에서 멈춘다. 두 가지 이유:
  //  (1) 임계에서 정확히 0이라 압박 축에 절벽이 없다 — 기존 고정 +15%/10분은 press 69→70에서
  //      경기당 승점이 0.35 떨어지는 계단을 만들어 "압박은 70 미만" 단일 정답을 강제했다.
  //  (2) 상한(+30%) 없이는 교체를 쓰지 않는 배치 시뮬에서 90분 풀프레스 시 체력이 0까지 떨어져
  //      압박 90이 무조건 자살 수가 된다. 이 상한에서도 풀타임 압박 90이면 종료 시 체력 ~25다.
  const staminaWeight = [1, 1]
  for (const i of [0, 1] as const) {
    const press = sides[i].tactics.instructions.pressing
    if (press >= 70) sides[i].sustainedPressMinutes = (sides[i].sustainedPressMinutes ?? 0) + 1
    else sides[i].sustainedPressMinutes = 0
    const excess = clamp((press - 70) / 30, 0, 1)
    staminaWeight[i] = 1 + Math.min(0.3, 0.15 * Math.floor((sides[i].sustainedPressMinutes ?? 0) / 10) * excess)
    if (press >= 70 && avgStamina(sides[i]) < 55) {
      fx[i].foulRate *= 1.5
      // 압박 실효 반감: 압박이 만든 이득(1.0 초과분)을 절반으로.
      fx[i].chanceRate = 1 + (fx[i].chanceRate - 1) * 0.5
      fx[i].possessionBias = 1 + (fx[i].possessionBias - 1) * 0.5
    }
  }

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

  trackPasses(st, sides, atkIdx)

  // 참여 빈도 보정: 찬스·파울 롤은 매 분 한 팀만(공격/수비 각 1팀) 굴린다. statBaseline은
  // 팀당 90분 기준이므로 90으로 나누면 롤이 실제 발생하는 '참여 분'(≈45분)의 절반만 반영돼
  // 실측의 ~50%로 과소집계된다. 참여 분(=90×참여빈도)으로 정규화해야 베이스라인에 수렴한다.
  // atkIdx는 defIdx의 여집합이므로 (공격팀의 공격빈도)=(수비팀의 수비빈도)=participation 로 일치한다.
  const participation = Math.max(0.15, (atkIdx === 0 ? possW0 : possW1) / (possW0 + possW1))

  // 2) 파울 롤 (수비 측): 베이스라인 캘리브레이션 (팀 실측 파울/90분, 참여 분 정규화)
  const foulP = clamp((def.team.statBaseline.foulsPerGame / (90 * participation)) * fx[defIdx].foulRate, 0, 0.6)
  if (rng.chance(foulP)) {
    st.stats[defIdx].fouls++
    const fouler = randomLineupPlayer(def, rng, ['CB', 'DM', 'LB', 'RB', 'CM'])
    st.events.push({ minute: st.minute, type: 'foul', teamId: def.team.id, playerId: fouler })
    // 지친 압박은 경고로 이어진다: 기본 0.12, 압박 70+ & 저체력이면 ×1.5.
    const tired = def.tactics.instructions.pressing >= 70 && avgStamina(def) < 55
    // 이미 경고를 받은 선수는 두 번째 경고를 훨씬 덜 받는다(BOOKED_CAUTION). 근거는 상수 주석.
    const booked = countYellows(st, fouler) >= 1
    if (rng.chance((tired ? 0.18 : 0.12) * (booked ? BOOKED_CAUTION : 1))) {
      st.events.push({ minute: st.minute, type: 'yellow', teamId: def.team.id, playerId: fouler })
      // 2옐로 → 레드. 누적은 **이벤트 로그에서 센다** — SideState에 카드 카운터를 두면
      // 스크립트 전반 적용·하이드레이션 복원 경로에서 상태와 로그가 어긋날 수 있다.
      if (countYellows(st, fouler) >= 2) sendOff(st, def, fouler)
    } else if (rng.chance(DIRECT_RED_P)) {
      // 직접 레드(심각한 파울). 실제 비율 근거는 DIRECT_RED_P 주석 참조.
      // 경고가 나온 파울에는 굴리지 않는다 — 같은 파울이 경고이면서 퇴장일 수는 없다.
      sendOff(st, def, fouler)
    }
  }

  // 3) 찬스 롤 (공격 측): 공격 전력(공격 페이즈) vs 수비 전력(수비 페이즈) + 템포 + 모멘텀 + 공격 패턴
  //    phaseFormations 미지정·groupIntensity 0이면 phase 존은 neutral과 동일 → 회귀 불변.
  //
  // ── F2 미드필드를 승패 경로에 넣는다 (2026-07-30) ──────────────────
  // 이전엔 midfield 존이 **점유 가중(possW)에만** 쓰였는데, 찬스 확률이 participation으로
  // 나눠지는 정규화 때문에 점유는 승패에 거의 중립이다. 결과적으로 "미드필드에서 훔쳐
  // 공격에 넣는 선택은 언제나 공짜 이득"이었다. F0(존 인원수)만 넣고 재보니 그 구멍이
  // 그대로 드러났다 — 3-5-2 대신 **4-4-2가 4개 상대 전부에서 1위**가 됐다(미드 2명의
  // 대가가 여전히 0이라서). 즉 인원수만으로는 고정 정답이 옮겨갈 뿐 사라지지 않는다.
  //
  // 실제 축구에서 중원은 공격의 공급선이자 **수비의 1선**이다. 그래서 찬스 빈도를 정하는
  // 두 전력에 미드필드를 섞는다. 선형 혼합이라 두 팀의 중원이 같으면 비(比)가 그대로여서
  // 동급 팀 캘리브레이션 계약(±15%)은 정의상 영향이 없다.
  // 가중 0.22: 존 셋(공·미·수) 중 하나에 1/3을 주는 것이 자연스러운 상한이지만, 실팀은
  // 미드필드 평균이 공격·수비와 크게 다를 수 있어(kor 4-2-3-1 기준 공 76.9 / 미 67.3 / 수 75.1)
  // 가중이 크면 팀별 슛 베이스라인이 밀린다. F0 지수와 함께 실측으로 정한 상한이다 —
  // (0.35, 0.30)에서 실팀 캘리브레이션(±25%)이 kor-cze +25.3% · esp-arg +28.7%로 깨졌고,
  // (0.20, 0.22)에서 +15.3% · +20.4%로 통과하면서 형태 축 부호 반전은 그대로 유지된다.
  const zAtk = zoneStrength(atk, 'attack')
  const zDef = zoneStrength(def, 'defense')
  const atkZone = effectiveAttack(zAtk)
  const defZone = effectiveDefense(zDef)
  // P3: 패턴 효과는 상대 라인 높이(뒷공간)와 역습 위험을 읽는다. 여기 risk는 공격 측 기준이다.
  const ap = attackPatternEffects(atk.tactics.attackPattern, {
    oppLineHeight: def.team.profile.style.lineHeight,
    risk: counterRiskScale(zs[atkIdx], zs[defIdx]),
  })
  const momentumBoost = atkIdx === 0 ? 1 + st.momentum * 0.15 : 1 - st.momentum * 0.15
  // 수비 측의 suppression(하이라인·하이프레스로 상대 전개를 끊는 항)이 공격 측 찬스를 억제한다.
  const chanceP = clamp(
    (atk.team.statBaseline.shotsPerGame * openPlayShotFactor(atk.team) / (90 * participation)) * Math.pow(atkZone / Math.max(30, defZone), STRENGTH_SENSITIVITY) * fx[atkIdx].chanceRate * ap.chanceRate * fx[defIdx].counterVulnerability * fx[defIdx].suppression * momentumBoost,
    0.02, 0.45,
  )
  if (rng.chance(chanceP)) resolveChance(st, atkIdx, defIdx, fx, rng, atkZone / Math.max(30, defZone))

  // 4) 체력 감소: 지속 압박 가중 + 그룹 적극성 가중(기본값 전부 1.0 → 불변).
  for (const [idx, side] of [[0, st.home], [1, st.away]] as const) {
    const drain = 0.55 * fx[idx].staminaDrain * staminaWeight[idx] * groupIntensityStaminaFactor(side.tactics.groupIntensity)
    for (const { playerId } of side.tactics.lineup) {
      if (side.sentOff.includes(playerId)) continue
      const p = side.team.squad.find(q => q.id === playerId)!
      side.staminaByPlayer[playerId] = Math.max(0, side.staminaByPlayer[playerId] - drain * (100 / Math.max(40, p.stamina)))
    }
  }
}

// ── 패스 추적 ───────────────────────────────────────────────────
// `SideStats.passAccuracy`는 폐기된 전반 스크립트에서만 채워져 실전에선 항상 0이었고,
// UI가 팀 시즌 평균으로 대신 채우며 각주로 사과하고 있었다. 엔진이 직접 센다.
//
// ★ 이 계층은 경기 결과에 **아무 것도 되먹이지 않는다**(순수 계측). 게다가 아래 RNG는
//   본 스트림과 분리된 별도 시드라 찬스·파울·득점 난수 순서가 한 톨도 바뀌지 않는다.
//   → 밸런스 게이트 24개와 캘리브레이션 계약은 정의상 불변이다.
//   (되먹임을 넣으려면 지시 축 비단조성·나쁜 판단 페널티 게이트를 전부 다시 뚫어야 한다.
//    패스 성공률은 지금 UI 표시 지표일 뿐이므로 그 비용을 지불할 이유가 없다.)

/** 볼을 가진 쪽의 분당 패스 시도. */
const PASS_ATTEMPTS_ON_BALL = 8
/** 볼이 없는 쪽의 분당 패스 시도(끊어내고 나가는 짧은 전개). */
const PASS_ATTEMPTS_OFF_BALL = 3
// 합계 근거: 90분 동안 팀당 45×8 + 45×3 = 495회, 양 팀 990회.
// 실제 월드컵 경기 총 패스가 800~1,200회(팀당 400~600)라 그 한가운데다.
// 분배가 점유에 따라 갈리므로 점유율 60%인 팀은 자연히 팀당 ~570회로 올라간다.

/** 소금값 — 본 스트림 시드(seed*10007 + minute)와 절대 충돌하지 않도록 큰 소수를 더한다.
 *  10007 간격 안에서 minute(1~90)만 쓰이므로 이 오프셋은 어떤 (seed, minute) 조합에서도
 *  다른 분의 본 스트림 시드와 겹치지 않는다. */
const PASS_RNG_SALT = 5279

/** 템포를 팀 기본보다 100점 올렸을 때의 패스 성공률 상대 감소폭.
 *  실제로 조정 가능한 폭은 ±50점이라 최대 ±9%p 상당(85% → 77%)이다.
 *  빠른 템포는 더 어려운 전진 패스를 고른다는 뜻이고, 실측에서도 다이렉트 플레이 팀의
 *  패스 성공률이 점유 팀보다 8~12%p 낮다(예: 2022 잉글랜드 87% vs 모로코 76%). */
const PASS_TEMPO_COST = 0.18
/** 상대가 팀 기본보다 100점 높게 압박했을 때의 상대 감소폭. 압박이 템포보다 조금 더 아프다 —
 *  템포는 내 선택이라 선수들이 준비돼 있지만 압박은 상대가 강요하는 것이다. */
const PASS_PRESS_COST = 0.22

/** 이 분의 패스 성공 확률.
 *  ★ 기준점은 **팀 자신의 프로필 스타일**이다. statBaseline.passAccuracy는 그 팀이
 *    자기 스타일(profile.style.tempo/pressing)로 뛰었을 때의 실측치이므로, 지시가
 *    기본값이면 편차가 정확히 0이 되어 베이스라인에 그대로 수렴한다(캘리브레이션 계약).
 *    전역 중립 50을 기준으로 삼으면 스페인처럼 저템포 팀이 기본 지시만으로도
 *    베이스라인을 넘어서 버려 계약이 깨진다.
 *  ★ 체력 항은 일부러 넣지 않았다. 실측 패스 성공률은 이미 90분 내내의 피로를 포함한
 *    경기 평균이라, 체력 감쇠를 또 곱하면 모든 경기가 베이스라인 아래로 치우친다. */
function passSuccessP(side: SideState, opp: SideState): number {
  const base = side.team.statBaseline.passAccuracy / 100
  const dTempo = (side.tactics.instructions.tempo - side.team.profile.style.tempo) / 100
  const dPress = (opp.tactics.instructions.pressing - opp.team.profile.style.pressing) / 100
  return clamp(base * (1 - PASS_TEMPO_COST * dTempo - PASS_PRESS_COST * dPress), 0.35, 0.98)
}

/** 이 분의 패스 시행을 굴려 누적한다. 베르누이 시행을 실제로 굴리는 이유:
 *  기댓값만 더하면 경기 간 편차가 0이 되어 모든 경기가 소수점까지 같은 값이 된다.
 *  시행 수(팀당 ~495)의 이항 분산이 곧 실제 경기별 산포(±1.6%p)와 같은 크기다. */
function trackPasses(st: MatchState, sides: readonly [SideState, SideState], atkIdx: 0 | 1) {
  const rng = createRng(st.seed * 10007 + st.minute + PASS_RNG_SALT)
  for (const i of [0, 1] as const) {
    const attempts = i === atkIdx ? PASS_ATTEMPTS_ON_BALL : PASS_ATTEMPTS_OFF_BALL
    const p = passSuccessP(sides[i], sides[(1 - i) as 0 | 1])
    let ok = 0
    for (let k = 0; k < attempts; k++) if (rng.chance(p)) ok++
    const s = st.stats[i]
    s.passesAttempted += attempts
    s.passesCompleted += ok
    s.passAccuracy = round1((s.passesCompleted / s.passesAttempted) * 100)
  }
}

// ── 퇴장(레드카드) ──────────────────────────────────────────────
// `sentOff` 소비 로직(zoneStrength 수적 열세, 슈터·파울러·측면 전력 제외)은 완비돼 있었으나
// `red` 이벤트 **생성처가 0건**이라 게임에서 퇴장이 한 번도 일어나지 않았다(감사 §12).
//
// 직접 레드 확률 근거 — 월드컵 본선 레드카드 비율:
//   2010 남아공 17/64=0.27 · 2014 브라질 10/64=0.16 · 2018 러시아 4/64=0.06 · 2022 카타르 4/64=0.06.
//   최근 두 대회는 VAR 이후 급감했고, 5대 리그(EPL 2022-23 51/380=0.13)가 중간값이다.
//   → 경기당 합계 0.10~0.15회를 목표로 잡는다(양 팀 합).
// 그 중 2옐로:직접 레드 비율은 대략 45:55다(EPL 다년 평균). 2옐로 경로는 파울·경고
//   확률에서 자동으로 정해지므로(실측 아래), 남은 몫을 직접 레드에 배분한 값이 이 상수다.
// 파울은 경기당 25회(양 팀) 발생하고 그 88%가 경고 없이 지나가므로,
//   0.0035 × 25 × 0.88 ≈ 0.077회/경기가 직접 레드로 나온다.
const DIRECT_RED_P = 0.0035
/** 이미 경고를 받은 선수가 두 번째 경고를 받을 확률 배수.
 *  경고 없이 그대로 두면 2옐로 퇴장이 경기당 0.24회로 실제(약 0.06회)의 4배가 된다 —
 *  우리 파울러 추첨이 5개 슬롯(CB·DM·LB·RB·CM)에 가중 3을 몰아주기 때문이다.
 *  실제 축구에서 경고받은 선수는 (1) 스스로 태클을 자제하고 (2) 심판이 두 번째 카드를 아끼며
 *  (3) 감독이 우선 교체 대상으로 삼는다. 세 효과를 한 계수로 묶었다.
 *  0.3에서 2옐로 퇴장이 경기당 ≈0.07회 — 직접 레드와 합쳐 실제 월드컵 비율에 든다. */
const BOOKED_CAUTION = 0.3

/** 이 선수가 지금까지 받은 경고 수(이번 파울 포함). */
function countYellows(st: MatchState, playerId: string): number {
  let n = 0
  for (const e of st.events) if (e.type === 'yellow' && e.playerId === playerId) n++
  return n
}

/** 퇴장 처리. GK는 대상에서 제외한다 — 엔진에 교체 GK 투입 경로가 없어
 *  (`resolveChance`가 라인업의 GK 슬롯을 그대로 읽는다) 골문이 무주공산이 되는 게 아니라
 *  퇴장당한 GK가 계속 선방하는 모순이 생긴다. 필드 플레이어만 퇴장시킨다. */
function sendOff(st: MatchState, side: SideState, playerId: string) {
  const slot = side.tactics.lineup.find(l => l.playerId === playerId)
  if (!slot || slot.slot === 'GK') return
  if (side.sentOff.includes(playerId)) return
  side.sentOff.push(playerId)
  st.events.push({ minute: st.minute, type: 'red', teamId: side.team.id, playerId })
}

/** 주전(라인업, 퇴장 제외) 평균 체력. 지속 압박 저체력 판정용. */
function avgStamina(side: SideState): number {
  const vals = side.tactics.lineup
    .filter(l => !side.sentOff.includes(l.playerId))
    .map(l => side.staminaByPlayer[l.playerId] ?? 100)
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 100
}

/** GK 파워플레이가 이 분 유효한가: 활성 & 85'+ & 해당 side가 지는 중. */
function gkPowerplayActive(st: MatchState, idx: 0 | 1): boolean {
  if (!st[idx === 0 ? 'home' : 'away'].tactics.gkPowerplay) return false
  return st.minute >= 85 && st.score[idx] < st.score[(1 - idx) as 0 | 1]
}

// 전력비 → 찬스 '질' 지수. 강팀은 슛을 더 많이 쏠 뿐 아니라 더 좋은 위치에서 쏜다.
// 동급(비율 1)이면 정확히 1.0이라 동급 캘리브레이션 계약에 무영향.
const XG_STRENGTH = 0.75

// ── 표시용 xG ───────────────────────────────────────────────────
// 문제: 예전에는 `chanceQuality`(득점 확률 사슬의 내부 입력)를 그대로 stats.xg에 누적했다.
// 그 값은 엘리트 슈터 기준 0.30이라 **슛당 xG가 0.23~0.25**로 실제 축구(0.10~0.12)의 2배였고,
// 한국이 스페인 상대로 경기당 3.2 xG를 만드는 표가 나왔다. 축구를 아는 사람에겐 바로 보인다.
//
// 해법: 상수배로 눌러 맞추지 않는다. **xG의 정의 그대로**, 우리 모델 자신이 계산한
//   P(골 | 이 슛) = P(유효슛) × P(골 | 유효슛)
// 를 표시값으로 쓴다. 득점 확률 사슬(chanceQuality → goalP)은 한 줄도 바꾸지 않으므로
// 밸런스 게이트 24개와 캘리브레이션 계약은 정의상 불변이고, 표시값만 갈아끼운다.
//
// 왜 단순 상수배가 답이 아닌가 — 세 가지 이유:
//  (1) 상수배는 **경기당 xG와 득점의 관계를 보장하지 못한다.** 슛당 상수 k를 곱하면
//      경기당 xG = k × 슛수인데, 득점은 슛수 × 유효슛률 × 전환율이라 유효슛률·GK가
//      바뀌는 매치업마다 xG−득점 괴리가 제멋대로 벌어진다. 정의대로 P(골|슛)을 쓰면
//      경기당 xG는 **기대 득점 그 자체**라 실제 득점과 표본오차 안에서 일치한다.
//  (2) 상수배는 GK를 xG에 반영하지 못한다. 실제 xG는 슛 시점 정보만 쓰므로 GK 의존이
//      약하지만, 우리 모델엔 슛 위치가 없어 '기회의 질'을 대신 실어줄 축이 GK·마무리뿐이다.
//  (3) 상수배는 분포를 그대로 눌러 **큰 찬스가 사라진다.** P(골|슛)은 유효슛률(슈터 능력에
//      비례)을 한 번 더 곱하므로 슈터 품질에 대해 2차식이 되어 꼬리가 살아난다
//      (하위 슈터 0.03 ↔ 엘리트 0.25).
//
// ⚠ 한계(정직하게 남긴다): 실제 xG의 분산은 **슛 위치**가 8할을 지배한다(페널티 0.76,
//   박스 밖 중거리 0.03). 우리는 위치 모델이 없다. 여기서 위치를 흉내 내려고 난수를
//   한 겹 더 얹는 선택지도 있었지만 채택하지 않았다:
//     - 득점 판정과 독립인 난수를 xG에만 곱하면 "xG 0.5짜리 결정적 찬스"라고 표시된 슛의
//       실제 득점 확률이 그대로여서, 중계·코치 조언(DANGER_XG, XG_GAP_ALERT)이 거짓말을 한다.
//     - 득점 판정에도 같이 물리면 밸런스 게이트를 다시 뚫어야 한다.
//   그래서 **표시 xG는 모델이 실제로 믿는 확률과 항상 일치**시키고, 대신 분포가 실제보다
//   좁다는 점(대부분 0.05~0.20, 페널티급 0.7 없음)을 한계로 받아들였다. 총량은 맞고
//   슛별 서열도 맞으며, 다만 극단값이 없다.
const DISPLAY_XG_MIN = 0.01
const DISPLAY_XG_MAX = 0.95
const displayXg = (goalProbability: number) => clamp(goalProbability, DISPLAY_XG_MIN, DISPLAY_XG_MAX)

function resolveChance(st: MatchState, atkIdx: 0 | 1, defIdx: 0 | 1, fx: ReturnType<typeof instructionEffects>[], rng: Rng, strengthRatio = 1, spDepth = 0) {
  const atk = atkIdx === 0 ? st.home : st.away
  const def = defIdx === 0 ? st.home : st.away
  // P3: simulateMinute과 **같은 컨텍스트**를 써야 빈도·질·코너가 한 벌의 규칙이 된다.
  const ap = attackPatternEffects(atk.tactics.attackPattern, {
    oppLineHeight: def.team.profile.style.lineHeight,
    risk: counterRiskScale(zoneStrength(atk), zoneStrength(def)),
  })
  // GK 파워플레이 양면: 공격 측 활성 → 세트피스에 GK 가담, 찬스 퀄 +40%.
  //                    수비 측 활성 → 골문 비움, 공격 측 실점(득점) 확률 3배(역습 빈 골문).
  const qualityBoost = gkPowerplayActive(st, atkIdx) ? 1.4 : 1.0
  const goalMult = gkPowerplayActive(st, defIdx) ? 3.0 : 1.0
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

  // xG: 슈팅 능력·찬스 퀄리티 기반. 공격 패턴(through↑/longshot↓)·GK 파워플레이(공격 측 +40%) 반영.
  // 기본값(balanced·비활성)이면 ap.chanceQuality=1, qualityBoost=1 → 회귀 불변.
  // B5 attackFocus: 상대의 약한 측면으로 공략을 몰면 찬스 퀄이 오른다(balanced는 1.0).
  const af = attackFocusEffects(
    atk.tactics.instructions.attackFocus,
    flankStrength(def.tactics.lineup, def.team.squad, def.staminaByPlayer, def.sentOff),
  )
  // E1: 수비 측이 공격적 태세로 나와 있으면 내주는 찬스의 '질'이 오른다(역습은 좋은 자리에서 잡힌다).
  // 기본(balanced)은 concedeQuality=1 → 회귀 불변.
  // 주발: 슈터가 윙어일 때만 발동. 역측(인버티드)은 컷인 각으로 퀄↑·코너↓, 정측은 반대.
  // 윙어가 아니거나 양발이면 전 축 1.0 → 회귀 불변.
  const ft = footEffects(shooterSlot.slot, shooter.foot, atk.tactics.attackPattern)
  // ★ chanceQuality는 **표시용 xG가 아니다** — 득점 확률 사슬의 내부 입력(찬스의 질 지수)이다.
  //   스케일(엘리트 슈터 기준 0.30)은 밸런스 게이트·캘리브레이션이 얹혀 있으므로 건드리지 않는다.
  const chanceQuality = clamp((es.shooting / 100) * 0.35 * fx[atkIdx].chanceQuality * ap.chanceQuality * qualityBoost * af.chanceQuality * ft.chanceQuality * fx[defIdx].concedeQuality * Math.pow(strengthRatio, XG_STRENGTH), 0.02, 0.65)

  // cross는 유효슛 확률 소폭↓(컷인↓·크로스 위주). balanced는 onTargetBias=1 → 불변.
  const onTargetP = clamp((es.shooting / 140) * ap.onTargetBias, 0.25, 0.75)
  // GK 파워플레이 수비 측 활성 시 빈 골문 → 득점 확률 ×3(goalMult). 상한도 그에 맞춰 완화.
  const goalP = clamp(chanceQuality * (1.6 - gkSave / 100) * goalMult, 0.04, goalMult > 1 ? 0.95 : 0.55)
  // 표시용 xG = 이 슛이 골이 될 확률 = P(유효슛) × P(골|유효슛). 근거는 DISPLAY_XG 주석.
  const xg = displayXg(onTargetP * goalP)
  st.stats[atkIdx].xg = round2(st.stats[atkIdx].xg + xg)

  if (!rng.chance(onTargetP)) {
    st.events.push({ minute: st.minute, type: 'miss', teamId: atk.team.id, playerId: shooter.id, xg })
    // cross는 코너 획득 확률↑(cornerBias). balanced는 1 → 불변.
    if (rng.chance(clamp(0.35 * ap.cornerBias * ft.cornerBias, 0, 0.9))) awardCorner(st, atkIdx, defIdx, fx, rng, spDepth)
    return
  }
  st.stats[atkIdx].shotsOnTarget++
  if (rng.chance(goalP)) {
    st.score[atkIdx]++
    st.events.push({ minute: st.minute, type: 'goal', teamId: atk.team.id, playerId: shooter.id, xg })
    st.momentum = clamp(st.momentum + (atkIdx === 0 ? 0.35 : -0.35), -1, 1)
  } else {
    st.events.push({ minute: st.minute, type: 'save', teamId: def.team.id, playerId: gk.id, xg })
    if (rng.chance(clamp(0.45 * ap.cornerBias * ft.cornerBias, 0, 0.9))) awardCorner(st, atkIdx, defIdx, fx, rng, spDepth)
  }
}

// ── 세트피스(코너) ──────────────────────────────────────────────
// `Player.setPiece`는 312명 검수 데이터인데 엔진 참조가 0건이었다(감사 §12).
// 코너를 "스탯 한 줄"에서 "실제 득점 경로"로 바꾼다.
//
// ★ 캘리브레이션 계약 유지 방식 — 세트피스 슛은 **공짜로 얹지 않는다**.
//   코너 하나당 SP_ATTEMPT_BASE 확률로 슛이 하나 추가되므로, 그만큼 오픈플레이 찬스
//   베이스라인을 팀별로 미리 깎는다(openPlayShotFactor). 팀의 자기 코너/슛 베이스라인
//   비율로 계산하므로 팀마다 정확한 몫이 빠진다 → 총 슛 수가 실측 베이스라인에 그대로 남는다.
//   세트피스 골도 stats.shots·xg에 함께 계상된다(game-design-plan §5 요구).

/** 코너당 슛(=박스 안에서 유효한 시도)이 만들어질 기준 확률.
 *  실제 축구에서 코너의 약 1/3이 슛으로 이어진다(Opta 계열 공개 집계 30~35%).
 *  키커 능력으로 ±30% 변동한다. */
const SP_ATTEMPT_BASE = 0.38
/** 세트피스 슛의 기준 xG. 키커 setPiece 70 · 박스 위협 62 · GK aerial 62에서 이 값이다.
 *  코너 전환율(코너당 골) 목표 4~7%에 맞춰 실측으로 정한 값 — 아래 보고 참조. */
const SP_XG_BASE = 0.135
/** 세트피스가 골로 끝나지 않았을 때 상대 역습이 열릴 기준 확률(루트·박스 인원 배수 적용 전).
 *  표준 지시(far/normal)에서도 걸리므로 낮게 잡는다. heavy+near면 ×1.375. */
const SP_COUNTER_BASE = 0.05
/** 세트피스가 골로 끝나지 않았을 때 또 다른 코너로 이어질 확률(연속 코너).
 *  이 항이 없으면 openPlayShotFactor로 깎인 오픈플레이 찬스만큼 코너가 통째로 사라져
 *  경기당 코너가 9.61 → 8.21로 내려앉는다(실측). 0.45에서 9.26으로 복원된다. */
const SP_REPEAT_CORNER_P = 0.45

/** 오픈플레이 찬스 베이스라인 감쇠 계수 — 세트피스가 가져갈 슛 몫을 미리 뺀다.
 *  SP_ATTEMPT_BASE(0.38)보다 높게 잡은 이유: 세트피스는 연속 코너(SP_REPEAT_CORNER_P)로
 *  스스로 코너를 재생산하고, 코너를 베이스라인보다 많이 만드는 팀(esp 실측 +16%)에서는
 *  베이스라인 기반 보정이 실제 추가분을 다 걷어내지 못한다.
 *  실측(12팀 전 조합 1,056경기)으로 이 값을 고른 근거:
 *    - 실팀 캘리브레이션 ±25% 게이트의 최악 셀(esp 홈 슛)이 HEAD 24.6% → 22.4%로 **여유가 늘었다**
 *      (0.38이면 24.9%로 한계선에 붙는다)
 *    - 경기당 총 득점이 2.614(도입 전) → 2.623으로 사실상 동일
 *    - 경기당 코너 9.61 → 9.26, 총 슛 27.52 → 26.22
 *  하한 0.7은 코너 베이스라인이 비정상적으로 높은 팀에서 오픈플레이가 붕괴하지 않게 하는 안전장치. */
const SP_SHOT_COMPENSATION = 0.45
function openPlayShotFactor(team: Team): number {
  const { shotsPerGame, cornersPerGame } = team.statBaseline
  if (shotsPerGame <= 0) return 1
  return clamp(1 - SP_SHOT_COMPENSATION * (cornersPerGame / shotsPerGame), 0.7, 1)
}

/** 한 번의 오픈플레이 찬스에서 파생될 수 있는 세트피스 연쇄의 최대 깊이.
 *  코너 → (클리어가 다시 라인 밖) → 코너 → … 는 실제로도 일어나지만, 무한 재귀를 막고
 *  한 분에 몰리는 이벤트 수를 제한하기 위해 2단으로 끊는다. */
const MAX_SP_CHAIN = 2

/** 코너 부여 + 세트피스 해결. `spDepth`가 상한에 닿으면 세트피스를 해결하지 않는다
 *  (연쇄·재귀 가드). 세트피스 역습이 얻은 코너도 같은 카운터를 물려받는다. */
function awardCorner(st: MatchState, atkIdx: 0 | 1, defIdx: 0 | 1, fx: ReturnType<typeof instructionEffects>[], rng: Rng, spDepth: number) {
  st.stats[atkIdx].corners++
  st.events.push({ minute: st.minute, type: 'corner', teamId: (atkIdx === 0 ? st.home : st.away).team.id })
  if (spDepth < MAX_SP_CHAIN) resolveSetPiece(st, atkIdx, defIdx, fx, rng, spDepth + 1)
}

/** 박스 공중 위협 — 필드 플레이어 상위 4명의 (physical 0.6 + shooting 0.4) 평균.
 *  헤더 득점력은 제공권(physical)이 주도하되 마무리(shooting)가 거든다. 체력 반영.
 *  공격 라인 적극성은 존 전력과 **같은 배수**로 반영한다 — 앞으로 나가 있는 팀이
 *  코너에서도 더 좋은 자리를 잡는다. 전부 0이면 1.0이라 기본 동작 불변. */
function boxThreat(side: SideState): { value: number; target: Player | null } {
  const rows = side.tactics.lineup
    .filter(l => !side.sentOff.includes(l.playerId) && l.slot !== 'GK')
    .map(l => {
      const p = side.team.squad.find(q => q.id === l.playerId)!
      const es = effectiveStats(p, l.slot, side.staminaByPlayer[l.playerId])
      return { p, v: es.physical * 0.6 + es.shooting * 0.4 }
    })
    // 동점이면 id 사전순으로 끊어 결정론을 지킨다.
    .sort((a, b) => b.v - a.v || a.p.id.localeCompare(b.p.id))
  const top4 = rows.slice(0, 4)
  const avg = top4.length ? top4.reduce((s, r) => s + r.v, 0) / top4.length : 50
  return {
    value: avg * groupIntensityZoneFactor(side.tactics.groupIntensity, 'attack'),
    // 마무리하는 사람은 키커가 아니라 박스 안 최고 위협이다. RNG를 쓰지 않고
    // 결정론적으로 고른다 — 추첨을 넣으면 난수 스트림이 바뀌어 시드 회귀가 깨진다.
    target: rows[0]?.p ?? null,
  }
}

/** 코너 키커 — 출전 중 최고 setPiece. 동점이면 id 사전순(결정론). */
function setPieceTaker(side: SideState): Player | null {
  const cands = side.tactics.lineup
    .filter(l => !side.sentOff.includes(l.playerId) && l.slot !== 'GK')
    .map(l => side.team.squad.find(p => p.id === l.playerId)!)
    .sort((a, b) => b.setPiece - a.setPiece || a.id.localeCompare(b.id))
  return cands[0] ?? null
}

function resolveSetPiece(st: MatchState, atkIdx: 0 | 1, defIdx: 0 | 1, fx: ReturnType<typeof instructionEffects>[], rng: Rng, spDepth: number) {
  const atk = atkIdx === 0 ? st.home : st.away
  const def = defIdx === 0 ? st.home : st.away
  const taker = setPieceTaker(atk)
  if (!taker) return

  // 1) 시도 성립: 키커 능력이 기준(70)에서 ±30% 변동시킨다. 배송이 나쁘면 첫 수비수에 걸린다.
  const attemptP = clamp(SP_ATTEMPT_BASE * (0.7 + 0.3 * (taker.setPiece / 70)), 0.12, 0.65)
  if (!rng.chance(attemptP)) return

  const { value: threat, target } = boxThreat(atk)
  // 헤더를 마무리하는 선수(없으면 키커 자신). 키커가 곧 타깃이면 어시스트는 남기지 않는다.
  const scorer = target ?? taker
  const assist = scorer.id === taker.id ? undefined : { assistId: taker.id }
  const gkSlot = def.tactics.lineup.find(l => l.slot === 'GK')!
  const gk = def.team.squad.find(p => p.id === gkSlot.playerId)!
  const gkAerial = gk.gkStats?.aerial ?? 25
  // P4: 니어 전환은 상대 GK 제공권을, 역습 노출은 매치업 우위를 읽는다(tactics P4 주석).
  // 표준 지시(far/normal)면 두 축 모두 정확히 1.0이라 기존 결과가 그대로 유지된다.
  const sp = setPieceEffects(atk.tactics, {
    oppGkAerial: gkAerial,
    risk: counterRiskScale(zoneStrength(atk), zoneStrength(def)),
  })
  const gkSave = (gk.gkStats?.saving ?? 20) * (0.75 + 0.25 * def.staminaByPlayer[gk.id] / 100)
  // GK 제공권: 62 기준 1.0, 92면 0.90, 32면 1.10. 나오는 골키퍼가 코너를 지운다.
  const gkFactor = clamp(1 - (gkAerial - 62) / 300, 0.85, 1.15)
  // 수적 열세는 박스에 넣을 몸이 줄어든다는 뜻이다 — 퇴장 1명당 −6%(zoneStrength와 같은 계수).
  const shortage = 1 - atk.sentOff.length * 0.06
  const mark = markingFactor(def.tactics.setPiece?.marking, clamp((threat - 55) / 25, 0, 1))

  // 오픈플레이와 같은 구조: chanceQuality는 내부 입력, 표시 xG는 P(골|슛)이다.
  const chanceQuality = clamp(
    SP_XG_BASE * (taker.setPiece / 70) * (threat / 62) * gkFactor * shortage * sp.conversion * mark,
    0.02, 0.35,
  )
  const goalP = clamp(chanceQuality * (1.6 - gkSave / 100), 0.02, 0.45)
  // 세트피스에는 유효슛 관문이 없다(골 판정을 먼저 굴린다) → goalP가 곧 P(골|슛)이다.
  // 실제 코너 슛 평균 xG 0.10~0.12와 같은 구간(기본값 0.135 × 0.85 ≈ 0.115)에 떨어진다.
  const xg = displayXg(goalP)
  st.stats[atkIdx].shots++
  st.stats[atkIdx].xg = round2(st.stats[atkIdx].xg + xg)

  // 헤더는 오픈플레이보다 유효슛 비율이 낮다(각이 좁고 몸싸움 중이다) — 0.52 고정.
  if (rng.chance(goalP)) {
    st.stats[atkIdx].shotsOnTarget++
    st.score[atkIdx]++
    // detail로 세트피스 골임을 표시한다 — 중계·통계가 오픈플레이와 구분할 수 있게.
    st.events.push({ minute: st.minute, type: 'goal', teamId: atk.team.id, playerId: scorer.id, xg, detail: 'setpiece', ...assist })
    // 세트피스 골의 모멘텀 반동은 오픈플레이(0.35)보다 작게 잡는다(0.20).
    // 흐름을 뚫어낸 골이 아니라 정지 상황의 한 방이라 경기 흐름을 덜 바꾸고,
    // 모멘텀은 다음 분의 찬스 확률에 곱해져 복리로 쌓이므로 대량 득점 꼬리를 만든다
    // (0.35로 두면 esp-arg 100경기에서 한 팀 9골 경기가 나와 현실성 게이트를 깼다).
    st.momentum = clamp(st.momentum + (atkIdx === 0 ? 0.20 : -0.20), -1, 1)
    return
  }
  if (rng.chance(0.52)) {
    st.stats[atkIdx].shotsOnTarget++
    st.events.push({ minute: st.minute, type: 'save', teamId: def.team.id, playerId: gk.id, xg, detail: 'setpiece' })
  } else {
    // 빗나간 헤더에는 assistId를 붙이지 않는다 — playerStats가 이벤트 타입과 무관하게
    // assistId를 어시스트로 세므로 붙이면 '실패한 어시스트'가 기록된다.
    st.events.push({ minute: st.minute, type: 'miss', teamId: atk.team.id, playerId: scorer.id, xg, detail: 'setpiece' })
  }
  // 2) 역습 노출: 박스에 사람을 밀어넣은 대가. 표준 지시에서도 소폭 걸리고,
  //    heavy·near를 고르면 커진다. 이 역습이 얻는 코너는 다시 세트피스를 부르지 않는다(재귀 가드).
  //
  // P4: 상한을 0.2 → 0.55로 올린다. sp.counterRisk가 매치업 우위로 지수 스케일되면서
  // far/heavy · risk 2.5에서 8.5배(=0.42)에 닿는데, 0.2 상한이 그 위를 통째로 잘라
  // **대가가 상대에 따라 커지지 못하게** 막고 있었다. 표준 지시(far/normal)는 배수가 정확히
  // 1.0이라 여전히 0.05이고, 저위험 상대(rsa risk 0.40)에서도 heavy가 0.057에 그친다.
  //
  // 그리고 역습의 **질**도 함께 오른다. 박스에 여섯을 올려보낸 뒤의 역습은 3대2로 열린다 —
  // 실제 축구에서 코너 역습이 위험한 이유가 빈도가 아니라 그 수적 상황이다. 지수 0.7은
  // 확률(선형)과 이중 과금이 되지 않도록 일부만 싣되, 0.5에서는 fra far/heavy의 승점 차가
  // −0.028(페어드 SE 0.012의 2.3배)에 그쳐 게이트를 걸 수 없었기에 올린 값이다.
  if (rng.chance(clamp(SP_COUNTER_BASE * sp.counterRisk, 0, 0.55))) {
    const zsAtk = zoneStrength(def, 'attack').attack
    const zsDef = zoneStrength(atk, 'defense').defense
    const outnumbered = Math.pow(sp.counterRisk, 0.7)
    resolveChance(st, defIdx, atkIdx, fx, rng, (zsAtk / Math.max(30, zsDef)) * outnumbered, MAX_SP_CHAIN)
    return
  }
  // 3) 클리어가 다시 라인 밖으로 — 연속 코너(근거는 SP_REPEAT_CORNER_P 주석).
  if (rng.chance(SP_REPEAT_CORNER_P)) awardCorner(st, atkIdx, defIdx, fx, rng, spDepth)
}

function randomLineupPlayer(side: SideState, rng: Rng, prefer: string[]): string {
  const pool = side.tactics.lineup.filter(l => !side.sentOff.includes(l.playerId))
  const weightedPool = pool.map(l => ({ item: l.playerId, w: prefer.includes(l.slot) ? 3 : 1 }))
  return rng.weighted(weightedPool)
}

export function applyCommand(state: MatchState, sideKey: 'home' | 'away', cmd: MatchCommand): MatchState {
  const st: MatchState = structuredClone(state)
  const side = st[sideKey]
  if (cmd.type === 'sub') {
    if (side.subsUsed >= MAX_SUBS) throw new Error(`교체 한도(${MAX_SUBS}회) 초과`)
    const slot = side.tactics.lineup.find(l => l.playerId === cmd.out)
    if (!slot) throw new Error('교체 대상이 라인업에 없음')
    // 퇴장당한 선수는 교체로 메울 수 없다 — 그러면 수적 열세가 무효가 된다(실제 규정도 동일).
    if (side.sentOff.includes(cmd.out)) throw new Error('퇴장당한 선수는 교체할 수 없음')
    if (side.tactics.lineup.some(l => l.playerId === cmd.in)) throw new Error('이미 출전 중인 선수')
    // 교체 기회 판정 — 인원 상한과 별개의 규정 축이다. 상태 변경 전에 막아야
    // "기회는 초과했는데 선수는 이미 바뀐" 반쪽 상태가 남지 않는다.
    const halftimeSub = st.minute === 45
    if (!halftimeSub && side.lastSubMinute !== st.minute) {
      const windows = side.subWindowsUsed ?? 0
      if (windows >= MAX_SUB_WINDOWS) throw new Error(`교체 기회(${MAX_SUB_WINDOWS}회) 모두 사용`)
      side.subWindowsUsed = windows + 1
    }
    // 하프타임 교체도 lastSubMinute은 갱신한다 — 45분 이후 첫 교체가 새 기회임을 판정하는 데 필요하다.
    side.lastSubMinute = st.minute
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
