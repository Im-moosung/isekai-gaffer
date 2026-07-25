// src/ui/pitch/three/camera.ts
// Phase 4E 3D 매치 뷰 — 방송 카메라 워크(순수 수학 + 적용 헬퍼).
//
// 설계 원칙(Phase 4E Global Constraints):
//  - **three 무의존**: 이 모듈은 three를 import하지 않는다(타입조차). 카메라 객체는
//    scene.ts 번들이 소유하므로 {@link applyCamera}가 구조적 인터페이스({@link CameraLike})로
//    주입받아 갱신한다 → 엔트리 번들에 three가 새지 않고, 테스트도 three 없이 돈다.
//  - **Math.random·Date 금지**: 오퍼레이터 호흡·오빗 위상·셰이크까지 전부 시드 해시(hash01).
//    같은 (mode, focus, t, seed) → 완전히 같은 샷.
//  - **불변식**: 카메라는 절대 피치 아래(y>3)나 관중석 뒤(|z|<80)로 빠지지 않는다.
//    모든 샷은 {@link clampShot}를 통과한다.
//  - **reduced-motion**: 셰이크 진폭 0이면 정확히 0을 돌려준다(리그는 amp를 0으로 강제).
//
// 시간 t는 three Clock의 경과 초(표시 전용). 모드 전환 보간은 {@link createCameraRig}가 맡는다.
import { hash01 } from './textures'
import { PITCH_H, PITCH_W, type Vec3 } from './types'

/** 카메라 연출 모드. */
export type CameraMode = 'broadcast' | 'highlight' | 'goal-cam' | 'celebrate'

/** 한 프레임의 카메라 상태(순수 값). */
export interface CameraShot {
  pos: Vec3
  lookAt: Vec3
  fov: number
}

/** 카메라가 따라갈 지점(FrameState.focus와 같은 모양). */
export interface Focus {
  x: number
  z: number
}

// ── 불변식(피치 밖·아래 이탈 금지) ────────────────────────────────
/** 카메라 최소 높이(m) — 잔디 아래로 내려가지 않는다. */
export const CAM_MIN_Y = 4
/** 카메라 |z| 한계(m) — 관중석 뒤로 빠지지 않는다. */
export const CAM_MAX_Z = 78
/** 카메라 |x| 한계(m). */
export const CAM_MAX_X = 118

// ── broadcast(기본 방송 앵글) ─────────────────────────────────────
/** 사이드라인 상단 카메라의 z(터치라인 바깥 -z 쪽). */
export const BROADCAST_Z = -55
/** 사이드라인 상단 카메라의 높이(m). */
export const BROADCAST_Y = 28
export const BROADCAST_FOV = 34
/** focus.x 추종 게인(<1 = 공간적 스무딩 — 카메라는 공보다 덜 움직인다). */
export const BROADCAST_FOLLOW = 0.62
/** 좌우 팬 한계(m) — 카메라 카트의 레일 길이. */
export const BROADCAST_MAX_PAN = 26
/** 오퍼레이터 호흡(수동 카메라 느낌) 진폭(m). */
const BROADCAST_DRIFT = 0.35

// ── highlight(액션 존 근접) ───────────────────────────────────────
export const HIGHLIGHT_Y = 14
export const HIGHLIGHT_DIST = 35
export const HIGHLIGHT_FOV = 30

// ── goal-cam(골대 뒤 로우 앵글) ───────────────────────────────────
export const GOAL_CAM_Y = 5.5
/** 골라인에서 뒤로 물러난 거리(m). */
export const GOAL_CAM_BEHIND = 12
export const GOAL_CAM_FOV = 38
/** 골 뒤 카메라의 좌우 이동 한계(m) — 골대 폭 근처를 벗어나지 않는다. */
const GOAL_CAM_MAX_Z = 9

// ── celebrate(득점팀 주위 오빗) ───────────────────────────────────
export const CELEBRATE_RADIUS = 22
export const CELEBRATE_Y = 9
export const CELEBRATE_FOV = 36
/** 기본 오빗 각속도(rad/s). 시드로 ±15% 변주된다. */
export const CELEBRATE_OMEGA = 0.42

// ── 전환·셰이크 ───────────────────────────────────────────────────
/** 모드 전환 시간(s) — easeInOutCubic. */
export const TRANSITION_S = 0.6
/** 셰이크 감쇠 시상수(s). */
export const SHAKE_DECAY_S = 0.45
/** 셰이크 진폭 상한(m) — 입력이 아무리 커도 화면이 뒤집히지 않는다. */
export const SHAKE_MAX = 1.5
/** 이 아래로 감쇠하면 셰이크를 완전히 끈다. */
const SHAKE_EPS = 1e-4

const TAU = Math.PI * 2
const HALF_W = PITCH_W / 2
const HALF_H = PITCH_H / 2

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

/** 시드+살트 → 0~2π 위상(결정론). */
function phase(seed: number, salt: number): number {
  return hash01(Math.imul(seed | 0, 2654435761) ^ Math.imul(salt | 0, 40503)) * TAU
}

/** 시드+살트 → 0~1(결정론). */
function unit(seed: number, salt: number): number {
  return hash01(Math.imul(seed | 0, 374761393) ^ Math.imul(salt | 0, 668265263))
}

/**
 * 모든 샷이 통과하는 안전 클램프 — 카메라가 잔디 아래(y<{@link CAM_MIN_Y})나
 * 관중석 뒤(|z|>{@link CAM_MAX_Z})로 빠지는 것을 막는다. 셰이크·보간 결과에도 적용된다.
 */
export function clampShot(shot: CameraShot): CameraShot {
  return {
    pos: {
      x: clamp(shot.pos.x, -CAM_MAX_X, CAM_MAX_X),
      y: shot.pos.y < CAM_MIN_Y ? CAM_MIN_Y : shot.pos.y,
      z: clamp(shot.pos.z, -CAM_MAX_Z, CAM_MAX_Z),
    },
    lookAt: { ...shot.lookAt },
    fov: clamp(shot.fov, 18, 70),
  }
}

/**
 * 모드별 카메라 샷(순수 함수). 같은 인자면 항상 같은 값을 돌려준다.
 *
 * @param mode  연출 모드
 * @param focus 카메라가 볼 지점(FrameState.focus — 월드 XZ)
 * @param t     경과 시간(s, three Clock) — 호흡·오빗 위상에만 쓴다
 * @param seed  결정론 시드
 */
export function cameraFor(mode: CameraMode, focus: Focus, t: number, seed: number): CameraShot {
  // 볼이 라인 밖으로 튀어도 카메라 기준점은 경기장 근처에 묶어둔다.
  const fx = clamp(focus.x, -HALF_W - 6, HALF_W + 6)
  const fz = clamp(focus.z, -HALF_H - 4, HALF_H + 4)
  switch (mode) {
    case 'highlight':
      return clampShot(highlightShot(fx, fz, t, seed))
    case 'goal-cam':
      return clampShot(goalCamShot(fx, fz, t, seed))
    case 'celebrate':
      return clampShot(celebrateShot(fx, fz, t, seed))
    default:
      return clampShot(broadcastShot(fx, fz, t, seed))
  }
}

/** 사이드라인 상단 방송 카메라 — 레일 위에서 focus.x를 부분 추종한다. */
function broadcastShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const pan = clamp(fx * BROADCAST_FOLLOW, -BROADCAST_MAX_PAN, BROADCAST_MAX_PAN)
  // 수동 카메라의 미세한 호흡(결정론) — 완전 고정된 CG 느낌을 없앤다.
  const driftX = BROADCAST_DRIFT * Math.sin(t * 0.23 + phase(seed, 1))
  const driftY = 0.25 * Math.sin(t * 0.17 + phase(seed, 2))
  return {
    pos: { x: pan + driftX, y: BROADCAST_Y + driftY, z: BROADCAST_Z },
    // 카메라는 덜 움직여도 시선은 공을 정확히 문다.
    lookAt: { x: fx, y: 1.2, z: fz * 0.55 },
    fov: BROADCAST_FOV,
  }
}

/** 액션 존 근접 컷 — focus를 중심으로 사이드라인 쪽 35m 지점까지 내려온다. */
function highlightShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  // 공이 골문 쪽일수록 대각선으로 붙어 "공격 방향"이 화면에 담긴다.
  const bias = clamp(fx / HALF_W, -1, 1) * 0.42
  // 각도만 흔들어 focus와의 거리는 정확히 유지한다.
  const wobble = 0.05 * Math.sin(t * 0.5 + phase(seed, 3))
  const az = -Math.PI / 2 - bias + wobble
  return {
    pos: {
      x: fx + Math.cos(az) * HIGHLIGHT_DIST,
      y: HIGHLIGHT_Y,
      z: fz + Math.sin(az) * HIGHLIGHT_DIST,
    },
    lookAt: { x: fx, y: 1.4, z: fz },
    fov: HIGHLIGHT_FOV,
  }
}

/** 골대 뒤 로우 앵글 — focus에 가까운 골문 뒤에서 피치 안쪽을 본다. */
function goalCamShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const side = fx >= 0 ? 1 : -1
  const sway = 0.4 * Math.sin(t * 0.6 + phase(seed, 4))
  return {
    pos: {
      x: side * (HALF_W + GOAL_CAM_BEHIND),
      y: GOAL_CAM_Y,
      z: clamp(fz * 0.35 + sway, -GOAL_CAM_MAX_Z, GOAL_CAM_MAX_Z),
    },
    lookAt: { x: fx, y: 1.4, z: fz },
    fov: GOAL_CAM_FOV,
  }
}

/** 세리머니 오빗 — 득점 지점 주위를 결정론 각속도로 완만히 돈다. */
function celebrateShot(fx: number, fz: number, t: number, seed: number): CameraShot {
  const omega = CELEBRATE_OMEGA * (0.85 + unit(seed, 5) * 0.3)
  const ang = phase(seed, 6) + t * omega
  return {
    pos: {
      x: fx + Math.cos(ang) * CELEBRATE_RADIUS,
      y: CELEBRATE_Y + 1.2 * Math.sin(ang * 0.5),
      z: fz + Math.sin(ang) * CELEBRATE_RADIUS,
    },
    lookAt: { x: fx, y: 1.6, z: fz },
    fov: CELEBRATE_FOV,
  }
}

/**
 * 골 순간 카메라 미세 흔들림(결정론). 축마다 다른 두 주파수를 섞어 기계적 반복을 없앤다.
 * 각 성분의 절댓값은 amp를 절대 넘지 않으며(가중치 합 = 1), amp ≤ 0이면
 * **정확히 0**을 돌려준다(reduced-motion 경로).
 *
 * @param t   경과 시간(s)
 * @param amp 진폭(m). 0 이하 → 무진동. {@link SHAKE_MAX}에서 포화.
 * @param seed 결정론 시드
 */
export function shake(t: number, amp: number, seed: number): Vec3 {
  if (!(amp > 0)) return { x: 0, y: 0, z: 0 }
  const a = amp > SHAKE_MAX ? SHAKE_MAX : amp
  const mix = (salt: number, f1: number, f2: number) =>
    0.62 * Math.sin(t * f1 + phase(seed, salt)) + 0.38 * Math.sin(t * f2 + phase(seed, salt + 32))
  return {
    x: a * mix(11, 31.7, 19.3),
    y: a * mix(12, 27.1, 41.9),
    z: a * mix(13, 23.5, 37.1),
  }
}

/** 표준 easeInOutCubic(0~1 밖은 클램프). */
export function easeInOutCubic(u: number): number {
  const x = clamp(u, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** 두 샷을 선형 보간한다(u는 0~1로 클램프). */
export function lerpShot(a: CameraShot, b: CameraShot, u: number): CameraShot {
  const k = clamp(u, 0, 1)
  if (k <= 0) return { pos: { ...a.pos }, lookAt: { ...a.lookAt }, fov: a.fov }
  if (k >= 1) return { pos: { ...b.pos }, lookAt: { ...b.lookAt }, fov: b.fov }
  return {
    pos: {
      x: lerp(a.pos.x, b.pos.x, k),
      y: lerp(a.pos.y, b.pos.y, k),
      z: lerp(a.pos.z, b.pos.z, k),
    },
    lookAt: {
      x: lerp(a.lookAt.x, b.lookAt.x, k),
      y: lerp(a.lookAt.y, b.lookAt.y, k),
      z: lerp(a.lookAt.z, b.lookAt.z, k),
    },
    fov: lerp(a.fov, b.fov, k),
  }
}

/**
 * three.PerspectiveCamera의 구조적 최소 계약. scene.ts 번들이 소유한 카메라를
 * three 의존 없이 갱신하기 위한 인터페이스다(테스트는 스텁으로 검증).
 */
export interface CameraLike {
  position: { set(x: number, y: number, z: number): void }
  fov: number
  lookAt(x: number, y: number, z: number): void
  updateProjectionMatrix(): void
}

/**
 * 샷을 실제 카메라에 적용한다. **위치 → lookAt** 순서를 지키며,
 * FOV가 바뀐 프레임에만 투영행렬을 다시 만든다(매 프레임 재계산 낭비 금지).
 */
export function applyCamera(camera: CameraLike, shot: CameraShot): void {
  camera.position.set(shot.pos.x, shot.pos.y, shot.pos.z)
  if (camera.fov !== shot.fov) {
    camera.fov = shot.fov
    camera.updateProjectionMatrix()
  }
  camera.lookAt(shot.lookAt.x, shot.lookAt.y, shot.lookAt.z)
}

export interface CameraRigOptions {
  /** 결정론 시드. 기본 1. */
  seed?: number
  /** 시작 모드. 기본 'broadcast'. */
  mode?: CameraMode
  /** true면 셰이크를 완전히 끈다(런타임 토글은 setReducedMotion). */
  reducedMotion?: boolean
  /** 모드 전환 시간(s). 기본 {@link TRANSITION_S}. */
  transition?: number
}

export interface CameraRigInput {
  focus: Focus
  /** 경과 시간(s, three Clock). */
  t: number
  /** 프레임 델타(s) — 내부에서 0~0.1로 클램프한다(탭 복귀 폭주 방지). */
  dt: number
  /** 주면 그 자리에서 applyCamera까지 수행한다. */
  camera?: CameraLike | null
}

export interface CameraRig {
  readonly mode: CameraMode
  /** 마지막으로 계산된 샷(셰이크 포함). */
  readonly shot: CameraShot
  /** 현재 셰이크 진폭(m). reduced-motion이면 다음 update에서 0이 된다. */
  readonly shakeAmp: number
  /** 전환 진행도 0~1(1이면 전환 없음). */
  readonly transitionU: number
  /** 모드 변경. 같은 모드면 무시된다. */
  setMode(mode: CameraMode, opts?: { instant?: boolean }): void
  /**
   * 골 순간 등 충격 주입(m, {@link SHAKE_MAX}에서 포화).
   * reduced-motion 강제는 update가 하므로 화면은 흔들리지 않는다.
   */
  impulse(amp: number): void
  setReducedMotion(value: boolean): void
  update(input: CameraRigInput): CameraShot
}

/**
 * 모드 전환 보간(easeInOutCubic 0.6s) + 셰이크 감쇠를 관리하는 적용 헬퍼.
 * 순수 계산은 {@link cameraFor}·{@link shake}가 담당하고, 리그는 시간 상태만 갖는다.
 */
export function createCameraRig(opts: CameraRigOptions = {}): CameraRig {
  const seed = opts.seed ?? 1
  const transition = opts.transition ?? TRANSITION_S
  let mode: CameraMode = opts.mode ?? 'broadcast'
  let reducedMotion = opts.reducedMotion === true
  let current: CameraShot = cameraFor(mode, { x: 0, z: 0 }, 0, seed)
  let from: CameraShot | null = null
  let elapsed = 0
  let amp = 0

  function setMode(next: CameraMode, o: { instant?: boolean } = {}): void {
    if (next === mode) return
    mode = next
    if (o.instant) {
      from = null
      elapsed = 0
      return
    }
    // 전환 중 재전환이면 "지금 보이는 화면"에서 다시 출발한다(점프 금지).
    from = { pos: { ...current.pos }, lookAt: { ...current.lookAt }, fov: current.fov }
    elapsed = 0
  }

  function update(input: CameraRigInput): CameraShot {
    const dt = clamp(input.dt, 0, 0.1)
    const target = cameraFor(mode, input.focus, input.t, seed)

    let base = target
    if (from) {
      elapsed += dt
      const u = transition > 0 ? clamp(elapsed / transition, 0, 1) : 1
      if (u >= 1) {
        from = null
      } else {
        base = lerpShot(from, target, easeInOutCubic(u))
      }
    }

    // reduced-motion 강제는 여기 한 곳에서만 한다(impulse·setReducedMotion은 상태만 바꾼다).
    if (reducedMotion) {
      amp = 0
    } else if (amp > 0) {
      amp = dt > 0 ? amp * Math.exp(-dt / SHAKE_DECAY_S) : amp
      if (amp < SHAKE_EPS) amp = 0
    }

    const jitter = shake(input.t, amp, seed)
    current =
      amp > 0
        ? clampShot({
            pos: { x: base.pos.x + jitter.x, y: base.pos.y + jitter.y, z: base.pos.z + jitter.z },
            lookAt: base.lookAt,
            fov: base.fov,
          })
        : base
    if (input.camera) applyCamera(input.camera, current)
    return current
  }

  return {
    get mode() {
      return mode
    },
    get shot() {
      return current
    },
    get shakeAmp() {
      return amp
    },
    get transitionU() {
      return from ? clamp(transition > 0 ? elapsed / transition : 1, 0, 1) : 1
    },
    setMode,
    impulse(next: number) {
      if (!(next > 0)) return
      amp = Math.min(Math.max(amp, next), SHAKE_MAX)
    },
    setReducedMotion(value: boolean) {
      reducedMotion = value
    },
    update,
  }
}
