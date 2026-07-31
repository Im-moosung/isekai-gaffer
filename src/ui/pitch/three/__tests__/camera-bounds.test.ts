// 카메라 프리셋 **전수 경계 검사**(영구 회귀 테스트).
//
// 왜 필요한가: 프리셋 상수는 "그럴듯한 숫자"로 정해지는데, 경기장 지오메트리(scene.ts)는
// 따로 자란다. 실제로 GOAL_CAM_BEHIND=12이던 시절 골 카메라가 엔드 스탠드 안쪽 경계를
// 5m 넘어 관중 인스턴스 사이에 박혀 있었고(골 순간 화면 절반이 색 상자), highlight·celebrate도
// 같은 병을 앓고 있었다. 눈으로는 특정 focus에서만 보이기 때문에 **격자 전수 검사**가 아니면
// 절대 못 잡는다.
//
// 여기서 쓰는 지오메트리 수치는 scene.ts의 상수를 손으로 옮긴 값이다. camera.ts는 three를
// import할 수 없어(코드 스플릿 계약) scene.ts에서 가져올 수 없으므로, 이 테스트가 두 파일의
// 값이 어긋나지 않게 못 박는 역할을 겸한다.
import { describe, expect, it } from 'vitest'
import {
  CAM_MAX_X,
  CAM_MAX_Z,
  CAM_MIN_Y,
  END_STAND_INNER_X,
  MAST_CLEAR_R,
  MAST_X,
  MAST_Z,
  SIDE_STAND_INNER_Z,
  STAND_CLEARANCE,
  cameraFor,
  standSurfaceY,
  type CameraMode,
  type CameraShot,
} from '../camera'

// ── scene.ts 실측치(하드코딩 미러) ────────────────────────────────
/** scene.ts: `APRON = 7`. */
const APRON = 7
/** scene.ts: `RAKE = 0.5`. */
const RAKE = 0.5
/** scene.ts: `STAND_DEPTH = 26`. */
const STAND_DEPTH = 26
/** scene.ts: `STAND_H0 = 2.4`. */
const STAND_H0 = 2.4
/** scene.ts: `PITCH_W/2 + APRON`. */
const END_INNER = 105 / 2 + APRON
/** scene.ts: `PITCH_H/2 + APRON`. */
const SIDE_INNER = 68 / 2 + APRON
/** scene.ts: 조명탑 마스트 중심(높이 0~44, 반경 ≤0.9). */
const MAST_PX = END_INNER + STAND_DEPTH * 0.85
const MAST_PZ = SIDE_INNER + STAND_DEPTH * 0.85
/** scene.ts: 마스트 실린더 상단 y(=0 + 44). */
const MAST_TOP_Y = 44

export const ALL_MODES: CameraMode[] = [
  'broadcast',
  'highlight',
  'set-piece',
  'goal-cam',
  'reaction',
  'celebrate',
  'entrance',
  'entrance-close',
]

/** 좌석 표면 위로 남은 여유(m). 스탠드 밖이면 +Infinity. */
function standMargin(s: CameraShot): number {
  const surface = standSurfaceY(s.pos.x, s.pos.z)
  return surface <= 0 ? Number.POSITIVE_INFINITY : s.pos.y - surface
}

/** 가장 가까운 조명탑 마스트까지의 수평 거리(m). 마스트 위를 지나면 +Infinity. */
function mastMargin(s: CameraShot): number {
  if (s.pos.y >= MAST_TOP_Y + 2) return Number.POSITIVE_INFINITY
  const d = Math.hypot(Math.abs(s.pos.x) - MAST_PX, Math.abs(s.pos.z) - MAST_PZ)
  return d
}

/** 피치 전역 격자 × 시간 × 시드 스윕. */
function* sweep(): Generator<{ mode: CameraMode; fx: number; fz: number; t: number; seed: number }> {
  for (const mode of ALL_MODES) {
    for (let fx = -58; fx <= 58; fx += 4) {
      for (let fz = -38; fz <= 38; fz += 4) {
        for (const t of [0, 0.37, 1.9, 5.5, 13.2, 30]) {
          for (const seed of [1, 7, 4242]) yield { mode, fx, fz, t, seed }
        }
      }
    }
  }
}

describe('경기장 지오메트리 미러', () => {
  it('camera.ts의 스탠드 상수가 scene.ts 실측치와 일치한다', () => {
    expect(SIDE_STAND_INNER_Z).toBe(SIDE_INNER)
    expect(SIDE_STAND_INNER_Z).toBe(41)
    expect(END_STAND_INNER_X).toBe(END_INNER)
    expect(END_STAND_INNER_X).toBe(59.5)
    expect(MAST_X).toBeCloseTo(MAST_PX, 9)
    expect(MAST_X).toBeCloseTo(81.6, 9)
    expect(MAST_Z).toBeCloseTo(MAST_PZ, 9)
    expect(MAST_Z).toBeCloseTo(63.1, 9)
  })

  it('standSurfaceY가 경사 슬래브를 그대로 재현한다', () => {
    // 스탠드 밖
    expect(standSurfaceY(0, 0)).toBe(0)
    expect(standSurfaceY(50, 40)).toBe(0)
    // 안쪽 경계는 "스탠드 밖", 그 한 뼘 안쪽부터 첫 열 높이에서 시작한다
    expect(standSurfaceY(0, -SIDE_INNER)).toBe(0)
    expect(standSurfaceY(0, -(SIDE_INNER + 0.001))).toBeCloseTo(STAND_H0, 2)
    // 침투 14m 지점(=BROADCAST_Z가 서는 자리)
    expect(standSurfaceY(0, -55)).toBeCloseTo(STAND_H0 + 14 * Math.tan(RAKE), 9)
    // 엔드 스탠드도 같은 규칙
    expect(standSurfaceY(END_INNER + 10, 0)).toBeCloseTo(STAND_H0 + 10 * Math.tan(RAKE), 9)
    // 슬래브 끝에서 포화(뒷벽 뒤로 더 올라가지 않는다)
    expect(standSurfaceY(0, -(SIDE_INNER + 100))).toBeCloseTo(
      STAND_H0 + STAND_DEPTH * Math.tan(RAKE),
      9,
    )
  })
})

describe('카메라 프리셋 전수 경계 검사', () => {
  it('어떤 모드·focus·시간·시드에도 관중석 안에 박히지 않는다', () => {
    let worst: { key: string; margin: number } | null = null
    for (const c of sweep()) {
      const s = cameraFor(c.mode, { x: c.fx, z: c.fz }, c.t, c.seed)
      const m = standMargin(s)
      if (!worst || m < worst.margin) {
        worst = { key: `${c.mode} focus(${c.fx},${c.fz}) t=${c.t} seed=${c.seed}`, margin: m }
      }
    }
    // 스탠드 풋프린트 안에 들어가더라도 좌석 표면 위로 STAND_CLEARANCE는 남아야 한다.
    expect(worst?.margin ?? Infinity).toBeGreaterThanOrEqual(STAND_CLEARANCE - 1e-6)
  })

  it('조명탑 마스트를 뚫지 않는다', () => {
    let worst = Number.POSITIVE_INFINITY
    for (const c of sweep()) {
      const s = cameraFor(c.mode, { x: c.fx, z: c.fz }, c.t, c.seed)
      worst = Math.min(worst, mastMargin(s))
    }
    expect(worst).toBeGreaterThan(MAST_CLEAR_R)
  })

  it('피치면 아래로 꺼지지 않고 FOV가 상식 범위에 있다', () => {
    // 격자가 수만 건이라 expect를 루프 안에서 부르면 테스트 자체가 병목이 된다.
    // 위반 사례만 모아 한 번에 단언한다(실패 시 어떤 케이스인지 그대로 보인다).
    const bad: string[] = []
    for (const c of sweep()) {
      const s = cameraFor(c.mode, { x: c.fx, z: c.fz }, c.t, c.seed)
      const ok =
        Number.isFinite(s.pos.x) &&
        Number.isFinite(s.pos.y) &&
        Number.isFinite(s.pos.z) &&
        s.pos.y >= CAM_MIN_Y &&
        Math.abs(s.pos.x) <= CAM_MAX_X &&
        Math.abs(s.pos.z) <= CAM_MAX_Z &&
        s.fov >= 18 &&
        s.fov <= 70
      if (!ok) {
        bad.push(
          `${c.mode} focus(${c.fx},${c.fz}) t=${c.t} seed=${c.seed} → (${s.pos.x}, ${s.pos.y}, ${s.pos.z}) fov=${s.fov}`,
        )
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('|z| 한계만으로 마스트 충돌이 구조적으로 불가능하다', () => {
    // 방어 설계의 근거를 못 박는다: 카메라 z는 마스트 z보다 MAST_CLEAR_R 이상 안쪽이다.
    expect(MAST_Z - CAM_MAX_Z).toBeGreaterThan(MAST_CLEAR_R)
  })

  it('BROADCAST_Z(-55)는 사이드 스탠드 안이지만 좌석 표면 한참 위다', () => {
    // 자리 자체는 관중석 풋프린트(|z|≥41) 안이다 — 실제 중계의 상단 메인 카메라와 같다.
    const s = cameraFor('broadcast', { x: 0, z: 0 }, 0, 3)
    expect(Math.abs(s.pos.z)).toBeGreaterThan(SIDE_INNER)
    const surface = standSurfaceY(s.pos.x, s.pos.z)
    expect(surface).toBeCloseTo(STAND_H0 + 14 * Math.tan(RAKE), 9) // ≈10.05m
    expect(s.pos.y - surface).toBeGreaterThan(17) // ≈18m 여유 — 문제 없음
  })

  it('goal-cam은 엔드 스탠드 안쪽 경계를 넘지 않는다(회귀: BEHIND 12 → 6)', () => {
    let worst = 0
    for (const c of sweep()) {
      if (c.mode !== 'goal-cam') continue
      const s = cameraFor(c.mode, { x: c.fx, z: c.fz }, c.t, c.seed)
      worst = Math.max(worst, Math.abs(s.pos.x))
    }
    expect(worst).toBeLessThan(END_STAND_INNER_X)
  })
})
