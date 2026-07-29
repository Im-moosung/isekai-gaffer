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
import type { MatchEvent, MatchEventType, Team } from '../engine/types'

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

/** 화자. 현재는 캐스터만 생성한다. 4단계(해설위원)가 'analyst'를 추가로 낼 자리다. */
export type Speaker = 'caster' | 'analyst'

/** 라인 강도 0~3. 3이 피크(골·퇴장). 향후 발화 우선순위·pitch 분기에 쓸 수 있다(§5.8). */
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

/** 한 이벤트의 라인을 만들고 fold 상태를 갱신한다. */
function step(e: MatchEvent, index: number, prior: MatchEvent[], home: Team, away: Team, seed: number, st: FoldState): Line {
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

  // 연호 — 골 피크에서만, 경기당 CHANT_CAP회 상한.
  // (문장이 이미 `{선수}!`로 끝나면 붙이지 않는다 — 이름이 세 번 반복되면 우스워진다)
  if (goalKind && st.chantsUsed < CHANT_CAP && player !== team
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
export function commentateAll(events: readonly MatchEvent[], home: Team, away: Team, seed = 0): Line[] {
  const st: FoldState = {
    score: [0, 0],
    wasBehind: {},
    playerGoals: {},
    recentIds: [],
    prevHadFiller: false,
    prevFiller: '',
    chantsUsed: 0,
  }
  const out: Line[] = []
  const prior: MatchEvent[] = []
  for (let i = 0; i < events.length; i++) {
    out.push(step(events[i], i, prior, home, away, seed, st))
    prior.push(events[i])
  }
  return out
}

/**
 * 배열 중 한 이벤트의 라인. 앞선 이벤트들이 맥락(스코어·streak·억제 링버퍼)을 만든다.
 * 접두 안정성 덕분에 `commentateAll(events)[index]`와 항상 같다.
 */
export function commentateAt(events: readonly MatchEvent[], index: number, home: Team, away: Team, seed = 0): Line {
  const lines = commentateAll(events.slice(0, index + 1), home, away, seed)
  return lines[lines.length - 1]
}

/**
 * 단일 이벤트의 라인(맥락 없음). 히스토리를 모르는 호출부·테스트용 편의 함수다.
 * 실제 중계 경로는 `commentateAll`/`commentateAt`을 써야 streak·골 종류가 산다.
 */
export function commentate(e: MatchEvent, home: Team, away: Team, seed = 0): Line {
  return commentateAt([e], 0, home, away, seed)
}
