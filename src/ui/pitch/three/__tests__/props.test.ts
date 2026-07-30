// props.ts 단위 테스트 — buildGoal / buildCornerFlags.
//
// 두 오브젝트 모두 "실루엣이 레퍼런스로 읽히는가"가 전부다. node에서 픽셀은 볼 수 없으므로
// 실루엣을 결정하는 **기하 불변식**(측면 네트의 사다리꼴, 사선 스테이의 방향, 깃발이
// 향하는 쪽)을 고정한다. 셋 다 첫 렌더에서 틀렸던 항목이다.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { NET_BACK_H, NET_DEPTH, VISUAL_POST_R, buildCornerFlags, buildGoal } from '../props'
import { GOAL_H, GOAL_W, POST_R } from '../textures'
import { PITCH_W, PITCH_H } from '../types'

// ── canvas 2D 스텁 ────────────────────────────────────────────────
// vitest 기본 환경(node)에는 document가 없어 textures.makeCanvas가 null을 돌려주고
// props가 단색 폴백만 탄다. 스텁을 깔아야 네트·깃발 텍스처 경로가 실행된다.
// scene.test.ts에 같은 스텁이 있지만 **의도적으로 복제**한다 — 공유 헬퍼로 빼려면 동시에
// 편집 중인 기존 테스트 파일을 수정해야 하기 때문이다.
function makeCtxStub(): CanvasRenderingContext2D {
  const noop = (): void => {}
  const gradient = { addColorStop: noop }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
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

/** globalThis.document를 캔버스 스텁으로 교체하고 복원 함수를 돌려준다(전역 오염 금지). */
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

const cylinders = (g: THREE.Object3D): THREE.Mesh[] =>
  g.children.filter((c) => (c as THREE.Mesh).geometry?.type === 'CylinderGeometry') as THREE.Mesh[]

/** 네트 패널은 골대에서 유일한 커스텀 BufferGeometry다(나머지는 원통·구). */
const netPanels = (g: THREE.Object3D): THREE.Mesh[] =>
  g.children.filter((c) => (c as THREE.Mesh).geometry?.type === 'BufferGeometry') as THREE.Mesh[]

function verts(mesh: THREE.Mesh): { x: number; y: number; z: number }[] {
  const pos = mesh.geometry.getAttribute('position')
  const out: { x: number; y: number; z: number }[] = []
  for (let i = 0; i < pos.count; i++) out.push({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) })
  return out
}

describe('buildGoal 프레임', () => {
  it.each([-1, 1] as const)('sign %i 골대가 해당 골라인에 선다', (sign) => {
    const g = buildGoal(THREE, { sign })
    expect(g.name).toBe(sign < 0 ? 'goal-west' : 'goal-east')
    const gx = (sign * PITCH_W) / 2
    const front = cylinders(g).filter((c) => Math.abs(c.position.x - gx) < 1e-6)
    // 앞쪽 원통 = 포스트 2 + 크로스바 1.
    expect(front.length).toBe(3)
    const posts = front.filter((c) => c.position.y < GOAL_H - 1e-6)
    expect(posts.length).toBe(2)
    const zs = posts.map((p) => p.position.z).sort((a, b) => a - b)
    expect(zs[0]).toBeCloseTo(-GOAL_W / 2, 6)
    expect(zs[1]).toBeCloseTo(GOAL_W / 2, 6)
    const bar = front.find((c) => Math.abs(c.position.y - GOAL_H) < 1e-6)!
    expect(bar.position.z).toBeCloseTo(0, 6)
  })

  it('시각용 반지름이 물리 정본보다 굵되 규격 상한(12cm) 안이다', () => {
    // 6cm 원통은 방송 카메라 거리(40~90m)에서 1픽셀 미만으로 사라져 네트만 뜬 것처럼
    // 보였다. 반대로 12cm를 넘으면 골대가 규격을 벗어난 통나무가 된다.
    expect(VISUAL_POST_R).toBeGreaterThan(POST_R)
    expect(VISUAL_POST_R).toBeLessThanOrEqual(0.12)
  })

  it.each([-1, 1] as const)('sign %i 사선 스테이가 크로스바 모서리와 뒤 상단을 잇는다', (sign) => {
    const g = buildGoal(THREE, { sign })
    const stays = cylinders(g).filter((c) => {
      const p = (c.geometry as THREE.CylinderGeometry).parameters
      return Math.abs(p.radiusTop - VISUAL_POST_R * 0.6) < 1e-9
    })
    expect(stays.length).toBe(2)
    const back = sign * NET_DEPTH
    const dy = NET_BACK_H - GOAL_H
    const len = Math.hypot(back, dy)
    for (const s of stays) {
      // 원통의 로컬 +Y는 rotZ(θ)에 의해 (-sinθ, cosθ)로 간다. 그 방향이 실제 두 모서리를
      // 잇는 벡터와 어긋나면 스테이가 허공을 가리켜 골대가 부서져 보인다.
      const dirX = -Math.sin(s.rotation.z)
      const dirY = Math.cos(s.rotation.z)
      expect(dirX).toBeCloseTo(back / len, 6)
      expect(dirY).toBeCloseTo(dy / len, 6)
      expect((s.geometry as THREE.CylinderGeometry).parameters.height).toBeCloseTo(len, 6)
    }
  })
})

describe('buildGoal 네트', () => {
  it('뒤쪽 상단이 크로스바보다 낮아 측면 네트가 사다리꼴이 된다', () => {
    // 이 부등식 하나가 "상자형 골대"와 레퍼런스의 골대를 가른다.
    expect(NET_BACK_H).toBeLessThan(GOAL_H)
  })

  it.each([-1, 1] as const)('sign %i 네트 4장이 사다리꼴·양면·깊이쓰기 없음이다', (sign) => {
    const g = buildGoal(THREE, { sign })
    const nets = netPanels(g)
    expect(nets.length).toBe(4) // 측면 2 + 천장 + 뒷면
    for (const n of nets) {
      const mat = n.material as THREE.MeshBasicMaterial
      expect(mat.side).toBe(THREE.DoubleSide)
      // 뒤 네트가 앞 네트에 깊이로 잘리면 그물이 반쪽만 남는다.
      expect(mat.depthWrite).toBe(false)
    }

    const gx = (sign * PITCH_W) / 2
    const bx = gx + sign * NET_DEPTH
    // 측면 패널 = 네 정점의 z가 모두 같은 패널.
    const sides = nets.filter((n) => {
      const v = verts(n)
      return v.every((p) => Math.abs(p.z - v[0].z) < 1e-6)
    })
    expect(sides.length).toBe(2)
    for (const s of sides) {
      const v = verts(s)
      expect(Math.abs(Math.abs(v[0].z) - GOAL_W / 2)).toBeLessThan(1e-6)
      const frontMax = Math.max(...v.filter((p) => Math.abs(p.x - gx) < 1e-6).map((p) => p.y))
      const backMax = Math.max(...v.filter((p) => Math.abs(p.x - bx) < 1e-6).map((p) => p.y))
      expect(frontMax).toBeCloseTo(GOAL_H, 5)
      expect(backMax).toBeCloseTo(NET_BACK_H, 5)
    }
  })

  it('캔버스가 없으면 throw하지 않고 단색 폴백, 있으면 네트 텍스처가 붙는다', () => {
    const plain = buildGoal(THREE, { sign: -1 })
    for (const n of netPanels(plain)) {
      expect((n.material as THREE.MeshBasicMaterial).map ?? null).toBeNull()
    }
    const restore = installCanvasStub()
    try {
      const textured = buildGoal(THREE, { sign: -1 })
      for (const n of netPanels(textured)) {
        expect((n.material as THREE.MeshBasicMaterial).map).not.toBeNull()
      }
    } finally {
      restore()
    }
  })

  it('두 번 빌드하면 구조가 같다(Math.random·Date 미사용)', () => {
    const snap = (g: THREE.Object3D): string[] =>
      g.children.map((c) => {
        const p = c.position
        const r = c.rotation
        return `${(c as THREE.Mesh).geometry?.type}|${p.x},${p.y},${p.z}|${r.x},${r.y},${r.z}`
      })
    expect(snap(buildGoal(THREE, { sign: 1 }))).toEqual(snap(buildGoal(THREE, { sign: 1 })))
  })
})

describe('buildCornerFlags', () => {
  /** 삼각 깃발 플레인 = 코너 그룹에서 유일한 커스텀 BufferGeometry. */
  const flagOf = (g: THREE.Object3D): THREE.Mesh =>
    g.children.find((c) => (c as THREE.Mesh).geometry?.type === 'BufferGeometry') as THREE.Mesh

  it('네 모서리에 하나씩, 부호 조합이 모두 다르다', () => {
    const flags = buildCornerFlags(THREE)
    expect(flags.name).toBe('corner-flags')
    expect(flags.children.length).toBe(4)
    const seen = new Set<string>()
    for (const c of flags.children) {
      expect(Math.abs(c.position.x)).toBeCloseTo(PITCH_W / 2, 6)
      expect(c.position.y).toBeCloseTo(0, 6)
      expect(Math.abs(c.position.z)).toBeCloseTo(PITCH_H / 2, 6)
      seen.add(`${Math.sign(c.position.x)},${Math.sign(c.position.z)}`)
    }
    expect(seen.size).toBe(4)
  })

  it('깃발이 로컬 +Z로 뻗고 피치 바깥을 향한다', () => {
    // 첫 렌더에서 깃발 방향을 코너 이등분선으로 두었더니 골 뒤 카메라에서 정확히
    // 엣지온이 되어 화면에서 사라졌다. "바깥을 향하되 엣지온이 아니다"가 계약이다.
    const flags = buildCornerFlags(THREE)
    for (const c of flags.children) {
      const flag = flagOf(c)
      expect(flag).toBeDefined()
      const v = verts(flag)
      const zs = v.map((p) => p.z)
      expect(Math.min(...zs)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...zs)).toBeCloseTo(0.45, 3)

      // 그룹 yaw로 회전한 로컬 +Z의 월드 방향.
      const yaw = c.rotation.y
      const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
      // 코너에서 피치 중심의 반대 방향(= 코너 위치 벡터).
      const outward = new THREE.Vector3(c.position.x, 0, c.position.z).normalize()
      expect(dir.dot(outward)).toBeGreaterThan(0)
    }
  })

  it('캔버스가 없으면 throw하지 않고 단색 폴백, 있으면 깃발 텍스처가 붙는다', () => {
    const plain = buildCornerFlags(THREE)
    expect((flagOf(plain.children[0]).material as THREE.MeshLambertMaterial).map ?? null).toBeNull()
    const restore = installCanvasStub()
    try {
      const textured = buildCornerFlags(THREE)
      const mat = flagOf(textured.children[0]).material as THREE.MeshLambertMaterial
      expect(mat.map).not.toBeNull()
      expect(mat.side).toBe(THREE.DoubleSide)
    } finally {
      restore()
    }
  })

  it('두 번 빌드하면 구조가 같다(Math.random·Date 미사용)', () => {
    const snap = (root: THREE.Object3D): string[] => {
      const out: string[] = []
      root.traverse((o) => {
        const p = o.position
        out.push(`${o.type}|${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}|${o.rotation.y.toFixed(6)}`)
      })
      return out
    }
    expect(snap(buildCornerFlags(THREE))).toEqual(snap(buildCornerFlags(THREE)))
  })
})
