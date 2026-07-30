// src/ui/pitch/three/player3d.ts
// 절차적 3D 선수 캐릭터 — 관절 리그 + 러닝 사이클.
//
// 설계 원칙(Phase 4E Global Constraints):
//  1) three는 **인자 주입**(정적 import 금지 — 엔트리 번들에 three가 유입되면 안 된다).
//     타입만 `import type`으로 참조한다(런타임 코드로 남지 않는다).
//  2) 외부 에셋 0 — 모든 형상은 코드 지오메트리, 등번호는 canvas 절차 텍스처.
//  3) Math.random·Date 금지 — 개체 변주(체격·피부·머리색·초기 위상·주발·다이브 방향)는
//     전부 선수 id 해시(hash01) 기반 결정론.
//  4) 성능 — 지오메트리·머티리얼·텍스처는 모듈 스코프 캐시를 공유한다.
//     22명을 만들어도 지오메트리는 한 번만 생성된다(킷 컬러별 머티리얼만 분기).
//
// 좌표 규약: 모델은 로컬 **+X를 정면**으로 서 있다(월드는 XZ 평면, Y가 높이).
//  - 시상면(앞뒤) 스윙 = Z축 회전, **양수 = 앞(+X)**
//  - 관상면(좌우) 롤·다이브 = X축 회전, **양수 = +Z 쪽으로 기울기**
//  - 몸통 비틀기 = Y축 회전
//  - 무릎은 뒤로만 굽으므로 **음수 = 굴곡**, 팔꿈치는 앞으로만 굽으므로 **양수 = 굴곡**
//  - pose.yaw(+X가 0인 atan2(dz,dx) 규약) → root.rotation.y = **-yaw**
//    (RotY(θ)는 로컬 +X를 월드 (cosθ,0,-sinθ)로 보내므로 θ=-yaw여야 (cos yaw,0,sin yaw)가 된다)
import type * as Three from 'three'
import type { PlayerPose } from './types'
import {
  capsuleVSpan,
  makeKitCanvas,
  type KitCanvasSpec,
  type KitPattern,
} from './textures'

// 순수 포즈 수학(러닝 사이클·역기구학·킥·다이브·킷 색)은 pose.ts로 분리했다 —
// 이유는 pose.ts 헤더 참조. 기존 import 경로(`from './player3d'`)를 쓰는 곳이 있어
// 공개 이름은 그대로 재수출한다.
import {
  ANKLE_H, ARM_Z, CELEBRATE_JUMP, FOREARM, HIP_Y, LEG_Z, SHIN_LEN, SHOULDER_Y,
  SPRINT_SPEED, STAND_DROP, TAU, THIGH_LEN, UPPER_ARM,
  advancePhase, celebrateOffset, clamp, clamp01, deepKit, diveAngles, gaitAngles,
  hash01, kickAngles, kitInk, luminance, mixColor, solveLeg,
} from './pose'

export * from './pose'

/** 주입되는 three 네임스페이스 타입(정적 import가 아니므로 번들에 포함되지 않는다). */
type ThreeNS = typeof import('three')

// ─────────────────────────────────────────────────────────────────────────────
// 리그 조립 (three 주입)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlayerOptions {
  /** 상의 킷 컬러 0xRRGGBB */
  kit: number
  /** 양말·디테일 액센트 컬러 */
  accent: number
  /** 등번호 */
  number: number
  isGk: boolean
}

export interface PlayerRig {
  root: Three.Object3D
  /** 매 프레임 호출. clockT는 초 단위 누적 시간(three Clock). */
  apply(pose: PlayerPose, clockT: number): void
  dispose(): void
}

const SKIN_TONES = [0xf0c9a4, 0xe0ac7e, 0xc68642, 0xa2673f, 0x7c4a26]
const HAIR_TONES = [0x141010, 0x2b1d14, 0x0d0d10, 0x4a2f1a, 0x5d4030]
/**
 * GK 형광 킷 베이스. 팀 색과 섞지 않고 **고정**한다 — 어웨이 액센트(딥네이비)와 섞으면
 * 올리브로 탁해져 필드 플레이어와의 구분이 무너졌다. 라임은 스칼렛·애저·잔디 어느
 * 쪽과도 색상과 명도가 동시에 벌어져 40px에서도 "저 사람은 골키퍼"가 즉시 읽힌다.
 * 소속 팀은 칼라·양말 밴드·반바지의 어두운 보조색이 알려준다.
 */
const GK_NEON = 0xd8ff3c

/**
 * 팀 패턴 — **무지(plain)로 확정**.
 *
 * docs/refs 축소 판정은 무지·횡스트라이프·새시 셋 다 44px를 통과시켰지만, 무지가
 * 팀 색 면적이 가장 크고 인식이 가장 빠르다고 결론냈다. 우리 화면은 참조 시트(단독 셔츠)와
 * 달리 **어두운 야간 피치 위에 22명이 흩어져 있고 블룸까지 걸린다**. 이 조건에서 어두운
 * 보조 패턴은 배경과 합쳐져 상체를 잘라먹는 쪽으로 작용한다(참조 문서도 파랑 팀 남색
 * 밴드 면적을 더 늘리지 말라고 명시한다). 두 팀이 이미 스칼렛/애저로 색상 축에서 벌어져
 * 있어 패턴이라는 두 번째 구분 축을 살 이유도 없다.
 *
 * 'hoops'는 텍스처 생성기에 남겨 둔다 — 팀 색이 서로 가까운 대진(예: 빨강 vs 주황)이
 * 생기면 그때 한쪽에만 켜는 것이 옳은 사용법이다.
 */
const KIT_PATTERN: KitPattern = 'plain'

// 모듈 스코프 공유 캐시 — 22명을 만들어도 지오메트리는 한 번만 생성된다.
const geoCache = new Map<string, Three.BufferGeometry>()
const matCache = new Map<string, Three.Material>()
const texCache = new Map<string, Three.Texture | null>()

function cachedGeo<G extends Three.BufferGeometry>(key: string, make: () => G): G {
  const hit = geoCache.get(key)
  if (hit) return hit as G
  const made = make()
  geoCache.set(key, made)
  return made
}

function cachedMat<M extends Three.Material>(key: string, make: () => M): M {
  const hit = matCache.get(key)
  if (hit) return hit as M
  const made = make()
  matCache.set(key, made)
  return made
}

/** 라이트에 반응하는 저비용 스타일라이즈 머티리얼(그림자맵 없이도 입체감이 난다). */
function bodyMat(three: ThreeNS, color: number): Three.MeshLambertMaterial {
  return cachedMat(`lam:${color}`, () => new three.MeshLambertMaterial({ color }))
}

function hexStr(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/**
 * 등번호 canvas 텍스처(고대비 아웃라인). canvas 미지원 환경(SSR·노드 테스트)에서는
 * null을 반환하고 **절대 throw하지 않는다** — 호출부가 단색 폴백을 쓴다.
 */
function numberTexture(three: ThreeNS, num: number, fg: number, outline: number): Three.Texture | null {
  const key = `num:${num}|${fg}|${outline}`
  const hit = texCache.get(key)
  if (hit !== undefined) return hit
  let tex: Three.Texture | null = null
  try {
    if (typeof document === 'undefined') throw new Error('no document')
    const cv = document.createElement('canvas')
    cv.width = 128
    cv.height = 128
    const ctx = cv.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const label = String(num)
    ctx.clearRect(0, 0, 128, 128)
    ctx.font = 'bold 92px "Arial Black", Impact, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 14
    ctx.strokeStyle = hexStr(outline)
    ctx.strokeText(label, 64, 68)
    ctx.fillStyle = hexStr(fg)
    ctx.fillText(label, 64, 68)
    const made = new three.CanvasTexture(cv)
    made.colorSpace = three.SRGBColorSpace
    made.needsUpdate = true
    tex = made
  } catch {
    tex = null
  }
  texCache.set(key, tex)
  return tex
}

/**
 * canvas 절차 텍스처를 three 텍스처로 감싼다(모듈 캐시 공유).
 * canvas 미지원 환경(SSR·node 테스트)에서는 **null**을 돌려주고 절대 throw하지 않는다.
 */
function canvasTex(
  three: ThreeNS,
  key: string,
  make: () => HTMLCanvasElement | null,
  srgb = true,
): Three.Texture | null {
  const hit = texCache.get(key)
  if (hit !== undefined) return hit
  let tex: Three.Texture | null = null
  try {
    const cv = make()
    if (cv) {
      const made = new three.CanvasTexture(cv)
      if (srgb) made.colorSpace = three.SRGBColorSpace
      made.needsUpdate = true
      tex = made
    }
  } catch {
    tex = null
  }
  texCache.set(key, tex)
  return tex
}

/**
 * 킷 텍스처를 입힌 램버트 머티리얼. 텍스처가 없으면 주 팀 색 단색으로 폴백한다
 * (폴백 3단의 1단 — 텍스처 없음. 나머지는 scene의 단색 머티리얼, SVG 피치다).
 * map이 붙을 때 color를 흰색으로 두는 이유: 램버트는 map과 color를 곱하므로
 * 캔버스에 그린 팔레트가 그대로 나와야 참조 판정 색이 보존된다.
 */
function kitMat(
  three: ThreeNS,
  key: string,
  fallback: number,
  make: () => HTMLCanvasElement | null,
): Three.MeshLambertMaterial {
  return cachedMat(`kit:${key}`, () => {
    const tex = canvasTex(three, `kittex:${key}`, make)
    return new three.MeshLambertMaterial(tex ? { map: tex, color: 0xffffff } : { color: fallback })
  })
}

/**
 * 컨택트 섀도우 블롭의 방사형 감쇠를 **정점 알파에 굽는다**(반지름 1, XZ 평면 원판).
 *
 * **왜 텍스처가 아니라 정점 알파인가:** 원래 구현은 방사형 그라디언트 캔버스를 `map`으로
 * 물린 반투명 평면이었는데, 헤드리스 렌더 실측에서 **화면에 아무것도 남기지 않았다**.
 * 크기·불투명도를 아무리 올려도 발밑 잔디 휘도가 0.2/255밖에 변하지 않았고, 같은 머티리얼을
 * 불투명으로 바꾸면 검은 사각형이 정상적으로 나왔다(=RGB는 살고 알파만 죽는다).
 * 그래서 그동안 **선수 발밑 그림자와 공 그림자가 코드에는 있는데 화면에는 없었다.**
 * 정점 알파로 바꾼 뒤 같은 프레임의 on/off 픽셀 diff는 최대 142(raw)·86(post)이 됐다.
 *
 * 정점 알파는 텍스처 알파 업로드 경로를 통째로 우회하고, 덤으로
 *  - 텍스처 업로드·샘플링·밉맵이 사라져 더 싸고,
 *  - 캔버스가 없는 환경(SSR·node 테스트)에서도 **똑같이** 동작하며(폴백 분기 불필요),
 *  - 순수 수학이라 node 테스트로 감쇠 곡선을 직접 검증할 수 있다.
 *
 * @param core 알파가 꺾이는 반지름 비율 — 크면 코어가 넓고 경계가 급하다(접지한 발),
 *   작으면 넓게 번진다(떠 있는 질량의 앰비언트 오클루전).
 * @param rings 중심 외 링 수 @param seg 원주 분할
 */
export function shadowDiscGeometry(three: ThreeNS, core: number, rings = 3, seg = 14): Three.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  const idx: number[] = []
  // 반지름 비율 → 알파.
  const alphaAt = (t: number): number => shadowFalloff(t, core)
  pos.push(0, 0, 0)
  col.push(0, 0, 0, alphaAt(0))
  for (let r = 1; r <= rings; r++) {
    const rad = r / rings
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * TAU
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad)
      col.push(0, 0, 0, alphaAt(rad))
    }
  }
  const ringStart = (r: number): number => 1 + (r - 1) * seg
  for (let s = 0; s < seg; s++) {
    const n = (s + 1) % seg
    // 중심 팬
    idx.push(0, ringStart(1) + n, ringStart(1) + s)
    // 링 사이 쿼드
    for (let r = 1; r < rings; r++) {
      const a0 = ringStart(r) + s
      const a1 = ringStart(r) + n
      const b0 = ringStart(r + 1) + s
      const b1 = ringStart(r + 1) + n
      idx.push(a0, a1, b1, a0, b1, b0)
    }
  }
  const geo = new three.BufferGeometry()
  geo.setAttribute('position', new three.Float32BufferAttribute(pos, 3))
  // itemSize 4 = RGBA 정점 색. three가 USE_COLOR_ALPHA로 컴파일해 알파까지 보간한다.
  geo.setAttribute('color', new three.Float32BufferAttribute(col, 4))
  geo.setIndex(idx)
  return geo
}

/**
 * 컨택트 섀도우 감쇠 곡선. t = 중심에서의 반지름 비율(0~1), 반환은 알파 배율(0~1).
 * 순수 함수 — 곡선이 단조 감소하고 가장자리에서 정확히 0이 되는지 테스트로 못박는다.
 */
export function shadowFalloff(t: number, core: number): number {
  const k = clamp(core, 0.05, 0.95)
  const u = clamp01(t)
  const mid = k + (1 - k) * 0.64
  if (u <= k) return 0.95 + (0.62 - 0.95) * (u / k)
  if (u <= mid) return 0.62 + (0.16 - 0.62) * ((u - k) / (mid - k))
  return 0.16 * (1 - (u - mid) / (1 - mid))
}

/** 관절 원점에서 아래로 뻗는 캡슐 팔다리(피벗 = 관절). */
function limbMesh(
  three: ThreeNS,
  key: string,
  radius: number,
  length: number,
  mat: Three.Material,
  radial = 8,
): Three.Mesh {
  const geo = cachedGeo(
    `cap:${key}`,
    () => new three.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 2, radial),
  )
  const mesh = new three.Mesh(geo, mat)
  mesh.position.y = -length / 2
  return mesh
}

/**
 * 힙·무릎 각에서 발목의 힙 로컬 위치를 구한다({@link solveLeg}의 정방향).
 * 접지 그림자를 **실제 발 위치**에 놓으려면 어떤 액션이든 이 순기구학이 필요하다
 * (러닝만 footTarget을 알고, 킥·아이들·다이브는 관절각만 있다).
 * @returns fx = 앞(+X), fy = 아래(힙에서의 낙차)
 */
export function ankleFromLeg(hip: number, knee: number): { fx: number; fy: number } {
  return {
    fx: THIGH_LEN * Math.sin(hip) + SHIN_LEN * Math.sin(hip + knee),
    fy: THIGH_LEN * Math.cos(hip) + SHIN_LEN * Math.cos(hip + knee),
  }
}

// ── 접지 그림자 계수 ─────────────────────────────────────────────────────────
// 선택: **발별 블롭**(싼 쪽). 실시간 섀도우맵은 캐스터가 22명×21메시 = 462개라
// 섀도우 패스에서 씬 전체를 한 번 더 그려야 하는데, 화면상 40~52px에서 얻는 건
// "발밑이 어둡다" 하나다. B-2에서 발 접지 역기구학이 들어가 발이 실제로 y=0에 붙으므로
// 블롭을 발마다 하나씩 두면 그 하나를 정확히 얻는다. 실측 비용은 커밋 메시지 참조.

/** 그림자 평면 높이(m) — 피치(y=0) 위, z-파이팅을 피할 만큼만 띄운다. */
const SHADOW_Y = 0.02
/**
 * 발 블롭 기본 반치수(m).
 *
 * **왜 부츠보다 훨씬 커야 하는가:** 방송 샷에서 1.8m 선수가 44px이므로 축척은 약 24px/m다.
 * 부츠(0.25×0.115m)는 6×3px이고, 방사형 그라디언트는 가장자리 알파가 0이라 블롭이
 * 부츠와 같은 크기면 **보이는 부분이 남지 않는다**(첫 구현이 정확히 이 실수였다 —
 * 씬 그래프는 맞았는데 화면에서는 잔디 휘도가 0.2/255밖에 안 변했다).
 * 지름 0.50×0.34m = 약 12×8px이면 부츠 바깥으로 3px 이상 어두운 테두리가 남는다.
 * (아래 값은 **반지름**이다 — 블롭 원판 지오메트리가 반지름 1로 만들어진다.)
 */
const FOOT_SHADOW_X = 0.28
const FOOT_SHADOW_Z = 0.19
/** 발이 1m 뜰 때 블롭이 퍼지는 배율. 그림자는 멀어질수록 크고 흐려진다. */
const FOOT_SPREAD = 2.6
/** 접지 순간의 발 블롭 불투명도. */
const FOOT_ALPHA = 0.8
/** 발 높이에 대한 감쇠 계수 — 1/(1+k·h). h=0.2m에서 약 1/3로 옅어진다. */
const FOOT_FADE = 10
/**
 * 몸통 질량 블롭 반지름(m)과 불투명도 — 발 블롭 둘만 있으면 몸통이 떠 보인다.
 * 반지름을 어깨너비(≈0.4m)에 맞춰야 알파가 실제로 보이는 영역에 모인다.
 */
const BODY_SHADOW_R = 0.5
const BODY_ALPHA = 0.62

/** 리그의 모든 관절 그룹. */
interface Joints {
  body: Three.Group
  torso: Three.Group
  head: Three.Group
  hipL: Three.Group
  hipR: Three.Group
  kneeL: Three.Group
  kneeR: Three.Group
  ankleL: Three.Group
  ankleR: Three.Group
  shoulderL: Three.Group
  shoulderR: Three.Group
  elbowL: Three.Group
  elbowR: Three.Group
  shadows: Shadows
}

/**
 * 접지 그림자 3장. 전부 `root`의 직계 자식이라 요(yaw)만 따라 돌고 몸이 기울어도
 * 지면에 눕는다. 머티리얼은 **선수마다 개별 인스턴스**다 — 불투명도가 발 높이에 따라
 * 매 프레임 바뀌므로 공유 캐시를 쓸 수 없다(3장 × 22명 = 66개, 전부 사소한 MeshBasic).
 */
interface Shadows {
  footL: Three.Mesh
  footR: Three.Mesh
  body: Three.Mesh
  matL: Three.MeshBasicMaterial
  matR: Three.MeshBasicMaterial
  matBody: Three.MeshBasicMaterial
}

/** 한쪽 발 블롭을 실제 발목 위치·높이에 맞춘다. */
function placeFootShadow(
  mesh: Three.Mesh,
  mat: Three.MeshBasicMaterial,
  hip: number,
  knee: number,
  legZ: number,
  p: RigPose,
  cr: number,
  sr: number,
): void {
  const { fx, fy } = ankleFromLeg(hip, knee)
  // body 로컬 발목 = (fx, HIP_Y - fy, legZ). body는 position.y = bodyY, rotation.x = bodyRoll.
  const y0 = HIP_Y - fy
  const y = p.bodyY + y0 * cr - legZ * sr
  const z = y0 * sr + legZ * cr
  // 부츠 바닥이 지면에서 뜬 높이(발목 관절은 접지 시 ANKLE_H에 있다).
  const h = y - ANKLE_H > 0 ? y - ANKLE_H : 0
  const s = 1 + FOOT_SPREAD * h
  mesh.position.set(fx, SHADOW_Y, z)
  // 지오메트리를 이미 XZ로 눕혀 놓았으므로 스케일도 X·Z 축이다(Y는 두께 = 1 고정).
  mesh.scale.set(FOOT_SHADOW_X * s, 1, FOOT_SHADOW_Z * s)
  mat.opacity = FOOT_ALPHA / (1 + FOOT_FADE * h)
}

/** 한 프레임의 최종 리그 포즈. 매 프레임 전 필드를 덮어써 이전 액션 포즈가 남지 않는다. */
interface RigPose {
  bodyY: number
  /** 전신 롤(다리 포함) — 다이브·낙하처럼 몸 전체가 눕는 동작 전용 */
  bodyRoll: number
  /**
   * 상체만의 롤. 보행 중 좌우 흔들림은 **반드시 여기에 넣는다** —
   * body에 넣으면 리그 전체가 body 원점을 중심으로 기울어 디딤발이 지면에서
   * 뜨거나 파고든다(편심 = 다리 z 0.10 + 부츠 z 반폭 0.0575 = 0.1575m,
   * 스프린트 입각기 최대 롤 0.046rad ⇒ 7.2mm 오차. 실측으로 확인).
   */
  torsoRoll: number
  torsoPitch: number
  torsoTwist: number
  hipL: number
  hipR: number
  kneeL: number
  kneeR: number
  /** 발목(정강이 기준 상대각) — 접지 중 발바닥을 지면과 평행하게 유지한다 */
  ankleL: number
  ankleR: number
  shoulderL: number
  shoulderR: number
  /** 팔 벌림(양수 = 몸에서 바깥으로) */
  armOutL: number
  armOutR: number
  elbowL: number
  elbowR: number
  headPitch: number
  headYaw: number
  /** 컨택트 섀도우 크기 배율(뜨면 작아진다) */
  shadowScale: number
}

const POSE_KEYS: readonly (keyof RigPose)[] = [
  'bodyY',
  'bodyRoll',
  'torsoRoll',
  'torsoPitch',
  'torsoTwist',
  'hipL',
  'hipR',
  'kneeL',
  'kneeR',
  'ankleL',
  'ankleR',
  'shoulderL',
  'shoulderR',
  'armOutL',
  'armOutR',
  'elbowL',
  'elbowR',
  'headPitch',
  'headYaw',
  'shadowScale',
]

/** 액션 전환 크로스페이드 총 길이(초)와 초기 시상수. */
const BLEND_TIME = 0.3
const BLEND_TAU = 0.15

/**
 * cur을 target 쪽으로 k만큼 지수 보간. 액션 전환 순간의 관절 팝을 없앤다.
 * 정상 구간에서는 k=1(즉시 대입)이라 러닝 사이클 진폭이 감쇠하지 않는다
 * (상시 1차 지연을 걸면 2.6Hz 스프린트에서 진폭이 절반으로 죽는다).
 */
function blendPose(cur: RigPose, target: RigPose, k: number): void {
  for (const key of POSE_KEYS) cur[key] += (target[key] - cur[key]) * k
}

function copyPose(cur: RigPose, target: RigPose): void {
  for (const key of POSE_KEYS) cur[key] = target[key]
}

function writePose(j: Joints, p: RigPose): void {
  j.body.position.y = p.bodyY
  j.body.rotation.x = p.bodyRoll
  j.torso.rotation.x = p.torsoRoll
  j.torso.rotation.z = -p.torsoPitch // 앞으로 숙이기 = -Z 회전
  j.torso.rotation.y = p.torsoTwist
  j.hipL.rotation.z = p.hipL
  j.hipR.rotation.z = p.hipR
  j.kneeL.rotation.z = p.kneeL
  j.kneeR.rotation.z = p.kneeR
  j.ankleL.rotation.z = p.ankleL
  j.ankleR.rotation.z = p.ankleR
  j.shoulderL.rotation.z = p.shoulderL
  j.shoulderR.rotation.z = p.shoulderR
  // 왼쪽은 -Z(정면 +X, 위 +Y ⇒ left = up×forward = -Z). -Z쪽 팔은 +X 회전이 바깥이다.
  j.shoulderL.rotation.x = p.armOutL
  j.shoulderR.rotation.x = -p.armOutR
  j.elbowL.rotation.z = p.elbowL
  j.elbowR.rotation.z = p.elbowR
  j.head.rotation.z = -p.headPitch
  j.head.rotation.y = p.headYaw

  // 접지 그림자 — 관절각에서 실제 발 위치를 순기구학으로 풀어 발마다 하나씩 놓는다.
  const sh = j.shadows
  const cr = Math.cos(p.bodyRoll)
  const sr = Math.sin(p.bodyRoll)
  placeFootShadow(sh.footL, sh.matL, p.hipL, p.kneeL, -LEG_Z, p, cr, sr)
  placeFootShadow(sh.footR, sh.matR, p.hipR, p.kneeR, LEG_Z, p, cr, sr)
  // 질량 블롭은 골반 아래. 뜰수록(bodyY>0) 넓게 퍼지고 옅어진다.
  const hb = p.bodyY > 0 ? p.bodyY : 0
  const bs = p.shadowScale * (1 + 0.9 * hb)
  sh.body.position.set(0, SHADOW_Y, HIP_Y * sr)
  sh.body.scale.set(BODY_SHADOW_R * bs, 1, BODY_SHADOW_R * bs)
  sh.matBody.opacity = BODY_ALPHA / (1 + 3 * hb)
}

/**
 * 절차적 3D 선수 1명을 만든다. three는 주입받는다(정적 import 금지).
 * 반환된 root를 씬에 추가하고 매 프레임 apply(pose, clockT)를 호출한다.
 */
export function createPlayer(three: ThreeNS, opts: PlayerOptions): PlayerRig {
  // ── 킷 팔레트 ──
  // docs/refs 판정: 40~52px에서 읽히는 건 실루엣·색 대비·킷뿐이고, 그중 **주 팀 색의
  // 면적**이 팀 인식 속도를 지배한다. 그래서
  //   상의 = 팀 색(면적 최대) / 반바지 = 어두운 보조색 / 양말 = 팀 색 반복
  // 이라는 세로 리듬을 만든다. 밝음–어두움–밝음이 축소본에서 실루엣을 셋으로 쪼개
  // 사람 형태로 읽히게 하고, 팀 색이 상·하 두 곳에 있어 측면·후면·가림에서도 남는다.
  //
  // 변경 전에는 양말이 `accent`(홈=흰색, 어웨이=남색)였다. 흰 양말은 축소본에서
  // 발밑의 밝은 점으로 시선을 끌면서 **팀 정보는 전혀 주지 않았고**, 남색 양말은
  // 어두운 피치에 묻혔다. 참조 판정의 "팀 색을 상의와 양말에 반복" 권고를 따른다.
  const deep = deepKit(opts.kit)
  const shirt = opts.isGk ? GK_NEON : opts.kit
  const shorts = deep
  const socks = opts.isGk ? GK_NEON : opts.kit
  const ink = kitInk(shirt)

  /** 몸통 캡슐의 원통 구간 v 범위 — 후프를 어깨·밑단 캡까지 흘리지 않기 위해. */
  const torsoCyl = capsuleVSpan(0.155, 0.3)
  /** 킷 텍스처 캐시 키. 팀 색·GK 여부가 같으면 22명이 텍스처 하나를 공유한다. */
  const kitKey = `${opts.isGk ? 'gk' : 'fp'}:${opts.kit}`
  const torsoSpec: KitCanvasSpec = {
    base: hexStr(shirt),
    deep: hexStr(deep),
    pattern: KIT_PATTERN,
    patternSpan: torsoCyl,
    // 칼라: 캡슐 위쪽 캡의 상단 14%(몸통 표면적의 약 6%). 목 둘레만 감싼다.
    bands: [{ from: 0.86, to: 1, color: hexStr(deep) }],
  }

  // 개체 변주 시드: 생성 시점엔 id를 모르므로 등번호·킷으로, 첫 apply에서 id 해시로 교체.
  const vary = hash01(`${opts.number}|${opts.kit}|${opts.isGk ? 'gk' : 'fp'}`)
  const skin = SKIN_TONES[Math.floor(vary * SKIN_TONES.length) % SKIN_TONES.length]
  const hair = HAIR_TONES[Math.floor(vary * 977) % HAIR_TONES.length]

  // 몸통·소매·양말은 절차 킷 텍스처, 나머지는 단색. 소매와 양말을 몸통과 **다른**
  // 머티리얼로 나눈 이유: 셋 다 캡슐이라 같은 텍스처를 물리면 팔·정강이에 칼라가 찍힌다.
  const torsoMat = kitMat(three, `torso:${kitKey}`, shirt, () => makeKitCanvas(torsoSpec))
  const sleeveMat = kitMat(three, `sleeve:${kitKey}`, shirt, () =>
    // 소매 밑단 트림 — 상완 캡슐의 아래끝(v=0)이 팔꿈치다. 참조가 "약 3px 이상 남는
    // 소매 끝"을 유효 디테일로 꼽았고, 팔 실루엣의 끝을 어둡게 찍으면 축소본에서
    // 팔이 몸통과 분리돼 보인다.
    makeKitCanvas({
      base: hexStr(shirt),
      deep: hexStr(deep),
      bands: [{ from: 0, to: 0.26, color: hexStr(deep) }],
    }),
  )
  const socksMat = kitMat(three, `sock:${kitKey}`, socks, () =>
    // 양말 밴드 — 정강이 캡슐의 위쪽(무릎 쪽)에 한 줄. 팀 색 면적을 거의 깎지 않으면서
    // 다리를 무릎에서 한 번 끊어 준다.
    makeKitCanvas({
      base: hexStr(socks),
      deep: hexStr(deep),
      bands: [{ from: 0.72, to: 0.86, color: hexStr(deep) }],
    }),
  )
  const shortsMat = bodyMat(three, shorts)
  const skinMat = bodyMat(three, skin)
  const hairMat = bodyMat(three, hair)
  const bootMat = bodyMat(three, 0x14161c)
  // GK는 장갑(밝은 액센트), 필드 플레이어는 맨손
  const handMat = opts.isGk ? bodyMat(three, mixColor(0xf4f7ff, opts.accent, 0.22)) : skinMat

  const root = new three.Group()
  root.name = `player-${opts.number}`

  // ── 접지 그림자: 발마다 하나 + 몸통 질량 하나 ──
  // 발 블롭은 코어가 넓어(0.55) 경계가 급하다 = 접지한 발.
  // 질량 블롭은 코어가 좁아(0.5) 넓게 번진다 = 몸의 앰비언트 오클루전.
  const makeBlob = (
    key: string,
    core: number,
    alpha: number,
  ): { mesh: Three.Mesh; mat: Three.MeshBasicMaterial } => {
    // 정점 알파(vertexColors + RGBA)로 감쇠를 준다 — 텍스처 알파 경로는 이 조합에서
    // 화면에 아무것도 남기지 않았다(shadowDiscGeometry 주석의 실측 근거).
    const mat = new three.MeshBasicMaterial({
      color: 0xffffff, // 정점 색(검정)과 곱해지므로 흰색이어야 정점 값이 그대로 나온다
      vertexColors: true,
      transparent: true,
      opacity: alpha,
      depthWrite: false,
      // 톤매핑을 태우면 그림자가 회색으로 들려 잔디 위에서 얼룩처럼 보인다.
      toneMapped: false,
    })
    const geo = cachedGeo(`blob:${key}`, () => shadowDiscGeometry(three, core))
    const mesh = new three.Mesh(geo, mat)
    mesh.position.y = SHADOW_Y
    mesh.renderOrder = 1
    root.add(mesh)
    return { mesh, mat }
  }
  const blobL = makeBlob('foot', 0.55, FOOT_ALPHA)
  const blobR = makeBlob('foot', 0.55, FOOT_ALPHA)
  const blobBody = makeBlob('body', 0.5, BODY_ALPHA)
  const shadows: Shadows = {
    footL: blobL.mesh,
    footR: blobR.mesh,
    body: blobBody.mesh,
    matL: blobL.mat,
    matR: blobR.mat,
    matBody: blobBody.mat,
  }

  // ── 몸통 트리 ──
  const body = new three.Group()
  root.add(body)

  // 골반(쇼츠) — 몸통이 숙여도 허리 이음새가 벌어지지 않게 덮는다
  const pelvis = new three.Mesh(
    cachedGeo('pelvis', () => new three.CapsuleGeometry(0.135, 0.1, 3, 10)),
    shortsMat,
  )
  pelvis.position.y = HIP_Y + 0.02
  pelvis.scale.set(0.85, 1, 1.15)
  body.add(pelvis)

  const torso = new three.Group()
  torso.position.y = HIP_Y
  body.add(torso)

  const chest = new three.Mesh(
    cachedGeo('chest', () => new three.CapsuleGeometry(0.155, 0.3, 3, 10)),
    torsoMat,
  )
  chest.position.y = 0.3
  chest.scale.set(0.78, 1, 1.24) // 앞뒤로 얇고 어깨로 넓은 단면
  torso.add(chest)

  // ── 등번호·가슴번호 ──
  // 아웃라인은 글자색의 반대편에서 고른다. kitInk가 따뜻한 킷에 아이보리를 주므로
  // `=== 0xffffff` 비교로는 아이보리 글자에 흰 아웃라인이 붙어 사라진다.
  const outline = luminance(ink) > 0.5 ? deep : 0xf2f5ff
  const numTex = numberTexture(three, opts.number, ink, outline)
  const numMat = numTex
    ? cachedMat(
        `num:${opts.number}:${ink}:${shirt}`,
        () =>
          new three.MeshBasicMaterial({
            map: numTex,
            transparent: false,
            alphaTest: 0.42,
            side: three.DoubleSide,
          }),
      )
    : cachedMat(`numflat:${ink}`, () => new three.MeshBasicMaterial({ color: ink }))
  /**
   * 번호 평면을 몸통 표면 바로 밖에 붙인다.
   * @param sign +1 = 가슴(정면 +X), -1 = 등(-X)
   *
   * 평면 법선은 로컬 +Z이고, rotation.y = sign·π/2가 그것을 ±X로 보낸다. 이때 평면의
   * 로컬 +X는 ∓Z로 가는데, 그 면을 보는 시점의 화면 오른쪽이 정확히 ∓Z라서 글자가
   * 좌우 반전되지 않는다(정면·후면 모두 성립).
   *
   * 왜 텍스처 아틀라스가 아니라 평면인가: 캡슐 UV에 번호를 그리면 선수마다 몸통 텍스처가
   * 하나씩 필요해 22장이 된다. 번호만 평면으로 떼면 몸통 텍스처는 팀당 1장(총 3~4장)이고,
   * 번호 텍스처는 이미 있는 번호별 캐시를 그대로 쓴다.
   */
  const addNumber = (sign: 1 | -1, size: number, y: number): void => {
    const plane = new three.Mesh(
      cachedGeo(`numplane:${size}`, () => new three.PlaneGeometry(size, size)),
      numMat,
    )
    plane.position.set(sign * 0.125, y, 0)
    plane.rotation.y = (sign * Math.PI) / 2
    torso.add(plane)
  }
  addNumber(-1, 0.26, 0.33)
  // 가슴번호는 참조 킷에 있고 우리에겐 없었다. 등번호보다 작게(실제 유니폼 관례) 두고
  // 조금 위에 놓아 반바지 경계와 겹치지 않게 한다.
  addNumber(1, 0.19, 0.36)

  const neck = new three.Mesh(
    cachedGeo('neck', () => new three.CylinderGeometry(0.045, 0.052, 0.09, 8)),
    skinMat,
  )
  neck.position.y = SHOULDER_Y + 0.06
  torso.add(neck)

  const head = new three.Group()
  head.position.y = SHOULDER_Y + 0.11
  torso.add(head)

  const skull = new three.Mesh(
    cachedGeo('skull', () => new three.SphereGeometry(0.115, 14, 10)),
    skinMat,
  )
  skull.position.y = 0.1
  skull.scale.set(1.08, 1.1, 0.94)
  head.add(skull)

  const hairCap = new three.Mesh(
    cachedGeo('hair', () => new three.SphereGeometry(0.121, 14, 8, 0, TAU, 0, Math.PI * 0.58)),
    hairMat,
  )
  hairCap.position.y = 0.1
  hairCap.scale.set(1.06, 1.12, 0.98)
  hairCap.rotation.z = 0.12 // 앞머리가 살짝 내려온다
  head.add(hairCap)

  // ── 팔: 숄더 → 상완(소매) → 엘보 → 하완(스킨) → 손 ──
  const buildArm = (sign: number) => {
    const shoulder = new three.Group()
    shoulder.position.set(0, SHOULDER_Y, sign * ARM_Z)
    torso.add(shoulder)
    shoulder.add(limbMesh(three, 'upperarm', 0.052, UPPER_ARM, sleeveMat))
    const elbow = new three.Group()
    elbow.position.y = -UPPER_ARM
    shoulder.add(elbow)
    elbow.add(limbMesh(three, 'forearm', 0.044, FOREARM, skinMat))
    const hand = new three.Mesh(
      cachedGeo('hand', () => new three.SphereGeometry(0.055, 8, 6)),
      handMat,
    )
    hand.position.y = -FOREARM - 0.01
    hand.scale.set(0.9, 1.05, 0.75)
    elbow.add(hand)
    return { shoulder, elbow }
  }
  // 정면 +X, 위 +Y ⇒ 해부학적 왼쪽 = up × forward = **-Z**, 오른쪽 = +Z
  const armL = buildArm(-1)
  const armR = buildArm(1)

  // ── 다리: 힙 → 허벅지(+쇼츠) → 무릎 → 정강이(양말) → 신발 ──
  const buildLeg = (sign: number) => {
    const hip = new three.Group()
    hip.position.set(0, HIP_Y, sign * LEG_Z)
    body.add(hip)
    hip.add(limbMesh(three, 'thigh', 0.078, THIGH_LEN, skinMat))
    const shortLeg = limbMesh(three, 'shortleg', 0.095, 0.2, shortsMat)
    shortLeg.position.y = -0.08 // 허벅지 위쪽을 덮는 쇼츠 자락
    hip.add(shortLeg)
    const knee = new three.Group()
    knee.position.y = -THIGH_LEN
    hip.add(knee)
    knee.add(limbMesh(three, 'shin', 0.062, SHIN_LEN, socksMat)) // 정강이 = 양말(액센트)
    // 발목 관절 — 접지 중 발바닥을 지면과 평행하게 유지하려면 정강이와 별도 자유도가 필요하다.
    // (정강이에 고정된 발은 디딤 중 발끝·뒤꿈치가 번갈아 지면을 파고들며 접지점이 흔들린다.)
    const ankle = new three.Group()
    ankle.position.y = -SHIN_LEN
    knee.add(ankle)
    const boot = new three.Mesh(
      cachedGeo('boot', () => new three.BoxGeometry(0.25, 0.07, 0.115)),
      bootMat,
    )
    // 부츠 바닥 = 발목 -0.04 ⇒ ANKLE_H와 일치해야 접지 계산이 맞는다.
    boot.position.set(0.048, -0.005, 0)
    ankle.add(boot)
    return { hip, knee, ankle }
  }
  const legL = buildLeg(-1)
  const legR = buildLeg(1)

  const joints: Joints = {
    body,
    torso,
    head,
    hipL: legL.hip,
    hipR: legR.hip,
    kneeL: legL.knee,
    kneeR: legR.knee,
    ankleL: legL.ankle,
    ankleR: legR.ankle,
    shoulderL: armL.shoulder,
    shoulderR: armR.shoulder,
    elbowL: armL.elbow,
    elbowR: armR.elbow,
    shadows,
  }

  // ── 애니메이션 상태(전부 결정론) ──
  let phase = 0
  let smoothSpeed = 0
  let lastT = -1
  let seeded = false
  let seed = vary
  let kickRight = true
  let diveDir = 1

  let prevAction: PlayerPose['action'] | null = null
  let prevAt = 0
  let blendLeft = 0

  /** 이번 프레임의 목표 포즈(액션이 계산해 채운다). */
  const pose: RigPose = {
    bodyY: 0,
    bodyRoll: 0,
    torsoRoll: 0,
    torsoPitch: 0,
    torsoTwist: 0,
    hipL: 0,
    hipR: 0,
    kneeL: 0,
    kneeR: 0,
    ankleL: 0,
    ankleR: 0,
    shoulderL: 0,
    shoulderR: 0,
    armOutL: 0.12,
    armOutR: 0.12,
    elbowL: 0.2,
    elbowR: 0.2,
    headPitch: 0,
    headYaw: 0,
    shadowScale: 1,
  }
  /** 실제로 리그에 써넣는 포즈(목표를 향해 크로스페이드된 값). */
  const shown: RigPose = { ...pose }

  function applyGait(speed: number): void {
    const g = gaitAngles(speed, phase, root.scale.x)
    pose.bodyY = g.bounce
    pose.bodyRoll = 0 // 보행 롤은 상체에만 — 다리를 기울이면 디딤발이 뜬다
    pose.torsoRoll = g.roll
    pose.torsoPitch = g.lean
    pose.torsoTwist = g.twist
    pose.hipL = g.hipL
    pose.hipR = g.hipR
    pose.kneeL = g.kneeL
    pose.kneeR = g.kneeR
    pose.ankleL = g.ankleL
    pose.ankleR = g.ankleR
    pose.shoulderL = g.shoulderL
    pose.shoulderR = g.shoulderR
    pose.elbowL = g.elbowL
    pose.elbowR = g.elbowR
    pose.armOutL = 0.1 + 0.13 * clamp01(speed / SPRINT_SPEED)
    pose.armOutR = pose.armOutL
    pose.headPitch = -0.55 * g.lean // 몸이 숙어도 시선은 앞을 본다
    pose.headYaw = 0
    // 체공(bob)이 클수록 그림자를 줄인다. bounce는 이제 음수 구간이라 bob을 쓴다.
    pose.shadowScale = 1 - 2.2 * g.bob
  }

  /** 한쪽 발을 지면(y=0)에 붙인 채 전후 fx에 놓는 힙·무릎·발목. 정지 계열 액션 공용. */
  function plantLeg(fx: number, bodyY: number): { hip: number; knee: number; ankle: number } {
    const { hip, knee } = solveLeg(fx, STAND_DROP + bodyY)
    return { hip, knee, ankle: -(hip + knee) }
  }

  function apply(p: PlayerPose, clockT: number): void {
    if (!seeded) {
      seed = hash01(p.id)
      phase = seed * TAU // 22명이 한 몸처럼 움직이지 않게 초기 위상 분산
      kickRight = seed < 0.78 // 결정론적 주발(약 22%가 왼발잡이)
      diveDir = hash01(`${p.id}:dive`) < 0.5 ? -1 : 1 // actionDir가 없을 때만 쓰는 폴백
      root.scale.setScalar(0.965 + 0.07 * seed) // 체격 미세 변주
      smoothSpeed = p.speed // 등장 프레임부터 실제 속도로 시작(초기 슬로모션 방지)
      seeded = true
    }
    const dt = lastT < 0 ? 0 : clamp(clockT - lastT, 0, 0.1)
    lastT = clockT

    // 급가감속에서도 사이클이 튀지 않게 속도를 완만히 따라간다
    smoothSpeed += (p.speed - smoothSpeed) * Math.min(1, dt * 7)
    // 보폭 위상은 **movement(두뇌)가 계산한 값을 그대로 소비**한다. 표시 계층이 자체
    // 적분하면 두 보폭 모델이 어긋나 그 차이가 그대로 발 미끄러짐이 된다.
    // gaitPhase가 없는 호출(단위 테스트·구버전 프레임)만 같은 strideLength로 폴백한다.
    // 어느 경로든 위상은 **모든 액션에서** 계속 진행한다 — 킥·세리머니 중에 멈춰 있으면
    // 러닝으로 복귀할 때 정지 위상에서 재개돼 다리가 튄다.
    phase =
      p.gaitPhase != null && Number.isFinite(p.gaitPhase)
        ? (((p.gaitPhase % 1) + 1) % 1) * TAU
        : advancePhase(phase, Math.max(smoothSpeed, p.speed * 0.6), dt)
    const t = clockT + seed * 6.28 // 개체별 시간 오프셋(호흡·세리머니 위상 분산)
    const at = clamp01(p.actionT)
    // 다이브 방향은 **볼이 향하는 쪽**을 무브먼트가 정한다(types.PlayerPose.actionDir).
    // 해시 폴백은 그 값이 없는 구버전 프레임·단위 테스트 전용이다.
    if (p.actionDir) diveDir = p.actionDir > 0 ? 1 : -1

    root.position.set(p.x, 0, p.z)
    root.rotation.y = -p.yaw

    switch (p.action) {
      case 'run': {
        applyGait(smoothSpeed)
        break
      }
      case 'kick': {
        applyGait(smoothSpeed * 0.35) // 팔·상체 기본값을 먼저 깔고 킥으로 덮는다
        const k = kickAngles(at)
        // 디딤 다리는 접지 IK로 푼다 — 하중이 실릴수록 살짝 앞·아래로 눌린다.
        const bodyY = -0.014 * k.plant
        const sup = plantLeg(0.1 * k.plant, bodyY)
        if (kickRight) {
          pose.hipR = k.hipKick
          pose.kneeR = k.kneeKick
          pose.ankleR = 0 // 차는 발은 정강이와 일직선(임팩트 면을 만든다)
          pose.hipL = sup.hip
          pose.kneeL = sup.knee
          pose.ankleL = sup.ankle
          pose.shoulderL = k.armSwing
          pose.shoulderR = -0.35 * k.armSwing
        } else {
          pose.hipL = k.hipKick
          pose.kneeL = k.kneeKick
          pose.ankleL = 0
          pose.hipR = sup.hip
          pose.kneeR = sup.knee
          pose.ankleR = sup.ankle
          pose.shoulderR = k.armSwing
          pose.shoulderL = -0.35 * k.armSwing
        }
        pose.torsoPitch = k.torsoLean
        pose.torsoTwist = (kickRight ? -1 : 1) * 0.25 * k.armSwing
        pose.armOutL = 0.34
        pose.armOutR = 0.34
        pose.elbowL = 0.5
        pose.elbowR = 0.5
        pose.bodyY = bodyY
        pose.bodyRoll = 0
        pose.torsoRoll = (kickRight ? 1 : -1) * 0.12 * Math.sin(Math.PI * at)
        pose.headPitch = 0.16
        pose.headYaw = 0
        pose.shadowScale = 1
        break
      }
      case 'celebrate': {
        const c = celebrateOffset(t)
        const air = c.jump / CELEBRATE_JUMP
        const wave = Math.sin(t * 7.5)
        pose.bodyY = c.jump
        pose.bodyRoll = 0
        pose.torsoRoll = 0.05 * wave
        pose.torsoPitch = c.lean
        pose.torsoTwist = 0.12 * wave
        // 착지 순간(air=0)에는 두 발이 정확히 지면에 붙고, 뜰수록 다리를 접는다.
        const cl = plantLeg(0.06, 0)
        const cr = plantLeg(-0.06, 0)
        pose.hipL = cl.hip + 0.35 * air
        pose.hipR = cr.hip + 0.2 * air
        pose.kneeL = cl.knee - 0.7 * air
        pose.kneeR = cr.knee - 0.45 * air
        pose.ankleL = cl.ankle * (1 - air)
        pose.ankleR = cr.ankle * (1 - air)
        // 두 팔을 머리 위로(2.6rad ≈ 149° → 위·앞을 가리킨다)
        pose.shoulderL = 2.6 * c.arm
        pose.shoulderR = 2.6 * c.arm
        pose.armOutL = 0.45 + 0.15 * wave
        pose.armOutR = 0.45 - 0.15 * wave
        pose.elbowL = 0.25
        pose.elbowR = 0.25
        pose.headPitch = -0.25
        pose.headYaw = 0.2 * wave
        pose.shadowScale = clamp(1 - 1.4 * air, 0.35, 1)
        break
      }
      case 'dive': {
        const d = diveAngles(at, diveDir)
        // roll>0이면 로컬 +Z(=오른쪽)가 아래로 깔린다. 아래/위 쪽 팔다리 값을 diveDir로
        // 미러링해야 양방향 다이브의 지면 클리어런스가 같아진다(비대칭 관통 방지).
        const rightDown = diveDir > 0
        const pick = (down: number, up: number): [number, number] =>
          rightDown ? [up, down] : [down, up]
        const [hipL, hipR] = pick(-0.15, 0.25 - 0.3 * d.tuck)
        const [kneeL, kneeR] = pick(-0.2 + 0.5 * d.tuck, d.tuck)
        const [shL, shR] = pick(d.armReach * 0.75, d.armReach)
        // 옆으로 누우면 시상면이 지면과 평행해진다 → 팔은 벌리지 않아야(=몸 옆으로
        // 처지지 않아야) 공을 향해 뻗은 모양이 되고 잔디를 파고들지 않는다
        const [outL, outR] = pick(0.03, 0.05)
        const [elL, elR] = pick(0.25, 0.1)
        pose.bodyY = d.lift
        pose.bodyRoll = d.roll // 다이브는 다리까지 함께 눕는다
        pose.torsoRoll = 0
        pose.torsoPitch = 0.12
        pose.torsoTwist = 0.18 * diveDir
        pose.hipL = hipL
        pose.hipR = hipR
        pose.kneeL = kneeL
        pose.kneeR = kneeR
        // 도약 직전에는 아직 서 있으므로 발바닥을 지면과 평행하게 두고(그러지 않으면
        // 부츠 앞코가 잔디를 파고든다), 몸이 눕는 만큼 정강이와 일직선으로 편다.
        const flat = 1 - clamp01(at / 0.4)
        pose.ankleL = -(hipL + kneeL) * flat
        pose.ankleR = -(hipR + kneeR) * flat
        pose.shoulderL = shL
        pose.shoulderR = shR
        pose.armOutL = outL
        pose.armOutR = outR
        pose.elbowL = elL
        pose.elbowR = elR
        pose.headPitch = -0.2
        pose.headYaw = 0
        pose.shadowScale = clamp(1 - 1.1 * d.lift, 0.4, 1)
        break
      }
      case 'down': {
        // 부상·넘어짐 — 다이브 종료 자세로 누운 채 미세하게 움직인다
        const d = diveAngles(1, diveDir)
        const breath = Math.sin(t * 1.9)
        const rightDown = diveDir > 0
        const pick = (down: number, up: number): [number, number] =>
          rightDown ? [up, down] : [down, up]
        const [hipL, hipR] = pick(0.2, 0.45)
        const [kneeL, kneeR] = pick(-0.5, -0.9)
        const [shL, shR] = pick(0.3, -0.7 + 0.1 * breath)
        const [outL, outR] = pick(0.06, 0.12)
        const [elL, elR] = pick(0.4, 0.9)
        pose.bodyY = d.lift
        pose.bodyRoll = d.roll
        pose.torsoRoll = 0
        pose.torsoPitch = 0.1 + 0.03 * breath
        pose.torsoTwist = 0.1 * diveDir
        pose.hipL = hipL
        pose.hipR = hipR
        pose.kneeL = kneeL
        pose.kneeR = kneeR
        pose.ankleL = 0
        pose.ankleR = 0
        pose.shoulderL = shL
        pose.shoulderR = shR
        pose.armOutL = outL
        pose.armOutR = outR
        pose.elbowL = elL
        pose.elbowR = elR
        pose.headPitch = -0.15
        pose.headYaw = 0
        pose.shadowScale = 1.05
        break
      }
      default: {
        // idle — 미세 호흡 + 좌우 체중 이동
        const breath = Math.sin(t * 1.85)
        const shift = Math.sin(t * 0.62)
        // 선 자세는 러닝보다 골반이 높다(무릎이 거의 펴진다). LEG_REACH를 넘지 않는
        // 한도(=STAND_DROP + 0.025) 안에서만 올려야 발이 지면에서 뜨지 않는다.
        const bodyY = 0.018 + 0.005 * breath
        const il = plantLeg(0.06 + 0.03 * shift, bodyY)
        const ir = plantLeg(-0.06 - 0.03 * shift, bodyY)
        pose.bodyY = bodyY
        pose.bodyRoll = 0
        pose.torsoRoll = 0.025 * shift
        pose.torsoPitch = 0.045 + 0.012 * breath
        pose.torsoTwist = 0.03 * shift
        pose.hipL = il.hip
        pose.hipR = ir.hip
        pose.kneeL = il.knee
        pose.kneeR = ir.knee
        pose.ankleL = il.ankle
        pose.ankleR = ir.ankle
        pose.shoulderL = 0.03 + 0.02 * breath
        pose.shoulderR = 0.03 - 0.02 * breath
        pose.armOutL = 0.13 + 0.02 * breath
        pose.armOutR = 0.13 + 0.02 * breath
        pose.elbowL = 0.22 + 0.03 * breath
        pose.elbowR = 0.22 - 0.03 * breath
        pose.headPitch = -0.02
        pose.headYaw = 0.16 * Math.sin(t * 0.43)
        pose.shadowScale = 1
        break
      }
    }

    // 액션이 바뀌거나 **같은 액션이 재발동**(actionT가 되감김)하면 크로스페이드.
    // 재발동 가드가 없으면 종료 자세(누운 다이브 등)에서 시작 자세로 2.2rad 튄다.
    // 첫 프레임은 스냅(prevAction === null).
    if (prevAction !== null && (p.action !== prevAction || at < prevAt - 0.2)) blendLeft = BLEND_TIME
    prevAction = p.action
    prevAt = at
    if (blendLeft > 0) {
      blendLeft = Math.max(0, blendLeft - dt)
      // 시상수를 남은 시간에 비례해 줄이면 페이드 끝에서 통과(k→1)로 매끄럽게 수렴한다
      const tau = BLEND_TAU * (blendLeft / BLEND_TIME)
      blendPose(shown, pose, tau > 1e-4 ? 1 - Math.exp(-dt / tau) : 1)
    } else {
      copyPose(shown, pose)
    }
    writePose(joints, shown)
  }

  /**
   * 인스턴스 해제. 지오메트리·머티리얼·텍스처는 **공유 캐시** 소유이므로 여기서
   * dispose하지 않는다(다른 21명이 같은 자원을 쓴다). 전체 해제는 disposePlayerCaches().
   */
  function dispose(): void {
    root.parent?.remove(root)
    root.clear()
    body.clear()
    torso.clear()
    // 그림자 머티리얼만은 **이 인스턴스 소유**다(발 높이별 불투명도 때문에 공유 불가).
    // 공유 캐시에 없으므로 disposePlayerCaches()가 회수해 주지 않는다 — 여기서 해제한다.
    shadows.matL.dispose()
    shadows.matR.dispose()
    shadows.matBody.dispose()
  }

  return { root, apply, dispose }
}

/**
 * 모듈 공유 캐시(지오메트리·머티리얼·텍스처) 전체 해제.
 * 3D 뷰를 완전히 내릴 때만 호출한다(개별 dispose()는 캐시를 건드리지 않는다).
 */
export function disposePlayerCaches(): void {
  for (const g of geoCache.values()) g.dispose()
  for (const m of matCache.values()) m.dispose()
  for (const t of texCache.values()) t?.dispose()
  geoCache.clear()
  matCache.clear()
  texCache.clear()
}
