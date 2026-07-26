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

/** 팀 멘탈리티 5프리셋 — 찬스 생성 vs 수비 안정의 무게중심. 'balanced'가 중립(기존 동작). */
export type Mentality = 'very-defensive' | 'defensive' | 'balanced' | 'attacking' | 'very-attacking'
/** 공격 패턴 4종. 'balanced'가 중립(기존 동작). */
export type AttackPattern = 'balanced' | 'cross' | 'through' | 'longshot'
/** 라인별 적극성 -1(자제)|0(기본)|1(적극). 모두 0이 중립(기존 동작). */
export interface GroupIntensity { attack: -1 | 0 | 1; midfield: -1 | 0 | 1; defense: -1 | 0 | 1 }
/** 페이즈별 포메이션(공격 시/수비 시 존 가중 이동). 미지정이 중립(기존 동작). */
export interface PhaseFormations { attack?: FormationId; defense?: FormationId }

/** 전술 상태. 확장 필드(mentality/phaseFormations/groupIntensity/attackPattern/gkPowerplay)는
 *  모두 선택적이며, 미지정(=기본값)이면 엔진 동작이 기존과 완전히 동일하다(시드 회귀 불변). */
export interface TacticState {
  formation: FormationId; lineup: LineupSlot[]; instructions: Instructions
  /** 미지정 시 'balanced'로 취급. */
  mentality?: Mentality
  /** 미지정 시 페이즈 가중 없음. */
  phaseFormations?: PhaseFormations
  /** 미지정 시 { attack:0, midfield:0, defense:0 }로 취급. */
  groupIntensity?: GroupIntensity
  /** 미지정 시 'balanced'로 취급. */
  attackPattern?: AttackPattern
  /** 미지정/false면 비활성. 85'+ & 지는 중에만 실효(엔진에서 판정). */
  gkPowerplay?: boolean
}
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
  /** 압박 70+ 연속 유지 분(지속 압박 페널티 추적). 압박<70인 분엔 0으로 리셋.
   *  미지정 시 0으로 취급(기존 상태 호환). */
  sustainedPressMinutes?: number
  /** 사용한 교체 기회 수(IFAB substitution opportunity). 경기당 3회이며, 같은 분의 복수
   *  교체는 한 번의 기회로 묶인다(실제로도 같은 정지 상황에서 여러 명을 함께 바꾼다).
   *  UI 표기는 "교체 기회" — "창/윈도우"는 교체 패널로 오해되므로 쓰지 않는다.
   *  미지정 시 0으로 취급(기존 상태 호환). */
  subWindowsUsed?: number
  /** 마지막 교체가 이뤄진 분. 같은 분의 추가 교체가 새 기회를 소모하지 않도록 판정하는 기준.
   *  미지정이면 아직 교체 없음(기존 상태 호환). */
  lastSubMinute?: number
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
