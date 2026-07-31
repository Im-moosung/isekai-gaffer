// src/game/matchStore.ts
import { create } from 'zustand'
import { createMatch, simulateSegment, applyCommand, type MatchCommand, type SimulateOpts } from '../engine/simulate'
import type { DecisionEntry, Instructions, MatchEvent, MatchState, TacticState, Team } from '../engine/types'
import { breakSchedule, detectMoment, type DecisionMoment, type HydrationSchedule } from './matchSession'
import { decideAwayActions } from './oppAi'
import { subbedOffIds } from './playerStats'

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

/** 상대 기대치(FIFA 랭킹 차 기반). even이 중립(기존 동작·데모). */
export type Expectation = 'underdog' | 'even' | 'favorite'

/** 언더독/페이버릿 판정 랭킹 차 임계값(브리프 정본: ≥15). */
export const EXPECTATION_THRESHOLD = 15

/** 팀 관점 FIFA 랭킹 차로 기대치 판정.
 *  랭킹 숫자는 작을수록 강팀 → (내 랭킹 - 상대 랭킹)이 클수록 우리가 약체(언더독).
 *  ≥+15면 언더독, ≤-15면 페이버릿, 그 사이는 even. */
export function teamExpectation(ownRanking: number, oppRanking: number): Expectation {
  const diff = ownRanking - oppRanking
  if (diff >= EXPECTATION_THRESHOLD) return 'underdog'
  if (diff <= -EXPECTATION_THRESHOLD) return 'favorite'
  return 'even'
}

/** 기대치별 결정론 보정 가산 테이블 — TEAM_TALK_TABLE에 더해진다(랜덤 없음).
 *  even은 전부 0(기존 동작 불변). 근거(브리프 정본):
 *   - 언더독×지는중: 약체가 지는 건 예상 범위 — 격노는 역효과, '침착'이 최대(업셋 유지).
 *   - 페이버릿×지는중: 이겨야 할 경기에서 뒤진 상황 — '격노'로 각성이 최대.
 *   - 언더독×비기는중: 강팀 상대 무승부는 호성적 — '격려'로 한 방을 노린다.
 *   - 페이버릿×비기는중: 강팀이 못 이기는 중 — 더 밀어붙이는 '격노'가 최대.
 *   - 언더독×이기는중: 강팀 상대 리드는 값지지만 취약 — '침착'하게 지킨다.
 *   - 페이버릿×이기는중: 예상된 리드 — 흐트러지지 않게 '침착'하게 관리. */
export const EXPECTATION_ADJUST: Record<Expectation, Record<ScoreSituation, Record<TeamTalkTone, number>>> = {
  even: {
    losing:  { rage: 0, encourage: 0, calm: 0, trust: 0 },
    drawing: { rage: 0, encourage: 0, calm: 0, trust: 0 },
    winning: { rage: 0, encourage: 0, calm: 0, trust: 0 },
  },
  underdog: {
    // 지는중: calm 2→10로 격노(8→4)를 제치고 최대.
    losing:  { rage: -4, encourage: 1, calm: 8, trust: 2 },
    // 비기는중: encourage 5→7로 최대.
    drawing: { rage: -1, encourage: 2, calm: 1, trust: 1 },
    // 이기는중: calm 6→8로 최대 유지·강화.
    winning: { rage: -2, encourage: 0, calm: 2, trust: 1 },
  },
  favorite: {
    // 지는중: rage 8→11로 최대 강화.
    losing:  { rage: 3, encourage: -1, calm: -2, trust: 0 },
    // 비기는중: rage 3→7로 encourage(5)를 제치고 최대.
    drawing: { rage: 4, encourage: 1, calm: -1, trust: -1 },
    // 이기는중: calm 6→7로 최대 유지.
    winning: { rage: -1, encourage: 1, calm: 1, trust: 0 },
  },
}

/** 상황·기대치에서 최대 사기 보정 톤(코치 추천 — 확률 요소 없는 결정론).
 *  동점 시 톤 우선순위(rage>encourage>calm>trust — 선언 순) 안정 선택. */
export function recommendedTone(situation: ScoreSituation, expectation: Expectation = 'even'): TeamTalkTone {
  const tones: TeamTalkTone[] = ['rage', 'encourage', 'calm', 'trust']
  let best = tones[0]
  let bestV = -Infinity
  for (const tone of tones) {
    const v = TEAM_TALK_TABLE[situation][tone] + EXPECTATION_ADJUST[expectation][situation][tone]
    if (v > bestV) { bestV = v; best = tone }
  }
  return best
}

/** 팀토크 선택 후 UI 즉시 효과 표시용 반환. */
export interface TeamTalkResult {
  /** 실제 적용된 사기 delta(반복 감쇠 반영 후 정수). */
  delta: number
  /** 반복 감쇠가 적용됐는지(지난 경기와 같은 톤). */
  repeated: boolean
  /** 선수별 반응 아이콘 2~3명(주장·keyPlayers 우선, 결정론). */
  reactions: { playerId: string; icon: TeamTalkReactionIcon }[]
}

export type TeamTalkReactionIcon = '🔥' | '😐' | '😰'

/** delta·선수 인덱스로 결정론 반응 아이콘. 뒤 선수일수록 약간 덜 반응(idx 감산).
 *  긍정 강할수록 🔥, 미지근하면 😐, 역효과면 😰. */
function reactionIcon(delta: number, idx: number): TeamTalkReactionIcon {
  const score = delta - idx
  if (score >= 5) return '🔥'
  if (score >= 0) return '😐'
  return '😰'
}

/** 개입 직후 지시 효과 부스트 지속(분). advanceMinute이 simulateSegment opts로 엔진에 전달(Task 5). */
const BOOST_MINUTES = 8

/** 터치라인 외침 4종 — [독려][더 뛰어][침착][칭찬]. */
export type ShoutType = 'urge' | 'work' | 'calm' | 'praise'
/** 외침 쿨다운(분) — 마지막 외침 이후 이 분이 지나야 재외침 가능. */
export const SHOUT_COOLDOWN = 10

/** 외침 효과 결정론 테이블 — 스코어 상황 × 외침 (사기·체력 delta, 전원 일괄).
 *  랜덤 없이 상황·유형만으로 정해진다(재현성). 부적합 조합은 역효과:
 *  이기는데 [더 뛰어]=사기 저하·체력 소모 가중, 지는데 [칭찬]=공허(사기 저하) 등.
 *  ★ 단순화 계약: 엔진 전달 없이 moraleByPlayer/staminaByPlayer 직접 보정(applyTeamTalk 방식). */
export const SHOUT_TABLE: Record<ScoreSituation, Record<ShoutType, { morale: number; stamina: number }>> = {
  losing:  { urge: { morale: 6, stamina: 0 }, work: { morale: 4, stamina: -2 }, calm: { morale: 2, stamina: 0 }, praise: { morale: -3, stamina: 0 } },
  drawing: { urge: { morale: 4, stamina: 0 }, work: { morale: 3, stamina: -2 }, calm: { morale: 3, stamina: 0 }, praise: { morale: 2, stamina: 0 } },
  winning: { urge: { morale: 1, stamina: 0 }, work: { morale: -4, stamina: -5 }, calm: { morale: 5, stamina: 0 }, praise: { morale: 4, stamina: 0 } },
}

/** 외침 한국어 라벨(버튼·로그용). */
export const SHOUT_LABEL: Record<ShoutType, string> = {
  urge: '독려', work: '더 뛰어', calm: '침착', praise: '칭찬',
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
  /** 사기 이월: 지정된 선수의 홈 시작 사기를 70 대신 이 값으로 덮어쓴다. */
  moraleOverride?: Record<string, number>
  /** 캠페인 징계 상태(경고 누적·출장정지). 데모는 넘기지 않는다 = 징계 없음. */
  discipline?: Discipline
}

/** 이 경기에 적용되는 우리 팀 징계 상태.
 *  워룸·작전판이 프롭 드릴링 없이 읽도록 matchStore가 킥오프 시점 스냅샷으로 들고 있는다
 *  (진실의 원천은 campaignStore이고, 경기 중에는 바뀌지 않는다). */
export interface Discipline {
  /** 이번 경기 출장정지 — 선발·교체 투입 모두 불가. */
  suspendedIds: string[]
  /** 대회 미소멸 누적 경고(장). 1장 보유자가 이번 경기에 또 받으면 다음 경기 결장이다. */
  cautions: Record<string, number>
}

const NO_DISCIPLINE: Discipline = { suspendedIds: [], cautions: {} }

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

/** 개입(submitCommand/applyTeamTalk)이 허용되는 phase.
 *  'pre'는 킥오프 전 전술 센터 — 감독이 계획을 세우는 시점이다. AI 상대는 처음부터
 *  자기 프로필 스타일로 출전하므로, 유저에게도 같은 출발선을 준다. */
const INTERVENTION_PHASES: MatchPhase[] = ['pre', 'paused-break', 'paused-user', 'paused-moment', 'halftime']

/** UI 컨트롤 활성 판정의 단일 진실원. 각 패널이 phase 목록을 따로 나열하면
 *  'pre' 승격 같은 변경이 한 곳에서 새어 store와 UI가 어긋난다. */
export function canIntervene(phase: MatchPhase): boolean {
  return INTERVENTION_PHASES.includes(phase)
}

/** 개입 권한 등급.
 *  - 'full'      전원 소집 — 선수 열한 명을 모아 놓고 지시할 수 있는 시점.
 *  - 'touchline' 터치라인 — 경기가 흐르는 중이라 교체와 열람만 가능.
 *  - 'none'      개입 불가. */
export type InterventionLevel = 'none' | 'touchline' | 'full'

/** 정지 사유에서 개입 권한 등급을 판정한다 — canIntervene 옆에 두는 두 번째 단일 진실원.
 *
 *  왜 등급을 나누는가: 실제 축구에서 포메이션·멘탈리티·전 전술 축을 갈아엎으려면
 *  선수단을 모아 놓고 말해야 한다. 경기가 흐르는 중에 감독이 할 수 있는 건 교체와
 *  터치라인에서 소리치는 정도다. 아무 때나 정지해 작전판을 통째로 여는 기존 동작은
 *  비현실적일 뿐 아니라, 정해진 개입 지점(하이드레이션 브레이크)을 컨셉의 중심에
 *  놓고서 정작 그 지점을 특별하지 않게 만든다.
 *
 *  'pre'는 pauseReason이 null이라 phase로 판정한다(킥오프 전 전술 센터 = 전원 소집). */
export function interventionLevel(phase: MatchPhase, pauseReason: PauseReason | null): InterventionLevel {
  if (phase === 'pre') return 'full'
  if (!INTERVENTION_PHASES.includes(phase)) return 'none'
  switch (pauseReason?.kind) {
    case 'hydration1':
    case 'hydration2':
    case 'halftime':
      return 'full'
    case 'user':
    case 'moment':
      return 'touchline'
    default:
      // 정지 phase인데 사유가 없다면(비정상) 가장 좁은 권한으로 떨어뜨린다.
      return 'touchline'
  }
}

/** 다음 '전원 소집' 시점(분). 하이드레이션 ×2와 하프타임(45) 중 현재 분 이후 가장 이른 것.
 *  남은 브레이크가 없으면 null. */
export function nextBreakMinute(minute: number, schedule: HydrationSchedule | null): number | null {
  const marks = schedule
    ? [schedule.firstHydration, 45, schedule.secondHydration]
    : [45]
  const next = marks.filter(m => m > minute).sort((x, y) => x - y)[0]
  return next ?? null
}

/** 터치라인 등급에서 화면에 띄울 안내 문구.
 *  UX 함정: 감독 타임에 들어갔는데 대부분이 잠겨 있으면 "고장난 건가"로 읽힌다.
 *  잠긴 이유와 언제 풀리는지를 반드시 함께 말해야 한다. */
export function touchlineNotice(minute: number, schedule: HydrationSchedule | null): string {
  const next = nextBreakMinute(minute, schedule)
  const head = `경기 진행 중 — 교체·외침과 ${TOUCHLINE_AXIS_TEXT} 지시만 가능합니다.`
  return next === null
    ? `${head} 남은 브레이크가 없습니다 — 포메이션·태세는 이대로 끝까지 갑니다.`
    : `${head} 포메이션·태세 변경은 다음 브레이크(${next}분)에서.`
}

// ── 터치라인 지시 (2026-08-01, round3 피드백 ②) ──────────────────────
// 왜 여는가: 개입 등급을 나눈 원래 근거가 *"경기가 흐르는 중에 할 수 있는 것은 소리치기와
// 교체뿐"*이었다. 그런데 "압박 올려!"·"템포 낮춰!"는 **바로 그 소리치기**다. 근거를 그대로
// 따르면 이 두 축은 터치라인에서 열려 있어야 하고, 닫아 둔 쪽이 근거와 어긋나 있었다.
//
// 왜 압박·템포만인가(라인·공격방향을 닫는 이유):
//  · 압박·템포는 **개인이 혼자 실행할 수 있는 노력 다이얼**이다. 한 명이 들어도 그 한 명이
//    바로 반응할 수 있다 — 소리쳐 전달되는 지시의 정의에 맞는다.
//  · 라인 높이는 백라인 네 명이 **동시에** 같은 오프사이드 선을 잡아야 성립한다. 한 명만
//    들으면 라인이 깨져 오히려 실점 경로가 된다(shape.ts가 라인 축을 백라인 전체의
//    평균 x로 정의하는 것도 같은 이유다). 공격방향은 공격 3~4명의 약속된 순환이라
//    마찬가지로 모아 놓고 다시 그려야 한다.
//  · 포메이션·태세·페이즈 포메이션·세트피스 루틴은 그보다 더 큰 구조 변경이라 그대로 잠근다.
//
// 왜 폭을 제한하는가: 소리쳐서 전달되는 것은 "지금보다 더/덜"이지 "68로 맞춰라"가 아니다.
// 한 번에 ±15까지만 움직인다 — 세 번 외치면 어차피 끝에서 끝까지 갈 수 있으므로 상한이
// 아니라 **속도 제한**이다.
//
// 왜 외침과 쿨다운을 공유하는가: 둘은 같은 행위다(터치라인에서 선수들의 주의를 끄는 일).
// 자원을 나눠 주면 "10분마다 외치고 + 10분마다 지시"로 개입 밀도가 두 배가 되고,
// "정지 시점이 곧 자원"이라는 설계가 pauseByUser 무제한과 맞물려 무너진다.
// 하나로 묶으면 90분에 최대 9회이고, 그중 몇 번을 지시에 쓸지가 감독의 선택이 된다.

/** 터치라인에서 소리쳐 전달할 수 있는 지시 축. */
export const TOUCHLINE_AXES = ['pressing', 'tempo'] as const
export type TouchlineAxis = (typeof TOUCHLINE_AXES)[number]
/** 터치라인 지시 1회의 축당 최대 변화폭. */
export const TOUCHLINE_STEP = 15
const TOUCHLINE_AXIS_TEXT = TOUCHLINE_AXES.map(k => INSTRUCTION_LABEL[k]).join('·')

/** 터치라인 지시로 성립하는 변경인가 — 축·폭만 본다(쿨다운은 store가 따로 본다).
 *  UI(ConsolePanel)와 store가 같은 함수를 쓴다. 규칙이 갈리면 화면은 허용하는데
 *  store가 throw하는 조합이 생긴다. */
export function touchlineOrderError(before: Instructions, after: Instructions): string | null {
  if (before.lineHeight !== after.lineHeight) {
    return '라인 높이는 백라인 전체가 동시에 잡아야 합니다 — 다음 브레이크에서.'
  }
  if (before.attackFocus !== after.attackFocus) {
    return '공격 방향 전환은 모아 놓고 다시 그려야 합니다 — 다음 브레이크에서.'
  }
  for (const k of TOUCHLINE_AXES) {
    if (Math.abs(after[k] - before[k]) > TOUCHLINE_STEP) {
      return `한 번에 ${INSTRUCTION_LABEL[k]}을(를) ${TOUCHLINE_STEP}보다 크게 바꿀 수 없습니다 — 소리쳐 전달되는 것은 "더/덜"입니다.`
    }
  }
  return null
}

/** 홈 주전(라인업, 퇴장 제외) 중 최저 스태미나. 동적 순간 'fatigue' 판정용. */
function homeStaminaFloor(engine: MatchState): number {
  const home = engine.home
  const vals = home.tactics.lineup
    .filter(l => !home.sentOff.includes(l.playerId))
    .map(l => home.staminaByPlayer[l.playerId] ?? 100)
  return vals.length ? Math.min(...vals) : 100
}

/**
 * 순간 제안 배너의 유효 기간(경기 분). 이 분이 지나면 자동 소거된다.
 *
 * 왜 만료가 필요한가: 제안 문장은 **그 순간의 상황 서술**이다("실점 직후입니다").
 * 무기한 남으면 2'에 뜬 실점 배너가 7' 동점 이후에도 같은 문장으로 떠 있어
 * 화면이 실제 스코어와 정반대의 말을 한다(실측: 10'→22' 12분 지속).
 *
 * 왜 5분인가: 유저가 반응할 시간이 먼저다. 재생 dwell(playback.ts)은 1x에서
 * 무사건 분 1.1 s · 사건 분 최대 9.6 s이고, 제안이 뜨는 분은 거의 항상 사건 분이다
 * (실점·득점은 골 dwell 8.6 s). 5분이면 1x에서 최소 13 s, 2x에서도 6~7 s가 남아
 * [사용]/[흘려보낸다]를 누를 여유가 있다. 반대로 10분을 주면 다음 제안이 뜰 때까지
 * 낡은 문장이 살아 있고(momentPrompt는 하나뿐이라 새 제안을 막는다), 하이드레이션
 * 브레이크 간격(약 22분)의 절반을 한 배너가 차지한다.
 *
 * 스코어 변화에 의한 소거는 이 기간과 별개로 즉시 적용된다 — 만료보다 강한 신호다.
 */
export const MOMENT_PROMPT_TTL = 5

/** 이 분에 순간 제안을 그대로 유지해도 되는가. 스코어가 스냅샷과 다르거나
 *  유효 기간이 지났으면 false(= 소거). 순수 함수라 테스트가 직접 부른다. */
export function momentPromptAlive(
  prompt: DecisionMoment | null, promptScore: readonly [number, number] | null,
  minute: number, score: readonly [number, number],
): boolean {
  if (!prompt) return false
  if (minute - prompt.minute > MOMENT_PROMPT_TTL) return false
  // 스냅샷이 없는 경우(구 상태 호환)는 스코어 판정을 건너뛴다.
  if (promptScore && (promptScore[0] !== score[0] || promptScore[1] !== score[1])) return false
  return true
}

/** 상대 감독의 변경 1건 통보(발동 분 + 배너 문구). */
export interface OppNotice { minute: number; text: string }

/** 구조 변경(포메이션·멘탈리티) 직후 적응 지연 지속(분). advanceMinute이 엔진에 전달. */
const ADAPT_MINUTES = 3

/** 지시 축을 "이탈"로 셀 최소 변화량. 이보다 작은 조정은 감독의 정상 업무로 본다. */
const AXIS_DEVIATION_THRESHOLD = 10

/** 킥오프 플랜 대비 변경된 축 수. 지시 4축은 10 이상 차이날 때만 센다
 *  — 미세 조정은 감독의 정상 업무이고, 구조 변경(포메이션·멘탈리티)이 진짜 "계획 이탈"이다.
 *  선택 필드(mentality·attackPattern)는 미지정을 'balanced'로 정규화해 비교한다
 *  — 그러지 않으면 UI가 명시값을 써 넣기만 해도 이탈로 집계된다. */
export function computeDeviation(plan: TacticState, cur: TacticState): number {
  let n = 0
  if (plan.formation !== cur.formation) n++
  if ((plan.mentality ?? 'balanced') !== (cur.mentality ?? 'balanced')) n++
  if ((plan.attackPattern ?? 'balanced') !== (cur.attackPattern ?? 'balanced')) n++
  for (const k of ['lineHeight', 'pressing', 'tempo'] as const) {
    if (Math.abs(plan.instructions[k] - cur.instructions[k]) >= AXIS_DEVIATION_THRESHOLD) n++
  }
  if (plan.instructions.attackFocus !== cur.instructions.attackFocus) n++
  return n
}

/** 플랜의 '구조'(포메이션·멘탈리티)가 그대로인가 — 팀 이해도 보너스·배지 판정의 단일 진실원.
 *  store·PlanBadge가 각자 판정하면 UI가 "유지"라고 말하는데 엔진은 보너스를 안 주는 괴리가 생긴다. */
export function isPlanStructIntact(plan: TacticState | null, cur: TacticState | undefined): boolean {
  if (!plan || !cur) return false
  return plan.formation === cur.formation
    && (plan.mentality ?? 'balanced') === (cur.mentality ?? 'balanced')
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
    /** momentPrompt를 세팅한 분의 스코어 스냅샷. 스코어가 바뀌면 제안 문장이 거짓이 되므로
   *  이 값과 현재 스코어를 비교해 즉시 소거한다. null이면 제안 없음. */
  momentPromptScore: [number, number] | null
  /** 개입 부스트 만료 분(그 분까지 홈 지시 효과 ×1.3). advanceMinute이 엔진에 전달. */
  boostUntil: number
  /** 하프타임 팀토크 1회 제한 플래그. */
  talked: boolean
  /** 마지막 터치라인 외침 분(쿨다운 계산·진행 표시용). null이면 아직 외침 없음. */
  lastShoutMinute: number | null
  /** 감독 개입 로그 — 기자회견 근거. startMatch/reset 시 초기화. */
  decisionLog: DecisionEntry[]
  /** 상대 AI가 이미 발동한 액션 키(유형당 1회 제한). */
  oppFired: string[]
  /** 상대 변경 통보 이력 — 방송 배너·작전판 상대 탭 타임라인. */
  oppNotices: OppNotice[]
  /** 킥오프 시점에 고정된 홈 전술 스냅샷. null이면 아직 킥오프 전(플랜 없음). */
  matchPlan: TacticState | null
  /** 킥오프 플랜 대비 변경된 축 수 — 누적 최대치. 되돌려도 줄지 않는다:
   *  "한 번 계획을 버렸다"는 사실이 남아야 기자회견 추궁이 성립한다. */
  planDeviation: number
  /** 적응 지연 만료 분(구조 변경 직후). 0이면 지연 없음. */
  adaptUntil: number
  /** 이 경기 우리 팀 징계 상태(킥오프 시점 스냅샷). 데모·기본값은 빈 상태. */
  discipline: Discipline
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
  /** 하프타임 팀토크 — 결정론 사기 보정 후 즉시 효과 결과 반환.
   *  opts.expectation: 상대 기대치(FIFA 랭킹 차) 보정, opts.repeated: 지난 경기와 같은 톤이면 효과 반감. */
  applyTeamTalk(side: 'home' | 'away', tone: TeamTalkTone, opts?: { expectation?: Expectation; repeated?: boolean }): TeamTalkResult
  /** 터치라인 외침 — playing 중 즉시(정지 없음). 10분 쿨다운·결정론 사기/체력 보정·로그.
   *  홈(감독) 전용. 쿨다운 중이거나 재생 중이 아니면 throw. */
  shout(type: ShoutType): void
  logShootoutSetup(summary: string): void
  reset(): void
}

const initial = {
  phase: 'pre' as MatchPhase,
  engine: null as MatchState | null,
  schedule: null as HydrationSchedule | null,
  pauseReason: null as PauseReason | null,
  momentPrompt: null as DecisionMoment | null,
  momentPromptScore: null as [number, number] | null,
  firedMoments: [] as DecisionMoment['kind'][],
  boostUntil: 0,
  talked: false,
  lastShoutMinute: null as number | null,
  decisionLog: [] as DecisionEntry[],
  oppFired: [] as string[],
  oppNotices: [] as OppNotice[],
  matchPlan: null as TacticState | null,
  planDeviation: 0,
  adaptUntil: 0,
  discipline: NO_DISCIPLINE,
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
    // 사기 이월: createMatch는 전원 70으로 초기화한다. 같은 규약으로 지정 선수만 덮어쓴다.
    if (opts?.moraleOverride) {
      for (const [id, v] of Object.entries(opts.moraleOverride)) {
        if (id in engine.home.moraleByPlayer) engine.home.moraleByPlayer[id] = v
      }
    }
    set({ ...initial, engine, schedule: breakSchedule(seed), discipline: opts?.discipline ?? NO_DISCIPLINE })
  },
  kickoff: () => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'pre') return
    // 킥오프 시점의 전술을 플랜으로 고정한다 — 이후의 모든 변경은 planDeviation으로 계측되고,
    // 경기 후 기자회견이 그 수치를 근거로 감독을 추궁한다.
    set({ phase: 'playing', matchPlan: structuredClone(engine.home.tactics), planDeviation: 0, adaptUntil: 0 })
  },
  advanceMinute: () => {
    const { engine, phase, schedule, firedMoments, momentPrompt: prevPrompt, momentPromptScore: prevPromptScore, boostUntil, oppFired, oppNotices, matchPlan, adaptUntil } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'playing') return // 정지 중엔 재개(confirmTactics)로만 진행
    const prevScore: [number, number] = [engine.score[0], engine.score[1]]
    // 개입 부스트 전달: confirmTactics가 세팅한 boostUntil이 이 분을 덮으면 홈(유저)에 고정 보너스.
    // 여기에 플랜 유지 보너스(팀 이해도)와 구조 변경 적응 지연을 함께 조립한다.
    // 셋 다 비활성이면 opts 없이 호출 → 기존 동작 불변.
    const nextMinute = engine.minute + 1
    const opts: SimulateOpts = {
      ...(boostUntil >= nextMinute ? { instructionBoost: { side: 'home' as const, until: boostUntil } } : {}),
      ...(isPlanStructIntact(matchPlan, engine.home.tactics) ? { planIntact: 'home' as const } : {}),
      ...(adaptUntil >= nextMinute ? { adaptLag: { side: 'home' as const, until: adaptUntil } } : {}),
    }
    let next = simulateSegment(engine, nextMinute, Object.keys(opts).length ? opts : undefined)
    const minute = next.minute

    // 상대 감독 — 창(46/60/70/80)에서 교체·전술 스위칭. 완전 결정론이라 시드 회귀에 안전하다.
    // phase 전이 판정보다 먼저 적용해야 하프타임·브레이크 직전 분에도 반영된다.
    let firedNext = oppFired
    let noticesNext = oppNotices
    for (const a of decideAwayActions(next, minute, firedNext)) {
      // 최종 방어선 — 상대 AI가 어떤 이유로든 재투입을 시도하면 여기서 버린다.
      // oppAi가 이미 후보에서 제외하지만, applyCommand(엔진)는 이 규칙을 모른다.
      if (a.cmd.type === 'sub' && subbedOffIds(next.events, next.away.team.id).includes(a.cmd.in)) continue
      try {
        next = applyCommand(next, 'away', a.cmd)
      } catch {
        // 교체 한도 초과 등은 조용히 건너뛴다 — 상대 AI의 실패가 경기를 멈추면 안 된다.
        continue
      }
      firedNext = [...firedNext, a.notice]
      noticesNext = [...noticesNext, { minute, text: a.notice }]
    }
    // 아래 모든 분기가 이 두 필드를 함께 써야 한다. 하나라도 빠지면 상대 AI가 같은
    // 액션을 무한 반복하거나(oppFired 소실) 통보가 사라진다.
    const opp = { oppFired: firedNext, oppNotices: noticesNext }

    // 순간 제안 만료 — 상황 서술은 상황이 유지될 때만 참이다. 스코어가 바뀌었거나
    // 유효 기간이 지난 제안은 여기서 버린다(MOMENT_PROMPT_TTL 주석 참조).
    // 감지보다 **먼저** 판정해야 낡은 제안이 새 제안을 계속 막지 않는다.
    const alive = momentPromptAlive(prevPrompt, prevPromptScore, minute, next.score)
    const momentPrompt = alive ? prevPrompt : null
    const expiry = alive ? {} : { momentPrompt: null, momentPromptScore: null }

    if (minute >= 90) {
      set({ engine: next, phase: 'fulltime', pauseReason: null, momentPrompt: null, momentPromptScore: null, ...opp })
      return
    }
    if (minute === 45) {
      set({ engine: next, phase: 'halftime', pauseReason: { kind: 'halftime' }, ...expiry, ...opp })
      return
    }
    if (schedule && minute === schedule.firstHydration) {
      set({ engine: next, phase: 'paused-break', pauseReason: { kind: 'hydration1' }, ...expiry, ...opp })
      return
    }
    if (schedule && minute === schedule.secondHydration) {
      set({ engine: next, phase: 'paused-break', pauseReason: { kind: 'hydration2' }, ...expiry, ...opp })
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
        set({
          engine: next, momentPrompt: moment, momentPromptScore: [next.score[0], next.score[1]],
          firedMoments: [...firedMoments, moment.kind], ...opp,
        })
        return
      }
    }
    set({ engine: next, ...expiry, ...opp })
  },
  pauseByUser: () => {
    const { engine, phase } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'playing') return
    set({ phase: 'paused-user', pauseReason: { kind: 'user' } })
  },
  confirmTactics: () => {
    const { engine, phase, pauseReason } = get()
    if (!engine) throw new Error('경기 미시작')
    if (!INTERVENTION_PHASES.includes(phase)) throw new Error('개입 중이 아님')
    // 킥오프 전 계획에는 인게임 부스트를 주지 않는다(사전 계획과 실시간 개입의 가치를 구분).
    // 재생 시작도 하지 않는다 — 'pre'의 진행은 kickoff()가 담당한다.
    if (phase === 'pre') return
    // 개입 직후 부스트: 지금부터 BOOST_MINUTES분간 찬스 퀄 +8%·실점 위험 −6%(advanceMinute이 엔진 전달).
    // 단 자유 정지(감독 타임)에는 주지 않는다 — pauseByUser에 횟수 제한이 없어
    // 8분마다 정지·확정만 반복하면 부스트가 상시 유지되는 공짜 이득이 생긴다.
    // 정해진 개입 지점(하이드레이션·하프타임·상황 제안)만 "선수단이 지시를 받는
    // 순간"으로 보고 효과를 싣는다. 감독 타임은 상황을 들여다보는 자유 정지다.
    const scheduled = pauseReason?.kind !== 'user'
    set({
      phase: 'playing', pauseReason: null, momentPrompt: null, momentPromptScore: null,
      ...(scheduled ? { boostUntil: engine.minute + BOOST_MINUTES } : {}),
    })
  },
  acceptMoment: () => {
    const { phase, momentPrompt } = get()
    if (phase !== 'playing') throw new Error('재생 중이 아님')
    if (!momentPrompt) throw new Error('제안된 순간이 없음')
    set({ phase: 'paused-moment', pauseReason: { kind: 'moment', moment: momentPrompt } })
  },
  dismissMoment: () => set({ momentPrompt: null, momentPromptScore: null }),
  submitCommand: (side, cmd) => {
    const { engine, phase, pauseReason, schedule, decisionLog, matchPlan, planDeviation } = get()
    if (!engine) throw new Error('경기 미시작')
    if (!INTERVENTION_PHASES.includes(phase)) throw new Error('개입 불가 시점')
    // 스토어가 최종 방어선이다 — UI가 섹션을 접는 것만으로는 부족하다.
    // 터치라인 등급에서 통과하는 것은 둘뿐이다: 교체, 그리고 압박·템포 지시(소리쳐 전달되는
    // 범위 — TOUCHLINE_AXES 주석 참조). 나머지는 전원 소집 사항이라 여기서 막는다.
    const touchline = interventionLevel(phase, pauseReason) === 'touchline'
    if (touchline && cmd.type !== 'sub') {
      if (cmd.type !== 'instructions') throw new Error(touchlineNotice(engine.minute, schedule))
      const axisErr = touchlineOrderError(engine[side].tactics.instructions, cmd.instructions)
      if (axisErr) throw new Error(axisErr)
      // 외침과 같은 자원을 쓴다 — 둘 다 "터치라인에서 주의를 끄는" 같은 행위다.
      const last = get().lastShoutMinute
      if (last !== null && engine.minute - last < SHOUT_COOLDOWN) {
        throw new Error(`터치라인 지시 쿨다운 — ${SHOUT_COOLDOWN - (engine.minute - last)}분 뒤에 다시 외칠 수 있습니다.`)
      }
    }
    const minute = engine.minute
    const sideState = engine[side]
    // IFAB 제3조 — 교체되어 나간 선수는 그 경기에 다시 출전할 수 없다. 스토어가 최종
    // 방어선이다: 교체 탭은 이미 카드를 잠그지만, 작전판 보드 등 다른 호출부가 늘어나면
    // UI 잠금만으로는 샌다. 양 팀 모두에 같은 규칙을 적용한다(엔진은 이 규칙을 모른다).
    if (cmd.type === 'sub' && subbedOffIds(engine.events, sideState.team.id).includes(cmd.in)) {
      throw new Error('교체로 나간 선수는 다시 투입할 수 없습니다 (IFAB 제3조)')
    }
    // 시점 라벨: 킥오프 전 / HT / N'. 결정 로그는 기자회견의 근거가 되므로
    // "언제 내린 결정인가"가 서사적으로 중요하다. 세 명령 분기가 같은 규칙을 쓴다.
    const when = phase === 'pre' ? '킥오프 전' : phase === 'halftime' ? 'HT' : `${minute}'`
    let entry: DecisionEntry | null = null
    if (cmd.type === 'instructions') {
      const changed = instructionDiff(sideState.tactics.instructions, cmd.instructions)
      // 변경 축이 0개면 로그 스킵(엔진 적용은 그대로) — "45' 지시 변경: " 같은 빈 요약 방지.
      if (changed.length > 0) {
        // 터치라인에서 내린 지시는 로그에서도 구분한다 — 기자회견이 "언제 어떻게 개입했나"를
        // 추궁할 때 브레이크 지시와 경기 중 외침은 성격이 다른 결정이다.
        const kindText = touchline ? '터치라인 지시' : '지시 변경'
        entry = { minute, kind: 'instructions', summary: `${when} ${kindText}: ${changed.join(', ')}`, detail: { changed, touchline } }
      }
    } else if (cmd.type === 'sub') {
      const nameOf = (id: string) => sideState.team.squad.find(p => p.id === id)?.name.ko ?? id
      entry = { minute, kind: 'sub', summary: `${when} 교체: ${nameOf(cmd.in)} IN, ${nameOf(cmd.out)} OUT`, detail: { in: cmd.in, out: cmd.out } }
    } else if (cmd.type === 'formation') {
      const before = sideState.tactics.formation, after = cmd.tactics.formation
      if (before !== after) {
        entry = { minute, kind: 'instructions', summary: `${when} 포메이션: ${before}→${after}`, detail: { before, after } }
      }
    }
    const nextEngine = applyCommand(engine, side, cmd)
    // 플랜 이탈은 홈(감독)에게만, 그리고 킥오프 이후에만 센다.
    // 'pre'의 변경은 아직 플랜을 '짜는' 중이므로 이탈이 아니다(matchPlan이 null이라 자연히 제외된다).
    const before = engine.home.tactics, after = nextEngine.home.tactics
    const dev = side === 'home' && matchPlan
      ? Math.max(planDeviation, computeDeviation(matchPlan, after))
      : planDeviation
    // 적응 지연은 구조 변경(포메이션·멘탈리티)에만 건다 — 지시 미세 조정은 개입 부스트의 영역이라
    // 둘을 같은 변경에 겹쳐 걸면 부스트와 지연이 서로를 상쇄해 어느 쪽도 체감되지 않는다.
    const structChanged = side === 'home' && !!matchPlan
      && (before.formation !== after.formation
        || (before.mentality ?? 'balanced') !== (after.mentality ?? 'balanced'))
    // 터치라인 지시가 실제로 무언가를 바꿨을 때만 자원을 소모한다(같은 값 재전송은 무료).
    const consumesShout = touchline && cmd.type === 'instructions' && !!entry
    set({
      engine: nextEngine,
      planDeviation: dev,
      ...(structChanged ? { adaptUntil: engine.minute + ADAPT_MINUTES } : {}),
      ...(consumesShout ? { lastShoutMinute: engine.minute } : {}),
      ...(entry ? { decisionLog: [...decisionLog, entry] } : {}),
    })
  },
  applyTeamTalk: (side, tone, opts) => {
    const { engine, phase, talked } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'halftime') throw new Error('팀토크는 하프타임에만 가능')
    if (talked) throw new Error('팀토크는 경기당 1회만 가능')
    const situation = scoreSituation(engine.score, side)
    const expectation = opts?.expectation ?? 'even'
    const repeated = opts?.repeated ?? false
    // 기본 테이블 + 기대치 보정, 반복이면 반감(울림이 덜하다). 정수로 반올림.
    const base = TEAM_TALK_TABLE[situation][tone] + EXPECTATION_ADJUST[expectation][situation][tone]
    const delta = repeated ? Math.round(base / 2) : base
    const next = structuredClone(engine)
    const sideState = next[side]
    const morale = sideState.moraleByPlayer
    for (const id of Object.keys(morale)) {
      morale[id] = Math.max(0, Math.min(100, morale[id] + delta))
    }
    // 선수별 반응 2~3명: keyPlayers(주장 역할) 우선, 부족분은 선발 라인업에서 채운다(결정론).
    const keyIds = sideState.team.profile.keyPlayers.map(k => k.playerId)
    const lineupIds = sideState.tactics.lineup.map(l => l.playerId)
    const picked: string[] = []
    for (const id of [...keyIds, ...lineupIds]) {
      if (!picked.includes(id) && id in morale) picked.push(id)
      if (picked.length >= 3) break
    }
    const reactions = picked.map((playerId, idx) => ({ playerId, icon: reactionIcon(delta, idx) }))
    const entry: DecisionEntry = {
      minute: engine.minute, kind: 'teamtalk',
      summary: `HT 팀토크: ${TONE_LABEL[tone]}`, detail: { tone, situation, expectation, repeated, delta },
    }
    set({ engine: next, talked: true, decisionLog: [...get().decisionLog, entry] })
    return { delta, repeated, reactions }
  },
  shout: (type) => {
    const { engine, phase, lastShoutMinute, decisionLog } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'playing') throw new Error('외침은 재생 중에만 가능')
    const minute = engine.minute
    if (lastShoutMinute !== null && minute - lastShoutMinute < SHOUT_COOLDOWN) {
      throw new Error('외침 쿨다운 중')
    }
    const situation = scoreSituation(engine.score, 'home')
    const { morale, stamina } = SHOUT_TABLE[situation][type]
    // ★ 단순화: 엔진 전달 없이 홈 사기/체력을 직접 보정(applyTeamTalk 방식). 정지 없음.
    const next = structuredClone(engine)
    const m = next.home.moraleByPlayer
    for (const id of Object.keys(m)) m[id] = Math.max(0, Math.min(100, m[id] + morale))
    if (stamina !== 0) {
      const s = next.home.staminaByPlayer
      for (const id of Object.keys(s)) s[id] = Math.max(0, Math.min(100, s[id] + stamina))
    }
    const entry: DecisionEntry = {
      minute, kind: 'teamtalk',
      summary: `${minute}' 외침: ${SHOUT_LABEL[type]}`,
      detail: { shout: type, situation, morale, stamina },
    }
    set({ engine: next, lastShoutMinute: minute, decisionLog: [...decisionLog, entry] })
  },
  logShootoutSetup: (summary) => {
    const { engine, decisionLog } = get()
    const entry: DecisionEntry = { minute: engine?.minute ?? 90, kind: 'shootout-setup', summary }
    set({ decisionLog: [...decisionLog, entry] })
  },
  reset: () => set({ ...initial }),
}))
