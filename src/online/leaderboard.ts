// src/online/leaderboard.ts
// 리더보드 점수 계산 + 제출/조회 (Supabase ↔ localStorage 폴백).
// 설계 §7 폴백 원칙: 키 부재·네트워크·테이블 오류 등 "어떤 실패든" localStorage로 100% 동작한다.
// supabase 클라이언트는 lazy 생성 — 모듈 로드 시점에 env가 없어도 크래시하지 않는다.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Team } from '../engine/types'
import type { CampaignStage, MatchRecord } from '../game/campaignStore'
import type { TeamId } from '../data/loader'

// ── 점수 계산 ──────────────────────────────────────────────
/** 점수 브레이크다운 — 항목별 소계 + 합계 + 도달 라운드/우승 여부. */
export interface ScoreBreakdown {
  roundPts: number       // 도달 라운드 점수
  matchPts: number       // 승점(승3/무1)×10
  goalDiffPts: number    // 득실차×5 (음수 허용)
  upsetPts: number       // 업셋 보너스(FIFA 랭킹차 기반)
  cleanSheetPts: number  // 무실점 경기당 30
  total: number
  reached: CampaignStage
  champion: boolean
}

export interface Ending { reached: CampaignStage; champion: boolean }

/** 도달 라운드(탈락 라운드 기준) → 점수. champion이면 별도 1200. */
const ROUND_PTS: Record<CampaignStage, number> = {
  group1: 0, group2: 0, group3: 0,
  r32: 100, r16: 200, qf: 350, sf: 550, final: 800,
  ended: 0,
}
const CHAMPION_PTS = 1200

/** 업셋 인정 랭킹 경계(한국 랭킹 25 미만 = 상위 팀). */
const UPSET_THRESHOLD = 25

const TOURNAMENT_STAGES: readonly CampaignStage[] = ['r32', 'r16', 'qf', 'sf', 'final']
function isTournament(s: CampaignStage): boolean {
  return TOURNAMENT_STAGES.includes(s)
}

/** 규정시간 결과(승부차기 무관): 승/무/패. */
function regulation(r: MatchRecord): 'win' | 'draw' | 'loss' {
  const [kor, opp] = r.score
  if (kor > opp) return 'win'
  if (kor < opp) return 'loss'
  return 'draw'
}

/** 승리 여부(승부차기 포함) — 업셋 판정용. */
function wonIncludingShootout(r: MatchRecord): boolean {
  const [kor, opp] = r.score
  if (kor > opp) return true
  if (kor === opp && r.shootout) return r.shootout[0] > r.shootout[1]
  return false
}

/**
 * 캠페인 기록으로 점수를 계산한다(순수 함수).
 * - 라운드: group탈락 0 / r32 100 / r16 200 / qf 350 / sf 550 / final 800 / champion 1200
 * - 승점: 승3·무1 합산 ×10 (승부차기 승은 규정상 무 = 1점)
 * - 득실차: (총득점-총실점) ×5 (음수 허용)
 * - 업셋: 승리(승부차기 포함)한 상대의 fifaRanking<25면 (25-랭킹)×(조별1/토너먼트2) 합산
 * - 무실점: 상대 득점 0인 경기당 30
 */
export function computeScore(
  records: MatchRecord[],
  ending: Ending,
  opponents: Record<TeamId, Team>,
): ScoreBreakdown {
  const roundPts = ending.champion ? CHAMPION_PTS : ROUND_PTS[ending.reached]

  let ptsRaw = 0
  let gf = 0
  let ga = 0
  let upsetPts = 0
  let cleanSheetPts = 0

  for (const r of records) {
    const [kor, opp] = r.score
    gf += kor
    ga += opp

    const res = regulation(r)
    if (res === 'win') ptsRaw += 3
    else if (res === 'draw') ptsRaw += 1

    if (opp === 0) cleanSheetPts += 30

    if (wonIncludingShootout(r)) {
      const ranking = opponents[r.opponentId]?.fifaRanking
      if (typeof ranking === 'number' && ranking < UPSET_THRESHOLD) {
        const weight = isTournament(r.stage) ? 2 : 1
        upsetPts += (UPSET_THRESHOLD - ranking) * weight
      }
    }
  }

  const matchPts = ptsRaw * 10
  const goalDiffPts = (gf - ga) * 5
  const total = roundPts + matchPts + goalDiffPts + upsetPts + cleanSheetPts

  return {
    roundPts, matchPts, goalDiffPts, upsetPts, cleanSheetPts, total,
    reached: ending.reached, champion: ending.champion,
  }
}

// ── 리더보드 제출/조회 ─────────────────────────────────────
export type LeaderboardMode = 'supabase' | 'local'

export interface LeaderboardRow {
  nickname: string
  total: number
  reached: CampaignStage
  champion: boolean
  created_at?: string
}

const TABLE = 'leaderboard'
const LOCAL_KEY = 'rematch-leaderboard'
const LOCAL_MAX = 50

// ── Supabase lazy 클라이언트 ───────────────────────────────
let cachedClient: SupabaseClient | null | undefined

function readEnv(name: string): string | undefined {
  // import.meta.env(빌드 시 주입)를 우선 확인하고, 없으면 process.env로 폴백한다.
  // 방어적으로 접근 — 어느 쪽도 없어도 크래시하지 않는다.
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
  const fromMeta = metaEnv?.[name]
  if (fromMeta) return fromMeta
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return proc?.env?.[name]
}

function getClient(): SupabaseClient | null {
  if (cachedClient !== undefined) return cachedClient
  const url = readEnv('VITE_SUPABASE_URL')
  const key = readEnv('VITE_SUPABASE_ANON_KEY')
  if (url && key) {
    try {
      cachedClient = createClient(url, key)
    } catch {
      cachedClient = null
    }
  } else {
    cachedClient = null
  }
  return cachedClient
}

/** 테스트 격리용 — 캐시된 클라이언트를 초기화한다. */
export function _resetClientForTest(): void {
  cachedClient = undefined
}

// ── localStorage 폴백 ──────────────────────────────────────
function readLocal(): LeaderboardRow[] {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as LeaderboardRow[]) : []
  } catch {
    return []
  }
}

function writeLocal(rows: LeaderboardRow[]): LeaderboardRow[] {
  const sorted = [...rows].sort((a, b) => b.total - a.total).slice(0, LOCAL_MAX)
  try {
    globalThis.localStorage?.setItem(LOCAL_KEY, JSON.stringify(sorted))
  } catch {
    /* 저장 실패는 무시(폴백의 폴백 없음 — 메모리 유실 허용) */
  }
  return sorted
}

/**
 * 점수를 제출한다. supabase 성공 시 mode='supabase', 어떤 실패든 localStorage 폴백('local').
 */
export async function submitScore(
  nickname: string,
  breakdown: ScoreBreakdown,
): Promise<{ ok: boolean; mode: LeaderboardMode }> {
  const row: LeaderboardRow = {
    nickname,
    total: breakdown.total,
    reached: breakdown.reached,
    champion: breakdown.champion,
    created_at: new Date().toISOString(),
  }

  const client = getClient()
  if (client) {
    try {
      const { error } = await client.from(TABLE).insert({
        nickname: row.nickname,
        total: row.total,
        reached: row.reached,
        champion: row.champion,
      })
      if (error) throw error
      return { ok: true, mode: 'supabase' }
    } catch {
      // 폴백으로 진행
    }
  }

  const rows = readLocal()
  rows.push(row)
  writeLocal(rows)
  return { ok: true, mode: 'local' }
}

/**
 * 상위 n개 기록을 total 내림차순으로 조회한다.
 * supabase 성공 시 mode='supabase', 어떤 실패든 localStorage 폴백('local').
 */
export async function topScores(
  n: number,
): Promise<{ rows: LeaderboardRow[]; mode: LeaderboardMode }> {
  const client = getClient()
  if (client) {
    try {
      const { data, error } = await client
        .from(TABLE)
        .select('nickname,total,reached,champion,created_at')
        .order('total', { ascending: false })
        .limit(n)
      if (error) throw error
      if (Array.isArray(data)) {
        return { rows: data as LeaderboardRow[], mode: 'supabase' }
      }
    } catch {
      // 폴백으로 진행
    }
  }

  const rows = readLocal()
    .sort((a, b) => b.total - a.total)
    .slice(0, n)
  return { rows, mode: 'local' }
}
