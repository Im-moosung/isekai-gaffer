#!/usr/bin/env node
// 입장 연출 단계별 "프레임 안 배역 수" 계측기.
// entrance.ts(순수) + camera.ts(순수)를 vite SSR 로더로 그대로 불러와,
// Match3D.tsx의 모드 매핑을 그대로 재현하고 월드→스크린 투영으로 카운트한다.
import { createServer } from 'vite'

const ROOT = '/Users/moo/Projects/daker/MH_Soccer-Manager'
const ASPECTS = process.argv.includes('--aspect')
  ? [Number(process.argv[process.argv.indexOf('--aspect') + 1])]
  : [1600 / 900, 1600 / 540, 105 / 68, 1280 / 720]

const server = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const load = (p) => server.ssrLoadModule(p)

const E = await load('/src/ui/pitch/three/entrance.ts')
const C = await load('/src/ui/pitch/three/camera.ts')
const { createMatch } = await load('/src/engine/simulate.ts')
const { makeTestTeam } = await load('/src/engine/fixtures/testTeams.ts')

const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 11 })
const cast = E.buildEntranceCast(state)

// ── 최소 선형대수(three 없이) ────────────────────────────────────
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l } }
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z

/** 월드점 → NDC. three.lookAt 규약(카메라는 -Z를 본다, up=+Y). */
function project(shot, aspect, p) {
  const fwd = norm(sub(shot.lookAt, shot.pos))       // 카메라가 보는 방향
  const right = norm(cross(fwd, { x: 0, y: 1, z: 0 }))
  const up = cross(right, fwd)
  const d = sub(p, shot.pos)
  const zc = dot(d, fwd)                              // 카메라 앞쪽 거리
  if (zc <= 0.01) return null
  const tanH = Math.tan((shot.fov * Math.PI) / 360)
  return { x: dot(d, right) / (zc * tanH * aspect), y: dot(d, up) / (zc * tanH), z: zc }
}

const inNdc = (n) => n !== null && n.x >= -1 && n.x <= 1 && n.y >= -1 && n.y <= 1
/**
 * 방송 세이프 에어리어(중앙 90 %). "프레임 안"만 세면 화면 맨 끝 1 % 띠에 걸친 사람도
 * 1명으로 세어져 실제 화면(텅 빈 미드필드)과 숫자가 어긋난다. 심사자가 "보인다"고
 * 말할 위치인지를 재려면 가장자리를 잘라내야 한다.
 */
const SAFE = 0.9
const inSafe = (n) => n !== null && Math.abs(n.x) <= SAFE && Math.abs(n.y) <= SAFE

// ── Match3D.tsx의 모드 매핑을 그대로 ───────────────────────────────
const MODE_MAP = process.argv.includes('--old')
  ? { lineup: 'reaction', intro: 'reaction', _: 'broadcast' }
  : { lineup: 'entrance-close', intro: 'entrance-close', disperse: 'broadcast', _: 'entrance' }
const modeFor = (ph) => MODE_MAP[ph] ?? MODE_MAP._

const HEAD_Y = 1.75   // player3d 리그의 머리 높이 근사
const FOOT_Y = 0.05
const TORSO_Y = 0.95

const SEED = state.seed

/** 단계 대표 시각들. 소개는 11명 전원을 훑어야 하므로 촘촘히 뽑는다. */
function samples() {
  const out = []
  for (const span of E.ENTRANCE_PHASES) {
    const len = span.end - span.start
    const n = span.phase === 'intro' ? 22 : 5
    for (let i = 1; i <= n; i++) out.push({ phase: span.phase, ms: span.start + (len * i) / (n + 1) })
  }
  return out
}

function measure(aspect) {
  const rows = new Map()
  for (const s of samples()) {
    const f = E.entranceFrame(cast, s.ms)
    const actors = [...f.players, f.referee]
    // t(초)는 three Clock 경과. 연출 시작을 0으로 두고 호흡 위상만 쓰므로 ms/1000이면 충분.
    const shot = C.cameraFor(modeFor(s.phase), f.focus, s.ms / 1000, SEED)
    let full = 0
    let partial = 0
    let safe = 0
    for (const a of actors) {
      const head = project(shot, aspect, { x: a.x, y: HEAD_Y, z: a.z })
      const foot = project(shot, aspect, { x: a.x, y: FOOT_Y, z: a.z })
      const torso = project(shot, aspect, { x: a.x, y: TORSO_Y, z: a.z })
      if (inNdc(head) && inNdc(foot)) full++
      else if (inNdc(torso) || inNdc(head) || inNdc(foot)) partial++
      if (inSafe(head) && inSafe(foot)) safe++
    }
    // 소개 단계: 호명 중인 선수가 실제로 프레임 안에 있는가(카드와 화면의 일치).
    let named = null
    const card = E.introCardAt(cast, s.ms)
    if (card) {
      const p = f.players.find(x => x.id === card.player.id)
      named = p ? inNdc(project(shot, aspect, { x: p.x, y: TORSO_Y, z: p.z })) : false
    }
    const cur = rows.get(s.phase) ?? { full: [], partial: [], total: actors.length, shot, focus: f.focus, named: [], safe: [] }
    cur.full.push(full)
    cur.safe.push(safe)
    cur.partial.push(partial)
    if (named !== null) cur.named.push(named)
    rows.set(s.phase, cur)
  }
  return rows
}

const mn = (a) => Math.min(...a)
const mx = (a) => Math.max(...a)

for (const aspect of ASPECTS) {
  console.log(`\n### aspect ${aspect.toFixed(3)}`)
  console.log('| 단계 | 배역 | 세이프에어리어 안 | 완전히 프레임 안 | 일부만 | 프레임 밖 | 호명 선수 |')
  console.log('|---|---:|---:|---:|---:|---:|---|')
  for (const [phase, r] of measure(aspect)) {
    const out = r.full.map((f, i) => r.total - f - r.partial[i])
    const rng = (a) => (mn(a) === mx(a) ? `${mn(a)}` : `${mn(a)}~${mx(a)}`)
    const named = r.named.length === 0 ? '—' : `${r.named.filter(Boolean).length}/${r.named.length}`
    console.log(`| ${phase} | ${r.total} | ${rng(r.safe)} | ${rng(r.full)} | ${rng(r.partial)} | ${rng(out)} | ${named} |`)
  }
}

await server.close()
