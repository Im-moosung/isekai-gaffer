#!/usr/bin/env node
// tools/cam-bounds/run.mjs
// 카메라 프리셋 경계 검사표 — 모든 연출 모드를 피치 전역 focus 격자 × 시간 × 시드로 훑어
// **최악 케이스**(관중석 좌석 표면 여유가 가장 작은 샷 / 조명탑 마스트에 가장 가까운 샷)를
// 뽑아 마크다운 표로 찍는다. `__tests__/camera-bounds.test.ts`가 통과/실패만 말한다면
// 이 스크립트는 "얼마나 아슬아슬한가"를 숫자로 보여 준다(상수를 조일 때의 근거).
//
// 사용:
//   node tools/cam-bounds/run.mjs
//   node tools/cam-bounds/run.mjs --step 2      # focus 격자 간격(m, 기본 4)
//
// TS 모듈(camera.ts)은 vite의 SSR 로더로 그대로 불러온다 — 새 의존성 없이 프로덕션 코드를
// 있는 그대로 계측하기 위해서다(번들 사본을 재면 의미가 없다).
import { createServer } from 'vite'

// scene.ts 실측치(하드코딩 미러 — camera-bounds.test.ts와 같은 값).
const APRON = 7
const RAKE = 0.5
const STAND_DEPTH = 26
const STAND_H0 = 2.4
const END_INNER = 105 / 2 + APRON
const SIDE_INNER = 68 / 2 + APRON
const MAST_PX = END_INNER + STAND_DEPTH * 0.85
const MAST_PZ = SIDE_INNER + STAND_DEPTH * 0.85
const MAST_TOP_Y = 44

const MODES = ['broadcast', 'highlight', 'set-piece', 'goal-cam', 'reaction', 'celebrate']
const TIMES = [0, 0.37, 1.9, 5.5, 13.2, 30]
const SEEDS = [1, 7, 4242]

const step = (() => {
  const i = process.argv.indexOf('--step')
  return i >= 0 ? Number(process.argv[i + 1]) : 4
})()

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { cameraFor, standSurfaceY, CAM_MIN_Y, STAND_CLEARANCE, MAST_CLEAR_R } =
  await server.ssrLoadModule('/src/ui/pitch/three/camera.ts')

const surfaceOf = (x, z) => standSurfaceY(x, z)
const mastDist = (s) =>
  s.pos.y >= MAST_TOP_Y + 2
    ? Infinity
    : Math.hypot(Math.abs(s.pos.x) - MAST_PX, Math.abs(s.pos.z) - MAST_PZ)

const rows = []
for (const mode of MODES) {
  let worst = null
  for (let fx = -58; fx <= 58; fx += step) {
    for (let fz = -38; fz <= 38; fz += step) {
      for (const t of TIMES) {
        for (const seed of SEEDS) {
          const s = cameraFor(mode, { x: fx, z: fz }, t, seed)
          const surface = surfaceOf(s.pos.x, s.pos.z)
          const standM = surface <= 0 ? Infinity : s.pos.y - surface
          const mastM = mastDist(s)
          // "여유"는 세 판정 중 가장 빡빡한 것으로 대표한다(스탠드·마스트·높이).
          const slack = Math.min(
            standM === Infinity ? 99 : standM - STAND_CLEARANCE,
            mastM === Infinity ? 99 : mastM - MAST_CLEAR_R,
            s.pos.y - CAM_MIN_Y,
          )
          if (!worst || slack < worst.slack) {
            worst = { fx, fz, t, seed, s, surface, standM, mastM, slack }
          }
        }
      }
    }
  }
  const w = worst
  const inStand = w.surface > 0
  const verdict = [
    inStand ? `스탠드 안(표면 ${w.surface.toFixed(2)}m, 여유 ${w.standM.toFixed(2)}m)` : '스탠드 밖',
    w.mastM === Infinity ? '마스트 위' : `마스트 ${w.mastM.toFixed(2)}m`,
    `높이 ${(w.s.pos.y - CAM_MIN_Y).toFixed(2)}m`,
  ].join(' / ')
  const ok = (inStand ? w.standM >= STAND_CLEARANCE - 1e-6 : true) &&
    (w.mastM === Infinity || w.mastM > MAST_CLEAR_R) &&
    w.s.pos.y >= CAM_MIN_Y
  rows.push(
    `| ${mode} | (${w.fx}, ${w.fz}) t=${w.t} seed=${w.seed} | (${w.s.pos.x.toFixed(1)}, ${w.s.pos.y.toFixed(1)}, ${w.s.pos.z.toFixed(1)}) | ${ok ? 'PASS' : 'FAIL'} — ${verdict} | ${w.slack.toFixed(2)} |`,
  )
}

await server.close()

console.log('')
console.log(
  `### 카메라 프리셋 경계 검사 (focus 격자 ${step}m, t ${TIMES.length}종 × seed ${SEEDS.length}종)`,
)
console.log('')
console.log('| 모드 | 최악 케이스 focus | 카메라 위치(x,y,z) | 판정 | 여유(m) |')
console.log('|---|---|---|---|---:|')
for (const r of rows) console.log(r)
console.log('')
console.log(
  `기준: 관중석 풋프린트(|x|≥${END_INNER} 또는 |z|≥${SIDE_INNER}) 안이면 좌석 표면(H0 ${STAND_H0} + 침투×tan${RAKE}) + ${STAND_CLEARANCE}m 이상, 조명탑 마스트(±${MAST_PX}, ±${MAST_PZ}) 반경 ${MAST_CLEAR_R}m 밖, y ≥ ${CAM_MIN_Y}.`,
)
