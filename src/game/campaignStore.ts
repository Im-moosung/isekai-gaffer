// src/game/campaignStore.ts
// 캠페인 상태 머신: 조별 3경기(cze→mex→rsa)→순위 산정→토너먼트 경로 분기→엔딩.
// 순수 상태 로직(엔진 import 없음). TeamId는 데이터 로더에서 가져온다.
import { create } from 'zustand'
import type { TeamId } from '../data/loader'
import type { DecisionEntry } from '../engine/types'

export type CampaignStage =
  | 'group1' | 'group2' | 'group3'
  | 'r32' | 'r16' | 'qf' | 'sf' | 'final'
  | 'ended'

export interface MatchRecord {
  stage: CampaignStage
  opponentId: TeamId
  score: [number, number] // [kor, 상대]
  shootout?: [number, number] // [kor, 상대] 승부차기
  decisions: DecisionEntry[] // 이 경기의 감독 개입 로그(기자회견 근거)
}

export interface CampaignState {
  seed: number
  stage: CampaignStage
  records: MatchRecord[]
  groupRank: 1 | 2 | 3 | null // 조별 종료 후 산정
  path: 'first' | 'second' | null
  fatigueCarry: Record<string, number> // 경기 종료 시 스태미나 이월
  ending: { reached: CampaignStage; champion: boolean } | null
  startCampaign(seed: number): void
  currentOpponent(): TeamId
  matchSeed(): number // seed*31 + matchIndex(진행 순 0부터)
  recordResult(
    score: [number, number],
    staminaByPlayer: Record<string, number>,
    shootout?: [number, number],
    decisions?: DecisionEntry[],
  ): void
  startingStamina(playerId: number | string): number
  reset(): void
}

// 조별 상대 순서 (역사 재현: 체코→멕시코→남아공)
const GROUP_OPPONENTS: Record<'group1' | 'group2' | 'group3', TeamId> = {
  group1: 'cze',
  group2: 'mex',
  group3: 'rsa',
}

// 토너먼트 경로별 상대 (진출 규칙: 조 1·2위만)
const FIRST_PATH: Record<'r32' | 'r16' | 'qf' | 'sf' | 'final', TeamId> = {
  r32: 'ecu', r16: 'eng', qf: 'nor', sf: 'arg', final: 'esp',
}
const SECOND_PATH: Record<'r32' | 'r16' | 'qf' | 'sf' | 'final', TeamId> = {
  r32: 'can', r16: 'mar', qf: 'fra', sf: 'esp', final: 'arg',
}

// 토너먼트 스테이지 전진 순서
const NEXT_TOURNAMENT: Record<'r32' | 'r16' | 'qf' | 'sf', 'r16' | 'qf' | 'sf' | 'final'> = {
  r32: 'r16', r16: 'qf', qf: 'sf', sf: 'final',
}

const TOURNAMENT_STAGES = ['r32', 'r16', 'qf', 'sf', 'final'] as const
type TournamentStage = (typeof TOURNAMENT_STAGES)[number]
function isTournament(s: CampaignStage): s is TournamentStage {
  return (TOURNAMENT_STAGES as readonly string[]).includes(s)
}

interface Row { pts: number; gf: number; ga: number }

// 조별 순위 산정: 타 팀 상호전적을 고정 테이블로 두고 유저 3경기 결과만 대입해
// 표준 규칙(승점→득실→다득점)으로 4팀 순위를 계산한다.
function computeKorRank(groupRecords: MatchRecord[]): 1 | 2 | 3 {
  const rows: Record<string, Row> = {}
  const ensure = (id: string): Row => (rows[id] ??= { pts: 0, gf: 0, ga: 0 })
  const play = (a: string, b: string, sa: number, sb: number) => {
    const ra = ensure(a), rb = ensure(b)
    ra.gf += sa; ra.ga += sb; rb.gf += sb; rb.ga += sa
    if (sa > sb) ra.pts += 3
    else if (sa < sb) rb.pts += 3
    else { ra.pts += 1; rb.pts += 1 }
  }

  // --- 타 팀 상호전적 고정 테이블 ---
  play('mex', 'cze', 3, 0) // 실측
  play('mex', 'rsa', 1, 0) // 실측
  play('cze', 'rsa', 1, 1) // 가상(리서치 미확정) — 무승부로 가정

  // --- 유저(kor) 3경기 결과 대입 ---
  for (const r of groupRecords) play('kor', r.opponentId, r.score[0], r.score[1])

  // 표준 정렬: 승점 → 득실차 → 다득점 → id(결정론 안정 정렬)
  const order = Object.keys(rows).sort((x, y) => {
    const rx = rows[x], ry = rows[y]
    if (ry.pts !== rx.pts) return ry.pts - rx.pts
    const gdx = rx.gf - rx.ga, gdy = ry.gf - ry.ga
    if (gdy !== gdx) return gdy - gdx
    if (ry.gf !== rx.gf) return ry.gf - rx.gf
    return x.localeCompare(y)
  })
  const rank = order.indexOf('kor') + 1
  return rank <= 1 ? 1 : rank === 2 ? 2 : 3
}

const initial = {
  seed: 0,
  stage: 'group1' as CampaignStage,
  records: [] as MatchRecord[],
  groupRank: null as 1 | 2 | 3 | null,
  path: null as 'first' | 'second' | null,
  fatigueCarry: {} as Record<string, number>,
  ending: null as { reached: CampaignStage; champion: boolean } | null,
}

export const useCampaignStore = create<CampaignState>((set, get) => ({
  ...initial,

  startCampaign: (seed) => set({ ...initial, seed }),

  currentOpponent: () => {
    const { stage, path } = get()
    if (stage === 'group1' || stage === 'group2' || stage === 'group3') {
      return GROUP_OPPONENTS[stage]
    }
    if (isTournament(stage)) {
      const table = path === 'second' ? SECOND_PATH : FIRST_PATH
      return table[stage]
    }
    throw new Error('캠페인 종료: 다음 상대 없음')
  },

  matchSeed: () => {
    const { seed, records } = get()
    return seed * 31 + records.length
  },

  recordResult: (score, staminaByPlayer, shootout, decisions = []) => {
    const state = get()
    const { stage } = state
    if (stage === 'ended') throw new Error('이미 종료된 캠페인')

    const opponentId = state.currentOpponent()
    const record: MatchRecord = { stage, opponentId, score, ...(shootout ? { shootout } : {}), decisions }
    const records = [...state.records, record]
    // 체력 이월: 이번 경기 종료 스태미나를 저장(다음 경기 시작 시 70% 회복)
    const fatigueCarry = { ...state.fatigueCarry, ...staminaByPlayer }

    // --- 조별 스테이지: 무승부 허용, 3경기 후 순위 산정 ---
    if (stage === 'group1') {
      set({ records, fatigueCarry, stage: 'group2' })
      return
    }
    if (stage === 'group2') {
      set({ records, fatigueCarry, stage: 'group3' })
      return
    }
    if (stage === 'group3') {
      const groupRecords = records.filter(r => r.stage.startsWith('group'))
      const rank = computeKorRank(groupRecords)
      if (rank === 1 || rank === 2) {
        set({ records, fatigueCarry, groupRank: rank, path: rank === 1 ? 'first' : 'second', stage: 'r32' })
      } else {
        // 3위 이하 → 즉시 탈락 엔딩
        set({ records, fatigueCarry, groupRank: 3, stage: 'ended', ending: { reached: 'group3', champion: false } })
      }
      return
    }

    // --- 토너먼트 스테이지: 무승부면 shootout 필수, 패배 즉시 엔딩 ---
    const [korG, oppG] = score
    let won: boolean
    if (korG > oppG) won = true
    else if (korG < oppG) won = false
    else {
      if (!shootout) throw new Error('토너먼트 무승부는 승부차기(shootout) 결과가 필요합니다')
      won = shootout[0] > shootout[1]
    }

    if (!won) {
      set({ records, fatigueCarry, stage: 'ended', ending: { reached: stage, champion: false } })
      return
    }
    if (stage === 'final') {
      set({ records, fatigueCarry, stage: 'ended', ending: { reached: 'final', champion: true } })
      return
    }
    set({ records, fatigueCarry, stage: NEXT_TOURNAMENT[stage as 'r32' | 'r16' | 'qf' | 'sf'] })
  },

  // 다음 경기 시작 스태미나: 이월값 + (100-이월값)*0.7 (70% 회복). 미기록/첫 경기는 100.
  startingStamina: (playerId) => {
    const carry = get().fatigueCarry[String(playerId)]
    if (carry === undefined) return 100
    return Math.min(100, carry + (100 - carry) * 0.7)
  },

  reset: () => set({ ...initial }),
}))
