// src/game/matchStore.ts
import { create } from 'zustand'
import { createMatch, simulateSegment, applyCommand, type MatchCommand } from '../engine/simulate'
import { createRng } from '../engine/rng'
import type { MatchState, Team } from '../engine/types'

export type MatchPhase = 'pre' | 'playing' | 'decision' | 'halftime' | 'fulltime'
export interface DecisionPrompt { id: string; minute: number; title: string; timeLimitSec: number }

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
  startMatch(home: Team, away: Team, seed: number): void
  playTo(minute: number): void
  tickDisplay(): void
  submitCommand(side: 'home' | 'away', cmd: MatchCommand): void
  resumeFromDecision(): void
  reset(): void
}

const initial = { phase: 'pre' as MatchPhase, engine: null, displayMinute: 0, pendingDecision: null, decisionsFired: [] as number[] }

export const useMatchStore = create<MatchUIState>((set, get) => ({
  ...initial,
  startMatch: (home, away, seed) => set({ ...initial, engine: createMatch(home, away, { seed }) }),
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
  resumeFromDecision: () => {
    const { phase } = get()
    if (phase !== 'decision') throw new Error('결정 창이 아님')
    set(s => ({ phase: s.engine && s.engine.minute >= 45 ? 'playing' : s.phase, pendingDecision: null }))
  },
  reset: () => set({ ...initial }),
}))
