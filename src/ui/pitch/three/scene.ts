// src/ui/pitch/three/scene.ts
// 3D 매치 뷰의 "무대" — 잔디 피치 · 골대 · 스타디움 관중석 · 관중 인스턴싱 · 야간 조명.
//
// 설계 원칙(Phase 4E Global Constraints):
//  - three는 **인자 주입**한다(`buildScene(THREE, ...)`). 이 모듈은 three를 정적 import하지
//    않으므로 엔트리 번들에 three가 섞이지 않는다(코드 스플릿 보장). 타입만 `import type`.
//  - Math.random / Date 금지. 관중 색·높이·위상까지 인덱스 시드 해시(textures.hash01).
//  - 실시간 그림자맵 금지(castShadow=false). 선수 발밑은 makeContactShadow의 페이크 그림자.
//  - 외부 에셋 0 — 모든 텍스처는 textures.ts의 canvas 절차 생성물. canvas 미지원 환경에서는
//    null이 오므로 단색 머티리얼로 폴백한다(node/jsdom 테스트에서 크래시 금지).
//
// 렌더러는 호출부(Task 5) 소유다. 권장 설정: outputColorSpace=SRGBColorSpace,
// toneMapping=ACESFilmicToneMapping, toneMappingExposure≈1.05, antialias=true.
import type * as THREE_NS from 'three'
import { PITCH_W, PITCH_H } from './types'
import {
  GOAL_W,
  GOAL_H,
  POST_R,
  hash01,
  makeAdBoardCanvas,
  makeConcreteCanvas,
  makeNetCanvas,
  makePitchCanvas,
  makeShadowCanvas,
} from './textures'

/** 주입되는 three 네임스페이스 전체. */
export type ThreeAPI = typeof THREE_NS

export interface BuildSceneOptions {
  /** 홈 팀 컬러(관중 색 변주에 사용). 기본 대한민국 레드. */
  homeColor?: number
  /** 어웨이 팀 컬러. */
  awayColor?: number
  /** 관중 목표 인원(실제 인스턴스 수는 좌석 격자에 맞춰 근사). 기본 4000. */
  crowdCount?: number
  /** 피치 텍스처 해상도(px/m). 기본 20 → 2100×1360. 저사양은 12 권장. */
  pxPerMeter?: number
  /** renderer.capabilities.getMaxAnisotropy() 값. 기본 16. */
  maxAnisotropy?: number
}

export interface SceneBundle {
  scene: THREE_NS.Scene
  /** 기본 방송 카메라(Task 4가 위치·타깃을 제어). */
  camera: THREE_NS.PerspectiveCamera
  /** 잔디 + 라인 + 골대 + 광고보드. */
  pitchGroup: THREE_NS.Group
  /** 관중석 슬래브 + 관중 + 조명탑. */
  stadiumGroup: THREE_NS.Group
  /** 피치 평면(레이캐스트·머티리얼 튜닝용). */
  pitchMesh: THREE_NS.Mesh
  /** 관중 InstancedMesh(캔버스 없는 환경에서도 생성됨). */
  crowd: THREE_NS.InstancedMesh | null
  /** 실제 생성된 관중 인스턴스 수. */
  crowdCount: number
  /**
   * 관중 애니메이션. 매 프레임 호출.
   * @param t 경과 시간(초, three Clock)
   * @param intensity 0=평상시 미세 흔들림, 1=골 세리머니 점프(파도타기)
   */
  crowdWave(t: number, intensity: number): void
  dispose(): void
}

// ── 스타디움 레이아웃(m) ────────────────────────────────────────
/** 터치라인 밖 러너프(잔디) 폭. */
const APRON = 7
/** 관중석 경사각(rad, ≈29°). */
const RAKE = 0.5
/** 관중석 수평 깊이. */
const STAND_DEPTH = 26
/** 관중석 첫 열 높이. */
const STAND_H0 = 2.4
/** 관중 열(깊이 방향) 수. */
const STAND_ROWS = 12
/** 롱사이드 관중석 안쪽 경계(z). */
const SIDE_INNER = PITCH_H / 2 + APRON
/** 골 뒤 관중석 안쪽 경계(x). */
const END_INNER = PITCH_W / 2 + APRON
/**
 * 롱사이드 관중석 길이(x 방향). 네 면이 코너에서 서로 파고들도록 넉넉히 잡아
 * 볼(bowl) 코너의 빈 쐐기(V자 노치)를 메운다.
 */
const SIDE_LEN = 2 * (END_INNER + STAND_DEPTH * 0.75)
/** 골 뒤 관중석 길이(z 방향). */
const END_LEN = 2 * (SIDE_INNER + STAND_DEPTH * 0.75)

interface StandSide {
  /** rotY 각(rad) — 로컬 +Z가 향하는 월드 방향. */
  yaw: number
  /** cos(yaw)·sin(yaw) 정확값(부동소수 오차 없는 축 정렬). */
  c: number
  s: number
  /** 골 뒤(엔드) 스탠드 여부 — 롱사이드와 지오메트리를 나눠 공유한다. */
  isEnd: boolean
  /** 로컬 z 기준 관중석 안쪽 경계. */
  inner: number
  /** 로컬 x 방향 길이. */
  length: number
  /** 관중 색 편향. */
  bias: 'home' | 'away' | 'mix'
  /** 페리미터 광고보드 거리(로컬 z). */
  boardDist: number
}

/** 4면 관중석. 홈은 +X로 공격하므로 -X 골 뒤가 홈 서포터석. */
const SIDES: readonly StandSide[] = [
  { yaw: 0, c: 1, s: 0, isEnd: false, inner: SIDE_INNER, length: SIDE_LEN, bias: 'mix', boardDist: PITCH_H / 2 + 3 },
  { yaw: Math.PI, c: -1, s: 0, isEnd: false, inner: SIDE_INNER, length: SIDE_LEN, bias: 'mix', boardDist: PITCH_H / 2 + 3 },
  { yaw: Math.PI / 2, c: 0, s: 1, isEnd: true, inner: END_INNER, length: END_LEN, bias: 'away', boardDist: PITCH_W / 2 + 4 },
  { yaw: -Math.PI / 2, c: 0, s: -1, isEnd: true, inner: END_INNER, length: END_LEN, bias: 'home', boardDist: PITCH_W / 2 + 4 },
]

/** 관중 중립 색(코트·피부·빈 좌석) — 팀 컬러와 섞여 자연스러운 노이즈를 만든다. */
const NEUTRALS = [0xd8dde6, 0x39404d, 0xb9a48c, 0x6a7280, 0x272c35]

/** 로컬(x,z) → 월드(x,z). rotY(yaw): x' = x·c + z·s, z' = -x·s + z·c. */
function rotY(x: number, z: number, c: number, s: number): { x: number; z: number } {
  return { x: x * c + z * s, z: -x * s + z * c }
}

/** canvas → CanvasTexture(없으면 null). sRGB·anisotropy·repeat 설정 포함. */
function toTexture(
  THREE: ThreeAPI,
  canvas: HTMLCanvasElement | null,
  opts: { srgb?: boolean; aniso?: number; repeat?: [number, number] } = {},
): THREE_NS.CanvasTexture | null {
  if (!canvas) return null
  const tex = new THREE.CanvasTexture(canvas)
  if (opts.srgb !== false && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = Math.max(1, opts.aniso ?? 16)
  if (opts.repeat) {
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(opts.repeat[0], opts.repeat[1])
  }
  tex.needsUpdate = true
  return tex
}

/**
 * 선수 발밑 페이크 컨택트 섀도우(반투명 검정 원). 실시간 그림자맵 대체.
 * XZ 평면에 눕혀진 상태로 반환되므로 호출부는 position만 옮기면 된다(y≈0.02 권장).
 * 호출마다 독립 geometry/material/texture를 만드므로 소유자가 dispose한다.
 * @param radius 반지름(m) @param opacity 최대 불투명도
 */
export function makeContactShadow(THREE: ThreeAPI, radius = 0.62, opacity = 0.62): THREE_NS.Mesh {
  const geo = new THREE.CircleGeometry(radius, 20)
  geo.rotateX(-Math.PI / 2)
  const tex = toTexture(THREE, makeShadowCanvas(64), { srgb: false, aniso: 4 })
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    ...(tex ? { map: tex } : {}),
    transparent: true,
    opacity: tex ? opacity : opacity * 0.6,
    depthWrite: false,
    toneMapped: false,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = 0.02
  mesh.renderOrder = 2
  return mesh
}

/**
 * 경기장 씬 전체를 조립한다. 렌더러·컨트롤은 호출부 소유.
 * @param THREE 주입된 three 네임스페이스
 * @param opts  팀 컬러·관중 수·텍스처 해상도
 */
export function buildScene(THREE: ThreeAPI, opts: BuildSceneOptions = {}): SceneBundle {
  const homeColor = opts.homeColor ?? 0xd7263d
  const awayColor = opts.awayColor ?? 0x2453b8
  const aniso = opts.maxAnisotropy ?? 16
  const targetCrowd = Math.max(0, Math.round(opts.crowdCount ?? 4000))

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x080e18)
  // 원경 관중석만 살짝 잠기는 약한 포그(피치는 영향 없음).
  scene.fog = new THREE.Fog(0x070c16, 150, 470)

  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 900)
  camera.position.set(0, 28, 78)
  camera.lookAt(0, 0, 0)

  const pitchGroup = new THREE.Group()
  pitchGroup.name = 'pitch'
  const stadiumGroup = new THREE.Group()
  stadiumGroup.name = 'stadium'
  scene.add(pitchGroup, stadiumGroup)

  // ── 바닥(틈새로 하늘이 보이지 않게) ──────────────────────────
  const baseGeo = new THREE.PlaneGeometry(520, 520)
  baseGeo.rotateX(-Math.PI / 2)
  const baseMesh = new THREE.Mesh(baseGeo, new THREE.MeshBasicMaterial({ color: 0x05070c }))
  baseMesh.position.y = -1.2
  stadiumGroup.add(baseMesh)

  // ── 러너프(피치 밖 잔디) ────────────────────────────────────
  const apronGeo = new THREE.PlaneGeometry(PITCH_W + APRON * 2 + 10, PITCH_H + APRON * 2 + 6)
  apronGeo.rotateX(-Math.PI / 2)
  const apronMesh = new THREE.Mesh(apronGeo, new THREE.MeshLambertMaterial({ color: 0x14421f }))
  apronMesh.position.y = -0.03
  pitchGroup.add(apronMesh)

  // ── 잔디 피치(절차 텍스처: mowing 줄무늬 + 전체 라인 마킹) ──
  const pitchTex = toTexture(THREE, makePitchCanvas(opts.pxPerMeter ?? 20), { aniso })
  const pitchGeo = new THREE.PlaneGeometry(PITCH_W, PITCH_H)
  pitchGeo.rotateX(-Math.PI / 2)
  const pitchMat = new THREE.MeshLambertMaterial({
    color: pitchTex ? 0xffffff : 0x2b8c40,
    ...(pitchTex ? { map: pitchTex } : {}),
  })
  const pitchMesh = new THREE.Mesh(pitchGeo, pitchMat)
  pitchMesh.name = 'pitch-plane'
  pitchGroup.add(pitchMesh)

  // ── 골대 2개(포스트·크로스바 원통 + 네트) ────────────────────
  const netTex = toTexture(THREE, makeNetCanvas(128, 10), { srgb: false, aniso, repeat: [1, 1] })
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xf5f8ff,
    roughness: 0.35,
    metalness: 0.05,
    emissive: new THREE.Color(0x1b2430),
  })
  const netMat = new THREE.MeshBasicMaterial({
    color: netTex ? 0xdfe6f0 : 0xaab4c2,
    ...(netTex ? { map: netTex } : {}),
    transparent: true,
    opacity: netTex ? 0.9 : 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  })
  const postGeo = new THREE.CylinderGeometry(POST_R, POST_R, GOAL_H, 12)
  const barGeo = new THREE.CylinderGeometry(POST_R, POST_R, GOAL_W + POST_R * 2, 12)
  const netDepth = 2.0
  const netBackGeo = new THREE.PlaneGeometry(GOAL_W, GOAL_H)
  const netSideGeo = new THREE.PlaneGeometry(netDepth, GOAL_H)
  const netTopGeo = new THREE.PlaneGeometry(netDepth, GOAL_W)
  netTopGeo.rotateX(-Math.PI / 2)
  if (netTex) {
    // 네트 격자 밀도를 실제 크기(≈0.6m 타일)에 맞춘다.
    netTex.repeat.set(GOAL_W / 0.6, GOAL_H / 0.6)
  }

  for (const sign of [-1, 1] as const) {
    const goal = new THREE.Group()
    goal.name = sign < 0 ? 'goal-west' : 'goal-east'
    const gx = (sign * PITCH_W) / 2
    for (const zs of [-1, 1] as const) {
      const post = new THREE.Mesh(postGeo, frameMat)
      post.position.set(gx, GOAL_H / 2, (zs * GOAL_W) / 2)
      goal.add(post)
    }
    const bar = new THREE.Mesh(barGeo, frameMat)
    bar.rotation.x = Math.PI / 2
    bar.position.set(gx, GOAL_H, 0)
    goal.add(bar)

    // 네트: 뒷면 + 좌우 + 천장(골 바깥쪽으로 netDepth 만큼).
    const back = new THREE.Mesh(netBackGeo, netMat)
    back.position.set(gx + sign * netDepth, GOAL_H / 2, 0)
    back.rotation.y = Math.PI / 2
    goal.add(back)
    for (const zs of [-1, 1] as const) {
      const side = new THREE.Mesh(netSideGeo, netMat)
      side.position.set(gx + (sign * netDepth) / 2, GOAL_H / 2, (zs * GOAL_W) / 2)
      goal.add(side)
    }
    const top = new THREE.Mesh(netTopGeo, netMat)
    top.position.set(gx + (sign * netDepth) / 2, GOAL_H, 0)
    goal.add(top)
    pitchGroup.add(goal)
  }

  // ── 관중석 슬래브 + 광고보드(면별 그룹) ─────────────────────
  const concreteTex = toTexture(THREE, makeConcreteCanvas(256), { aniso, repeat: [24, 4] })
  const standMat = new THREE.MeshLambertMaterial({
    color: concreteTex ? 0xbcc4d2 : 0x2b3140,
    ...(concreteTex ? { map: concreteTex } : {}),
  })
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x161b24 })
  const adTexSide = toTexture(THREE, makeAdBoardCanvas(), { aniso, repeat: [4, 1] })
  const adTexEnd = adTexSide ? adTexSide.clone() : null
  if (adTexEnd) {
    adTexEnd.repeat.set(2.5, 1)
    adTexEnd.needsUpdate = true
  }

  const rise = STAND_DEPTH * Math.tan(RAKE)
  const slope = STAND_DEPTH / Math.cos(RAKE)
  const sideRakeGeo = new THREE.BoxGeometry(SIDE_LEN, 1.6, slope)
  const endRakeGeo = new THREE.BoxGeometry(END_LEN, 1.6, slope)
  const sideWallGeo = new THREE.BoxGeometry(SIDE_LEN, 7, 1.6)
  const endWallGeo = new THREE.BoxGeometry(END_LEN, 7, 1.6)
  const sideFenceGeo = new THREE.BoxGeometry(SIDE_LEN, STAND_H0, 1.2)
  const endFenceGeo = new THREE.BoxGeometry(END_LEN, STAND_H0, 1.2)
  const sideBoardGeo = new THREE.BoxGeometry(100, 1.05, 0.3)
  const endBoardGeo = new THREE.BoxGeometry(62, 1.05, 0.3)
  const sideAdMat = new THREE.MeshBasicMaterial({
    color: adTexSide ? 0xffffff : 0x101828,
    ...(adTexSide ? { map: adTexSide } : {}),
    toneMapped: false,
  })
  const endAdMat = new THREE.MeshBasicMaterial({
    color: adTexEnd ? 0xffffff : 0x101828,
    ...(adTexEnd ? { map: adTexEnd } : {}),
    toneMapped: false,
  })

  for (const side of SIDES) {
    const isEnd = side.isEnd
    const g = new THREE.Group()
    g.rotation.y = side.yaw
    // 경사 슬래브: 로컬 -z 끝이 (inner, H0), +z 끝이 (inner+DEPTH, H0+rise).
    const rake = new THREE.Mesh(isEnd ? endRakeGeo : sideRakeGeo, standMat)
    rake.rotation.x = -RAKE
    rake.position.set(0, STAND_H0 + rise / 2, side.inner + STAND_DEPTH / 2)
    g.add(rake)
    // 뒷벽
    const wall = new THREE.Mesh(isEnd ? endWallGeo : sideWallGeo, wallMat)
    wall.position.set(0, STAND_H0 + rise + 2.4, side.inner + STAND_DEPTH + 0.8)
    g.add(wall)
    // 피치와 관중석 사이 낮은 펜스
    const fence = new THREE.Mesh(isEnd ? endFenceGeo : sideFenceGeo, wallMat)
    fence.position.set(0, STAND_H0 / 2, side.inner - 0.6)
    g.add(fence)
    // 페리미터 LED 광고보드(살짝 뒤로 기울임)
    const board = new THREE.Mesh(isEnd ? endBoardGeo : sideBoardGeo, isEnd ? endAdMat : sideAdMat)
    board.position.set(0, 0.55, side.boardDist)
    board.rotation.x = 0.13
    g.add(board)
    stadiumGroup.add(g)
  }

  // ── 관중 InstancedMesh ───────────────────────────────────────
  // 목표 인원에서 좌석 간격을 역산 → 4면 열·행 격자에 배치(결정론).
  const totalLen = SIDES.reduce((a, s) => a + s.length, 0)
  const perRow = Math.max(1, targetCrowd / STAND_ROWS)
  const seatGap = Math.max(0.9, totalLen / perRow)
  const colsOf = (len: number) => Math.max(1, Math.round(len / seatGap))
  const crowdCount = targetCrowd > 0 ? SIDES.reduce((a, s) => a + colsOf(s.length) * STAND_ROWS, 0) : 0

  let crowd: THREE_NS.InstancedMesh | null = null
  let baseY: Float32Array = new Float32Array(0)
  let phase: Float32Array = new Float32Array(0)
  let wavePos: Float32Array = new Float32Array(0)

  if (crowdCount > 0) {
    // 단위 박스를 인스턴스마다 좌석 간격에 맞춰 스케일 → 관중 수와 무관하게 "빽빽한 무리".
    const seatGeo = new THREE.BoxGeometry(1, 1, 1)
    // 관중은 unlit(MeshBasic): 피치 쪽을 향한 면이 조명 사각지대라 램버트로는 새까맣게 죽는다.
    // 색 지터(0.58~1.0)가 이미 명암 변주를 만들므로 unlit이 더 밝고 싸다.
    const seatMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    crowd = new THREE.InstancedMesh(seatGeo, seatMat, crowdCount)
    crowd.name = 'crowd'
    crowd.frustumCulled = false
    const m = crowd.instanceMatrix.array as Float32Array
    baseY = new Float32Array(crowdCount)
    phase = new Float32Array(crowdCount)
    wavePos = new Float32Array(crowdCount)
    const col = new THREE.Color()
    const rowStep = STAND_DEPTH / STAND_ROWS

    let i = 0
    for (const side of SIDES) {
      const cols = colsOf(side.length)
      const colStep = side.length / cols
      // 스탠드 길이 방향 폭 / 깊이 방향 두께. yaw가 ±90°인 엔드 스탠드는 월드 축이 뒤바뀐다.
      const widthScale = colStep * 0.66
      const depthScale = rowStep * 0.52
      const sx = side.isEnd ? depthScale : widthScale
      const sz = side.isEnd ? widthScale : depthScale
      for (let r = 0; r < STAND_ROWS; r++) {
        const lz = side.inner + (r + 0.5) * rowStep
        // 슬래브 윗면(두께 절반 보정 포함) 높이.
        const surfaceY = STAND_H0 + (lz - side.inner) * Math.tan(RAKE) + 0.9
        // 홀수 열은 반 칸 어긋나게(엇갈린 좌석 배치).
        const stagger = r % 2 === 0 ? 0 : colStep / 2
        for (let cIdx = 0; cIdx < cols; cIdx++) {
          const lx = -side.length / 2 + (cIdx + 0.5) * colStep + stagger
          const w = rotY(lx, lz, side.c, side.s)
          const h1 = hash01(i * 3 + 11)
          const h2 = hash01(i * 3 + 20011)
          const sy = 0.82 + h1 * 0.46
          const jx = (h2 - 0.5) * colStep * 0.3
          const o = i * 16
          m[o] = sx
          m[o + 5] = sy
          m[o + 10] = sz
          m[o + 12] = w.x + jx * side.c
          m[o + 13] = surfaceY + sy / 2 - 0.25
          m[o + 14] = w.z - jx * side.s
          m[o + 15] = 1
          baseY[i] = m[o + 13]
          phase[i] = hash01(i * 7 + 3301) * Math.PI * 2
          // 경기장 중심 기준 방위각 → 파도타기 진행 위상.
          wavePos[i] = Math.atan2(w.z, w.x) + Math.PI
          crowd.setColorAt(i, seatColor(col, side.bias, homeColor, awayColor, i))
          i++
        }
      }
    }
    crowd.instanceMatrix.needsUpdate = true
    if (crowd.instanceColor) crowd.instanceColor.needsUpdate = true
    stadiumGroup.add(crowd)
  }

  // ── 조명탑 4기(야간 경기 실루엣) ─────────────────────────────
  const mastGeo = new THREE.CylinderGeometry(0.5, 0.9, 44, 8)
  const mastMat = new THREE.MeshLambertMaterial({ color: 0x232830 })
  const rigGeo = new THREE.BoxGeometry(10, 5.2, 1.1)
  const rigMat = new THREE.MeshBasicMaterial({ color: 0xfff4d6, toneMapped: false })
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const px = sx * (END_INNER + STAND_DEPTH * 0.85)
      const pz = sz * (SIDE_INNER + STAND_DEPTH * 0.85)
      const mast = new THREE.Mesh(mastGeo, mastMat)
      mast.position.set(px, 22, pz)
      stadiumGroup.add(mast)
      const rig = new THREE.Mesh(rigGeo, rigMat)
      rig.position.set(px, 43, pz)
      rig.lookAt(0, 0, 0)
      stadiumGroup.add(rig)
    }
  }

  // ── 조명(야간 톤, 실시간 그림자 없음) ────────────────────────
  const hemi = new THREE.HemisphereLight(0xa8c8ff, 0x1d4a24, 1.05)
  hemi.position.set(0, 60, 0)
  const key = new THREE.DirectionalLight(0xfff6e8, 1.5)
  key.position.set(58, 82, 42)
  key.castShadow = false
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.7)
  fill.position.set(-62, 58, -48)
  fill.castShadow = false
  const amb = new THREE.AmbientLight(0x6a7c98, 0.6)
  scene.add(hemi, key, fill, amb)

  // ── 관중 웨이브 ──────────────────────────────────────────────
  const crowdMatrix = crowd ? (crowd.instanceMatrix.array as Float32Array) : null
  function crowdWave(t: number, intensity: number): void {
    if (!crowd || !crowdMatrix) return
    const k = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity
    const jumpAmp = 0.85 * k
    for (let i = 0; i < crowdCount; i++) {
      const idle = 0.035 * Math.sin(t * 1.9 + phase[i])
      const jump = jumpAmp > 0 ? jumpAmp * Math.max(0, Math.sin(t * 4.6 - wavePos[i] * 1.15 + phase[i] * 0.12)) : 0
      crowdMatrix[i * 16 + 13] = baseY[i] + idle + jump
    }
    crowd.instanceMatrix.needsUpdate = true
  }

  function dispose(): void {
    disposeTree(scene)
    scene.clear()
    pitchGroup.clear()
    stadiumGroup.clear()
    crowd = null
  }

  return {
    scene,
    camera,
    pitchGroup,
    stadiumGroup,
    pitchMesh,
    crowd,
    crowdCount,
    crowdWave,
    dispose,
  }
}

/**
 * 관중 1명의 좌석 색(결정론). 면 편향에 따라 홈/어웨이 컬러와 중립색을 섞고
 * 인덱스 해시로 명도를 흔들어 "사람 무리" 노이즈를 만든다.
 */
function seatColor(
  col: THREE_NS.Color,
  bias: StandSide['bias'],
  homeColor: number,
  awayColor: number,
  i: number,
): THREE_NS.Color {
  const pick = hash01(i * 5 + 917)
  const homeShare = bias === 'home' ? 0.46 : bias === 'away' ? 0.12 : 0.28
  const awayShare = bias === 'away' ? 0.46 : bias === 'home' ? 0.12 : 0.28
  let hex: number
  if (pick < homeShare) hex = homeColor
  else if (pick < homeShare + awayShare) hex = awayColor
  else hex = NEUTRALS[Math.floor(hash01(i * 11 + 4441) * NEUTRALS.length) % NEUTRALS.length]
  col.setHex(hex)
  // 명도 지터(0.58~1.0) — 야간 조명 아래 얼룩덜룩한 관중석. 1을 넘기지 않아
  // instanceColor가 항상 [0,1]에 머문다(과노출 방지).
  col.multiplyScalar(0.58 + hash01(i * 13 + 6607) * 0.42)
  return col
}

/** three 객체 트리의 geometry/material/texture/light를 전부 해제한다. */
function disposeTree(root: THREE_NS.Object3D): void {
  const geos = new Set<THREE_NS.BufferGeometry>()
  const mats = new Set<THREE_NS.Material>()
  root.traverse((obj) => {
    const anyObj = obj as unknown as {
      geometry?: THREE_NS.BufferGeometry
      material?: THREE_NS.Material | THREE_NS.Material[]
      isLight?: boolean
      dispose?: () => void
    }
    if (anyObj.geometry) geos.add(anyObj.geometry)
    if (anyObj.material) {
      if (Array.isArray(anyObj.material)) for (const m of anyObj.material) mats.add(m)
      else mats.add(anyObj.material)
    }
    if (anyObj.isLight && typeof anyObj.dispose === 'function') anyObj.dispose()
  })
  for (const g of geos) g.dispose()
  for (const m of mats) {
    // 머티리얼이 참조하는 모든 텍스처(map/alphaMap/emissiveMap…) 해제.
    const rec = m as unknown as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      const v = rec[key] as { isTexture?: boolean; dispose?: () => void } | null
      if (v && typeof v === 'object' && v.isTexture && typeof v.dispose === 'function') v.dispose()
    }
    m.dispose()
  }
}
