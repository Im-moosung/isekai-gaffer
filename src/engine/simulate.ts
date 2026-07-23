// src/engine/simulate.ts
import { createRng, type Rng } from './rng'
import { zoneStrength } from './strength'
import { instructionEffects, formationEdge } from './tactics'
import { effectiveStats } from './fitness'
import { pickBestXI } from './lineup'
import type { Instructions, MatchState, SideState, TacticState, Team } from './types'

export type MatchCommand =
  | { type: 'sub'; out: string; in: string }
  | { type: 'instructions'; instructions: Instructions }
  | { type: 'formation'; tactics: TacticState }

const MAX_SUBS = 5
// 전력 차 민감도 — 동급 팀은 비율 1이라 캘리브레이션 계약 무영향, 비대칭 매치업의 승률 분화 담당.
// 실데이터 검증(esp≥55승) 기준으로 튜닝.
const STRENGTH_SENSITIVITY = 1.6

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
    seed: opts.seed,
  }
}

function emptyStats() { return { possession: 50, passAccuracy: 0, shots: 0, shotsOnTarget: 0, fouls: 0, corners: 0, xg: 0 } }

function defaultTactics(team: Team): TacticState {
  // fixtures의 pickBestXI와 동일 로직 (lineup.ts 공유). 프로필 스타일을 지시로 반영.
  const t = pickBestXI(team)
  t.instructions = {
    lineHeight: team.profile.style.lineHeight, pressing: team.profile.style.pressing,
    tempo: team.profile.style.tempo, attackFocus: 'balanced',
  }
  return t
}

export function simulateSegment(state: MatchState, toMinute: number): MatchState {
  const st: MatchState = structuredClone(state)
  while (st.minute < toMinute) {
    st.minute++
    // 분 파생 RNG: 세그먼트 분할 지점과 무관하게 같은 분은 같은 난수 → 45+45=90 결정론
    const rng = createRng(st.seed * 10007 + st.minute)
    simulateMinute(st, rng)
    if (st.minute === 45) st.events.push({ minute: 45, type: 'halftime', teamId: st.home.team.id })
  }
  if (toMinute >= 90 && !st.events.some(e => e.type === 'fulltime'))
    st.events.push({ minute: 90, type: 'fulltime', teamId: st.home.team.id })
  return st
}

function simulateMinute(st: MatchState, rng: Rng) {
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
    if (rng.chance(0.12)) st.events.push({ minute: st.minute, type: 'yellow', teamId: def.team.id, playerId: fouler })
  }

  // 3) 찬스 롤 (공격 측): 공격 전력 vs 수비 전력 + 템포 + 모멘텀
  const momentumBoost = atkIdx === 0 ? 1 + st.momentum * 0.15 : 1 - st.momentum * 0.15
  const chanceP = clamp(
    (atk.team.statBaseline.shotsPerGame / (90 * participation)) * Math.pow(zs[atkIdx].attack / Math.max(30, zs[defIdx].defense), STRENGTH_SENSITIVITY) * fx[atkIdx].chanceRate * fx[defIdx].counterVulnerability * momentumBoost,
    0.02, 0.45,
  )
  if (rng.chance(chanceP)) resolveChance(st, atkIdx, defIdx, fx, rng)

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

function resolveChance(st: MatchState, atkIdx: 0 | 1, defIdx: 0 | 1, fx: ReturnType<typeof instructionEffects>[], rng: Rng) {
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
