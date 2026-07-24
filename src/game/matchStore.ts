// src/game/matchStore.ts
import { create } from 'zustand'
import { createMatch, simulateSegment, applyCommand, type MatchCommand } from '../engine/simulate'
import { createRng } from '../engine/rng'
import type { DecisionEntry, Instructions, MatchEvent, MatchState, TacticState, Team } from '../engine/types'

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

/** 지시 축 한국어 라벨. attackFocus는 값도 한글로 매핑. */
const INSTRUCTION_LABEL: Record<keyof Instructions, string> = {
  lineHeight: '라인', pressing: '압박', tempo: '템포', attackFocus: '공격',
}
const ATTACK_FOCUS_KO: Record<Instructions['attackFocus'], string> = {
  left: '좌', center: '중앙', right: '우', balanced: '균형',
}
function fmtAxis(v: number | string): string {
  return typeof v === 'number' ? String(v) : (ATTACK_FOCUS_KO[v as Instructions['attackFocus']] ?? v)
}
/** 바뀐 지시 축만 "압박 55→90" 형식으로 나열. */
function instructionDiff(before: Instructions, after: Instructions): string[] {
  const keys: (keyof Instructions)[] = ['lineHeight', 'pressing', 'tempo', 'attackFocus']
  return keys
    .filter(k => before[k] !== after[k])
    .map(k => `${INSTRUCTION_LABEL[k]} ${fmtAxis(before[k])}→${fmtAxis(after[k])}`)
}

/** 팀토크 톤 한국어 라벨(로그 요약용). */
const TONE_LABEL: Record<TeamTalkTone, string> = {
  rage: '격노', encourage: '격려', calm: '침착', trust: '신뢰',
}

export interface MatchUIState {
  phase: MatchPhase
  engine: MatchState | null
  displayMinute: number
  pendingDecision: DecisionPrompt | null
  decisionsFired: number[]
  /** 하프타임 팀토크 1회 제한 플래그. */
  talked: boolean
  /** 감독 개입 로그 — 기자회견 근거. startMatch/reset 시 초기화. */
  decisionLog: DecisionEntry[]
  startMatch(home: Team, away: Team, seed: number, opts?: StartMatchOpts): void
  playTo(minute: number): void
  tickDisplay(): void
  submitCommand(side: 'home' | 'away', cmd: MatchCommand): void
  applyTeamTalk(side: 'home' | 'away', tone: TeamTalkTone): void
  logShootoutSetup(summary: string): void
  resumeFromDecision(): void
  reset(): void
}

const initial = { phase: 'pre' as MatchPhase, engine: null, displayMinute: 0, pendingDecision: null, decisionsFired: [] as number[], talked: false, decisionLog: [] as DecisionEntry[] }

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
    const { engine, phase, decisionLog } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'halftime' && phase !== 'decision') throw new Error('개입 불가 시점')
    const minute = engine.minute
    const sideState = engine[side]
    let entry: DecisionEntry | null = null
    if (cmd.type === 'instructions') {
      const changed = instructionDiff(sideState.tactics.instructions, cmd.instructions)
      // 변경 축이 0개면 로그 스킵(엔진 적용은 그대로) — "45' 지시 변경: " 같은 빈 요약 방지.
      if (changed.length > 0) {
        entry = { minute, kind: 'instructions', summary: `${minute}' 지시 변경: ${changed.join(', ')}`, detail: { changed } }
      }
    } else if (cmd.type === 'sub') {
      const nameOf = (id: string) => sideState.team.squad.find(p => p.id === id)?.name.ko ?? id
      entry = { minute, kind: 'sub', summary: `${minute}' 교체: ${nameOf(cmd.in)} IN, ${nameOf(cmd.out)} OUT`, detail: { in: cmd.in, out: cmd.out } }
    } else if (cmd.type === 'formation') {
      const before = sideState.tactics.formation, after = cmd.tactics.formation
      entry = { minute, kind: 'instructions', summary: `HT 포메이션: ${before}→${after}`, detail: { before, after } }
    }
    set({
      engine: applyCommand(engine, side, cmd),
      ...(entry ? { decisionLog: [...decisionLog, entry] } : {}),
    })
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
    const entry: DecisionEntry = {
      minute: engine.minute, kind: 'teamtalk',
      summary: `HT 팀토크: ${TONE_LABEL[tone]}`, detail: { tone, situation, delta },
    }
    set({ engine: next, talked: true, decisionLog: [...get().decisionLog, entry] })
  },
  logShootoutSetup: (summary) => {
    const { engine, decisionLog } = get()
    const entry: DecisionEntry = { minute: engine?.minute ?? 90, kind: 'shootout-setup', summary }
    set({ decisionLog: [...decisionLog, entry] })
  },
  resumeFromDecision: () => {
    const { phase } = get()
    if (phase !== 'decision') throw new Error('결정 창이 아님')
    set(s => ({ phase: s.engine && s.engine.minute >= 45 ? 'playing' : s.phase, pendingDecision: null }))
  },
  reset: () => set({ ...initial }),
}))
