// src/ui/pitch/three/pose.ts
// 선수 포즈의 **순수 수학** — three 무의존, 결정론(Math.random·Date 금지), 단위 테스트 대상.
// 러닝 사이클·역기구학·킥·세리머니·다이브 + 킷 색 계산이 여기 산다.
//
// 왜 player3d.ts에서 떼어냈나:
//  player3d.ts는 원래 이 순수 계층과 "three 리그 조립" 계층을 한 파일에 담고 파일 안에서
//  배너 주석으로 갈라 놓고 있었다(1630줄). 문제는 **의존 방향**이었다 — 표시 로직인
//  movement.ts와 entrance.ts가 공유 보폭 모델(strideLength·MIN_GAIT_SPEED) 하나 때문에
//  three 리그 빌더 전체를 import해야 했다. 순수 계층을 독립 모듈로 두면 그 두 모듈은
//  자기가 실제로 쓰는 것만 가져간다.
//  (types.ts 주석대로 movement와 렌더러가 **같은 보폭 모델**을 써야 발이 미끄러지지 않는다 —
//   그 계약의 집도 여기가 맞다.)
//
// 좌표 규약은 player3d.ts 헤더 참조(로컬 +X 정면, 무릎 음수 굴곡, 팔꿈치 양수 굴곡).
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

/** 0xRRGGBB → HSL. h·s·l 모두 0~1. 무채색이면 h=0. */
export function rgbToHsl(color: number): { h: number; s: number; l: number } {
  const r = ((color >> 16) & 255) / 255
  const g = ((color >> 8) & 255) / 255
  const b = (color & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d < 1e-9) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

/** HSL(0~1) → 0xRRGGBB. */
export function hslToRgb(h: number, s: number, l: number): number {
  const hh = ((h % 1) + 1) % 1
  const ss = clamp01(s)
  const ll = clamp01(l)
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
  const p = 2 * ll - q
  const ch = (t0: number): number => {
    let t = ((t0 % 1) + 1) % 1
    let v: number
    if (t < 1 / 6) v = p + (q - p) * 6 * t
    else if (t < 1 / 2) v = q
    else if (t < 2 / 3) v = p + (q - p) * (2 / 3 - t) * 6
    else v = p
    return clamp(Math.round(v * 255), 0, 255)
  }
  return (ch(hh + 1 / 3) << 16) | (ch(hh) << 8) | ch(hh - 1 / 3)
}

/**
 * 팀 주색에서 킷의 **어두운 보조색**(버건디·딥네이비)을 만든다.
 *
 * 왜 shade()가 아닌가: 채널 균등 배율은 명도와 함께 채도까지 떨어뜨려 스칼렛을 탁한
 * 갈색으로, 애저를 청회색으로 만든다. 야간 피치 위에서 그 둘은 서로 수렴한다.
 * 색상(H)을 고정하고 채도를 바닥에서 끌어올린 뒤 명도만 낮추면 참조 판정 팔레트
 * (버건디 `#7A1424` / 딥네이비 `#071C4A`)에 가까운 값이 나온다.
 * L=0.21은 두 목표값(0.28 / 0.16)의 중간이며, 트림 면적이 몸통의 10% 미만이라
 * 이 정도 편차는 40~52px에서 구분되지 않는다.
 */
export function deepKit(color: number): number {
  const { h, s } = rgbToHsl(color)
  return hslToRgb(h, Math.max(s, 0.7), 0.21)
}

/** 등번호를 어두운 잉크로 바꾸는 킷 휘도 임계. */
const INK_DARK_ABOVE = 0.62

/**
 * 등번호 색. 어두운 킷에는 흰 계열, 밝은 킷에는 잉크블랙.
 * 따뜻한 킷(빨강~주황)에는 순백 대신 아이보리 `#FFF1D0`을 쓴다 — 스칼렛 위의 순백은
 * 야간 조명에서 차갑게 튀어 번호만 도려낸 것처럼 보인다(docs/refs 팔레트 권고).
 *
 * **임계가 {@link contrastOn}(0.45)보다 높은 이유:** Rec.709 휘도는 초록에 0.7152를 주므로
 * 채도 높은 중간 파랑(#4895EF → 0.55)이 "밝은 색"으로 분류돼 **검은 번호**를 받았다.
 * 실제로는 애저 위의 흰 번호가 정답이고 참조 팔레트도 그렇게 지정한다. 0.62면 GK 형광
 * 라임(0.91)만 검정을 받고 두 팀 킷은 밝은 글자를 받는다.
 */
export function kitInk(color: number): number {
  if (luminance(color) > INK_DARK_ABOVE) return 0x14181f
  const { h } = rgbToHsl(color)
  const warm = h < 0.11 || h > 0.9
  return warm ? 0xfff1d0 : 0xffffff
}

// ── 신체 치수(m) ─────────────────────────────────────────────────────────────
// 총신장 ≈ 1.80, 머리 지름 ≈ 0.23 ⇒ 약 7.8등신(7.5등신 근사).
// 보행 역기구학이 이 값들을 직접 쓰므로 리그 조립부보다 앞에 둔다.
// (리그 조립부 player3d.ts가 같은 치수로 메시를 만들어야 하므로 export한다 —
//  기하와 역기구학이 다른 숫자를 쓰면 발이 지면을 파고든다.)
export const HIP_Y = 0.94
export const THIGH_LEN = 0.47
export const SHIN_LEN = 0.46
export const SHOULDER_Y = 0.5 // 힙(몸통 피벗) 기준 어깨 높이 → 월드 1.44
export const UPPER_ARM = 0.3
export const FOREARM = 0.26
export const LEG_Z = 0.1
export const ARM_Z = 0.195

// ── 러닝 사이클 ───────────────────────────────────────────────────────────────

/** 한 스트라이드(=2보, 위상 0→2π) 동안의 관절 각(rad)과 몸통 오프셋. */
export interface GaitAngles {
  /** 힙 스윙(양수 = 허벅지가 앞으로) */
  hipL: number
  hipR: number
  /** 무릎(음수 = 굴곡, 정강이가 뒤로) */
  kneeL: number
  kneeR: number
  /** 발목(정강이 기준 상대각). 접지 중에는 발바닥이 지면과 평행해진다 */
  ankleL: number
  ankleR: number
  /** 어깨 스윙(양수 = 팔이 앞으로) — 같은 쪽 발의 전후 위치와 교차한다 */
  shoulderL: number
  shoulderR: number
  /** 팔꿈치(양수 = 굴곡, 하완이 앞으로) */
  elbowL: number
  elbowR: number
  /** 골반 수직 오프셋(m, 부호 있음). 선 자세 기준이며 러닝 중에는 항상 ≤ 0이다 */
  bounce: number
  /** 접지 최저점 대비 골반 상승량(m, ≥ 0) — 체공 정도. 그림자 크기에 쓴다 */
  bob: number
  /** 전경 기울기(rad, 양수 = 앞으로 숙임) — 속도 비례 */
  lean: number
  /** 몸통 좌우 롤(rad) */
  roll: number
  /** 어깨-골반 반대 비틀기(rad) */
  twist: number
}

const GAIT_FLOOR = 0.18 // 속도 0에서도 남는 최소 진폭(제자리 걸음이 얼어붙지 않게)
const ARM_AMP = 0.62
const ELBOW_BASE = 0.28
const ELBOW_MID = 0.75
const ELBOW_AMP = 0.35
const BOUNCE_AMP = 0.052
const LEAN_MAX = 0.3
const ROLL_AMP = 0.075
const TWIST_AMP = 0.16
/** 유각기 발목 저측굴곡(rad) — 발끝이 아래로 떨어진다. */
const TOE_AMP = 0.45

// ── 보행 기하 상수 ──────────────────────────────────────────────────────────
// 아래 값들은 "발이 미끄러지지 않는다"를 **풀 수 있는 조건**을 만든다.
// 힙 관절 높이 HIP_Y에서 발목이 지면 접촉 높이 ANKLE_H까지 내려가려면 다리가
// STAND_DROP만큼 뻗어야 하고, 그 상태에서 앞뒤로 E만큼 더 도달해야 접지 구간이
// 생긴다. 즉 다리 길이 > STAND_DROP 이어야 한다(기존 0.86 < 0.90이라 발이 애초에
// 땅에 닿지 못했다 — 미끄러짐의 숨은 원인 중 하나).

/** 발바닥이 지면에 닿을 때의 발목 관절 높이(m) = 부츠 중심 오프셋 + 두께 절반. */
export const ANKLE_H = 0.04
/** 힙 관절 → 발목의 수직 거리(m), 선 자세 기준. (리그 조립부도 쓴다 → export) */
export const STAND_DROP = HIP_Y - ANKLE_H
/** 무릎이 잠기지 않도록 링크 합의 99.5%까지만 뻗는다. */
const LEG_REACH = (THIGH_LEN + SHIN_LEN) * 0.995

/**
 * 접지율(duty factor) — 한 다리가 한 스트라이드 중 지면에 붙어 있는 시간 비율.
 * 빠를수록 접지 시간이 짧고 체공이 길다(문헌: 스프린트 ≈ 0.21).
 *
 * 이 값이 접지 구간의 이동거리 L·δ를 정하고, 그 절반이 다리가 앞뒤로 도달해야 하는
 * 거리 E가 된다. E가 커질수록 골반을 더 낮춰야 발이 닿으므로(crouch),
 * **보행 δ를 실측치(≈0.6)까지 올리면 걷는 자세가 앉은 자세가 된다.**
 * 다리 길이 0.93m·힙 높이 0.94m라는 이 리그의 비율에서 타협점이 0.44다.
 */
function dutyFactor(eff: number): number {
  return 0.44 - 0.23 * eff
}

/** 유각기 발 지면 클리어런스(m) — 빠를수록 높이 든다. */
function swingLift(eff: number): number {
  return 0.07 + 0.1 * eff
}

/**
 * 2링크 역기구학. 힙 로컬 좌표 (fx = 앞, fy = 아래)에 발목을 놓는 힙·무릎 각을 푼다.
 * 무릎이 앞으로 나오는 해(사람 다리)를 고른다. 도달 불가면 반경을 클램프한다
 * (유각기에만 발생하며 공중이라 보이지 않는다).
 */
export function solveLeg(fx: number, fy: number): { hip: number; knee: number } {
  const r = clamp(Math.hypot(fx, fy), Math.abs(THIGH_LEN - SHIN_LEN) + 1e-4, LEG_REACH)
  const beta = Math.atan2(fx, fy) // 힙→발목 방향(0 = 바로 아래)
  const d = Math.acos(clamp((THIGH_LEN * THIGH_LEN + r * r - SHIN_LEN * SHIN_LEN) / (2 * THIGH_LEN * r), -1, 1))
  const g = Math.acos(clamp((SHIN_LEN * SHIN_LEN + r * r - THIGH_LEN * THIGH_LEN) / (2 * SHIN_LEN * r), -1, 1))
  return { hip: beta + d, knee: -(d + g) }
}

interface GaitPlan {
  /** 포화된 유효 속도(m/s) */
  sp: number
  eff: number
  amp: number
  /** 한 스트라이드 이동거리(로컬 단위 — root.scale 보정 후) */
  L: number
  duty: number
  /** 접지 구간 반각(rad) = π·duty */
  a: number
  /** 접지 전후 도달거리 절반(m) */
  E: number
  /** 접지 최저점에서의 골반 하강량(m, ≥ 0) */
  crouch: number
  bobAmp: number
  lift: number
}

/**
 * 속도에서 보행 기하를 유도한다.
 * crouch는 튜닝값이 아니라 **역기구학 도달 조건에서 나온 값**이다 —
 * 접지 구간 끝(발이 가장 멀리 뻗은 순간)에 hypot(E, fy) = LEG_REACH가 되도록
 * 골반 높이를 낮춘다. 빨리 달릴수록 보폭이 길어 더 낮게 앉는다(실제와 같다).
 */
function gaitPlan(speed: number, scale: number): GaitPlan {
  const sp = clamp(speed, 0, SPRINT_SPEED)
  const eff = sp / SPRINT_SPEED
  const amp = GAIT_FLOOR + (1 - GAIT_FLOOR) * eff
  const duty = dutyFactor(eff)
  const s = scale > 1e-6 ? scale : 1
  // root.scale이 걸린 상태에서도 **월드** 보폭이 strideLength(v)여야 하므로 로컬로 환산한다.
  const L = strideLength(sp) / s
  const bobAmp = BOUNCE_AMP * amp
  const E = Math.min((L * duty) / 2, LEG_REACH * 0.96)
  // 접지 구간 끝의 골반 상승량(접지 중 bob은 양끝에서 최대, 중간에서 0)
  const bobEnd = bobAmp * (0.5 - 0.5 * Math.cos(TAU * duty))
  const crouch = Math.max(0, STAND_DROP + bobEnd - Math.sqrt(Math.max(1e-6, LEG_REACH * LEG_REACH - E * E)))
  return { sp, eff, amp, L, duty, a: Math.PI * duty, E, crouch, bobAmp, lift: swingLift(eff) }
}

/** 골반 수직 오프셋. 접지 중간(위상 0·π)에서 최저, 체공(±π/2)에서 최고 — 실제 러닝의 COM 궤적. */
function gaitBob(plan: GaitPlan, phase: number): number {
  return plan.bobAmp * (0.5 - 0.5 * Math.cos(2 * phase))
}

/** 한쪽 발의 힙 로컬 목표 위치(fx = 앞, fy = 아래)와 접지 여부. */
export interface FootTarget {
  fx: number
  fy: number
  grounded: boolean
  /** 유각기 진행도 0~1(접지 중에는 -1) */
  psi: number
}

/**
 * 발 궤적 — 이 함수가 "발이 미끄러지지 않는다"의 정의 그 자체다.
 *
 * 접지 구간(|φ-π| ≤ a)에서 fx는 위상에 대해 **정확히 -L/2π 기울기의 직선**이다.
 * 위상은 이동거리로 적분되므로(dφ/dt = 2π·v/L) dfx/dt = -v가 되어
 * 발의 대지 속도가 정확히 0이 된다. 눈대중 사인파가 아니라 이 등식이 근거다.
 *
 * 유각 구간은 양끝에서 같은 기울기를 갖는 3차 에르미트로 이어 붙인다(C1 연속) —
 * 착지 순간 발이 이미 -v로 흐르고 있어야 접지 시작에서 튀지 않는다.
 */
function footTarget(plan: GaitPlan, phase: number): FootTarget {
  let d = ((phase - Math.PI) % TAU + TAU) % TAU
  if (d > Math.PI) d -= TAU
  const fyGround = STAND_DROP - plan.crouch + gaitBob(plan, phase)
  if (Math.abs(d) <= plan.a) {
    return { fx: -(plan.L / TAU) * d, fy: fyGround, grounded: true, psi: -1 }
  }
  const span = TAU - 2 * plan.a
  const psi = (d > plan.a ? d - plan.a : d + TAU - plan.a) / span
  // 양끝 기울기 m을 맞춘 3차 에르미트: g(0)=0, g(1)=1, g'(0)=g'(1)=m
  const m = -(1 - plan.duty) / plan.duty
  const g = m * (2 * psi ** 3 - 3 * psi ** 2 + psi) + (-2 * psi ** 3 + 3 * psi ** 2)
  return {
    fx: -plan.E + 2 * plan.E * g,
    fy: fyGround - plan.lift * Math.sin(Math.PI * psi),
    grounded: false,
    psi,
  }
}

/**
 * 왼발의 힙 로컬 목표 위치·접지 여부(오른발은 phase+π). 접지 계약을 외부에서
 * 검증할 수 있게 공개한다 — 어느 위상이 입각기인지 알아야 슬립을 잴 수 있다.
 */
export function gaitFoot(speed: number, phase: number, scale = 1): FootTarget {
  return footTarget(gaitPlan(speed, scale), phase)
}

/** 한쪽 다리의 힙·무릎·발목. 발목은 접지 중 발바닥을 지면과 평행하게 유지한다. */
function legFromFoot(f: FootTarget): { hip: number; knee: number; ankle: number } {
  const { hip, knee } = solveLeg(f.fx, f.fy)
  // 발바닥 수평 유지 = 힙+무릎+발목 = 0. 유각기에는 발끝을 살짝 떨어뜨린다.
  const ankle = -(hip + knee) - (f.grounded ? 0 : TOE_AMP * Math.sin(Math.PI * f.psi))
  return { hip, knee, ankle }
}

/** 한쪽 팔의 어깨·팔꿈치 — 같은 쪽 **발**의 전후 위치와 반대 위상(교차 스윙). */
function armAngles(amp: number, swing: number): { shoulder: number; elbow: number } {
  return {
    shoulder: -ARM_AMP * amp * swing,
    elbow: ELBOW_BASE + amp * (ELBOW_MID + ELBOW_AMP * -swing), // 팔이 앞으로 올 때 더 접힌다
  }
}

/**
 * 러닝/워킹 한 프레임의 전신 각도. 결정론 순수 함수.
 * @param speed m/s (0 이하는 0, SPRINT_SPEED 이상은 포화)
 * @param phase 누적 위상(rad) — movement의 gaitPhase(×2π) 또는 advancePhase()의 값
 * @param scale root.scale(체격 변주). 월드 보폭을 유지하려면 로컬 궤적을 1/scale 해야 한다
 */
export function gaitAngles(speed: number, phase: number, scale = 1): GaitAngles {
  const plan = gaitPlan(speed, scale)
  const opp = phase + Math.PI

  const fl = footTarget(plan, phase)
  const fr = footTarget(plan, opp)
  const l = legFromFoot(fl)
  const r = legFromFoot(fr)
  // 팔 스윙 세기는 발의 전후 위치를 도달거리로 정규화한 값(유각 오버슛은 클램프)
  const norm = (fx: number): number => clamp(fx / Math.max(plan.E, 1e-3), -1.2, 1.2)
  const al = armAngles(plan.amp, norm(fl.fx))
  const ar = armAngles(plan.amp, norm(fr.fx))
  const bob = gaitBob(plan, phase)

  return {
    hipL: l.hip,
    hipR: r.hip,
    kneeL: l.knee,
    kneeR: r.knee,
    ankleL: l.ankle,
    ankleR: r.ankle,
    shoulderL: al.shoulder,
    shoulderR: ar.shoulder,
    elbowL: al.elbow,
    elbowR: ar.elbow,
    bounce: bob - plan.crouch,
    bob,
    lean: LEAN_MAX * (0.25 * plan.eff + 0.75 * plan.eff * plan.eff),
    roll: ROLL_AMP * plan.amp * Math.sin(phase),
    twist: TWIST_AMP * plan.amp * Math.sin(phase),
  }
}

/**
 * 한 스트라이드(2보)에 나아가는 거리(m). 빠를수록 보폭이 길어져 케이던스가 폭주하지 않는다.
 * **movement와 player3d가 공유하는 단 하나의 보폭 모델**이다 — 두 계층이 다른 보폭을 쓰면
 * 위상 진행 속도와 발 궤적 기울기가 어긋나 그 차이가 그대로 미끄러짐이 된다.
 * SPRINT_SPEED에서 포화시키는 이유도 같다(러닝 사이클 진폭과 같은 지점에서 포화해야 한다).
 */
export function strideLength(speed: number): number {
  return 1.1 + 0.28 * clamp(speed, 0, SPRINT_SPEED)
}

/** 정지에 가까워도 다리가 완전히 멈추지 않도록 하는 최소 보행 속도(m/s). */
export const MIN_GAIT_SPEED = 0.35

/**
 * 누적 거리 기반 위상 적분 — 프레임 dt가 흔들려도 걸음 속도가 일정하다.
 * movement.computeFrame이 gaitPhase를 공급하지 못할 때만 쓰이는 폴백이며,
 * 같은 strideLength를 쓰므로 두 경로의 케이던스는 동일하다.
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
  /**
   * 디딤 다리 하중 0~1(0 → 1 → 0). 디딤 다리의 관절각은 접지 역기구학이 풀므로
   * 여기서는 **하중만** 내보낸다(예전의 hipSupport·kneeSupport 상수 각도는
   * 다리 길이를 바꾸면 즉시 지면을 파고들어 접지 계약을 깨뜨렸다).
   */
  plant: number
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

  return {
    hipKick,
    kneeKick,
    plant: Math.sin(Math.PI * u), // 디딤발 하중(0 → 1 → 0)
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

const DIVE_ARC = 0.5
// 옆으로 누우면 어깨·팔(로컬 z ±0.195)과 손이 아래로 내려온다. 그 반폭만큼 띄워야
// 몸이 잔디를 파고들지 않는다. B-2에서 다리가 0.05m 길어져 접힌 다리도 더 아래로
// 내려오므로 그만큼 올렸다(실측: 이 값에서 양방향 관통 0 이하).
const DIVE_GROUND = 0.41

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
