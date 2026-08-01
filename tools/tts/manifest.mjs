#!/usr/bin/env node
// tools/tts/manifest.mjs
// **내일 아침에 무엇을 몇 번의 요청으로 어떤 순서로 굽는가**를 확정한다.
// roster.mjs(누구 이름이 불리는가)와 inventory.mjs(어떤 문장이 나오는가)의 실측을
// 받아 배치(=API 요청 1회) 목록으로 접는다.
//
// ## 두 종류의 배치 — 조각 수가 다르므로 절대 섞지 않는다
//  · plain   : 완결 문장 N개를 한 번에 읽힌다. 문장 사이 무음으로 갈라 **조각 N개**.
//  · carrier : `A …… B` 캐리어 N개. 말줄임표 쉼까지 갈라 **조각 2N개**.
//              머리(head)를 쓰면 문중(연속) 억양, 꼬리(tail)를 쓰면 문말(하강) 억양이다.
//              docs/audio/tts-proto/README.md의 B안이 이것이다.
//
// ## 이름은 두 형태다
//  · `{이름},`      머리 절단. 명단 중간 호명.
//  · `{이름}입니다.` 꼬리 절단. 그룹 마지막 호명 + 골키퍼.
//    ★ 왜 `입니다`를 공용 조각으로 빼지 않는가: `이한범`+`입니다`의 이음매가
//      음절 한복판(범+입 → [버빔])에 떨어져 연음이 깨진다. 조사를 이름 클립에
//      붙인 것과 같은 이유다. 받침 없는 이름은 안 깨지지만 반반으로 갈리는
//      품질은 품질이 아니다.
//
// ## 예산
//  모델당 RPD 10. 캐스터/해설위원이 다른 모델이라 각각 10이다.
//
//   node tools/tts/manifest.mjs [--batch 16] [--scope group|all] [--json docs/audio/tts/manifest.json]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const BATCH = Number(arg('batch', 16))
const SCOPE = arg('scope', 'group')
const JSON_OUT = arg('json', 'docs/audio/tts/manifest.json')
/** 모델별 일일 요청 한도(RPD). 예산이 맞는지 이 값으로 판정한다. */
const RPD = 10

const roster = JSON.parse(readFileSync('docs/audio/tts/roster.json', 'utf8'))
const entrance = JSON.parse(readFileSync('docs/audio/tts/entrance-lines.json', 'utf8'))

const SPEAKERS = {
  caster: { voice: 'Puck', model: 'gemini-2.5-flash-preview-tts', ko: '캐스터' },
  analyst: { voice: 'Iapetus', model: 'gemini-3.1-flash-tts-preview', ko: '해설위원' },
}

/** 클립 키 = 발화 문자열의 해시. 한글 파일명·경로 인코딩 문제를 통째로 피한다. */
const keyOf = (prefix, text) =>
  `${prefix}/${createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 10)}`

// ── 캐리어 ──────────────────────────────────────────────────
// 둘 다 **문법적으로 성립하는 한 문장**이다. 비문을 읽히면 모델이 엉뚱한 억양을 낸다.
/** 머리 절단용 — 앞 조각이 문중 억양으로 나온다. */
const carrierHead = t => `${t} …… 지금 좋습니다.`
/** 꼬리 절단용 — 뒤 조각이 문말 하강 억양으로 나온다. */
const carrierTail = t => `이 선수는 …… ${t}`

// ── 클립 목록 ───────────────────────────────────────────────
/** @type {{key:string,speaker:string,text:string,kind:string,cut:string,carrier:string,tier:number,why:string}[]} */
const carriers = []
const plains = { caster: [], analyst: [] }

// (1) 입장 소개 완결 문장 — plain 배치.
for (const l of entrance.lines) {
  plains[l.speaker].push({
    key: keyOf('t', l.speech), speaker: l.speaker, text: l.speech,
    kind: 'plain', tier: 1, why: '입장 소개 문장',
  })
}

// (2) `골키퍼,` — 모든 입장 소개가 쓰는 유일한 조각. 캐리어 머리 절단.
//     `골키퍼 …… 자리를 잡습니다.`는 문법적으로 온전한 문장이다.
carriers.push({
  key: keyOf('t', '골키퍼,'), speaker: 'caster', text: '골키퍼,',
  kind: 'frag', cut: 'head', carrier: '골키퍼 …… 자리를 잡습니다.',
  tier: 1, why: '골키퍼 도입(모든 경기 공통)',
})

// (3) 이름 — 우선순위 순. 한국이 먼저다(유저 팀이라 언제나 나온다).
const ORDER = SCOPE === 'group'
  ? ['kor', 'cze', 'mex', 'rsa']
  : ['kor', 'cze', 'mex', 'rsa', 'ecu', 'can', 'eng', 'mar', 'nor', 'fra', 'arg', 'esp']
const TIER = { kor: 2, cze: 3, mex: 3, rsa: 3 }

for (const tid of ORDER) {
  const list = roster.clipTargets[tid] ?? []
  const tier = TIER[tid] ?? 4
  for (const p of list) {
    carriers.push({
      key: keyOf('n', `${p.ko},`), speaker: 'caster', text: `${p.ko},`,
      kind: 'name', cut: 'head', carrier: carrierHead(p.ko),
      tier, why: `${tid} 이름(중간 호명)`,
    })
    carriers.push({
      key: keyOf('n', `${p.ko}입니다.`), speaker: 'caster', text: `${p.ko}입니다.`,
      kind: 'name', cut: 'tail', carrier: carrierTail(`${p.ko}입니다.`),
      tier, why: `${tid} 이름(마지막 호명·골키퍼)`,
    })
  }
}

// ── 배치로 접는다 ───────────────────────────────────────────
// plain과 carrier를 절대 섞지 않는다(조각 수가 N vs 2N이라 split이 어긋난다).
const batches = []
const chunk = (arr, n) => {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

const PLAIN_STYLE = '월드컵 중계 방송 톤으로, 또렷하고 차분하게'
const CARRIER_STYLE = '월드컵 중계 방송 톤으로, 또렷하고 차분하게'
/** 말줄임표 쉼 지시 — 실측에서 쉼표(0.34초)는 안 먹고 말줄임표는 0.40~2.59초 쉬었다. */
const CARRIER_INSTR = '말줄임표(……)에서는 반드시 1초 이상 완전히 멈춰라.'

let n = 0
const push = (speaker, kind, items) => {
  const p = speaker === 'caster' ? 'C' : 'A'
  batches.push({
    id: `${p}${String(++n).padStart(2, '0')}`,
    speaker, model: SPEAKERS[speaker].model, voice: SPEAKERS[speaker].voice,
    kind,
    pieces: kind === 'plain' ? 1 : 2,
    style: kind === 'plain' ? PLAIN_STYLE : CARRIER_STYLE,
    extra: kind === 'plain' ? '' : CARRIER_INSTR,
    tier: Math.min(...items.map(i => i.tier)),
    lines: items.map(i => (kind === 'plain' ? i.text : i.carrier)),
    items: items.map(i => ({ key: i.key, text: i.text, kind: i.kind, cut: i.cut ?? null, why: i.why })),
  })
}

// 캐스터: 템플릿(plain) → 이름·조각(carrier) 순. 앞이 없으면 뒤가 쓸모없다.
for (const c of chunk(plains.caster, BATCH)) push('caster', 'plain', c)
for (const c of chunk(carriers.filter(x => x.speaker === 'caster'), BATCH)) push('caster', 'carrier', c)
for (const c of chunk(plains.analyst, BATCH)) push('analyst', 'plain', c)

const manifest = {
  version: 1,
  batchSize: BATCH,
  scope: SCOPE,
  rpd: RPD,
  speakers: SPEAKERS,
  gapMs: 90,
  atempo: 1.15,
  loudnorm: 'I=-16:TP=-1.5:LRA=11',
  batches,
}

// ── 보고 ────────────────────────────────────────────────────
const byS = s => batches.filter(b => b.speaker === s)
const clips = batches.reduce((a, b) => a + b.items.length, 0)

console.log(`\n# TTS 생성 매니페스트 — scope=${SCOPE}, 배치 ${BATCH}\n`)
console.log('| 배치 | 화자 | 종류 | 문장 | 클립 | 티어 | 내용 |')
console.log('|---|---|---|---:|---:|---:|---|')
for (const b of batches) {
  const why = [...new Set(b.items.map(i => i.why))]
  console.log(`| ${b.id} | ${SPEAKERS[b.speaker].ko} | ${b.kind} | ${b.lines.length} | ${b.items.length} | T${b.tier} | ${why.slice(0, 2).join(' / ')}${why.length > 2 ? ` 외 ${why.length - 2}` : ''} |`)
}
// ── 배포 용량 추정 ──────────────────────────────────────────
// 발화 길이는 commentary-tts.SYLLABLES_PER_SEC(5.6음절/초, 브라우저 실측)로 재고,
// atempo 1.15로 나눈 뒤 mp3 64k(=8KB/초)를 곱한다. 앞뒤 무음은 깎이므로 꼬리 여유는 없다.
const SYL_PER_SEC = 5.6
const KB_PER_SEC = 8
const syllables = t => [...t].filter(c => {
  const c0 = c.codePointAt(0)
  return c0 >= 0xac00 && c0 <= 0xd7a3
}).length
let bytes = 0
for (const b of batches) for (const i of b.items) {
  bytes += (syllables(i.text) / SYL_PER_SEC / 1.15) * KB_PER_SEC * 1024
}

console.log(`\n총 클립 ${clips}개 / 요청 ${batches.length}회`)
console.log(`추정 배포 용량 ${(bytes / 1024 / 1024).toFixed(2)} MB (mp3 64k · 24kHz 모노, public/tts/**)`)
for (const s of ['caster', 'analyst']) {
  const bs = byS(s)
  const days = Math.ceil(bs.length / RPD)
  console.log(`  ${SPEAKERS[s].ko.padEnd(5)} ${SPEAKERS[s].model.padEnd(32)} 요청 ${String(bs.length).padStart(2)}회 / RPD ${RPD} → **${days}일** ${bs.length <= RPD ? '(하루에 들어간다)' : '(초과)'}`)
}

const out = resolve(JSON_OUT)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(manifest, null, 1) + '\n')
console.log(`\n${JSON_OUT} 기록.`)
