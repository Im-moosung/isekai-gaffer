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
const has = n => process.argv.includes(`--${n}`)
/** plain(완결 문장) 배치 크기. 문장끼리는 각자 완결된 발화라 음역 흩어짐에 덜 민감하다. */
const PLAIN_BATCH = Number(arg('plain-batch', 16))
/**
 * carrier(이름·조각) 배치 크기. **여기가 위험한 축이다.**
 * 프로토 실측: 2~4개는 템플릿과 2반음 이내, 16개는 3.2~13.2반음으로 흩어져
 * `--match-register`(±5반음)로도 12/16이 구제 불가였다. 5~15는 미측정 구간이다.
 */
const CARRIER_BATCH = Number(arg('carrier-batch', arg('batch', 12)))
/** 미측정 구간을 재는 모드 — 첫 두 캐리어 배치를 8개·12개로 고정한다.
 *  ★ 탐침도 **실제 우선순위 앞쪽**을 굽는다. 버리는 요청이 하나도 없게. */
const PROBE = has('probe')
const SCOPE = arg('scope', 'group')
const JSON_OUT = arg('json', 'docs/audio/tts/manifest.json')
/** 모델별 일일 요청 한도(RPD). */
const RPD = 10
/**
 * 마감까지 쓸 수 있는 **총** 캐스터 요청 수.
 * 한도 창이 둘이다(실측 2026-08-01 00:45 PDT — 자정을 넘겨 이미 리셋됐다):
 *   · PDT 08-01 (지금 ~ KST 08-02 16:00)  10회
 *   · PDT 08-02 (KST 08-02 16:00 ~ 마감)  10회
 * 마감 KST 08-03 10:00 = PDT 08-02 17:00이라 두 창 다 마감 전이다.
 */
const BUDGET = Number(arg('budget', 20))

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

// ★ **실제로 발화되는 문자열만** 굽는다. `entrance-lines.json.nameLines`는 런타임이
//   부르는 `lineupIntroBeats`에서 그대로 뽑은 집합이라 어긋날 수 없다.
//   AI 팀은 XI가 결정론이라 `{이름}입니다.`가 4명(골키퍼 + 세 그룹의 마지막)에만
//   필요하다 — 전원에게 두 형태를 구우면 팀당 22개, 실측대로면 **11개**다.
//   한국만 26명 × 2형태다(유저가 슬롯을 통째로 바꾼다 — 여기만 상한이다).
// 순서는 roster의 스쿼드 순서를 따른다. **이미 구워 둔 배치의 구성이 바뀌면 안 되므로**
// 정렬 규칙을 함부로 바꾸지 마라(원본 wav와 배치 정의가 어긋나 엉뚱한 이름이 나간다).
for (const tid of ORDER) {
  const spoken = new Set(entrance.nameLines?.[tid] ?? [])
  const list = roster.clipTargets[tid] ?? []
  const tier = TIER[tid] ?? 4
  for (const p of list) {
    const mid = `${p.ko},`
    const fin = `${p.ko}입니다.`
    if (spoken.has(mid)) {
      carriers.push({
        key: keyOf('n', mid), speaker: 'caster', text: mid,
        kind: 'name', cut: 'head', carrier: carrierHead(p.ko),
        tier, why: `${tid} 이름(중간 호명)`,
      })
    }
    if (spoken.has(fin)) {
      carriers.push({
        key: keyOf('n', fin), speaker: 'caster', text: fin,
        kind: 'name', cut: 'tail', carrier: carrierTail(fin),
        tier, why: `${tid} 이름(마지막 호명·골키퍼)`,
      })
    }
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

// ★ 스타일 문구는 **프로토가 실제로 200을 받은 것을 그대로** 쓴다(tools/tts/proto.py).
//   손으로 다시 쓰면 안 된다 — 처음에 "말줄임표에서 1초 이상 멈춰라"로만 줄였다가
//   HTTP 400 `Model tried to generate text, but it should only be used for TTS`로
//   요청 하나를 태웠다. `……`를 **소리 내어 읽지 말라**는 말이 빠지면 모델이 그 자리를
//   "채워 넣으라는 지시"로 읽는다.
const PLAIN_STYLE = { caster: '축구 중계 캐스터처럼 생생하게 읽어라.', analyst: '축구 중계 해설위원처럼 차분하게 짚어 읽어라.' }
const CARRIER_STYLE = {
  caster: '축구 중계 캐스터의 목소리로 읽어라. 말줄임표(……)는 소리 내어 읽지 말고 '
    + '그 자리에서 1초 이상 완전히 쉬어라. 말줄임표 앞뒤는 한 문장이니, '
    + '말줄임표 앞에서 어조를 내리지 말고 뒤도 새 문장처럼 높여 시작하지 마라.',
  analyst: '축구 중계 해설위원의 차분한 목소리로 읽어라. 말줄임표(……)는 소리 내어 읽지 말고 '
    + '그 자리에서 1초 이상 완전히 쉬어라. 말줄임표 앞뒤는 한 문장이니, '
    + '말줄임표 앞에서 어조를 내리지 말고 뒤도 새 문장처럼 높여 시작하지 마라.',
}

let n = 0
const push = (speaker, kind, items) => {
  const p = speaker === 'caster' ? 'C' : 'A'
  batches.push({
    id: `${p}${String(++n).padStart(2, '0')}`,
    speaker, model: SPEAKERS[speaker].model, voice: SPEAKERS[speaker].voice,
    kind,
    pieces: kind === 'plain' ? 1 : 2,
    style: (kind === 'plain' ? PLAIN_STYLE : CARRIER_STYLE)[speaker],
    extra: '',
    tier: Math.min(...items.map(i => i.tier)),
    lines: items.map(i => (kind === 'plain' ? i.text : i.carrier)),
    items: items.map(i => ({ key: i.key, text: i.text, kind: i.kind, cut: i.cut ?? null, why: i.why })),
  })
}

/** 캐리어를 앞에서부터 잘라 낸다. probe면 첫 두 덩이를 8·12로 고정한다. */
function carrierChunks(list) {
  if (!PROBE) return chunk(list, CARRIER_BATCH)
  const out = [list.slice(0, 8), list.slice(8, 20)]
  return [...out.filter(c => c.length > 0), ...chunk(list.slice(20), CARRIER_BATCH)]
}

// 캐스터: 템플릿(plain) → 이름·조각(carrier) 순. 앞이 없으면 뒤가 쓸모없다.
// ★ 이 순서가 곧 우선순위다. 한도가 끊겨 뒤가 잘려도 앞은 그대로 쓸 수 있다.
for (const c of chunk(plains.caster, PLAIN_BATCH)) push('caster', 'plain', c)
for (const c of carrierChunks(carriers.filter(x => x.speaker === 'caster'))) push('caster', 'carrier', c)
for (const c of chunk(plains.analyst, PLAIN_BATCH)) push('analyst', 'plain', c)

const manifest = {
  version: 1,
  plainBatch: PLAIN_BATCH,
  carrierBatch: CARRIER_BATCH,
  probe: PROBE,
  scope: SCOPE,
  rpd: RPD,
  budget: BUDGET,
  speakers: SPEAKERS,
  gapMs: 90,
  atempo: 1.15,
  loudnorm: 'I=-16:TP=-1.5:LRA=11',
  batches,
}

// ── 보고 ────────────────────────────────────────────────────
const byS = s => batches.filter(b => b.speaker === s)
const clips = batches.reduce((a, b) => a + b.items.length, 0)

console.log(`\n# TTS 생성 매니페스트 — scope=${SCOPE}, plain ${PLAIN_BATCH} / carrier ${CARRIER_BATCH}${PROBE ? " (probe 8·12 선행)" : ""}\n`)
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
  const windows = Math.ceil(bs.length / RPD)
  const fits = bs.length <= BUDGET
  console.log(`  ${SPEAKERS[s].ko.padEnd(5)} ${SPEAKERS[s].model.padEnd(32)} 요청 ${String(bs.length).padStart(2)}회 `
    + `/ 창 ${windows}개(RPD ${RPD}) / 예산 ${BUDGET} → ${fits ? `**들어간다** (여유 ${BUDGET - bs.length})` : '**초과**'}`)
}

const out = resolve(JSON_OUT)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(manifest, null, 1) + '\n')
console.log(`\n${JSON_OUT} 기록.`)
