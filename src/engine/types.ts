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
  /** 실제 대회 사용 포메이션 (표시·워룸 노출용 — 자유 문자열).
   *  엔진의 플레이 가능 포메이션은 FormationId 6종이며, Phase 3에서 AI 측 배선 완료:
   *  pickBestXI가 preferredFormations[0]을 mapFormation으로 매핑해 상대가 시그니처
   *  포메이션으로 출전한다(가장 가까운 FormationId로 매핑). */
  preferredFormations: string[]; style: TeamStyle
  keyPlayers: { playerId: string; dependency: number }[]
  benchPattern: 'protect-lead' | 'chase-attack' | 'balanced'
}
export interface StatBaseline {
  possession: number; passAccuracy: number; shotsPerGame: number
  shotsOnTargetPerGame: number; foulsPerGame: number; cornersPerGame: number; xgPerGame: number | null
}
export interface Team {
  id: string; name: { ko: string; en: string }; fifaCode: string; fifaRanking: number; tier: number
  flag?: string
  profile: TeamProfile; statBaseline: StatBaseline; squad: Player[]
}
export type FormationId = '4-3-3' | '4-2-3-1' | '4-4-2' | '3-5-2' | '4-1-4-1' | '5-4-1'
export interface Instructions { lineHeight: number; pressing: number; tempo: number; attackFocus: 'left'|'center'|'right'|'balanced' }
export interface LineupSlot { slot: Position; playerId: string }
export interface TacticState { formation: FormationId; lineup: LineupSlot[]; instructions: Instructions }
/** 감독의 개입 1건 기록 — AI 기자회견/헤드라인의 근거가 된다. summary는 한국어 서술. */
export interface DecisionEntry { minute: number; kind: 'instructions'|'sub'|'teamtalk'|'shootout-setup'; summary: string; detail?: Record<string, unknown> }
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
  /** 조별 "실제 전반 재현" 모드: 지정 시 전반(≤45)은 시뮬하지 않고 이 스크립트를 일괄 적용한다.
   *  세그먼트 분할 대응을 위해 상태에 보관(후반 분 파생 RNG는 불변 → 분할 결정론 유지). */
  firstHalfScript?: { events: MatchEvent[]; score: [number, number] }
}
