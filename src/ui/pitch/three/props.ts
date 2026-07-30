// src/ui/pitch/three/props.ts
// 피치 위 개별 오브젝트 — 골대와 코너 플래그. 각각 docs/refs/stadium/의 레퍼런스가 있다.
//
// ── 골대: 레퍼런스 대비 무엇이 달랐나 ────────────────────────────
// `goal-front-three-quarter.png`는 **뒤로 기울어진 상자형** 골대다. 크로스바에서 네트가
// 뒤·아래로 흘러 뒤쪽 낮은 바에 걸리고, 거기서 지면까지 수직으로 떨어진다. 측면 네트는
// 그래서 사각형이 아니라 **사다리꼴**이고, 그 사다리꼴 실루엣이 골대를 골대로 읽게 하는
// 가장 큰 신호다. 예전 구현은 깊이 2m짜리 **직육면체**(뒷면이 크로스바와 같은 높이의
// 직사각형)라 옆에서 보면 상자였다. 네트 격자도 0.6m 타일이라 실제 그물(10~14cm)보다
// 5배 성겨서 원경에서 격자가 아니라 굵은 창살로 보였다.
//
// ── 코너 플래그 ──────────────────────────────────────────────────
// `corner-flag-main-side.png`: 얇고 약간 휜 흰 폴, 삼각 플레인 한 장, 노랑/코럴 큰 색면,
// 어두운 팔각 베이스. 예전에는 **아예 없었다**(코너 아크 라인만 피치 텍스처에 있었다).
//
// 제약: Math.random / Date 금지. three는 인자 주입(코드 스플릿). 텍스처 null이면 단색 폴백.
import type * as THREE_NS from 'three'
import { PITCH_W, PITCH_H } from './types'
import { GOAL_H, GOAL_W, makeFlagCanvas, makeNetCanvas } from './textures'

type ThreeAPI = typeof THREE_NS

/**
 * 골대 프레임의 **시각용** 반지름(m). 규격 상한은 12cm이고 `textures.POST_R`(0.06)은
 * 물리·판정이 쓰는 정본이라 건드리지 않는다. 방송 카메라 거리(40~90m)에서 6cm 원통은
 * 1픽셀 미만으로 사라져 골대가 네트만 뜬 것처럼 보였다 — 시각 지오메트리만 규격 상한에
 * 가깝게 올린다.
 */
export const VISUAL_POST_R = 0.09
/** 골 네트 깊이(골라인에서 뒤쪽 바닥 프레임까지, m). 규정 권장 2m. */
export const NET_DEPTH = 2.0
/** 뒤쪽 상단 바 높이(m). 크로스바(2.44)보다 낮아야 측면 네트가 사다리꼴이 된다. */
export const NET_BACK_H = 1.28
/**
 * 네트 한 칸 크기(m). 실제 축구 골 네트는 10~14cm 마름모/사각이다. 0.6m였던 예전 값의
 * 1/5로, 원경에서는 밉맵이 회색 안개로 눌러 주고 근경에서는 레퍼런스의 촘촘한 격자가 된다.
 */
const NET_CELL = 0.16

// ── 공용: UV까지 직접 잡는 사각 패널 ────────────────────────────
/**
 * 임의의 사각형(사다리꼴 포함) 네 꼭짓점으로 평면 지오메트리를 만든다.
 * `PlaneGeometry`는 직사각형만 되므로 사다리꼴 측면 네트를 만들 수 없다.
 * UV는 (0,0)-(1,1)로 깔고 호출부가 `texture.repeat`으로 칸 수를 정한다.
 * 꼭짓점 순서: 좌하 → 우하 → 우상 → 좌상.
 */
function quadGeometry(
  THREE: ThreeAPI,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
): THREE_NS.BufferGeometry {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3),
  )
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  geo.setIndex([0, 1, 2, 0, 2, 3])
  geo.computeVertexNormals()
  return geo
}

/**
 * 네트 텍스처를 패널 실치수에 맞춰 만든다(칸이 항상 정사각으로 보이게).
 * 공유 base를 clone하지 않고 **캔버스에서 직접** 만든다 — clone 방식이면 base 자체가
 * 어떤 머티리얼에도 붙지 않아 disposeTree의 순회에서 빠지고 영구 누수된다.
 */
function netPanelTexture(
  THREE: ThreeAPI,
  canvas: HTMLCanvasElement | null,
  aniso: number,
  widthM: number,
  heightM: number,
): THREE_NS.Texture | null {
  if (!canvas) return null
  const t = new THREE.CanvasTexture(canvas)
  t.anisotropy = Math.max(1, aniso)
  t.wrapS = THREE.RepeatWrapping
  t.wrapT = THREE.RepeatWrapping
  t.repeat.set(Math.max(1, widthM / NET_CELL), Math.max(1, heightM / NET_CELL))
  t.needsUpdate = true
  return t
}

export interface GoalOptions {
  /** -1 = 서쪽(-X) 골, +1 = 동쪽(+X) 골. */
  sign: -1 | 1
  maxAnisotropy?: number
}

/**
 * 골대 하나(프레임 + 사다리꼴 네트). 반환 그룹을 pitchGroup에 붙인다.
 * 해제는 scene.disposeTree가 순회로 처리한다.
 */
export function buildGoal(THREE: ThreeAPI, opts: GoalOptions): THREE_NS.Group {
  const { sign } = opts
  const aniso = Math.max(1, opts.maxAnisotropy ?? 8)
  const group = new THREE.Group()
  group.name = sign < 0 ? 'goal-west' : 'goal-east'

  const gx = (sign * PITCH_W) / 2
  const hw = GOAL_W / 2
  /** 골 바깥 방향으로의 깊이 오프셋(월드 x). */
  const back = sign * NET_DEPTH

  // ── 프레임 ────────────────────────────────────────────────────
  // 레퍼런스의 프레임은 균일한 굵기의 흰 튜브 + **둥근 모서리**다. 원통만 이어 붙이면
  // 크로스바-포스트 접합부가 각져서 저가 3D 티가 난다 — 이음매마다 구를 하나 박는다.
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xf7fAff,
    roughness: 0.32,
    metalness: 0.04,
    // 야간 사각지대에서도 프레임이 완전히 죽지 않게 하는 최소 자발광.
    emissive: new THREE.Color(0x263140),
  })
  const postGeo = new THREE.CylinderGeometry(VISUAL_POST_R, VISUAL_POST_R, GOAL_H, 10)
  const jointGeo = new THREE.SphereGeometry(VISUAL_POST_R, 10, 6)
  for (const zs of [-1, 1] as const) {
    const post = new THREE.Mesh(postGeo, frameMat)
    post.position.set(gx, GOAL_H / 2, zs * hw)
    group.add(post)
    const joint = new THREE.Mesh(jointGeo, frameMat)
    joint.position.set(gx, GOAL_H, zs * hw)
    group.add(joint)
  }
  const bar = new THREE.Mesh(
    new THREE.CylinderGeometry(VISUAL_POST_R, VISUAL_POST_R, GOAL_W, 10),
    frameMat,
  )
  bar.rotation.x = Math.PI / 2
  bar.position.set(gx, GOAL_H, 0)
  group.add(bar)

  // 뒤쪽 프레임: 바닥 바 + 상단 바 + 두 수직 기둥. 여기에 네트가 걸린다.
  const backBarGeo = new THREE.CylinderGeometry(VISUAL_POST_R * 0.7, VISUAL_POST_R * 0.7, GOAL_W, 8)
  for (const y of [0.06, NET_BACK_H] as const) {
    const b = new THREE.Mesh(backBarGeo, frameMat)
    b.rotation.x = Math.PI / 2
    b.position.set(gx + back, y, 0)
    group.add(b)
  }
  const backPostGeo = new THREE.CylinderGeometry(VISUAL_POST_R * 0.7, VISUAL_POST_R * 0.7, NET_BACK_H, 8)
  for (const zs of [-1, 1] as const) {
    const p = new THREE.Mesh(backPostGeo, frameMat)
    p.position.set(gx + back, NET_BACK_H / 2, zs * hw)
    group.add(p)
    // 크로스바 모서리 → 뒤쪽 상단 모서리 사선 스테이(레퍼런스의 측면 사선).
    const dx = back
    const dy = NET_BACK_H - GOAL_H
    const len = Math.sqrt(dx * dx + dy * dy)
    const stay = new THREE.Mesh(
      new THREE.CylinderGeometry(VISUAL_POST_R * 0.6, VISUAL_POST_R * 0.6, len, 8),
      frameMat,
    )
    stay.position.set(gx + dx / 2, GOAL_H + dy / 2, zs * hw)
    // 원통 로컬 +Y를 (dx, dy) 방향으로 눕힌다. z축 고정이라 z 회전 하나로 충분하다.
    // rotZ(θ)는 +Y를 (-sinθ, cosθ)로 보내므로 θ = atan2(-dx, dy).
    stay.rotation.z = Math.atan2(-dx, dy)
    group.add(stay)
  }

  // ── 네트 ──────────────────────────────────────────────────────
  // 굵기 인자를 6으로 올린다: 기본(12)은 칸 대비 선 폭이 8%뿐이라 첫 렌더에서 네트가
  // 사실상 보이지 않았다. 레퍼런스의 네트는 선이 분명한 흰 격자다.
  const netCanvas = makeNetCanvas(128, 8, 6)
  /** 패널 하나를 만든다. 네트는 양면 + depthWrite off(뒤 네트가 앞 네트에 가려지지 않게). */
  const netMesh = (
    geo: THREE_NS.BufferGeometry,
    w: number,
    h: number,
  ): THREE_NS.Mesh => {
    const t = netPanelTexture(THREE, netCanvas, aniso, w, h)
    const mat = new THREE.MeshBasicMaterial({
      color: t ? 0xe4ebf5 : 0xaab4c2,
      ...(t ? { map: t } : {}),
      transparent: true,
      opacity: t ? 0.95 : 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    })
    const m = new THREE.Mesh(geo, mat)
    m.renderOrder = 1
    return m
  }

  const sideLen = Math.sqrt(NET_DEPTH * NET_DEPTH + (GOAL_H - NET_BACK_H) * (GOAL_H - NET_BACK_H))
  for (const zs of [-1, 1] as const) {
    // 측면 사다리꼴: 골라인 바닥 → 골라인 크로스바 → 뒤 상단 → 뒤 바닥.
    const geo = quadGeometry(
      THREE,
      [gx, 0, zs * hw],
      [gx, GOAL_H, zs * hw],
      [gx + back, NET_BACK_H, zs * hw],
      [gx + back, 0, zs * hw],
    )
    group.add(netMesh(geo, GOAL_H, NET_DEPTH))
  }
  // 천장: 크로스바 → 뒤 상단 바(뒤로 내려가는 경사면).
  group.add(
    netMesh(
      quadGeometry(
        THREE,
        [gx, GOAL_H, -hw],
        [gx, GOAL_H, hw],
        [gx + back, NET_BACK_H, hw],
        [gx + back, NET_BACK_H, -hw],
      ),
      GOAL_W,
      sideLen,
    ),
  )
  // 뒷면: 뒤 상단 바 → 지면(수직).
  group.add(
    netMesh(
      quadGeometry(
        THREE,
        [gx + back, 0, -hw],
        [gx + back, 0, hw],
        [gx + back, NET_BACK_H, hw],
        [gx + back, NET_BACK_H, -hw],
      ),
      GOAL_W,
      NET_BACK_H,
    ),
  )

  return group
}

// ── 코너 플래그 ─────────────────────────────────────────────────
/** 폴 높이(m). 경기 규칙상 1.5m 이상. */
export const FLAG_POLE_H = 1.5
/** 깃발 크기(m). 규정 30×45cm. */
const FLAG_H = 0.3
const FLAG_L = 0.45

/**
 * 코너 플래그 4개를 담은 그룹. 폴은 레퍼런스처럼 **살짝 휘어** 있다(2단 원통).
 * 깃발은 삼각 플레인 한 장이되 u 방향으로 3등분해 저폴리 접힘을 준다 —
 * 완전 평면이면 종이처럼 보이고, 레퍼런스도 각진 면 몇 개로 천을 표현했다.
 */
export function buildCornerFlags(THREE: ThreeAPI, maxAnisotropy = 8): THREE_NS.Group {
  const group = new THREE.Group()
  group.name = 'corner-flags'

  const poleMat = new THREE.MeshStandardMaterial({
    color: 0xf2f6fc,
    roughness: 0.4,
    metalness: 0.02,
    emissive: new THREE.Color(0x1e2733),
  })
  const baseMat = new THREE.MeshLambertMaterial({ color: 0x2a2f39 })
  const flagCanvas = makeFlagCanvas(128, 96)
  const flagTex = flagCanvas ? new THREE.CanvasTexture(flagCanvas) : null
  if (flagTex) {
    if (THREE.SRGBColorSpace) flagTex.colorSpace = THREE.SRGBColorSpace
    flagTex.anisotropy = Math.max(1, maxAnisotropy)
    flagTex.needsUpdate = true
  }
  const flagMat = new THREE.MeshLambertMaterial({
    color: flagTex ? 0xffffff : 0xf5c518,
    ...(flagTex ? { map: flagTex } : {}),
    side: THREE.DoubleSide,
    // 야간 사각지대에서 노랑이 갈색으로 죽지 않게 하는 최소 자발광.
    emissive: new THREE.Color(0x3a3010),
  })

  // 폴은 두 토막으로 나눠 위쪽을 살짝 기울인다(레퍼런스의 휨).
  const lowGeo = new THREE.CylinderGeometry(0.021, 0.026, FLAG_POLE_H * 0.55, 6)
  const highGeo = new THREE.CylinderGeometry(0.018, 0.021, FLAG_POLE_H * 0.48, 6)
  const capGeo = new THREE.SphereGeometry(0.028, 8, 6)
  const baseGeo = new THREE.CylinderGeometry(0.085, 0.105, 0.13, 8)
  const flagGeo = flagPanelGeometry(THREE)

  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const g = new THREE.Group()
      g.position.set((sx * PITCH_W) / 2, 0, (sz * PITCH_H) / 2)
      // 깃발 방향. 코너 이등분선(atan2(sx, sz))으로 두면 골 뒤 카메라에서 정확히
      // 엣지온이 되어 **깃발이 사라진다**(첫 렌더에서 실제로 그랬다). z 성분을 0.35로
      // 눌러 터치라인 방향으로 기울이면, 피치 바깥을 향하면서도 롱사이드 방송
      // 카메라에는 항상 넓은 면을 보인다.
      g.rotation.y = Math.atan2(sx, sz * 0.35)

      const base = new THREE.Mesh(baseGeo, baseMat)
      base.position.y = 0.065
      g.add(base)

      const low = new THREE.Mesh(lowGeo, poleMat)
      low.position.y = 0.13 + (FLAG_POLE_H * 0.55) / 2
      g.add(low)

      // 위쪽 토막을 3.5° 기울여 이음매에서 곡선처럼 보이게 한다.
      const tilt = 0.061
      const lowTop = 0.13 + FLAG_POLE_H * 0.55
      const high = new THREE.Mesh(highGeo, poleMat)
      high.rotation.z = tilt
      const hl = FLAG_POLE_H * 0.48
      high.position.set(-Math.sin(tilt) * (hl / 2), lowTop + Math.cos(tilt) * (hl / 2), 0)
      g.add(high)

      const topY = lowTop + Math.cos(tilt) * hl
      const topX = -Math.sin(tilt) * hl
      const cap = new THREE.Mesh(capGeo, poleMat)
      cap.position.set(topX, topY, 0)
      g.add(cap)

      const flag = new THREE.Mesh(flagGeo, flagMat)
      flag.position.set(topX, topY - 0.02, 0)
      g.add(flag)

      group.add(g)
    }
  }
  return group
}

/**
 * 삼각 깃발 지오메트리. 폴은 원점의 세로 모서리(길이 {@link FLAG_H})이고 정점이 +Z로
 * {@link FLAG_L}만큼 뻗는다. u를 3등분하고 각 마디를 x로 살짝 밀어 저폴리 펄럭임을 만든다.
 */
function flagPanelGeometry(THREE: ThreeAPI): THREE_NS.BufferGeometry {
  const SEG = 3
  const pos: number[] = []
  const uv: number[] = []
  const idx: number[] = []
  /** 마디별 옆방향 변위(m) — 결정론 상수. 천의 접힘 한 번을 흉내 낸다. */
  const sway = [0, 0.016, -0.012, 0.022]
  for (let i = 0; i <= SEG; i++) {
    const u = i / SEG
    const z = u * FLAG_L
    // 삼각형: 폴 쪽 높이 FLAG_H → 정점에서 0으로 수렴.
    const half = (FLAG_H / 2) * (1 - u)
    const x = sway[i]
    pos.push(x, -half, z, x, half, z)
    uv.push(u, 0, u, 1)
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2
    idx.push(a, a + 2, a + 3, a, a + 3, a + 1)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}
