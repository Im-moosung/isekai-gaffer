// src/game/pressconf.ts
// 기자회견 질문 · 신문 헤드라인 · 캠페인 에필로그 생성기 (템플릿 정본).
// 이 게임 서사 축의 심장 — AI 서술은 상위 레이어이며, 키 부재·실패 시 이 모듈이 100% 폴백한다.
// 순수 함수 · 결정론(Math.random/Date 금지, 해시로 변형 선택) · 사실 서술 · 비하 금지.
import type { MatchRecord, CampaignStage } from './campaignStore'
import type { DecisionEntry } from '../engine/types'
import { teamNameKo, type TeamId } from '../data/loader'

// ── 공개 타입 ──────────────────────────────────────────────
/** 기자 질문 1건. 답변은 3택 [공격적, 겸손, 유머] 톤 순서 고정. */
export interface PressQuestion { id: string; text: string; options: [string, string, string] }
/** 신문 1면 헤드라인 3요소. FICTION 워터마크 표기는 UI 몫. */
export interface Headline { title: string; sub: string; quote: string }

// ── 결정론 해시 (FNV-1a) ───────────────────────────────────
function hash(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
/** record 기반 안정 시드: 스코어 + 로그 길이 + stage. */
function recordSeed(r: MatchRecord): number {
  const so = r.shootout ? `${r.shootout[0]}:${r.shootout[1]}` : ''
  return hash(`${r.stage}|${r.score[0]}:${r.score[1]}|${so}|${r.opponentId}|${r.decisions.length}`)
}

// ── 상수 테이블 ────────────────────────────────────────────
/**
 * 캠페인 상대 한글 표기. 정본은 팀 JSON의 `name.ko` 하나뿐이다(src/data/loader.ts).
 * 예전에는 이 모듈이 자기 표를 복사해 들고 있었고 미등록 id는 코드값('rsa')을 그대로
 * 뱉었다 — 그 값이 화면·신문·**AI 헤드라인 프롬프트**까지 흘러갔다. 이제 로더가
 * 이름 없는 팀에 대해 던지므로 조용히 새어 나가는 경로가 없다.
 */
function oppName(id: TeamId): string { return teamNameKo(id) }

const STAGE_LABEL: Record<CampaignStage, string> = {
  group1: '조별리그 1차전', group2: '조별리그 2차전', group3: '조별리그 3차전',
  r32: '32강', r16: '16강', qf: '8강', sf: '4강', final: '결승', ended: '여정의 끝',
}

// 한국어 조사(받침) 처리 — 헤드라인 가독성용.
function hasBatchim(word: string): boolean {
  if (!word) return false
  const c = word.charCodeAt(word.length - 1)
  if (c < 0xac00 || c > 0xd7a3) return false // 한글 음절이 아니면 받침 없음으로 취급
  return (c - 0xac00) % 28 !== 0
}
function josa(word: string, withB: string, withoutB: string): string {
  return word + (hasBatchim(word) ? withB : withoutB)
}

// ── 경기 결과 분류 ─────────────────────────────────────────
type Outcome = 'bigwin' | 'win' | 'narrow' | 'shootoutWin' | 'draw' | 'loss'
function outcomeOf(r: MatchRecord): Outcome {
  const [kor, opp] = r.score
  if (kor === opp) {
    if (r.shootout) return r.shootout[0] > r.shootout[1] ? 'shootoutWin' : 'loss'
    return 'draw'
  }
  if (kor > opp) {
    const diff = kor - opp
    if (diff >= 3) return 'bigwin'
    if (diff === 1) return 'narrow'
    return 'win'
  }
  return 'loss'
}

// ═══════════════════════════════════════════════════════════
// buildQuestions
// ═══════════════════════════════════════════════════════════
// ── 답변 풀 — 결과 × 톤 ─────────────────────────────────────
// 왜 결과별로 가르는가(2026-08-02, 실플레이 결함):
//   예전 풀은 톤 3종 × 4문장이 전부였고, 셋을 **같은 인덱스**로 함께 뽑았다. 그래서
//   실제로 나올 수 있는 답변 세트가 네 가지뿐이었고, 무엇보다 **경기 결과를 몰랐다.**
//   2-5로 진 경기의 회견에 "이 정도는 예상했던 그림입니다."가 떴다 — 대패한 감독의 말이
//   아니고, 그 톤을 AI 헤드라인이 받아 "대승"으로 뒤집는 경로까지 열어 줬다.
//   질문은 이미 결과를 안다(resultQuestions가 승/무/패로 갈린다). 답변만 몰랐던 것이
//   결함의 자리였으므로, 답변도 outcomeOf가 판정한 결과 칸에서만 뽑는다.
//
// 문안 규약(전 칸 공통):
//   · 배열 순서 [aggressive, humble, humor]는 **계약**이다. answerTone이 이 풀로 톤을
//     역분류해 헤드라인 톤을 정하므로, 칸을 옮기면 헤드라인이 답변과 반대로 나간다.
//   · 공격적 톤은 **결과를 부정하지 않는다.** 진 날의 공격적 답변은 "우리가 이겼다"가
//     아니라 "결과는 받아들이되 방향은 바꾸지 않는다"다.
//   · 유머도 결과를 안다. 진 날의 유머는 자조여야 한다 — 대패 회견의 "발 뻗고 자겠습니다"는
//     조롱으로 읽힌다.
//   · 한 문장·존댓말·비하 금지. 라틴 문자와 숫자는 쓰지 않는다(§5.2 speech 규약: ko-KR
//     보이스가 철자로 읽고, 내부 수치는 사람이 하는 말이 아니다).
type ToneTrio = { aggressive: readonly string[]; humble: readonly string[]; humor: readonly string[] }

const OUTCOME_ANSWERS: Record<Outcome, ToneTrio> = {
  bigwin: {
    aggressive: [
      '우리 준비가 옳았습니다. 결과가 증명하죠.',
      '오늘 같은 경기력이면 누구와 붙어도 두렵지 않습니다.',
      '이 점수 차는 우연이 아니라 준비의 값입니다.',
      '다음 상대도 오늘 우리를 보고 계산이 복잡해졌을 겁니다.',
    ],
    humble: [
      '선수들이 모든 걸 쏟아부은 덕분입니다.',
      '점수 차만큼 쉬운 경기는 아니었습니다.',
      '오늘 잘 풀렸다고 다음도 그러리라 믿지는 않습니다.',
      '제 몫보다 선수들의 헌신이 컸습니다.',
    ],
    humor: [
      '오늘 밤은 발 뻗고 자겠습니다.',
      '후반에는 제가 할 일이 없어 물만 마셨습니다.',
      '해설진 목소리가 저보다 더 컸을 겁니다.',
      '이런 날은 벤치가 세상에서 제일 편한 자리입니다.',
    ],
  },
  win: {
    aggressive: [
      '준비한 대로 눌렀고, 그래서 이겼습니다.',
      '이 경기력을 유지하면 누구와 붙어도 두렵지 않습니다.',
      '운이 아니라 우리가 만들어 벌린 점수 차였습니다.',
      '다음 상대도 우리를 경계해야 할 겁니다.',
    ],
    humble: [
      '선수들이 모든 걸 쏟아부은 덕분입니다.',
      '팬들의 응원이 큰 힘이 됐습니다.',
      '이겼지만 보완해야 할 장면이 여럿 보였습니다.',
      '아직 갈 길이 멉니다. 겸손히 준비하겠습니다.',
    ],
    humor: [
      '커피를 몇 잔 마셨는지 세지도 못했네요.',
      '오늘은 넥타이를 풀고 저녁을 먹겠습니다.',
      '해설진 목소리가 저보다 더 컸을 겁니다.',
      '벤치에 앉았다 일어났다 하느라 다리가 다 저리네요.',
    ],
  },
  narrow: {
    aggressive: [
      '한 골 차라도 이긴 건 이긴 겁니다. 우리 방식이 통했습니다.',
      '버텨야 할 때 버텼습니다. 그게 우리 힘입니다.',
      '아슬아슬해 보여도 계산 안에 있던 경기였습니다.',
      '이런 경기를 이기는 팀이 결국 멀리 갑니다.',
    ],
    humble: [
      '선수들이 마지막까지 집중해 준 덕분입니다.',
      '한 골 차 승부는 언제든 뒤집힐 수 있었습니다.',
      '팬들의 응원이 큰 힘이 됐습니다.',
      '이긴 것에 안도하고, 내용은 다시 들여다보겠습니다.',
    ],
    humor: [
      '심장이 열 개라도 모자란 경기였네요.',
      '막판에는 시계만 열 번은 본 것 같습니다.',
      '커피를 몇 잔 마셨는지 세지도 못했네요.',
      '오늘 제 수명이 조금 줄어든 것 같습니다.',
    ],
  },
  shootoutWin: {
    aggressive: [
      '승부차기까지 갈 준비도 우리는 해 뒀습니다.',
      '키커 순서까지 준비한 대로였습니다. 우연이 아닙니다.',
      '이런 승부를 넘어 본 팀은 다음에도 넘습니다.',
      '끝까지 흔들리지 않은 쪽이 우리였습니다.',
    ],
    humble: [
      '골키퍼와 키커들이 감당해 준 결과입니다.',
      '승부차기는 누가 웃어도 이상하지 않은 자리였습니다.',
      '끝까지 맞선 상대에게도 박수를 보내고 싶습니다.',
      '선수들의 담대함에 제가 기댔습니다.',
    ],
    humor: [
      '심장이 열 개라도 모자란 경기였네요.',
      '승부차기 내내 저는 하늘만 보고 있었습니다.',
      '오늘 밤은 발 뻗고 자겠습니다.',
      '페널티 마크가 그렇게 멀어 보인 건 처음입니다.',
    ],
  },
  draw: {
    aggressive: [
      '승점을 나눴을 뿐, 우리 방향은 바꾸지 않습니다.',
      '내용에서 밀린 경기였다고는 보지 않습니다.',
      '오늘의 승점 하나가 나중에 값을 할 겁니다.',
      '같은 상대를 다시 만나면 결과는 다를 겁니다.',
    ],
    humble: [
      '아쉬운 결과지만 선수들은 최선을 다했습니다.',
      '마무리를 준비시키지 못한 건 제 몫이 부족했던 탓입니다.',
      '승점 하나도 소중히 받아들이겠습니다.',
      '팬들께는 이기는 경기를 보여 드리고 싶었습니다.',
    ],
    humor: [
      '오늘은 골대가 우리 편이 아니었던 것 같습니다.',
      '슛 하나만 더 들어갔으면 지금 웃고 있었을 텐데요.',
      '집에 가서 그 장면만 몇 번이고 돌려 볼 것 같습니다.',
      '오늘 밤은 잠이 조금 늦게 올 것 같습니다.',
    ],
  },
  loss: {
    // 공격적 톤이 결과를 부정하지 않게 — "우리가 이겼다"가 아니라 "방향은 안 바꾼다"다.
    aggressive: [
      '결과는 받아들이지만 방향을 바꿀 생각은 없습니다.',
      '오늘 진 것이 우리 축구가 틀렸다는 뜻은 아닙니다.',
      '고개를 숙이지는 않겠습니다. 다음 경기에서 답하겠습니다.',
      '오늘 일은 오늘로 끝내고 다음 준비에 들어가겠습니다.',
    ],
    humble: [
      '준비를 충분히 시키지 못한 제 책임입니다.',
      '선수들은 뛰었습니다. 부족했던 건 제 쪽입니다.',
      '기대하고 기다려 주신 팬들께 죄송할 뿐입니다.',
      '오늘은 상대가 우리보다 나았습니다. 인정하겠습니다.',
    ],
    // 진 날의 유머는 자조다 — 상대나 선수를 향하면 조롱이 된다.
    humor: [
      '오늘 밤은 잠이 쉽게 오지 않을 것 같습니다.',
      '제 머리가 하얗게 세는 소리를 들은 것 같습니다.',
      '집으로 가는 길이 오늘따라 유난히 멀겠네요.',
      '경기 영상을 몇 번이나 돌려 볼지 저도 모르겠습니다.',
    ],
  },
}

// ── 답변 풀 — 질문 종류 × 톤 ────────────────────────────────
// 왜 종류별로도 갈라야 했는가(2026-08-03, 배포본 지적):
//   질문은 **감독의 결정 로그**에서 나오는데(logQuestionText) 답변은 경기 결과만 보고 뽑혔다.
//   그래서 「63분에 손흥민을 빼고 황희찬을 투입하셨습니다. 계획된 승부수였습니까?」에
//   「커피를 몇 잔 마셨는지 세지도 못했네요.」가 붙었다 — 문답이 아니라 두 개의 독백이다.
//   결과 기반 질문(resultQuestions)만 결과 칸에서 뽑고, 로그 기반 질문은 **그 종류의 답변**을
//   쓴다.
//
// 문안 규약: 결과 칸과 동일([공격적, 겸손, 유머] 순서 계약 · 한 문장 · 존댓말 · 비하 금지 ·
//   라틴 문자와 숫자 금지). 하나 더 있다 —
//   · **결과를 단정하지 않는다.** 이 답변들은 승패와 무관하게 붙으므로, "그 교체로 이겼습니다"
//     같은 문장은 진 경기에서 거짓이 된다. 판단의 **의도**를 말하되 결과는 말하지 않는다.
type QKind = 'teamtalk' | 'shout' | 'sub' | 'instructions' | 'shootout'

const KIND_ANSWERS: Record<QKind, ToneTrio> = {
  // 하프타임 라커룸 이야기 — "그 말이 후반의 흐름을 만들었다고 보십니까?"
  teamtalk: {
    aggressive: [
      '라커룸에서 할 말은 해야 후반이 달라집니다.',
      '그 순간 필요한 말이었고, 저는 망설이지 않습니다.',
      '하프타임은 감독이 쓰라고 주어진 시간입니다.',
      '후반에 나온 장면들이 그 말의 답이라고 봅니다.',
    ],
    humble: [
      '제 말보다 선수들이 스스로 다잡은 덕이 큽니다.',
      '라커룸에서 오간 이야기는 선수들 몫으로 남겨 두겠습니다.',
      '방향만 짚어 줬을 뿐, 뛴 것은 선수들입니다.',
      '후반의 흐름을 제 말 덕이라고 하기는 어렵습니다.',
    ],
    humor: [
      '라커룸 벽이 제 목소리를 다 기억하고 있을 겁니다.',
      '그 짧은 사이에 제 목이 다 쉬어 버렸습니다.',
      '무슨 말을 했는지는 선수들에게 물어봐 주십시오.',
      '하프타임에는 제가 제일 바쁜 사람이 됩니다.',
    ],
  },
  // 터치라인 외침 — "그 한마디가 꼭 필요한 순간이었습니까?"
  shout: {
    aggressive: [
      '그 자리에서 바로 잡지 않으면 늦습니다.',
      '터치라인에서 소리치는 것도 제 일입니다.',
      '흐름이 넘어가려는 순간이 보여서 외쳤습니다.',
      '경기 중에 해야 할 말을 아끼지는 않습니다.',
    ],
    humble: [
      '선수들이 제 목소리를 들어준 것이 고마울 뿐입니다.',
      '멀리서 거들 수 있는 건 그 한마디뿐이었습니다.',
      '소리쳐 봐야 그 안의 판단은 결국 선수들 몫입니다.',
      '제 외침이 닿았다면 그것으로 다행입니다.',
    ],
    humor: [
      '관중석까지 들렸다면 사과드리겠습니다.',
      '제 목소리가 함성을 이길 수는 없더군요.',
      '팔을 하도 휘저어서 어깨가 다 뻐근합니다.',
      '중계 마이크에 덜 담겼기를 바랄 뿐입니다.',
    ],
  },
  // 교체 — "계획된 승부수였습니까?"
  sub: {
    aggressive: [
      '그 자리에서 속도를 올려야 한다고 봤습니다.',
      '준비해 둔 카드였고, 쓸 때가 왔을 뿐입니다.',
      '기다리다 늦느니 먼저 움직이는 쪽을 택합니다.',
      '교체로 승부를 걸어야 하는 시간이었습니다.',
    ],
    humble: [
      '나간 선수도 들어간 선수도 제 몫을 해 줬습니다.',
      '다리가 무거워지는 것이 보여 내린 결정입니다.',
      '벤치에서 기다린 선수를 믿어 본 선택입니다.',
      '교체가 통했다면 그건 뛴 선수들 덕입니다.',
    ],
    humor: [
      '벤치에 좋은 선수가 많으면 감독은 고민이 깊어집니다.',
      '누구를 뺄지 정하는 일이 제일 어렵습니다.',
      '대기심에게 번호판을 몇 번이나 부탁했는지 모르겠습니다.',
      '교체 카드를 더 주신다면 다 쓸 것 같습니다.',
    ],
  },
  // 지시 변경 — "어떤 의도였는지 설명해 주시겠습니까?"
  instructions: {
    aggressive: [
      '상대가 우리를 읽기 전에 먼저 바꿔야 합니다.',
      '그대로 두면 끌려간다고 판단했습니다.',
      '경기 중에 손대는 것을 두려워하지 않습니다.',
      '노린 자리가 있었고, 거기를 열려고 바꿨습니다.',
    ],
    humble: [
      '준비한 것이 통하지 않아 다시 맞춰 본 것뿐입니다.',
      '판단은 제가 했고 실행은 선수들이 해냈습니다.',
      '더 나은 방법을 찾아보려 한 시도였습니다.',
      '경기 중에 본 것을 그대로 반영했을 뿐입니다.',
    ],
    humor: [
      '작전판에 그린 그림이 오늘따라 많았습니다.',
      '가만히 앉아 있질 못해 자꾸 무언가를 바꾸게 됩니다.',
      '선수들이 제 손짓을 알아봐 준 것만도 다행입니다.',
      '끝나고 보니 제 수첩이 새까맣게 되어 있더군요.',
    ],
  },
  // 승부차기 키커 순서 — "선정 기준은 무엇이었습니까?"
  shootout: {
    aggressive: [
      '서겠다고 먼저 손든 선수를 앞에 세웠습니다.',
      '순서까지 미리 정해 두고 들어간 경기였습니다.',
      '피하려는 선수가 없어 순서를 짜기 어렵지 않았습니다.',
      '중요한 순번일수록 담대한 선수에게 맡겼습니다.',
    ],
    humble: [
      '그 자리에 서는 용기는 결국 선수들의 것입니다.',
      '훈련장에서 보여 준 모습을 그대로 믿었습니다.',
      '누가 서든 쉽지 않은 자리라 조심스러웠습니다.',
      '제 기준보다 선수들의 뜻을 먼저 물었습니다.',
    ],
    humor: [
      '제 심장이 먼저 순서를 정하려 들더군요.',
      '그 순간만큼은 저도 눈을 감고 싶었습니다.',
      '순서를 적은 종이가 손에서 다 젖어 있었습니다.',
      '이 일은 몇 번을 겪어도 익숙해지지가 않습니다.',
    ],
  },
}

/** 톤별 전체 문안(결과 칸·종류 칸을 가로질러 합친 것). 헤드라인 역분류·UI 프리뷰용 계약 형태 유지.
 *  ★ 새 문안을 여기에 등록하지 않으면 answerTone이 해시 폴백으로 떨어져 헤드라인 톤이 답변과
 *    어긋난다 — 결과 칸과 종류 칸 **둘 다** 합쳐야 하는 이유다. */
export const ANSWER_POOLS: ToneTrio = {
  aggressive: [...Object.values(OUTCOME_ANSWERS), ...Object.values(KIND_ANSWERS)].flatMap(t => t.aggressive),
  humble: [...Object.values(OUTCOME_ANSWERS), ...Object.values(KIND_ANSWERS)].flatMap(t => t.humble),
  humor: [...Object.values(OUTCOME_ANSWERS), ...Object.values(KIND_ANSWERS)].flatMap(t => t.humor),
}
// 역분류는 매 답변마다 도는 경로라 Set으로 굳혀 둔다(문안 중복은 테스트가 막는다).
const TONE_SETS: readonly Set<string>[] = [
  new Set(ANSWER_POOLS.aggressive), new Set(ANSWER_POOLS.humble), new Set(ANSWER_POOLS.humor),
]

/** 결과 칸에서 [공격적, 겸손, 유머] 한 세트를 뽑는다.
 *  톤마다 pick의 **다른 비트**를 읽는 이유: 셋을 같은 인덱스로 묶으면 조합 수가 풀 길이(넷)로
 *  주저앉는다 — 그게 예전 결함의 절반이었다. 비트만 나눠 써도 결정론은 그대로다. */
function pickTrio(pick: number, p: ToneTrio): [string, string, string] {
  return [
    p.aggressive[pick % p.aggressive.length],
    p.humble[(pick >>> 3) % p.humble.length],
    p.humor[(pick >>> 6) % p.humor.length],
  ]
}
function optionsFor(pick: number, outcome: Outcome): [string, string, string] {
  return pickTrio(pick, OUTCOME_ANSWERS[outcome])
}
/** 로그 기반 질문의 답변 — 결과가 아니라 **질문 종류**의 칸에서 뽑는다. */
function optionsForKind(pick: number, kind: QKind): [string, string, string] {
  return pickTrio(pick, KIND_ANSWERS[kind])
}

// ── 기자의 입 — 내부 로그를 사람의 말로 옮긴다 ──────────────────
// `DecisionEntry.summary`는 **감독 노트의 문법**이다: "HT 팀토크: 격려",
// "63' 교체: 황희찬 IN, 손흥민 OUT", "47' 지시 변경: 압박 62→47".
// 예전에는 이 문자열을 따옴표로 감싸 질문에 그대로 박았고, 그래서 기자가
// 「"HT 팀토크: 격려"라는 선택이…」라고 말했다(감사 결함 ⑦). 기자는 우리 로그를 읽지 않는다 —
// 경기를 보고 말한다. 아래에서 구조화 필드(detail)와 요약 파싱으로 사람의 문장을 만들고,
// **해석에 실패하면 질문을 만들지 않는다**(null). 로그 원문을 노출하느니 결과 기반 질문으로
// 채우는 편이 낫고, resultQuestions가 3문항을 보장하므로 빈자리는 생기지 않는다.

/** 로그 요약 접두사("킥오프 전" / "HT" / "63'") → 기자가 쓰는 시점 표현. */
function whenPhrase(summary: string): string {
  if (summary.startsWith('킥오프 전')) return '킥오프 전에'
  if (summary.startsWith('HT')) return '하프타임에'
  const m = /^(\d+)'/.exec(summary)
  return m ? `${m[1]}분에` : '경기 중'
}

/** 하프타임 팀토크 톤 → 기자가 전해 들은 장면. */
const TONE_SCENE: Record<string, string> = {
  rage: '선수들을 강하게 몰아세우셨다고 합니다',
  encourage: '선수들을 북돋우셨다고 합니다',
  calm: '선수들을 진정시키셨다고 합니다',
  trust: '선수들에게 믿음을 보이셨다고 합니다',
}
/** 터치라인 외침 → 관중석에서도 보이던 장면. */
const SHOUT_SCENE: Record<string, string> = {
  urge: '더 밀어붙이라고 외치셨습니다',
  work: '더 뛰라고 다그치셨습니다',
  calm: '침착하라고 손짓하셨습니다',
  praise: '잘하고 있다고 소리치셨습니다',
}

/** 요약에 박힌 한국어 라벨 → 톤 키(detail이 없는 옛 로그용 역인덱스).
 *  matchStore의 TONE_LABEL·SHOUT_LABEL과 짝이다 — 그쪽을 바꾸면 여기도 바꿔야 한다.
 *  (matchStore를 import하면 UI 스토어가 순수 템플릿 모듈로 딸려 들어와 계층이 뒤집힌다.) */
const TONE_BY_LABEL: Record<string, string> = {
  격노: 'rage', 격려: 'encourage', 침착: 'calm', 신뢰: 'trust',
}
const SHOUT_BY_LABEL: Record<string, string> = {
  독려: 'urge', '더 뛰어': 'work', 침착: 'calm', 칭찬: 'praise',
}

// ── 전술 변경 로그 → 기자의 문장 ────────────────────────────
// `tacticsDiff`가 만드는 조각은 **작전판의 문법**이다: "압박 55→90", "멘탈리티 균형→공격적",
// "공격 적극성 기본→적극", "박스 인원 표준→많이". 기자는 이렇게 말하지 않는다.
//   ① 0~100 슬라이더 값은 우리 내부 수치다. 실제 기자는 "압박을 62에서 47까지"라고 세지 않고
//      "압박을 늦췄다"고 말한다. 숫자를 지우면 TTS 오독 위험도 함께 사라진다.
//   ② '멘탈리티'·'적극성'·'박스 인원'은 구현 용어다. 관중이 본 장면의 낱말로 옮긴다.
//   ③ 예전 파서는 `(.+?)\s(.+?)→(.+)` 하나로 축 이름을 잘라, 두 낱말짜리 축을 통째로 망가뜨렸다
//      ("공격 적극성 기본→적극" → 「공격을 적극성 기본에서 적극으로 바꾸셨습니다」). 그래서
//      **아는 축 이름의 표**로 자른다. 모르는 축은 null — 원문을 흘리느니 질문을 만들지 않는다.

/** 수치 축(0~100) → [올렸을 때, 내렸을 때]. 값 자체는 절대 문장에 넣지 않는다. */
const NUMERIC_AXIS: Record<string, [string, string]> = {
  '라인': ['수비 라인을 끌어올리', '수비 라인을 끌어내리'],
  '압박': ['압박을 한층 끌어올리', '압박을 늦추'],
  '템포': ['경기 템포를 끌어올리', '템포를 늦추'],
}

/** 공격 방향(attackFocus) 값 → 장면. 옛 로그의 '좌측/우측' 표기도 함께 받는다. */
const FOCUS_SCENE: Record<string, string> = {
  '좌': '공격을 왼쪽으로 몰아가', '좌측': '공격을 왼쪽으로 몰아가',
  '우': '공격을 오른쪽으로 몰아가', '우측': '공격을 오른쪽으로 몰아가',
  '중앙': '공격을 가운데로 모으', '균형': '공격을 양쪽으로 고르게 펴',
}
const MENTALITY_ORDER = ['매우 수비적', '수비적', '균형', '공격적', '매우 공격적']
const INTENSITY_ORDER = ['자제', '기본', '적극']
const GROUP_WORD: Record<string, string> = { '공격': '최전방', '미드필드': '중원', '수비': '수비진' }
const PATTERN_SCENE: Record<string, string> = {
  '크로스': '공격을 측면 크로스 위주로 돌리',
  '중앙 침투': '공격을 중앙 침투 쪽으로 돌리',
  '중거리': '공격을 중거리 슛 위주로 돌리',
  '균형': '공격 방식을 다시 고르게 가져가',
}
const CORNER_SCENE: Record<string, string> = {
  '니어': '코너킥을 니어포스트로 올리', '파': '코너킥을 먼 쪽으로 올리', '짧게': '코너킥을 짧게 가져가',
}
const BOXLOAD_SCENE: Record<string, string> = {
  '많이': '코너에서 문전에 사람을 더 채우',
  '적게': '코너에서 문전 인원을 줄이',
  '표준': '코너에서 문전 인원을 원래대로 되돌리',
}
const MARKING_SCENE: Record<string, string> = {
  '맨투맨': '수비를 대인 방어로 돌리', '존': '수비를 지역 방어로 돌리',
}

/** 서열 축의 방향(뒤 값이 앞 값보다 위인가). 표 밖의 값이면 null. */
function rankUp(order: string[], before: string, after: string): boolean | null {
  const b = order.indexOf(before), a = order.indexOf(after)
  if (b < 0 || a < 0 || a === b) return null
  return a > b
}

/** 범주·서열 축 → 장면. 키는 tacticsDiff가 쓰는 축 이름 그대로(긴 것부터 매칭한다). */
const AXIS_SCENE: Record<string, (before: string, after: string) => string | null> = {
  '멘탈리티': (b, a) => {
    const up = rankUp(MENTALITY_ORDER, b, a)
    return up === null ? null : up ? '팀을 더 공격적으로 돌리' : '팀을 더 단단하게 잠그'
  },
  '공격 적극성': (b, a) => intensityScene('공격', b, a),
  '미드필드 적극성': (b, a) => intensityScene('미드필드', b, a),
  '수비 적극성': (b, a) => intensityScene('수비', b, a),
  '공격 패턴': (_b, a) => PATTERN_SCENE[a] ?? null,
  '코너 루트': (_b, a) => CORNER_SCENE[a] ?? null,
  '박스 인원': (_b, a) => BOXLOAD_SCENE[a] ?? null,
  '수비 마킹': (_b, a) => MARKING_SCENE[a] ?? null,
  '공격': (_b, a) => FOCUS_SCENE[a] ?? null,
  '포메이션': (b, a) => `진형을 ${b}에서 ${a}로 바꾸`,
}
function intensityScene(line: string, before: string, after: string): string | null {
  const up = rankUp(INTENSITY_ORDER, before, after)
  const w = GROUP_WORD[line]
  if (up === null || !w) return null
  // 주어가 감독이므로 "최전방을 움직이셨습니다"가 아니라 "…에 주문하셨습니다"로 쓴다.
  return up ? `${w}에 더 적극적으로 나서라고 주문하` : `${w}에 힘을 아끼라고 주문하`
}

/** 긴 축 이름부터 — '공격 적극성'이 '공격'에 먼저 먹히면 안 된다. */
const AXIS_NAMES = [...Object.keys(NUMERIC_AXIS), ...Object.keys(AXIS_SCENE)]
  .sort((a, b) => b.length - a.length)

/** 전술 변경 조각 1개 → 기자의 절("…끌어올리"). 해석 불가면 null. */
function axisClause(piece: string): string | null {
  const t = piece.trim()
  // GK 파워플레이는 화살표가 없는 on/off 스위치다. 관중석에서 가장 잘 보이는 장면이라 살린다.
  if (t.startsWith('GK 파워플레이')) {
    if (t.endsWith('ON')) return '골키퍼까지 상대 진영으로 올려보내'
    if (t.endsWith('OFF')) return '골키퍼를 다시 골문으로 돌려보내'
    return null
  }
  const arrow = t.indexOf('→')
  if (arrow < 0) return null
  const left = t.slice(0, arrow).trim(), after = t.slice(arrow + 1).trim()
  const axis = AXIS_NAMES.find(n => left === n || left.startsWith(`${n} `))
  if (!axis) return null
  const before = left.slice(axis.length).trim()
  if (!before || !after) return null

  const numeric = NUMERIC_AXIS[axis]
  if (numeric) {
    const nb = Number(before), na = Number(after)
    if (!Number.isFinite(nb) || !Number.isFinite(na) || nb === na) return null
    return na > nb ? numeric[0] : numeric[1]
  }
  return AXIS_SCENE[axis](before, after)
}

/** 결정 로그 1건 → 기자 질문(+ 답변을 고를 종류). 해석할 수 없으면 null(질문을 만들지 않는다).
 *  종류를 함께 돌려주는 이유: 답변이 질문에 실제로 대답해야 하기 때문이다. 예전에는 텍스트만
 *  돌려주고 답변을 경기 결과로만 골라, 교체 질문에 커피 이야기가 붙었다. */
function logQuestionText(e: DecisionEntry): { text: string; kind: QKind } | null {
  const when = whenPhrase(e.summary)
  switch (e.kind) {
    case 'teamtalk': {
      // detail이 정본이고, 그 필드가 없던 시절의 로그는 요약의 한국어 라벨로 되짚는다.
      const tone = (typeof e.detail?.tone === 'string' ? TONE_SCENE[e.detail.tone] : undefined)
        ?? TONE_SCENE[TONE_BY_LABEL[/팀토크: (.+)$/.exec(e.summary)?.[1] ?? ''] ?? '']
      if (tone) {
        return {
          kind: 'teamtalk',
          text: `하프타임 라커룸 이야기가 나옵니다. ${tone} — 그 말이 후반의 흐름을 만들었다고 보십니까?`,
        }
      }
      const shout = (typeof e.detail?.shout === 'string' ? SHOUT_SCENE[e.detail.shout] : undefined)
        ?? SHOUT_SCENE[SHOUT_BY_LABEL[/외침: (.+)$/.exec(e.summary)?.[1] ?? ''] ?? '']
      // 라커룸 이야기와 터치라인 외침은 같은 로그 종류지만 **다른 질문**이다 — 답변 칸도 가른다.
      if (shout) {
        return { kind: 'shout', text: `${when} 터치라인에서 ${shout}. 그 한마디가 꼭 필요한 순간이었습니까?` }
      }
      return null
    }
    case 'sub': {
      const m = /교체: (.+) IN, (.+) OUT$/.exec(e.summary)
      if (!m) return null
      const [, inName, outName] = m
      return {
        kind: 'sub',
        text: `${when} ${josa(outName, '을', '를')} 빼고 ${josa(inName, '을', '를')} 투입하셨습니다. 계획된 승부수였습니까?`,
      }
    }
    case 'instructions': {
      // 포메이션 변경은 before/after가 구조화돼 있다.
      const before = e.detail?.before, after = e.detail?.after
      if (typeof before === 'string' && typeof after === 'string') {
        return {
          kind: 'instructions',
          text: `${when} 진형을 ${before}에서 ${after}로 바꾸셨습니다. 무엇을 노리신 변화였습니까?`,
        }
      }
      // detail.changed가 정본이지만, 그 필드가 없던 시절의 로그(저장된 캠페인)도 읽을 수 있게
      // 요약 문자열에서 같은 조각을 뽑는 폴백을 둔다.
      const changed = Array.isArray(e.detail?.changed)
        ? (e.detail.changed as unknown[])
        : (/지시 변경: (.+)$/.exec(e.summary)?.[1].split(', ') ?? [])
      const clauses = changed
        .filter((c): c is string => typeof c === 'string')
        .map(axisClause)
        .filter((c): c is string => c !== null)
      if (clauses.length === 0) return null
      // 축이 여러 개면 마지막만 종결하고 앞은 '고,'로 잇는다("…올리고, 템포를 …올리셨습니다").
      const joined = clauses.length === 1
        ? clauses[0]
        : `${clauses.slice(0, -1).join('고, ')}고, ${clauses[clauses.length - 1]}`
      return { kind: 'instructions', text: `${when} ${joined}셨습니다. 어떤 의도였는지 설명해 주시겠습니까?` }
    }
    case 'shootout-setup':
      // 이 로그는 자유 문자열이라 파싱할 구조가 없다. 사실만 말하고 요약은 인용하지 않는다.
      return {
        kind: 'shootout',
        text: '승부차기를 앞두고 키커 순서를 직접 정하셨습니다. 선정 기준은 무엇이었습니까?',
      }
  }
}

// 결과 기반 질문(로그 부족분 채움). 중립 추궁.
function resultQuestions(r: MatchRecord): string[] {
  const opp = oppName(r.opponentId)
  const out = outcomeOf(r)
  const qs: string[] = []
  switch (out) {
    case 'bigwin':
      qs.push(`${josa(opp, '을', '를')} 상대로 큰 점수 차 승리였습니다. 이런 결과를 예상하셨습니까?`)
      break
    case 'narrow':
      qs.push(`한 골 차 승부 끝에 웃으셨습니다. 후반 집중력의 비결이 있었습니까?`)
      break
    case 'win':
      qs.push(`${josa(opp, '을', '를')} 넘어 승리를 거두셨습니다. 오늘 가장 큰 원동력은 무엇이었습니까?`)
      break
    case 'shootoutWin':
      qs.push(`승부차기까지 가는 접전이었습니다. 그 긴장을 어떻게 견디셨습니까?`)
      break
    case 'draw':
      qs.push(`${josa(opp, '과', '와')} 무승부로 마쳤습니다. 아쉬움이 남는 결과라는 평가에 동의하십니까?`)
      break
    case 'loss':
      qs.push(`아쉬운 결과였습니다. 어느 지점에서 승부가 갈렸다고 보십니까?`)
      break
  }
  if (r.score[0] === 0) {
    qs.push('공격이 좀처럼 풀리지 않았습니다. 무엇이 부족했다고 보십니까?')
  }
  // 항상 사용 가능한 일반 질문(3문항 보장의 마지막 안전망).
  qs.push('오늘 경기, 전체적으로 어떻게 평가하십니까?')
  qs.push('팬들에게 한 말씀 부탁드립니다.')
  qs.push('다음을 향한 각오를 말씀해 주시겠습니까?')
  return qs
}

/** 킥오프 계획에서 얼마나 멀어졌는가(변경된 전술 항목 수) — 이 이상이면 "계획을 버렸다"로 본다.
 *  구조(대형·태세) + 지시 두 가지 이상을 갈아엎어야 도달하는 값이다.
 *  ★ 이 수치는 **판정에만 쓰고 문장에는 넣지 않는다.** 기자는 감독이 몇 가지를 바꿨는지 세지
 *    않는다 — 전반과 후반의 팀이 달라 보였다고 말할 뿐이다. */
const PIVOT_DEVIATION = 4

/** 플랜 추궁 3분기. 답변은 공용 풀 대신 전용 문안을 쓴다 — "계획을 지켰다/버렸다"는
 *  구체적 추궁에 "커피를 몇 잔 마셨는지…" 같은 일반 답변이 붙으면 문답이 어긋난다.
 *  튜플 순서는 공용 계약과 동일하게 [공격적, 겸손, 유머] 고정. */
type PlanBranch = 'kept' | 'pivot-win' | 'pivot-loss'
const PLAN_ANSWERS: Record<PlanBranch, [string, string, string]> = {
  kept: [
    '흔들 이유가 없었습니다. 준비한 대로 눌렀을 뿐입니다.',
    '선수들이 계획을 끝까지 믿고 뛰어준 덕분입니다.',
    '벤치에서 할 일이 없어 90분 내내 서 있기만 했습니다.',
  ],
  'pivot-win': [
    '틀린 게 아니라 상대가 우리 계획을 읽었을 뿐입니다. 그래서 다시 바꿨습니다.',
    '계획을 고집하지 않은 건 제 판단이었고, 실행은 선수들이 해냈습니다.',
    '전반 계획은 라커룸에 두고 나왔습니다. 나중에 찾으러 가야겠네요.',
  ],
  'pivot-loss': [
    '바꾸지 않았다면 더 나빴을 겁니다. 결정은 후회하지 않습니다.',
    '판을 흔든 건 접니다. 결과의 책임도 제게 있습니다.',
    '오늘은 제가 화이트보드를 너무 많이 지웠던 것 같습니다.',
  ],
}

/** 계획을 지켰나 / 갈아엎었나 × 결과로 갈리는 추궁 질문. 성립하지 않으면 null.
 *  질문 문안은 중립 추궁("~습니까?") 톤을 유지한다 — 비하·단정 금지 계약.
 *
 *  ★ 문장에 수치를 넣지 않는 이유(2026-08-01, 사용자 지적): 예전 문안은 「N개 축을 바꾸셨는데」
 *    였다. '축'은 전술 슬라이더를 부르는 **우리 구현 용어**이고, 기자가 바뀐 항목을 세어 오는
 *    일도 없다. 화면의 플랜 배지가 사라져도 이 질문이 혼자 성립해야 하므로, 관중이 본 것
 *    ("전반과 후반의 팀이 달랐다")만으로 문장을 세운다. */
function planQuestion(planDeviation: number, won: boolean): { text: string; branch: PlanBranch } | null {
  if (planDeviation === 0 && won) {
    return { branch: 'kept', text: '경기 내내 처음 준비한 대로 밀고 가셨습니다. 한 번쯤 바꿔 볼 생각은 없으셨습니까?' }
  }
  if (planDeviation >= PIVOT_DEVIATION && won) {
    return { branch: 'pivot-win', text: '전반과 후반이 완전히 다른 팀이었습니다. 경기 중에 손을 많이 대셨는데, 처음 준비가 틀렸던 겁니까?' }
  }
  if (planDeviation >= PIVOT_DEVIATION && !won) {
    return { branch: 'pivot-loss', text: '경기 도중에 팀을 크게 흔드셨습니다. 준비한 것을 접은 판단이 결과로 이어졌다고 보십니까?' }
  }
  return null
}

/**
 * 기자 질문 3문항 생성.
 * 1) 계획 추궁이 성립하면 최우선(감독의 사전 설계를 경기 후에 회수하는 장치다.
 *    로그 질문이 항상 3개를 채우므로, 뒤에 붙이면 영영 노출되지 않는다)
 * 2) 결정 로그 기반 질문(teamtalk→sub→instructions→shootout-setup 순, summary 활용)
 * 3) 부족분은 결과 기반 질문으로 채움
 * 4) 결정론: 같은 (record, log, planDeviation) → 같은 질문
 *
 * planDeviation 미지정은 "플랜 정보 없음"이며 추궁 질문을 만들지 않는다.
 * 0을 기본값으로 두면 플랜을 세운 적 없는 호출부(데모·테스트)까지 "계획대로 됐습니다"를
 * 듣게 되므로, 있음/없음을 값으로 구분한다.
 */
export function buildQuestions(record: MatchRecord, log: DecisionEntry[], planDeviation?: number): PressQuestion[] {
  const seed = recordSeed(record)
  const outcome = outcomeOf(record)
  // 로그 우선순위 정렬(안정): kind 우선순위 → 원래 등장 순서.
  const KIND_ORDER: Record<DecisionEntry['kind'], number> = {
    teamtalk: 0, sub: 1, instructions: 2, 'shootout-setup': 3,
  }
  const ordered = log
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind] || a.idx - b.idx)

  // 답변의 출처는 세 갈래다:
  //   options 고정(플랜 추궁 전용 문안) → kind(로그 기반 질문, 종류 칸) → 없음(결과 칸).
  const items: { text: string; options?: [string, string, string]; kind?: QKind }[] = []
  const seen = new Set<string>()
  const push = (text: string, from?: { options?: [string, string, string]; kind?: QKind }) => {
    if (seen.has(text)) return
    seen.add(text)
    items.push({ text, ...from })
  }

  if (planDeviation !== undefined) {
    const pq = planQuestion(planDeviation, outcome !== 'draw' && outcome !== 'loss')
    if (pq) push(pq.text, { options: PLAN_ANSWERS[pq.branch] })
  }
  for (const { e } of ordered) {
    const q = logQuestionText(e)
    if (q) push(q.text, { kind: q.kind })
  }
  for (const t of resultQuestions(record)) push(t)

  return items.slice(0, 3).map((q, i) => {
    const pick = seed + i * 2654435761
    return {
      id: `pq${i + 1}`,
      text: q.text,
      options: q.options ?? (q.kind ? optionsForKind(pick, q.kind) : optionsFor(pick, outcome)),
    }
  })
}

// ═══════════════════════════════════════════════════════════
// buildHeadline
// ═══════════════════════════════════════════════════════════
/** 답변 텍스트의 톤을 역분류(0=공격적/1=겸손/2=유머). 풀 밖이면 해시 폴백.
 *  결과별로 갈린 풀도 톤 축으로 합쳐 두었으므로(TONE_SETS) 어느 결과의 문안이든 여기서 잡힌다.
 *  플랜 추궁의 전용 답변도 같은 [공격적, 겸손, 유머] 순서로 놓여 있으므로 인덱스로 분류한다
 *  — 등록하지 않으면 해시 폴백으로 떨어져 헤드라인 톤이 답변과 어긋난다. */
function answerTone(text: string): 0 | 1 | 2 {
  for (let i = 0; i < TONE_SETS.length; i++) if (TONE_SETS[i].has(text)) return i as 0 | 1 | 2
  for (const trio of Object.values(PLAN_ANSWERS)) {
    const i = trio.indexOf(text)
    if (i >= 0) return i as 0 | 1 | 2
  }
  return (hash(text) % 3) as 0 | 1 | 2
}

// 결과 × 톤 헤드라인 제목 템플릿. 톤과 해시로 변형 선택 → 결정론.
function titleTemplates(out: Outcome, team: string, opp: string): string[] {
  switch (out) {
    case 'bigwin':
      return [
        `${team}, ${josa(opp, '을', '를')} 완파하다`,
        `${team}, ${opp} 상대 완승`,
        `${josa(opp, '을', '를')} 무너뜨린 ${team}`,
      ]
    case 'narrow':
      return [
        `${team}, ${josa(opp, '을', '를')} 힘겹게 넘다`,
        // '제압'은 완승의 어휘라 진땀승과 충돌한다(실캡처: "진땀승... 대한민국, 체코 제압").
        // narrow는 한 골 차 신승이므로 버티고 지켜낸 쪽 어휘를 쓴다.
        `진땀승... ${team}, ${opp} 상대 리드 지켜내다`,
        `${team}, ${opp} 상대 한 골 차 승부 웃다`,
      ]
    case 'win':
      return [
        `${team}, ${josa(opp, '을', '를')} 넘다`,
        `${team}, ${opp} 상대로 승리`,
        `${josa(opp, '을', '를')} 꺾은 ${team}`,
      ]
    case 'shootoutWin':
      return [
        `승부차기 혈투 끝에 웃은 ${team}`,
        `${team}, ${josa(opp, '과', '와')} 승부차기 접전 승리`,
        `${team}, 12야드에서 갈린 승부 잡다`,
      ]
    case 'draw':
      return [
        `${team}, ${josa(opp, '과', '와')} 승점 분배`,
        `${team}·${opp}, 승부 가리지 못하다`,
        `${team}, ${josa(opp, '과', '와')} 무승부`,
      ]
    case 'loss':
      return [
        `${team}, ${josa(opp, '에게', '에게')} 발목 잡히다`,
        `${team}, ${opp}전 아쉬운 패배`,
        `${team}의 여정, ${opp}전에서 시험대에 서다`,
      ]
  }
}

/**
 * 신문 헤드라인 생성. 결과 × (마지막 답변) 톤 조합 템플릿, quote는 answers 중 하나 인용.
 * FICTION 워터마크는 UI가 붙인다.
 */
export function buildHeadline(record: MatchRecord, answers: string[], teamName: string): Headline {
  const opp = oppName(record.opponentId)
  const out = outcomeOf(record)
  const nonEmpty = answers.filter(a => typeof a === 'string' && a.trim().length > 0)
  const lastTone = nonEmpty.length ? answerTone(nonEmpty[nonEmpty.length - 1]) : 0
  const seed = recordSeed(record)

  const titles = titleTemplates(out, teamName, opp)
  const title = titles[(lastTone + seed) % titles.length]

  const [kor, oppG] = record.score
  const so = record.shootout ? ` (승부차기 ${record.shootout[0]}-${record.shootout[1]})` : ''
  const sub = `${STAGE_LABEL[record.stage]} · ${teamName} ${kor}-${oppG} ${opp}${so}`

  const quoted = nonEmpty.length
    ? nonEmpty[seed % nonEmpty.length]
    : '끝까지 최선을 다했습니다.'
  const quote = `"${quoted}" — ${teamName} 감독`

  return { title, sub, quote }
}

// ═══════════════════════════════════════════════════════════
// AI 컨텍스트 — 사실 카드
// ═══════════════════════════════════════════════════════════
// 왜 여기에 있는가(2026-08-02, 실플레이 결함):
//   기자회견이 AI에 넘기던 맥락은 `{ teamName, opponentId, stage, score: [2,5] }` 였다.
//   **배열의 어느 칸이 우리 득점인지가 그 데이터 안에 적혀 있지 않다.** opponentId는 코드값
//   ('mex')이고 teamName은 한국어라 둘을 짝지을 단서도 없다. 그 결과 모델은 2-5 **패배**를
//   "2-0에서 5-2로 대승"이라고 뒤집어 썼다(존재하지 않는 전개까지 창작).
//   교훈: **모델에게 판정을 시키지 않는다.** 승패는 우리가 계산해서 한국어 낱말로 못 박고,
//   양 팀의 득점은 인덱스가 아니라 이름 붙은 필드로 준다.
//
// 이 모듈에 두는 이유: 상대 한글 표기·단계 라벨·승패 판정(outcomeOf)이 전부 여기 있다.
// UI가 자기 사본을 들고 계산하면 화면과 프롬프트가 따로 놀 수 있다.
// 반환 타입을 Record<string, unknown>으로 두는 것은 aiClient.narrate의 계약에 맞추기 위함이다.

/** 우리 팀 기본 표기 — 캠페인에서 유저는 언제나 kor을 지휘한다(App.tsx). */
const OUR_TEAM_DEFAULT = '대한민국'

/** 승/무/패를 한국어 낱말로. 승부차기는 별도 필드로 분리해 정규시간과 섞지 않는다. */
function resultWord(kor: number, opp: number): '승리' | '무승부' | '패배' {
  return kor > opp ? '승리' : kor < opp ? '패배' : '무승부'
}

/**
 * 경기 1건 → AI에 넘길 **모호함 없는** 사실 카드.
 * 키를 한국어로 두는 이유: 모델이 읽는 유일한 라벨이므로, `score[0]`처럼 해석이 필요한
 * 이름을 남기지 않는다. 스코어 표기는 '최종_스코어' 하나로 정본화해 모델이 직접
 * 숫자를 조합하다 뒤집는 경로를 없앤다.
 */
export function describeMatch(record: MatchRecord, teamName: string = OUR_TEAM_DEFAULT): Record<string, unknown> {
  const [kor, opp] = record.score
  const oppKo = oppName(record.opponentId)
  const regulation = resultWord(kor, opp)
  const so = record.shootout
  // 최종 결과 = 정규시간 결과, 단 승부차기가 있었으면 그쪽이 승부를 가른다.
  const final = so ? (so[0] > so[1] ? '승부차기 승리' : '승부차기 패배') : regulation
  // 조사는 josa()로 맞춘다 — 이 문장은 모델이 가장 먼저 읽는 한 줄이라 "은(는)" 같은
  // 기계 표기를 남기면 그 어색함이 그대로 헤드라인 문체로 새어 나온다.
  const we = josa(teamName, '은', '는')
  const summary = so
    ? `${we} ${josa(oppKo, '과', '와')} ${kor}-${opp} 스코어로 비긴 뒤 승부차기 ${so[0]}-${so[1]}로 ${so[0] > so[1] ? '이겼다' : '졌다'}.`
    : regulation === '무승부'
      ? `${we} ${josa(oppKo, '과', '와')} ${kor}-${opp} 스코어로 비겼다.`
      : `${we} ${oppKo}에 ${kor}-${opp} 스코어로 ${regulation === '승리' ? '이겼다' : '졌다'}.`
  return {
    대회_단계: STAGE_LABEL[record.stage] ?? record.stage,
    우리_팀: teamName,
    우리_팀_득점: kor,
    상대_팀: oppKo,
    상대_팀_득점: opp,
    정규시간_결과: regulation,
    점수차: Math.abs(kor - opp),
    승부차기: so ? { 우리_팀: so[0], 상대_팀: so[1] } : null,
    최종_결과: final,
    최종_스코어: `${teamName} ${kor}-${opp} ${oppKo}`,
    한줄_사실: summary,
  }
}

/**
 * 캠페인 전체 → 사실 카드. 에필로그가 뒤집히면 여정 전체가 거짓이 되므로
 * 경기별 결과를 **한 줄씩 판정해서** 넘긴다(모델이 배열을 세게 두지 않는다).
 */
export function describeCampaign(
  records: MatchRecord[],
  ending: { reached: CampaignStage; champion: boolean },
  teamName: string = OUR_TEAM_DEFAULT,
): Record<string, unknown> {
  let w = 0, d = 0, l = 0, gf = 0, ga = 0
  const matches = records
    .filter(r => r.stage !== 'ended')
    .map(r => {
      const [kor, opp] = r.score
      gf += kor; ga += opp
      // 승부차기가 있으면 그 승패가 진출을 가른다 — 전적도 그 기준으로 센다.
      const outcome = r.shootout
        ? (r.shootout[0] > r.shootout[1] ? '승리' : '패배')
        : resultWord(kor, opp)
      if (outcome === '승리') w++
      else if (outcome === '패배') l++
      else d++
      return describeMatch(r, teamName)
    })
  const reached = STAGE_LABEL[ending.reached] ?? ending.reached
  return {
    우리_팀: teamName,
    도달_단계: reached,
    우승_여부: ending.champion,
    통산_전적: `${w}승 ${d}무 ${l}패`,
    총_득점: gf,
    총_실점: ga,
    경기별_결과: matches,
    한줄_사실: ending.champion
      ? `${josa(teamName, '은', '는')} ${w}승 ${d}무 ${l}패로 우승했다.`
      : `${josa(teamName, '은', '는')} ${w}승 ${d}무 ${l}패를 기록했고, ${reached}에서 여정이 끝났다(우승하지 못했다).`,
  }
}

/**
 * 3층 방어선 — AI가 돌려준 문장에 **이 경기에 존재하지 않는 스코어 표기**가 있는가.
 *
 * 프롬프트 제약은 강제력이 아니라 부탁이다. 실제 결함 문장("2-0에서 5-2로 대승")도
 * 없는 스코어 두 개를 지어낸 것이었으므로, 값싼 문자열 검사만으로 그 부류를 잡는다.
 *
 * 과잉 방어를 피하려고 판정 범위를 좁게 잡았다:
 *  - 검사 대상은 `숫자-숫자` **두 토막**뿐이다. `4-2-3-1` 같은 세 토막 이상은 포메이션이라
 *    스코어로 읽지 않는다.
 *  - 허용값은 실제 스코어와 승부차기 스코어. 그 외 숫자 쌍이 하나라도 있으면 위반이다.
 *  - 스코어를 아예 쓰지 않은 헤드라인(대부분의 정상 출력)은 매치가 0건이라 통과한다.
 * 즉 "숫자를 말했는데 그 숫자가 틀린 경우"만 버린다. 뒤집힌 표기(2-5를 5-2로)도 여기서 걸린다
 * — 상대를 주어로 놓은 진실한 문장까지 버리게 되지만, 그 손해는 템플릿 헤드라인 한 줄이고
 * 반대쪽 손해는 결과 왜곡이다.
 */
export function contradictsScore(text: string, record: MatchRecord): boolean {
  const allowed = new Set<string>([`${record.score[0]}-${record.score[1]}`])
  if (record.shootout) allowed.add(`${record.shootout[0]}-${record.shootout[1]}`)
  const tokens = text.match(/\d+(?:\s*[-–:]\s*\d+)+/g) ?? []
  for (const tok of tokens) {
    const parts = tok.split(/[-–:]/).map(s => s.trim())
    if (parts.length !== 2) continue // 포메이션 표기 — 판정하지 않는다
    if (!allowed.has(parts.join('-'))) return true
  }
  return false
}

// ═══════════════════════════════════════════════════════════
// buildEpilogue
// ═══════════════════════════════════════════════════════════
/**
 * 캠페인 여정 3~5문장. 조별 성적 요약 → 토너먼트 하이라이트 → 결말. 사실 기반.
 */
export function buildEpilogue(
  records: MatchRecord[],
  ending: { reached: CampaignStage; champion: boolean },
): string[] {
  const group = records.filter(r => r.stage.startsWith('group'))
  const tour = records.filter(r => !r.stage.startsWith('group') && r.stage !== 'ended')
  const sentences: string[] = []

  // 1) 조별 성적 요약(사실).
  if (group.length) {
    let w = 0, d = 0, l = 0, gf = 0, ga = 0
    for (const r of group) {
      gf += r.score[0]; ga += r.score[1]
      if (r.score[0] > r.score[1]) w++
      else if (r.score[0] < r.score[1]) l++
      else d++
    }
    sentences.push(`조별리그에서 ${w}승 ${d}무 ${l}패, ${gf}득점 ${ga}실점을 기록했다.`)
    // 2) 기억에 남는 경기 한 판.
    //    예전에는 "최다 득점 경기"를 골라 "가장 인상적인 경기"라고 불렀다. 그 결과
    //    전패한 캠페인에서 0-3 대패가 "가장 인상적인 경기"로 소개됐다 — 팀을 조롱하는
    //    문장으로 읽힌다. 결과(승>무>패) → 득실차 → 다득점 순으로 고르고, 이긴 경기가
    //    없으면 "가장 인상적인"이라는 상찬 대신 중립적으로 서술한다.
    const rank = (r: MatchRecord) => (r.score[0] > r.score[1] ? 2 : r.score[0] === r.score[1] ? 1 : 0)
    const best = [...group].sort((a, b) =>
      rank(b) - rank(a)
      || (b.score[0] - b.score[1]) - (a.score[0] - a.score[1])
      || b.score[0] - a.score[0]
      || a.stage.localeCompare(b.stage))[0]
    sentences.push(
      rank(best) > 0
        // "2-0로"처럼 숫자 뒤 조사가 틀리는 자리다(받침 유무가 숫자 읽기에 따라 갈린다).
        // "스코어로"를 끼워 조사를 고정한다.
        ? `가장 인상적인 경기는 ${oppName(best.opponentId)}전으로, ${best.score[0]}-${best.score[1]} 스코어로 마쳤다.`
        : `가장 근접했던 경기는 ${oppName(best.opponentId)}전으로, ${best.score[0]}-${best.score[1]} 스코어로 마쳤다.`,
    )
  }

  // 3) 토너먼트 하이라이트(승부차기·승수).
  if (tour.length) {
    const wonPk = (r: MatchRecord) => !!r.shootout && r.shootout[0] > r.shootout[1]
    const wins = tour.filter(r => r.score[0] > r.score[1] || wonPk(r)).length
    // 승부차기를 **이긴** 경기가 있으면 그걸 하이라이트로 쓴다. 예전에는 첫 승부차기를
    // 무조건 "혈투 끝에 살아남았다"로 서술해, 승부차기로 탈락한 결말에서 사실이 뒤집혔다.
    const pkWin = tour.find(wonPk)
    const pkLoss = tour.find(r => !!r.shootout && r.shootout[0] < r.shootout[1])
    if (pkWin) {
      sentences.push(`토너먼트에서 ${wins}번의 승리를 거뒀고, ${oppName(pkWin.opponentId)}전에서는 승부차기 혈투 끝에 살아남았다.`)
    } else if (pkLoss) {
      sentences.push(`토너먼트에서 ${wins}번의 승리를 거뒀고, ${oppName(pkLoss.opponentId)}전은 승부차기까지 간 끝에 갈렸다.`)
    } else if (wins > 0) {
      sentences.push(`토너먼트 무대에 올라 ${wins}번의 승리를 거뒀다.`)
    } else {
      sentences.push('토너먼트 무대에 올랐지만 승리를 더하지는 못했다.')
    }
  }

  // 4) 결말(사실 기반).
  if (ending.champion) {
    sentences.push('그리고 마침내 결승 무대에서 정상에 올라 우승 트로피를 들어올렸다.')
  } else if (ending.reached.startsWith('group')) {
    sentences.push('아쉽게도 조별리그의 문턱을 넘지 못하고 여정을 마쳤다.')
  } else {
    sentences.push(`${STAGE_LABEL[ending.reached]}에서 여정이 멈췄지만, 끝까지 최선을 다한 도전이었다.`)
  }

  // 3~5문장 보장.
  if (sentences.length < 3) sentences.push('선수들과 팬이 함께 만든 이야기였다.')
  return sentences.slice(0, 5)
}
