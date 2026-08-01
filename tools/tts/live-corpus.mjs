#!/usr/bin/env node
// tools/tts/live-corpus.mjs
// **경기 중 중계 발화 전량**을 실측으로 모으고, 조각 분해 설계를 평가·최적화한다.
//
// 왜 필요한가: 입장 소개는 대본이라 문장을 세면 끝이지만, 경기 중계는
// (분 × 선수 × 사건 × 변형)의 곱이라 통문장이 포화되지 않는다. 조각을 이어 붙여야
// 하고, 그러면 **이음매 수**가 품질을 결정한다. 여기서 재는 것은 클립 수가 아니라
// **발화당 평균 이음매 수**다.
//
// ## 모델
// 발화 하나를 토큰 열로 본다. 토큰은 **가변 슬롯**(선수 147 · 팀 12 · 분 91 · 필러 5)
// 이거나 **리터럴**(그 외 문자열)이다. 분해는 이 토큰 열을 클립 그룹으로 자르는 것이고,
// 한 그룹의 클립 수 = 그 안에 든 가변 슬롯 도메인 크기의 **곱**이다.
//   · `{팀} 진영에서 반칙이 나옵니다.` 를 한 그룹으로 = 12클립, 이음매 0
//   · 나눠 굽기 = 12 + 1 = 13클립, 이음매 1
// 즉 팀·필러처럼 도메인이 작은 슬롯은 본문에 흡수시키는 편이 싸다. 선수(147)는 절대
// 흡수하지 않는다 — 곱이 폭발한다.
//
// ## 최적화
// 인접 그룹 쌍을 **(줄어드는 이음매) / (늘어나는 클립)** 비로 정렬해 탐욕적으로 합친다.
// 선수 슬롯이 든 쌍은 후보에서 제외한다. 임계 비 아래로 떨어지면 멈춘다.
//
// 사용:
//   node tools/tts/live-corpus.mjs [--seeds 24] [--ratio 8] [--json docs/audio/tts/live-corpus.json]
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

const SEP = '\u241F'
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const SEEDS = Number(arg('seeds', 24))
/**
 * 합치기 임계 — **발화 1,000건당 줄어드는 이음매 / 늘어나는 클립**.
 * 코퍼스 크기로 정규화한 값이라 시드 수를 바꿔도 같은 설계가 나온다
 * (정규화 전에는 시드를 늘릴수록 임계가 저절로 헐거워졌다).
 */
const RATIO = Number(arg('ratio', 0.7))
const JSON_OUT = arg('json', 'docs/audio/tts/live-corpus.json')

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam, TEAM_IDS } = await server.ssrLoadModule('/src/data/loader.ts')
const { createMatch, simulateSegment } = await server.ssrLoadModule('/src/engine/simulate.ts')
const { pickBestXI } = await server.ssrLoadModule('/src/engine/lineup.ts')
const { applyDiscipline } = await server.ssrLoadModule('/src/game/campaignStore.ts')
const { teamCardTally } = await server.ssrLoadModule('/src/game/playerStats.ts')
const { commentateTimeline } = await server.ssrLoadModule('/src/game/commentary.ts')

const GROUP = ['cze', 'mex', 'rsa']
const FIRST = { r32: 'ecu', r16: 'eng', qf: 'nor', sf: 'arg', final: 'esp' }
const SECOND = { r32: 'can', r16: 'mar', qf: 'fra', sf: 'esp', final: 'arg' }
const TOUR = ['r32', 'r16', 'qf', 'sf', 'final']
const ALL_TEAMS = [...TEAM_IDS]

const teams = Object.fromEntries(ALL_TEAMS.map(id => [id, loadTeam(id)]))
const kor = teams.kor

/** 발화 문자열 → 등장 횟수. 화자별로 따로 센다(클립은 화자별로 굽는다). */
const corpus = { caster: new Map(), analyst: new Map() }
const bump = (sp, s) => corpus[sp].set(s, (corpus[sp].get(s) ?? 0) + 1)
/** 상대 팀 **선발 XI**(결정론) — 시드에 안 걸린 이름까지 대상에 넣기 위한 집합. */
const xiNames = new Set()

function playMatch(oppId, seed, homeTactics, sOv, mOv) {
  const away = teams[oppId]
  const st0 = createMatch(kor, away, { seed, homeTactics })
  for (const [id, v] of Object.entries(sOv)) if (id in st0.home.staminaByPlayer) st0.home.staminaByPlayer[id] = v
  for (const [id, v] of Object.entries(mOv)) if (id in st0.home.moraleByPlayer) st0.home.moraleByPlayer[id] = v
  const st = simulateSegment(st0, 90)
  for (const side of ['home', 'away']) {
    const team = side === 'home' ? kor : away
    for (const slot of st[side].tactics.lineup) {
      const p = team.squad.find(x => x.id === slot.playerId)
      if (p) xiNames.add(p.name.ko)
    }
  }
  for (const l of commentateTimeline(st.events, kor, away, seed, {}, 95)) {
    bump(l.speaker, l.speech)
    if (l.follow) bump(l.follow.speaker, l.follow.speech)
  }
  return { score: [st.score[0], st.score[1]], cards: teamCardTally(st.events, kor.id), stamina: { ...st.home.staminaByPlayer }, morale: { ...st.home.moraleByPlayer } }
}

const tiebreak = (seed, stage) => ((seed * 7919 + stage.length * 31) % 2) === 0

function runCampaign(seed) {
  let cautions = {}, bans = {}, fatigue = {}, morale = {}
  let played = 0, groupPts = 0, groupGd = 0, path = null
  const startStamina = id => (fatigue[id] === undefined ? 100 : Math.min(100, fatigue[id] + (100 - fatigue[id]) * 0.7))
  const startMorale = id => (morale[id] === undefined ? 70 : 70 + (morale[id] - 70) * 0.3)
  const step = (oppId, stage) => {
    const suspended = Object.keys(bans).filter(id => bans[id] > 0)
    const tactics = pickBestXI(kor, undefined, suspended)
    const sOv = {}, mOv = {}
    for (const p of kor.squad) { sOv[p.id] = startStamina(p.id); mOv[p.id] = startMorale(p.id) }
    const r = playMatch(oppId, seed * 31 + played, tactics, sOv, mOv)
    played++
    fatigue = { ...fatigue, ...r.stamina }
    morale = { ...morale, ...r.morale }
    const next = applyDiscipline(cautions, bans, r.cards, stage)
    cautions = next.cautions; bans = next.bans
    return r
  }
  for (let i = 0; i < 3; i++) {
    const r = step(GROUP[i], `group${i + 1}`)
    groupPts += r.score[0] > r.score[1] ? 3 : r.score[0] === r.score[1] ? 1 : 0
    groupGd += r.score[0] - r.score[1]
  }
  if (groupPts >= 5) path = 'first'
  else if (groupPts >= 3 || (groupPts >= 2 && groupGd >= 0)) path = 'second'
  if (!path) return
  const table = path === 'first' ? FIRST : SECOND
  for (const stage of TOUR) {
    const r = step(table[stage], stage)
    const won = r.score[0] > r.score[1] || (r.score[0] === r.score[1] && tiebreak(seed, stage))
    if (!won || stage === 'final') break
  }
}

for (let s = 1; s <= SEEDS; s++) runCampaign(s)

// ── 토큰화 ──────────────────────────────────────────────────
const FILLERS = ['자,', '아,', '네,', '그런데,', '여기서,']
const TEAM_KO = ALL_TEAMS.map(id => teams[id].name.ko)
// 이름 대상 = roster 실측(kor 전원 + 나머지 팀의 발화된 선수). 여기서는 스쿼드 전원을
// 후보로 잡으면 과대추정이므로 roster.json의 clipTargets를 쓴다.
// 이름 대상은 **이 코퍼스에서 실제로 불린 선수** ∪ **한국 스쿼드 전원**이다.
// 한국만 전원인 이유: 유저가 라인업을 직접 바꾸므로 26명 누구나 후보다(AI는
// `pickBestXI`가 XI를 결정론으로 고정한다 — docs/audio/tts/README.md §①).
// ★ roster.json을 쓰지 않는다. 그 파일은 따로 생성된 스냅숏이라 팀 데이터가 바뀌면
//   조용히 어긋나고, 어긋난 만큼이 **커버리지 구멍**이 된다. 여기서 직접 센다.
const ALL_SQUAD = new Set()
for (const id of ALL_TEAMS) for (const p of teams[id].squad) ALL_SQUAD.add(p.name.ko)
const PLAYERS = [...ALL_SQUAD].sort((a, b) => b.length - a.length)
// 대진에 안 걸린 팀도 **선발 XI는 결정론**이라 미리 넣어 둔다 — 시드 수에 따라
// 이름 대상이 오락가락하면 커버리지가 조용히 깨진다(입장 소개가 같은 사고를 냈다).
for (const tid of ALL_TEAMS) {
  if (tid === 'kor') continue
  const st = createMatch(kor, teams[tid], { seed: 1 })
  for (const slot of st.away.tactics.lineup) {
    const p = teams[tid].squad.find(x => x.id === slot.playerId)
    if (p) xiNames.add(p.name.ko)
  }
}
const SPOKEN_NAMES = new Set([...kor.squad.map(p => p.name.ko), ...xiNames])
for (const sp of ['caster', 'analyst']) {
  for (const line of corpus[sp].keys()) for (const nm of PLAYERS) if (line.includes(nm)) SPOKEN_NAMES.add(nm)
}
const NAME_TARGETS = [...SPOKEN_NAMES]
const TEAMS_SORTED = [...TEAM_KO].sort((a, b) => b.length - a.length)
const TEAM_SET = new Set(TEAMS_SORTED)

/** 슬롯 도메인 크기 — 클립 수는 그룹 안 슬롯 도메인의 곱이다. */
// SCOREA/SCOREB = `이 대 ` + `일…` — 스코어를 통으로 구우면 11×11×형태라 예산 밖이다.
// 이음매가 **어절 경계**(`대` 뒤 공백)에 떨어지므로 연음이 깨지지 않는다.
// ORD = `세 번째` — `번째`를 붙여 굽는다(고유어 수사 + 의존명사는 한 어절로 읽힌다).
const DOMAIN = { NAME: NAME_TARGETS.length, TEAM: TEAM_KO.length, MINUTE: 91, FILLER: FILLERS.length, SCOREA: 11, SCOREB: 11, ORD: 11 }
const SINO = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구', '십']
const ORD_KO = ['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '여러']
const SCORE_RE = new RegExp(`^(${SINO.join('|')}) 대 (${SINO.join('|')})`)
const ORD_RE = new RegExp(`^(${ORD_KO.join('|')}) 번째`)

/** 이름·팀 뒤에 **붙여서 구워야 하는** 조사·구두점(이음매가 음절 한복판에 떨어지지 않게). */
const SLOT_TAIL = /^(입니다[.!?]?|에게|과|와|의|이|가|은|는|을|를)?[,.!?]?/
const MINUTE_RE = /^((전반|후반) \d+분|후반 추가시간), /

/**
 * 발화 하나를 토큰 열로. 토큰: {v:슬롯종류, form:조사꼬리} 또는 {lit:문자열}
 * @param speaker 필러는 캐스터 라인에만 붙는다(commentary.step) — 해설의 문두 `네,`는
 *   템플릿의 일부라 잘라내면 안 된다.
 */
function tokenize(speech, speaker) {
  const out = []
  let rest = speech
  if (speaker === 'caster') {
    const f = FILLERS.find(x => rest.startsWith(x + ' '))
    if (f) { out.push({ v: 'FILLER', form: '', text: f + ' ' }); rest = rest.slice(f.length + 1) }
  }
  const m = MINUTE_RE.exec(rest)
  if (m) { out.push({ v: 'MINUTE', form: '', text: m[0] }); rest = rest.slice(m[0].length) }
  let buf = ''
  let i = 0
  // ★ 스코어·서수 슬롯은 **캐스터에만** 있다(`v.scoreSpeech`·`v.nth`는 캐스터 템플릿
  //   전용이다). 해설 문장의 `두 번째 볼 싸움`은 변수가 아니라 리터럴이라, 슬롯으로
  //   보면 한 문장이 11클립으로 부풀어 오른다.
  const numeric = speaker === 'caster'
  while (i < rest.length) {
    const sc = numeric && SCORE_RE.exec(rest.slice(i))
    if (sc) {
      const tail = SLOT_TAIL.exec(rest.slice(i + sc[0].length))[0]
      if (buf) { out.push({ lit: buf }); buf = '' }
      out.push({ v: 'SCOREA', form: '', text: `${sc[1]} 대 ` })
      out.push({ v: 'SCOREB', form: tail, text: sc[2] + tail })
      i += sc[0].length + tail.length
      continue
    }
    const od = numeric && ORD_RE.exec(rest.slice(i))
    if (od) {
      if (buf) { out.push({ lit: buf }); buf = '' }
      out.push({ v: 'ORD', form: '', text: od[0] })
      i += od[0].length
      continue
    }
    let hit = null
    for (const nm of PLAYERS) if (rest.startsWith(nm, i)) { hit = nm; break }
    if (!hit) for (const tm of TEAMS_SORTED) if (rest.startsWith(tm, i)) { hit = tm; break }
    if (!hit) { buf += rest[i]; i += 1; continue }
    const tail = SLOT_TAIL.exec(rest.slice(i + hit.length))[0]
    if (buf) { out.push({ lit: buf }); buf = '' }
    out.push({ v: TEAM_SET.has(hit) ? 'TEAM' : 'NAME', form: tail, text: hit + tail })
    i += hit.length + tail.length
  }
  if (buf) out.push({ lit: buf })
  return out
}

// ── 이름 조사 재작성 ────────────────────────────────────────
// `docs/audio/tts/name-rewrite.json`을 **코퍼스에 그대로 적용**한다. 그 표는 동시에
// commentary.ts에 넣을 문자열이기도 하다 — 여기서 적용한 결과가 곧 굽는 클립이므로
// 둘이 어긋나면 그 문장은 조회표에 없다. 그래서 적용 후 **검증**까지 여기서 한다.
const REWRITE = JSON.parse(readFileSync('docs/audio/tts/name-rewrite.json', 'utf8'))
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAME_ALT = PLAYERS.map(esc).join('|')
const REWRITE_RE = REWRITE.rules.flatMap(r =>
  r.from.map(f => ({
    id: r.id,
    re: new RegExp(esc(f).split(esc('{P}')).join(`(${NAME_ALT})`), 'g'),
    to: r.to.split('{P}').join('$1'),
  })))

/** 재작성표를 발화 하나에 적용한다. */
function rewrite(speech) {
  let s = speech
  for (const r of REWRITE_RE) s = s.replace(r.re, r.to)
  return s
}

// ── 분해 평가 ───────────────────────────────────────────────
/** 그룹(토큰 배열)의 추상 키 — 같은 키면 같은 클립 묶음이다. */
const groupKey = (sp, g) => sp + SEP + g.map(t => (t.lit !== undefined ? 'L:' + t.lit : `${t.v}:${t.form}`)).join(SEP)
const hasName = g => g.some(t => t.v === 'NAME')

// ── 슬롯 도메인 전개 ────────────────────────────────────────
// ★ 조사 형태는 **받침이 정한다**. `{팀}이`는 받침 있는 팀만, `{팀}가`는 없는 팀만
//   나온다 — 두 형태를 합쳐야 12개지 각각 12개가 아니다. 곱셈으로 어림하면 두 배로
//   부풀어 예산 판단이 틀린다. 그래서 **실제 문자열을 전개해서** 센다.
const jong = ch => { const c = ch.codePointAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : -1 }
const batchim = w => jong(w[w.length - 1]) > 0
const PAIRS = { 이: true, 가: false, 은: true, 는: false, 을: true, 를: false, 과: true, 와: false }
const MINUTES = [...Array(45).keys()].map(i => `전반 ${i + 1}분, `)
  .concat([...Array(45).keys()].map(i => `후반 ${i + 46}분, `), ['후반 추가시간, '])
const NAME_LIST = [...new Set(NAME_TARGETS)]

/** 슬롯 하나의 값 목록(조사 형태를 반영). */
function slotValues(v, form) {
  const suffix = w => w + form
  const filt = list => {
    const j = form[0]
    return j in PAIRS ? list.filter(w => batchim(w) === PAIRS[j]).map(suffix) : list.map(suffix)
  }
  switch (v) {
    case 'NAME': return filt(NAME_LIST)
    case 'TEAM': return filt(TEAM_KO)
    case 'MINUTE': return MINUTES
    case 'FILLER': return FILLERS.map(f => f + ' ')
    case 'SCOREA': return SINO.map(x => `${x} 대 `)
    case 'SCOREB': return SINO.map(suffix)
    case 'ORD': return ORD_KO.map(x => `${x} 번째`)
    default: throw new Error('unknown slot ' + v)
  }
}

/** 그룹을 **구울 문자열 전량**으로 전개한다(= 클립 목록). */
function expand(g) {
  let acc = ['']
  for (const t of g) {
    const vals = t.lit !== undefined ? [t.lit] : slotValues(t.v, t.form)
    const next = []
    for (const a of acc) for (const v of vals) next.push(a + v)
    acc = next
  }
  return acc
}

const costCache = new Map()
/** 그룹이 필요로 하는 클립 수(전개 결과 크기). */
function groupCost(g, key) {
  const k = key ?? groupKey('', g)
  let c = costCache.get(k)
  if (c === undefined) { c = expand(g).length; costCache.set(k, c) }
  return c
}

/** 현재 분해(각 발화의 그룹 경계)를 받아 총 클립 수·총 이음매를 센다. */
function score(items) {
  const inv = new Map()
  let seams = 0, utter = 0
  for (const it of items) {
    utter += it.n
    seams += (it.groups.length - 1) * it.n
    for (const g of it.groups) {
      const k = groupKey(it.sp, g)
      if (!inv.has(k)) inv.set(k, { cost: groupCost(g, k), freq: 0, group: g, sample: g.map(t => t.text ?? t.lit).join('') })
      inv.get(k).freq += it.n
    }
  }
  let clips = 0
  for (const v of inv.values()) clips += v.cost
  return { clips, seams, utter, avgSeams: seams / utter, inv }
}

function buildItems(rewritten) {
  const items = []
  for (const sp of ['caster', 'analyst']) {
    for (const [s0, n] of corpus[sp]) {
      const toks = tokenize(rewritten ? rewrite(s0) : s0, sp)
      // ★ **해설위원 문장은 쪼개지 않는다.** 두 가지 이유가 겹친다:
      //   ① 런타임 조회표(`index.json.clips`)는 발화 문자열 하나에 클립 하나를
      //      매기고 화자를 모른다. 캐스터와 해설이 같은 조각(`대한민국은`)을 나눠
      //      쓰면 **어느 한쪽이 남의 목소리로 나간다** — 지금 고치려는 그 증상이다.
      //   ② 해설 문장은 77종뿐이고 팀 슬롯이 든 것도 둘뿐이라, 통으로 구워도
      //      100클립 아래다. 이음매 0으로 사는 게 싸다.
      items.push({ sp, n, toks, groups: sp === 'analyst' ? [toks] : toks.map(t => [t]) })
    }
  }
  return items
}

/** 재작성이 **빠짐없이** 됐는지 — 남은 이름 형태가 `,`/`!` 밖이면 그 문장은 폴백한다. */
function verifyRewrite() {
  const bad = new Map()
  for (const it of buildItems(true)) {
    for (const t of it.toks) {
      if (t.v === 'NAME' && t.form !== ',' && t.form !== '!') {
        const k = `${t.form}  ←  ${it.toks.map(x => (x.v === 'NAME' ? '{P}' + x.form : (x.text ?? x.lit))).join('')}`
        bad.set(k, (bad.get(k) ?? 0) + it.n)
      }
    }
  }
  return [...bad].sort((a, b) => b[1] - a[1])
}

/** 탐욕적 인접 합치기. 선수 슬롯이 든 그룹은 합치지 않는다. */
function optimize(items, ratioFloor) {
  const merges = []
  for (;;) {
    const base = score(items)
    // 후보: (왼쪽 그룹 키, 오른쪽 그룹 키) 인접 패턴별 빈도
    const cand = new Map()
    for (const it of items) {
      for (let i = 0; i + 1 < it.groups.length; i++) {
        const a = it.groups[i], b = it.groups[i + 1]
        if (hasName(a) || hasName(b)) continue
        const k = groupKey(it.sp, a) + SEP + groupKey(it.sp, b)
        cand.set(k, (cand.get(k) ?? 0) + it.n)
      }
    }
    let best = null
    for (const [k, freq] of cand) {
      const next = items.map(it => ({ ...it, groups: applyMerge(it, k) }))
      const s = score(next)
      const dClips = s.clips - base.clips
      const dSeams = base.seams - s.seams
      if (dSeams <= 0) continue
      const ratio = dClips <= 0 ? Infinity : (dSeams / base.utter) * 1000 / dClips
      if (!best || ratio > best.ratio) best = { k, ratio, dClips, dSeams, next, freq }
    }
    if (!best || best.ratio < ratioFloor) return { items, merges }
    items = best.next
    merges.push({ pattern: fmtKey(best.k), ratio: best.ratio, dClips: best.dClips, dSeams: best.dSeams, freq: best.freq })
  }
}

/** 그룹 키를 사람이 읽을 형태로. 화자 토큰은 지우고 슬롯은 `{종류}` 로 보인다. */
function fmtKey(k) {
  return k.split(SEP).filter(x => x !== 'caster' && x !== 'analyst')
    .map(x => (x.startsWith('L:') ? x.slice(2) : `{${x}}`)).join('')
}

function applyMerge(it, key) {
  const out = []
  let i = 0
  while (i < it.groups.length) {
    if (i + 1 < it.groups.length) {
      const a = it.groups[i], b = it.groups[i + 1]
      if (!hasName(a) && !hasName(b) && groupKey(it.sp, a) + SEP + groupKey(it.sp, b) === key) {
        out.push([...a, ...b]); i += 2; continue
      }
    }
    out.push(it.groups[i]); i += 1
  }
  return out
}

// ── 보고 ────────────────────────────────────────────────────
const totalUtter = [...corpus.caster.values()].reduce((a, b) => a + b, 0) + [...corpus.analyst.values()].reduce((a, b) => a + b, 0)
console.log(`\n# 경기 중 중계 코퍼스 — 캠페인 시드 1..${SEEDS}\n`)
console.log(`총 발화 ${totalUtter}건 · 서로 다른 문장 ${corpus.caster.size + corpus.analyst.size}개 (캐스터 ${corpus.caster.size} / 해설 ${corpus.analyst.size})`)
console.log(`이름 대상 ${DOMAIN.NAME}명 · 팀 ${DOMAIN.TEAM} · 분 ${DOMAIN.MINUTE} · 필러 ${DOMAIN.FILLER}\n`)

const rows = []
const raw = buildItems(false)
rows.push(['① 재작성 전(이름 조사 9형태) · 합치기 없음', score(raw)])
const col = buildItems(true)
rows.push(['② 재작성 후(이름 2형태) · 합치기 없음', score(col)])
const opt = optimize(buildItems(true), RATIO)
const optScore = score(opt.items)
rows.push([`③ 재작성 후 + 탐욕 합치기(비≥${RATIO}) — **채택**`, optScore])

const missed = verifyRewrite()
if (missed.length) {
  console.error('\n! 재작성이 덮지 못한 이름 형태 — name-rewrite.json에 규칙을 더해라:')
  for (const [k, n] of missed.slice(0, 20)) console.error(`  ${String(n).padStart(5)}  ${k}`)
  process.exitCode = 1
} else {
  console.log('\n재작성 검증: 모든 이름이 `{이름},` 또는 `{이름}!` 두 형태로 닫힌다. ✅')
}

console.log('| 설계 | 클립 수 | 평균 이음매 | 총 이음매 |')
console.log('|---|---:|---:|---:|')
for (const [label, s] of rows) console.log(`| ${label} | ${s.clips} | ${s.avgSeams.toFixed(3)} | ${s.seams} |`)

console.log('\n## 채택된 합치기\n')
console.log('| 패턴 | 이음매 −  | 클립 + | 비 |')
console.log('|---|---:|---:|---:|')
for (const m of opt.merges) console.log(`| ${m.pattern} | ${m.dSeams} | ${m.dClips} | ${m.ratio === Infinity ? '∞' : m.ratio.toFixed(2)} |`)

const bySlot = {}
for (const [k, v] of optScore.inv) {
  const kind = k.includes('NAME:') ? 'name' : k.includes('MINUTE:') ? 'minute' : k.includes('TEAM:') ? 'team'
    : k.includes('FILLER:') ? 'filler' : /SCORE[AB]:|ORD:/.test(k) ? 'num' : 'body'
  bySlot[kind] = (bySlot[kind] ?? 0) + v.cost
}
console.log('\n최종 클립 구성:', JSON.stringify(bySlot))

console.log('\n## 이음매가 남은 상위 패턴 (③)\n')
const seamPat = new Map()
for (const it of opt.items) {
  if (it.groups.length < 2) continue
  const k = it.groups.map(g => fmtKey(groupKey(it.sp, g))).join('  |  ')
  seamPat.set(k, (seamPat.get(k) ?? 0) + it.n)
}
for (const [k, n] of [...seamPat].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(n).padStart(5)}  ${k}`)

// ── 굽을 클립 목록(전개) ────────────────────────────────────
// 생성 텍스트는 **trim**한다. 앞뒤 공백은 조회표 키에서만 의미가 있고(원문 부분열),
// 굽는 소리에는 없다 — trim하면 ` 파울입니다.`와 `파울입니다.`가 한 클립으로 합쳐진다.
//
// 억양(캐리어 모드)은 그 조각이 문장 안에서 **어디에 서는가**로 정한다:
//   · 마지막 자리에 서 본 적이 없다 → 문중 억양이 필요하다 → 머리 절단 캐리어
//   · 첫 자리에 서 본 적이 없다 → 문말 하강이 필요하다 → 꼬리 절단 캐리어
//   · 둘 다 → 완결 문장이므로 직접 생성(plain)
const posn = new Map()   // 그룹 키 → {first, last, sp, group, freq}
for (const it of opt.items) {
  it.groups.forEach((g, i) => {
    const k = groupKey(it.sp, g)
    const e = posn.get(k) ?? { first: false, last: false, sp: it.sp, group: g, freq: 0 }
    if (i === 0) e.first = true
    if (i === it.groups.length - 1) e.last = true
    e.freq += it.n
    posn.set(k, e)
  })
}
/** trim된 생성 텍스트 → {role, cut, freq} */
const clipPlan = new Map()
for (const e of posn.values()) {
  const cut = !e.last ? 'head' : !e.first ? 'tail' : 'plain'
  for (const text of expand(e.group)) {
    const speak = text.trim()
    if (!speak) continue
    const cur = clipPlan.get(`${e.sp}${SEP}${speak}`)
    if (!cur) clipPlan.set(`${e.sp}${SEP}${speak}`, { role: e.sp, text: speak, cut, freq: e.freq })
    // 같은 문자열이 두 자리에 서면 문중 억양(head)을 택한다 — 문말 하강을 문중에
    // 쓰면 즉시 튀지만, 문중 억양이 문말에 오는 건 이음매 무음이 흡수한다.
    else {
      cur.freq += e.freq
      if (cur.cut !== 'head' && cut === 'head') cur.cut = 'head'
    }
  }
}
const plan = [...clipPlan.values()].sort((a, b) => b.freq - a.freq)
console.log(`\n굽을 클립(전개·trim·중복 제거): **${plan.length}**개`)
console.log('  캐리어 머리절단', plan.filter(x => x.cut === 'head').length,
  '· 꼬리절단', plan.filter(x => x.cut === 'tail').length,
  '· 직접', plan.filter(x => x.cut === 'plain').length)

// ── 커버리지 검증 — 런타임 DP를 그대로 흉내 낸다 ─────────────
// 조회표 키는 **trim된 조각 텍스트**이고, 조각 사이 공백은 런타임 DP가 공짜로
// 건너뛴다(commentary-mp3.decompose). 그 규칙으로 코퍼스 전 발화가 덮이는지 여기서
// 확인한다 — 굽기 전에 설계가 틀렸는지 알 수 있는 유일한 지점이다.
const keys = new Set(plan.map(p => p.text))
const maxKeyLen = Math.max(...[...keys].map(k => k.length))
function covered(str) {
  const n = str.length
  const dp = new Array(n + 1).fill(false)
  dp[n] = true
  for (let i = n - 1; i >= 0; i--) {
    for (let j = Math.min(n, i + maxKeyLen); j > i; j--) {
      if (dp[j] && keys.has(str.slice(i, j))) { dp[i] = true; break }
    }
    if (!dp[i] && str[i] === ' ') dp[i] = dp[i + 1]
  }
  return dp[0]
}
const uncovered = []
let coveredN = 0
for (const it of opt.items) {
  const str = it.toks.map(t => t.text ?? t.lit).join('').trim()
  if (covered(str)) coveredN += it.n
  else uncovered.push([str, it.n])
}
console.log(`  커버리지 ${((coveredN / totalUtter) * 100).toFixed(2)}% (${coveredN}/${totalUtter})`)
if (uncovered.length) {
  console.error('  ! 덮이지 않는 문장:')
  for (const [str, n] of uncovered.sort((a, b) => b[1] - a[1]).slice(0, 10)) console.error(`    ${n}  ${str}`)
  process.exitCode = 1
}

// 기존 219클립과의 겹침.
const baked = JSON.parse(readFileSync('public/tts/index.json', 'utf8')).clips
const bakedTexts = new Set(Object.keys(baked).map(t => t.trim()))
const reuse = plan.filter(x => bakedTexts.has(x.text))
console.log(`  이미 구운 것 재사용 ${reuse.length}개 → **새로 구울 것 ${plan.length - reuse.length}개**`)

writeFileSync(resolve('docs/audio/tts/live-plan.json'), JSON.stringify({
  seeds: SEEDS, ratio: RATIO, totalUtter, avgSeams: optScore.avgSeams,
  coverage: coveredN / totalUtter,
  // 빈도 내림차순 — 그대로 index.json의 `warm`(미리 받기 순서)이 된다.
  clips: plan,
}, null, 1) + '\n')
console.log('docs/audio/tts/live-plan.json 기록 완료')

const out = resolve(JSON_OUT)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({
  seeds: SEEDS, totalUtter, domain: DOMAIN,
  designs: rows.map(([label, s]) => ({ label, clips: s.clips, seams: s.seams, avgSeams: s.avgSeams })),
  merges: opt.merges,
  finalBySlot: bySlot,
  // 발화 전량은 싣지 않는다 — 200시드면 900KB고, 언제든 이 도구로 다시 뽑을 수 있다.
  // 필요하면 `--dump-speeches`로 따로 받는다.
  ...(process.argv.includes('--dump-speeches')
    ? { speeches: { caster: Object.fromEntries(corpus.caster), analyst: Object.fromEntries(corpus.analyst) } }
    : {}),
}, null, 1) + '\n')
console.log(`\n${JSON_OUT} 기록 완료`)

await server.close()
