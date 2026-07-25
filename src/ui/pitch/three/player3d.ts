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

/** 주입되는 three 네임스페이스 타입(정적 import가 아니므로 번들에 포함되지 않는다). */
type ThreeNS = typeof import('three')

// ─────────────────────────────────────────────────────────────────────────────
// 순수 포즈 수학 (three 무의존 — 단위 테스트 대상)
// ─────────────────────────────────────────────────────────────────────────────

export const TAU = Math.PI * 2

/** 최대 진폭 기준 속도(m/s). 이 이상은 포화된다. */
export const SPRINT_SPEED = 8

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1)
}

/** 0→0, 1→1의 부드러운 S 커브(양끝 도함수 0). */
function smoothstep(t: number): number {
  const u = clamp01(t)
  return u * u * (3 - 2 * u)
}

/** FNV-1a 32bit 문자열 해시 → [0, 1). 결정론(랜덤·시간 미사용). */
export function hash01(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

/** 0xRRGGBB 채널별 배율(0~255 클램프). f<1 어둡게, f>1 밝게. */
export function shade(color: number, f: number): number {
  const r = clamp(Math.round(((color >> 16) & 255) * f), 0, 255)
  const g = clamp(Math.round(((color >> 8) & 255) * f), 0, 255)
  const b = clamp(Math.round((color & 255) * f), 0, 255)
  return (r << 16) | (g << 8) | b
}

/** 두 색의 채널별 선형 보간(t=0 → a, t=1 → b). */
export function mixColor(a: number, b: number, t: number): number {
  const u = clamp01(t)
  const ch = (sh: number): number => {
    const av = (a >> sh) & 255
    const bv = (b >> sh) & 255
    return clamp(Math.round(av + (bv - av) * u), 0, 255)
  }
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** 상대 휘도(0~1, Rec.709 근사) — 등번호 대비 판정용. */
export function luminance(color: number): number {
  const r = ((color >> 16) & 255) / 255
  const g = ((color >> 8) & 255) / 255
  const b = (color & 255) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 배경색 위에서 가장 잘 읽히는 글자색(흰색 또는 잉크블랙). */
export function contrastOn(color: number): number {
  return luminance(color) > 0.45 ? 0x14181f : 0xffffff
}

// ── 러닝 사이클 ───────────────────────────────────────────────────────────────

/** 한 스트라이드(=2보, 위상 0→2π) 동안의 관절 각(rad)과 몸통 오프셋. */
export interface GaitAngles {
  /** 힙 스윙(양수 = 다리가 앞으로) */
  hipL: number
  hipR: number
  /** 무릎(음수 = 굴곡, 정강이가 뒤로) */
  kneeL: number
  kneeR: number
  /** 어깨 스윙(양수 = 팔이 앞으로) — 같은 쪽 다리와 교차한다 */
  shoulderL: number
  shoulderR: number
  /** 팔꿈치(양수 = 굴곡, 하완이 앞으로) */
  elbowL: number
  elbowR: number
  /** 골반 상하 바운스(m, 부호 있음) */
  bounce: number
  /** 전경 기울기(rad, 양수 = 앞으로 숙임) — 속도 비례 */
  lean: number
  /** 몸통 좌우 롤(rad) */
  roll: number
  /** 어깨-골반 반대 비틀기(rad) */
  twist: number
}

const GAIT_FLOOR = 0.18 // 속도 0에서도 남는 최소 진폭(제자리 걸음이 얼어붙지 않게)
const HIP_BIAS = 0.1 // 달릴수록 힙이 살짝 앞으로 눌린다
const KNEE_BASE = 0.14
const KNEE_SWING = 1.35 // 유각기(스윙) 무릎 굴곡
const KNEE_STANCE = 0.22 // 입각기(디딤) 충격 흡수
const ARM_AMP = 0.62
const ELBOW_BASE = 0.28
const ELBOW_MID = 0.75
const ELBOW_AMP = 0.35
const BOUNCE_AMP = 0.052
const LEAN_MAX = 0.3
const ROLL_AMP = 0.075
const TWIST_AMP = 0.16

/**
 * 힙 스윙 진폭(rad). **보폭에 연동**한다 — 접지 중 발이 몸통 대비 정확히 -v로 흘러야
 * 발이 미끄러지지 않는다. 발의 최대 상대 속도 ≈ L·A·ω, ω = 2πv/stride 이므로
 * A = stride / (2π·L). 속도와 무관한 상수 진폭을 쓰면 저속·고속 양쪽에서 미끄러진다.
 *
 * LEG_EFF는 실측 튜닝값(무릎 굴곡이 발 궤적에 더해지므로 기하학적 다리 길이 0.86보다
 * 크다). 이 값에서 접지 슬립: v=2 4.3% / v=3 2.8% / v=5 1.1% / v=8 1.2%.
 * (0.80이면 v=8에서 9.4%, 1.00이면 12.9%로 나빠진다.)
 */
const LEG_EFF = 0.87
function hipAmplitude(sp: number): number {
  return strideLength(sp) / (TAU * LEG_EFF)
}

/** 한쪽 다리의 힙·무릎 — 반대쪽은 같은 식에 phase+π를 넣는다(정확한 반대 위상). */
function legAngles(
  hipAmp: number,
  amp: number,
  eff: number,
  phase: number,
): { hip: number; knee: number } {
  const s = Math.sin(phase)
  const c = Math.cos(phase)
  // swing: phase=0에서 1(유각 중간 — 발을 접어 끌어올린다), phase=π(입각 중간)에서 0
  const swing = 0.5 + 0.5 * c
  const stance = 0.5 - 0.5 * c
  return {
    hip: hipAmp * s + HIP_BIAS * eff,
    // 세제곱으로 유각 중간에만 크게 굽힌다(디딤발은 거의 편 상태를 유지 → 크라우칭 방지)
    knee: -(KNEE_BASE + KNEE_SWING * amp * swing * swing * swing + KNEE_STANCE * amp * stance),
  }
}

/** 한쪽 팔의 어깨·팔꿈치 — 같은 쪽 다리와 반대 위상(교차 스윙). */
function armAngles(amp: number, phase: number): { shoulder: number; elbow: number } {
  const s = Math.sin(phase)
  return {
    shoulder: -ARM_AMP * amp * s,
    elbow: ELBOW_BASE + amp * (ELBOW_MID + ELBOW_AMP * -s), // 팔이 앞으로 올 때 더 접힌다
  }
}

/**
 * 러닝/워킹 한 프레임의 전신 각도. 결정론 순수 함수.
 * @param speed m/s (0 이하는 0, SPRINT_SPEED 이상은 포화)
 * @param phase 누적 위상(rad) — advancePhase()로 적분한 값
 */
export function gaitAngles(speed: number, phase: number): GaitAngles {
  const sp = clamp(speed, 0, SPRINT_SPEED)
  const eff = sp / SPRINT_SPEED
  const amp = GAIT_FLOOR + (1 - GAIT_FLOOR) * eff
  const hipAmp = hipAmplitude(sp)
  const opp = phase + Math.PI

  const l = legAngles(hipAmp, amp, eff, phase)
  const r = legAngles(hipAmp, amp, eff, opp)
  const al = armAngles(amp, phase)
  const ar = armAngles(amp, opp)

  return {
    hipL: l.hip,
    hipR: r.hip,
    kneeL: l.knee,
    kneeR: r.knee,
    shoulderL: al.shoulder,
    shoulderR: ar.shoulder,
    elbowL: al.elbow,
    elbowR: ar.elbow,
    // 한 스트라이드에 두 번(보마다). 디딤 중간(phase 0·π)에서 0, 체공에서 최대.
    // 음수로 내려가지 않게 해 발이 잔디를 파고들지 않는다.
    bounce: BOUNCE_AMP * amp * (0.5 - 0.5 * Math.cos(2 * phase)),
    lean: LEAN_MAX * (0.25 * eff + 0.75 * eff * eff),
    roll: ROLL_AMP * amp * Math.sin(phase),
    twist: TWIST_AMP * amp * Math.sin(phase),
  }
}

/** 한 스트라이드(2보)에 나아가는 거리(m). 빠를수록 보폭이 길어져 케이던스가 폭주하지 않는다. */
export function strideLength(speed: number): number {
  return 1.1 + 0.28 * clamp(speed, 0, 12)
}

/** 정지에 가까워도 다리가 완전히 멈추지 않도록 하는 최소 보행 속도(m/s). */
const MIN_GAIT_SPEED = 0.35

/**
 * 누적 거리 기반 위상 적분 — 프레임 dt가 흔들려도 걸음 속도가 일정하다.
 * dt는 0~0.1s로 클램프(탭 비활성 복귀 시 위상 점프 방지). 결과는 [0, TAU).
 */
export function advancePhase(phase: number, speed: number, dt: number): number {
  const v = Math.max(speed, MIN_GAIT_SPEED)
  const strides = (v * clamp(dt, 0, 0.1)) / strideLength(speed)
  const next = (phase + strides * TAU) % TAU
  return next < 0 ? next + TAU : next
}

// ── 슈팅 ─────────────────────────────────────────────────────────────────────

/** 킥 한 프레임(rad) — 차는 다리 / 디딤 다리 / 상체 반동. */
export interface KickAngles {
  /** 차는 다리 힙(양수 = 앞) */
  hipKick: number
  /** 차는 다리 무릎(음수 = 굴곡) */
  kneeKick: number
  hipSupport: number
  kneeSupport: number
  /** 상체(양수 = 앞으로 숙임, 음수 = 뒤로 젖힘) */
  torsoLean: number
  /** 반대편 팔 균형 스윙 */
  armSwing: number
}

const KICK_BACK_T = 0.32 // 백스윙 완료
const KICK_PEAK_T = 0.58 // 임팩트 직후 팔로스루 정점
const KICK_BACK = 0.85
const KICK_FWD = 1.2
const KICK_KNEE_BACK = 1.17 // = 0.12 + 1.05 (백스윙 끝 무릎 굴곡)

/**
 * 백스윙(0~0.32) → 임팩트 스윙(0.32~0.58) → 팔로스루 회복(0.58~1).
 * t는 0~1로 클램프되며 양끝이 중립에 가까워 러닝 사이클과 자연스럽게 이어진다.
 */
export function kickAngles(t: number): KickAngles {
  const u = clamp01(t)
  let hipKick: number
  let kneeKick: number
  let torsoLean: number
  let armSwing: number

  if (u <= KICK_BACK_T) {
    const p = smoothstep(u / KICK_BACK_T)
    hipKick = -KICK_BACK * p
    kneeKick = -(0.12 + 1.05 * p)
    torsoLean = -0.16 * p
    armSwing = -0.25 * p
  } else if (u <= KICK_PEAK_T) {
    const p = smoothstep((u - KICK_BACK_T) / (KICK_PEAK_T - KICK_BACK_T))
    hipKick = -KICK_BACK + (KICK_FWD + KICK_BACK) * p
    kneeKick = -KICK_KNEE_BACK + (KICK_KNEE_BACK - 0.06) * p // 임팩트에서 채찍처럼 편다
    torsoLean = -0.16 + 0.38 * p
    armSwing = -0.25 + 1.2 * p
  } else {
    const p = smoothstep((u - KICK_PEAK_T) / (1 - KICK_PEAK_T))
    hipKick = KICK_FWD * (1 - p)
    kneeKick = -0.06 - 0.1 * p
    torsoLean = 0.22 * (1 - p)
    armSwing = 0.95 * (1 - p)
  }

  const plant = Math.sin(Math.PI * u) // 디딤발 하중(0 → 1 → 0)
  return {
    hipKick,
    kneeKick,
    hipSupport: 0.14 * plant,
    kneeSupport: -(0.18 + 0.3 * plant),
    torsoLean,
    armSwing,
  }
}

// ── 세리머니 ─────────────────────────────────────────────────────────────────

/** 세리머니 점프 주기(초). */
export const CELEBRATE_PERIOD = 0.8
/** 세리머니 점프 최고 높이(m). */
export const CELEBRATE_JUMP = 0.34

export interface CelebratePose {
  /** 지면 위 높이(m) — 항상 ≥ 0 */
  jump: number
  /** 팔 올림 계수 0~1 */
  arm: number
  /** 상체 젖힘(음수 = 뒤로) */
  lean: number
}

/** 두 팔을 들고 반복 점프. t는 초 단위 연속 시간(음수도 안전). */
export function celebrateOffset(t: number): CelebratePose {
  const ph = (Math.PI * t) / CELEBRATE_PERIOD
  return {
    // |sin| → 착지 순간이 뾰족해 "통통 뛰는" 느낌이 난다
    jump: CELEBRATE_JUMP * Math.abs(Math.sin(ph)),
    arm: 0.75 + 0.2 * Math.sin(2 * ph),
    lean: -0.1 - 0.06 * Math.cos(2 * ph),
  }
}

// ── GK 다이브 ────────────────────────────────────────────────────────────────

export interface DiveAngles {
  /** 몸통 롤(rad) — dir 부호를 따르고 |roll| ≤ π/2 */
  roll: number
  /** 몸통 상승(m) — 체공 아크 + 옆으로 누웠을 때의 몸통 두께 보정 */
  lift: number
  /** 팔 뻗기(음수 = 머리 위로) */
  armReach: number
  /** 다리 접기(음수 = 굴곡) */
  tuck: number
}

const DIVE_ARC = 0.55
// 옆으로 누우면 어깨·팔(로컬 z ±0.195)과 손이 아래로 내려온다. 그 반폭만큼 띄워야
// 몸이 잔디를 파고들지 않는다(실측: 이 값에서 최대 관통 3cm 이하).
const DIVE_GROUND = 0.35

/** 도약 → 체공 → 옆으로 눕기. t는 0~1 클램프, dir는 ±1(0이면 +1). */
export function diveAngles(t: number, dir: number): DiveAngles {
  const u = clamp01(t)
  const s = Math.sign(dir) || 1
  const lay = smoothstep(u / 0.55)
  return {
    roll: s * (Math.PI / 2) * lay,
    lift: DIVE_ARC * Math.sin(Math.PI * u) + DIVE_GROUND * lay,
    armReach: -2.2 * smoothstep(u / 0.5),
    tuck: -0.55 * smoothstep(u / 0.6),
  }
}

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

// 신체 치수(m) — 총신장 ≈ 1.80, 머리 지름 ≈ 0.23 ⇒ 약 7.8등신(7.5등신 근사)
const HIP_Y = 0.94
const THIGH_LEN = 0.44
const SHIN_LEN = 0.42
const SHOULDER_Y = 0.5 // 힙(몸통 피벗) 기준 어깨 높이 → 월드 1.44
const UPPER_ARM = 0.3
const FOREARM = 0.26
const LEG_Z = 0.1
const ARM_Z = 0.195

const SKIN_TONES = [0xf0c9a4, 0xe0ac7e, 0xc68642, 0xa2673f, 0x7c4a26]
const HAIR_TONES = [0x141010, 0x2b1d14, 0x0d0d10, 0x4a2f1a, 0x5d4030]
const GK_NEON = 0xd8ff3c // GK 형광 킷 베이스

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

/** 발밑 페이크 컨택트 섀도우용 방사형 그라디언트(실시간 그림자맵 대체). */
function shadowTexture(three: ThreeNS): Three.Texture | null {
  const hit = texCache.get('shadow')
  if (hit !== undefined) return hit
  let tex: Three.Texture | null = null
  try {
    if (typeof document === 'undefined') throw new Error('no document')
    const cv = document.createElement('canvas')
    cv.width = 64
    cv.height = 64
    const ctx = cv.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(0,0,0,0.55)')
    g.addColorStop(0.55, 'rgba(0,0,0,0.26)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
    const made = new three.CanvasTexture(cv)
    made.needsUpdate = true
    tex = made
  } catch {
    tex = null
  }
  texCache.set('shadow', tex)
  return tex
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

/** 리그의 모든 관절 그룹. */
interface Joints {
  body: Three.Group
  torso: Three.Group
  head: Three.Group
  hipL: Three.Group
  hipR: Three.Group
  kneeL: Three.Group
  kneeR: Three.Group
  shoulderL: Three.Group
  shoulderR: Three.Group
  elbowL: Three.Group
  elbowR: Three.Group
  shadow: Three.Mesh
}

/** 한 프레임의 최종 리그 포즈. 매 프레임 전 필드를 덮어써 이전 액션 포즈가 남지 않는다. */
interface RigPose {
  bodyY: number
  bodyRoll: number
  torsoPitch: number
  torsoTwist: number
  hipL: number
  hipR: number
  kneeL: number
  kneeR: number
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
  'torsoPitch',
  'torsoTwist',
  'hipL',
  'hipR',
  'kneeL',
  'kneeR',
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
  j.torso.rotation.z = -p.torsoPitch // 앞으로 숙이기 = -Z 회전
  j.torso.rotation.y = p.torsoTwist
  j.hipL.rotation.z = p.hipL
  j.hipR.rotation.z = p.hipR
  j.kneeL.rotation.z = p.kneeL
  j.kneeR.rotation.z = p.kneeR
  j.shoulderL.rotation.z = p.shoulderL
  j.shoulderR.rotation.z = p.shoulderR
  // 왼쪽은 -Z(정면 +X, 위 +Y ⇒ left = up×forward = -Z). -Z쪽 팔은 +X 회전이 바깥이다.
  j.shoulderL.rotation.x = p.armOutL
  j.shoulderR.rotation.x = -p.armOutR
  j.elbowL.rotation.z = p.elbowL
  j.elbowR.rotation.z = p.elbowR
  j.head.rotation.z = -p.headPitch
  j.head.rotation.y = p.headYaw
  j.shadow.scale.setScalar(p.shadowScale)
}

/**
 * 절차적 3D 선수 1명을 만든다. three는 주입받는다(정적 import 금지).
 * 반환된 root를 씬에 추가하고 매 프레임 apply(pose, clockT)를 호출한다.
 */
export function createPlayer(three: ThreeNS, opts: PlayerOptions): PlayerRig {
  const shirt = opts.isGk ? mixColor(GK_NEON, opts.accent, 0.28) : opts.kit
  const shorts = opts.isGk ? shade(shirt, 0.55) : shade(opts.kit, 0.62)
  const socks = opts.isGk ? shade(opts.accent, 0.85) : opts.accent
  const ink = contrastOn(shirt)

  // 개체 변주 시드: 생성 시점엔 id를 모르므로 등번호·킷으로, 첫 apply에서 id 해시로 교체.
  const vary = hash01(`${opts.number}|${opts.kit}|${opts.isGk ? 'gk' : 'fp'}`)
  const skin = SKIN_TONES[Math.floor(vary * SKIN_TONES.length) % SKIN_TONES.length]
  const hair = HAIR_TONES[Math.floor(vary * 977) % HAIR_TONES.length]

  const shirtMat = bodyMat(three, shirt)
  const shortsMat = bodyMat(three, shorts)
  const socksMat = bodyMat(three, socks)
  const skinMat = bodyMat(three, skin)
  const hairMat = bodyMat(three, hair)
  const bootMat = bodyMat(three, 0x14161c)
  // GK는 장갑(밝은 액센트), 필드 플레이어는 맨손
  const handMat = opts.isGk ? bodyMat(three, mixColor(0xf4f7ff, opts.accent, 0.22)) : skinMat

  const root = new three.Group()
  root.name = `player-${opts.number}`

  // ── 발밑 컨택트 섀도우(Task 2 의존 없이 자체 생성) ──
  const shTex = shadowTexture(three)
  const shadowMat = cachedMat(shTex ? 'shadow:tex' : 'shadow:flat', () =>
    shTex
      ? new three.MeshBasicMaterial({ map: shTex, transparent: true, depthWrite: false })
      : new three.MeshBasicMaterial({
          color: 0x000000,
          transparent: true,
          opacity: 0.26,
          depthWrite: false,
        }),
  )
  const shadowGeo = shTex
    ? cachedGeo('shadow:plane', () => new three.PlaneGeometry(1.05, 1.05))
    : cachedGeo('shadow:circle', () => new three.CircleGeometry(0.42, 18))
  const shadow = new three.Mesh(shadowGeo, shadowMat)
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.02
  shadow.renderOrder = 1
  root.add(shadow)

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
    shirtMat,
  )
  chest.position.y = 0.3
  chest.scale.set(0.78, 1, 1.24) // 앞뒤로 얇고 어깨로 넓은 단면
  torso.add(chest)

  // 등번호 평면(뒤 = -X). 로컬 +X가 월드 +Z를 향하도록 회전해야 글자가 뒤집히지 않는다.
  const numTex = numberTexture(three, opts.number, ink, ink === 0xffffff ? shade(shirt, 0.45) : 0xf2f5ff)
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
  const numPlane = new three.Mesh(
    cachedGeo('numplane', () => new three.PlaneGeometry(0.26, 0.26)),
    numMat,
  )
  numPlane.position.set(-0.125, 0.33, 0)
  numPlane.rotation.y = -Math.PI / 2
  torso.add(numPlane)

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
    shoulder.add(limbMesh(three, 'upperarm', 0.052, UPPER_ARM, shirtMat))
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
    const boot = new three.Mesh(
      cachedGeo('boot', () => new three.BoxGeometry(0.25, 0.07, 0.115)),
      bootMat,
    )
    boot.position.set(0.048, -SHIN_LEN - 0.005, 0)
    knee.add(boot)
    return { hip, knee }
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
    shoulderL: armL.shoulder,
    shoulderR: armR.shoulder,
    elbowL: armL.elbow,
    elbowR: armR.elbow,
    shadow,
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
    torsoPitch: 0,
    torsoTwist: 0,
    hipL: 0,
    hipR: 0,
    kneeL: 0,
    kneeR: 0,
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
    const g = gaitAngles(speed, phase)
    pose.bodyY = g.bounce
    pose.bodyRoll = g.roll
    pose.torsoPitch = g.lean
    pose.torsoTwist = g.twist
    pose.hipL = g.hipL
    pose.hipR = g.hipR
    pose.kneeL = g.kneeL
    pose.kneeR = g.kneeR
    pose.shoulderL = g.shoulderL
    pose.shoulderR = g.shoulderR
    pose.elbowL = g.elbowL
    pose.elbowR = g.elbowR
    pose.armOutL = 0.1 + 0.13 * clamp01(speed / SPRINT_SPEED)
    pose.armOutR = pose.armOutL
    pose.headPitch = -0.55 * g.lean // 몸이 숙어도 시선은 앞을 본다
    pose.headYaw = 0
    pose.shadowScale = 1 - 2.2 * Math.max(0, g.bounce)
  }

  function apply(p: PlayerPose, clockT: number): void {
    if (!seeded) {
      seed = hash01(p.id)
      phase = seed * TAU // 22명이 한 몸처럼 움직이지 않게 초기 위상 분산
      kickRight = seed < 0.78 // 결정론적 주발(약 22%가 왼발잡이)
      diveDir = hash01(`${p.id}:dive`) < 0.5 ? -1 : 1
      root.scale.setScalar(0.965 + 0.07 * seed) // 체격 미세 변주
      smoothSpeed = p.speed // 등장 프레임부터 실제 속도로 시작(초기 슬로모션 방지)
      seeded = true
    }
    const dt = lastT < 0 ? 0 : clamp(clockT - lastT, 0, 0.1)
    lastT = clockT

    // 급가감속에서도 사이클이 튀지 않게 속도를 완만히 따라간다
    smoothSpeed += (p.speed - smoothSpeed) * Math.min(1, dt * 7)
    // 위상은 **모든 액션에서** 계속 적분한다. 킥·세리머니 중에 멈춰 있으면
    // 러닝으로 복귀할 때 정지 위상에서 재개돼 다리가 튄다.
    phase = advancePhase(phase, Math.max(smoothSpeed, p.speed * 0.6), dt)
    const t = clockT + seed * 6.28 // 개체별 시간 오프셋(호흡·세리머니 위상 분산)
    const at = clamp01(p.actionT)

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
        if (kickRight) {
          pose.hipR = k.hipKick
          pose.kneeR = k.kneeKick
          pose.hipL = k.hipSupport
          pose.kneeL = k.kneeSupport
          pose.shoulderL = k.armSwing
          pose.shoulderR = -0.35 * k.armSwing
        } else {
          pose.hipL = k.hipKick
          pose.kneeL = k.kneeKick
          pose.hipR = k.hipSupport
          pose.kneeR = k.kneeSupport
          pose.shoulderR = k.armSwing
          pose.shoulderL = -0.35 * k.armSwing
        }
        pose.torsoPitch = k.torsoLean
        pose.torsoTwist = (kickRight ? -1 : 1) * 0.25 * k.armSwing
        pose.armOutL = 0.34
        pose.armOutR = 0.34
        pose.elbowL = 0.5
        pose.elbowR = 0.5
        pose.bodyY = 0.02 * Math.sin(Math.PI * at)
        pose.bodyRoll = (kickRight ? 1 : -1) * 0.12 * Math.sin(Math.PI * at)
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
        pose.bodyRoll = 0.05 * wave
        pose.torsoPitch = c.lean
        pose.torsoTwist = 0.12 * wave
        pose.hipL = 0.12 + 0.35 * air
        pose.hipR = 0.12 + 0.2 * air
        pose.kneeL = -0.25 - 0.7 * air
        pose.kneeR = -0.2 - 0.45 * air
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
        pose.bodyRoll = d.roll
        pose.torsoPitch = 0.12
        pose.torsoTwist = 0.18 * diveDir
        pose.hipL = hipL
        pose.hipR = hipR
        pose.kneeL = kneeL
        pose.kneeR = kneeR
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
        pose.torsoPitch = 0.1 + 0.03 * breath
        pose.torsoTwist = 0.1 * diveDir
        pose.hipL = hipL
        pose.hipR = hipR
        pose.kneeL = kneeL
        pose.kneeR = kneeR
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
        pose.bodyY = 0.006 * breath
        pose.bodyRoll = 0.035 * shift
        pose.torsoPitch = 0.045 + 0.012 * breath
        pose.torsoTwist = 0.03 * shift
        pose.hipL = 0.05 + 0.05 * shift
        pose.hipR = 0.05 - 0.05 * shift
        pose.kneeL = -0.11 - 0.03 * shift
        pose.kneeR = -0.11 + 0.03 * shift
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
