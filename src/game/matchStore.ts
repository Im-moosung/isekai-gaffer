// src/game/matchStore.ts
import { create } from 'zustand'
import { createMatch, simulateSegment, applyCommand, type MatchCommand } from '../engine/simulate'
import { createRng } from '../engine/rng'
import type { MatchEvent, MatchState, TacticState, Team } from '../engine/types'

export type MatchPhase = 'pre' | 'playing' | 'decision' | 'halftime' | 'fulltime'
export interface DecisionPrompt { id: string; minute: number; title: string; timeLimitSec: number }

/** 하프타임 팀토크 4톤. */
export type TeamTalkTone = 'rage' | 'encourage' | 'calm' | 'trust'
/** 팀 관점 스코어 상황. */
export type ScoreSituation = 'losing' | 'drawing' | 'winning'

/** 결정론 사기 보정 테이블 — 스코어 상황 × 톤 (moraleByPlayer 일괄 가감치).
 *  랜덤 없이 상황·톤만으로 결과가 정해진다(재현성). */
export const TEAM_TALK_TABLE: Record<ScoreSituation, Record<TeamTalkTone, number>> = {
  losing:  { rage: 8, encourage: 5, calm: 2, trust: 3 },
  drawing: { rage: 3, encourage: 5, calm: 4, trust: 4 },
  winning: { rage: -4, encourage: 2, calm: 6, trust: 5 },
}

/** 팀 관점(side)에서 현재 스코어 상황을 판정한다. */
export function scoreSituation(score: [number, number], side: 'home' | 'away'): ScoreSituation {
  const [own, opp] = side === 'home' ? [score[0], score[1]] : [score[1], score[0]]
  if (own < opp) return 'losing'
  if (own > opp) return 'winning'
  return 'drawing'
}

export interface StartMatchOpts {
  homeTactics?: TacticState
  firstHalfScript?: { events: MatchEvent[]; score: [number, number] }
  /** 체력 이월: 지정된 선수의 홈 시작 스태미나를 100 대신 이 값으로 덮어쓴다. */
  staminaOverride?: Record<string, number>
}

function decisionMinutes(seed: number): number[] {
  const rng = createRng(seed ^ 0xdec1)
  return [rng.int(55, 68), rng.int(72, 84)]
}

export interface MatchUIState {
  phase: MatchPhase
  engine: MatchState | null
  displayMinute: number
  pendingDecision: DecisionPrompt | null
  decisionsFired: number[]
  /** 하프타임 팀토크 1회 제한 플래그. */
  talked: boolean
  startMatch(home: Team, away: Team, seed: number, opts?: StartMatchOpts): void
  playTo(minute: number): void
  tickDisplay(): void
  submitCommand(side: 'home' | 'away', cmd: MatchCommand): void
  applyTeamTalk(side: 'home' | 'away', tone: TeamTalkTone): void
  resumeFromDecision(): void
  reset(): void
}

const initial = { phase: 'pre' as MatchPhase, engine: null, displayMinute: 0, pendingDecision: null, decisionsFired: [] as number[], talked: false }

export const useMatchStore = create<MatchUIState>((set, get) => ({
  ...initial,
  startMatch: (home, away, seed, opts) => {
    const engine = createMatch(home, away, {
      seed,
      ...(opts?.homeTactics ? { homeTactics: opts.homeTactics } : {}),
      ...(opts?.firstHalfScript ? { firstHalfScript: opts.firstHalfScript } : {}),
    })
    // 체력 이월: createMatch는 전원 100으로 초기화하므로, 지정 선수만 이월값으로 덮어쓴다.
    if (opts?.staminaOverride) {
      for (const [id, v] of Object.entries(opts.staminaOverride)) {
        if (id in engine.home.staminaByPlayer) engine.home.staminaByPlayer[id] = v
      }
    }
    set({ ...initial, engine })
  },
  playTo: (minute) => {
    const { engine, decisionsFired } = get()
    if (!engine) throw new Error('경기 미시작')
    const triggers = decisionMinutes(engine.seed)
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
  applyTeamTalk: (side, tone) => {
    const { engine, phase, talked } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'halftime') throw new Error('팀토크는 하프타임에만 가능')
    if (talked) throw new Error('팀토크는 경기당 1회만 가능')
    const situation = scoreSituation(engine.score, side)
    const delta = TEAM_TALK_TABLE[situation][tone]
    const next = structuredClone(engine)
    const morale = next[side].moraleByPlayer
    for (const id of Object.keys(morale)) {
      morale[id] = Math.max(0, Math.min(100, morale[id] + delta))
    }
    set({ engine: next, talked: true })
  },
  resumeFromDecision: () => {
    const { phase } = get()
    if (phase !== 'decision') throw new Error('결정 창이 아님')
    set(s => ({ phase: s.engine && s.engine.minute >= 45 ? 'playing' : s.phase, pendingDecision: null }))
  },
  reset: () => set({ ...initial }),
}))
