// buildScene은 three를 주입받는다. 테스트에서는 실제 three(WebGL 없이 동작하는 씬 그래프
// 부분만)를 주입해 구조·결정론·해제를 검증한다. 프로덕션 모듈은 three를 정적 import하지
// 않으므로 코드 스플릿은 유지된다.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildScene, makeContactShadow } from '../scene'
import { GOAL_H, GOAL_W, POST_R } from '../textures'
import { PITCH_W, PITCH_H } from '../types'

function build(opts = {}) {
  return buildScene(THREE, { crowdCount: 800, pxPerMeter: 2, ...opts })
}

describe('buildScene 구조', () => {
  it('scene·camera·그룹을 돌려주고 카메라가 피치를 담는다', () => {
    const b = build()
    expect(b.scene.isScene).toBe(true)
    expect(b.camera.isPerspectiveCamera).toBe(true)
    expect(b.camera.far).toBeGreaterThan(300)
    expect(b.scene.children).toContain(b.pitchGroup)
    expect(b.scene.children).toContain(b.stadiumGroup)
    b.dispose()
  })

  it('피치 평면이 105×68이며 XZ에 눕는다', () => {
    const b = build()
    const geo = b.pitchMesh.geometry as THREE.PlaneGeometry
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    expect(box.max.x - box.min.x).toBeCloseTo(PITCH_W, 4)
    expect(box.max.z - box.min.z).toBeCloseTo(PITCH_H, 4)
    expect(box.max.y - box.min.y).toBeCloseTo(0, 4)
    b.dispose()
  })

  it('골대 2개가 양 골라인에 서고 포스트·크로스바 규격이 맞다', () => {
    const b = build()
    const goals = b.pitchGroup.children.filter((o) => o.name.startsWith('goal-'))
    expect(goals.length).toBe(2)
    const posts: THREE.Mesh[] = []
    for (const g of goals) {
      for (const c of g.children) {
        const m = c as THREE.Mesh
        const p = m.geometry?.type === 'CylinderGeometry' ? m : null
        if (p) posts.push(p)
      }
    }
    // 골대당 포스트 2 + 크로스바 1
    expect(posts.length).toBe(6)
    const cyl = posts[0].geometry as THREE.CylinderGeometry
    expect(cyl.parameters.radiusTop).toBeCloseTo(POST_R, 5)
    for (const g of goals) {
      const x = (g.children[0] as THREE.Mesh).position.x
      expect(Math.abs(x)).toBeCloseTo(PITCH_W / 2, 4)
      const zs = g.children.slice(0, 2).map((c) => c.position.z).sort((a, z) => a - z)
      expect(zs[1] - zs[0]).toBeCloseTo(GOAL_W, 4)
      expect((g.children[2] as THREE.Mesh).position.y).toBeCloseTo(GOAL_H, 4)
    }
    b.dispose()
  })

  it('조명은 존재하되 실시간 그림자는 전부 꺼져 있다', () => {
    const b = build()
    const lights: THREE.Light[] = []
    b.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) lights.push(o as THREE.Light)
    })
    expect(lights.length).toBeGreaterThanOrEqual(3)
    expect(lights.some((l) => (l as THREE.HemisphereLight).isHemisphereLight)).toBe(true)
    expect(lights.some((l) => (l as THREE.DirectionalLight).isDirectionalLight)).toBe(true)
    for (const l of lights) expect(l.castShadow).toBe(false)
    b.scene.traverse((o) => {
      expect(o.castShadow).toBe(false)
      expect(o.receiveShadow).toBe(false)
    })
    b.dispose()
  })
})

describe('관중 InstancedMesh', () => {
  it('요청 인원에 근접한 수로 생성되고 관중석 위에 앉는다', () => {
    const b = build({ crowdCount: 4000 })
    expect(b.crowd).not.toBeNull()
    expect(b.crowdCount).toBeGreaterThan(3400)
    expect(b.crowdCount).toBeLessThan(4600)
    expect(b.crowd!.count).toBe(b.crowdCount)

    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    let insidePitch = 0
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < b.crowdCount; i++) {
      b.crowd!.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)
      // 관중은 피치 위(플레이 영역)에 있으면 안 된다.
      if (Math.abs(p.x) < PITCH_W / 2 && Math.abs(p.z) < PITCH_H / 2) insidePitch++
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    expect(insidePitch).toBe(0)
    expect(minY).toBeGreaterThan(2) // 첫 열도 피치보다 높다
    expect(maxY).toBeGreaterThan(12) // 경사가 실제로 올라간다
    b.dispose()
  })

  it('색이 홈/어웨이/중립으로 섞이고 모두 유효 범위', () => {
    const b = build({ crowdCount: 1200, homeColor: 0xff0000, awayColor: 0x0000ff })
    const ic = b.crowd!.instanceColor
    expect(ic).not.toBeNull()
    const arr = ic!.array
    const seen = new Set<string>()
    for (let i = 0; i < b.crowdCount; i++) {
      const r = arr[i * 3]
      const g = arr[i * 3 + 1]
      const bl = arr[i * 3 + 2]
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(1)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
      expect(bl).toBeGreaterThanOrEqual(0)
      expect(bl).toBeLessThanOrEqual(1)
      seen.add(`${r.toFixed(2)},${g.toFixed(2)},${bl.toFixed(2)}`)
    }
    // 단색이 아니라 충분히 변주된다.
    expect(seen.size).toBeGreaterThan(50)
    b.dispose()
  })

  it('crowdCount 0이면 관중을 만들지 않는다', () => {
    const b = build({ crowdCount: 0 })
    expect(b.crowd).toBeNull()
    expect(b.crowdCount).toBe(0)
    expect(() => b.crowdWave(1.2, 1)).not.toThrow()
    b.dispose()
  })

  it('두 번 빌드하면 완전히 동일하다(Math.random·Date 미사용)', () => {
    const a = build({ crowdCount: 1000 })
    const c = build({ crowdCount: 1000 })
    expect(a.crowdCount).toBe(c.crowdCount)
    expect(Array.from(a.crowd!.instanceMatrix.array)).toEqual(
      Array.from(c.crowd!.instanceMatrix.array),
    )
    expect(Array.from(a.crowd!.instanceColor!.array)).toEqual(
      Array.from(c.crowd!.instanceColor!.array),
    )
    a.dispose()
    c.dispose()
  })
})

describe('crowdWave', () => {
  it('intensity가 클수록 Y가 크게 튀고, 같은 t면 같은 결과', () => {
    const b = build({ crowdCount: 1000 })
    const arr = b.crowd!.instanceMatrix.array
    const baseline = Array.from(arr)

    b.crowdWave(0, 0)
    const idle = Array.from(arr)
    b.crowdWave(0, 1)
    const jump = Array.from(arr)
    b.crowdWave(0, 1)
    expect(Array.from(arr)).toEqual(jump)

    let idleMax = 0
    let jumpMax = 0
    for (let i = 0; i < b.crowdCount; i++) {
      const k = i * 16 + 13
      idleMax = Math.max(idleMax, Math.abs(idle[k] - baseline[k]))
      jumpMax = Math.max(jumpMax, Math.abs(jump[k] - baseline[k]))
    }
    expect(idleMax).toBeLessThan(0.1) // 평상시는 미세 흔들림
    expect(jumpMax).toBeGreaterThan(0.4) // 골 때는 확실히 점프
    b.dispose()
  })

  it('XZ 위치는 흔들지 않고 Y만 움직인다', () => {
    const b = build({ crowdCount: 600 })
    const arr = b.crowd!.instanceMatrix.array
    const before = Array.from(arr)
    const v0 = b.crowd!.instanceMatrix.version
    b.crowdWave(3.7, 1)
    for (let i = 0; i < b.crowdCount; i++) {
      expect(arr[i * 16 + 12]).toBe(before[i * 16 + 12])
      expect(arr[i * 16 + 14]).toBe(before[i * 16 + 14])
    }
    // needsUpdate는 setter-only → version 증가로 GPU 업로드 예약을 검증
    expect(b.crowd!.instanceMatrix.version).toBeGreaterThan(v0)
    b.dispose()
  })

  it('여러 t에서 파도가 실제로 진행한다(전원 동시 점프 아님)', () => {
    const b = build({ crowdCount: 2000 })
    const arr = b.crowd!.instanceMatrix.array
    b.crowdWave(1.0, 1)
    let jumping = 0
    for (let i = 0; i < b.crowdCount; i++) {
      if (arr[i * 16 + 13] > 0) jumping++
    }
    expect(jumping).toBe(b.crowdCount) // 모두 유효한 높이
    // 파도 위상차 → 같은 순간에도 높이가 서로 다르다
    const ys = new Set<string>()
    for (let i = 0; i < b.crowdCount; i++) ys.add(arr[i * 16 + 13].toFixed(3))
    expect(ys.size).toBeGreaterThan(100)
    b.dispose()
  })
})

describe('dispose', () => {
  it('모든 geometry·material·texture를 해제한다', () => {
    const b = build({ crowdCount: 500 })
    const geos = new Set<THREE.BufferGeometry>()
    const mats = new Set<THREE.Material>()
    b.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) geos.add(m.geometry)
      if (m.material) {
        for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm)
      }
    })
    expect(geos.size).toBeGreaterThan(5)
    expect(mats.size).toBeGreaterThan(5)

    let disposed = 0
    const expected = geos.size + mats.size
    for (const g of geos) g.addEventListener('dispose', () => disposed++)
    for (const m of mats) m.addEventListener('dispose', () => disposed++)

    b.dispose()
    expect(disposed).toBe(expected)
    expect(b.scene.children.length).toBe(0)
  })

  it('dispose 후 crowdWave 호출이 안전하다', () => {
    const b = build({ crowdCount: 500 })
    b.dispose()
    expect(() => b.crowdWave(2, 1)).not.toThrow()
  })
})

describe('makeContactShadow', () => {
  it('XZ 평면에 눕는 반투명 검정 원', () => {
    const mesh = makeContactShadow(THREE, 0.6)
    const geo = mesh.geometry
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    expect(box.max.y - box.min.y).toBeCloseTo(0, 5)
    expect(box.max.x - box.min.x).toBeCloseTo(1.2, 3)
    expect(box.max.z - box.min.z).toBeCloseTo(1.2, 3)
    const mat = mesh.material as THREE.MeshBasicMaterial
    expect(mat.transparent).toBe(true)
    expect(mat.depthWrite).toBe(false)
    expect(mat.opacity).toBeGreaterThan(0)
    expect(mat.opacity).toBeLessThan(1)
    expect(mat.color.getHex()).toBe(0x000000)
    mesh.geometry.dispose()
    mat.dispose()
  })
})
