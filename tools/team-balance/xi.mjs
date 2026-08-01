#!/usr/bin/env node
// tools/team-balance/xi.mjs
// 각 팀이 실제로 내보내는 XI를 찍는다. positionFitness는 **자질을 보지 않으므로**
// (같은 포지션이면 전원 1.0) pickBestXI는 사실상 squad 배열 순서로 뽑는다.
// 즉 JSON의 선수 나열 순서가 곧 뎁스 차트다 — 이 스크립트는 그 결과를 눈으로 확인시킨다.
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam, TEAM_IDS } = await server.ssrLoadModule('/src/data/loader.ts')
const { pickBestXI } = await server.ssrLoadModule('/src/engine/lineup.ts')

const rate = (p) => p.gkStats
  ? (p.gkStats.saving * 0.6 + p.gkStats.aerial * 0.25 + p.gkStats.buildup * 0.15)
  : (p.stats.shooting + p.stats.passing + p.stats.dribbling + p.stats.defending + p.stats.physical + p.stats.pace) / 6

const only = process.argv[2]
for (const id of TEAM_IDS) {
  if (only && id !== only) continue
  const t = loadTeam(id)
  const xi = pickBestXI(t)
  const inXI = new Set(xi.lineup.map(l => l.playerId))
  console.log(`\n=== ${id} (FIFA ${t.fifaRanking}) ${xi.formation}  pref=${t.profile.preferredFormations[0]}`)
  for (const { slot, playerId } of xi.lineup) {
    const p = t.squad.find(q => q.id === playerId)
    console.log(`  ${slot.padEnd(3)} ${p.name.en.padEnd(24)} ${String(rate(p).toFixed(1)).padStart(5)}  ${p.club}`)
  }
  const bench = t.squad.filter(p => !inXI.has(p.id)).sort((a, b) => rate(b) - rate(a)).slice(0, 6)
  console.log('  -- 벤치 상위:', bench.map(p => `${p.name.en}(${p.position} ${rate(p).toFixed(1)})`).join(', '))
  const sig = t.profile.signatureXI ?? []
  const missing = sig.filter(pid => !inXI.has(pid)).map(pid => t.squad.find(q => q.id === pid)?.name.en)
  if (missing.length) console.log('  !! signatureXI인데 XI에 없음:', missing.join(', '))
}
await server.close()
