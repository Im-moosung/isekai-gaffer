// src/game/commentary.ts
// 이벤트 → 한국어 중계 라인. 결정론 템플릿 (Math.random 금지, FNV-1a 해시로 변형 선택).
// 순수 함수 — React/스토어 import 금지. 모든 문장은 사실 서술형 (스펙 §7.1 세이프가드).
//
// ★ Phase C 설계 근거 (docs/audit/commentary-style-research.md)
//  1) text / speech 분리 — 화면은 `고오오올`·`…`·`!!!`을 쓰고 싶지만 ko-KR TTS는
//     `고오오올`을 "고.오.오.올" 4음절 말더듬으로, `…`를 엔진마다 다르게 읽는다(§5.2).
//     그래서 라인은 항상 두 문자열을 함께 낸다. SSML은 쓰지 않는다(§5.1 확정 배제).
//  2) 분 접두 제거 — 예전엔 26/26 템플릿이 `27' `로 시작했다. 실제 캐스터는 분을
//     10줄에 한 번, 골·카드·전후반 경계에서만 말한다. 분은 UI 타임스탬프(Ticker)로 옮기고
//     문장 안 삽입은 골·카드·경계 + 그 외 소수 확률로만 한다(§4.1 #1).
//  3) 변형 선택자 — 예전 `(minute*31 + type.length) % n`은 type.length가 타입 상수라
//     실질 `minute % n`이었다. 2변형이면 짝/홀 분 엄격 교대 = 랜덤보다 나쁜 지각 주기(§4.1 #4).
//     실제 믹서(FNV-1a) + 최근 사용 변형 억제 링버퍼로 교체했다.
//  4) 맥락 인지 — 골 종류 판정(선제/동점/역전/쐐기/추격), streak 4단어(또·이번에도·벌써·연속),
//     조사 자동 선택. 히스토리가 필요하므로 이벤트 배열을 접으며(fold) 상태를 만든다(§4.1 #5,#11).
//  5) 결정론 — 같은 (시드, 이벤트 배열, 인덱스)면 항상 같은 라인. 링버퍼도 fold 상태라 결정론이다.
//
// 세이프가드: 리서치가 수집한 실제 중계 어록 중 특정 선수·팀 조롱 비유는 의도적으로 전부 배제했다.
// 1인칭 편파 표현(`우리`, `대~한민국`)도 쓰지 않는다 — 상대 폄하로 읽힐 여지를 원천 차단한다.
//
// ★ Phase C 4~5단계
//  6) 해설위원(analyst) — 캐스터는 **무슨 일이 일어났는지**, 해설위원은 **왜 그런지**를
//     말한다(§1.1). 이벤트의 30~40%에만 붙인다 — 매번 붙으면 수다스럽다(§1.3 적용 규칙).
//     캐스터 라인의 `follow` 슬롯에 담아 1:1 배열 계약(commentateAll)을 깨지 않는다.
//  7) 소강 구간 라인 — 이벤트 없는 분이 이어지면 침묵이 흐른다. 흐름(flow) 상태를
//     판정해 코멘트를 넣되, 조용한 구간도 중계의 일부이므로 빈도를 엄격히 제한한다(§3.4).
//  8) 전술 반영 해설 — 감독의 지시(decisionLog)를 해설이 알아본다(§3.5). ★ 인과를
//     단정하지 않는다. 엔진은 "그 지시 때문에" 그렇게 됐는지 모른다. 전부 시간 서술
//     ("압박을 올린 뒤로 ~")로만 쓴다 — 사실 서술은 틀릴 수 없다.
import type { DecisionEntry, MatchEvent, MatchEventType, Position, Team } from '../engine/types'
import { dramaRank } from './drama'

// ── 조사 자동 선택 (§5.5) ────────────────────────────────────
// 왜 필요한가: 선수 이름이 데이터 주도라 `${player}가`는 `손흥민가`를 만든다.
// 화면에서 틀릴 뿐 아니라 TTS가 그 틀린 조사를 소리로 읽는다.

/** 한글 음절의 받침(종성) 유무. 한글이 아니면 받침 없음으로 취급한다. */
export function hasBatchim(s: string): boolean {
  const c = s.charCodeAt(s.length - 1)
  if (Number.isNaN(c) || c < 0xac00 || c > 0xd7a3) return false
  return (c - 0xac00) % 28 !== 0
}

/** 종성 인덱스(0=받침 없음, 8=ㄹ). 으로/로 판정에 쓴다. */
function jongseong(s: string): number {
  const c = s.charCodeAt(s.length - 1)
  if (Number.isNaN(c) || c < 0xac00 || c > 0xd7a3) return 0
  return (c - 0xac00) % 28
}

/** 이/가 */
export const josaIGa = (s: string): string => s + (hasBatchim(s) ? '이' : '가')
/** 은/는 */
export const josaEunNeun = (s: string): string => s + (hasBatchim(s) ? '은' : '는')
/** 을/를 */
export const josaEulReul = (s: string): string => s + (hasBatchim(s) ? '을' : '를')
/** 과/와 */
export const josaGwaWa = (s: string): string => s + (hasBatchim(s) ? '과' : '와')
/** 으로/로 — ㄹ 받침(종성 8)은 '로'를 쓴다. */
export const josaEuRo = (s: string): string => {
  const j = jongseong(s)
  return s + (j === 0 || j === 8 ? '로' : '으로')
}

// ── 숫자 한글화 (§5.3) ───────────────────────────────────────
// 한국어 TTS의 최대 함정. `2-1`은 "이 마이너스 일", `1:0`은 엔진마다 제각각으로 읽힌다.
// `3번째`는 "삼번째"(오독 — 번째는 고유어 수사). speech 문자열에는 숫자를 남기지 않는다.
// 예외: `분`은 한자어 수사로 정상 발음되므로(`전반 12분` → "전반 십이분") 숫자 그대로 둔다.

const SINO_KO = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십'] as const

/** 스코어 한글 발음 — `2:1` → `이 대 일`. 0은 반드시 '영'(엔진에 따라 '제로'로 읽힌다). */
export function scoreKo(a: number, b: number): string {
  const one = (n: number): string => SINO_KO[n] ?? String(n)
  return `${one(a)} 대 ${one(b)}`
}

const ORD_KO = ['', '첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'] as const

/** 고유어 서수 관형사 — `${ordKo(3)} 번째` → "세 번째". 범위 밖이면 '여러'. */
export function ordKo(n: number): string {
  return ORD_KO[n] ?? '여러'
}

/** 고유어 기수 관형사 — 사람을 셀 때는 `4명`이 "사명"이 아니라 "네 명"이다. */
const CARD_KO = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한'] as const

/** `${countKo(4)} 명` → "네 명". 범위 밖이면 한자어 수사로 폴백한다. */
export function countKo(n: number): string {
  return CARD_KO[n] ?? String(n)
}

/**
 * 포메이션 id를 발음 가능한 문자열로 — `4-2-3-1` → `사 이 삼 일`.
 * 하이픈을 그대로 두면 ko-KR 보이스가 "사 마이너스 이"로 읽거나 통째로 삼킨다.
 * 실제 캐스터도 "사-이-삼-일"로 자릿수를 하나씩 끊어 읽는다.
 */
export function formationSpeechKo(formation: string): string {
  return formation
    .split('-')
    .map(d => SINO_KO[Number(d)] ?? d)
    .join(' ')
}

// ── 해시 (§4.1 #4) ──────────────────────────────────────────

/** FNV-1a 32bit. 인접 입력이 흩어지는 실제 믹서 — `minute % n`류의 지각 가능한 주기를 없앤다. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

// ── 라인 타입 ────────────────────────────────────────────────

/** 화자. 캐스터(사실)와 해설위원(해석). 둘은 TTS pitch로도 갈린다(§5.7). */
export type Speaker = 'caster' | 'analyst'

/** 라인 강도 0~3. 3이 피크(골·퇴장). 발화 우선순위·pitch 분기에 쓴다(§5.8). */
export type Intensity = 0 | 1 | 2 | 3

export interface Line {
  /** 변형 식별자(`goal.opener.1` 등). 최근 사용 억제 링버퍼의 키. */
  id: string
  speaker: Speaker
  /** 이벤트 분. UI 타임스탬프가 이 값을 쓴다(문장 안에는 원칙적으로 없다). */
  minute: number
  /** 화면 표시용 — `고오오올`, `…`, `!!!` 허용. */
  text: string
  /** TTS 전용 — §5 규칙(숫자 한글화·라틴 문자 금지·`!` 1개)을 통과한 문자열. */
  speech: string
  intensity: Intensity
  /** 문장 안에 분이 들어갔는가(회귀 테스트가 비율을 잰다). */
  hasMinutePrefix: boolean
  /**
   * 이 캐스터 라인을 **받아서** 이어지는 해설위원 라인(§1.1 "해설은 절대 먼저 말하지 않는다").
   * ★ 왜 배열이 아니라 중첩인가: `commentateAll`은 이벤트와 1:1이라는 계약(접두 안정성·
   *   `commentateAt` 일치·playback의 eventIndex)을 갖는다. 해설을 같은 배열에 끼워 넣으면
   *   그 계약이 전부 깨진다. 화면·발화가 필요할 때는 `flattenLines()`로 펼친다.
   */
  follow?: Line
}

/** 중계 컨텍스트. 이벤트만으로는 알 수 없는 재료(감독의 지시 기록)를 넣는다.
 *  ★ 전부 선택적이다 — 넘기지 않으면 4단계 이전과 동일한 결과가 나온다(회귀 안전). */
export interface CommentaryCtx {
  /** `matchStore.decisionLog` — 감독 개입 기록. **읽기 전용으로만 쓴다.** */
  decisions?: readonly DecisionEntry[]
  /** 해설이 인정할 화자(감독)의 팀 id. 기본값은 홈. */
  managedTeamId?: string
}

/** `Line`과 그 `follow`를 한 줄씩 펼친다(티커·발화·테스트 공용). */
export function flattenLines(lines: readonly Line[]): Line[] {
  const out: Line[] = []
  for (const l of lines) {
    out.push(l)
    if (l.follow) out.push(l.follow)
  }
  return out
}

// ── 골 종류 (§3.1) ───────────────────────────────────────────

/** 골 종류. 득점팀 관점, 골 **직전** 스코어로 판정한다. */
export type GoalKind =
  | 'opener'      // 선제골
  | 'equalizer'   // 동점골
  | 'comeback'    // 역전골
  | 'restore'     // 다시 앞서 나가는 골(뒤진 적 없음)
  | 'clincher'    // 쐐기골
  | 'extra'       // 추가골
  | 'chase'       // 추격골
  | 'consolation' // 만회골

/**
 * 골 종류를 판정한다.
 * @param diff 골 **직전** (득점팀 점수 - 상대 점수)
 * @param total 골 직전 두 팀 합계
 * @param wasBehind 이 경기에서 득점팀이 한 번이라도 뒤진 적 있는가
 */
export function classifyGoal(diff: number, total: number, wasBehind: boolean, minute: number): GoalKind {
  if (total === 0) return 'opener'
  if (diff === -1) return 'equalizer'
  if (diff === 0) return wasBehind ? 'comeback' : 'restore'
  if (diff <= -2) return minute >= 80 && diff <= -3 ? 'consolation' : 'chase'
  // 쐐기골 = "사실상 승부가 갈렸다". 리서치의 `diff>=2`를 그대로 쓰면 전반 12분 2-0에도
  // "승부는 결정됐습니다"가 나와 우스워진다 — 점수차가 클수록 이른 시간도 허용하도록 완화했다.
  if (diff >= 3) return 'clincher'
  if (diff === 2 && minute >= 35) return 'clincher'
  if (minute >= 75) return 'clincher'
  return 'extra'
}

// ── streak (§3.3) ───────────────────────────────────────────

/** 연속 사건. `또`·`이번에도`·`벌써`·`연속` 네 단어를 쓸 근거가 되는 상태. */
export type StreakKind = 'playerShots' | 'saves' | 'corners' | 'fouls' | 'conceded'
interface Streak { kind: StreakKind; n: number }

/** 이 이벤트가 streak인지 판정한다. n은 이번 것을 포함한 횟수. */
function detectStreak(e: MatchEvent, prior: MatchEvent[]): Streak | null {
  const within = (min: number, pred: (x: MatchEvent) => boolean): number =>
    prior.filter(x => e.minute - x.minute <= min && pred(x)).length
  switch (e.type) {
    case 'shot': {
      if (!e.playerId) return null
      const n = within(15, x => x.type === 'shot' && x.playerId === e.playerId) + 1
      return n >= 2 ? { kind: 'playerShots', n } : null
    }
    case 'save': {
      if (!e.playerId) return null
      const n = within(20, x => x.type === 'save' && x.playerId === e.playerId) + 1
      return n >= 2 ? { kind: 'saves', n } : null
    }
    case 'corner': {
      const n = within(4, x => x.type === 'corner' && x.teamId === e.teamId) + 1
      return n >= 2 ? { kind: 'corners', n } : null
    }
    case 'foul': {
      if (!e.playerId) return null
      const n = within(90, x => x.type === 'foul' && x.playerId === e.playerId) + 1
      return n >= 3 ? { kind: 'fouls', n } : null
    }
    case 'goal': {
      // 실점 쪽 관점 — 같은 팀이 10분 이내에 연달아 실점했는가.
      const n = within(10, x => x.type === 'goal' && x.teamId === e.teamId) + 1
      return n >= 2 ? { kind: 'conceded', n } : null
    }
    default:
      return null
  }
}

// ── 템플릿 ───────────────────────────────────────────────────

interface Vars {
  m: number
  /** `전반 27분` / `후반 63분` / `후반 추가시간` */
  minuteKo: string
  team: string
  opp: string
  player: string
  /** 조사 결합형 — 템플릿이 `손흥민가`를 만들 수 없게 미리 붙여 둔다. */
  playerIGa: string
  playerEunNeun: string
  playerEulReul: string
  teamIGa: string
  teamEunNeun: string
  /** 화면용 스코어(`2-1`). 골 이벤트는 득점팀 관점, 그 외는 홈-원정. */
  scoreText: string
  /** 발화용 스코어(`이 대 일`). */
  scoreSpeech: string
  /** streak 서수 관형사(`세`). streak가 없으면 빈 문자열. */
  nth: string
}

/** 템플릿 1개. `s`(speech)를 생략하면 `t`(text)를 그대로 발화한다. */
interface Tpl {
  id: string
  intensity: Intensity
  t: (v: Vars) => string
  s?: (v: Vars) => string
}

/** 템플릿 정의 축약형 — 함수 1개면 text=speech, 튜플이면 [text, speech]. */
type TplDef = ((v: Vars) => string) | [(v: Vars) => string, (v: Vars) => string]

/** 풀 정의 헬퍼 — id에 풀 이름과 인덱스를 자동 부여한다(링버퍼 키). */
function pool(name: string, intensity: Intensity, items: TplDef[]): Tpl[] {
  return items.map((it, i) =>
    Array.isArray(it)
      ? { id: `${name}.${i}`, intensity, t: it[0], s: it[1] }
      : { id: `${name}.${i}`, intensity, t: it },
  )
}

// 기본 이벤트 풀. 종결어미를 의도적으로 섞었다 — 체언 종결(`슛!` `코너킥.`),
// `-니다`, `-네요`, `-죠`. 26/26이 `-니다`였던 게 로봇 신호였다(§4.1 #2).
const BASE: Record<MatchEventType, Tpl[]> = {
  kickoff: pool('kickoff', 1, [
    () => '경기가 시작됩니다.',
    v => `${v.team}의 킥오프, 경기가 열립니다.`,
    v => `킥오프! ${v.team} 대 ${v.opp}, 90분의 승부가 시작됩니다.`,
    () => '주심의 휘슬, 경기 시작입니다.',
    v => `${v.teamIGa} 공을 굴립니다. 시작합니다.`,
  ]),
  chance: pool('chance', 1, [
    v => `${v.player}, 좋은 기회를 잡습니다.`,
    v => `${v.playerEunNeun} 여기서 공간을 찾아냅니다.`,
    v => `${v.teamIGa} 위험한 순간을 만들어냅니다!`,
    v => `${v.player}에게 찬스!`,
    v => `열립니다! ${v.player}!`,
    v => `${v.team}, 박스 안으로 파고듭니다.`,
    v => `기회입니다. ${v.player}.`,
    v => `${v.playerIGa} 수비 사이를 비집고 들어가네요.`,
  ]),
  shot: pool('shot', 2, [
    v => `${v.player}, 슛!`,
    v => `${v.playerIGa} 때립니다!`,
    v => `${v.player}의 슈팅, 골문을 향합니다!`,
    v => `슛! ${v.player}!`,
    v => `${v.playerEunNeun} 과감하게 노려봅니다.`,
    v => `${v.team}, 슈팅으로 연결합니다.`,
    v => `여기서 슛을 시도합니다, ${v.player}.`,
    v => `${v.player}의 발끝을 떠납니다!`,
  ]),
  // goal은 종류별 전용 풀(GOAL_POOLS)을 쓴다. 여기 값은 판정 실패 시 안전망.
  goal: pool('goal', 3, [
    [v => `고오오올! ${v.player}!`, v => `골! ${v.player}!`],
    v => `${v.player}, 골망을 흔듭니다!`,
    v => `${v.team}의 골! 스코어가 움직입니다!`,
  ]),
  save: pool('save', 2, [
    () => '막아냅니다!',
    v => `${v.player}, 선방!`,
    v => `${v.player}의 세이브!`,
    v => `${v.playerIGa} 손끝으로 걷어냅니다!`,
    v => `${v.team} 골키퍼, 몸을 날립니다!`,
    () => '이걸 막아내네요.',
    v => `${v.player}, 골문을 지킵니다.`,
  ]),
  miss: pool('miss', 1, [
    () => '빗나갑니다.',
    v => `${v.player}의 슛, 골문을 벗어납니다.`,
    [v => `아… ${v.player}. 마무리가 아쉽습니다.`, v => `아, ${v.player}. 마무리가 아쉽습니다.`],
    v => `${v.teamIGa} 기회를 살리지 못합니다.`,
    () => '골문 옆으로 흐릅니다.',
    v => `${v.playerEunNeun} 고개를 떨굽니다.`,
    v => `${v.player}, 조금 높았죠.`,
  ]),
  foul: pool('foul', 0, [
    () => '파울입니다.',
    v => `${v.player}의 반칙으로 흐름이 끊깁니다.`,
    v => `${v.playerEunNeun} 늦게 들어갔습니다.`,
    () => '주심, 휘슬을 붑니다.',
    v => `${v.team} 진영에서 반칙이 나옵니다.`,
    v => `${v.playerIGa} 상대를 넘어뜨립니다.`,
  ]),
  yellow: pool('yellow', 2, [
    v => `${v.player}, 옐로카드.`,
    v => `주심이 ${v.player}에게 경고를 줍니다.`,
    v => `경고 하나가 나옵니다. ${v.player}입니다.`,
    v => `${v.playerEunNeun} 경고를 피하지 못합니다.`,
  ]),
  red: pool('red', 3, [
    v => `${v.player}, 레드카드! 퇴장입니다!`,
    v => `주심이 ${v.playerEulReul} 그라운드 밖으로 내보냅니다.`,
    v => `퇴장! ${v.team}, 수적 열세에 놓입니다.`,
  ]),
  corner: pool('corner', 1, [
    () => '코너킥.',
    v => `${v.team}의 코너킥입니다.`,
    v => `${v.player}, 코너에 공을 올립니다.`,
    v => `${v.teamIGa} 코너킥을 얻어냅니다.`,
    v => `${v.team}, 세트피스 기회를 잡네요.`,
  ]),
  sub: pool('sub', 0, [
    v => `${v.player}, 그라운드에 들어섭니다.`,
    v => `${v.team}, 교체 카드를 씁니다.`,
    v => `교체입니다. ${v.player}.`,
    v => `${v.team} 벤치가 움직입니다.`,
  ]),
  halftime: pool('halftime', 1, [
    () => '전반 종료.',
    () => '하프타임을 알리는 휘슬입니다.',
    [v => `전반이 끝났습니다. 스코어는 ${v.scoreText}.`, v => `전반이 끝났습니다. 스코어는 ${v.scoreSpeech}입니다.`],
  ]),
  fulltime: pool('fulltime', 2, [
    () => '경기 종료!',
    [v => `종료 휘슬. 최종 스코어 ${v.scoreText}.`, v => `종료 휘슬. 최종 스코어 ${v.scoreSpeech}입니다.`],
    () => '여기서 경기가 끝납니다.',
  ]),
}

// 골 종류별 풀 (§3.1). 종류마다 전용 명사가 있고, 틀리면 즉시 어색해진다.
const GOAL_POOLS: Record<GoalKind, Tpl[]> = {
  opener: pool('goal.opener', 3, [
    [v => `고오오올! ${v.player}! 귀중한 선제골입니다!`, v => `골! ${v.player}! 귀중한 선제골입니다!`],
    v => `${v.player}! 선제골! ${v.team}, 먼저 앞서 나갑니다!`,
    v => `균형이 깨집니다! 선취점은 ${v.team}입니다!`,
    v => `골! ${v.playerIGa} 첫 골을 신고합니다!`,
  ]),
  equalizer: pool('goal.equalizer', 3, [
    v => `동점골! 원점입니다! ${v.player}!`,
    [v => `따라붙습니다! ${v.scoreText}! ${v.player}의 골!`, v => `따라붙습니다! ${v.scoreSpeech}! ${v.player}의 골!`],
    v => `경기를 다시 원점으로 돌립니다! ${v.player}!`,
    v => `${v.player}! 이거 큽니다. 완전히 새 경기가 됐습니다!`,
  ]),
  comeback: pool('goal.comeback', 3, [
    v => `역전! 역전골입니다! ${v.player}!`,
    v => `뒤집었습니다! ${v.teamIGa} 경기를 뒤집습니다!`,
    v => `끌려가던 ${v.team}, 드디어 앞서 나갑니다! ${v.player}!`,
    [v => `고오오올! 역전입니다! ${v.player}!`, v => `골! 역전입니다! ${v.player}!`],
  ]),
  restore: pool('goal.restore', 3, [
    v => `${v.player}! 다시 앞서 나갑니다!`,
    v => `골! ${v.team}, 리드를 되찾습니다!`,
    v => `균형을 깨는 골입니다! ${v.player}!`,
  ]),
  clincher: pool('goal.clincher', 3, [
    v => `쐐기를 박습니다! ${v.player}!`,
    [v => `${v.scoreText}. 승부에 쐐기를 박는 골입니다.`, v => `${v.scoreSpeech}. 승부에 쐐기를 박는 골입니다.`],
    v => `${v.player}의 골. 이걸로 사실상 승부는 결정됐습니다.`,
    v => `${v.team}, 쐐기골입니다. 이제 뒤집기는 어려워 보이네요.`,
  ]),
  extra: pool('goal.extra', 3, [
    v => `추가골! ${v.player}!`,
    v => `${v.team}, 한 골 더 달아납니다! ${v.player}의 골!`,
    [v => `골! ${v.scoreText}. 점수가 벌어집니다.`, v => `골! ${v.scoreSpeech}. 점수가 벌어집니다.`],
  ]),
  chase: pool('goal.chase', 3, [
    v => `추격골입니다! 아직 끝나지 않았습니다! ${v.player}!`,
    () => '한 골 따라붙습니다! 희망이 생깁니다!',
    [v => `${v.scoreText}. ${v.player}의 골로 간격을 좁힙니다.`, v => `${v.scoreSpeech}. ${v.player}의 골로 간격을 좁힙니다.`],
  ]),
  consolation: pool('goal.consolation', 2, [
    () => '만회골입니다. 조금 늦었지만 의미는 있습니다.',
    v => `${v.player}, 한 골 만회합니다.`,
    v => `영패는 면했습니다. ${v.player}의 골입니다.`,
  ]),
}

// 극장골 — 88분 이후 동점·역전에만. 남발하면 죽는 단어다(§3.2).
const LATE_DRAMA: Tpl[] = pool('goal.lateDrama', 3, [
  [v => `고오오올!! 극장골!! ${v.player}!!`, v => `골! 극장골입니다! ${v.player}!`],
  v => `이게 됩니까! 경기 종료 직전, ${v.player}!`,
  v => `다 끝난 경기를 되돌립니다! ${v.player}의 극장골!`,
])

const MULTI_GOAL: Tpl[] = pool('goal.multi', 3, [
  v => `멀티골! 오늘 두 번째 골입니다! ${v.player}!`,
  v => `${v.player}, 또 한 골! 오늘 두 골째입니다!`,
])

const HAT_TRICK: Tpl[] = pool('goal.hattrick', 3, [
  v => `해트트릭! ${v.player}, 해트트릭입니다!`,
  v => `해트트릭! 오늘 경기 공은 ${v.playerIGa} 챙겨 갑니다!`,
])

// streak 풀 — `또`·`이번에도`·`벌써`·`연속` 네 단어가 "기억하는 중계"를 만든다(§3.3).
const STREAK_POOLS: Record<Exclude<StreakKind, 'conceded'>, Tpl[]> = {
  playerShots: pool('streak.playerShots', 2, [
    v => `또 ${v.player}입니다!`,
    v => `이번에도 ${v.player}!`,
    v => `${v.player}, 오늘 벌써 ${v.nth} 번째 슛입니다.`,
    v => `계속 ${v.player}입니다. 혼자 다 하네요.`,
  ]),
  saves: pool('streak.saves', 2, [
    () => '또 막아냅니다!',
    () => '이번에도 막습니다!',
    v => `연속 선방! ${v.player}, 벽입니다!`,
    v => `${v.player}, 오늘 ${v.nth} 번째 선방입니다.`,
  ]),
  corners: pool('streak.corners', 1, [
    () => '연속 코너킥입니다.',
    () => '계속 두드립니다. 또 코너킥.',
    v => `${v.nth} 번째 코너킥. ${v.team}, 완전히 몰아붙이네요.`,
  ]),
  fouls: pool('streak.fouls', 1, [
    v => `${v.player}, 오늘 벌써 ${v.nth} 번째 파울입니다. 카드가 나올 수 있어요.`,
    v => `또 ${v.player}입니다. 반칙이 잦네요.`,
  ]),
}

// 연속 실점 — 골 라인 뒤에 붙는 꼬리 문장(골 풀은 득점팀 관점이라 대체하지 않는다).
const CONCEDED_TAILS: readonly string[] = [
  '또 들어갔습니다. 수비가 흔들리네요.',
  '연속 실점입니다.',
  '순식간에 두 골입니다.',
]

// 문두 필러(§2.x) — 실제 중계는 30%대. 연속 사용 금지가 핵심이다.
const FILLERS: readonly string[] = ['자,', '아,', '네,', '그런데,', '여기서,']

/** 필러를 붙일 확률(%). 리서치 권고 25~35%의 중앙값. */
const FILLER_PCT = 30
/** 골·카드·경계 외 이벤트에 분을 삽입할 확률(%). 낮게 유지한다 — 분 낭독이 로봇 신호였다. */
const MINUTE_PCT = 12
/** 최근 사용 변형 억제 링버퍼 길이. 풀 크기(2~8)보다 넉넉해 직전 반복을 확실히 막는다. */
const RECENT_RING = 10
/** `{선수}! {선수}!` 연호 경기당 상한(§4.1 #12). */
const CHANT_CAP = 3
/** 문장 안에 분을 항상 넣는 이벤트 — 골·카드·전후반 경계. */
const ALWAYS_MINUTE: ReadonlySet<MatchEventType> = new Set(['goal', 'yellow', 'red', 'halftime', 'fulltime'])

// ── 해설위원 (§1) ────────────────────────────────────────────
// 캐스터가 사실을 던지고, 해설이 그 사실에 해석을 붙인다. 표준 시퀀스 3박자 중
// [캐스터 사실] → [해설 해석] 두 박자만 쓴다(§1.3).
//
// ★ 문장 설계 원칙(세이프가드 연장선):
//   - 경기 화면이 보여주지 않은 미시 사실을 지어내지 않는다. "수비수 두 명이 공만 보고
//     있었다" 같은 문장은 엔진이 모르는 사실이라 화면과 어긋날 수 있다. 대신 **언제나
//     참인 판단**(경기 양상·남은 시간·심리·다음 국면)으로 쓴다.
//   - 1인칭 편파(`우리`)는 쓰지 않는다. 1인칭 **판단**(`제가 보기엔`)은 해설의 문법이므로 쓴다.
//   - 30음절 이내(§5.8 — Chrome 15초 유터런스 절단 여유).

/** 해설이 **항상** 개입하는 이벤트 — 골과 퇴장은 방송에서도 예외 없이 해설이 받는다. */
const ANALYST_ALWAYS: ReadonlySet<MatchEventType> = new Set(['goal', 'red', 'halftime', 'fulltime'])

/**
 * 그 외 이벤트에 해설이 붙을 확률(%). 목표는 **전체 이벤트의 30~40%**(§1.3).
 * 실경기 이벤트 분포(파울·코너·슛이 다수, 골·카드는 소수)에 맞춰 큰 사건일수록 높였다.
 * 목록에 없는 타입(kickoff·chance)엔 해설이 붙지 않는다 — 아직 아무 일도 안 일어났다.
 */
const ANALYST_PCT: Partial<Record<MatchEventType, number>> = {
  sub: 100, save: 64, miss: 46, yellow: 40, shot: 18, corner: 12,
}
// ★ `foul`이 빠진 이유: 파울은 해설이 가장 할 말이 없는 장면인데(체감상 "네, 위험한
//   위치는 아닙니다" 한 줄), 파울 분의 리듬 dwell은 2.7초로 짧아 해설을 붙이면 체류가
//   두 배로 늘어난다. 가치 대비 비용이 가장 나쁜 조합이라 통째로 뺐다.
//   반대로 `sub`은 100%다 — 교체는 감독의 결정이라 해설이 반드시 짚어야 하고,
//   교체 이벤트는 주인공 이벤트가 아니라(playback.DRAMA_PRIORITY 밖) 체류를 늘리지 않는다.

/** 해설 개입 최소 간격(라인 수). 직전 이벤트에 해설이 붙었으면 확률 개입은 건너뛴다 —
 *  해설이 두 이벤트 연속으로 말하면 캐스터가 사라진 것처럼 들린다. */
const ANALYST_GAP = 2

/** 해설 라인은 캐스터보다 한 단계 낮은 강도로 말한다(탄식·완서 — §1.1 감정 열). */
function analystIntensity(base: Intensity): Intensity {
  return Math.max(0, base - 1) as Intensity
}

// 골 종류별 해설. 캐스터가 "무엇"을 외친 직후 "그래서 이 골이 무슨 의미인가"를 붙인다.
const AN_GOAL: Partial<Record<GoalKind, Tpl[]>> = {
  opener: pool('an.goal.opener', 2, [
    () => '네, 선제골의 무게가 큽니다. 이제 상대가 나와야 하죠.',
    () => '먼저 넣은 쪽이 경기를 끌고 갑니다.',
    () => '이 한 골로 경기 운영이 편해집니다.',
  ]),
  equalizer: pool('an.goal.equalizer', 2, [
    () => '이건 완전히 새 경기입니다. 따라잡힌 쪽이 흔들리거든요.',
    () => '네, 이 시점의 동점골은 넣은 쪽에 힘이 확 실립니다.',
    () => '앞서 있던 팀엔 뼈아프죠. 다시 만들어야 합니다.',
  ]),
  comeback: pool('an.goal.comeback', 2, [
    () => '역전은 다릅니다. 앞섰던 팀 라인이 내려가거든요.',
    () => '네, 이 골 하나로 두 팀의 계획이 통째로 바뀝니다.',
    v => `${v.opp}, 이제 나올 수밖에 없습니다. 공간이 생기죠.`,
  ]),
  clincher: pool('an.goal.clincher', 1, [
    () => '남은 시간을 생각하면 뒤집기가 쉽지 않습니다.',
    () => '네, 사실상 여기서 갈렸다고 봅니다.',
    () => '이제 벤치는 다음 경기를 생각할 겁니다.',
  ]),
  chase: pool('an.goal.chase', 2, [
    () => '한 골 차가 되면 지키는 쪽이 훨씬 불편해집니다.',
    () => '네, 아직 시간이 있습니다. 다음 십 분이 중요해요.',
  ]),
  consolation: pool('an.goal.consolation', 1, [
    () => '늦었지만 다음 경기 분위기를 만드는 골입니다.',
    () => '네, 끝까지 포기하지 않은 결과죠.',
  ]),
}

// 종류 판정이 없거나 전용 풀이 없는 골(restore·extra)의 기본 해설.
const AN_GOAL_ANY: Tpl[] = pool('an.goal.any', 2, [
  () => '네, 마무리가 침착했습니다. 서두르면 안 들어가거든요.',
  () => '이 골 하나로 경기 양상이 또 바뀝니다.',
  () => '점수 차가 벌어지면 뒤진 쪽이 라인을 올려야 하죠.',
])

// 이벤트 타입별 해설. 골은 위 전용 풀이 우선한다.
const AN_BASE: Partial<Record<MatchEventType, Tpl[]>> = {
  // ★ save·miss·yellow·shot은 **짧게** 간다. 실제 방송에서도 흔한 장면의 해설은
  //   한 마디로 끝난다 — 길게 붙이면 다음 장면을 캐스터가 못 받는다(체류 시간 압박).
  //   긴 2~3문장은 골·퇴장·하프타임처럼 경기가 멈춘 순간에만 쓴다(§1.1 문장 길이 열).
  save: pool('an.save', 1, [
    () => '네, 이런 선방이 승점을 지킵니다.',
    v => `${v.player}, 자리 선정이 좋았습니다.`,
    () => '각을 좁힌 게 컸어요.',
    () => '이런 장면 하나가 수비를 편하게 하죠.',
  ]),
  miss: pool('an.miss', 1, [
    () => '조금만 더 눕혀 찼으면 좋았을 텐데요.',
    () => '네, 슛 선택은 맞았습니다.',
    () => '이런 게 쌓이면 후회로 남습니다.',
    () => '급했습니다. 한 박자만 참았으면요.',
  ]),
  yellow: pool('an.yellow', 1, [
    () => '경고를 안고 뛰면 발이 안 나갑니다.',
    () => '네, 발이 먼저 들어갔습니다.',
    () => '벤치가 교체를 고민하게 되죠.',
  ]),
  red: pool('an.red', 2, [
    () => '수적 열세는 체력에서 먼저 옵니다.',
    v => `${v.team}, 이제 한 명을 빼고 수비 숫자를 맞춰야 합니다.`,
    () => '네, 경기 계획을 통째로 다시 짜야 하는 상황입니다.',
  ]),
  sub: pool('an.sub', 0, [
    () => '벤치가 흐름을 바꿔 보겠다는 겁니다.',
    () => '다리가 무거워진 자리를 먼저 정리합니다.',
    () => '네, 이 시점의 교체는 늦기 전에 하는 게 맞죠.',
  ]),
  shot: pool('an.shot', 1, [
    () => '이렇게 두드리다 보면 하나는 들어갑니다.',
    () => '네, 슛을 아끼지 않는 게 좋죠.',
  ]),
  corner: pool('an.corner', 0, [
    () => '세트피스 하나가 경기를 가릅니다.',
    () => '네, 두 번째 볼 싸움을 봐야죠.',
  ]),
  foul: pool('an.foul', 0, [
    () => '흐름을 끊는 것도 경기 운영이죠.',
    () => '네, 위험한 위치는 아닙니다.',
  ]),
  halftime: pool('an.halftime', 1, [
    () => '네, 후반 십오 분이 분수령이 될 겁니다.',
    () => '라커룸에서 어떤 이야기가 나오느냐가 후반을 가릅니다.',
    () => '전반에 아낀 체력을 후반 어디에 쓸지 정해야 합니다.',
  ]),
  fulltime: pool('an.fulltime', 1, [
    () => '네, 두 팀 다 준비한 걸 꺼낸 경기였습니다.',
    () => '결정적인 순간을 누가 잡았느냐로 갈렸습니다.',
    () => '제가 보기엔 후반 중반의 십 분이 승부처였습니다.',
  ]),
}

// ── 전술 반영 해설 (§3.5) ────────────────────────────────────
// ★ 인과 단정 금지. 엔진은 "그 지시 **때문에**" 이 장면이 나왔는지 알 수 없다.
//   그래서 전부 **시간 서술**("~한 뒤로", "~하고 나서")로 쓴다. 시간 서술은 관찰이라
//   틀릴 수 없고, 듣는 사람은 그걸 인과로 읽는다 — 거짓말 없이 같은 효과를 낸다.

/** 감독 지시 1건을 해설이 알아볼 수 있는 형태로 정규화한 것. */
export type TacticKind =
  | 'pressUp' | 'pressDown'
  | 'lineUp' | 'lineDown'
  | 'tempoUp' | 'tempoDown'
  | 'focusWing' | 'focusCenter'
  | 'backThree' | 'backFour' | 'formation'
  | 'sub'

export interface TacticalNote { minute: number; kind: TacticKind }

/** `matchStore`가 `detail.changed`에 넣는 `"압박 55→90"` 형식. 라벨은 matchStore와 동기. */
const CHANGED_RE = /^(라인|압박|템포|공격)\s(.+)→(.+)$/

/** 스리백 계열 포메이션(첫 숫자가 3 또는 5). */
function isBackThree(f: string): boolean {
  return f.startsWith('3') || f.startsWith('5')
}

/**
 * 감독 개입 기록을 해설이 쓸 수 있는 노트로 바꾼다(순수·읽기 전용).
 * 파싱 실패·해석 불가 항목은 조용히 버린다 — 해설이 없는 게 틀린 해설보다 낫다.
 */
export function readTacticalNotes(decisions: readonly DecisionEntry[]): TacticalNote[] {
  const out: TacticalNote[] = []
  for (const d of decisions) {
    if (d.kind === 'sub') {
      out.push({ minute: d.minute, kind: 'sub' })
      continue
    }
    if (d.kind !== 'instructions') continue
    const detail = d.detail ?? {}
    const changed = detail.changed
    if (Array.isArray(changed)) {
      for (const raw of changed) {
        const m = CHANGED_RE.exec(String(raw))
        if (!m) continue
        const [, axis, before, after] = m
        if (axis === '공격') {
          if (after === '좌' || after === '우') out.push({ minute: d.minute, kind: 'focusWing' })
          else if (after === '중앙') out.push({ minute: d.minute, kind: 'focusCenter' })
          continue
        }
        const b = Number(before), a = Number(after)
        if (!Number.isFinite(b) || !Number.isFinite(a) || a === b) continue
        const up = a > b
        if (axis === '라인') out.push({ minute: d.minute, kind: up ? 'lineUp' : 'lineDown' })
        else if (axis === '압박') out.push({ minute: d.minute, kind: up ? 'pressUp' : 'pressDown' })
        else out.push({ minute: d.minute, kind: up ? 'tempoUp' : 'tempoDown' })
      }
      continue
    }
    const before = detail.before, after = detail.after
    if (typeof before === 'string' && typeof after === 'string' && before !== after) {
      const kind: TacticKind = isBackThree(after) && !isBackThree(before)
        ? 'backThree'
        : !isBackThree(after) && isBackThree(before) ? 'backFour' : 'formation'
      out.push({ minute: d.minute, kind })
    }
  }
  return out
}

/** 지시가 해설에 언급될 수 있는 유효 기간(분). 이보다 오래되면 더는 "그 지시 뒤"가 아니다. */
const TACTIC_WINDOW = 10
/** 지시 직후 몇 분은 건너뛴다 — 지시하자마자 효과를 말하면 거짓말처럼 들린다. */
const TACTIC_DELAY = 1
/** 전술 해설이 붙을 수 있는 이벤트(장면이 있어야 "그 뒤로 이렇게 됐다"를 말할 수 있다). */
const TACTIC_TRIGGERS: ReadonlySet<MatchEventType> = new Set(['goal', 'shot', 'chance', 'save', 'corner', 'miss'])

/**
 * 전술 해설 문장. `mine`은 이벤트 주체가 **감독의 팀**인지 — 같은 지시라도
 * 우리가 만든 장면인지 상대가 만든 장면인지에 따라 할 말이 정반대다.
 * 모든 문장이 시간 서술이다("~한 뒤로"), 인과 단정이 없다.
 */
export const TACTIC_LINES: Record<TacticKind, { mine: readonly string[]; theirs: readonly string[] }> = {
  pressUp: {
    mine: [
      '압박을 올린 뒤로 높은 위치에서 공을 끊는 장면이 나옵니다.',
      '네, 압박 강도를 올리고 나서 상대가 후방에서 공을 못 돌리고 있습니다.',
    ],
    theirs: [
      '압박을 올린 만큼 뒷공간이 비어 있습니다. 위험 부담은 감수하겠다는 거죠.',
      '압박을 올린 뒤로 이런 뒷공간 장면이 늘었습니다.',
    ],
  },
  pressDown: {
    mine: ['압박을 낮춘 뒤로 공을 끊고 나가는 거리가 길어졌습니다.'],
    theirs: ['압박을 낮추고 나서 상대에게 시간을 주고 있습니다.'],
  },
  lineUp: {
    mine: ['라인을 올린 뒤로 상대 진영에서 경기가 이어집니다.'],
    theirs: ['라인을 올린 뒤에 나온 뒷공간 장면입니다. 이게 이 선택의 값이죠.'],
  },
  lineDown: {
    mine: [
      '라인을 내린 뒤에 나온 역습입니다. 이걸 노린 거죠.',
      '네, 내려서서 공간을 벌어 두고 한 번에 나갔습니다.',
    ],
    theirs: ['라인을 내렸는데도 상대가 계속 두드립니다. 버티는 시간이 길어지네요.'],
  },
  tempoUp: {
    mine: ['템포를 올린 뒤로 전개가 눈에 띄게 빨라졌습니다.'],
    theirs: ['템포를 올린 뒤로 실수도 같이 나오고 있습니다. 급할 때 나오는 장면이죠.'],
  },
  tempoDown: {
    mine: ['속도를 줄이고 나서 볼을 오래 소유합니다. 시간을 관리하는 거죠.'],
    theirs: ['속도를 줄인 사이에 상대가 자리를 잡았습니다.'],
  },
  focusWing: {
    mine: ['측면으로 붙이기 시작한 뒤로 계속 저쪽에서 장면이 나옵니다.'],
    theirs: ['측면에 무게를 실은 만큼 중앙이 비어 있습니다.'],
  },
  focusCenter: {
    mine: ['중앙으로 좁힌 뒤로 짧은 패스가 늘었습니다.'],
    theirs: ['중앙에 모인 사이 측면이 열려 있습니다.'],
  },
  backThree: {
    mine: ['스리백으로 바꾼 뒤로 윙백 두 명이 사실상 윙어처럼 올라옵니다.'],
    theirs: ['스리백으로 바꾼 뒤 중앙이 넓어져 있습니다.'],
  },
  backFour: {
    mine: ['포백으로 돌아온 뒤로 뒤가 정리됐습니다.'],
    theirs: ['포백으로 돌아왔는데 측면 뒤가 계속 노출됩니다.'],
  },
  formation: {
    mine: ['포메이션을 바꾼 뒤로 서는 위치가 달라졌습니다.'],
    theirs: ['포메이션을 바꾼 직후라 아직 자리가 덜 잡혔습니다.'],
  },
  sub: {
    mine: [
      '교체 카드를 쓰고 나서 곧바로 장면이 나옵니다.',
      '네, 들어온 선수가 다리가 살아 있으니 확실히 다릅니다.',
    ],
    theirs: ['교체 직후엔 자리가 한 번 흔들립니다. 지금이 그 시간이죠.'],
  },
}

// ── speech 정규화 (§5.2) ─────────────────────────────────────

/**
 * TTS 문자열을 안전하게 만든다.
 * - `…`/`...` → `,` (Apple 음성은 무시하거나 `.`로 처리 — 쉼표가 유일하게 이식성 있는 pause)
 * - `!!`+ → `!` (여러 개는 무시되거나 이상한 pause를 만든다)
 * - 이모지·라틴 문자 제거 (ko-KR 보이스가 철자를 읽거나 자모 이름으로 읽는다)
 */
export function sanitizeSpeech(s: string): string {
  return s
    .replace(/[.]{3,}|…+/g, ',')
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/[A-Za-z]+/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim()
}

// ── 분 라벨 ─────────────────────────────────────────────────

/** `전반 27분` / `후반 63분` / `후반 추가시간`. 숫자는 한자어로 정상 발음된다(§5.3). */
export function minuteLabel(m: number): string {
  if (m > 90) return '후반 추가시간'
  return m <= 45 ? `전반 ${m}분` : `후반 ${m}분`
}

// ── fold 상태 ───────────────────────────────────────────────

interface FoldState {
  score: [number, number]
  wasBehind: Record<string, boolean>
  playerGoals: Record<string, number>
  recentIds: string[]
  /** 직전 라인이 필러를 썼는가 — 연속 필러 금지. */
  prevHadFiller: boolean
  /** 직전에 쓴 필러 — 같은 필러 연달아 쓰지 않는다. */
  prevFiller: string
  chantsUsed: number
  /** 해설위원 변형 억제 링버퍼(캐스터와 별도 — 풀이 다르므로 섞으면 서로를 굶긴다). */
  recentAnIds: string[]
  /** 마지막으로 해설이 붙은 라인 인덱스. ANALYST_GAP 간격 판정용. -1 = 아직 없음. */
  lastAnalystIndex: number
  /** 이미 해설이 언급한 지시 노트(중복 언급 금지 — 같은 지시를 두 번 말하면 우습다). */
  usedNotes: Set<number>
}

/** 이벤트 주체 팀·선수(name.ko). 선수 미지정·미발견이면 팀명으로 대체한다. */
function resolve(e: MatchEvent, home: Team, away: Team): { team: string; opp: string; player: string } {
  const acting = e.teamId === home.id ? home : away
  const other = e.teamId === home.id ? away : home
  const team = acting.name.ko
  const player = e.playerId ? (acting.squad.find(p => p.id === e.playerId)?.name.ko ?? team) : team
  return { team, opp: other.name.ko, player }
}

/**
 * 변형을 고른다. 최근 사용 변형을 먼저 제외해 주기적 반복을 없애고, 남는 게 없으면
 * 전체 풀에서 해시로 고른다(결정론 유지 — 랜덤을 쓰지 않는다).
 */
function pickVariant(items: Tpl[], key: string, recentIds: string[]): Tpl {
  const fresh = items.filter(t => !recentIds.includes(t.id))
  const usable = fresh.length > 0 ? fresh : items
  return usable[fnv1a(key) % usable.length]
}

/** 골 이벤트에 쓸 풀을 고른다. 해트트릭 > 멀티골 > 극장골 > 종류별. */
function goalPool(kind: GoalKind, scored: number, minute: number): Tpl[] {
  if (scored >= 3) return HAT_TRICK
  if (scored === 2) return MULTI_GOAL
  if (minute >= 88 && (kind === 'equalizer' || kind === 'comeback')) return LATE_DRAMA
  return GOAL_POOLS[kind] ?? BASE.goal
}

/** 해설 라인 1개를 만든다(문장은 이미 결정된 상태 — 포장만 한다). */
function makeAnalystLine(id: string, minute: number, text: string, intensity: Intensity): Line {
  return {
    id, speaker: 'analyst', minute, text,
    speech: sanitizeSpeech(text), intensity, hasMinutePrefix: false,
  }
}

/**
 * 이 이벤트에 붙일 **전술 해설**을 찾는다. 없으면 null.
 * 조건: 감독의 지시가 TACTIC_DELAY~TACTIC_WINDOW분 전에 있었고, 아직 언급하지 않았고,
 * 지금 이벤트가 "그 뒤로 이렇게 됐다"를 말할 수 있는 장면일 것.
 */
function tacticalFollow(
  e: MatchEvent, notes: readonly TacticalNote[], managedTeamId: string, h: number, st: FoldState,
): Line | null {
  if (!TACTIC_TRIGGERS.has(e.type)) return null
  // 가장 최근의 미언급 노트부터 본다 — 감독이 방금 내린 지시가 가장 궁금하다.
  for (let i = notes.length - 1; i >= 0; i--) {
    if (st.usedNotes.has(i)) continue
    const gap = e.minute - notes[i].minute
    if (gap < TACTIC_DELAY || gap > TACTIC_WINDOW) continue
    // ★ 관점은 **공격한 쪽** 기준이다. `save`의 teamId는 막은 팀이므로 뒤집는다 —
    //   안 뒤집으면 "우리 골키퍼 선방"에 "템포를 올린 뒤 전개가 빨라졌다"가 붙는다.
    const attackerIsManaged = e.type === 'save' ? e.teamId !== managedTeamId : e.teamId === managedTeamId
    const mine = attackerIsManaged
    const set = TACTIC_LINES[notes[i].kind]
    const items = mine ? set.mine : set.theirs
    if (items.length === 0) continue
    st.usedNotes.add(i)
    const text = items[h % items.length]
    return makeAnalystLine(`an.tactic.${notes[i].kind}.${mine ? 'mine' : 'theirs'}`, e.minute, text, 1)
  }
  return null
}

/** 이벤트 종류에 맞는 해설 풀. 없으면 null(= 해설을 붙일 말이 없다). */
function analystPool(e: MatchEvent, goalKind: GoalKind | null): Tpl[] | null {
  if (e.type === 'goal') return (goalKind && AN_GOAL[goalKind]) ?? AN_GOAL_ANY
  return AN_BASE[e.type] ?? null
}

/**
 * 캐스터 라인에 이어 붙일 해설위원 라인을 정한다(§1.3 "모든 이벤트에 붙이지 말 것").
 * 우선순위: 전술 해설 > 항상 개입(골·퇴장·경계) > 확률 개입.
 */
function analystFollow(
  e: MatchEvent, index: number, v: Vars, goalKind: GoalKind | null,
  notes: readonly TacticalNote[], managedTeamId: string, casterIntensity: Intensity,
  h: number, st: FoldState,
): Line | null {
  const tactic = tacticalFollow(e, notes, managedTeamId, h >>> 3, st)
  if (tactic) return tactic

  const always = ANALYST_ALWAYS.has(e.type)
  if (!always) {
    // 확률 개입은 간격 제한을 지킨다(피크 이벤트는 위에서 이미 통과).
    if (index - st.lastAnalystIndex < ANALYST_GAP) return null
    const pct = ANALYST_PCT[e.type] ?? 0
    if (pct === 0 || (h >>> 24) % 100 >= pct) return null
  }
  const items = analystPool(e, goalKind)
  if (!items) return null
  const tpl = pickVariant(items, `an|${index}|${e.minute}|${e.type}`, st.recentAnIds)
  st.recentAnIds.push(tpl.id)
  if (st.recentAnIds.length > RECENT_RING) st.recentAnIds.shift()
  return makeAnalystLine(tpl.id, e.minute, tpl.t(v), analystIntensity(casterIntensity))
}

/** 한 이벤트의 라인을 만들고 fold 상태를 갱신한다. */
function step(
  e: MatchEvent, index: number, prior: MatchEvent[], home: Team, away: Team, seed: number,
  st: FoldState, notes: readonly TacticalNote[], managedTeamId: string,
): Line {
  const { team, opp, player } = resolve(e, home, away)
  const isHome = e.teamId === home.id
  const streak = detectStreak(e, prior)

  // 스코어 문자열 — 골이면 득점 후 득점팀 관점, 그 외는 현재 홈-원정.
  let sa = st.score[0]
  let sb = st.score[1]
  let goalKind: GoalKind | null = null
  let scoredByPlayer = 0
  if (e.type === 'goal') {
    const before: [number, number] = [st.score[0], st.score[1]]
    const mine = isHome ? before[0] : before[1]
    const theirs = isHome ? before[1] : before[0]
    goalKind = classifyGoal(mine - theirs, before[0] + before[1], st.wasBehind[e.teamId] === true, e.minute)
    // 상태 갱신은 라인 생성 전에 반영해야 스코어 문구가 "골 직후"가 된다.
    st.score[isHome ? 0 : 1] += 1
    if (e.playerId) {
      st.playerGoals[e.playerId] = (st.playerGoals[e.playerId] ?? 0) + 1
      scoredByPlayer = st.playerGoals[e.playerId]
    }
    // 뒤진 팀 플래그 갱신(역전골 판정 근거).
    if (st.score[0] > st.score[1]) st.wasBehind[away.id] = true
    else if (st.score[1] > st.score[0]) st.wasBehind[home.id] = true
    sa = isHome ? st.score[0] : st.score[1]
    sb = isHome ? st.score[1] : st.score[0]
  }

  const v: Vars = {
    m: e.minute,
    minuteKo: minuteLabel(e.minute),
    team, opp, player,
    playerIGa: josaIGa(player),
    playerEunNeun: josaEunNeun(player),
    playerEulReul: josaEulReul(player),
    teamIGa: josaIGa(team),
    teamEunNeun: josaEunNeun(team),
    scoreText: `${sa}-${sb}`,
    scoreSpeech: scoreKo(sa, sb),
    nth: ordKo(streak?.n ?? 0),
  }

  // 풀 선택: streak 전용 풀이 있으면 그쪽을 우선한다(기억하는 중계가 우선).
  let items: Tpl[]
  if (goalKind) items = goalPool(goalKind, scoredByPlayer, e.minute)
  else if (streak && streak.kind !== 'conceded') items = STREAK_POOLS[streak.kind]
  else items = BASE[e.type]

  // 해시 키에 시드·인덱스·분·선수·스코어를 모두 섞는다 — 어느 한 축의 주기가 드러나지 않게.
  const key = `${seed}|${index}|${e.minute}|${e.type}|${e.playerId ?? e.teamId}|${st.score[0]}:${st.score[1]}`
  const tpl = pickVariant(items, key, st.recentIds)
  const h = fnv1a(`x${key}`)

  let text = tpl.t(v)
  let speech = (tpl.s ?? tpl.t)(v)

  // 연속 실점 꼬리 — 골 문장 뒤에 붙인다(득점 관점 문장을 지우지 않고 사실을 더한다).
  if (streak?.kind === 'conceded') {
    const tail = CONCEDED_TAILS[h % CONCEDED_TAILS.length]
    text += ` ${tail}`
    speech += ` ${tail}`
  }

  // 해설위원 — 캐스터 문장을 **받아서** 말한다(§1.1 "해설은 절대 먼저 말하지 않는다").
  // ★ 여기서 먼저 정하는 이유: 해설이 붙으면 연호를 생략해야 한다(바로 아래).
  const follow = analystFollow(e, index, v, goalKind, notes, managedTeamId, tpl.intensity, h, st)
  if (follow) st.lastAnalystIndex = index

  // 연호 — 골 피크에서만, 경기당 CHANT_CAP회 상한.
  // (문장이 이미 `{선수}!`로 끝나면 붙이지 않는다 — 이름이 세 번 반복되면 우스워진다)
  // ★ 해설이 뒤에 붙는 골에는 연호를 생략한다. 브라우저 실측에서 피크 골 라인이 6.9초까지
  //   늘어 해설이 다음 분에 잘렸다(interrupted). 이름 반복보다 해설 한 문장이 더 값지고,
  //   생략하면 골 순간의 총 발화가 체류 상한(MAX_DWELL_MS) 안에 들어온다.
  if (goalKind && !follow && st.chantsUsed < CHANT_CAP && player !== team
      && !text.endsWith(`${player}!`) && h % 100 < 45) {
    st.chantsUsed += 1
    text += ` ${player}! ${player}!`
    speech += ` ${player}! ${player}!`
  }

  // 템플릿 자체가 감탄사로 시작하면(`아… 손흥민.`) 필러를 겹치지 않는다 — `그런데, 아, …`는 우습다.
  // 분 접두를 붙이기 **전에** 판정한다(붙인 뒤엔 문두가 `후반 64분,`으로 바뀐다).
  const startsWithInterjection = /^(아|자|네)[…,\s]/.test(text)

  // 분 삽입 — 골·카드·경계는 항상, 그 외는 MINUTE_PCT 확률.
  const hasMinutePrefix = e.type !== 'kickoff'
    && (ALWAYS_MINUTE.has(e.type) || (h >>> 8) % 100 < MINUTE_PCT)
  if (hasMinutePrefix) {
    text = `${v.minuteKo}, ${text}`
    speech = `${v.minuteKo}, ${speech}`
  }

  // 필러 — 피크(intensity 3)엔 붙이지 않는다. 연속 금지 + 같은 필러 연달아 금지.
  const intensity = tpl.intensity
  let usedFiller = ''
  if (intensity < 3 && !st.prevHadFiller && !startsWithInterjection && (h >>> 16) % 100 < FILLER_PCT) {
    const cands = FILLERS.filter(f => f !== st.prevFiller)
    usedFiller = cands[(h >>> 20) % cands.length]
    text = `${usedFiller} ${text}`
    speech = `${usedFiller} ${speech}`
  }
  st.prevHadFiller = usedFiller !== ''
  if (usedFiller) st.prevFiller = usedFiller

  // 링버퍼 갱신 — 다음 선택에서 이 변형을 제외한다.
  st.recentIds.push(tpl.id)
  if (st.recentIds.length > RECENT_RING) st.recentIds.shift()

  return {
    id: tpl.id,
    speaker: 'caster',
    minute: e.minute,
    text,
    speech: sanitizeSpeech(speech),
    intensity,
    hasMinutePrefix,
    ...(follow ? { follow } : {}),
  }
}

// ── 경기 흐름 · 소강 구간 (§3.4) ─────────────────────────────
// "아무 이벤트 없는 90초를 침묵으로 두면 게임이 죽는다." 다만 반대도 참이다 —
// 조용한 구간은 중계의 일부다. 그래서 **가뭄이 확실할 때만, 드물게** 말한다.

/** 흐름 상태. `dominant`/`lowBlock`은 주체 팀이 있다. */
export type FlowKind = 'dominant' | 'lull' | 'endToEnd' | 'lowBlock' | 'even'

/** 흐름 판정에 쓰는 "공격 장면" 이벤트. */
const ATTACKING: ReadonlySet<MatchEventType> = new Set(['shot', 'chance', 'corner', 'goal', 'save', 'miss'])

/** 흐름 판정 창(분). 이 구간의 공격 장면 분포로 양상을 읽는다. */
const FLOW_WINDOW = 12
/** 이만큼 연속으로 이벤트가 없어야 흐름 라인을 낸다.
 *  근거(실측 8경기): 무사건 분이 전체의 42.8%이고 연속 무사건 런의 분포는
 *  1분 93 / 2분 36 / 3분 21 / 4분+ 18 이다. 1x 재생에서 무사건 분은 1.8초이므로
 *  3분 연속 = 약 5초의 완전한 정적 — 여기가 중계가 비어 들리기 시작하는 지점이다.
 *  3으로 잡으면 경기당 4~5회 발동한다(캐스터 라인 100여 개 대비 5% 미만). */
const LULL_GAP = 3
/** 정적이 이어져도 이 간격(분)으로만 다시 말한다 — 같은 소강에 계속 말 걸지 않는다. */
const LULL_EVERY = 4
/** 흐름 라인을 내지 않는 구간 — 초반은 아직 판단할 재료가 없고, 종료 직전은 캐스터의 시간이다. */
const FLOW_MIN_MINUTE = 6
const FLOW_MAX_MINUTE = 88

/** 그 시점까지의 이벤트로 경기 흐름을 판정한다(순수·결정론).
 *  `side`는 그 양상의 주체(dominant=몰아붙이는 쪽, lowBlock=내려선 쪽). 없으면 null. */
export function flowStateAt(
  events: readonly MatchEvent[], minute: number, homeId: string,
): { kind: FlowKind; side: 'home' | 'away' | null } {
  let homeAtk = 0, awayAtk = 0
  let homeGoals = 0, awayGoals = 0
  for (const e of events) {
    if (e.type === 'goal') {
      if (e.teamId === homeId) homeGoals++
      else awayGoals++
    }
    if (e.minute > minute || e.minute <= minute - FLOW_WINDOW) continue
    if (!ATTACKING.has(e.type)) continue
    // `save`는 막은 팀의 이벤트지만 **공격한 쪽**은 반대다 — 흐름은 공격 주체로 센다.
    const attacker = e.type === 'save' ? (e.teamId === homeId ? 'away' : 'home') : (e.teamId === homeId ? 'home' : 'away')
    if (attacker === 'home') homeAtk++
    else awayAtk++
  }
  const total = homeAtk + awayAtk
  if (total <= 1) return { kind: 'lull', side: null }
  if (homeAtk >= 3 && awayAtk >= 3) return { kind: 'endToEnd', side: null }
  const lead: 'home' | 'away' = homeAtk >= awayAtk ? 'home' : 'away'
  const other: 'home' | 'away' = lead === 'home' ? 'away' : 'home'
  const leadN = Math.max(homeAtk, awayAtk), otherN = Math.min(homeAtk, awayAtk)
  if (leadN >= 4 && otherN <= 1) {
    // 몰아붙이는 쪽이 **지고 있으면** 상대가 잠근 것이다 — 같은 분포, 다른 이야기.
    const leadGoals = lead === 'home' ? homeGoals : awayGoals
    const otherGoals = lead === 'home' ? awayGoals : homeGoals
    if (leadGoals < otherGoals) return { kind: 'lowBlock', side: other }
    return { kind: 'dominant', side: lead }
  }
  return { kind: 'even', side: null }
}

/** 흐름 라인 풀. 화자를 템플릿마다 명시한다 — "잠잠하네요"는 캐스터의 말이지만
 *  "한 골은 시간문제"는 해설의 판단이다. */
interface FlowTpl { id: string; speaker: Speaker; intensity: Intensity; t: (team: string) => string }
function flowPool(name: string, items: Array<[Speaker, (team: string) => string]>): FlowTpl[] {
  return items.map(([speaker, t], i) => ({ id: `${name}.${i}`, speaker, intensity: 0 as Intensity, t }))
}

const FLOW_POOLS: Record<FlowKind, FlowTpl[]> = {
  lull: flowPool('flow.lull', [
    ['caster', () => '잠시 소강 상태입니다.'],
    ['caster', () => '양 팀 다 숨을 고르고 있습니다.'],
    ['caster', () => '중원에서 공방이 이어집니다.'],
    ['caster', () => '특별한 장면 없이 시간이 흐릅니다.'],
    ['caster', () => '경기가 다소 잠잠해졌습니다.'],
    ['analyst', () => '네, 이럴 때 한 번의 전환이 경기를 가릅니다.'],
    ['analyst', () => '탐색전이 길어지고 있습니다. 먼저 움직이는 쪽이 위험을 안죠.'],
  ]),
  dominant: flowPool('flow.dominant', [
    ['caster', t => `${josaIGa(t)} 계속 몰아붙입니다.`],
    ['caster', t => `${josaEunNeun(t)} 상대 진영에서만 경기를 하고 있습니다.`],
    ['analyst', () => '네, 이 흐름이면 한 골은 시간문제로 보입니다.'],
    ['analyst', t => `${josaEunNeun(t)} 숨 쉴 틈을 안 주고 있습니다.`],
  ]),
  endToEnd: flowPool('flow.endToEnd', [
    ['caster', () => '정신없이 오갑니다.'],
    ['caster', () => '완전히 난타전입니다.'],
    ['analyst', () => '이거 몇 골이 날지 모르겠는데요.'],
  ]),
  lowBlock: flowPool('flow.lowBlock', [
    ['caster', t => `${josaEunNeun(t)} 완전히 내려섰습니다.`],
    ['caster', () => '열 명이 다 자기 진영에 서 있습니다.'],
    ['analyst', t => `${josaEunNeun(t)} 잠그고 역습을 노리는 겁니다. 뚫기가 쉽지 않아요.`],
  ]),
  even: flowPool('flow.even', [
    ['caster', () => '중원 싸움이 팽팽합니다.'],
    ['caster', () => '양 팀 모두 쉽게 내주지 않습니다.'],
    ['analyst', () => '네, 한 번의 실수가 경기를 가를 분위기입니다.'],
  ]),
}

/**
 * 그 분에 낼 흐름 라인(없으면 null). **무사건 분에만** 나온다.
 *
 * 빈도 근거: 마지막 이벤트로부터 4분이 지나야 첫 라인이 나오고, 그 뒤로는 5분마다
 * 한 번만 더 나온다. 실경기 이벤트 밀도(90분에 25~40개)에서 4분 이상 가뭄은
 * 경기당 5~9회 정도이므로 대략 **10분에 한 번**꼴이다 — 침묵을 없애되 수다스럽지 않다.
 *
 * 무상태 결정론: 상태를 들고 다니지 않고 `minute - 마지막 이벤트 분`만 본다.
 * 덕분에 `commentateAll`처럼 접두 안정성이 자동으로 성립한다.
 */
export function flowLineAt(
  events: readonly MatchEvent[], minute: number, home: Team, away: Team, seed = 0,
): Line | null {
  if (minute < FLOW_MIN_MINUTE || minute > FLOW_MAX_MINUTE) return null
  let lastMinute = -1
  for (const e of events) {
    if (e.minute <= minute && e.minute > lastMinute) lastMinute = e.minute
  }
  if (lastMinute < 0) return null // 킥오프도 안 했다
  const gap = minute - lastMinute
  if (gap < LULL_GAP || (gap - LULL_GAP) % LULL_EVERY !== 0) return null

  const { kind, side } = flowStateAt(events, minute, home.id)
  const team = side === null ? '' : side === 'home' ? home.name.ko : away.name.ko
  const items = FLOW_POOLS[kind]
  const tpl = items[fnv1a(`${seed}|flow|${minute}|${kind}`) % items.length]
  const text = tpl.t(team)
  return {
    id: tpl.id,
    speaker: tpl.speaker,
    minute,
    text,
    speech: sanitizeSpeech(text),
    intensity: tpl.intensity,
    hasMinutePrefix: false,
  }
}

// ── 공개 API ────────────────────────────────────────────────

/**
 * 이벤트 배열 전체의 중계 라인을 만든다(이벤트와 1:1, 같은 순서).
 *
 * ★ 왜 배열 단위인가: `또`·`이번에도`·`연속`·역전골 판정·변형 억제 링버퍼는 모두
 *   직전 사건 기억을 요구한다. 히스토리 없이 한 이벤트만 보고는 구조적으로 만들 수 없다.
 *   접기(fold)로 상태를 누적하므로 **접두 안정성**이 있다 — `events.slice(0, k)`로 부른 결과의
 *   앞 k개는 전체로 부른 결과의 앞 k개와 항상 같다(재생 중 티커가 매 분 다시 계산해도 안전).
 *
 * @param seed 경기 시드. 같은 시드·같은 이벤트면 항상 같은 문장(결정론 계약).
 */
export function commentateAll(
  events: readonly MatchEvent[], home: Team, away: Team, seed = 0, ctx: CommentaryCtx = {},
): Line[] {
  const st: FoldState = {
    score: [0, 0],
    wasBehind: {},
    playerGoals: {},
    recentIds: [],
    prevHadFiller: false,
    prevFiller: '',
    chantsUsed: 0,
    recentAnIds: [],
    lastAnalystIndex: -ANALYST_GAP,
    usedNotes: new Set<number>(),
  }
  const notes = ctx.decisions ? readTacticalNotes(ctx.decisions) : []
  const managedTeamId = ctx.managedTeamId ?? home.id
  const out: Line[] = []
  const prior: MatchEvent[] = []
  for (let i = 0; i < events.length; i++) {
    out.push(step(events[i], i, prior, home, away, seed, st, notes, managedTeamId))
    prior.push(events[i])
  }
  return out
}

/**
 * 배열 중 한 이벤트의 라인. 앞선 이벤트들이 맥락(스코어·streak·억제 링버퍼)을 만든다.
 * 접두 안정성 덕분에 `commentateAll(events)[index]`와 항상 같다.
 */
export function commentateAt(
  events: readonly MatchEvent[], index: number, home: Team, away: Team, seed = 0, ctx: CommentaryCtx = {},
): Line {
  const lines = commentateAll(events.slice(0, index + 1), home, away, seed, ctx)
  return lines[lines.length - 1]
}

/**
 * 화면(티커)에 흘릴 **완성된 중계 타임라인** — 캐스터 라인 + 해설 라인 + 소강 구간 라인을
 * 시간순으로 펼친 배열. 이벤트와 1:1이 아니므로 인덱스 계약이 없다(그 계약은
 * `commentateAll`이 지킨다). 재생 중 매 분 다시 불러도 앞부분이 바뀌지 않는다.
 *
 * @param untilMinute 여기까지의 분을 훑으며 소강 라인을 채운다. 생략 시 마지막 이벤트 분.
 *   ★ 재생 중에는 표시 분을 넘겨야 한다 — 마지막 이벤트 이후의 정적이 곧 소강 구간이다.
 */
export function commentateTimeline(
  events: readonly MatchEvent[], home: Team, away: Team, seed = 0,
  ctx: CommentaryCtx = {}, untilMinute?: number,
): Line[] {
  const base = commentateAll(events, home, away, seed, ctx)
  const last = untilMinute ?? (events.length > 0 ? events[events.length - 1].minute : 0)
  const out: Line[] = []
  let i = 0

  /** 같은 분의 라인들을 티커에 흘릴 순서로. 주인공을 **맨 뒤**에 둔다(아래 주석). */
  const flush = (upTo: number) => {
    const from = i
    while (i < base.length && base[i].minute <= upTo) i++
    // 이벤트와 1:1이라는 commentateAll 계약을 이용해 라인↔이벤트를 인덱스로 짝짓는다.
    const all = Array.from({ length: i - from }, (_, k) => from + k)
    // 주인공 하나만 뒤로 보낸다. 전체 정렬을 하면 같은 타입이 둘일 때(예: miss 둘)
    // 3D가 그리는 **앞쪽** 이벤트가 아니라 뒤쪽이 마지막에 남아 다시 어긋난다
    // (pickDramaEvent는 동점에서 배열 앞쪽을 택한다).
    let bestK = -1
    let bestRank = Infinity
    for (const k of all) {
      const r = dramaRank(events[k]?.type ?? 'foul')
      if (r < bestRank) { bestRank = r; bestK = k }
    }
    const idx = bestK < 0 ? all : [...all.filter(k => k !== bestK), bestK]
    // ★ 왜 재정렬하는가: 엔진은 한 분에 여러 이벤트를 낸다(슛 → 세이브 → 코너).
    //   3D는 그중 **주인공 하나**(pickDramaEvent)를 그 분 내내 그리는데, 티커는 배열
    //   순서대로 흘려서 마지막에 남는 줄이 코너였다. 그래서 화면은 세이브를 보여주고
    //   글은 "코너에 공을 올립니다"를 말했다(seed 42 실측: 주인공 있는 43분 중 6분).
    //   로그의 내용은 그대로 두고 **눈이 닿는 마지막 줄만** 주인공으로 맞춘다.
    //   안정 정렬 — 순위가 같으면 원래 순서(발생 순)를 지킨다.
    for (const k of idx) {
      out.push(base[k])
      if (base[k].follow) out.push(base[k].follow!)
    }
  }

  for (let m = 0; m <= last; m++) {
    flush(m)
    const flow = flowLineAt(events, m, home, away, seed)
    if (flow) out.push(flow)
  }
  // 남은 라인(untilMinute보다 뒤의 이벤트)도 같은 규칙으로 흘린다.
  flush(Infinity)
  return out
}

/**
 * 단일 이벤트의 라인(맥락 없음). 히스토리를 모르는 호출부·테스트용 편의 함수다.
 * 실제 중계 경로는 `commentateAll`/`commentateAt`을 써야 streak·골 종류가 산다.
 */
export function commentate(e: MatchEvent, home: Team, away: Team, seed = 0): Line {
  return commentateAt([e], 0, home, away, seed)
}

// ── 입장 라인업 소개 (경기 이벤트가 아니다) ──────────────────
//
// ★ 왜 `commentateAll` 밖인가: 저 함수는 **이벤트와 1:1**이라는 계약을 갖는다
//   (접두 안정성 · `commentateAt` 일치 · playback의 eventIndex). 입장 소개는 이벤트가
//   하나도 없는 구간의 발화라 그 배열에 끼워 넣을 자리가 없다. 그래서 완전히 별도
//   경로로 두고, 공용 자산(조사·수사·sanitizeSpeech·Speaker)만 함께 쓴다.
//
// 화자 분담(§1.1)은 그대로다 — **캐스터가 명단을 읽고**, 해설위원은 다 읽은 뒤
// 한 줄 받는다. 해설이 먼저 말하는 일은 없다.
//
// 문장 구조는 사용자 지시를 그대로 따른다:
//   "골키퍼 김승규" / "네 명의 수비가 출전합니다. 김민재, 이한범, …, … 입니다."
// 즉 **포지션 그룹 단위로 묶어 말하되 개별 이름을 부른다.** 이름 하나가 곧 비트
// 하나이므로, 표시 계층은 비트 경계에서 도트·명단 행 하이라이트를 옮기면 된다.

/** 소개 묶음 — 포지션을 네 그룹으로 접는다. */
export type LineupGroupKey = 'GK' | 'DF' | 'MF' | 'FW'

const GROUP_OF: Record<Position, LineupGroupKey> = {
  GK: 'GK',
  CB: 'DF', LB: 'DF', RB: 'DF',
  DM: 'MF', CM: 'MF', AM: 'MF',
  LW: 'FW', RW: 'FW', ST: 'FW',
}

/** 포지션 → 소개 묶음. */
export function lineupGroupOf(position: Position): LineupGroupKey {
  return GROUP_OF[position] ?? 'MF'
}

/** 소개에 필요한 최소 선수 정보(엔진 타입에 묶이지 않는다 — 표시 계층이 만들어 넘긴다). */
export interface LineupMember {
  id: string
  number: number
  nameKo: string
  position: Position
}

/** 소개 비트 한 개 = 한 문장 = 한 번의 발화. */
export interface LineupBeat {
  /** 'open' 팀 도입 · 'group' 그룹 도입 · 'name' 개별 호명 · 'analyst' 해설 받는 말 */
  kind: 'open' | 'group' | 'name' | 'analyst'
  speaker: Speaker
  /** 화면 자막 문자열. */
  text: string
  /** TTS 문자열({@link sanitizeSpeech} 통과). */
  speech: string
  /** 이 비트에서 하이라이트할 선수 id. 없으면 null. */
  playerId: string | null
  group: LineupGroupKey | null
}

/** 그룹 도입 문장 — 사용자 예문("네 명의 수비가 출전합니다")을 기본형으로 삼는다. */
const GROUP_LEAD: Record<Exclude<LineupGroupKey, 'GK'>, (n: number) => string> = {
  DF: n => `${countKo(n)} 명의 수비가 출전합니다.`,
  MF: n => `중원에는 ${countKo(n)} 명이 섭니다.`,
  FW: n => `최전방은 ${countKo(n)} 명입니다.`,
}

/** 그룹 라벨(자막용 — 발화에는 위 문장이 쓰인다). */
const GROUP_LABEL: Record<LineupGroupKey, string> = {
  GK: '골키퍼', DF: '수비', MF: '미드필더', FW: '공격수',
}

/**
 * 해설위원이 명단을 다 들은 뒤 받는 말. 백라인 인원으로 갈리고, 같은 인원 안에서는
 * 팀·포메이션 해시로 변형을 고른다(결정론 — 매 경기 같은 문장이 반복되지 않게).
 * ★ 인과를 단정하지 않는다. 전부 형태 서술이다.
 */
const ANALYST_SHAPE: Record<number, readonly string[]> = {
  3: [
    '스리백으로 뒤를 두껍게 세웠습니다.',
    '백 스리, 좌우 윙백의 활동량이 관건입니다.',
    '스리백입니다. 중앙을 좁게 쓰겠다는 뜻이죠.',
  ],
  4: [
    '포백 라인이 균형을 잡습니다.',
    '기본에 충실한 포백, 간격 유지가 열쇠입니다.',
    '포백입니다. 좌우 풀백이 얼마나 올라오느냐를 보시죠.',
  ],
  5: [
    '파이브백, 일단 뒤를 잠그고 시작합니다.',
    '백 파이브로 폭을 넓게 지킵니다.',
    '다섯을 뒤에 세웠습니다. 역습을 노리는 배치죠.',
  ],
}
const ANALYST_FALLBACK = '익숙하지 않은 배치입니다. 첫 십 분을 보면 답이 나옵니다.'

/**
 * 한 팀의 입장 소개 비트 배열(결정론·순수).
 *
 * @param teamKo    팀 한국어 이름
 * @param formation 포메이션 id(`4-2-3-1` 등) — 도입 문장에서 자릿수로 읽는다
 * @param members   선발 XI. **정렬 순서가 곧 명단 순서**다(GK → 수비 → 중원 → 공격).
 */
export function lineupIntroBeats(
  teamKo: string, formation: string, members: readonly LineupMember[],
): LineupBeat[] {
  const out: LineupBeat[] = []
  if (members.length === 0) return out

  const push = (b: Omit<LineupBeat, 'speech'> & { speech?: string }): void => {
    out.push({ ...b, speech: sanitizeSpeech(b.speech ?? b.text) })
  }

  push({
    kind: 'open', speaker: 'caster', playerId: null, group: null,
    text: `${teamKo} 선발 라인업 · ${formation}`,
    speech: `${teamKo} 선발 라인업입니다. ${formationSpeechKo(formation)} 대형.`,
  })

  // 그룹은 members 순서를 지키며 접는다 — 명단 순서와 호명 순서가 어긋나면
  // 하이라이트가 명단 위를 되돌아가며 튄다.
  const order: LineupGroupKey[] = ['GK', 'DF', 'MF', 'FW']
  for (const key of order) {
    const group = members.filter(m => lineupGroupOf(m.position) === key)
    if (group.length === 0) continue
    if (key === 'GK') {
      // 사용자 예문 그대로 — 골키퍼는 그룹 도입 없이 이름과 한 문장이다.
      for (const m of group) {
        push({
          kind: 'name', speaker: 'caster', playerId: m.id, group: key,
          text: `골키퍼 ${m.nameKo}`, speech: `골키퍼, ${m.nameKo}.`,
        })
      }
      continue
    }
    push({
      kind: 'group', speaker: 'caster', playerId: null, group: key,
      text: `${GROUP_LABEL[key]} ${group.length}명`,
      speech: GROUP_LEAD[key](group.length),
    })
    group.forEach((m, i) => {
      const last = i === group.length - 1
      push({
        kind: 'name', speaker: 'caster', playerId: m.id, group: key,
        text: m.nameKo,
        // 마지막 이름에서 문장을 닫는다 — 쉼표로 끝나면 보이스가 다음 그룹 도입까지
        // 한 호흡으로 이어 읽어 그룹 경계가 사라진다.
        speech: last ? `${m.nameKo}입니다.` : `${m.nameKo},`,
      })
    })
  }

  const backline = members.filter(m => lineupGroupOf(m.position) === 'DF').length
  const pool = ANALYST_SHAPE[backline]
  // 변형 키에 인원 수까지 넣는다 — 두 팀이 같은 포메이션일 때 같은 문장이 연달아
  // 나오면(양 팀 소개는 바로 이어진다) 템플릿이라는 게 그대로 드러난다.
  const shape = pool
    ? pool[fnv1a(`entrance:${teamKo}:${formation}:${members.length}`) % pool.length]
    : ANALYST_FALLBACK
  push({ kind: 'analyst', speaker: 'analyst', playerId: null, group: null, text: shape })

  return out
}
