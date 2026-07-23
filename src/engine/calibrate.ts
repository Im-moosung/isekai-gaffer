// src/engine/calibrate.ts
import { createMatch, simulateSegment } from './simulate'
import type { Team } from './types'

export interface SideAvg { goals: number; possession: number; shots: number; shotsOnTarget: number; fouls: number; corners: number; xg: number }
export interface BatchReport { n: number; avg: { home: SideAvg; away: SideAvg }; homeWinRate: number; drawRate: number }

export function runBatch(home: Team, away: Team, n: number, seedBase = 1000): BatchReport {
  const sum = { home: zero(), away: zero() }
  let homeWins = 0, draws = 0
  for (let i = 0; i < n; i++) {
    const r = simulateSegment(createMatch(home, away, { seed: seedBase + i }), 90)
    for (const [key, idx] of [['home', 0], ['away', 1]] as const) {
      sum[key].goals += r.score[idx]
      sum[key].possession += r.stats[idx].possession
      sum[key].shots += r.stats[idx].shots
      sum[key].shotsOnTarget += r.stats[idx].shotsOnTarget
      sum[key].fouls += r.stats[idx].fouls
      sum[key].corners += r.stats[idx].corners
      sum[key].xg += r.stats[idx].xg
    }
    if (r.score[0] > r.score[1]) homeWins++
    else if (r.score[0] === r.score[1]) draws++
  }
  const div = (s: SideAvg): SideAvg => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v / n])) as unknown as SideAvg
  return { n, avg: { home: div(sum.home), away: div(sum.away) }, homeWinRate: homeWins / n, drawRate: draws / n }
}

const zero = (): SideAvg => ({ goals: 0, possession: 0, shots: 0, shotsOnTarget: 0, fouls: 0, corners: 0, xg: 0 })

const TOLERANCE = 0.15

export function checkCalibration(report: BatchReport, home: Team, away: Team) {
  const rows: { metric: string; side: 'home' | 'away'; expected: number; actual: number; withinTolerance: boolean }[] = []
  const push = (metric: string, side: 'home' | 'away', expected: number, actual: number) =>
    rows.push({ metric, side, expected, actual, withinTolerance: Math.abs(actual - expected) <= expected * TOLERANCE })
  for (const [side, team, avg] of [['home', home, report.avg.home], ['away', away, report.avg.away]] as const) {
    push('possession', side, team.statBaseline.possession, avg.possession)
    push('shotsPerGame', side, team.statBaseline.shotsPerGame, avg.shots)
    push('shotsOnTargetPerGame', side, team.statBaseline.shotsOnTargetPerGame, avg.shotsOnTarget)
    push('foulsPerGame', side, team.statBaseline.foulsPerGame, avg.fouls)
    push('cornersPerGame', side, team.statBaseline.cornersPerGame, avg.corners)
    if (team.statBaseline.xgPerGame != null) push('xgPerGame', side, team.statBaseline.xgPerGame, avg.xg)
  }
  return rows
}
