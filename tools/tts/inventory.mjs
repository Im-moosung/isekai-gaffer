#!/usr/bin/env node
// tools/tts/inventory.mjs
// 입장 소개(lineupIntroBeats)가 실제로 발화하는 **문장 전체 집합**을 프로덕션 코드에서
// 뽑아낸다. 손으로 옮겨 적으면 반드시 어긋난다 — 어긋나면 mp3가 없는 문장이 생기고,
// 그 한 줄만 로봇 목소리로 튄다.
//
// 12팀 × (pickBestXI가 뽑는 포메이션)으로 소개 비트를 만들고, 이름 비트를 빼고
// 남은 문장을 중복 제거해 목록으로 낸다.
//
//   node tools/tts/inventory.mjs [--json docs/audio/tts/entrance-lines.json]
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const JSON_OUT = arg('json', 'docs/audio/tts/entrance-lines.json')

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam } = await server.ssrLoadModule('/src/data/loader.ts')
const { pickBestXI } = await server.ssrLoadModule('/src/engine/lineup.ts')
const { lineupIntroBeats } = await server.ssrLoadModule('/src/game/commentary.ts')

const IDS = ['kor', 'cze', 'mex', 'rsa', 'ecu', 'eng', 'nor', 'arg', 'esp', 'can', 'mar', 'fra']

/** 유저가 고를 수 있는 포메이션 전부 — 한국은 작전판에서 바꾼다. */
const { XI_SLOTS } = await server.ssrLoadModule('/src/engine/formations.ts')
const ALL_FORMATIONS = Object.keys(XI_SLOTS)

const tplLines = new Map()   // speech → { speaker, from:Set }
const formations = new Set()
const teamsKo = []

const add = (speech, speaker, from) => {
  const e = tplLines.get(speech) ?? { speaker, from: new Set() }
  e.from.add(from)
  tplLines.set(speech, e)
}

for (const id of IDS) {
  const team = loadTeam(id)
  teamsKo.push({ id, ko: team.name.ko })
  // 그 팀이 실제로 설 수 있는 포메이션: AI는 pickBestXI 기본값 하나, 한국은 전부.
  const fs = id === 'kor' ? ALL_FORMATIONS : [pickBestXI(team).formation]
  for (const f of fs) {
    formations.add(f)
    const t = pickBestXI(team, f)
    const members = t.lineup.map(s => {
      const p = team.squad.find(x => x.id === s.playerId)
      return { id: p.id, number: p.number, nameKo: p.name.ko, position: p.position }
    })
    for (const b of lineupIntroBeats(team.name.ko, f, members)) {
      if (b.kind === 'name') continue
      add(b.speech, b.speaker, `${id}/${f}`)
    }
  }
}

const rows = [...tplLines.entries()].map(([speech, v]) => ({
  speech, speaker: v.speaker, from: [...v.from].slice(0, 3), n: v.from.size,
})).sort((a, b) => (a.speaker === b.speaker ? b.n - a.n : a.speaker < b.speaker ? -1 : 1))

console.log(`\n# 입장 소개 템플릿 문장 (이름 비트 제외) — ${rows.length}개\n`)
console.log('| 화자 | 문장 | 쓰이는 조합 |')
console.log('|---|---|---:|')
for (const r of rows) console.log(`| ${r.speaker} | ${r.speech} | ${r.n} |`)

const byS = s => rows.filter(r => r.speaker === s).length
console.log(`\n캐스터 ${byS('caster')}문장 / 해설위원 ${byS('analyst')}문장`)
console.log(`포메이션 ${formations.size}종: ${[...formations].join(', ')}`)

const out = resolve(JSON_OUT)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ teams: teamsKo, formations: [...formations], lines: rows }, null, 1) + '\n')
console.log(`\n${JSON_OUT} 기록.`)

await server.close()
