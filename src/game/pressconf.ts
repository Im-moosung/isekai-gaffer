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

// 로그 종류별 질문 프레임 — 추궁하되 중립("~습니까?", "동의하십니까?"). summary를 문안에 활용.
function logQuestionText(e: DecisionEntry): string {
  switch (e.kind) {
    case 'teamtalk':
      return `라커룸 분위기가 화제입니다. "${e.summary}"라는 선택이 결과로 이어졌다는 평가에 동의하십니까?`
    case 'sub':
      return `승부처의 교체가 눈길을 끌었습니다. "${e.summary}", 계획된 승부수였습니까?`
    case 'instructions':
      return `경기 중 전술 변화가 있었습니다. "${e.summary}", 어떤 의도였는지 설명해 주시겠습니까?`
    case 'shootout-setup':
      return `승부차기를 앞두고 "${e.summary}" 준비가 있었습니다. 키커 선정 기준은 무엇이었습니까?`
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
  for (const { e } of ordered) push(logQuestionText(e))
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
        `진땀승... ${team}, ${opp} 제압`,
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
    // 2) 최고의 순간(최다 득점 조별 경기).
    const best = [...group].sort((a, b) =>
      (b.score[0] + b.score[1]) - (a.score[0] + a.score[1]) || a.stage.localeCompare(b.stage))[0]
    sentences.push(`가장 인상적인 경기는 ${oppName(best.opponentId)}전으로, ${best.score[0]}-${best.score[1]}로 마쳤다.`)
  }

  // 3) 토너먼트 하이라이트(승부차기·최다 골 경기).
  if (tour.length) {
    const wins = tour.filter(r => r.score[0] > r.score[1] || (r.shootout && r.shootout[0] > r.shootout[1])).length
    const shootout = tour.find(r => r.shootout)
    if (shootout) {
      sentences.push(`토너먼트에서 ${wins}번의 승리를 거뒀고, ${oppName(shootout.opponentId)}전에서는 승부차기 혈투 끝에 살아남았다.`)
    } else {
      sentences.push(`토너먼트 무대에 올라 ${wins}번의 승리를 거뒀다.`)
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
