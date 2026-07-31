#!/usr/bin/env node
// tools/sim-audit/verify-fk.mjs
// pose.diveHandLocal(순기구학 닫힌 식)이 **실제 three 리그**가 만드는 손 위치와 같은지
// 검증한다. 두 계층이 다른 팔을 상상하면 "공이 손에 붙는다"가 성립하지 않는다.
import { createServer } from 'vite'
import * as THREE from 'three'

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const p3 = await server.ssrLoadModule('/src/ui/pitch/three/player3d.ts')
const pose = await server.ssrLoadModule('/src/ui/pitch/three/pose.ts')

const rig = p3.createPlayer(THREE, { kit: 0xff0000, accent: 0xffffff, number: 1, isGk: true })
// root.scale 변주를 없애 순수 리그 좌표를 본다.
rig.root.scale.setScalar(1)

/** 리그에서 "뻗는 손"(위로 뜨는 쪽) 메시를 찾는다. */
function handWorld() {
  rig.root.updateMatrixWorld(true)
  const hands = []
  rig.root.traverse(o => { if (o.isMesh && o.geometry?.type === 'SphereGeometry' && o.scale.x === 0.9) hands.push(o) })
  const out = hands.map(h => {
    const v = new THREE.Vector3()
    h.getWorldPosition(v)
    return v
  })
  // 위로 뜨는 팔 = y가 큰 쪽(누운 자세에서 위쪽 팔이 높다)
  return out.sort((a, b) => b.y - a.y)[0]
}

console.log('| t | dir | three 리그 손 (x,y,z) | diveHandLocal (x,y,z) | 오차 m |')
console.log('|---|---|---|---|---|')
let worst = 0
for (const dir of [1, -1]) {
  // t=0은 제외한다: 팔이 아직 내려와 있어 두 손의 높이가 같고, "뻗는 손"이 기하학적으로
  // 정의되지 않는다(어느 쪽을 골라도 맞다). 접촉이 일어나는 창은 t ≥ 0.25다.
  for (const t of [0.25, 0.4, 0.55, 0.7, 1]) {
    // yaw=0, 위치 원점에서 다이브 포즈를 적용
    rig.apply({ id: 'gk', side: 'home', number: 1, x: 0, z: 0, yaw: 0, speed: 0, action: 'dive', actionT: t, actionDir: dir }, 0)
    // 크로스페이드를 끝내기 위해 같은 포즈를 충분히 반복 적용한다
    for (let i = 0; i < 60; i++) rig.apply({ id: 'gk', side: 'home', number: 1, x: 0, z: 0, yaw: 0, speed: 0, action: 'dive', actionT: t, actionDir: dir }, i * 0.05)
    rig.root.scale.setScalar(1)
    const w = handWorld()
    const l = pose.diveHandLocal(t, dir)
    const err = Math.hypot(w.x - l.x, w.y - l.y, w.z - l.z)
    worst = Math.max(worst, err)
    console.log(`| ${t} | ${dir} | ${w.x.toFixed(3)}, ${w.y.toFixed(3)}, ${w.z.toFixed(3)} | ${l.x.toFixed(3)}, ${l.y.toFixed(3)}, ${l.z.toFixed(3)} | **${err.toFixed(4)}** |`)
  }
}
console.log(`\n최대 오차: ${worst.toFixed(4)} m`)
await server.close()
