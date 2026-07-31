// src/game/coach.ts
// 코치 회의 (멀티 코치) — 순수 로직.
// 브레이크·하프타임 진입 시 **말할 근거가 있는 코치만** 제안을 낸다(등장 수 0~4명 가변).
// 근거는 전부 실측(스탯·이벤트·체력·스코어·교체 카드)이며 결정론적이다(랜덤·시각 의존 없음).
//
// ★ 최상위 제약(2026-07-26 사용자 확정): **근거가 데이터에서 나오지 않으면 등장하지 않는다.**
//   "꼭 3명이 없는 근거 억지로 만들면서 조언할 필요 없어." 전원 침묵도 정상 상태다.
//   이전 판은 무조건 3장을 push해서 체력 100인 선수를 "최하위 3인"이라 부르고,
//   xG 0 대 0에서 `0 < 0 === false`를 타고 "상대보다 찬스가 많습니다"라고 말했다.
//   그래서 모든 발동 조건은 **양(+)의 증거**만 쓴다 — 0은 '열세'가 아니라 '표본 없음'이다.
//
// ★ 존(왼쪽/오른쪽) 언급 금지: 엔진 이벤트에 좌우 존 정보가 없다. 근거는
//   상대 유효슛·코너 허용·체력 하위 선수·점유·파울 등 실측 가능한 값만 사용한다.
// ★ 세이프가드: 선수 실명은 사실 서술(이름+수치)만. 비하·조롱 금지.

import type {
  AttackPattern, GroupIntensity, Instructions, MatchState, Mentality, SideState,
} from '../engine/types'
import { trapFactor } from '../engine/tactics'
import { matchupEdge } from '../engine/simulate'
import { zoneStrength } from '../engine/strength'
import { trapAxis, edgeMentality } from './scouting'

/** 코치 직함(익명 — 실명 금지). */
export type CoachRole = '수비 코치' | '공격 코치' | '피지컬 코치' | '세트피스 코치'

/** 부분 전술 변경 객체 — [채택] 시 draft(현재 tactics)에 병합된다.
 *  **빈 객체({})도 유효하다** — 전술 축으로 표현할 수 없는 조언(예: "남은 교체 카드를 다 쓰십시오")은
 *  패치 없이 말만 남긴다. UI는 빈 패치 카드에 [채택] 버튼을 붙이지 않는다. */
export interface TacticPatch {
  instructions?: Partial<Instructions>
  mentality?: Mentality
  groupIntensity?: Partial<GroupIntensity>
  attackPattern?: AttackPattern
}

/** 코치 1인의 제안 카드. */
export interface CoachAdvice {
  coach: CoachRole
  /** 실측 수치를 포함한 근거. */
  rationale: string
  /** 사람이 읽는 제안. */
  proposal: string
  /** [채택] 시 병합할 부분 전술. 빈 객체면 조언 전용 카드. */
  apply: TacticPatch
}

/** 패치가 실제로 무언가를 바꾸는가(빈 조언 카드 판별 — UI의 [채택] 노출 조건). */
export function hasPatch(p: TacticPatch): boolean {
  return Object.keys(p).length > 0
}

// ── 국면 축 ──────────────────────────────────────────────────────
/** 5국면. 국면마다 **감독이 실제로 쓸 수 있는 카드가 다르다** —
 *  초반엔 상대 성향을 읽는 게 전부고, 종반엔 남은 교체 카드와 잔여 시간이 전부다. */
export type CoachPhase = 'early-first' | 'late-first' | 'halftime' | 'mid-second' | 'endgame'

/** 분 → 국면. 경계는 실제 개입 시점에 맞췄다:
 *  전반 하이드레이션 20~24' · 하프타임 45' · 후반 하이드레이션 65~69'
 *  (matchSession.breakSchedule). 75'는 교체·시간 관리가 다른 모든 판단을 덮는 지점이다. */
export function coachPhase(minute: number): CoachPhase {
  if (minute <= 25) return 'early-first'
  if (minute < 45) return 'late-first'
  if (minute === 45) return 'halftime'
  if (minute < 75) return 'mid-second'
  return 'endgame'
}

// ── 임계값 (전부 "왜 이 값인가"를 근거와 함께) ────────────────────
/** 엔진 정본(simulate.ts MAX_SUBS)과 같은 값. 엔진이 export하지 않아 복제한다. */
const MAX_SUBS = 5
const FULL_TIME = 90
/** 최근 추이 창(분). 브레이크 간격(22'→45'→67'→종료)보다 짧아야 "최근"이 의미를 갖는다. */
const RECENT_WINDOW = 15
/** 양 팀 슛이 이만큼 쌓이기 전엔 xG·유효슛 비교가 노이즈다.
 *  **0을 '열세'로 읽지 않기 위한 표본 게이트** — F2 결함 3의 재발 방지선. */
const MIN_SHOT_SAMPLE = 3
// ── 체력 경고선: **팀 자신의 중앙값 대비** 판정한다 ─────────────
// 고정선(예: 75)은 쓸 수 없다 — 하프타임이면 주전 전원이 자연히 그 아래다.
// 그렇다고 절대 곡선(100 − 0.55·분 − 8)도 쓸 수 없다는 것이 실측으로 드러났다(감사 결함 ④).
//  (1) 엔진 실측 소모는 분당 0.55가 아니다. 개인 스태미나 보정(100/max(40,stamina))이 곱해져
//      kor 선발 평균은 분당 ≈0.72다. 45분 기대치가 8~10점 높게 잡혀 늘 전원이 걸렸다.
//  (2) 캠페인 2경기부터는 킥오프 체력이 100이 아니다(잔여 피로 — campaignStore.RESIDUAL_LOAD).
//      절대 곡선은 그 사실을 모른다.
// 실제로 "주전 11명이 이 시점 기대치를 밑돕니다"가 8경기 내내 나왔다. 전원 경고는 변별력이 0이다.
//
// 그래서 기준을 **상대화**한다: 같은 경기·같은 시점의 우리 주전 중앙값보다 처졌는가.
// 정의상 절반을 넘길 수 없고, 캠페인 잔여 피로·전술·시점과 무관하게 뜻이 같다.
/** 팀 중앙값보다 이만큼 밑돌면 개인 사유(포지션 부하·낮은 stamina 스탯·압박 가중)가 있다. */
const BEHIND_MEDIAN = 8
/** 중앙값과 무관한 절대 위험 수위. 엔진의 지속 압박 실효 반감 판정선(평균 55)과 같은 값이다.
 *  팀 전체가 이 아래로 내려가면 "처진 소수"가 아니라 팀 전체 문제이므로 경고선이 여기로 올라온다. */
const STAMINA_DANGER_FLOOR = 55
/** 지속 압박 누적 경고. 엔진(simulate.ts)의 체력 가중은 `floor(sustained/10)` 단계라
 *  10분이 첫 페널티가 붙는 지점이다. 압박이 정확히 70이면 excess=0이라 페널티가 없어 제외한다. */
const SUSTAINED_PRESS_ALERT = 10
/** 앱이 스스로 "주의 · 뒷공간 노출"을 띄우는 라인 값(ui/console/ConsolePanel AXES와 같은 값).
 *  코치가 이 이상을 권할 때는 같은 대가를 문장으로 밝힌다 — 두 화면이 어긋나면 안 된다. */
const HIGH_LINE_WARN = 70
/** 수비 코치 발동선: 최근 창 내 상대 유효슛, 그리고 유효슛 격차. */
const DEF_RECENT_ON_TARGET = 2
const DEF_ON_TARGET_GAP = 2
/** 실점 직후 판정 창(분). */
const CONCEDE_WINDOW = 10
/** 공격 코치 xG 열세 판정.
 *  엔진 xG가 실제 P(골|슛) 스케일로 재정의되면서(경기당 팀 xG 3.2 → 1.4) 0.6 → 0.25로 내렸다.
 *  새 스케일에서 좋은 찬스 하나가 약 0.13이므로 0.25는 여전히 "결정적 찬스 2개분" 차이다. */
const XG_GAP_ALERT = 0.25
/** "흐름이 우리 쪽"으로 읽는 점유율 하한. 방송·분석 관례에서 55%를 넘으면 '지배'라고 부른다
 *  (50~54%는 사실상 대등이라 어느 쪽 흐름이라고 단정하지 않는다). */
const FLOW_POSSESSION = 55
/** 세트피스 코치 발동선(현행 유지). */
const CORNER_ALERT = 4
/** 종반엔 세트피스가 마지막 카드라 문턱을 낮춘다. */
const CORNER_ALERT_ENDGAME = 2

const PATTERN_KO: Record<AttackPattern, string> = {
  balanced: '균형', cross: '크로스', through: '중앙 침투', longshot: '중거리',
}
const MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비적', 'defensive': '수비적', 'balanced': '균형',
  'attacking': '공격적', 'very-attacking': '매우 공격적',
}

/** 결정론 해시(문구 변형용 — 난수 대신 쓴다. 시각·난수 의존 금지). FNV-1a. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 결정론 변형 선택. seed에 코치별 salt를 섞어 같은 분에도 코치마다 다른 문구가 나오게 한다. */
function pickBy<T>(items: readonly T[], seed: string): T {
  return items[hash(seed) % items.length]
}

/** [from, 현재] 구간에서 attacker가 만든 "유효슛" 개수.
 *  ★ 엔진 이벤트 의미론(simulate.ts): goal/miss는 teamId=공격측, save는 teamId=수비측(막은 GK 팀).
 *  따라서 attacker의 유효슛 = goal(teamId=attacker) + save(teamId=defender). */
function onTargetIn(engine: MatchState, attackerId: string, defenderId: string, from: number): number {
  return engine.events.filter(
    e => e.minute > from && (
      (e.type === 'goal' && e.teamId === attackerId) ||
      (e.type === 'save' && e.teamId === defenderId)
    ),
  ).length
}

/** 라인업(퇴장 제외) 체력 — 낮은 순. 동점은 이름 순 안정 정렬(결정론). */
function starterStamina(state: SideState): { name: string; stamina: number }[] {
  const rows = state.tactics.lineup
    .filter(l => !state.sentOff.includes(l.playerId))
    .map(l => {
      const p = state.team.squad.find(pp => pp.id === l.playerId)
      return { name: p?.name.ko ?? l.playerId, stamina: Math.round(state.staminaByPlayer[l.playerId] ?? 100) }
    })
  rows.sort((a, b) => a.stamina - b.stamina || a.name.localeCompare(b.name))
  return rows
}

/** 주전 체력 중앙값(짝수면 아래쪽 — 결정론). 빈 배열이면 100. */
function medianStamina(rows: readonly { stamina: number }[]): number {
  if (rows.length === 0) return 100
  return rows[Math.floor((rows.length - 1) / 2)].stamina // rows는 오름차순 정렬 상태
}

/** 라인업(퇴장 제외) 중 세트피스 최고 선수. 동점은 이름 순(결정론). */
function bestSetPieceTaker(state: SideState): { name: string; setPiece: number } | null {
  const rows = state.tactics.lineup
    .filter(l => !state.sentOff.includes(l.playerId))
    .map(l => state.team.squad.find(pp => pp.id === l.playerId))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map(p => ({ name: p.name.ko, setPiece: p.setPiece }))
  if (rows.length === 0) return null
  rows.sort((a, b) => b.setPiece - a.setPiece || a.name.localeCompare(b.name))
  return rows[0]
}

/** 상대의 후방 전개 지표 — 엔진 matchupContext(simulate.ts)와 **같은 입력**으로 뽑는다.
 *  GK는 지금 그라운드에 서 있는 GK를 읽는다(교체·퇴장 반영). 없으면 엔진과 같은 기본값 50. */
function oppBuildup(oppState: SideState): { gkBuildup: number; possession: number; index: number; trap: number } {
  const gkSlot = oppState.tactics.lineup.find(l => l.slot === 'GK' && !oppState.sentOff.includes(l.playerId))
  const gk = gkSlot ? oppState.team.squad.find(p => p.id === gkSlot.playerId) : undefined
  const gkBuildup = gk?.gkStats?.buildup ?? 50
  const possession = oppState.team.profile.style.possession
  return {
    gkBuildup, possession,
    index: Math.round((gkBuildup + possession) / 2),
    trap: trapFactor({ oppGkBuildup: gkBuildup, oppPossession: possession }),
  }
}

// ── 국면별 도입 문구(R4 다양화) ─────────────────────────────────
// 같은 국면·같은 코치라도 분·스코어가 다르면 다른 문장이 뽑힌다. 전부 결정론이다.
type PhaseLines = Record<CoachPhase, readonly string[]>

const DEF_LEAD: PhaseLines = {
  'early-first': ['초반에 흐름을 내주면 남은 시간이 길어집니다.', '아직 초반입니다 — 지금 형태를 잡으면 됩니다.'],
  'late-first': ['전반 종료 직전의 실점이 가장 아픕니다.', '이 흐름을 하프타임까지 끌고 가면 안 됩니다.'],
  'halftime': ['전반에 내준 패턴은 후반에도 그대로 반복됩니다.', '후반 시작 15분이 승부처입니다.'],
  'mid-second': ['상대가 교체로 힘을 더하는 구간입니다.', '여기서 정리하지 않으면 종반에 무너집니다.'],
  'endgame': ['종반 실점 하나면 경기가 통째로 뒤집힙니다.', '남은 시간은 짧고 실점의 대가는 큽니다.'],
}

// 공격 코치의 도입 문구는 **흐름이 누구 쪽인가**로 갈린다.
// ★ 예전에는 국면만 보고 골라서, 바로 윗줄 근거가 "점유율 60%"(우리 점유)인데 다음 줄이
//   "초반 흐름은 상대 쪽입니다."로 나갔다(감사 결함 ③). 같은 카드 안에서 사실이 뒤집힌다.
//   그래서 흐름 판정(atkHolding)에 따라 두 벌 중 하나를 쓴다.
/** 흐름이 상대 쪽일 때 — 볼도 못 잡고 결과도 없다. */
const ATK_LEAD: PhaseLines = {
  'early-first': ['초반 흐름은 상대 쪽입니다.', '아직 시간은 많지만 형태는 바꿔야 합니다.'],
  'late-first': ['전반이 끝나기 전에 한 방이 필요합니다.', '0으로 하프타임에 들어가면 후반이 무거워집니다.'],
  'halftime': ['후반은 시작부터 밀어붙여야 합니다.', '45분이 통째로 남았습니다 — 지금 방식을 바꿉시다.'],
  'mid-second': ['아직 되돌릴 시간이 있습니다.', '상대 다리가 무거워지는 구간을 노립시다.'],
  'endgame': ['남은 시간에 전부 걸어야 합니다.', '지금 안 걸면 기회는 없습니다.'],
}

/** 흐름은 우리 쪽인데 결과가 없을 때 — 처방이 "더 밀어붙이자"가 아니라 "다르게 열자"다. */
const ATK_LEAD_HOLDING: PhaseLines = {
  'early-first': ['볼은 우리가 갖고 있는데 마지막 30미터가 막혀 있습니다.', '초반 흐름은 우리 쪽입니다 — 다만 그게 슈팅으로 이어지지 않습니다.'],
  'late-first': ['점유는 우리 것인데 전반이 그냥 지나갑니다.', '이대로 볼만 돌리다 하프타임에 들어갈 수는 없습니다.'],
  'halftime': ['전반 내내 볼은 우리가 가졌습니다 — 후반엔 여는 방식을 바꿉시다.', '점유는 충분했습니다. 부족한 건 마지막 패스입니다.'],
  'mid-second': ['볼은 계속 우리에게 있습니다 — 문제는 열지 못한다는 것입니다.', '점유를 득점으로 바꿀 경로를 하나 더 만듭시다.'],
  'endgame': ['볼은 우리가 쥐고 있습니다 — 남은 시간엔 위험을 감수하고 열어야 합니다.', '점유만으로는 남은 시간을 못 넘깁니다.'],
}

const PHYS_LEAD: PhaseLines = {
  'early-first': ['이 페이스로는 후반이 없습니다.', '전반 초반에 이미 다리가 무겁습니다.'],
  'late-first': ['하프타임이 코앞입니다.', '전반 남은 시간은 아껴야 합니다.'],
  'halftime': ['하프타임 교체는 흐름을 끊지 않습니다.', '라커룸에서 바꿀 수 있는 게 가장 쌉니다.'],
  'mid-second': ['다리가 무거워지기 시작하는 구간입니다.', '교체 타이밍을 놓치면 종반에 걸어 다닙니다.'],
  'endgame': ['마지막 구간입니다.', '여기서부터는 다리가 판단을 대신합니다.'],
}

const SET_LEAD: PhaseLines = {
  'early-first': ['초반부터 세트피스가 쌓입니다.', '상대가 세트피스를 계속 내주고 있습니다.'],
  'late-first': ['전반에 얻은 세트피스를 흘려보내고 있습니다.', '하프타임 전에 한 번은 살려야 합니다.'],
  'halftime': ['전반에 쌓인 세트피스가 후반의 자산입니다.', '후반엔 세트피스를 확실히 마무리합시다.'],
  'mid-second': ['세트피스가 계속 나오고 있습니다.', '흐름이 막히면 세트피스가 답입니다.'],
  'endgame': ['종반엔 세트피스 한 번이 경기를 끝냅니다.', '남은 시간엔 흐름보다 정지 상황입니다.'],
}

/** 코치진 제안 생성 — **발동 조건을 만족한 코치만** 등장한다(0~4개, 빈 배열 가능).
 *  상충 허용(수비 코치 "가두자" vs 피지컬 코치 "압박 낮추자" — 감독의 딜레마). */
export function buildCoachAdvice(engine: MatchState, side: 'home' | 'away'): CoachAdvice[] {
  const other = side === 'home' ? 'away' : 'home'
  const own = side === 'home' ? engine.stats[0] : engine.stats[1]
  const opp = side === 'home' ? engine.stats[1] : engine.stats[0]
  const ownState = engine[side]
  const oppState = engine[other]
  const minute = engine.minute
  const phase = coachPhase(minute)
  const remaining = Math.max(0, FULL_TIME - minute)
  const [ownScore, oppScore] = side === 'home'
    ? [engine.score[0], engine.score[1]]
    : [engine.score[1], engine.score[0]]
  const behind = ownScore < oppScore
  const leading = ownScore > oppScore
  const seed = `${minute}:${ownScore}-${oppScore}`
  // 표본 게이트: 양 팀 슛 총합. 조별 전반 스크립트 구간처럼 시뮬이 없었으면 0이고,
  // 그때는 어떤 슛·xG 비교도 하지 않는다(→ 그 코치는 침묵한다).
  const shotSample = own.shots + opp.shots

  const advice: CoachAdvice[] = []

  // ── 체력 상태를 **먼저** 읽는다 ──────────────────────────────
  // ★ 순서가 계약이다(감사 결함 ③). 예전에는 수비 코치가 먼저 "압박을 68까지 올리자"고 하고
  //   그 아래에서 피지컬 코치가 "압박을 한 단계 낮춥니다"라고 했다 — 같은 카드 묶음 안에서
  //   서로를 모르는 채 반대 처방을 냈다. 코치진은 딜레마를 제시할 수는 있어도 **같은 사실을
  //   서로 다르게 보고 있어서는 안 된다.** 그래서 체력 판정을 공통 입력으로 끌어올려
  //   수비 코치가 그 값을 읽고 압박 처방을 스스로 접게 한다.
  const staminaRows = starterStamina(ownState)
  const medStamina = medianStamina(staminaRows)
  // 팀 전체가 위험 수위 아래로 내려가면 "처진 소수"가 아니라 팀 전체 문제다 — 그때는 절대선을 쓴다.
  const staminaLine = Math.max(medStamina - BEHIND_MEDIAN, STAMINA_DANGER_FLOOR)
  /** 절대 위험 수위가 경고선을 지배하는 국면인가(= 팀 전체가 바닥). 문구가 달라진다. */
  const floorMode = medStamina - BEHIND_MEDIAN < STAMINA_DANGER_FLOOR
  const tiredAll = staminaRows.filter(r => r.stamina <= staminaLine)
  const press = ownState.tactics.instructions.pressing
  const pressMinutes = ownState.sustainedPressMinutes ?? 0
  const sustained = press > 70 && pressMinutes >= SUSTAINED_PRESS_ALERT
  const physFires = tiredAll.length > 0 || sustained
  /** 다리가 압박을 감당하지 못하는 상태 — 수비 코치는 이때 압박을 올리지 않는다.
   *  기준을 "피지컬 코치가 말을 하는가"로 잡으면 처진 선수 1명에도 압박 처방이 봉쇄되므로,
   *  **팀 규모의 문제**(절대 바닥 국면이거나 주전 3명 이상)일 때만 봉쇄한다. */
  const legsGone = sustained || floorMode || tiredAll.length >= 3

  // ── 수비 코치 ────────────────────────────────────────────────
  // 발동: 최근 15분 상대 유효슛 ≥ 2 / 유효슛 격차 ≥ 2 / 최근 10분 실점.
  // 셋 다 **양의 증거**라 데이터가 0이면 자동으로 침묵한다.
  const recentOppShots = onTargetIn(engine, oppState.team.id, ownState.team.id, minute - RECENT_WINDOW)
  const conceded = engine.events.some(
    e => e.type === 'goal' && e.teamId === oppState.team.id && e.minute > minute - CONCEDE_WINDOW,
  )
  const onTargetGap = opp.shotsOnTarget - own.shotsOnTarget
  const defFires = recentOppShots >= DEF_RECENT_ON_TARGET
    || onTargetGap >= DEF_ON_TARGET_GAP
    || conceded

  // 방향은 **상대의 후방 전개 능력**이 정한다. 무조건 "라인을 내려라"는 남아공·체코처럼
  // 전개가 약한 팀 상대로는 틀린 조언이다 — 엔진의 compress 이득이 정확히 trapFactor에
  // 비례하므로(tactics.ts) 같은 판별자를 재사용한다(scouting.ts와 동일 패턴).
  const bu = oppBuildup(oppState)
  // 태세는 trap이 아니라 매치업 우위(edge)가 정한다 — 킥오프 추천(scouting.recommendPlan)과
  // 같은 판별자여야 "코치가 하프타임에 킥오프 플랜을 배신하는" 조언이 나오지 않는다.
  // 여기서는 **지금 그라운드의** 존 전력을 읽으므로 체력·퇴장·사기가 반영된 실시간 값이다.
  const edge = matchupEdge(zoneStrength(ownState), zoneStrength(oppState))
  const axis = trapAxis(bu.trap)
  const compress = bu.trap >= 0.25 // 가둘 수 있다(라인·압박을 올리는 쪽이 이득)
  const block = bu.trap <= -0.25 // 벗겨진다(내려앉아 블록을 세우는 쪽이 이득)
  // 종반에 지고 있는데 "내려앉읍시다"는 경기를 포기하라는 말이다. 그 조합에서는
  // 블록 처방을 내지 않는다(가두는 처방은 공수 양쪽에 이득이라 그대로 낸다).
  const defMuted = block && phase === 'endgame' && behind

  if (defFires && !defMuted) {
    const facts = [`상대 유효슛 ${opp.shotsOnTarget}개(우리 ${own.shotsOnTarget}개)·코너 ${opp.corners}개를 허용했고, 최근 ${RECENT_WINDOW}분에만 ${recentOppShots}개입니다.`]
    if (conceded) facts.push(`최근 ${CONCEDE_WINDOW}분 안에 실점했습니다.`)
    facts.push(`상대 후방 전개 지표는 ${bu.index}입니다(GK 빌드업 ${bu.gkBuildup} · 점유 성향 ${bu.possession} · 기준 72).`)

    // 압박 처방은 다리가 남아 있을 때만 올린다. 다리가 없으면 **현재 값을 유지**하고
    // 압박 축의 판단을 피지컬 코치에게 넘긴다 — 그래야 두 카드가 같은 사실 위에 선다.
    const wantPress = axis.pressing
    const pressing = legsGone && wantPress > press ? press : wantPress
    const pressDeferred = pressing !== wantPress
    const axisText = `라인 ${axis.lineHeight} · 압박 ${pressing}`
    const direction = compress
      ? `기준 72보다 낮아 전방에서 가둘 수 있습니다 — 내려앉지 말고 ${axisText}까지 올려 상대 전개를 끊읍시다.`
      : block
        ? `기준 72를 넘어 우리 압박이 벗겨집니다 — ${axisText}까지 내려 블록을 세웁시다.`
        : `기준 72와 비슷해 어느 쪽도 크게 통하지 않습니다 — ${axisText}의 중간 강도로 형태를 고정합시다.`
    // 대가를 말하지 않는 조언은 조언이 아니다. 앱 자신의 슬라이더가 라인 70+를
    // "주의 · 뒷공간 노출"로 표시하므로(ui/console/ConsolePanel AXES), 그 값을 권할 때는
    // 코치가 먼저 그 대가를 입에 올려야 한다 — 그러지 않으면 앱이 자기 경고와 모순된다.
    const costs: string[] = []
    if (axis.lineHeight >= HIGH_LINE_WARN) {
      costs.push(`라인 ${axis.lineHeight}는 뒷공간을 내주는 값입니다 — 오프사이드 트랩과 GK 커버를 전제로 겁니다.`)
    }
    if (pressDeferred) {
      costs.push(`다만 다리가 받쳐주지 않아 압박은 지금 값(${press})을 유지합니다 — 압박 조정은 피지컬 코치 판단을 따르십시오.`)
    }
    const men = edgeMentality(edge)

    advice.push({
      coach: '수비 코치',
      rationale: facts.join(' '),
      proposal: [pickBy(DEF_LEAD[phase], `${seed}:def`), direction, ...costs, '수비 라인 적극성도 올립니다.'].join(' '),
      apply: {
        instructions: { lineHeight: axis.lineHeight, pressing },
        // ★ +1이 '적극(존 전력 1.06)', −1이 '자제(0.95)'다. 이전 판은 수비를 굳히자면서
        //   defense:-1을 걸어 수비 존을 오히려 약화시켰다(engine tactics.groupIntensityZoneFactor).
        groupIntensity: { defense: 1 },
        ...(men === 'defensive' || men === 'very-defensive' ? { mentality: men } : {}),
      },
    })
  }

  // ── 공격 코치 ────────────────────────────────────────────────
  // 발동: (지고 있음 & 전반 초반이 아님) / 표본이 있는데 최근 유효슛 0 / xG 열세가 뚜렷.
  // 전반 초반의 "지고 있음"만으로는 등장하지 않는다 — 킥오프 플랜을 5분 만에 갈아엎을 근거가 아니다.
  const recentOwnShots = onTargetIn(engine, ownState.team.id, oppState.team.id, minute - RECENT_WINDOW)
  const dryStretch = shotSample >= MIN_SHOT_SAMPLE && recentOwnShots === 0
  const xgBehind = shotSample >= MIN_SHOT_SAMPLE + 1 && opp.xg - own.xg >= XG_GAP_ALERT
  const atkFires = (behind && phase !== 'early-first') || dryStretch || xgBehind

  if (atkFires) {
    const facts: string[] = []
    if (behind) facts.push(`${ownScore}-${oppScore}로 뒤진 채 ${remaining}분 남았습니다.`)
    if (dryStretch) facts.push(`최근 ${RECENT_WINDOW}분 우리 유효슛이 0개입니다(양 팀 슛 ${shotSample}개·점유율 ${Math.round(own.possession)}%).`)
    if (xgBehind) facts.push(`xG는 우리 ${own.xg.toFixed(2)} 대 상대 ${opp.xg.toFixed(2)}로 찬스의 질에서 밀립니다.`)

    // 패턴은 상대 라인 높이가 정한다 — 엔진 attackPatternEffects 기준으로 상대가 높게 서면
    // 뒷공간(중앙 침투: 찬스 질 +16%)이, 낮게 서면 박스를 여는 크로스(코너 1.6배)·
    // 중거리(빈도 +14%)가 맞다. 후자는 둘 다 유효해 결정론 해시로 갈라 문구를 다양화한다.
    const oppLine = oppState.team.profile.style.lineHeight
    const patterns: AttackPattern[] = oppLine >= 62 ? ['through'] : ['cross', 'longshot']
    const pick = pickBy(patterns, `${seed}:atk`)
    const men: Mentality = behind && phase === 'endgame' ? 'very-attacking' : 'attacking'
    // 숫자 뒤 조사는 읽기(62=육십이/70=칠십)에 따라 갈리므로 대시로 끊어 조사 자체를 피한다.
    const patternWhy = oppLine >= 62
      ? `상대 라인 높이 ${oppLine} — 높게 서 있어 뒷공간이 열려 있습니다`
      : `상대 라인 높이 ${oppLine} — 낮게 서 있어 박스를 여는 쪽이 낫습니다`

    // 흐름 판정: 볼을 우리가 쥐고 있는가. 점유가 명확히 우리 쪽이거나 슛 수가 앞서면
    // "흐름은 상대 쪽"이라고 말할 수 없다 — 바로 윗줄 근거가 그 반대를 적고 있기 때문이다.
    const atkHolding = own.possession >= FLOW_POSSESSION || own.shots > opp.shots
    const leadLines = atkHolding ? ATK_LEAD_HOLDING[phase] : ATK_LEAD[phase]

    advice.push({
      coach: '공격 코치',
      rationale: facts.join(' '),
      proposal: `${pickBy(leadLines, `${seed}:atk`)} ${patternWhy}. ${PATTERN_KO[pick]} 위주로 바꾸고 태세를 ${MENTALITY_KO[men]}으로 올려 공격 라인 적극성을 더합시다.`,
      apply: { mentality: men, groupIntensity: { attack: 1 }, attackPattern: pick },
    })
  }

  // ── 피지컬 코치 ──────────────────────────────────────────────
  // 발동: 주전 체력이 경고선 이하인 선수가 실제로 존재 / 지속 압박 누적이 페널티 구간.
  // ★ 이전 판의 "체력 하위 3인"은 값과 무관하게 늘 3명을 뽑아 100/100/100을 경고했다.
  //   지금은 **경고선을 넘긴 선수만** 이름을 부르고, 아무도 없으면 등장하지 않는다.
  // ★ 발동 판정(physFires)과 경고선은 이 블록 위에서 이미 계산했다 — 수비 코치가 같은 값을 읽는다.
  // 실명은 가장 심한 3명까지만 부른다(카드 한 장에 11명을 늘어놓을 수는 없다).
  // 다만 **인원 수는 전체를 말한다** — 3명만 세면 "하위 3인"을 늘 3명이라 부르던 옛 버그의 재발이다.
  const tired = tiredAll.slice(0, 3)
  const subsLeft = Math.max(0, MAX_SUBS - ownState.subsUsed)

  if (physFires) {
    const facts: string[] = []
    if (tiredAll.length > 0) {
      const names = tired.map(r => `${r.name} ${r.stamina}`).join(', ')
      // 팀 전체가 바닥이면 "누가 처졌나"가 아니라 "팀이 위험하다"가 사실이다 — 문장을 나눈다.
      facts.push(floorMode
        ? `주전 ${tiredAll.length}명이 위험 수위(${STAMINA_DANGER_FLOOR})를 밑돕니다 — 최저 ${names}.`
        : `팀 중앙값 ${medStamina} 기준 ${staminaLine} 아래로 처진 선수 ${tiredAll.length}명 — ${names}.`)
    }
    if (sustained) facts.push(`압박 ${press}를 ${pressMinutes}분째 유지 중이라 체력 소모 가중이 붙었습니다.`)

    // 종반에 지고 있으면 강도를 낮추는 게 오답이다 — 남은 카드를 쓰라는 조언만 남기고
    // 전술 패치는 걸지 않는다(교체는 감독이 교체 패널에서 직접 해야 하는 결정이다).
    const noPatch = phase === 'endgame' && behind
    const action = phase === 'halftime'
      ? subsLeft > 0
        ? `지친 선수는 지금 바꾸십시오(교체 카드 ${subsLeft}장). 후반 압박도 한 단계 낮춥니다.`
        : '교체 카드가 없으니 압박을 낮춰 후반을 설계합시다.'
      : phase === 'endgame'
        ? behind
          ? `${remaining}분 남았습니다. 체력 관리는 버리고 남은 교체 카드 ${subsLeft}장을 지금 다 쓰십시오.`
          : subsLeft > 0
            ? `${remaining}분 남았습니다. 교체 ${subsLeft}장으로 다리를 바꾸고 압박은 낮춰 시간을 벌읍시다.`
            : `교체 카드가 없습니다. 압박을 낮춰 남은 ${remaining}분을 실수 없이 버팁시다.`
        : phase === 'mid-second'
          ? `교체 카드 ${subsLeft}장을 준비하고 압박·중원 적극성을 낮춰 종반까지 다리를 남깁시다.`
          : `아직 ${remaining}분이 남았습니다. 압박을 낮추고 중원 적극성을 자제로 둬 체력을 아낍시다.`

    // 수비 코치가 같은 브레이크에서 라인을 올리자고 했다면 그 사실을 인정하고 **역할을 나눈다**.
    // "라인은 올리되 압박은 낮춘다"는 모순이 아니라 실제 축구의 표준 조합이다(높게 서서
    // 간격을 줄이되 개인이 쫓아가지는 않는다). 이 문장이 없으면 두 카드가 싸우는 것처럼 읽힌다.
    const withDef = advice.some(a => a.coach === '수비 코치')
      ? ' 수비 코치의 라인 조정에는 동의합니다 — 라인은 올리되 개인 압박은 낮춰야 다리가 버팁니다.'
      : ''

    advice.push({
      coach: '피지컬 코치',
      rationale: facts.join(' '),
      proposal: `${pickBy(PHYS_LEAD[phase], `${seed}:phys`)} ${action}${withDef}`,
      apply: noPatch
        ? {}
        : { instructions: { pressing: Math.max(20, press - 15) }, groupIntensity: { midfield: -1 } },
    })
  }

  // ── 세트피스 코치 ────────────────────────────────────────────
  // 발동: 코너 4개 이상. 종반에 지거나 비기는 중이면 2개로 낮춘다(마지막 카드).
  const setFires = own.corners >= CORNER_ALERT
    || (phase === 'endgame' && !leading && own.corners >= CORNER_ALERT_ENDGAME)
  if (setFires) {
    const taker = bestSetPieceTaker(ownState)
    const facts = [`코너 ${own.corners}개를 얻었습니다(상대 파울 ${opp.fouls}개).`]
    if (taker) facts.push(`${taker.name}의 세트피스 ${taker.setPiece}가 그라운드에 있습니다.`)
    advice.push({
      coach: '세트피스 코치',
      rationale: facts.join(' '),
      proposal: `${pickBy(SET_LEAD[phase], `${seed}:set`)} 크로스 패턴으로 전환해 코너와 측면 공격의 빈도를 올립시다.`,
      apply: { attackPattern: 'cross' },
    })
  }

  return advice
}
