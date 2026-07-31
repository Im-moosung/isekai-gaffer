#!/usr/bin/env node
// 도트 은폐 실측 — **팀 간 포함**. e04274e가 쓴 것과 같은 표본 규모(1224 케이스).
//
// 왜 다시 재는가: e04274e는 `separateDots`를 **작전판(analysis)에서만** 걸었다.
// 이름표를 켠 나머지 보드(전술판 TacticsBoard, 하이라이트 2D)는 분리 없이 그려졌고,
// 그쪽에서는 어웨이 도트를 마지막에 그려 **우리 도트가 통째로 가려졌다**(감사 ⑨).
//
// 케이스: 뷰포트 4 × 포메이션 6 × 압박 {0,50,100} × 라인 {10,15,…,90} = 1224.
// 뷰포트는 SVG 균일 스케일이라 좌표를 바꾸지 않지만, e04274e와 표본 수를 맞추려고 곱한다.
//
// 사용: node tools/match-layout/dots.mjs [--mode raw|sep]
import { createServer } from 'vite'

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d }
const MODE = arg('--mode', 'sep')

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const L = p => server.ssrLoadModule(p)
const { tacticalCoords, separateDots, dotOverlapRatio } = await L('/src/ui/pitch/shape.ts')
const { XI_SLOTS } = await L('/src/ui/pitch/formations.ts')

const VPS = ['3456x2234', '1920x1080', '1440x900', '390x844']
const FORMS = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']
const PRESS = [0, 50, 100]
const LINES = Array.from({ length: 17 }, (_, i) => 10 + i * 5)

const VB_X = 1.05
const VB_Y = 0.68
const dist = (a, b) => Math.hypot((a.x - b.x) * VB_X, (a.y - b.y) * VB_Y)

let cases = 0
let pairs = 0
let minD = Infinity
let maxOv = 0
let hidden = 0        // 겹침 50% 초과 = "한 명이 사라진다"
let crossHidden = 0   // 그중 팀 간
let near = 0          // 3.6m 안쪽(경합으로 남기는 것)
let crossMinD = Infinity
const perCaseMin = []

for (const _vp of VPS) {
  void _vp
  for (const f of FORMS) {
    for (const P of PRESS) {
      for (const Lh of LINES) {
        const n = XI_SLOTS[f].length
        const ins = { lineHeight: Lh, pressing: P, tempo: 50, attackFocus: 'balanced' }
        // 어웨이는 거울 전술(라인 100-L) — 실제 경기에서 두 블록이 만나는 배치다.
        const insA = { ...ins, lineHeight: 100 - Lh }
        const home = Array.from({ length: n }, (_, i) => tacticalCoords(f, i, 'home', ins))
        const away = Array.from({ length: n }, (_, i) => tacticalCoords(f, i, 'away', insA))
        const all = MODE === 'raw' ? [...home, ...away] : separateDots([...home, ...away])
        cases++
        let caseMin = Infinity
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const d = dist(all[i], all[j])
            const ov = dotOverlapRatio(all[i], all[j])
            const cross = (i < n) !== (j < n)
            pairs++
            if (d < minD) minD = d
            if (d < caseMin) caseMin = d
            if (ov > maxOv) maxOv = ov
            if (ov > 0.5) { hidden++; if (cross) crossHidden++ }
            if (d < 3.6) near++
            if (cross && d < crossMinD) crossMinD = d
          }
        }
        perCaseMin.push(caseMin)
      }
    }
  }
}

const under = t => perCaseMin.filter(v => v < t).length
console.log(`mode=${MODE}  케이스 ${cases} · 쌍 ${pairs}`)
console.log(`최소 중심 거리       ${minD.toFixed(2)} m`)
console.log(`  그중 팀 간         ${crossMinD.toFixed(2)} m`)
console.log(`최대 겹침 면적       ${(maxOv * 100).toFixed(1)} %`)
console.log(`50% 넘게 가린 쌍     ${hidden}  (팀 간 ${crossHidden})`)
console.log(`3.6m 안쪽 쌍         ${near}`)
console.log(`케이스 최소거리 <3m  ${under(3)} / <2m ${under(2)} / <1m ${under(1)}`)

await server.close()
