// exterior.ts 단위 테스트 — buildExterior.
//
// 외부 연출은 "보이는가"를 node에서 검증할 수 없으므로, 대신 **화면에서 사라지게 만드는
// 설정 실수**를 고정한다: 하늘/실루엣의 fog 미해제, 라이트 몰래 추가, 그림자 켜짐,
// 빛기둥 토글 무효화, HDR 배율 미반영. 전부 실제로 한 번씩 겪었던 회귀다.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { buildExterior, type ExteriorOptions, type ExteriorStand } from '../exterior'

// ── canvas 2D 스텁 ────────────────────────────────────────────────
// vitest 기본 환경(node)에는 document가 없어 textures.makeCanvas가 항상 null을 돌려주고
// exterior가 단색 폴백만 탄다. 아래 스텁은 no-op 2D 컨텍스트를 심어 텍스처 경로를 강제한다.
// scene.test.ts에 같은 스텁이 있지만 **의도적으로 복제**한다 — 공유 헬퍼로 빼면 동시에
// 편집 중인 기존 테스트 파일을 건드려야 하고, 스텁이 커버해야 할 API 집합도 파일마다 다르다.
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

// ── 테스트용 레이아웃(scene.ts SIDES와 같은 규격) ────────────────
const STAND_DEPTH = 26
const RAKE = 0.5
const STAND_H0 = 1.9
const STANDS: readonly ExteriorStand[] = [
  { yaw: 0, inner: 41, length: 158 },
  { yaw: Math.PI, inner: 41, length: 158 },
  { yaw: Math.PI / 2, inner: 59.5, length: 121 },
  { yaw: -Math.PI / 2, inner: 59.5, length: 121 },
]
const MASTS = [
  { x: 81.5, z: 63 },
  { x: -81.5, z: 63 },
  { x: 81.5, z: -63 },
  { x: -81.5, z: -63 },
]

function opts(over: Partial<ExteriorOptions> = {}): ExteriorOptions {
  return {
    stands: STANDS,
    standDepth: STAND_DEPTH,
    rake: RAKE,
    standH0: STAND_H0,
    masts: MASTS,
    rigY: 42,
    ...over,
  }
}

function findByName(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  let hit: THREE.Object3D | undefined
  root.traverse((o) => {
    if (!hit && o.name === name) hit = o
  })
  return hit
}

function sprites(root: THREE.Object3D): THREE.Sprite[] {
  const out: THREE.Sprite[] = []
  root.traverse((o) => {
    if ((o as THREE.Sprite).isSprite) out.push(o as THREE.Sprite)
  })
  return out
}

/** 가산합성 원뿔(빛기둥)만 센다 — 실루엣 링도 CylinderGeometry라 합성 모드로 갈라야 한다. */
function lightShafts(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    const mat = m.material as THREE.Material | undefined
    if (
      m.geometry?.type === 'CylinderGeometry' &&
      mat &&
      !Array.isArray(mat) &&
      mat.blending === THREE.AdditiveBlending
    ) {
      out.push(m)
    }
  })
  return out
}

/** 트리의 모든 머티리얼 색을 순회 순서대로 뽑는다(setEmissiveBoost 전후 비교용). */
function colors(root: THREE.Object3D): THREE.Color[] {
  const out: THREE.Color[] = []
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material
    if (!mat) return
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      const c = (m as unknown as { color?: THREE.Color }).color
      if (c) out.push(c.clone())
    }
  })
  return out
}

describe('buildExterior 폴백 경로(캔버스 없음)', () => {
  it('throw하지 않고 하늘 돔을 단색으로 세운다', () => {
    const b = buildExterior(THREE, opts())
    expect(b.group.isGroup).toBe(true)
    const sky = findByName(b.group, 'sky-dome') as THREE.Mesh | undefined
    expect(sky).toBeDefined()
    const mat = sky!.material as THREE.MeshBasicMaterial
    // 안쪽에서 보는 돔이므로 BackSide가 아니면 통째로 컬링된다.
    expect(mat.side).toBe(THREE.BackSide)
    // 포그(끝 470m)를 켜면 700m 밖 돔이 전부 포그 색으로 뭉개져 그라디언트가 사라진다.
    expect(mat.fog).toBe(false)
    expect(mat.map ?? null).toBeNull()
  })

  it('텍스처가 없으면 도시 실루엣을 아예 만들지 않는다(단색 링은 검은 띠일 뿐)', () => {
    const b = buildExterior(THREE, opts())
    expect(findByName(b.group, 'skyline')).toBeUndefined()
    expect(sprites(b.group).length).toBe(0)
    expect(lightShafts(b.group).length).toBe(0)
  })
})

describe('buildExterior 텍스처 경로(캔버스 스텁)', () => {
  it('도시 실루엣 링이 포그·깊이쓰기 없이 붙는다', () => {
    const restore = installCanvasStub()
    try {
      const b = buildExterior(THREE, opts())
      const ring = findByName(b.group, 'skyline') as THREE.Mesh | undefined
      expect(ring).toBeDefined()
      const mat = ring!.material as THREE.MeshBasicMaterial
      expect(mat.fog).toBe(false)
      // 원경 링이 깊이를 쓰면 그 앞의 반투명 요소가 잘려 나간다.
      expect(mat.depthWrite).toBe(false)
      expect(mat.map).not.toBeNull()
    } finally {
      restore()
    }
  })

  it('마스트마다 halo 스프라이트 2장(넓은 산란 + 뜨거운 코어)이 생긴다', () => {
    const restore = installCanvasStub()
    try {
      const b = buildExterior(THREE, opts())
      const sp = sprites(b.group)
      expect(sp.length).toBe(MASTS.length * 2)
      for (const s of sp) {
        expect(s.material.blending).toBe(THREE.AdditiveBlending)
        expect(s.material.fog).toBe(false)
      }
    } finally {
      restore()
    }
  })

  it('lightShafts 토글이 실제로 오버드로우를 없앤다', () => {
    const restore = installCanvasStub()
    try {
      const on = buildExterior(THREE, opts())
      expect(lightShafts(on.group).length).toBe(MASTS.length)
      const off = buildExterior(THREE, opts({ lightShafts: false }))
      expect(lightShafts(off.group).length).toBe(0)
    } finally {
      restore()
    }
  })
})

describe('setEmissiveBoost', () => {
  it('배율을 올리면 발광 재질만 밝아지고, 1 이하·NaN은 기본값으로 되돌린다', () => {
    const restore = installCanvasStub()
    try {
      // 포스트FX가 비동기로 붙으므로 이 교체가 동작하지 않으면 블룸이 켜진 뒤에도
      // halo·빛기둥이 리그와 같은 세기로 남아 야간 연출이 밋밋해진다.
      const b = buildExterior(THREE, opts())
      const base = colors(b.group)

      b.setEmissiveBoost(2)
      const up = colors(b.group)
      expect(up.length).toBe(base.length)
      let brighter = 0
      for (let i = 0; i < base.length; i++) {
        expect(up[i].r).toBeGreaterThanOrEqual(base[i].r - 1e-9)
        expect(up[i].g).toBeGreaterThanOrEqual(base[i].g - 1e-9)
        expect(up[i].b).toBeGreaterThanOrEqual(base[i].b - 1e-9)
        if (up[i].r > base[i].r + 1e-6) brighter++
      }
      expect(brighter).toBeGreaterThan(0)

      for (const bad of [1, 0, -3, Number.NaN]) {
        b.setEmissiveBoost(bad)
        const back = colors(b.group)
        for (let i = 0; i < base.length; i++) {
          expect(back[i].r).toBeCloseTo(base[i].r, 6)
          expect(back[i].g).toBeCloseTo(base[i].g, 6)
          expect(back[i].b).toBeCloseTo(base[i].b, 6)
        }
      }
    } finally {
      restore()
    }
  })
})

describe('buildExterior 계약', () => {
  it('라이트를 하나도 만들지 않고 그림자 플래그를 켜지 않는다', () => {
    const restore = installCanvasStub()
    try {
      const b = buildExterior(THREE, opts())
      let lights = 0
      b.group.traverse((o) => {
        if ((o as THREE.Light).isLight) lights++
        // 실시간 그림자는 씬 전체에서 꺼져 있다(scene.test.ts와 같은 계약).
        expect(o.castShadow).toBe(false)
        expect(o.receiveShadow).toBe(false)
      })
      // 조명은 scene.ts가 단독으로 소유한다 — 여기서 늘어나면 드로우콜/셰이더가 조용히 는다.
      expect(lights).toBe(0)
    } finally {
      restore()
    }
  })

  it('두 번 빌드하면 이름·위치가 완전히 같다(Math.random·Date 미사용)', () => {
    const restore = installCanvasStub()
    try {
      const snap = (root: THREE.Object3D): string[] => {
        const out: string[] = []
        root.traverse((o) => {
          const p = o.position
          out.push(`${o.type}|${o.name}|${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`)
        })
        return out
      }
      expect(snap(buildExterior(THREE, opts()).group)).toEqual(
        snap(buildExterior(THREE, opts()).group),
      )
    } finally {
      restore()
    }
  })
})
