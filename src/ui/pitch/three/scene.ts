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
import { ROW_STEP, SEAT_PITCH, buildCrowd, crowdCapacity, type CrowdBundle, type CrowdStand } from './crowd'
import { buildExterior, type ExteriorBundle } from './exterior'
import { buildCornerFlags, buildGoal } from './props'
import { kitInk } from './pose'
import { ENTRANCE_BANNER_AWAY, ENTRANCE_BANNER_HOME } from './entrance'
import { loadFlagImage } from '../../flags/flags'
import type { TeamId } from '../../../data/loader'
import {
  AD_PANEL_ASPECT,
  AD_TEXTS,
  makeAdBoardCanvas,
  makeBannerCanvas,
  makeConcreteCanvas,
  makeCrowdCanvas,
  makePitchCanvas,
  type CrowdBias,
} from './textures'

/** 주입되는 three 네임스페이스 전체. */
export type ThreeAPI = typeof THREE_NS

export interface BuildSceneOptions {
  /** 홈 팀 컬러(관중 색 변주에 사용). 기본 대한민국 레드. */
  homeColor?: number
  /** 어웨이 팀 컬러. */
  awayColor?: number
  /**
   * 관중 on/off. **0 이하면 관중 없음, 그 외 어떤 값이든 정원까지 채운다.**
   *
   * @deprecated 이름과 달리 더 이상 "인원 수"를 지시하지 않는다. 좌석 격자가 현실 피치
   * (좌석 0.62m · 열 0.9m)로 고정됐기 때문이다 — 사람 크기는 요청 인원에 따라 달라질 수
   * 없다. 예전 구현은 인원에서 좌석 간격을 역산해서 2000명을 요청하면 간격이 3.35m가 되고
   * 인스턴스가 한 변 2m짜리 색 큐브가 됐다(crowd.ts 헤더의 진단 참조). LOD가 필요하면
   * {@link crowdDetail}을 쓴다. 기존 호출부(Match3D의 4200 등)는 고치지 않아도
   * "관중 있음"으로 해석되므로 그대로 동작한다.
   */
  crowdCount?: number
  /**
   * 관중 LOD(0.35~1, 기본 1). 좌석 피치와 열 간격을 함께 1/detail배로 벌려 인스턴스 수를
   * 줄인다. 내리면 레퍼런스 밀도에서 멀어지므로 저사양 폴백에서만 쓴다.
   */
  crowdDetail?: number
  /**
   * 경기장 외부(밤하늘 돔·조명탑 halo·빛기둥·지붕·외벽·원경 도시)를 그릴지. 기본 true.
   * 끄면 예전처럼 볼(bowl)만 검은 배경 위에 남는다.
   */
  exterior?: boolean
  /**
   * 조명탑 빛기둥(가산합성 원뿔 4개)을 그릴지. 기본 true.
   * 외부 요소 중 유일하게 오버드로우 비용이 있는 항목이라 따로 열어 둔다.
   */
  lightShafts?: boolean
  /** 입장 배너 캡션에 새길 국가 이름(한국어). 없으면 배너를 만들지 않는다. */
  homeLabel?: string
  /** 어웨이 국가 이름(한국어). */
  awayLabel?: string
  /**
   * 입장 배너에 펼칠 국기의 팀 id. 주면 `public/flags/<iso>.svg`를 **비동기로** 받아
   * 배너 텍스처를 국기로 다시 그린다. 없으면 팀 색 폴백 도안으로 남는다.
   */
  homeTeamId?: TeamId
  /** 어웨이 국기의 팀 id. */
  awayTeamId?: TeamId
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
   * 입장 배너(피치에 펼치는 팀 색 천)를 켜고 끈다. 기본 꺼짐 — **입장 연출 중에만** 켠다.
   * 경기가 시작되면 배너는 걷힌다(실제 의식도 그렇다).
   * `homeLabel`/`awayLabel`을 주지 않았으면 조용한 no-op이다.
   */
  setEntranceBanners(visible: boolean): void
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
/**
 * 관중석 첫 열 높이(= 피치와 관중석 사이 펜스 높이).
 *
 * 2.4였다. 광고판 윗단이 1.08m이므로 그 위로 첫 좌석(2.4 + 슬래브 반두께 0.91 = 3.3m)
 * 까지 2.2m가 **완전한 검정 띠**로 남았고, 방송 카메라 클로즈업에서 프레임의 1/4을
 * 죽은 검정이 차지했다. 실제 경기장의 이 구간은 1.5~2m이고 대부분 광고·LED 리본으로
 * 덮여 있다 — 높이를 줄이고 아래 `ribbonMat`로 윗단을 덮는다.
 */
const STAND_H0 = 1.9
/** 경사 슬래브 두께. */
const SLAB_T = 1.6
/**
 * 슬래브 윗면(좌석면)이 STAND_H0보다 높은 양(m). 두께 절반을 **수직으로** 환산한 값이라
 * cos(RAKE)로 나눈다 — 경사면의 반두께는 수직 거리로 더 크다.
 */
const SEAT_LIFT = SLAB_T / 2 / Math.cos(RAKE)
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

interface StandSide extends CrowdStand {
  /** rotY 각(rad) — 로컬 +Z가 향하는 월드 방향. */
  yaw: number
  /** 골 뒤(엔드) 스탠드 여부 — 롱사이드와 지오메트리를 나눠 공유한다. */
  isEnd: boolean
  /** 관중 색 편향. */
  bias: CrowdBias
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
 * 좌석 격자 정원 = 4면 × (길이 / {@link SEAT_PITCH}) × (깊이 / {@link ROW_STEP}).
 * 현 스탠드 규격(SIDE_LEN 158m · END_LEN 121m · 깊이 26m)에서 **약 25,000석**.
 * 예전 값은 7,440이었다 — 좌석 피치를 인원에서 역산하던 시절의 산물이고, 그래서
 * 인스턴스 하나가 사람이 아니라 2m 색 큐브였다(crowd.ts 헤더 진단 참조).
 */
export const MAX_CROWD_INSTANCES: number = crowdCapacity(SIDES, STAND_DEPTH, 1)

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
  /** 관중 유무. crowdCount는 더 이상 인원이 아니다(BuildSceneOptions 주석 참조). */
  const wantCrowd = (opts.crowdCount ?? 1) > 0
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
  // 1600m로 넓힌다: 하늘 돔(반지름 700m)이 생긴 뒤로는 520m 평면의 **가장자리**가
  // 지평선보다 앞에 보여서 "땅이 끝나는 선"이 프레임에 들어왔다. 포그 끝(470m) 밖까지
  // 깔면 가장자리가 포그 색으로 수렴해 지평선과 이음매 없이 붙는다.
  const baseGeo = new THREE.PlaneGeometry(1600, 1600)
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

  // ── 골대 2개 + 코너 플래그 4개(레퍼런스 기반 — props.ts) ──────
  for (const sign of [-1, 1] as const) {
    pitchGroup.add(buildGoal(THREE, { sign, maxAnisotropy: aniso }))
  }
  pitchGroup.add(buildCornerFlags(THREE, aniso))

  // ── 관중석 슬래브 + 광고보드(면별 그룹) ─────────────────────
  const concreteTex = toTexture(THREE, makeConcreteCanvas(256), { aniso, repeat: [24, 4] })
  // 슬래브는 **어두운 네이비 콘크리트**여야 한다. 예전 색(0xbcc4d2)은 관중 사이 틈으로
  // 밝은 회색이 새어 나와 관중석이 격자무늬로 보이는 원인 중 하나였다. 레퍼런스의
  // 바탕색은 짙은 네이비다.
  const standMat = new THREE.MeshLambertMaterial({
    color: concreteTex ? 0x596478 : 0x141a28,
    ...(concreteTex ? { map: concreteTex } : {}),
  })
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x11151d })
  // 펜스 정면에 붙는 콘크리트 — 순수 단색 검정은 화면에서 "구멍"으로 읽힌다.
  const fenceTex = toTexture(THREE, makeConcreteCanvas(256), { aniso, repeat: [40, 1] })
  const fenceMat = new THREE.MeshLambertMaterial({
    color: fenceTex ? 0x4a5364 : 0x161b25,
    ...(fenceTex ? { map: fenceTex } : {}),
  })
  /**
   * 펜스 윗단 LED 리본. 실제 경기장이 이 위치에 두르는 얇은 발광 띠이고,
   * 화면에서는 피치와 관중석을 가르는 밝은 선이 되어 죽은 검정 띠를 없앤다.
   * 광고판보다 약하게(0.5배) 밀어 시선을 뺏지 않는다.
   */
  const ribbonMat = new THREE.MeshBasicMaterial({ color: hdr(0x16294d, AD_SHARE * 0.3), toneMapped: false })

  /**
   * 광고판 텍스처 repeat — 패널 하나가 항상 `보드높이 × AD_PANEL_ASPECT`(6.3m)가 되게
   * 역산한다. 예전에는 repeat을 4/2.5로 손으로 박아 두 면의 글자 크기가 서로 달랐고
   * 패널 비율도 레퍼런스(5.2:1)에서 멀었다.
   */
  const BOARD_H = 1.05
  const adRepeat = (len: number): number => len / (BOARD_H * AD_PANEL_ASPECT * AD_TEXTS.length)
  const SIDE_BOARD_LEN = 100
  const END_BOARD_LEN = 62
  const adTexSide = toTexture(THREE, makeAdBoardCanvas(), { aniso, repeat: [adRepeat(SIDE_BOARD_LEN), 1] })
  const adTexEnd = adTexSide ? adTexSide.clone() : null
  if (adTexEnd) {
    adTexEnd.repeat.set(adRepeat(END_BOARD_LEN), 1)
    adTexEnd.needsUpdate = true
  }

  /**
   * ── 입장 배너(스토리보드 컷1의 "태극기 / 상대편 국기") ──────────
   * 피치에 눕힌 **국기 천** 두 장. 2026-08-01 정정 전에는 "실제 국기가 아니다"라며
   * 팀 색 tifo를 깔았는데, 스펙 §9.1이 금지한 것은 엠블럼·크레스트·공식 로고이고
   * 국기는 오히려 그 조항이 **지정한** 식별 수단이었다
   * (근거는 textures.makeBannerCanvas · entrance.ENTRANCE_BANNER_HOME 주석).
   *
   * 국기 SVG 디코드는 비동기라 **두 단계**로 간다: 먼저 팀 색 폴백 캔버스로 텍스처를
   * 만들어 씬을 즉시 완성하고, 이미지가 도착하면 같은 자리에 국기 캔버스를 그려
   * 텍스처 이미지를 교체한다. 로드가 실패하면 폴백이 그대로 남는다(연출은 안 멈춘다).
   * 기본은 숨김이고 입장 연출이 켠다.
   */
  const bannerGroup = new THREE.Group()
  bannerGroup.visible = false
  bannerGroup.name = 'entrance-banners'
  pitchGroup.add(bannerGroup)
  const addBanner = (
    spec: { x: number; z: number; w: number; h: number }, color: number, label: string,
    teamId?: TeamId,
  ): void => {
    const tex = toTexture(THREE, makeBannerCanvas(color, kitInk(color), label), { aniso })
    if (tex && teamId) {
      // 국기 도착 시 캔버스를 통째로 갈아끼운다. 새 캔버스를 만들어 `tex.image`에 꽂는
      // 편이 기존 캔버스에 덧그리는 것보다 안전하다 — 폴백 도안이 국기 밑에 남지 않는다.
      void loadFlagImage(teamId).then(img => {
        if (!img) return
        const next = makeBannerCanvas(color, kitInk(color), label, img)
        if (!next) return
        tex.image = next
        tex.needsUpdate = true
      })
    }
    if (tex) {
      // ★ 180° 회전 보정(u·v 둘 다 뒤집는다). 평면을 -90°로 눕히면
      //   · u(+X)는 **화면 왼쪽**을 향하고(방송 카메라가 -Z라 화면 오른쪽이 -X — ends.ts),
      //   · v(+Y)는 -Z로 가서 **화면 아래**를 향한다.
      //   둘을 그대로 두면 팀명이 뒤집힌 채 거울상으로 읽힌다(실제 캡처로 확인).
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(-1, -1)
      tex.offset.set(1, 1)
      tex.needsUpdate = true
    }
    const geo = new THREE.PlaneGeometry(spec.w, spec.h)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshLambertMaterial({
      color: tex ? 0xffffff : color,
      ...(tex ? { map: tex } : {}),
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    // 잔디 바로 위. 0.02는 z-fighting을 피하는 최소 높이다(라인 텍스처와 같은 평면이다).
    mesh.position.set(spec.x, 0.02, spec.z)
    mesh.renderOrder = 1
    bannerGroup.add(mesh)
  }
  if (opts.homeLabel) addBanner(ENTRANCE_BANNER_HOME, homeColor, opts.homeLabel, opts.homeTeamId)
  if (opts.awayLabel) addBanner(ENTRANCE_BANNER_AWAY, awayColor, opts.awayLabel, opts.awayTeamId)
  const setEntranceBanners = (visible: boolean): void => {
    bannerGroup.visible = visible && bannerGroup.children.length > 0
  }

  const rise = STAND_DEPTH * Math.tan(RAKE)
  const slope = STAND_DEPTH / Math.cos(RAKE)
  const sideRakeGeo = new THREE.BoxGeometry(SIDE_LEN, SLAB_T, slope)
  const endRakeGeo = new THREE.BoxGeometry(END_LEN, SLAB_T, slope)
  const sideWallGeo = new THREE.BoxGeometry(SIDE_LEN, 7, 1.6)
  const endWallGeo = new THREE.BoxGeometry(END_LEN, 7, 1.6)
  const sideFenceGeo = new THREE.BoxGeometry(SIDE_LEN, STAND_H0, 1.2)
  const endFenceGeo = new THREE.BoxGeometry(END_LEN, STAND_H0, 1.2)
  const sideRibbonGeo = new THREE.BoxGeometry(SIDE_LEN, 0.16, 0.06)
  const endRibbonGeo = new THREE.BoxGeometry(END_LEN, 0.16, 0.06)
  const sideBoardGeo = new THREE.BoxGeometry(SIDE_BOARD_LEN, BOARD_H, 0.3)
  const endBoardGeo = new THREE.BoxGeometry(END_BOARD_LEN, BOARD_H, 0.3)
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

  /**
   * 좌석면 관중 텍스처 한 타일이 덮는 실치수(m).
   * 가로: `perSide`(30) × 좌석 피치. 세로: 타일 행 수(30/0.78 ≈ 38) × 경사면 열 간격.
   * 이 값으로 repeat을 잡아야 텍스처 속 인물 크기가 인스턴스 인물 크기와 일치한다.
   */
  const CROWD_TILE_W = 30 * SEAT_PITCH
  const CROWD_TILE_V = (30 / 0.78) * (ROW_STEP / Math.cos(RAKE))
  const crowdSkinGeo = { side: new THREE.PlaneGeometry(SIDE_LEN, slope), end: new THREE.PlaneGeometry(END_LEN, slope) }

  for (const side of SIDES) {
    const isEnd = side.isEnd
    const g = new THREE.Group()
    g.rotation.y = side.yaw
    // 경사 슬래브: 로컬 -z 끝이 (inner, H0), +z 끝이 (inner+DEPTH, H0+rise).
    const rake = new THREE.Mesh(isEnd ? endRakeGeo : sideRakeGeo, standMat)
    rake.rotation.x = -RAKE
    rake.position.set(0, STAND_H0 + rise / 2, side.inner + STAND_DEPTH / 2)
    g.add(rake)

    // 좌석면 관중 텍스처(2단 구성의 1단) — 인스턴스 사람 **사이의 틈**을 메운다.
    // 면마다 편향이 달라 텍스처도 면마다 따로 만든다(홈 골 뒤는 빨강이 우세해야 한다).
    if (wantCrowd) {
      const skinTex = toTexture(
        THREE,
        makeCrowdCanvas({
          size: 256,
          home: hexCss(homeColor),
          away: hexCss(awayColor),
          bias: side.bias,
          seed: Math.round(side.yaw * 1000),
        }),
        { aniso, repeat: [(isEnd ? END_LEN : SIDE_LEN) / CROWD_TILE_W, slope / CROWD_TILE_V] },
      )
      if (skinTex) {
        const skin = new THREE.Mesh(isEnd ? crowdSkinGeo.end : crowdSkinGeo.side, new THREE.MeshBasicMaterial({ map: skinTex }))
        // XY 평면 → 좌석면. -PI/2로 눕히고 추가로 -RAKE만큼 뒤로 세운다.
        skin.rotation.x = -Math.PI / 2 - RAKE
        skin.position.set(0, STAND_H0 + rise / 2 + SEAT_LIFT + 0.01, side.inner + STAND_DEPTH / 2)
        g.add(skin)
      }
    }

    // 뒷벽
    const wall = new THREE.Mesh(isEnd ? endWallGeo : sideWallGeo, wallMat)
    wall.position.set(0, STAND_H0 + rise + 2.4, side.inner + STAND_DEPTH + 0.8)
    g.add(wall)
    // 피치와 관중석 사이 낮은 펜스 + 윗단 LED 리본
    const fence = new THREE.Mesh(isEnd ? endFenceGeo : sideFenceGeo, fenceMat)
    fence.position.set(0, STAND_H0 / 2, side.inner - 0.6)
    g.add(fence)
    const ribbon = new THREE.Mesh(isEnd ? endRibbonGeo : sideRibbonGeo, ribbonMat)
    ribbon.position.set(0, STAND_H0 - 0.16, side.inner - 1.22)
    g.add(ribbon)
    // 페리미터 LED 광고보드(살짝 뒤로 기울임)
    const board = new THREE.Mesh(isEnd ? endBoardGeo : sideBoardGeo, isEnd ? endAdMat : sideAdMat)
    board.position.set(0, 0.55, side.boardDist)
    board.rotation.x = 0.13
    g.add(board)
    stadiumGroup.add(g)
  }

  // ── 관중 InstancedMesh(2단 구성의 2단 — crowd.ts) ────────────
  let crowdBundle: CrowdBundle | null = wantCrowd
    ? buildCrowd(THREE, {
        stands: SIDES,
        homeColor,
        awayColor,
        standDepth: STAND_DEPTH,
        rake: RAKE,
        standH0: STAND_H0,
        seatLift: SEAT_LIFT,
        detail: opts.crowdDetail,
      })
    : null
  const crowdCount = crowdBundle?.count ?? 0
  if (crowdBundle) stadiumGroup.add(crowdBundle.mesh)

  // ── 조명탑 4기(야간 경기 실루엣) ─────────────────────────────
  const RIG_Y = 43
  const masts: { x: number; z: number }[] = []
  const mastGeo = new THREE.CylinderGeometry(0.5, 0.9, 44, 8)
  const mastMat = new THREE.MeshLambertMaterial({ color: 0x232830 })
  const rigGeo = new THREE.BoxGeometry(10, 5.2, 1.1)
  // 조명탑 리그가 블룸의 주 광원이다 — 여기만 확실히 임계 위로 올린다.
  const rigMat = new THREE.MeshBasicMaterial({ color: hdr(0xfff4d6, 1), toneMapped: false })
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      const px = sx * (END_INNER + STAND_DEPTH * 0.85)
      const pz = sz * (SIDE_INNER + STAND_DEPTH * 0.85)
      masts.push({ x: px, z: pz })
      const mast = new THREE.Mesh(mastGeo, mastMat)
      mast.position.set(px, 22, pz)
      stadiumGroup.add(mast)
      const rig = new THREE.Mesh(rigGeo, rigMat)
      rig.position.set(px, RIG_Y, pz)
      rig.lookAt(0, 0, 0)
      stadiumGroup.add(rig)
    }
  }

  // ── 경기장 외부(exterior.ts) ─────────────────────────────────
  const exterior: ExteriorBundle | null =
    opts.exterior === false
      ? null
      : buildExterior(THREE, {
          stands: SIDES,
          standDepth: STAND_DEPTH,
          rake: RAKE,
          standH0: STAND_H0,
          masts,
          rigY: RIG_Y,
          skyBoost,
          emissiveBoost: boost,
          maxAnisotropy: aniso,
          lightShafts: opts.lightShafts !== false,
        })
  if (exterior) stadiumGroup.add(exterior.group)

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
    exterior?.setEmissiveBoost(boost)
  }

  // ── 관중 웨이브 ──────────────────────────────────────────────
  // 이제 유니폼 2개만 쓴다(crowd.ts의 정점 셰이더가 실제 변위를 만든다).
  // 예전에는 프레임마다 인스턴스 행렬 전체(수백 KB)를 다시 올렸다 — 그 비용이
  // 관중 수 상한을 눌렀고, 없어졌기 때문에 7,440 → 25,000으로 늘릴 수 있었다.
  function crowdWave(t: number, intensity: number): void {
    crowdBundle?.wave(t, intensity)
  }

  function dispose(): void {
    disposeTree(scene)
    scene.clear()
    pitchGroup.clear()
    stadiumGroup.clear()
    crowdBundle = null
  }

  return {
    scene,
    camera,
    pitchGroup,
    setEntranceBanners,
    stadiumGroup,
    pitchMesh,
    // 값 복사로 노출하면 dispose 후에도 해제된 메시를 붙들게 된다(dangling). getter로 클로저를 본다.
    get crowd() {
      return crowdBundle?.mesh ?? null
    },
    crowdCount,
    crowdWave,
    setEmissiveBoost,
    dispose,
  }
}

/** 0xRRGGBB → `#rrggbb`(캔버스 텍스처 생성기가 CSS 색 문자열을 받는다). */
function hexCss(hex: number): string {
  return `#${(hex >>> 0).toString(16).padStart(6, '0').slice(-6)}`
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
