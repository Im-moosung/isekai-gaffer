// src/engine/simulate.ts
import { createRng, type Rng } from './rng'
import { zoneStrength } from './strength'
import { instructionEffects, formationEdge, mentalityEffects, attackPatternEffects, groupIntensityStaminaFactor, attackFocusEffects, type MatchupContext } from './tactics'
import { effectiveStats } from './fitness'
import { pickBestXI } from './lineup'
import type { Instructions, MatchEvent, MatchState, SideState, SideStats, TacticState, Team } from './types'

export type MatchCommand =
  | { type: 'sub'; out: string; in: string }
  | { type: 'instructions'; instructions: Instructions }
  | { type: 'formation'; tactics: TacticState }

/** simulateSegment 옵션. 미지정이면 기존 동작(회귀 불변). */
export interface SimulateOpts {
  /** 개입 직후 부스트: 지정 side에 until 분까지 고정 보너스(찬스 퀄 +8%·실점 위험 −6%). */
  instructionBoost?: { side: 'home' | 'away'; until: number }
}

const MAX_SUBS = 5
// 전력 차 민감도 — 동급 팀은 비율 1이라 캘리브레이션 계약 무영향, 비대칭 매치업의 승률 분화 담당.
// 실데이터 검증(esp≥55승) 기준으로 튜닝.
// 이 값은 '기회의 양'만 늘린다. 슛 수는 ±15%(동급)/±25%(실팀) 캘리브레이션 계약에 묶여 있어
// 여기만 올리면 전력 서열 게이트와 정면충돌한다. 그래서 전력 차의 나머지 절반은
// XG_STRENGTH가 '기회의 질'로 싣는다 — 슛 수를 건드리지 않고 서열을 벌리는 축이다.
const STRENGTH_SENSITIVITY = 1.6

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

function emptyStats() { return { possession: 50, passAccuracy: 0, shots: 0, shotsOnTarget: 0, fouls: 0, corners: 0, xg: 0 } }

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
  st.stats = ([0, 1] as const).map(i => ({
    possession: round1(possTotal > 0 ? (bl[i].possession / possTotal) * 100 : 50),
    passAccuracy: bl[i].passAccuracy,
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
 *  left: 우리가 왼쪽을 공략 → 상대의 오른쪽 수비(RB/RW)를 만난다. 좌우가 뒤집히는 점에 주의. */
function flankStrength(def: SideState): { left: number; right: number; center: number } {
  const pick = (slots: string[]) => {
    const vals = def.tactics.lineup
      .filter(l => !def.sentOff.includes(l.playerId) && slots.includes(l.slot))
      .map(l => {
        const p = def.team.squad.find(q => q.id === l.playerId)!
        const es = effectiveStats(p, l.slot, def.staminaByPlayer[l.playerId])
        return (es.defending + es.physical + es.pace) / 3
      })
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 55
  }
  return { left: pick(['RB', 'RW']), right: pick(['LB', 'LW']), center: pick(['CB', 'DM']) }
}

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
    fx[i].chanceRate *= m.chanceRate
    fx[i].chanceQuality *= m.chanceQuality
    fx[i].counterVulnerability *= m.counterVulnerability
    fx[i].possessionBias *= m.possessionBias
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
    if (rng.chance(tired ? 0.18 : 0.12)) st.events.push({ minute: st.minute, type: 'yellow', teamId: def.team.id, playerId: fouler })
  }

  // 3) 찬스 롤 (공격 측): 공격 전력(공격 페이즈) vs 수비 전력(수비 페이즈) + 템포 + 모멘텀 + 공격 패턴
  //    phaseFormations 미지정·groupIntensity 0이면 phase 존은 neutral과 동일 → 회귀 불변.
  const atkZone = zoneStrength(atk, 'attack').attack
  const defZone = zoneStrength(def, 'defense').defense
  const ap = attackPatternEffects(atk.tactics.attackPattern)
  const momentumBoost = atkIdx === 0 ? 1 + st.momentum * 0.15 : 1 - st.momentum * 0.15
  // 수비 측의 suppression(하이라인·하이프레스로 상대 전개를 끊는 항)이 공격 측 찬스를 억제한다.
  const chanceP = clamp(
    (atk.team.statBaseline.shotsPerGame / (90 * participation)) * Math.pow(atkZone / Math.max(30, defZone), STRENGTH_SENSITIVITY) * fx[atkIdx].chanceRate * ap.chanceRate * fx[defIdx].counterVulnerability * fx[defIdx].suppression * momentumBoost,
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

function resolveChance(st: MatchState, atkIdx: 0 | 1, defIdx: 0 | 1, fx: ReturnType<typeof instructionEffects>[], rng: Rng, strengthRatio = 1) {
  const atk = atkIdx === 0 ? st.home : st.away
  const def = defIdx === 0 ? st.home : st.away
  const ap = attackPatternEffects(atk.tactics.attackPattern)
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
  const af = attackFocusEffects(atk.tactics.instructions.attackFocus, flankStrength(def))
  const xg = clamp((es.shooting / 100) * 0.35 * fx[atkIdx].chanceQuality * ap.chanceQuality * qualityBoost * af.chanceQuality * Math.pow(strengthRatio, XG_STRENGTH), 0.02, 0.65)
  st.stats[atkIdx].xg = round2(st.stats[atkIdx].xg + xg)

  // cross는 유효슛 확률 소폭↓(컷인↓·크로스 위주). balanced는 onTargetBias=1 → 불변.
  const onTargetP = clamp((es.shooting / 140) * ap.onTargetBias, 0.25, 0.75)
  if (!rng.chance(onTargetP)) {
    st.events.push({ minute: st.minute, type: 'miss', teamId: atk.team.id, playerId: shooter.id, xg })
    // cross는 코너 획득 확률↑(cornerBias). balanced는 1 → 불변.
    if (rng.chance(clamp(0.35 * ap.cornerBias, 0, 0.9))) { st.stats[atkIdx].corners++; st.events.push({ minute: st.minute, type: 'corner', teamId: atk.team.id }) }
    return
  }
  st.stats[atkIdx].shotsOnTarget++
  // GK 파워플레이 수비 측 활성 시 빈 골문 → 득점 확률 ×3(goalMult). 상한도 그에 맞춰 완화.
  const goalP = clamp(xg * (1.6 - gkSave / 100) * goalMult, 0.04, goalMult > 1 ? 0.95 : 0.55)
  if (rng.chance(goalP)) {
    st.score[atkIdx]++
    st.events.push({ minute: st.minute, type: 'goal', teamId: atk.team.id, playerId: shooter.id, xg })
    st.momentum = clamp(st.momentum + (atkIdx === 0 ? 0.35 : -0.35), -1, 1)
  } else {
    st.events.push({ minute: st.minute, type: 'save', teamId: def.team.id, playerId: gk.id, xg })
    if (rng.chance(clamp(0.45 * ap.cornerBias, 0, 0.9))) { st.stats[atkIdx].corners++; st.events.push({ minute: st.minute, type: 'corner', teamId: atk.team.id }) }
  }
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
