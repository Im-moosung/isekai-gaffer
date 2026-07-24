// src/game/matchStore.ts
import { create } from 'zustand'
import { createMatch, simulateSegment, applyCommand, type MatchCommand } from '../engine/simulate'
import type { DecisionEntry, Instructions, MatchEvent, MatchState, TacticState, Team } from '../engine/types'
import { breakSchedule, detectMoment, type DecisionMoment, type HydrationSchedule } from './matchSession'

/** 재생 세션 상태 머신.
 *  - 'pre'          킥오프 대기
 *  - 'playing'      분 단위 재생 중(UI 타이머가 advanceMinute 호출)
 *  - 'paused-break' 하이드레이션 브레이크 자동 정지
 *  - 'paused-user'  유저 자유 일시정지(감독 타임)
 *  - 'paused-moment'동적 순간 제안을 수락해 정지
 *  - 'halftime'     하프타임 정지
 *  - 'fulltime'     경기 종료 */
export type MatchPhase = 'pre' | 'playing' | 'paused-break' | 'paused-user' | 'paused-moment' | 'halftime' | 'fulltime'

/** 정지 사유. moment는 동적 순간을 수락한 경우만. */
export type PauseReason =
  | { kind: 'hydration1' | 'halftime' | 'hydration2' | 'user' }
  | { kind: 'moment'; moment: DecisionMoment }

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

/** 개입 직후 지시 효과 부스트 지속(분). 엔진 전달은 Phase 4A Task 4. */
const BOOST_MINUTES = 8

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

/** 개입(submitCommand/applyTeamTalk)이 허용되는 phase. */
const INTERVENTION_PHASES: MatchPhase[] = ['paused-break', 'paused-user', 'paused-moment', 'halftime']

/** 홈 주전(라인업, 퇴장 제외) 중 최저 스태미나. 동적 순간 'fatigue' 판정용. */
function homeStaminaFloor(engine: MatchState): number {
  const home = engine.home
  const vals = home.tactics.lineup
    .filter(l => !home.sentOff.includes(l.playerId))
    .map(l => home.staminaByPlayer[l.playerId] ?? 100)
  return vals.length ? Math.min(...vals) : 100
}

export interface MatchUIState {
  phase: MatchPhase
  engine: MatchState | null
  /** 하이드레이션 브레이크 스케줄(startMatch 시 시드로 결정). */
  schedule: HydrationSchedule | null
  /** 현재 정지 사유(정지 중일 때만). */
  pauseReason: PauseReason | null
  /** 재생 중 감지된 동적 순간 제안(수락 전). null이면 제안 없음. */
  momentPrompt: DecisionMoment | null
  /** 이미 발동한 동적 순간 유형(유형당 1회 제한). */
  firedMoments: DecisionMoment['kind'][]
  /** 개입 부스트 만료 분(그 분까지 지시 효과 부스트). 엔진 전달은 Task 4. */
  boostUntil: number
  /** 하프타임 팀토크 1회 제한 플래그. */
  talked: boolean
  /** 감독 개입 로그 — 기자회견 근거. startMatch/reset 시 초기화. */
  decisionLog: DecisionEntry[]
  startMatch(home: Team, away: Team, seed: number, opts?: StartMatchOpts): void
  /** 킥오프 — 'pre'에서 재생 시작('playing'). */
  kickoff(): void
  /** 1분 재생 스텝(UI 타이머가 호출). 브레이크·하프타임 도달 시 자동 정지,
   *  동적 순간 감지 시 정지하지 않고 momentPrompt만 세팅(재생 계속). */
  advanceMinute(): void
  /** 유저 자유 일시정지(감독 타임). */
  pauseByUser(): void
  /** 전술 확정 — 모든 정지 상태에서 재개. 부스트 만료 분 설정. */
  confirmTactics(): void
  /** 동적 순간 제안 수락 → 'paused-moment'로 정지. */
  acceptMoment(): void
  /** 동적 순간 제안 무시(재생 계속). */
  dismissMoment(): void
  submitCommand(side: 'home' | 'away', cmd: MatchCommand): void
  applyTeamTalk(side: 'home' | 'away', tone: TeamTalkTone): void
  logShootoutSetup(summary: string): void
  reset(): void
}

const initial = {
  phase: 'pre' as MatchPhase,
  engine: null as MatchState | null,
  schedule: null as HydrationSchedule | null,
  pauseReason: null as PauseReason | null,
  momentPrompt: null as DecisionMoment | null,
  firedMoments: [] as DecisionMoment['kind'][],
  boostUntil: 0,
  talked: false,
  decisionLog: [] as DecisionEntry[],
}

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
    set({ ...initial, engine, schedule: breakSchedule(seed) })
  },
  kickoff: () => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'pre') return
    set({ phase: 'playing' })
  },
  advanceMinute: () => {
    const { engine, phase, schedule, firedMoments, momentPrompt } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'playing') return // 정지 중엔 재개(confirmTactics)로만 진행
    const prevScore: [number, number] = [engine.score[0], engine.score[1]]
    const next = simulateSegment(engine, engine.minute + 1)
    const minute = next.minute

    if (minute >= 90) {
      set({ engine: next, phase: 'fulltime', pauseReason: null, momentPrompt: null })
      return
    }
    if (minute === 45) {
      set({ engine: next, phase: 'halftime', pauseReason: { kind: 'halftime' } })
      return
    }
    if (schedule && minute === schedule.firstHydration) {
      set({ engine: next, phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
      return
    }
    if (schedule && minute === schedule.secondHydration) {
      set({ engine: next, phase: 'paused-break', pauseReason: { kind: 'hydration2' } })
      return
    }

    // 동적 순간 감지 — 정지하지 않고 제안(momentPrompt)만 세팅. 유형당 1회.
    // 이미 다른 제안이 떠 있으면(momentPrompt 존재) 덮어쓰지 않는다.
    if (!momentPrompt) {
      const moment = detectMoment(
        next.events, minute, next.score, prevScore, homeStaminaFloor(next),
        { homeId: next.home.team.id, awayId: next.away.team.id },
      )
      if (moment && !firedMoments.includes(moment.kind)) {
        set({ engine: next, momentPrompt: moment, firedMoments: [...firedMoments, moment.kind] })
        return
      }
    }
    set({ engine: next })
  },
  pauseByUser: () => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'playing') return
    set({ phase: 'paused-user', pauseReason: { kind: 'user' } })
  },
  confirmTactics: () => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (!INTERVENTION_PHASES.includes(phase)) throw new Error('개입 중이 아님')
    // 개입 직후 부스트: 지금부터 BOOST_MINUTES분간 지시 효과 강화(엔진 전달은 Task 4).
    set({ phase: 'playing', pauseReason: null, momentPrompt: null, boostUntil: engine.minute + BOOST_MINUTES })
  },
  acceptMoment: () => {
    const { phase, momentPrompt } = get()
    if (phase !== 'playing') throw new Error('재생 중이 아님')
    if (!momentPrompt) throw new Error('제안된 순간이 없음')
    set({ phase: 'paused-moment', pauseReason: { kind: 'moment', moment: momentPrompt } })
  },
  dismissMoment: () => set({ momentPrompt: null }),
  submitCommand: (side, cmd) => {
    const { engine, phase, decisionLog } = get()
    if (!engine) throw new Error('경기 미시작')
    if (!INTERVENTION_PHASES.includes(phase)) throw new Error('개입 불가 시점')
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
  reset: () => set({ ...initial }),
}))
