// fx3d.ts는 three를 주입받는다(정적 import 금지 — 코드 스플릿). 테스트에서는 실제 three의
// 씬 그래프 부분만 써서 구조·결정론·해제를 검증한다(WebGL 컨텍스트 없이 동작하는 범위).
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import {
  BALL_R,
  BURST_COUNT,
  BURST_LIFE,
  FLASH_CONCEDED,
  FLASH_SCORED,
  createBall,
  flashQuad,
  goalBurst,
  makeBallCanvas,
} from '../fx3d'
import type { BallPose } from '../types'

const pose = (x: number, y: number, z: number, spin = 0): BallPose => ({ x, y, z, spin })

// ── canvas 2D 스텁(node 환경엔 document가 없다) ──────────────────
function makeCtxStub(): CanvasRenderingContext2D {
  const noop = (): void => {}
  const gradient = { addColorStop: noop }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillRect: noop,
    clearRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    putImageData: noop,
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    createPattern: () => ({}),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  }
  return ctx as unknown as CanvasRenderingContext2D
}

function installCanvasStub(): () => void {
  const g = globalThis as { document?: unknown }
  const had = 'document' in g
  const prev = g.document
  g.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') return {}
      return {
        width: 1,
        height: 1,
        getContext: (kind: string) => (kind === '2d' ? makeCtxStub() : null),
      }
    },
  }
  return () => {
    if (had) g.document = prev
    else delete g.document
  }
}

/** 트리 전체의 geometry/material/texture를 수집한다(dispose 완전성 대조용). */
function collectResources(root: THREE.Object3D): {
  geos: Set<THREE.BufferGeometry>
  mats: Set<THREE.Material>
  texes: Set<THREE.Texture>
} {
  const geos = new Set<THREE.BufferGeometry>()
  const mats = new Set<THREE.Material>()
  const texes = new Set<THREE.Texture>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) geos.add(m.geometry)
    if (m.material) {
      for (const mm of Array.isArray(m.material) ? m.material : [m.material]) {
        mats.add(mm)
        const rec = mm as unknown as Record<string, unknown>
        for (const key of Object.keys(rec)) {
          const v = rec[key] as THREE.Texture | null
          if (v && typeof v === 'object' && v.isTexture) texes.add(v)
        }
      }
    }
  })
  return { geos, mats, texes }
}

/** 생성된 모든 리소스에 dispose 리스너를 달고 실제 해제 수를 센다. */
function countDisposals(root: THREE.Object3D): { expected: number; fired: () => number } {
  const { geos, mats, texes } = collectResources(root)
  let fired = 0
  for (const r of [...geos, ...mats, ...texes]) r.addEventListener('dispose', () => fired++)
  return { expected: geos.size + mats.size + texes.size, fired: () => fired }
}

const matOf = (m: THREE.Object3D) => (m as THREE.Mesh).material as THREE.MeshBasicMaterial

describe('makeBallCanvas', () => {
  it('canvas 미지원 환경에서는 null(throw 금지)', () => {
    expect(makeBallCanvas(64)).toBeNull()
  })

  it('canvas가 있으면 2:1 적도 전개 캔버스를 만든다', () => {
    const restore = installCanvasStub()
    try {
      const c = makeBallCanvas(128)
      expect(c).not.toBeNull()
      expect(c!.width).toBe(128)
      expect(c!.height).toBe(64)
    } finally {
      restore()
    }
  })
})

describe('createBall — 구조', () => {
  it('구체 + 컨택트 섀도우 **둘만** 한 그룹에 담는다(트레일 없음)', () => {
    const b = createBall(THREE)
    expect(b.group.children).toContain(b.mesh)
    expect(b.group.children).toContain(b.shadow)
    // 볼 트레일은 제거됐다(실제 중계에 없고, 균일한 구체 10개가 잔상이 아니라
    // "잔디에 떨어진 점 10개"로 읽혔다). 자식은 공과 그림자뿐이어야 한다.
    expect(b.group.children).toHaveLength(2)
    const geo = b.mesh.geometry as THREE.SphereGeometry
    expect(geo.type).toBe('SphereGeometry')
    expect(geo.parameters.radius).toBeCloseTo(BALL_R, 6)
    expect(BALL_R).toBeGreaterThan(0.1) // 실제 축구공 반지름(11cm) 근처
    expect(BALL_R).toBeLessThan(0.13)
    b.dispose()
  })

  it('radius 옵션이 구체·섀도우 크기에 반영된다', () => {
    const small = createBall(THREE, { radius: 0.11 })
    const big = createBall(THREE, { radius: 0.5 })
    expect((small.mesh.geometry as THREE.SphereGeometry).parameters.radius).toBeCloseTo(0.11, 6)
    expect((big.mesh.geometry as THREE.SphereGeometry).parameters.radius).toBeCloseTo(0.5, 6)
    small.dispose()
    big.dispose()
  })

  it('canvas가 있으면 절차 텍스처를 입고, 없으면 단색으로 폴백한다', () => {
    const plain = createBall(THREE)
    expect((plain.mesh.material as THREE.MeshStandardMaterial).map).toBeNull()
    plain.dispose()

    const restore = installCanvasStub()
    try {
      const b = createBall(THREE)
      const mat = b.mesh.material as THREE.MeshStandardMaterial
      expect(mat.map).not.toBeNull()
      expect(mat.map!.isTexture).toBe(true)
      b.dispose()
    } finally {
      restore()
    }
  })
})

describe('createBall — update', () => {
  it('BallPose 위치를 따라가고 잔디 아래로 파묻히지 않는다', () => {
    const b = createBall(THREE)
    b.update(pose(12, 0.11, -7), 0.016)
    expect(b.mesh.position.x).toBeCloseTo(12, 6)
    expect(b.mesh.position.z).toBeCloseTo(-7, 6)
    expect(b.mesh.position.y).toBeGreaterThanOrEqual(BALL_R - 1e-9)
    b.update(pose(12, -5, -7), 0.016)
    expect(b.mesh.position.y).toBeGreaterThanOrEqual(BALL_R - 1e-9)
    b.dispose()
  })

  it('이동 방향에 수직인 축으로, 이동거리/반지름 만큼 구른다', () => {
    const b = createBall(THREE)
    b.update(pose(0, BALL_R, 0), 0.016) // 첫 프레임은 스냅(회전 없음)
    expect(b.mesh.quaternion.equals(new THREE.Quaternion())).toBe(true)

    b.update(pose(0.02, BALL_R, 0), 0.016)
    const q = b.mesh.quaternion
    const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)))
    expect(angle).toBeCloseTo(0.02 / BALL_R, 4)
    const axis = new THREE.Vector3(q.x, q.y, q.z).normalize()
    // +X로 구르면 회전축은 -Z (윗면이 진행 방향으로 넘어간다)
    expect(axis.z).toBeCloseTo(-1, 4)
    expect(Math.abs(axis.y)).toBeLessThan(1e-6)
    const top = new THREE.Vector3(0, BALL_R, 0).applyQuaternion(q)
    expect(top.x).toBeGreaterThan(0)

    // +Z로 구르면 회전축은 +X
    const c = createBall(THREE)
    c.update(pose(0, BALL_R, 0), 0.016)
    c.update(pose(0, BALL_R, 0.02), 0.016)
    const axis2 = new THREE.Vector3(c.mesh.quaternion.x, c.mesh.quaternion.y, c.mesh.quaternion.z).normalize()
    expect(axis2.x).toBeCloseTo(1, 4)

    // 정지하면 회전도 멈춘다
    const before = b.mesh.quaternion.clone()
    b.update(pose(0.02, BALL_R, 0), 0.016)
    expect(b.mesh.quaternion.equals(before)).toBe(true)
    b.dispose()
    c.dispose()
  })

  it('컨택트 섀도우는 공 바로 아래에 붙고 높이에 따라 커지며 옅어진다', () => {
    const b = createBall(THREE)
    b.update(pose(5, BALL_R, 3), 0.016)
    const lowOpacity = matOf(b.shadow).opacity
    const lowScale = b.shadow.scale.x
    expect(b.shadow.position.x).toBeCloseTo(5, 6)
    expect(b.shadow.position.z).toBeCloseTo(3, 6)
    expect(b.shadow.position.y).toBeLessThan(0.1)
    expect(lowOpacity).toBeGreaterThan(0)

    b.update(pose(5, 6, 3), 0.016)
    expect(matOf(b.shadow).opacity).toBeLessThan(lowOpacity * 0.6)
    expect(b.shadow.scale.x).toBeGreaterThan(lowScale * 1.2)
    // 그래도 완전히 사라지진 않는다(공이 어디 있는지 알려주는 단서)
    expect(matOf(b.shadow).opacity).toBeGreaterThan(0)
    b.dispose()
  })

  it('아무리 빨리 움직여도 잔상 메시가 생기지 않는다(트레일 회귀 방지)', () => {
    const b = createBall(THREE)
    for (let i = 0; i < 40; i++) b.update(pose(i * 0.5, BALL_R, 0), 0.05) // 10 m/s
    // 예전 구현은 여기서 세그먼트 10개를 켰다. 지금은 공·그림자만 남아야 한다.
    expect(b.group.children).toHaveLength(2)
    expect(b.group.children.every((c) => c.visible)).toBe(true)
    b.dispose()
  })

  it('dispose가 모든 geometry·material·texture를 해제하고 그룹을 비운다', () => {
    const restore = installCanvasStub()
    try {
      const b = createBall(THREE)
      b.update(pose(1, BALL_R, 1), 0.016)
      const { geos, mats, texes } = collectResources(b.group)
      expect(geos.size).toBeGreaterThan(1)
      expect(mats.size).toBeGreaterThanOrEqual(2) // 공 표면 + 섀도우
      // 섀도우는 정점 알파로 바뀌어 텍스처를 쓰지 않는다 — 남는 건 공 표면 텍스처뿐이다.
      expect(texes.size).toBeGreaterThanOrEqual(1)
      const { expected, fired } = countDisposals(b.group)
      b.dispose()
      expect(fired()).toBe(expected)
      expect(b.group.children.length).toBe(0)
      expect(() => b.update(pose(2, BALL_R, 2), 0.016)).not.toThrow()
    } finally {
      restore()
    }
  })
})

describe('goalBurst', () => {
  const at = { x: 40, y: 1, z: 2 }

  it('팀 컬러 파티클 60개를 만든다', () => {
    const g = goalBurst(THREE, 0xff3040, at)
    expect(BURST_COUNT).toBe(60)
    expect(g.mesh.count).toBe(BURST_COUNT)
    expect(g.mesh.isInstancedMesh).toBe(true)
    expect(g.done).toBe(false)
    const ic = g.mesh.instanceColor
    expect(ic).not.toBeNull()
    let rSum = 0
    let gSum = 0
    let bSum = 0
    for (let i = 0; i < BURST_COUNT; i++) {
      const r = ic!.array[i * 3]
      const gg = ic!.array[i * 3 + 1]
      const bb = ic!.array[i * 3 + 2]
      for (const v of [r, gg, bb]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      rSum += r
      gSum += gg
      bSum += bb
    }
    // 0xff3040 → 빨강이 지배적이어야 한다(팀 컬러 무시 뮤테이션 방지)
    expect(rSum).toBeGreaterThan(gSum * 2)
    expect(rSum).toBeGreaterThan(bSum * 2)
    g.dispose()
  })

  it('초기 분포가 결정론적이고 시드로 갈린다', () => {
    const a = goalBurst(THREE, 0x2453b8, at, { seed: 5 })
    const b = goalBurst(THREE, 0x2453b8, at, { seed: 5 })
    const c = goalBurst(THREE, 0x2453b8, at, { seed: 6 })
    a.update(0.1)
    b.update(0.1)
    c.update(0.1)
    expect(Array.from(a.mesh.instanceMatrix.array)).toEqual(Array.from(b.mesh.instanceMatrix.array))
    expect(Array.from(a.mesh.instanceMatrix.array)).not.toEqual(
      Array.from(c.mesh.instanceMatrix.array),
    )
    a.dispose()
    b.dispose()
    c.dispose()
  })

  it('폭발 지점에서 사방으로 흩어진다', () => {
    const g = goalBurst(THREE, 0xffffff, at, { seed: 2 })
    g.update(0.08)
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    const seen = new Set<string>()
    let maxD = 0
    for (let i = 0; i < g.mesh.count; i++) {
      g.mesh.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)
      const d = Math.hypot(p.x - at.x, p.y - at.y, p.z - at.z)
      maxD = Math.max(maxD, d)
      seen.add(`${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`)
      expect(p.y).toBeGreaterThan(0) // 잔디 아래로 안 내려간다
    }
    expect(seen.size).toBe(g.mesh.count) // 전부 다른 위치(한 점에 뭉치지 않음)
    expect(maxD).toBeGreaterThan(0.2)
    expect(maxD).toBeLessThan(3)
    g.dispose()
  })

  it('중력을 받아 솟았다 떨어지고, 수명이 끝나면 소멸한다', () => {
    const g = goalBurst(THREE, 0xffffff, at, { seed: 3 })
    const meanY = () => {
      const m = new THREE.Matrix4()
      const p = new THREE.Vector3()
      let s = 0
      for (let i = 0; i < g.mesh.count; i++) {
        g.mesh.getMatrixAt(i, m)
        p.setFromMatrixPosition(m)
        s += p.y
      }
      return s / g.mesh.count
    }
    g.update(0.15)
    const early = meanY()
    g.update(0.3)
    const apex = meanY()
    g.update(0.95)
    const late = meanY()
    expect(apex).toBeGreaterThan(early) // 솟는다
    expect(late).toBeLessThan(apex) // 떨어진다

    expect(matOf(g.mesh).opacity).toBeLessThan(1) // 페이드 진행
    expect(matOf(g.mesh).opacity).toBeGreaterThan(0)
    expect(g.update(BURST_LIFE)).toBe(false)
    expect(g.done).toBe(true)
    expect(g.mesh.count).toBe(0)
    expect(g.update(0.1)).toBe(false)
    g.dispose()
  })

  it('reduced-motion이면 파티클을 그리지 않는다', () => {
    const g = goalBurst(THREE, 0xffffff, at, { reducedMotion: true })
    expect(g.mesh.count).toBe(0)
    expect(g.done).toBe(true)
    expect(g.update(0.1)).toBe(false)
    g.dispose()
  })

  it('dispose가 지오메트리·머티리얼·인스턴스 버퍼를 해제한다', () => {
    const g = goalBurst(THREE, 0xffffff, at)
    const scene = new THREE.Scene()
    scene.add(g.mesh)
    const { expected, fired } = countDisposals(g.mesh)
    let instanceDisposed = 0
    g.mesh.addEventListener('dispose', () => instanceDisposed++)
    const spy = vi.spyOn(g.mesh, 'dispose')
    g.dispose()
    expect(fired()).toBe(expected)
    // InstancedMesh.dispose가 없으면 instanceMatrix GPU 버퍼가 영구 누수된다
    expect(spy).toHaveBeenCalledTimes(1)
    expect(instanceDisposed).toBe(1)
    expect(scene.children).not.toContain(g.mesh)
    spy.mockRestore()
  })
})

describe('flashQuad', () => {
  const makeCam = () => new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 900)

  it('처음엔 보이지 않고, flash 뒤 페이드 아웃한다', () => {
    const f = flashQuad(THREE, 0xffffff)
    expect(f.alpha).toBe(0)
    expect(f.mesh.visible).toBe(false)

    f.flash({ peak: 0.8, duration: 0.5 })
    f.update(0)
    expect(f.alpha).toBeCloseTo(0.8, 6)
    expect(f.mesh.visible).toBe(true)
    expect(matOf(f.mesh).opacity).toBeCloseTo(0.8, 6)

    f.update(0.25)
    const mid = f.alpha
    expect(mid).toBeLessThan(0.8)
    expect(mid).toBeGreaterThan(0)
    f.update(0.25)
    expect(f.alpha).toBe(0)
    expect(f.mesh.visible).toBe(false)
    // 수명이 끝난 뒤 더 갱신해도 음수로 가지 않는다
    f.update(1)
    expect(f.alpha).toBe(0)
    f.dispose()
  })

  it('득점은 밝게, 실점은 어둡게', () => {
    expect(new THREE.Color(FLASH_SCORED.color).getHSL({ h: 0, s: 0, l: 0 }).l).toBeGreaterThan(0.5)
    expect(new THREE.Color(FLASH_CONCEDED.color).getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(0.2)

    const f = flashQuad(THREE, FLASH_SCORED.color)
    expect(matOf(f.mesh).color.getHex()).toBe(FLASH_SCORED.color)
    f.flash({ color: FLASH_CONCEDED.color })
    expect(matOf(f.mesh).color.getHex()).toBe(FLASH_CONCEDED.color)
    f.dispose()
  })

  it('카메라에 붙어 화각을 가득 채우고 FOV 변화를 따라간다', () => {
    const cam = makeCam()
    const f = flashQuad(THREE)
    f.attach(cam)
    expect(cam.children).toContain(f.mesh)
    expect(f.mesh.frustumCulled).toBe(false)
    expect(matOf(f.mesh).depthTest).toBe(false)
    expect(matOf(f.mesh).depthWrite).toBe(false)
    expect(f.mesh.renderOrder).toBeGreaterThan(100)

    const d = -f.mesh.position.z
    expect(d).toBeGreaterThan(cam.near)
    const expectH = 2 * d * Math.tan(((cam.fov / 2) * Math.PI) / 180)
    expect(f.mesh.scale.y).toBeGreaterThanOrEqual(expectH)
    expect(f.mesh.scale.y).toBeLessThan(expectH * 1.2)
    expect(f.mesh.scale.x).toBeGreaterThanOrEqual(expectH * cam.aspect)

    const before = f.mesh.scale.y
    cam.fov = 60
    f.update(0.016)
    expect(f.mesh.scale.y).toBeGreaterThan(before * 1.3)
    f.dispose()
  })

  it('reduced-motion이면 화면을 번쩍이지 않는다', () => {
    const f = flashQuad(THREE, 0xffffff, { reducedMotion: true })
    f.flash({ peak: 1 })
    f.update(0)
    expect(f.alpha).toBe(0)
    expect(f.mesh.visible).toBe(false)
    f.dispose()
  })

  it('dispose가 리소스를 해제하고 카메라에서 떼어낸다', () => {
    const cam = makeCam()
    const f = flashQuad(THREE, 0xffffff)
    f.attach(cam)
    const { expected, fired } = countDisposals(f.mesh)
    expect(expected).toBeGreaterThanOrEqual(2)
    f.dispose()
    expect(fired()).toBe(expected)
    expect(cam.children).not.toContain(f.mesh)
    expect(() => f.update(0.1)).not.toThrow()
  })
})
