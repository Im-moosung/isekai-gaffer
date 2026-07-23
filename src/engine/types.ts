export type Position = 'GK'|'CB'|'LB'|'RB'|'DM'|'CM'|'AM'|'LW'|'RW'|'ST'
export type Foot = 'L' | 'R' | 'B'
export interface FieldStats { shooting: number; passing: number; dribbling: number; defending: number; physical: number; pace: number }
export interface GkStats { saving: number; aerial: number; buildup: number }
export interface Player {
  id: string; number: number; name: { ko: string; en: string }
  position: Position; altPositions: Position[]; foot: Foot | null
  stats?: FieldStats; gkStats?: GkStats
  setPiece: number; penalty: number; stamina: number
}
export interface TeamStyle { possession: number; pressing: number; lineHeight: number; tempo: number } // 0~100
export interface TeamProfile {
  preferredFormations: FormationId[]; style: TeamStyle
  keyPlayers: { playerId: string; dependency: number }[]
  benchPattern: 'protect-lead' | 'chase-attack' | 'balanced'
}
export interface StatBaseline {
  possession: number; passAccuracy: number; shotsPerGame: number
  shotsOnTargetPerGame: number; foulsPerGame: number; cornersPerGame: number; xgPerGame: number | null
}
export interface Team {
  id: string; name: { ko: string; en: string }; fifaCode: string; fifaRanking: number; tier: number
  profile: TeamProfile; statBaseline: StatBaseline; squad: Player[]
}
export type FormationId = '4-3-3' | '4-2-3-1' | '4-4-2' | '3-5-2' | '4-1-4-1' | '5-4-1'
export interface Instructions { lineHeight: number; pressing: number; tempo: number; attackFocus: 'left'|'center'|'right'|'balanced' }
export interface LineupSlot { slot: Position; playerId: string }
export interface TacticState { formation: FormationId; lineup: LineupSlot[]; instructions: Instructions }
export type MatchEventType = 'kickoff'|'chance'|'shot'|'goal'|'save'|'miss'|'foul'|'yellow'|'red'|'corner'|'sub'|'halftime'|'fulltime'
export interface MatchEvent { minute: number; type: MatchEventType; teamId: string; playerId?: string; assistId?: string; detail?: string; xg?: number }
export interface SideStats { possession: number; passAccuracy: number; shots: number; shotsOnTarget: number; fouls: number; corners: number; xg: number }
export interface SideState {
  team: Team; tactics: TacticState
  staminaByPlayer: Record<string, number>   // 0~100
  moraleByPlayer: Record<string, number>    // 0~100
  subsUsed: number; sentOff: string[]
}
export interface MatchState {
  minute: number; score: [number, number]   // [home, away]
  home: SideState; away: SideState
  events: MatchEvent[]; stats: [SideStats, SideStats]
  momentum: number  // -1(away 우세)~+1(home 우세)
  seed: number      // 분 파생 RNG 시드 (createRng(seed*10007+minute)) — 세그먼트 분할 결정론의 근간
}
