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

// ── 세트피스는 **규칙상 예외**다(11라운드 추가) ───────────────────────────
// 경기 규칙 11조: 코너킥에서 나온 공을 직접 받는 선수는 오프사이드가 아니다.
// 위 스윕은 오픈플레이 이벤트만 만들므로 이 예외를 **한 번도 지나가지 않는다** —
// "통과했으니 안다"가 아니라 검증한 적이 없는 것이다. 여기서 명시적으로 확인한다:
// 세트피스 사건(`detail:'setpiece'`·`corner`)에는 상한이 걸리지 않아야 하고,
// 그 결과 마무리 배역이 수비 라인 앞에 서는 키프레임이 **정상**으로 남아야 한다.
{
  const st = structuredClone(base)
  st.away.tactics.instructions = { ...st.away.tactics.instructions, lineHeight: 90 }
  const line = offsideLineFor(st.away, true)
  let spFrames = 0, ahead = 0
  for (const route of ['near', 'far', 'short']) {
    for (const boxLoad of ['light', 'normal', 'heavy']) {
      st.home.tactics.setPiece = { route, boxLoad }
      for (const minute of MINUTES) {
        for (const [type, detail] of [['goal', 'setpiece'], ['save', 'setpiece'], ['miss', 'setpiece'], ['corner', undefined]]) {
          const shooter = st.home.tactics.lineup[9].playerId
          const ev = { minute, type, teamId: type === 'save' ? away.id : home.id, playerId: shooter, ...(detail ? { detail } : {}) }
          const seq = buildSequence(ev, st.home, st.away)
          for (const p of seq) {
            const m = p.movers.find(mv => mv.playerId === shooter)
            if (!m) continue
            spFrames++
            // 기준은 **뒤에서 두 번째 수비수**만이다. 볼 x를 함께 넣으면 안 된다 —
            // 코너는 볼이 바이라인에 있어 누구나 "공보다 뒤"가 되고, 그러면 상한이
            // 걸려 있어도 이 지표가 0으로 나와 아무것도 증명하지 못한다.
            if (m.x > line) ahead++
          }
        }
      }
    }
  }
  console.log(`\n세트피스 예외 — 검사 키프레임 ${spFrames.toLocaleString()} · 수비 라인 앞 ${ahead.toLocaleString()}`)
  console.log(`  수비 라인(lh 90) x=${line.toFixed(1)}. 코너킥에 오프사이드는 없으므로 이 ${ahead}건은 **위반이 아니다**.`)
  console.log(ahead > 0 ? '  예외가 실제로 작동한다 ✓ (상한이 걸렸다면 0이어야 한다)' : '  ★ 상한이 걸려 있다 — 코너에서 문전 침투가 잘려 나간다')
}
await server.close()
