#!/usr/bin/env node
// tools/team-balance/reorder.mjs
//
// data/teams/*.json의 `squad` 배열을 **등번호순 → 뎁스 차트순**으로 다시 쓴다.
//
// 왜 배열 순서가 전력인가:
//   engine/fitness.positionFitness는 **자질을 보지 않는다** — 슬롯과 포지션이 같으면
//   누구든 1.0이다. 그래서 engine/lineup.pickBestXI의 정렬은 동점 투성이가 되고,
//   Array#sort가 안정 정렬이라 **배열에 먼저 적힌 사람이 선발**이 된다.
//   12개 팀 JSON이 전부 등번호순으로 적혀 있었으므로, 모든 팀이 "등번호가 빠른 XI"를
//   내보내고 있었다. 아르헨티나가 E.마르티네스·엔소·맥알리스터·라우타로·로메로를 전부
//   벤치에 두고 뛴 것이 그 결과다(등번호 20·22·23·24가 뒤에 적혀 있다).
//
// 무엇을 정본으로 쓰는가:
//   profile.signatureXI. 각 팀 JSON이 이미 "그 팀의 선발 11명"을 적어 두고 있었으나
//   저장소 어디서도 읽지 않는 죽은 데이터였다(grep 결과 소비처 0곳).
//   이 스크립트는 signatureXI를 포메이션 슬롯에 최적 배정(헝가리언 대신 완전 탐색 대신
//   탐욕+교환 개선)한 뒤 그 순서로 배열 앞에 놓고, 나머지는 포지션별 존 지표 내림차순으로
//   뒤에 붙인다. GK는 반드시 index 0에 온다(squad[0]이 GK라고 가정하는 테스트가 있다).
//
// 결정론: 난수 없음. 입력 JSON만으로 출력이 정해진다.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'

const DIR = 'data/teams'
const XI_SLOTS = {
  '4-3-3':   ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST'],
  '4-2-3-1': ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'DM', 'LW', 'AM', 'RW', 'ST'],
  '4-4-2':   ['GK', 'CB', 'CB', 'LB', 'RB', 'LW', 'CM', 'CM', 'RW', 'ST', 'ST'],
  '3-5-2':   ['GK', 'CB', 'CB', 'CB', 'LW', 'DM', 'CM', 'CM', 'RW', 'ST', 'ST'],
  '4-1-4-1': ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'LW', 'CM', 'CM', 'RW', 'ST'],
  '5-4-1':   ['GK', 'CB', 'CB', 'CB', 'LB', 'RB', 'LW', 'CM', 'CM', 'RW', 'ST'],
}
const FORMATION_MAP = { '4-2-2-2': '4-4-2', '3-4-2-1': '3-5-2', '4-1-3-2': '4-4-2', '3-1-4-2': '3-5-2' }
const mapFormation = (p) => (p in XI_SLOTS ? p : FORMATION_MAP[p] ?? '4-4-2')

const ADJACENT = {
  GK: [], CB: ['DM'], LB: ['LW', 'CB'], RB: ['RW', 'CB'],
  DM: ['CM', 'CB'], CM: ['DM', 'AM'], AM: ['CM', 'ST', 'LW', 'RW'],
  LW: ['ST', 'AM', 'LB'], RW: ['ST', 'AM', 'RB'], ST: ['LW', 'RW', 'AM'],
}
function fitness(p, slot) {
  if ((p.position === 'GK') !== (slot === 'GK')) return 0.2
  if (p.position === slot) return 1.0
  if ((p.altPositions ?? []).includes(slot)) return 0.85
  if (ADJACENT[p.position].includes(slot) || ADJACENT[slot].includes(p.position)) return 0.65
  return 0.4
}
// 존 가중(engine/strength.ZONE_WEIGHT)과 같은 축으로 매긴 뎁스 지표.
const ZONE_OF = { GK: 'gk', CB: 'defense', LB: 'defense', RB: 'defense', DM: 'midfield', CM: 'midfield', AM: 'midfield', LW: 'attack', RW: 'attack', ST: 'attack' }
const ZONE_WEIGHT = { defense: ['defending', 'physical', 'pace'], midfield: ['passing', 'dribbling', 'defending'], attack: ['shooting', 'dribbling', 'pace'] }
function depth(p) {
  if (p.position === 'GK') return p.gkStats.saving * 0.6 + p.gkStats.aerial * 0.25 + p.gkStats.buildup * 0.15
  const keys = ZONE_WEIGHT[ZONE_OF[p.position]]
  return keys.reduce((s, k) => s + p.stats[k], 0) / keys.length
}

/** signatureXI 11명을 슬롯에 배정한다. 탐욕(적합도 내림차순) 후 2-교환으로 개선한다. */
function assign(players, slots) {
  const n = slots.length
  const order = [...players.keys()]
  const perm = new Array(n).fill(null)
  const taken = new Set()
  // 적합도가 유일하게 높은 슬롯부터 채운다(GK → 정포지션 → 대체).
  const pairs = []
  for (let s = 0; s < n; s++) for (const i of order) pairs.push({ s, i, f: fitness(players[i], slots[s]) })
  pairs.sort((a, b) => b.f - a.f || a.s - b.s || a.i - b.i)
  for (const { s, i } of pairs) { if (perm[s] === null && !taken.has(i)) { perm[s] = i; taken.add(i) } }
  // 적합도 합이 1순위, 동점이면 뎁스 지표 합이 2순위(ε 가중). 동점 배정이 흔하다 —
  // 아르헨티나의 CM 슬롯 2개에 맥알리스터·데 파울·엔소가 전부 1.0으로 들어오는 식이다.
  const score = (pm) => pm.reduce((t, i, s) => t + fitness(players[i], slots[s]) + depth(players[i]) * 1e-4, 0)
  for (let pass = 0; pass < 4; pass++) {
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const cand = perm.slice(); [cand[a], cand[b]] = [cand[b], cand[a]]
      if (score(cand) > score(perm) + 1e-9) { perm[a] = cand[a]; perm[b] = cand[b] }
    }
  }
  return perm.map(i => players[i])
}

/** engine/lineup.pickBestXI를 그대로 흉내 낸다(안정 정렬 = 배열 순서 우선). */
function greedyXI(squad, slots) {
  const used = new Set()
  return slots.map(slot => {
    const c = squad.filter(p => !used.has(p.id))
      .map((p, i) => ({ p, i, f: fitness(p, slot) }))
      .sort((a, b) => b.f - a.f || a.i - b.i)[0].p
    used.add(c.id)
    return c
  })
}

/**
 * 배열 순서를 고쳐 의도한 선발이 실제로 뽑히게 한다.
 * 탐욕 선정은 슬롯을 앞에서부터 채우므로, 앞 슬롯이 뒤 슬롯의 주인을 먼저 데려가 버린다
 * (모로코: LB 슬롯이 마즈라위를 먼저 쓰면 RB에 하키미 대신 남은 사람이 온다).
 *  · 의도한 선수의 적합도가 실제 선택자와 같거나 높으면 → 그 앞으로 옮긴다(순서 문제).
 *  · 낮으면 → 포지션 적합도로 진 것이라 순서로 뒤집을 수 없다. 포기하고 그 선수를
 *    선발 블록 맨 뒤로 내려 **뒤 슬롯을 훔치지 않게** 한다.
 */
function repair(squad, slots, intended) {
  let arr = squad.slice()
  for (let iter = 0; iter < 40; iter++) {
    const got = greedyXI(arr, slots)
    let changed = false
    for (let s = 0; s < slots.length; s++) {
      const want = intended[s]
      if (!want || got[s].id === want.id) continue
      const idxOf = (p) => arr.findIndex(q => q.id === p.id)
      const wi = idxOf(want), gi = idxOf(got[s])
      const move = (from, to) => { const [p] = arr.splice(from, 1); arr.splice(to > from ? to - 1 : to, 0, p) }
      if (fitness(want, slots[s]) >= fitness(got[s], slots[s])) move(wi, gi)
      else move(wi, slots.length) // 선발 블록 밖으로
      changed = true
      break
    }
    if (!changed) return arr
  }
  return arr
}

for (const file of readdirSync(DIR).filter(f => f.endsWith('.json')).sort()) {
  const path = `${DIR}/${file}`
  const raw = readFileSync(path, 'utf8')
  const d = JSON.parse(raw)
  const slots = XI_SLOTS[mapFormation(d.profile.preferredFormations[0])]
  const byId = new Map(d.squad.map(p => [p.id, p]))
  const sig = d.profile.signatureXI.map(id => byId.get(id)).filter(Boolean)
  const starters = assign(sig, slots)
  const startIds = new Set(starters.map(p => p.id))
  // 나머지: GK 먼저(백업 골키퍼는 뎁스순), 그다음 슬롯 순서대로 그 슬롯 최적 백업.
  const rest = d.squad.filter(p => !startIds.has(p.id))
  const restGk = rest.filter(p => p.position === 'GK').sort((a, b) => depth(b) - depth(a))
  const restOut = rest.filter(p => p.position !== 'GK')
  const bench = []
  const used = new Set()
  for (const slot of slots.slice(1)) {
    const c = restOut.filter(p => !used.has(p.id))
      .sort((a, b) => fitness(b, slot) - fitness(a, slot) || depth(b) - depth(a))[0]
    if (c) { bench.push(c); used.add(c.id) }
  }
  for (const p of restOut.filter(p => !used.has(p.id)).sort((a, b) => depth(b) - depth(a))) bench.push(p)
  const ordered = repair([...starters, ...restGk, ...bench], slots, starters)
  if (ordered.length !== d.squad.length) throw new Error(`${file}: 인원 ${d.squad.length} → ${ordered.length}`)
  if (new Set(ordered.map(p => p.id)).size !== ordered.length) throw new Error(`${file}: 중복`)
  if (ordered[0].position !== 'GK') throw new Error(`${file}: squad[0]이 GK가 아니다`)

  // 원본 서식 보존: 선수 한 명이 정확히 한 줄이므로 **줄만 재배열**한다.
  // JSON.stringify로 다시 쓰면 인라인 객체가 전부 펼쳐져 파일이 45% 부풀고 diff를 읽을 수 없다.
  const lines = raw.split('\n')
  const head = lines.findIndex(l => l.includes('"squad": ['))
  let tail = head + 1
  while (!/^\s*\],?\s*$/.test(lines[tail])) tail++
  const body = lines.slice(head + 1, tail)
  if (body.length !== d.squad.length) throw new Error(`${file}: 줄 수 ${body.length} ≠ 인원 ${d.squad.length}`)
  const lineById = new Map()
  for (const l of body) {
    const m = l.match(/"id":\s*"([^"]+)"/)
    if (!m) throw new Error(`${file}: id 없는 줄`)
    lineById.set(m[1], l.replace(/,\s*$/, ''))
  }
  const rebuilt = ordered.map((p, i) => lineById.get(p.id) + (i === ordered.length - 1 ? '' : ','))
  const out = [...lines.slice(0, head + 1), ...rebuilt, ...lines.slice(tail)].join('\n')
  JSON.parse(out) // 파싱 검증
  writeFileSync(path, out)
  console.log(`${d.id}: ${slots.join('/')} → ${starters.map(p => p.name.en.split(' ').pop()).join(', ')}`)
}
