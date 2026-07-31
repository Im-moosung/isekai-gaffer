// src/ui/pitch/three/fx3d.ts
// Phase 4E 3D 매치 뷰 — 3D 볼 · 골 파티클 · 플래시 쿼드.
//
// 설계 원칙(Phase 4E Global Constraints):
//  - three는 **인자 주입**(`createBall(THREE, …)`). 정적 import는 타입뿐이라 엔트리 번들에
//    three가 새지 않는다(코드 스플릿 보장).
//  - **외부 에셋 0**: 공 가죽 무늬는 canvas 절차 생성(오각형 12개 = 잘린 정이십면체 근사).
//    canvas 미지원 환경에서는 null → 단색 폴백(테스트·SSR에서 크래시 금지).
//  - **Math.random·Date 금지**: 파티클 초기 속도·크기·색 지터까지 전부 시드 해시(hash01).
//    같은 seed → 같은 폭발.
//  - **reduced-motion**: 트레일·파티클·플래시를 비활성화할 수 있다.
//  - 생성한 모든 geometry/material/texture는 `dispose()`가 남김없이 해제한다.
import type * as THREE_NS from 'three'
import { makeContactShadow, type ThreeAPI } from './scene'
import { hash01, makeCanvas } from './textures'
import type { BallPose, Vec3 } from './types'

const TAU = Math.PI * 2
const DEG = Math.PI / 180
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// ── 볼 ────────────────────────────────────────────────────────────
/** 공식 5호구 반지름(m). movement.ts의 BALL_RADIUS와 같은 스케일. */
export const BALL_R = 0.115
/**
 * 이 높이(m)에서 그림자가 최대로 커지고 옅어진다.
 *
 * **볼 트레일을 걷어낸 뒤 "공이 떠 있다"를 말하는 유일한 단서**라 값이 중요하다.
 * 실제 중계에서도 시청자는 잔디에 붙은 그림자와 공 사이의 간격으로 높이를 읽는다.
 */
const SHADOW_FADE_H = 6

// ── 골 파티클 ─────────────────────────────────────────────────────
export const BURST_COUNT = 60
export const BURST_LIFE = 1.5
/** 파티클 중력(m/s²). */
export const BURST_GRAVITY = -16
/** 파티클이 잔디를 뚫지 않는 최저 높이(m). */
const BURST_GROUND = 0.06

// ── 플래시 프리셋 ─────────────────────────────────────────────────
/** 득점 = 흰 섬광. */
export const FLASH_SCORED = { color: 0xffffff, peak: 0.62, duration: 0.55 } as const
/** 실점 = 어두운 암전. */
export const FLASH_CONCEDED = { color: 0x05070c, peak: 0.5, duration: 0.7 } as const

/**
 * 축구공 가죽 무늬 캔버스(2:1 적도 전개). 잘린 정이십면체의 오각형 12개를
 * 정이십면체 꼭짓점 방향에서 구해 등장방형 투영으로 찍는다.
 * @param size 가로 픽셀(세로는 절반). @returns 캔버스 또는 null(미지원 환경)
 */
export function makeBallCanvas(size = 256): HTMLCanvasElement | null {
  const W = Math.max(8, Math.round(size))
  const H = Math.max(4, Math.round(W / 2))
  const c = makeCanvas(W, H)
  if (!c) return null
  const { ctx, canvas } = c

  // 흰 가죽 베이스 + 미세 얼룩(결정론)
  ctx.fillStyle = '#f3f5fa'
  ctx.fillRect(0, 0, W, H)
  for (let i = 0; i < 600; i++) {
    const x = hash01(i * 3 + 17) * W
    const y = hash01(i * 3 + 9871) * H
    const s = 1 + hash01(i + 331) * (W / 90)
    ctx.fillStyle = hash01(i + 7717) > 0.5 ? 'rgba(255,255,255,0.5)' : 'rgba(120,132,150,0.16)'
    ctx.fillRect(x, y, s, s)
  }

  // 정이십면체 12 꼭짓점 = 오각형 중심
  const t = (1 + Math.sqrt(5)) / 2
  const verts: [number, number, number][] = []
  for (const a of [-1, 1] as const) {
    for (const b of [-1, 1] as const) {
      verts.push([0, a, b * t], [a, b * t, 0], [a * t, 0, b])
    }
  }
  const r = W * 0.052
  ctx.fillStyle = '#1b2028'
  verts.forEach((v, i) => {
    const len = Math.hypot(v[0], v[1], v[2])
    const nx = v[0] / len
    const ny = v[1] / len
    const nz = v[2] / len
    const u = 0.5 + Math.atan2(nz, nx) / TAU
    const cy = (0.5 - Math.asin(ny) / Math.PI) * H
    const cx = u * W
    // 등장방형 투영은 위도가 높을수록 가로로 압축된다 → 그리는 쪽을 늘려 보정.
    const stretch = 1 / Math.max(0.35, Math.sqrt(1 - ny * ny))
    const rot = hash01(i * 13 + 7) * TAU
    pentagon(ctx, cx, cy, r, stretch, rot)
    // 좌우 이음매(u=0/1)를 가로지르는 조각은 반대편에도 한 번 더.
    if (cx < r * stretch) pentagon(ctx, cx + W, cy, r, stretch, rot)
    else if (cx > W - r * stretch) pentagon(ctx, cx - W, cy, r, stretch, rot)
  })
  return canvas
}

/** 오각형 하나(가로 stretch 보정 + 회전). */
function pentagon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  stretch: number,
  rot: number,
): void {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(stretch, 1)
  ctx.rotate(rot)
  ctx.beginPath()
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + (k * TAU) / 5
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (k === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

export interface BallOptions {
  /** 공 반지름(m). 기본 {@link BALL_R}. */
  radius?: number
  /** 가죽 텍스처 가로 픽셀. 기본 256. */
  texSize?: number
}

export interface Ball3D {
  /** 씬에 붙일 루트(공 + 접지 그림자). */
  group: THREE_NS.Group
  mesh: THREE_NS.Mesh
  shadow: THREE_NS.Mesh
  /**
   * 매 프레임 호출 — 위치·구름 회전·그림자 갱신.
   * @param dt 프레임 델타(s). 트레일 제거 후 현재 구현은 쓰지 않지만, 볼 연출이 다시
   *           시간 적분을 필요로 할 때 호출부를 전부 고치지 않도록 계약에 남겨 둔다.
   */
  update(ball: BallPose, dt: number): void
  dispose(): void
}

/**
 * 3D 볼. 절차 텍스처 구체 + 이동 방향 기반 구름 회전 + 컨택트 섀도우.
 *
 * **트레일은 없다(2026-07-31 제거).** 예전에는 0.18 m 간격으로 구체 10개를 뿌려
 * 잔상을 흉내 냈는데, 실주행에서 "잔디에 떨어진 회색 쓰레기 10개"로 읽혔다. 근거:
 *  1) 실제 축구 중계에 볼 트레일은 없다. 이 프로젝트의 3D 계층은 카메라 문법·dwell·
 *     항력 궤적까지 전부 중계 문법에 맞춰 왔다 — 트레일만 게임 UI 어휘였다.
 *  2) 잔상은 **번짐**으로 읽혀야 하는데, 크기·간격이 균일한 불투명 구체 10개는
 *     번짐이 아니라 정지한 물체 10개로 보인다. 방송 카메라 거리(20~40 m)에서 공이
 *     3~5 px이라 세그먼트도 같은 크기의 점이 되고, 속도 비례 축소·페이드를 넣어도
 *     "점선"이라는 성질은 그대로다.
 *  3) 높이 단서는 이미 컨택트 섀도우가 물리적으로 정확하게 준다({@link SHADOW_FADE_H}).
 *     트레일은 그 위에 얹은 중복 신호였고, 오히려 그림자와 겹쳐 지저분했다.
 *  4) 프레임당 메시 10개 · 머티리얼 10개가 사라진다(리듀스드 모션 분기도 함께).
 *
 * @param THREE 주입된 three 네임스페이스
 */
export function createBall(THREE: ThreeAPI, opts: BallOptions = {}): Ball3D {
  const r = opts.radius ?? BALL_R

  const group = new THREE.Group()
  group.name = 'ball'

  const tex = toTexture(THREE, makeBallCanvas(opts.texSize ?? 256))
  const geo = new THREE.SphereGeometry(r, 22, 16)
  const mat = new THREE.MeshStandardMaterial({
    color: tex ? 0xffffff : 0xf2f4f8,
    ...(tex ? { map: tex } : {}),
    roughness: 0.45,
    metalness: 0.02,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'ball-mesh'
  mesh.position.y = r
  group.add(mesh)

  const shadow = makeContactShadow(THREE, r * 3.4, 0.5)
  const shadowMat = shadow.material as THREE_NS.MeshBasicMaterial
  const shadowBase = shadowMat.opacity
  group.add(shadow)

  const axis = new THREE.Vector3()
  const spinQ = new THREE.Quaternion()
  let prev: Vec3 | null = null
  let disposed = false

  function update(ball: BallPose, _dt: number): void {
    if (disposed) return
    const y = ball.y > r ? ball.y : r
    mesh.position.set(ball.x, y, ball.z)

    // ── 구름 회전: 수평 이동 방향에 수직인 축으로 (이동거리/반지름) rad ──
    if (prev) {
      const dx = ball.x - prev.x
      const dz = ball.z - prev.z
      const dist = Math.hypot(dx, dz)
      if (dist > 1e-9) {
        axis.set(dz / dist, 0, -dx / dist)
        spinQ.setFromAxisAngle(axis, dist / r)
        mesh.quaternion.premultiply(spinQ)
      }
    }
    prev = { x: ball.x, y, z: ball.z }

    // ── 컨택트 섀도우: 높이에 따라 커지고 옅어진다 ──
    const k = clamp((y - r) / SHADOW_FADE_H, 0, 1)
    shadow.position.set(ball.x, 0.02, ball.z)
    const s = 1 + k * 1.6
    shadow.scale.set(s, 1, s)
    shadowMat.opacity = shadowBase * (1 - k * 0.8)
  }

  function dispose(): void {
    disposed = true
    disposeTree(group)
    group.clear()
    group.removeFromParent()
    prev = null
  }

  return { group, mesh, shadow, update, dispose }
}

export interface BurstOptions {
  /** 파티클 수. 기본 {@link BURST_COUNT}. */
  count?: number
  /** 결정론 시드. 기본 1. */
  seed?: number
  /** true면 파티클을 그리지 않는다(즉시 done). */
  reducedMotion?: boolean
  /** 수명(s). 기본 {@link BURST_LIFE}. */
  life?: number
}

export interface GoalBurst {
  mesh: THREE_NS.InstancedMesh
  /** 수명이 끝났는가. */
  readonly done: boolean
  readonly elapsed: number
  /** 매 프레임 호출. 아직 살아 있으면 true. */
  update(dt: number): boolean
  dispose(): void
}

/**
 * 골 파티클 폭발 — 팀 컬러 콘페티 60개가 중력을 받으며 튀고 페이드아웃한다.
 * 초기 속도·크기·회전·색 지터는 전부 시드 해시(같은 seed → 같은 폭발).
 *
 * @param color 팀 컬러(hex)
 * @param at    폭발 지점(월드)
 */
export function goalBurst(
  THREE: ThreeAPI,
  color: number,
  at: Vec3,
  opts: BurstOptions = {},
): GoalBurst {
  const n = Math.max(0, Math.round(opts.count ?? BURST_COUNT))
  const life = opts.life != null && opts.life > 0 ? opts.life : BURST_LIFE
  const seed = opts.seed ?? 1
  const reduced = opts.reducedMotion === true

  const geo = new THREE.BoxGeometry(0.24, 0.24, 0.05)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, n)
  mesh.name = 'goal-burst'
  mesh.frustumCulled = false

  const vel = new Float32Array(n * 3)
  const size = new Float32Array(n)
  const spin = new Float32Array(n * 2)
  const base = new THREE.Color(color)
  const col = new THREE.Color()
  const dummy = new THREE.Object3D()

  for (let i = 0; i < n; i++) {
    const h = (salt: number) => hash01(Math.imul(seed | 0, 2654435761) ^ (i * 977 + salt))
    const az = h(1) * TAU
    // 위로 치솟는 원뿔(14°~91°) — 잔디에 깔리지 않고 화면에 뜬다.
    const el = 0.25 + h(2) * 1.35
    const sp = 6 + h(3) * 9
    const flat = Math.cos(el) * sp
    vel[i * 3] = Math.cos(az) * flat
    vel[i * 3 + 1] = Math.sin(el) * sp
    vel[i * 3 + 2] = Math.sin(az) * flat
    size[i] = 0.7 + h(4) * 0.8
    spin[i * 2] = (h(5) - 0.5) * 26
    spin[i * 2 + 1] = (h(6) - 0.5) * 26
    // 0.62~1.0 배 — instanceColor가 [0,1]을 벗어나지 않는다(과노출 방지).
    col.copy(base).multiplyScalar(0.62 + h(7) * 0.38)
    mesh.setColorAt(i, col)
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

  let elapsed = 0
  let done = reduced || n === 0
  if (done) {
    mesh.count = 0
    mat.opacity = 0
  } else {
    write()
  }

  function write(): void {
    const u = clamp(elapsed / life, 0, 1)
    const e = elapsed
    for (let i = 0; i < n; i++) {
      const py = at.y + vel[i * 3 + 1] * e + 0.5 * BURST_GRAVITY * e * e
      dummy.position.set(
        at.x + vel[i * 3] * e,
        py < BURST_GROUND ? BURST_GROUND : py,
        at.z + vel[i * 3 + 2] * e,
      )
      dummy.rotation.set(spin[i * 2] * e, spin[i * 2 + 1] * e, 0)
      dummy.scale.setScalar(size[i] * (0.4 + 0.6 * (1 - u)))
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    mesh.instanceMatrix.needsUpdate = true
    // 끝에서 급히 사라지는 페이드(초반엔 또렷하게 보인다).
    mat.opacity = 1 - u * u * u
  }

  return {
    mesh,
    get done() {
      return done
    },
    get elapsed() {
      return elapsed
    },
    update(dt: number): boolean {
      if (done) return false
      elapsed += dt > 0 ? dt : 0
      if (elapsed >= life) {
        done = true
        elapsed = life
        mesh.count = 0
        mat.opacity = 0
        return false
      }
      write()
      return true
    },
    dispose(): void {
      done = true
      mesh.removeFromParent()
      geo.dispose()
      mat.dispose()
      // instanceMatrix/instanceColor GPU 버퍼는 'dispose' 이벤트로만 회수된다.
      mesh.dispose()
    },
  }
}

export interface FlashOptions {
  /** 기본 최대 알파. */
  peak?: number
  /** 기본 지속(s). */
  duration?: number
  /** true면 절대 번쩍이지 않는다. */
  reducedMotion?: boolean
}

export interface FlashTrigger {
  color?: number
  peak?: number
  duration?: number
}

export interface FlashQuad {
  mesh: THREE_NS.Mesh
  /** 현재 알파(0이면 숨김). */
  readonly alpha: number
  /** 카메라 자식으로 붙인다(카메라 앞 풀스크린). */
  attach(camera: THREE_NS.PerspectiveCamera): void
  /** 섬광 시작. reduced-motion이면 무시된다. */
  flash(trigger?: FlashTrigger): void
  update(dt: number): void
  dispose(): void
}

/** 쿼드가 카메라 프러스텀을 확실히 덮도록 두는 여유. */
const FLASH_MARGIN = 1.04

/**
 * 카메라 앞 풀스크린 쿼드(득점=밝게 / 실점=어둡게). 카메라의 자식으로 붙어
 * FOV·aspect 변화를 매 프레임 추종한다(카메라 모드 전환 중에도 화면을 꽉 채운다).
 */
export function flashQuad(THREE: ThreeAPI, color = 0xffffff, opts: FlashOptions = {}): FlashQuad {
  const reduced = opts.reducedMotion === true
  const geo = new THREE.PlaneGeometry(1, 1)
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.name = 'flash-quad'
  mesh.frustumCulled = false
  mesh.renderOrder = 999
  mesh.visible = false

  let cam: THREE_NS.PerspectiveCamera | null = null
  let alpha = 0
  let active = false
  let elapsed = 0
  let peak = opts.peak ?? FLASH_SCORED.peak
  let duration = opts.duration ?? FLASH_SCORED.duration
  let disposed = false

  function resize(): void {
    if (!cam) return
    const d = Math.max(cam.near * 1.5, 1)
    const h = 2 * d * Math.tan((cam.fov / 2) * DEG)
    mesh.position.set(0, 0, -d)
    mesh.scale.set(h * cam.aspect * FLASH_MARGIN, h * FLASH_MARGIN, 1)
  }

  return {
    mesh,
    get alpha() {
      return alpha
    },
    attach(camera: THREE_NS.PerspectiveCamera): void {
      if (disposed) return
      cam = camera
      camera.add(mesh)
      resize()
    },
    flash(trigger: FlashTrigger = {}): void {
      if (disposed || reduced) return
      if (trigger.color != null) mat.color.setHex(trigger.color)
      if (trigger.peak != null) peak = trigger.peak
      if (trigger.duration != null) duration = trigger.duration
      elapsed = 0
      active = true
    },
    update(dt: number): void {
      if (disposed) return
      resize()
      if (!active) return
      elapsed += dt > 0 ? dt : 0
      const u = duration > 0 ? elapsed / duration : 1
      if (u >= 1) {
        active = false
        alpha = 0
      } else {
        alpha = peak * (1 - u) * (1 - u)
      }
      mat.opacity = alpha
      mesh.visible = alpha > 0.002
    },
    dispose(): void {
      disposed = true
      active = false
      alpha = 0
      mesh.removeFromParent()
      cam = null
      geo.dispose()
      mat.dispose()
    },
  }
}

/** canvas → CanvasTexture(없으면 null). */
function toTexture(THREE: ThreeAPI, canvas: HTMLCanvasElement | null): THREE_NS.CanvasTexture | null {
  if (!canvas) return null
  const tex = new THREE.CanvasTexture(canvas)
  if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

/** 트리의 geometry/material/texture를 남김없이 해제한다(scene.ts와 같은 규칙). */
function disposeTree(root: THREE_NS.Object3D): void {
  const geos = new Set<THREE_NS.BufferGeometry>()
  const mats = new Set<THREE_NS.Material>()
  root.traverse((obj) => {
    const any = obj as unknown as {
      geometry?: THREE_NS.BufferGeometry
      material?: THREE_NS.Material | THREE_NS.Material[]
      isInstancedMesh?: boolean
      dispose?: () => void
    }
    if (any.geometry) geos.add(any.geometry)
    if (any.material) {
      if (Array.isArray(any.material)) for (const m of any.material) mats.add(m)
      else mats.add(any.material)
    }
    if (any.isInstancedMesh && typeof any.dispose === 'function') any.dispose()
  })
  for (const g of geos) g.dispose()
  for (const m of mats) {
    const rec = m as unknown as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      const v = rec[key] as { isTexture?: boolean; dispose?: () => void } | null
      if (v && typeof v === 'object' && v.isTexture && typeof v.dispose === 'function') v.dispose()
    }
    m.dispose()
  }
}
