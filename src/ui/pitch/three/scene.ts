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
// 렌더러는 호출부 소유다. 권장 설정: outputColorSpace=SRGBColorSpace, antialias=true,
// toneMapping=NeutralToneMapping, toneMappingExposure≈1.05.
//   ACESFilmic에서 Neutral로 바꾼 근거(tools/tone-stats/sweep.mjs 실측, 랜딩 장면):
//   ACES는 토우가 깊어 야간 씬의 25%가 순검정으로 뭉개지고(흑클립 24.65%) 관중석 채도가
//   0.76→0.38로 무너졌다. Neutral(Khronos PBR Neutral)은 하이라이트만 롤오프하고 암부는
//   거의 항등이라 흑클립 9.81%, 채도 0.62를 지킨다. 관중 색이 이 씬의 정보량 대부분이다.
import type * as THREE_NS from 'three'
import { PITCH_W, PITCH_H } from './types'
import { shadowDiscGeometry } from './player3d'
import {
  GOAL_W,
  GOAL_H,
  POST_R,
  hash01,
  makeAdBoardCanvas,
  makeConcreteCanvas,
  makeNetCanvas,
  makePitchCanvas,
} from './textures'

/** 주입되는 three 네임스페이스 전체. */
export type ThreeAPI = typeof THREE_NS

export interface BuildSceneOptions {
  /** 홈 팀 컬러(관중 색 변주에 사용). 기본 대한민국 레드. */
  homeColor?: number
  /** 어웨이 팀 컬러. */
  awayColor?: number
  /**
   * 관중 목표 인원(실제 인스턴스 수는 좌석 격자에 맞춰 근사). 기본 4000.
   *
   * **상한 포화**: 좌석 간격 하한 {@link MIN_SEAT_GAP}(0.9m)과 열 수 {@link STAND_ROWS}(12)가
   * 격자 용량을 고정하므로 실제 인스턴스 수는 {@link MAX_CROWD_INSTANCES}(현 스탠드 규격에서
   * 7440)를 넘지 않는다. 즉 12000을 요청해도 7440만 생성된다(0 이하는 관중 없음).
   */
  crowdCount?: number
  /** 피치 텍스처 해상도(px/m). 기본 20 → 2100×1360. 저사양은 12 권장. */
  pxPerMeter?: number
  /** renderer.capabilities.getMaxAnisotropy() 값. 기본 16. */
  maxAnisotropy?: number
  /**
   * 발광체(조명탑 리그·LED 광고보드)의 색을 1.0 위로 밀어 올리는 배율. 기본 1(=끄기).
   *
   * **포스트 프로세싱(블룸)이 붙을 때만 1보다 크게 준다.** 블룸은 임계값을 넘는 픽셀만
   * 번지게 하는데, 모든 것이 [0,1]에 눌려 있으면 흰 잔디 라인과 조명탑이 같은 밝기라
   * "번져야 할 것"을 구분할 수 없다. HalfFloat 렌더 타깃에서는 1.0 초과가 살아남으므로
   * 발광체만 HDR로 올려 블룸이 그것만 집어내게 한다.
   * 컴포저가 없을 때(폴백) 이 값을 주면 캔버스 출력에서 그냥 흰색으로 클리핑되므로
   * 호출부는 포스트FX 활성 여부를 확인하고 넘겨야 한다. 기본값이 1인 이유다.
   */
  emissiveBoost?: number
  /**
   * 밤하늘(배경·포그) 색 배율. 기본 1.
   *
   * **왜 따로 필요한가:** 컴포저 없이 캔버스에 바로 그릴 때 배경 클리어 색은 셰이더를
   * 거치지 않으므로 **톤매핑을 피해 간다**. 컴포저를 붙이면 배경도 렌더 타깃에 들어가
   * OutputPass에서 함께 톤매핑되는데, ACES 계열은 토우가 깊어 0.0034(=#080e18) 같은
   * 값을 사실상 0으로 눌러 버린다 → 남색 밤하늘이 순검정이 되고 스타디움이 허공에 뜬다.
   * 톤매핑 뒤에도 원래 밤하늘이 남도록 선형 공간에서 미리 밀어 올린다.
   */
  skyBoost?: number
}

/**
 * 권장 발광 배율. 조명탑은 블룸 임계(0.85)를 확실히 넘겨야 halo가 생긴다.
 * 스윕 실측: 2.4배는 랜딩 카메라가 조명탑 옆을 지날 때 화면의 1/6이 흰 덩어리가 됐다.
 * 1.7배가 halo는 남기고 코어 면적은 원래 패널 크기에 머무는 지점이었다.
 */
export const EMISSIVE_BOOST = 1.7
/** LED 광고보드 배율 — 조명탑만큼 세면 피치 주변에 띠 모양 발광이 생겨 촌스럽다. */
export const AD_BOARD_BOOST = 1.15

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
  /**
   * 관중 InstancedMesh(캔버스 없는 환경에서도 생성됨).
   * `dispose()` 이후에는 **null이 된다**(getter로 노출 — 해제된 메시를 붙들지 않는다).
   */
  readonly crowd: THREE_NS.InstancedMesh | null
  /** 실제 생성된 관중 인스턴스 수. 항상 `≤ MAX_CROWD_INSTANCES`. */
  crowdCount: number
  /**
   * 관중 애니메이션. 매 프레임 호출.
   * @param t 경과 시간(초, three Clock)
   * @param intensity 0=평상시 미세 흔들림, 1=골 세리머니 점프(파도타기)
   */
  crowdWave(t: number, intensity: number): void
  /**
   * 발광체(조명탑·LED 보드) HDR 배율을 런타임에 교체한다. {@link BuildSceneOptions.emissiveBoost}와
   * 같은 의미이며, 포스트FX가 **비동기로** 붙는 호출부가 사후에 켤 수 있게 열어 둔다.
   */
  setEmissiveBoost(boost: number): void
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

/**
 * 좌석 격자 최소 간격(m). 사람 어깨너비 하한 — 이보다 촘촘히 붙이면 박스가 서로 겹친다.
 * 이 하한이 곧 관중 수 상한을 만든다({@link MAX_CROWD_INSTANCES}).
 */
const MIN_SEAT_GAP = 0.9

/**
 * 좌석 격자가 수용 가능한 최대 관중 인스턴스 수 = 4면 × (길이/0.9m 열) × 12행.
 * 현 스탠드 규격(SIDE_LEN 158m · END_LEN 121m)에서 **7440**.
 * `buildScene({ crowdCount })`이 이 값에서 포화하므로 호출부는 초과 요청을 기대하면 안 된다.
 */
export const MAX_CROWD_INSTANCES: number = SIDES.reduce(
  (a, s) => a + Math.max(1, Math.round(s.length / MIN_SEAT_GAP)) * STAND_ROWS,
  0,
)

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
  // 감쇠는 **정점 알파**로 굽는다. 반투명 캔버스를 map으로 물린 예전 구현은 헤드리스 렌더
  // 실측에서 화면에 아무것도 남기지 않았다 — 그래서 그동안 공 그림자와 선수 발밑 그림자가
  // 둘 다 코드에는 있는데 화면에는 없었다. 근거는 player3d.shadowDiscGeometry 주석 참조.
  const geo = shadowDiscGeometry(THREE as unknown as typeof import('three'), 0.45, 3, 20)
  geo.scale(radius, 1, radius)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, // 정점 색(검정)과 곱해진다
    vertexColors: true,
    transparent: true,
    opacity,
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
  // 1 미만·NaN은 무시한다(발광체를 어둡게 만들 이유가 없다).
  const sane = (v: number | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 1 ? v : 1
  let boost = sane(opts.emissiveBoost)
  /** LED 보드 초과분 비율 — 기본 boost 1.7에서 1.15배가 되도록 잡은 값. */
  const AD_SHARE = (AD_BOARD_BOOST - 1) / (EMISSIVE_BOOST - 1)
  /**
   * 발광체 색을 선형 공간에서 HDR로 민다. boost가 1이면 정확히 기존 색 그대로다
   * (컴포저 없는 폴백 경로에서 흰색으로 클리핑되지 않게).
   * @param share 조명탑 대비 이 발광체의 초과분 비율(1=조명탑과 같은 세기)
   */
  const hdr = (hex: number, share: number): THREE_NS.Color =>
    new THREE.Color(hex).multiplyScalar(1 + (boost - 1) * share)

  const rawSky = opts.skyBoost
  const skyBoost = typeof rawSky === 'number' && Number.isFinite(rawSky) && rawSky > 0 ? rawSky : 1
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x080e18).multiplyScalar(skyBoost)
  // 원경 관중석만 살짝 잠기는 약한 포그(피치는 영향 없음). 포그도 배경과 같은 배율로
  // 밀어야 지평선에서 색이 갈라지지 않는다.
  // (getHex()로 넘기면 1.0 초과가 잘려 배율이 무의미해진다 — Color 인스턴스를 그대로 준다.)
  scene.fog = new THREE.Fog(new THREE.Color(0x070c16).multiplyScalar(skyBoost), 150, 470)

  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 900)
  camera.position.set(0, 28, 78)
  camera.lookAt(0, 0, 0)
  // 카메라를 **씬에 편입**한다. WebGLRenderer.render()는 projectObject(scene, …)로 씬 서브트리만
  // 렌더 리스트에 담으므로, 카메라 자식으로 붙는 오브젝트(fx3d.flashQuad의 풀스크린 골 섬광)는
  // 카메라가 씬 밖에 떠 있으면 **영원히 그려지지 않는다**. 씬 루트는 항상 단위행렬이라
  // 카메라의 월드 변환은 그대로다(호출부가 position/quaternion을 직접 써도 동작 동일).
  scene.add(camera)

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
    color: hdr(adTexSide ? 0xffffff : 0x101828, AD_SHARE),
    ...(adTexSide ? { map: adTexSide } : {}),
    toneMapped: false,
  })
  const endAdMat = new THREE.MeshBasicMaterial({
    color: hdr(adTexEnd ? 0xffffff : 0x101828, AD_SHARE),
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
  // 간격 하한 때문에 targetCrowd가 커져도 격자가 더 촘촘해지지 않는다 → MAX_CROWD_INSTANCES 포화.
  const seatGap = Math.max(MIN_SEAT_GAP, totalLen / perRow)
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
  // 조명탑 리그가 블룸의 주 광원이다 — 여기만 확실히 임계 위로 올린다.
  const rigMat = new THREE.MeshBasicMaterial({ color: hdr(0xfff4d6, 1), toneMapped: false })
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

  /**
   * 발광체 HDR 배율을 런타임에 바꾼다. 포스트FX는 비동기로 붙기 때문에(애드온 청크 로드)
   * buildScene 시점에는 컴포저가 붙을지 알 수 없다 — 붙은 뒤에 이걸 호출한다.
   * 성능 가드가 블룸을 끌 때도 1로 되돌려야 발광체가 흰색으로 타지 않는다.
   */
  function setEmissiveBoost(next: number): void {
    boost = sane(next)
    rigMat.color.copy(hdr(0xfff4d6, 1))
    sideAdMat.color.copy(hdr(adTexSide ? 0xffffff : 0x101828, AD_SHARE))
    endAdMat.color.copy(hdr(adTexEnd ? 0xffffff : 0x101828, AD_SHARE))
  }

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
    // 값 복사로 노출하면 dispose 후에도 해제된 메시를 붙들게 된다(dangling). getter로 클로저를 본다.
    get crowd() {
      return crowd
    },
    crowdCount,
    crowdWave,
    setEmissiveBoost,
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

/** three 객체 트리의 geometry/material/texture/light/인스턴스 버퍼를 전부 해제한다. */
function disposeTree(root: THREE_NS.Object3D): void {
  const geos = new Set<THREE_NS.BufferGeometry>()
  const mats = new Set<THREE_NS.Material>()
  root.traverse((obj) => {
    const anyObj = obj as unknown as {
      geometry?: THREE_NS.BufferGeometry
      material?: THREE_NS.Material | THREE_NS.Material[]
      isLight?: boolean
      isInstancedMesh?: boolean
      dispose?: () => void
    }
    if (anyObj.geometry) geos.add(anyObj.geometry)
    if (anyObj.material) {
      if (Array.isArray(anyObj.material)) for (const m of anyObj.material) mats.add(m)
      else mats.add(anyObj.material)
    }
    if (anyObj.isLight && typeof anyObj.dispose === 'function') anyObj.dispose()
    // InstancedMesh의 instanceMatrix/instanceColor는 WebGLObjects가 **'dispose' 이벤트로만**
    // gl.deleteBuffer + VAO release를 한다(attributes가 WeakMap이라 GC로는 회수되지 않는다).
    // geometry/material만 해제하면 빌드·해제 사이클마다 인스턴스 버퍼가 영구 누수된다.
    if (anyObj.isInstancedMesh && typeof anyObj.dispose === 'function') anyObj.dispose()
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
