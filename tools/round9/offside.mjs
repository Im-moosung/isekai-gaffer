#!/usr/bin/env node
// tools/round9/offside.mjs — 오프사이드 전수 검증(계열 10종 · 존 2종까지 포함).
// scenes.test.ts의 같은 스윕을 스크립트로 돌려 **검사 키프레임 수와 최악 위반**을 낸다.
import { createServer } from 'vite'
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = p => server.ssrLoadModule(p)
const { makeTestTeam } = await L('/src/engine/fixtures/testTeams.ts')
const sim = await L('/src/engine/simulate.ts')
const { buildSequence, offsideLineFor } = await L('/src/ui/pitch/choreography.ts')
const { XI_SLOTS } = await L('/src/ui/pitch/formations.ts')

const home = makeTestTeam('kor', 82), away = makeTestTeam('esp', 84)
const base = sim.createMatch(home, away, { seed: 42 })
const FORMATIONS = Object.keys(XI_SLOTS)
const PATTERNS = ['balanced', 'cross', 'through', 'longshot']
const FOCI = ['left', 'center', 'right', 'balanced']
const TYPES = ['goal', 'save', 'miss', 'shot', 'chance']
// 분을 넓게 잡아 계열·존·루트 해시 조합을 전수에 가깝게 훑는다.
const MINUTES = Array.from({ length: 20 }, (_, i) => 3 + i * 4)

let checked = 0, worst = -Infinity, worstTag = ''
for (const formation of FORMATIONS) {
  for (let lh = 10; lh <= 90; lh += 10) {
    const st = structuredClone(base)
    st.away.tactics.formation = formation
    st.away.tactics.instructions = { ...st.away.tactics.instructions, lineHeight: lh }
    const line = offsideLineFor(st.away, true)
    for (const focus of FOCI) {
      st.home.tactics.instructions = { ...st.home.tactics.instructions, attackFocus: focus }
      for (const pattern of PATTERNS) {
        st.home.tactics.attackPattern = pattern
        for (const minute of MINUTES) {
          for (const type of TYPES) {
            const shooter = st.home.tactics.lineup[9].playerId
            const seq = buildSequence({ minute, type, teamId: home.id, playerId: shooter }, st.home, st.away)
            for (let k = 0; k + 1 < seq.length; k++) {
              const p = seq[k]
              if (!p.carrier || p.carrier === shooter) continue
              const m = p.movers.find(mv => mv.playerId === shooter)
              if (!m) continue
              const cap = Math.max(line, p.ball.x, 50)
              checked++
              const gap = m.x - cap
              if (gap > worst) { worst = gap; worstTag = `${formation}/lh${lh}/${focus}/${pattern}/${minute}:${type}/k${k}` }
            }
          }
        }
      }
    }
  }
}
console.log(`검사 키프레임 ${checked.toLocaleString()} · 최악 여유 ${worst.toFixed(3)} units (${worstTag})`)
console.log(worst <= 0 ? '위반 0 ✓' : '★ 위반 발생')
await server.close()
