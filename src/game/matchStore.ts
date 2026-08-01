// src/game/matchStore.ts
import { create } from 'zustand'
import { createMatch, simulateSegment, applyCommand, type MatchCommand, type SimulateOpts } from '../engine/simulate'
import type {
  AttackPattern, BoxLoad, DecisionEntry, GroupIntensity, Instructions, MatchEvent, MatchState,
  Mentality, SetPieceMarking, SetPieceRoute, TacticState, Team,
} from '../engine/types'
import { MENTALITIES } from '../engine/tactics'
import { createRng } from '../engine/rng'
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

// ── 외침은 개입이 아니다 (2026-08-01 재판정, 사용자 지시) ─────────────────
//
// 어제까지 외침은 자유 개입 5회·10분 쿨다운을 **감독 타임과 공유**했다(8b6a86e).
// 근거는 *"둘 다 터치라인에서 선수들의 주의를 끄는 같은 행위"*였고, 그 근거가 틀렸다.
// 사용자: *"이런 감독이 소리치는 거에 5 개입으로 보는 게 더 이상해."*
//
// **무엇이 다른가 — 남는가 아닌가.**
//  · 외침("더 뛰어!")은 사기·체력에 **일시적 자극**을 준다. 경기를 세우지 않고, 감독은
//    터치라인에 선 채 90분 내내 소리친다. 실제 축구에서 이건 자원이 아니라 습관이다.
//  · 감독 타임은 경기를 **세우고** 작전판을 열어 팀의 상태를 **영구히** 바꾼다.
//    랜딩이 약속한 "다섯 번의 개입"의 실체가 이것이다.
// 자원 회계는 "얼마나 오래 남는가"를 따라가야 한다. 한 마디 지르는 것과 판을 여는 것을
// 같은 통장에서 빼면, 유저는 지르는 것이 아까워서 지르지 않게 된다 — 실제로 그랬다.
//
// **그래서 터치라인 지시(라인·압박·템포·공격방향 슬라이더)는 어느 쪽인가 — 개입이다.**
// 세 가지 근거가 같은 곳을 가리킨다:
//  ① **결과가 남는다.** 슬라이더가 옮긴 값은 그 뒤 모든 분의 시뮬레이션에 들어간다.
//     외침의 사기 보정처럼 잦아들지 않는다. 위 기준(남는가)이 그대로 적용된다.
//  ② **경기를 세워야만 도달한다.** submitCommand는 INTERVENTION_PHASES에서만 통과하고,
//     터치라인 등급이 붙는 phase는 paused-user·paused-moment — 둘 다 **이미 개입을 한 번
//     쓴 뒤**다. 여기에 외침 시계를 걸면 "개입을 썼는데 그 안에서 아무 말도 못 한다"가 된다.
//  ③ **조작이 다르다.** 소리치는 것은 버튼 하나고, 지시는 슬라이더를 보며 수치를 고르는
//     일이다. 유저가 화면을 열어 값을 읽고 있다면 그건 이미 감독 타임이다.
//
// 결론: **두 개의 시계**를 둔다. 나누면 "외쳤는데 감독 타임은 되는" 상태가 생기지만
// 그건 모순이 아니라 **의도**다 — 셋이 같은 것이라는 전제가 기각됐기 때문이다.

/** 외침 쿨다운(분) — 자유 개입 횟수와 **무관**하고, 이 시계만 지키면 몇 번이든 외친다.
 *  5분: 90분에 최대 18회. "언제 지를까"를 계획하게 만들지 않을 만큼 흔하고,
 *  매 분 연타로 사기를 펌프질할 수는 없을 만큼은 드물다. */
export const SHOUT_COOLDOWN = 5

/** 자유 개입(감독 타임·터치라인 지시 창) 쿨다운(분). 외침과 **다른 시계**다. */
export const INTERVENTION_COOLDOWN = 10

/** 지금 외칠 수 있는가 — 쿨다운·사유를 한 번에 답한다(freeInterventionState의 외침판).
 *  순수 함수라 UI와 store가 같은 판정을 쓴다. 자유 개입 잔량은 **보지 않는다** — 그것이
 *  이 분리의 요점이다. */
export function shoutState(
  lastShoutMinute: number | null,
  minute: number,
): { cooldownLeft: number; canShout: boolean; blockedReason: string | null } {
  const cooldownLeft = lastShoutMinute === null
    ? 0
    : Math.max(0, SHOUT_COOLDOWN - (minute - lastShoutMinute))
  return cooldownLeft > 0
    ? {
        cooldownLeft, canShout: false,
        blockedReason: `목이 쉰다 — ${cooldownLeft}분 뒤에 다시 외칠 수 있습니다(개입 횟수와는 무관합니다).`,
      }
    : { cooldownLeft: 0, canShout: true, blockedReason: null }
}

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

// ── 외침의 결과를 보여 준다 (2026-08-01, 사용자 지시) ────────────────────
// *"실제 바뀌는 결과도 팝업으로 잠깐 보여지고 사라지게… 누가 얼마나 올랐는지…
//   매번 같은 거 선택하고 같은 선수들이 영향을 받는 게 아니라 이건 랜덤하게."*
//
// **결정론과 다양성을 어떻게 양립시켰는가** — 이 프로젝트는 `Math.random()`을 금지한다
// (리더보드·리플레이가 시드 재현에 의존한다). 그래서 무작위성의 출처를 **시드 파생**으로
// 옮긴다: `createRng(seed·소수 + 분·소수 + 외침 종류)`.
//  · 같은 시드 · 같은 분 · 같은 외침 → **언제나 같은 결과**(재현 계약).
//  · 그런데 유저에게는 매번 다르다 — 외침 쿨다운이 5분이라 두 번째 외침은 반드시 다른
//    분이고, 분이 스트림을 통째로 갈아 치운다. 여기에 대상 가중치가 그 순간의 사기·체력·
//    카드·득점을 읽으므로, 같은 분이라도 경기 상황이 다르면 다른 사람이 뽑힌다.
// 즉 다양성은 난수가 아니라 **경기 상태의 다양성**에서 나온다. 그게 이 게임이 팔려는
// 것이기도 하다 — 같은 말도 다른 라커룸에서는 다르게 먹힌다.
//
// **왜 완전 무작위로 뽑지 않는가**: 아무나 뽑으면 유저는 팝업을 두 번 보고 읽기를 그만둔다.
// 대상 선정을 **상태와 연결**하면 패턴을 발견할 수 있다("더 뛰어는 체력 남은 선수에게
// 잘 먹히는구나"). 다만 결정적이면 다시 "매번 같다"로 돌아가므로, 상태는 **가중치**로만
// 쓰고 뽑기 자체는 rng.weighted에 맡긴다 — 경향은 보이되 명단은 고정되지 않는다.

/** 외침이 특히 닿은 선수 한 명. */
export interface ShoutTarget {
  playerId: string
  name: string
  /** 이 선수의 사기가 **실제로** 움직인 양(팀 일괄분 + 추가분, 0~100 클램프 반영 후). */
  morale: number
}

/** 외침 직후 UI가 잠깐 띄우는 결과. 팀토크 결과 배너(TeamTalkResult)와 같은 문법이다. */
export interface ShoutResult {
  type: ShoutType
  situation: ScoreSituation
  /** 전원에게 걸린 기본 사기 delta(SHOUT_TABLE). */
  teamMorale: number
  /** 전원에게 걸린 기본 체력 delta(SHOUT_TABLE). 0이면 체력은 건드리지 않았다. */
  teamStamina: number
  /** 특히 반응한 선수 2~3명 — "누가 얼마나"의 실체. */
  targets: ShoutTarget[]
  /** 역효과(팀 사기가 내려갔다) — 배너가 색을 뒤집는 근거. */
  backfire: boolean
  /** 이 외침이 **누구에게** 잘 닿는지 한 줄. 유저가 패턴을 발견하는 통로다. */
  affinity: string
}

/** 외침별 대상 성향 문구 — 가중치 규칙(shoutTargets)과 **같은 사실**을 말해야 한다. */
const SHOUT_AFFINITY: Record<ShoutType, string> = {
  urge: '가라앉은 선수에게 먼저 닿습니다',
  work: '체력이 남은 선수가 먼저 반응합니다',
  calm: '경고를 받은 선수부터 가라앉힙니다',
  praise: '오늘 해낸 선수에게 먼저 닿습니다',
}

/** 외침 종류별 시드 오프셋 — 같은 분에 종류만 바꿔도 다른 스트림이 되게 한다(서로소 소수). */
const SHOUT_SEED: Record<ShoutType, number> = { urge: 3, work: 5, calm: 7, praise: 11 }

/**
 * 이 외침이 특히 닿을 선수 2~3명을 고른다 — **가중 추첨**이고, 가중치는 현재 상태에서 온다.
 * 후보는 퇴장을 뺀 선발 11인이다(벤치는 소리를 듣지만 경기에 없다).
 *
 * 가중치는 전부 하한 0.2를 둔다. 0을 주면 그 선수는 영영 뽑히지 않아 "매번 같은 사람들"이
 * 되고, 그것이 사용자가 지적한 바로 그 증상이다. 하한은 경향과 다양성을 함께 남긴다.
 */
function shoutTargets(
  engine: MatchState, type: ShoutType, rng: ReturnType<typeof createRng>,
): string[] {
  const side = engine.home
  const ids = side.tactics.lineup
    .map(l => l.playerId)
    .filter(id => !side.sentOff.includes(id) && id in side.moraleByPlayer)
  if (ids.length === 0) return []
  // 이 경기에서 경고를 받은 선수 / 공격포인트를 낸 선수 — 침착·칭찬의 가중치 원천.
  const booked = new Set(engine.events.filter(e => e.type === 'yellow' && e.playerId).map(e => e.playerId!))
  const scored = new Set(
    engine.events
      .filter(e => e.type === 'goal' && e.teamId === side.team.id)
      .flatMap(e => [e.playerId, e.assistId].filter(Boolean) as string[]),
  )
  const items = ids.map(id => {
    const morale = side.moraleByPlayer[id] ?? 70
    const stamina = side.staminaByPlayer[id] ?? 100
    let w: number
    switch (type) {
      // 독려는 일으켜 세우는 말이다 — 이미 펄펄 나는 선수에게는 할 말이 아니다.
      case 'urge': w = (100 - morale) / 20; break
      // 뛸 수 있는 다리가 남아 있어야 "더 뛰어"가 명령이 된다. 지친 선수에겐 잔소리다.
      case 'work': w = stamina / 20; break
      // 진정시킬 대상은 흥분한 선수다. 카드를 받은 선수가 가장 뚜렷한 신호(×4).
      case 'calm': w = (morale / 25) * (booked.has(id) ? 4 : 1); break
      // 칭찬은 근거가 있어야 한다 — 오늘 골·어시스트를 낸 선수(×4).
      case 'praise': w = (morale / 25) * (scored.has(id) ? 4 : 1); break
    }
    return { item: id, w: Math.max(0.2, w) }
  })
  const want = Math.min(items.length, rng.int(2, 3))
  const picked: string[] = []
  const pool = [...items]
  for (let i = 0; i < want && pool.length > 0; i++) {
    const id = rng.weighted(pool)
    picked.push(id)
    pool.splice(pool.findIndex(p => p.item === id), 1)
  }
  return picked
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
 *  잠긴 이유와 언제 풀리는지를 반드시 함께 말해야 한다.
 *  ★ 2026-08-01 확장 개방 이후로는 **잠긴 쪽이 소수**다. 그러니 안내도 "무엇만 되는가"가
 *    아니라 "무엇만 안 되는가"를 말해야 화면과 사실이 맞는다. */
export function touchlineNotice(minute: number, schedule: HydrationSchedule | null): string {
  const next = nextBreakMinute(minute, schedule)
  const head = `경기 진행 중 — 교체·외침과 ${TOUCHLINE_AXIS_TEXT} 지시가 열려 있습니다.`
  const tail = `${TOUCHLINE_LOCKED_TEXT}만 잠깁니다`
  return next === null
    ? `${head} ${tail} — 남은 브레이크가 없습니다. 이 대형으로 끝까지 갑니다.`
    : `${head} ${tail} — 다음 브레이크(${next}분)에서 바꿀 수 있습니다.`
}

// ── 터치라인 지시 (2026-08-01, round3 피드백 ② → 확장 개방) ──────────────
// 왜 여는가: 개입 등급을 나눈 원래 근거가 *"경기가 흐르는 중에 할 수 있는 것은 소리치기와
// 교체뿐"*이었다. 그런데 "압박 올려!"·"라인 내려!"·"더 공격적으로!"는 **바로 그 소리치기**다.
// 근거를 그대로 따르면 이 축들은 터치라인에서 열려 있어야 하고, 닫아 둔 쪽이 근거와
// 어긋나 있었다. 1차 개방(압박·템포)은 그 근거를 절반만 적용한 것이었다.
//
// ★ 왜 라인 높이를 열었는가(1차 개방의 논거를 뒤집는다):
//   1차 개방은 "백라인 네 명이 **동시에** 같은 오프사이드 선을 잡아야 하니 한 명만 들으면
//   라인이 깨진다"는 이유로 라인을 닫았다. 그러나 실제 경기에서 터치라인 감독이 가장 자주
//   내리는 지시가 바로 "라인 올려"·"내려"다 — 백라인은 서로를 보며 맞추는 훈련된 유닛이라
//   한 명이 듣고 손을 들면 나머지가 따라간다. "동시에 실행해야 한다"는 사실은 **전달 대역폭**의
//   문제가 아니라 **실행 정밀도**의 문제였고, 후자는 폭 제한(±15)이 이미 다루고 있다.
//   사용자 결정(2026-08-01)이 이 판정의 정본이다.
//
// ★ 그래서 잠기는 것은 무엇인가 — "포메이션의 경계":
//   기준은 **대형 재배치인가**이다. 소리쳐 전달되는 것은 "어떻게 뛰어라"이지 "어디에 서라"가
//   아니다. 열한 명의 좌표를 다시 그리는 일은 선수들을 모아 놓고 판을 보여 줘야 한다.
//    · formation(선발 대형 문자열) — 정의상 대형 재배치다.
//    · phaseFormations(공격 시·수비 시 대형) — 이것도 **대형**이다. 페이즈별이라고 해서
//      성격이 달라지지 않는다. 오히려 "언제 어느 대형으로 바뀌는가"라는 약속이라 더 큰
//      합의가 필요하다.
//    · lineup(슬롯 배치) — 자리 바꾸기는 좌표 재배치 그 자체다. 단 교체({type:'sub'})는
//      규칙이 정지 상황을 보장하므로 예외다(원래부터 열려 있다).
//   반대로 mentality·groupIntensity·attackPattern·setPiece·instructions는 **같은 대형 안에서
//   어떻게 행동할지**를 정하는 태도·실행 지시라 전부 열었다. 세트피스도 마찬가지다:
//   루틴 자체는 훈련장에서 약속하지만, 코너 앞에서 **이미 약속된 것 중 하나를 고르는** 것은
//   실제로 손짓 하나로 전달된다. 새 루틴을 발명하는 것이 아니다.
//
// 왜 폭을 제한하는가: 소리쳐서 전달되는 것은 "지금보다 더/덜"이지 "68로 맞춰라"가 아니다.
// 수치 축은 한 번에 ±15, 서열 축(멘탈리티 5단·그룹 적극성 3단)은 한 번에 ±1단계다.
// 상한이 아니라 **속도 제한**이다 — 여러 번 외치면 끝에서 끝까지 갈 수 있다.
// 범주 축(공격방향·공격 패턴·세트피스)에는 "폭"이라는 개념이 없어 제한하지 않는다.
//
// 왜 외침과 쿨다운을 공유하는가: 둘은 같은 행위다(터치라인에서 선수들의 주의를 끄는 일).
// 자원을 나눠 주면 "10분마다 외치고 + 10분마다 지시"로 개입 밀도가 두 배가 된다.
// 2026-08-01 확장으로 **감독 타임 진입까지 같은 시계를 쓴다**(freeInterventionState 참조) —
// 시계를 나누면 "외쳤는데 감독 타임은 되고, 그 안에서 지시는 막히는" 모순이 생긴다.

/** 터치라인에서 소리쳐 전달할 수 있는 **수치** 지시 축(폭 제한 대상). */
export const TOUCHLINE_AXES = ['lineHeight', 'pressing', 'tempo'] as const
export type TouchlineAxis = (typeof TOUCHLINE_AXES)[number]
/** 터치라인 지시 1회의 수치 축당 최대 변화폭. */
export const TOUCHLINE_STEP = 15
/** 터치라인 지시 1회의 **서열** 축당 최대 변화폭(멘탈리티 5단·그룹 적극성 3단). */
export const TOUCHLINE_RANK_STEP = 1
const TOUCHLINE_AXIS_TEXT = '라인·압박·템포·공격방향·멘탈리티·그룹 적극성·공격 패턴·세트피스'
/** 터치라인에서 잠기는 것 — 전부 "대형"이다(위 경계 논증 참조). */
const TOUCHLINE_LOCKED_TEXT = '포메이션(선발 대형·페이즈 대형·자리 배치)'

const MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비적', 'defensive': '수비적', 'balanced': '균형',
  'attacking': '공격적', 'very-attacking': '매우 공격적',
}
const PATTERN_KO: Record<AttackPattern, string> = {
  balanced: '균형', cross: '크로스', through: '중앙 침투', longshot: '중거리',
}
const GI_LINE_KO: Record<keyof GroupIntensity, string> = {
  attack: '공격', midfield: '미드필드', defense: '수비',
}
const GI_KO: Record<-1 | 0 | 1, string> = { [-1]: '자제', 0: '기본', 1: '적극' }
const SP_ROUTE_KO: Record<SetPieceRoute, string> = { near: '니어', far: '파', short: '짧게' }
const SP_LOAD_KO: Record<BoxLoad, string> = { light: '적게', normal: '표준', heavy: '많이' }
const SP_MARK_KO: Record<SetPieceMarking, string> = { zonal: '존', man: '맨투맨' }

const DEFAULT_GI: GroupIntensity = { attack: 0, midfield: 0, defense: 0 }
const GI_LINES: (keyof GroupIntensity)[] = ['attack', 'midfield', 'defense']

/** 터치라인 판정에 필요한 경기 맥락. 순수 함수를 유지하면서도 "언제 풀리는지"를
 *  문구에 넣기 위해 호출부가 넘긴다(UI와 store가 같은 값을 넘긴다). */
export interface TouchlineCtx {
  /** GK 파워플레이 엔진 조건 판정용 — 현재 분. */
  minute: number
  /** GK 파워플레이 엔진 조건 판정용 — 이 side가 지고 있는가. */
  losing: boolean
  /** 잠긴 축의 안내에 붙일 다음 전원 소집 시점. null이면 남은 브레이크 없음. */
  nextBreak: number | null
}

/** "다음 브레이크(67분)에서 바꿀 수 있습니다." — 잠금 문구의 꼬리를 한 곳에서 만든다.
 *  잠금 안내는 **무엇이·왜·언제 풀리는지** 셋을 다 말해야 한다(ShoutBar 선례). */
function breakTail(nextBreak: number | null): string {
  return nextBreak === null
    ? '남은 브레이크가 없어 이번 경기에서는 바꿀 수 없습니다.'
    : `다음 브레이크(${nextBreak}분)에서 바꿀 수 있습니다.`
}

/** 터치라인 지시로 성립하는 **지시 4축** 변경인가 — 폭만 본다.
 *  touchlineTacticsError의 부분집합이며, 지시만 다루는 호출부(테스트·ConsolePanel)가 쓴다.
 *  판정 규칙이 두 벌이 되지 않도록 본 함수가 이 함수를 그대로 호출한다. */
export function touchlineOrderError(before: Instructions, after: Instructions): string | null {
  for (const k of TOUCHLINE_AXES) {
    if (Math.abs(after[k] - before[k]) > TOUCHLINE_STEP) {
      return `한 번에 ${INSTRUCTION_LABEL[k]}을(를) ${TOUCHLINE_STEP}보다 크게 바꿀 수 없습니다 — 소리쳐 전달되는 것은 "더/덜"입니다.`
    }
  }
  // 공격방향은 범주 축이라 폭 개념이 없다. 방향 전환은 "왼쪽으로!" 한마디로 전달된다.
  return null
}

/** 터치라인 지시로 성립하는 전술 변경인가 — 축·폭만 본다(쿨다운·창은 store가 따로 본다).
 *  UI(ConsolePanel·TacticsExtras·작전판)와 store가 **같은 함수**를 쓴다. 규칙이 갈리면
 *  화면은 허용하는데 store가 throw하는 조합이 생긴다.
 *
 *  before는 **창(touchlineWindow)이 열린 순간의 스냅샷**이어야 한다 — 현재값을 기준으로
 *  삼으면 같은 분에 세 번 눌러 +45를 만드는 우회가 열린다. */
export function touchlineTacticsError(before: TacticState, after: TacticState, ctx: TouchlineCtx): string | null {
  // ① 대형 — 터치라인에서 소리쳐 전달되는 대역폭이 아니다(위 "포메이션의 경계" 논증).
  if (before.formation !== after.formation) {
    return `포메이션 변경은 선수를 모아 놓고 판을 보여 줘야 합니다 — ${breakTail(ctx.nextBreak)}`
  }
  if (JSON.stringify(before.lineup) !== JSON.stringify(after.lineup)) {
    return `자리 배치 변경은 대형을 다시 그리는 일입니다 — ${breakTail(ctx.nextBreak)} (교체는 지금도 가능합니다)`
  }
  if (JSON.stringify(before.phaseFormations ?? {}) !== JSON.stringify(after.phaseFormations ?? {})) {
    return `페이즈 포메이션도 대형입니다 — ${breakTail(ctx.nextBreak)}`
  }
  // ② 수치 축 폭 제한.
  const insErr = touchlineOrderError(before.instructions, after.instructions)
  if (insErr) return insErr
  // ③ 서열 축 — "더/덜" 한 단계씩. 매우 수비적에서 매우 공격적으로 한 번에 가는 것은
  //    소리쳐 전달되는 지시가 아니라 팀을 다시 짜는 일이다.
  const bm = MENTALITIES.indexOf(before.mentality ?? 'balanced')
  const am = MENTALITIES.indexOf(after.mentality ?? 'balanced')
  if (Math.abs(am - bm) > TOUCHLINE_RANK_STEP) {
    return `멘탈리티는 한 번에 한 단계씩만 바꿀 수 있습니다 — 지금은 ${MENTALITY_KO[MENTALITIES[bm]]}에서 한 칸 옆까지입니다.`
  }
  const bgi = { ...DEFAULT_GI, ...(before.groupIntensity ?? {}) }
  const agi = { ...DEFAULT_GI, ...(after.groupIntensity ?? {}) }
  for (const line of GI_LINES) {
    if (Math.abs(agi[line] - bgi[line]) > TOUCHLINE_RANK_STEP) {
      return `${GI_LINE_KO[line]} 적극성은 한 번에 한 단계씩만 바꿀 수 있습니다 — 자제에서 적극으로 한 번에 갈 수는 없습니다.`
    }
  }
  // ④ GK 파워플레이 — 등급 잠금은 풀렸지만 **엔진 조건은 그대로**다(simulate.gkPowerplayActive).
  //    UI만 풀면 "눌렀는데 아무 일도 안 난다"가 되므로 여기서 같은 조건으로 막고 사유를 말한다.
  //    끄는 것은 언제나 허용한다 — 위험한 상태를 되돌리는 길까지 막을 이유가 없다.
  if (!before.gkPowerplay && after.gkPowerplay) {
    if (ctx.minute < 85) return "GK 파워플레이는 85' 이후에만 효과가 있습니다 — 지금 켜도 아무 일도 일어나지 않습니다."
    if (!ctx.losing) return 'GK 파워플레이는 지고 있을 때만 효과가 있습니다 — 지금 켜도 아무 일도 일어나지 않습니다.'
  }
  // ⑤ 범주 축(공격 패턴·세트피스 3축)은 폭 개념이 없어 그대로 통과한다.
  return null
}

/** 바뀐 전술 축을 사람이 읽는 한 줄로 나열한다 — 터치라인 결정 로그의 본문.
 *  기자회견이 "언제 어떻게 개입했나"를 추궁하려면 지시 4축뿐 아니라 태세·적극성·패턴까지
 *  같은 문장에 들어와야 한다(기존 instructionDiff는 4축만 봤다). */
export function tacticsDiff(before: TacticState, after: TacticState): string[] {
  const out = instructionDiff(before.instructions, after.instructions)
  if (before.formation !== after.formation) out.push(`포메이션 ${before.formation}→${after.formation}`)
  const bm = before.mentality ?? 'balanced', am = after.mentality ?? 'balanced'
  if (bm !== am) out.push(`멘탈리티 ${MENTALITY_KO[bm]}→${MENTALITY_KO[am]}`)
  const bgi = { ...DEFAULT_GI, ...(before.groupIntensity ?? {}) }
  const agi = { ...DEFAULT_GI, ...(after.groupIntensity ?? {}) }
  for (const line of GI_LINES) {
    if (bgi[line] !== agi[line]) out.push(`${GI_LINE_KO[line]} 적극성 ${GI_KO[bgi[line]]}→${GI_KO[agi[line]]}`)
  }
  const bp = before.attackPattern ?? 'balanced', ap = after.attackPattern ?? 'balanced'
  if (bp !== ap) out.push(`공격 패턴 ${PATTERN_KO[bp]}→${PATTERN_KO[ap]}`)
  if (!!before.gkPowerplay !== !!after.gkPowerplay) out.push(`GK 파워플레이 ${after.gkPowerplay ? 'ON' : 'OFF'}`)
  const bsp = before.setPiece ?? {}, asp = after.setPiece ?? {}
  if ((bsp.route ?? 'far') !== (asp.route ?? 'far')) out.push(`코너 루트 ${SP_ROUTE_KO[bsp.route ?? 'far']}→${SP_ROUTE_KO[asp.route ?? 'far']}`)
  if ((bsp.boxLoad ?? 'normal') !== (asp.boxLoad ?? 'normal')) out.push(`박스 인원 ${SP_LOAD_KO[bsp.boxLoad ?? 'normal']}→${SP_LOAD_KO[asp.boxLoad ?? 'normal']}`)
  if ((bsp.marking ?? 'zonal') !== (asp.marking ?? 'zonal')) out.push(`수비 마킹 ${SP_MARK_KO[bsp.marking ?? 'zonal']}→${SP_MARK_KO[asp.marking ?? 'zonal']}`)
  return out
}

// ── 자유 개입(감독 타임) = 희소 자원 (2026-08-01) ──────────────────────
// 왜 제한하는가: 랜딩이 *"90분과 다섯 번의 개입이 주어진다"*고 약속하는데 코드에는 그 실체가
// 없었다(pauseByUser 무제한). 문구가 가리키는 것을 실제로 만든다 — 개입이 자원이어야
// "언제 쓸 것인가"가 감독의 결정이 된다.
//
// 무엇을 세는가: **감독이 고른 정지만** 센다. 자유 정지(pauseByUser)와 순간 제안 수락
// (acceptMoment — 배너가 문자 그대로 "감독 타임을 쓰시겠습니까?"라고 묻는다)이 그것이다.
// 순간 제안을 세지 않으면 [흘려보낸다]가 아무 대가 없는 선택이 되어 버튼이 장식이 된다.
// 반대로 하이드레이션·하프타임은 **규칙이 주는 것**이라 세지 않는다 — "하프타임 들어갔다고
// 내 개입이 깎였다"는 감각은 설계 의도가 아니다.
//
// 쿨다운 시계: **터치라인 지시와 공유하고, 외침과는 공유하지 않는다**(2026-08-01 재판정).
// lastInterventionMinute 하나가 감독 타임 진입과 터치라인 지시 창을 함께 잰다 — 둘은 실제로
// 같은 행위다(경기를 세우고 팀 상태를 바꾼다). 외침은 다른 시계를 쓴다. 근거는 SHOUT_COOLDOWN
// 위의 논증이고, 사용자 지시(2026-08-01)가 이 판정의 정본이다.

/** 자유 개입(감독 타임) 총량. 랜딩 "90분과 다섯 번의 개입"의 실체다. */
export const MAX_FREE_INTERVENTIONS = 5

/** 지금 감독 타임을 쓸 수 있는가 — 잔량·쿨다운·사유를 한 번에 답한다.
 *  순수 함수라 UI와 store가 같은 판정을 쓴다(규칙이 갈리면 "눌리는데 거부되는" 조합이 생긴다).
 *  두 사유는 반드시 구별된다 — 횟수 소진과 쿨다운은 풀리는 방식이 다르다(쿨다운은 기다리면
 *  풀리고, 소진은 영영 풀리지 않는다). 둘 다 막혔으면 더 오래 막는 쪽(소진)을 말한다. */
export function freeInterventionState(
  used: number,
  lastInterventionMinute: number | null,
  minute: number,
): { left: number; cooldownLeft: number; canPause: boolean; blockedReason: string | null } {
  const left = Math.max(0, MAX_FREE_INTERVENTIONS - used)
  const cooldownLeft = lastInterventionMinute === null
    ? 0
    : Math.max(0, INTERVENTION_COOLDOWN - (minute - lastInterventionMinute))
  if (left === 0) {
    return {
      left, cooldownLeft, canPause: false,
      blockedReason: `자유 개입 ${MAX_FREE_INTERVENTIONS}회를 모두 썼습니다 — 남은 개입은 정해진 브레이크(하이드레이션·하프타임)뿐입니다.`,
    }
  }
  if (cooldownLeft > 0) {
    return {
      left, cooldownLeft, canPause: false,
      blockedReason: `개입 쿨다운 — ${cooldownLeft}분 뒤에 감독 타임을 쓸 수 있습니다(터치라인 지시와 같은 시계 · 외침은 별개입니다).`,
    }
  }
  return { left, cooldownLeft: 0, canPause: true, blockedReason: null }
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
 * 왜 5분이었나: 유저가 반응할 시간이 먼저다. 재생 dwell(playback.ts)은 1x에서
 * 무사건 분 1.1 s · 사건 분 최대 9.6 s이고, 제안이 뜨는 분은 거의 항상 사건 분이다
 * (실점·득점은 골 dwell 8.6 s). 5분이면 1x에서 최소 13 s, 2x에서도 6~7 s가 남아
 * [사용]/[흘려보낸다]를 누를 여유가 있다. 반대로 10분을 주면 다음 제안이 뜰 때까지
 * 낡은 문장이 살아 있고(momentPrompt는 하나뿐이라 새 제안을 막는다), 하이드레이션
 * 브레이크 간격(약 22분)의 절반을 한 배너가 차지한다.
 *
 * 왜 5 → 6인가(2026-08-01): 위 논증은 "배너가 뜨는 순간 = 그 분이 시작되는 순간"을
 * 전제했다. 그런데 MatchScreen이 배너에 `revealed` 노출 게이트를 걸었다 — 실점 장면이
 * 화면에 드러나기 **전에** "실점 직후입니다" 배너가 먼저 뜨던 결함을 고치기 위해서다.
 * 노출이 뒤로 밀리면 유저가 반응할 창도 같이 밀린다. 지연의 상한은 그 분의 dwell 하나
 * (골 안무 8.6 s 중 reveal이 6~7 s 지점 → 최대 약 7 s)이고, 이는 무사건 분 여섯 개
 * (1.1 s × 6)보다 크므로 **경기 분 1분을 통째로 되돌려 준다.** 6분이어도 위 상한
 * 논증(10분은 과하다)은 그대로 성립한다 — 브레이크 간격의 절반에는 여전히 못 미친다.
 *
 * 스코어 변화에 의한 소거는 이 기간과 별개로 즉시 적용된다 — 만료보다 강한 신호다.
 */
export const MOMENT_PROMPT_TTL = 6

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
  /** 마지막 **외침** 분(외침 쿨다운 전용 시계). null이면 아직 없음.
   *  개입 시계(lastInterventionMinute)와 **분리돼 있다** — SHOUT_COOLDOWN 주석의 논증. */
  lastShoutMinute: number | null
  /** 마지막 **자유 개입** 분(감독 타임 진입·터치라인 지시 창). 개입 쿨다운 전용 시계. */
  lastInterventionMinute: number | null
  /** 쓴 자유 개입 횟수(감독 타임 + 순간 제안 수락). MAX_FREE_INTERVENTIONS가 상한. */
  freeInterventionsUsed: number
  /** 열려 있는 터치라인 지시 창. 같은 분의 여러 지시를 **한 번의 개입**으로 묶는다.
   *  IFAB 교체 기회가 "같은 분의 복수 교체는 한 기회"로 묶는 것과 같은 문법이다.
   *  tactics는 **창이 열린 순간의 스냅샷**이라 폭 제한(±15·±1단계)의 기준점이 된다 —
   *  현재값을 기준으로 삼으면 같은 창에서 세 번 눌러 제한을 우회할 수 있다. */
  touchlineWindow: { minute: number; side: 'home' | 'away'; tactics: TacticState } | null
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
  /** 터치라인 외침 — playing 중 즉시(정지 없음). **자유 개입 5회를 쓰지 않는다.**
   *  SHOUT_COOLDOWN(5분) 시계만 지키면 몇 번이든 외친다. 결정론 사기/체력 보정 + 시드 파생
   *  RNG로 고른 대상 2~3명의 추가 보정 + 로그. 홈(감독) 전용.
   *  쿨다운 중이거나 재생 중이 아니면 throw. 화면이 잠깐 띄울 결과를 돌려준다. */
  shout(type: ShoutType): ShoutResult
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
  lastInterventionMinute: null as number | null,
  freeInterventionsUsed: 0,
  touchlineWindow: null as { minute: number; side: 'home' | 'away'; tactics: TacticState } | null,
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
    const { engine, phase, freeInterventionsUsed, lastInterventionMinute } = get()
    if (!engine) throw new Error('경기 미시작')
    if (phase !== 'playing') return
    // store가 최종 방어선이다 — UI가 버튼을 죽이는 것만으로는 부족하다.
    // 막혔을 때 throw하지 않고 조용히 거절하는 이유: 이 액션은 화면 버튼의 onClick에
    // 그대로 물려 있어 throw가 곧 렌더 경로의 예외가 된다. 사유는 화면이
    // freeInterventionState(같은 판정)로 미리 읽어 표시한다.
    if (!freeInterventionState(freeInterventionsUsed, lastInterventionMinute, engine.minute).canPause) return
    // 감독 타임 진입 자체가 창을 연다 — 한 번 불러 세운 동안 내리는 지시는 한 번의 개입이다.
    // 그래서 이 안에서의 터치라인 지시는 추가 비용이 없다(touchlineWindow 주석).
    set({
      phase: 'paused-user', pauseReason: { kind: 'user' },
      freeInterventionsUsed: freeInterventionsUsed + 1,
      lastInterventionMinute: engine.minute,
      touchlineWindow: { minute: engine.minute, side: 'home', tactics: structuredClone(engine.home.tactics) },
    })
  },
  confirmTactics: () => {
    const { engine, phase, pauseReason } = get()
    if (!engine) throw new Error('경기 미시작')
    if (!INTERVENTION_PHASES.includes(phase)) throw new Error('개입 중이 아님')
    // 킥오프 전 계획에는 인게임 부스트를 주지 않는다(사전 계획과 실시간 개입의 가치를 구분).
    // 재생 시작도 하지 않는다 — 'pre'의 진행은 kickoff()가 담당한다.
    if (phase === 'pre') return
    // 개입 직후 부스트: 지금부터 BOOST_MINUTES분간 찬스 퀄 +8%·실점 위험 −6%(advanceMinute이 엔진 전달).
    //
    // ★ 2026-08-01 재판정 — **자유 개입에는 부스트를 주지 않는다. 실측이 그렇게 시켰다.**
    //
    // 예전 규칙(감독 타임 제외)의 근거는 *"pauseByUser에 횟수 제한이 없어 8분마다
    // 정지·확정만 반복하면 부스트가 상시 유지된다"*였고, 그 전제는 이번에 사라졌다
    // (자유 개입 5회 + 10분 쿨다운 — MAX_FREE_INTERVENTIONS·freeInterventionState).
    // 그래서 "이제는 줘도 된다"가 잠정 판단이었고, 판정을 측정에 맡겼다.
    //
    // 측정(tools/touchline-balance/run.mjs · kor 홈 · n=400 페어드 · 시드 20260801~):
    // 전술을 **하나도 바꾸지 않고 5회를 소진만** 하는 전략(spend-only)이
    //   rsa +2.0pp(SE 0.7) · mex +2.3pp(0.7) · esp +1.3pp(0.6) · fra +1.5pp(0.6) · arg +2.0pp(0.7)
    // 로 **상대 5팀 전부에서 유의하게 양수**였다. 즉 "판단 없이 정지 버튼만 다섯 번
    // 누른다"가 공짜 승률이 된다 — 정의상 지배 전략이고, 이 게임이 팔려는 것(무엇을
    // 언제 바꿀 것인가)과 정반대다. 사전에 정한 결정 규칙대로 부스트를 거둔다.
    //
    // 남는 규칙: 부스트는 **자원을 소모하지 않는 개입**(하이드레이션·하프타임)에만 붙는다.
    // 자유 개입(감독 타임·순간 제안 수락)이 주는 것은 부스트가 아니라 **권한**이다 —
    // 경기 중에 지시를 바꿀 수 있다는 것 자체가 그 5회의 값이다. 순간 제안도 이제 5회에서
    // 세므로 같은 규칙을 적용한다(예전엔 무료라 부스트를 줬다).
    const scheduled = pauseReason?.kind !== 'user' && pauseReason?.kind !== 'moment'
    set({
      phase: 'playing', pauseReason: null, momentPrompt: null, momentPromptScore: null,
      ...(scheduled ? { boostUntil: engine.minute + BOOST_MINUTES } : {}),
    })
  },
  acceptMoment: () => {
    const { engine, phase, momentPrompt, freeInterventionsUsed, lastInterventionMinute } = get()
    if (phase !== 'playing') throw new Error('재생 중이 아님')
    if (!momentPrompt) throw new Error('제안된 순간이 없음')
    // 순간 제안 수락도 자유 개입이다 — 배너가 문자 그대로 "감독 타임을 쓰시겠습니까?"라고
    // 묻는다. 세지 않으면 [흘려보낸다]가 대가 없는 선택이 되어 버튼이 장식이 된다.
    if (engine && !freeInterventionState(freeInterventionsUsed, lastInterventionMinute, engine.minute).canPause) return
    const minute = engine?.minute ?? 0
    set({
      phase: 'paused-moment', pauseReason: { kind: 'moment', moment: momentPrompt },
      freeInterventionsUsed: freeInterventionsUsed + 1,
      lastInterventionMinute: minute,
      ...(engine ? { touchlineWindow: { minute, side: 'home' as const, tactics: structuredClone(engine.home.tactics) } } : {}),
    })
  },
  dismissMoment: () => set({ momentPrompt: null, momentPromptScore: null }),
  submitCommand: (side, cmd) => {
    const { engine, phase, pauseReason, schedule, decisionLog, matchPlan, planDeviation, touchlineWindow } = get()
    if (!engine) throw new Error('경기 미시작')
    if (!INTERVENTION_PHASES.includes(phase)) throw new Error('개입 불가 시점')
    // 스토어가 최종 방어선이다 — UI가 섹션을 접는 것만으로는 부족하다.
    // 터치라인 등급에서 통과하는 것: 교체, 그리고 대형을 건드리지 않는 전술 지시 전부
    // (TOUCHLINE_AXES 주석의 "포메이션의 경계" 논증 참조). 대형은 여기서 막는다.
    const touchline = interventionLevel(phase, pauseReason) === 'touchline'
    // 같은 분에 열려 있는 창인가 — 있으면 폭 제한의 기준점이자 "추가 비용 없음"의 근거다.
    const openWindow = touchlineWindow && touchlineWindow.minute === engine.minute && touchlineWindow.side === side
      ? touchlineWindow
      : null
    /** 터치라인 지시가 실제로 바꾼 축(로그 본문). 빈 배열이면 무료 no-op이다. */
    let touchlineChanged: string[] = []
    if (touchline && cmd.type !== 'sub') {
      if (cmd.type !== 'instructions' && cmd.type !== 'formation') {
        throw new Error(touchlineNotice(engine.minute, schedule))
      }
      const cur = engine[side].tactics
      const after: TacticState = cmd.type === 'instructions'
        ? { ...cur, instructions: cmd.instructions }
        : cmd.tactics
      // 폭 제한은 **창 스냅샷 기준**이다 — 현재값 기준이면 같은 창에서 세 번 눌러 +45를 만든다.
      const base = openWindow ? openWindow.tactics : cur
      const [own, opp] = side === 'home'
        ? [engine.score[0], engine.score[1]]
        : [engine.score[1], engine.score[0]]
      const err = touchlineTacticsError(base, after, {
        minute: engine.minute, losing: own < opp, nextBreak: nextBreakMinute(engine.minute, schedule),
      })
      if (err) throw new Error(err)
      touchlineChanged = tacticsDiff(cur, after)
      // 자원 소모는 **창을 새로 여는 경우에만**. 같은 창 안의 추가 지시는 한 번의 개입이다.
      // 아무것도 바뀌지 않는 재전송도 무료다(슬라이더가 같은 값을 되돌려 놓는 경우).
      if (touchlineChanged.length > 0 && !openWindow) {
        const last = get().lastInterventionMinute
        if (last !== null && engine.minute - last < INTERVENTION_COOLDOWN) {
          throw new Error(`터치라인 지시 쿨다운 — ${INTERVENTION_COOLDOWN - (engine.minute - last)}분 뒤에 다시 지시할 수 있습니다(외침은 지금도 가능합니다).`)
        }
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
    if (touchline && cmd.type !== 'sub') {
      // 터치라인에서 내린 지시는 명령 종류와 무관하게 **한 줄로** 남긴다 — 기자회견이
      // "언제 어떻게 개입했나"를 추궁하는 근거다. 킥오프 전 슬라이더 드래그가 남기던
      // 노이즈는 여기 들어오지 않는다('pre'는 full 등급이라 이 분기를 타지 않는다).
      if (touchlineChanged.length > 0) {
        entry = {
          minute, kind: 'instructions',
          summary: `${when} 터치라인 지시: ${touchlineChanged.join(', ')}`,
          detail: { changed: touchlineChanged, touchline: true },
        }
      }
    } else if (cmd.type === 'instructions') {
      const changed = instructionDiff(sideState.tactics.instructions, cmd.instructions)
      // 변경 축이 0개면 로그 스킵(엔진 적용은 그대로) — "45' 지시 변경: " 같은 빈 요약 방지.
      if (changed.length > 0) {
        entry = { minute, kind: 'instructions', summary: `${when} 지시 변경: ${changed.join(', ')}`, detail: { changed } }
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
    // 터치라인 지시가 실제로 무언가를 바꿨고, 그것이 **새 창**일 때만 자원을 소모한다.
    // 같은 창 안의 추가 지시와 같은 값 재전송은 무료다(창 설계 — touchlineWindow 주석).
    const opensWindow = touchline && cmd.type !== 'sub' && touchlineChanged.length > 0 && !openWindow
    set({
      engine: nextEngine,
      planDeviation: dev,
      ...(structChanged ? { adaptUntil: engine.minute + ADAPT_MINUTES } : {}),
      ...(opensWindow
        ? {
            lastInterventionMinute: engine.minute,
            touchlineWindow: { minute: engine.minute, side, tactics: structuredClone(engine[side].tactics) },
          }
        : {}),
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
    // 자유 개입 잔량은 보지 않는다 — 외침은 개입이 아니다(SHOUT_COOLDOWN 주석의 논증).
    if (!shoutState(lastShoutMinute, minute).canShout) throw new Error('외침 쿨다운 중')
    const situation = scoreSituation(engine.score, 'home')
    const { morale, stamina } = SHOUT_TABLE[situation][type]
    // ★ 단순화: 엔진 전달 없이 홈 사기/체력을 직접 보정(applyTeamTalk 방식). 정지 없음.
    const next = structuredClone(engine)
    const m = next.home.moraleByPlayer
    const beforeMorale = { ...m }
    for (const id of Object.keys(m)) m[id] = Math.max(0, Math.min(100, m[id] + morale))
    if (stamina !== 0) {
      const s = next.home.staminaByPlayer
      for (const id of Object.keys(s)) s[id] = Math.max(0, Math.min(100, s[id] + stamina))
    }
    // 시드 파생 RNG — Math.random 금지 계약을 지키면서 매번 다른 사람이 뽑히게 하는 장치.
    // 소수를 곱해 시드·분·종류가 서로의 스트림을 침범하지 않게 한다.
    const rng = createRng(engine.seed * 10007 + minute * 131 + SHOUT_SEED[type])
    // 대상 선정은 **보정 전 상태**를 본다(engine). 보정 후를 보면 일괄분이 이미 섞여 들어가
    // "가라앉은 선수"의 정의가 외침 종류에 따라 흔들린다.
    const picks = shoutTargets(engine, type, rng)
    // 추가분의 부호는 팀 delta를 따른다 — 역효과라면 특히 세게 반응한 쪽이 더 상한다.
    const sign = morale >= 0 ? 1 : -1
    const targets: ShoutTarget[] = picks.map(id => {
      m[id] = Math.max(0, Math.min(100, m[id] + sign * rng.int(2, 5)))
      return {
        playerId: id,
        name: next.home.team.squad.find(p => p.id === id)?.name.ko ?? id,
        // 화면에는 **실제로 움직인 양**을 적는다. 사기 99인 선수에게 +8을 표시하면 거짓말이다.
        morale: m[id] - (beforeMorale[id] ?? m[id]),
      }
    })
    const entry: DecisionEntry = {
      minute, kind: 'teamtalk',
      summary: `${minute}' 외침: ${SHOUT_LABEL[type]}`,
      detail: { shout: type, situation, morale, stamina, targets: targets.map(t => t.playerId) },
    }
    set({ engine: next, lastShoutMinute: minute, decisionLog: [...decisionLog, entry] })
    return {
      type, situation, teamMorale: morale, teamStamina: stamina, targets,
      backfire: morale < 0, affinity: SHOUT_AFFINITY[type],
    }
  },
  logShootoutSetup: (summary) => {
    const { engine, decisionLog } = get()
    const entry: DecisionEntry = { minute: engine?.minute ?? 90, kind: 'shootout-setup', summary }
    set({ decisionLog: [...decisionLog, entry] })
  },
  reset: () => set({ ...initial }),
}))
