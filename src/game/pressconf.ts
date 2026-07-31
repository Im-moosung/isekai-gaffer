// src/game/pressconf.ts
// 기자회견 질문 · 신문 헤드라인 · 캠페인 에필로그 생성기 (템플릿 정본).
// 이 게임 서사 축의 심장 — AI 서술은 상위 레이어이며, 키 부재·실패 시 이 모듈이 100% 폴백한다.
// 순수 함수 · 결정론(Math.random/Date 금지, 해시로 변형 선택) · 사실 서술 · 비하 금지.
import type { MatchRecord, CampaignStage } from './campaignStore'
import type { DecisionEntry } from '../engine/types'

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
/** 캠페인 상대 한글 표기(외부 로더 비의존 — 계층 격리). 미등록 id는 코드 그대로. */
const OPPONENT_KO: Record<string, string> = {
  cze: '체코', mex: '멕시코', rsa: '남아공',
  ecu: '에콰도르', eng: '잉글랜드', nor: '노르웨이', arg: '아르헨티나', esp: '스페인',
  can: '캐나다', mar: '모로코', fra: '프랑스',
}
function oppName(id: string): string { return OPPONENT_KO[id] ?? id }

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
// 답변 톤 풀 — index 0=공격적, 1=겸손, 2=유머. 톤 정렬 유지(헤드라인이 답변 톤을 역분류).
const AGGRESSIVE = [
  '우리 준비가 옳았습니다. 결과가 증명하죠.',
  '누구와 붙어도 두렵지 않습니다.',
  '이 정도는 예상했던 그림입니다.',
  '다음 상대도 우리를 경계해야 할 겁니다.',
]
const HUMBLE = [
  '선수들이 모든 걸 쏟아부은 덕분입니다.',
  '팬들의 응원이 큰 힘이 됐습니다.',
  '아직 갈 길이 멉니다. 겸손히 준비하겠습니다.',
  '제 몫보다 선수들의 헌신이 컸습니다.',
]
const HUMOR = [
  '심장이 열 개라도 모자란 경기였네요.',
  '오늘 밤은 발 뻗고 자겠습니다.',
  '해설진 목소리가 저보다 더 컸을 겁니다.',
  '커피를 몇 잔 마셨는지 세지도 못했네요.',
]
/** 답변 톤 풀 export (헤드라인 역분류·UI 프리뷰용). */
export const ANSWER_POOLS: { aggressive: readonly string[]; humble: readonly string[]; humor: readonly string[] } = {
  aggressive: AGGRESSIVE, humble: HUMBLE, humor: HUMOR,
}

function optionsFor(pick: number): [string, string, string] {
  const i = pick % AGGRESSIVE.length
  return [AGGRESSIVE[i], HUMBLE[i], HUMOR[i]]
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

/** "압박 62→47" 한 조각을 "압박을 62에서 47까지 내리" 꼴로. 해석 불가면 null.
 *
 *  ★ 숫자 뒤에는 '로/으로'를 쓰지 않는다 — 받침 유무가 읽기에 따라 갈린다(90=구십'으로',
 *    5=오'로'). 이 저장소가 여러 번 밟은 자리라, 수치 축은 조사 자체가 없는 '까지'로 끊는다.
 *    비수치 축(공격방향)만 한글이므로 그쪽에서만 josa로 '로/으로'를 고른다. */
function axisClause(piece: string): string | null {
  const m = /^(.+?)\s(.+?)→(.+)$/.exec(piece.trim())
  if (!m) return null
  const [, axis, before, after] = m
  const nb = Number(before), na = Number(after)
  const head = josa(axis, '을', '를')
  if (Number.isFinite(nb) && Number.isFinite(na)) {
    const verb = na > nb ? '올리' : na < nb ? '내리' : '조정하'
    return `${head} ${before}에서 ${after}까지 ${verb}`
  }
  return `${head} ${before}에서 ${josa(after, '으로', '로')} 바꾸`
}

/** 결정 로그 1건 → 기자 질문. 해석할 수 없으면 null(질문을 만들지 않는다). */
function logQuestionText(e: DecisionEntry): string | null {
  const when = whenPhrase(e.summary)
  switch (e.kind) {
    case 'teamtalk': {
      const tone = typeof e.detail?.tone === 'string' ? TONE_SCENE[e.detail.tone] : undefined
      if (tone) return `하프타임 라커룸 이야기가 나옵니다. ${tone} — 그 말이 후반의 흐름을 만들었다고 보십니까?`
      const shout = typeof e.detail?.shout === 'string' ? SHOUT_SCENE[e.detail.shout] : undefined
      if (shout) return `${when} 터치라인에서 ${shout} 그 한마디가 꼭 필요한 순간이었습니까?`
      return null
    }
    case 'sub': {
      const m = /교체: (.+) IN, (.+) OUT$/.exec(e.summary)
      if (!m) return null
      const [, inName, outName] = m
      return `${when} ${josa(outName, '을', '를')} 빼고 ${josa(inName, '을', '를')} 투입하셨습니다. 계획된 승부수였습니까?`
    }
    case 'instructions': {
      // 포메이션 변경은 before/after가 구조화돼 있다.
      const before = e.detail?.before, after = e.detail?.after
      if (typeof before === 'string' && typeof after === 'string') {
        return `${when} 진형을 ${before}에서 ${after}로 바꾸셨습니다. 무엇을 노리신 변화였습니까?`
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
      return `${when} ${joined}셨습니다. 어떤 의도였는지 설명해 주시겠습니까?`
    }
    case 'shootout-setup':
      // 이 로그는 자유 문자열이라 파싱할 구조가 없다. 사실만 말하고 요약은 인용하지 않는다.
      return '승부차기를 앞두고 키커 순서를 직접 정하셨습니다. 선정 기준은 무엇이었습니까?'
  }
}

// 결과 기반 질문(로그 부족분 채움). 중립 추궁.
function resultQuestions(r: MatchRecord): string[] {
  const opp = oppName(r.opponentId)
  const out = outcomeOf(r)
  const qs: string[] = []
  switch (out) {
    case 'bigwin':
      qs.push(`${opp}을 상대로 큰 점수 차 승리였습니다. 이런 결과를 예상하셨습니까?`)
      break
    case 'narrow':
      qs.push(`한 골 차 승부 끝에 웃으셨습니다. 후반 집중력의 비결이 있었습니까?`)
      break
    case 'win':
      qs.push(`${opp}을 넘어 승리를 거두셨습니다. 오늘 가장 큰 원동력은 무엇이었습니까?`)
      break
    case 'shootoutWin':
      qs.push(`승부차기까지 가는 접전이었습니다. 그 긴장을 어떻게 견디셨습니까?`)
      break
    case 'draw':
      qs.push(`${opp}과 무승부로 마쳤습니다. 아쉬움이 남는 결과라는 평가에 동의하십니까?`)
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

/** 킥오프 플랜 이탈 축 수 기준 — 이 이상이면 "계획을 버렸다"로 본다.
 *  구조(포메이션·멘탈리티) + 지시 2축 이상을 갈아엎어야 도달하는 값이다. */
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

/** 플랜 이탈 정도 × 결과로 갈리는 추궁 질문. 성립하지 않으면 null.
 *  질문 문안은 중립 추궁("~습니까?") 톤을 유지한다 — 비하·단정 금지 계약. */
function planQuestion(planDeviation: number, won: boolean): { text: string; branch: PlanBranch } | null {
  if (planDeviation === 0 && won) {
    return { branch: 'kept', text: '경기 내내 킥오프 때의 계획을 한 번도 흔들지 않으셨습니다. 무엇을 준비하셨습니까?' }
  }
  if (planDeviation >= PIVOT_DEVIATION && won) {
    return { branch: 'pivot-win', text: `전반과 완전히 다른 팀이었습니다. ${planDeviation}개 축을 바꾸셨는데, 원래 계획이 틀렸던 겁니까?` }
  }
  if (planDeviation >= PIVOT_DEVIATION && !won) {
    return { branch: 'pivot-loss', text: `${planDeviation}개 축을 도중에 바꾸셨습니다. 계획을 버린 것이 결과로 이어졌다고 보십니까?` }
  }
  return null
}

/**
 * 기자 질문 3문항 생성.
 * 1) 플랜 이탈 추궁이 성립하면 최우선(감독의 사전 설계를 경기 후에 회수하는 축이다.
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
  // 로그 우선순위 정렬(안정): kind 우선순위 → 원래 등장 순서.
  const KIND_ORDER: Record<DecisionEntry['kind'], number> = {
    teamtalk: 0, sub: 1, instructions: 2, 'shootout-setup': 3,
  }
  const ordered = log
    .map((e, idx) => ({ e, idx }))
    .sort((a, b) => KIND_ORDER[a.e.kind] - KIND_ORDER[b.e.kind] || a.idx - b.idx)

  // options가 지정된 항목(플랜 추궁)은 전용 문안을 쓰고, 나머지는 공용 톤 풀에서 뽑는다.
  const items: { text: string; options?: [string, string, string] }[] = []
  const seen = new Set<string>()
  const push = (text: string, options?: [string, string, string]) => {
    if (seen.has(text)) return
    seen.add(text)
    items.push(options ? { text, options } : { text })
  }

  if (planDeviation !== undefined) {
    const out = outcomeOf(record)
    const pq = planQuestion(planDeviation, out !== 'draw' && out !== 'loss')
    if (pq) push(pq.text, PLAN_ANSWERS[pq.branch])
  }
  for (const { e } of ordered) {
    const t = logQuestionText(e)
    if (t) push(t)
  }
  for (const t of resultQuestions(record)) push(t)

  return items.slice(0, 3).map((q, i) => ({
    id: `pq${i + 1}`,
    text: q.text,
    options: q.options ?? optionsFor(seed + i * 2654435761),
  }))
}

// ═══════════════════════════════════════════════════════════
// buildHeadline
// ═══════════════════════════════════════════════════════════
/** 답변 텍스트의 톤을 역분류(0=공격적/1=겸손/2=유머). 풀 밖이면 해시 폴백.
 *  플랜 추궁의 전용 답변도 같은 [공격적, 겸손, 유머] 순서로 놓여 있으므로 인덱스로 분류한다
 *  — 등록하지 않으면 해시 폴백으로 떨어져 헤드라인 톤이 답변과 어긋난다. */
function answerTone(text: string): 0 | 1 | 2 {
  if (AGGRESSIVE.includes(text)) return 0
  if (HUMBLE.includes(text)) return 1
  if (HUMOR.includes(text)) return 2
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
