// src/ui/landing/landing-camera.test.ts
// 랜딩 배경 카메라 궤적 회귀 — "조명탑 마스트가 프레임을 가로지르지 않는다"를
// 렌더 없이 순수 수학으로 지킨다.
//
// 왜 이 테스트가 있는가: 예전 구도(반경 148m 360° 풀 오빗)는 한 바퀴에 조명탑 4기를
// 전부 통과했다. 시작 프레임부터 마스트 방위각과 11°밖에 안 떨어져 있어, 심사자가 보는
// 첫 화면에서 발광 리그가 화면 오른쪽 아래를 흰 덩어리로 태웠다. 상수를 무심코
// 되돌리면 같은 사고가 재발하므로 프러스텀으로 못을 박는다.
import { describe, expect, it } from 'vitest'
import { LANDING_CAMERA, landingCameraAt } from './camera'

// ── scene.ts 실측 지오메트리(읽기 전용 복제) ──────────────────
// buildScene은 이 값들을 내보내지 않는다. 바뀌면 이 테스트가 먼저 깨져야 하므로
// 출처를 명시해 복제한다: APRON=7, STAND_DEPTH=26, 피치 105×68.
const END_INNER = 105 / 2 + 7 // 59.5
const SIDE_INNER = 68 / 2 + 7 // 41
const STAND_DEPTH = 26
/** 조명탑 밑동 좌표 — scene.ts의 `px = ±(END_INNER + STAND_DEPTH*0.85)` 그대로. */
const MAST_X = END_INNER + STAND_DEPTH * 0.85 // 81.6
const MAST_Z = SIDE_INNER + STAND_DEPTH * 0.85 // 63.1
/** 마스트 원통: 반경 0.5~0.9, 높이 44(y=0~44). 발광 리그는 y=43, 폭 10m. */
const MAST_R = 0.9
const MAST_TOP = 44
/** 리그 박스(10×5.2×1.1)의 반폭 — 마스트보다 훨씬 넓으므로 이걸로 부풀려 검사한다. */
const RIG_HALF_W = 5

const MASTS = [
  { x: MAST_X, z: MAST_Z },
  { x: MAST_X, z: -MAST_Z },
  { x: -MAST_X, z: MAST_Z },
  { x: -MAST_X, z: -MAST_Z },
]

/**
 * 카메라에서 가까운 조명탑으로 볼 기준 거리(m). 새 구도에서 앞쪽 2기는 60~100m,
 * 뒤쪽 2기는 210~230m에 있어 사이가 크게 벌어진다. 이 선 안쪽에 있는 탑은
 * "화면을 가릴 만큼 큰" 탑이므로 프레임 밖이어야 한다.
 */
const NEAR_D = 150

/**
 * 검사할 최대 종횡비. |ndcX|는 종횡비에 반비례하므로 **가장 넓은 화면만** 보면 충분하다.
 * 2.4는 3440×1440 울트라와이드 — 랜딩 3D가 켜지는(>720px) 화면 중 가장 넓은 축이다.
 */
const MAX_ASPECT = 2.4

interface Basis {
  eye: { x: number; y: number; z: number }
  /** 시야축(정규화). */
  f: [number, number, number]
  /** 화면 가로축(정규화). */
  r: [number, number, number]
  /** 화면 세로축(정규화). */
  u: [number, number, number]
}

function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2])
  return [v[0] / l, v[1] / l, v[2] / l]
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/** lookAt(0, lookY, 0) + 월드 업(0,1,0)으로 카메라 정규 직교 기저를 만든다. */
function basisAt(t: number): Basis {
  const eye = landingCameraAt(t)
  const l = LANDING_CAMERA.lookAt
  const f = norm([l.x - eye.x, l.y - eye.y, l.z - eye.z])
  const r = norm(cross(f, [0, 1, 0]))
  const u = cross(r, f)
  return { eye, f, r, u }
}

/**
 * 월드 점을 정규화 화면좌표로 옮긴다. |ndc| ≤ 1이면 프레임 안.
 * 카메라 뒤(depth ≤ 0)면 null(=화면에 없음).
 */
function ndc(b: Basis, p: { x: number; y: number; z: number }, aspect: number): [number, number] | null {
  const d: [number, number, number] = [p.x - b.eye.x, p.y - b.eye.y, p.z - b.eye.z]
  const w = d[0] * b.f[0] + d[1] * b.f[1] + d[2] * b.f[2]
  if (w <= 0) return null
  const su = d[0] * b.r[0] + d[1] * b.r[1] + d[2] * b.r[2]
  const sv = d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2]
  const tanV = Math.tan((LANDING_CAMERA.fov * Math.PI) / 360)
  return [su / w / (tanV * aspect), sv / w / tanV]
}

/** 마스트 원통 + 리그를 표면 점으로 샘플링한다(축만 재면 두께를 놓친다). */
function mastSamples(m: { x: number; z: number }): Array<{ x: number; y: number; z: number }> {
  const out: Array<{ x: number; y: number; z: number }> = []
  for (let i = 0; i <= 16; i++) {
    const y = (MAST_TOP * i) / 16
    // y가 리그 높이(43)에 닿으면 폭 10m 박스가 붙어 있으므로 반폭을 그만큼 넓게 본다.
    const rad = y > 40 ? RIG_HALF_W : MAST_R
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4
      out.push({ x: m.x + Math.cos(a) * rad, y, z: m.z + Math.sin(a) * rad })
    }
  }
  return out
}

/** XZ 방위각을 [0, 2π)로 정규화한다. 호가 π를 가로지르므로 atan2 원값을 그대로 쓰면 안 된다. */
function azimuth(p: { x: number; z: number }): number {
  return (Math.atan2(p.z, p.x) + 2 * Math.PI) % (2 * Math.PI)
}

const PERIOD = (2 * Math.PI) / LANDING_CAMERA.arcOmega
/**
 * 샘플 시각(초). 호(121s)·달리(170s)·보브(57s)의 주기가 서로 어긋나 최악 조합은
 * 한 주기 안에 나타나지 않는다 — 맥놀이가 한 바퀴 돌도록 4000초(약 33주기)를 훑는다.
 */
const TIMES = Array.from({ length: 2001 }, (_, i) => (4000 * i) / 2000)

describe('랜딩 배경 카메라 궤적', () => {
  it('t=0은 호의 중심 — 정지 컷이 가장 좋은 구도다', () => {
    const p = landingCameraAt(0)
    // 달리·보브 항은 sin(0)=0이라 기준 반경·높이 그대로여야 한다(하네스 LANDING과 동기화 조건).
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(110, 6)
    expect(p.y).toBeCloseTo(50, 6)
    expect(azimuth(p)).toBeCloseTo(LANDING_CAMERA.arcCenter, 6)
  })

  /**
   * [2026-08-01 타이틀 리디자인] 랜딩 타이틀이 화면 **중앙 정렬**로 바뀌면서 구도가
   * 계약이 됐다: 소실점과 제목 축이 같은 세로선 위에 있어야 한다. 그래서
   *  ① 호의 중심은 정확히 180°(골대 뒤 정면),
   *  ② 왕복 진폭은 ±5° 이내여야 한다.
   * 예전 값(189.1° ± 9.2°)으로 되돌리면 제목만 가운데 있고 경기장은 기울어진
   * "기울어진 사진"이 된다 — 눈으로만 잡히는 결함이라 수치로 못을 박는다.
   */
  it('정면 대칭 — 호의 중심은 골대 뒤 180°, 진폭은 ±5° 이내', () => {
    expect(LANDING_CAMERA.arcCenter).toBeCloseTo(Math.PI, 10)
    expect(LANDING_CAMERA.arcAmp).toBeLessThanOrEqual(0.088) // 5.04°
    // t=0(정지 컷·reduced-motion이 그리는 유일한 프레임)은 중심선 위에 정확히 선다.
    const p = landingCameraAt(0)
    expect(Math.abs(p.z)).toBeLessThan(1e-9)
    expect(p.x).toBeLessThan(0) // 골대 뒤(−x)에서 피치를 바라본다
  })

  it('결정론 — 같은 t는 항상 같은 좌표', () => {
    for (const t of [0, 7.5, 63.25, 512]) {
      expect(landingCameraAt(t)).toEqual(landingCameraAt(t))
    }
  })

  it('호는 마스트 없는 구간(142.3°~217.7°) 안에 갇혀 있다', () => {
    const lo = Math.atan2(MAST_Z, -MAST_X) // 142.3°
    const hi = 2 * Math.PI - lo // 217.7°
    let min = Infinity
    let max = -Infinity
    for (const t of TIMES) {
      const a = azimuth(landingCameraAt(t))
      min = Math.min(min, a)
      max = Math.max(max, a)
    }
    // 0.2rad(11.5°)은 "방위각만 피했다"가 아니라 여유까지 확인하기 위한 완충이다.
    expect(min).toBeGreaterThan(lo + 0.2)
    expect(max).toBeLessThan(hi - 0.2)
  })

  it('어떤 t·종횡비에서도 가까운 조명탑이 프레임에 들어오지 않는다', () => {
    // 표본별 expect는 수백만 번 호출돼 테스트가 30초씩 걸린다 — 최솟값만 모아 한 번 단언한다.
    const samples = MASTS.map(mastSamples)
    let worst = Infinity
    let nearSeen = 0
    for (const t of TIMES) {
      const b = basisAt(t)
      for (let i = 0; i < MASTS.length; i++) {
        const m = MASTS[i]
        if (Math.hypot(m.x - b.eye.x, m.z - b.eye.z) > NEAR_D) continue
        nearSeen++
        for (const s of samples[i]) {
          const n = ndc(b, s, MAX_ASPECT)
          if (n === null) continue // 카메라 뒤 = 화면 밖
          // 수평으로 완전히 벗어나 있어야 한다. 세로로만 벗어나면 카메라가 조금만
          // 기울어도 마스트가 다시 프레임을 세로로 가로지른다.
          worst = Math.min(worst, Math.abs(n[0]))
        }
      }
    }
    // 가까운 탑이 한 번도 없었다면 검사 자체가 헛돈 것이다(NEAR_D를 잘못 잡은 경우).
    expect(nearSeen).toBeGreaterThan(TIMES.length)
    expect(worst).toBeGreaterThan(1.2)
  })

  it('먼 쪽 조명탑 2기는 프레임 안에 남는다 — halo가 3D의 증거다', () => {
    for (const t of [0, PERIOD / 4, PERIOD / 2, (3 * PERIOD) / 4]) {
      const b = basisAt(t)
      const inFrame = MASTS.filter((m) => {
        const n = ndc(b, { x: m.x, y: 43, z: m.z }, 16 / 9)
        return n !== null && Math.abs(n[0]) < 1 && Math.abs(n[1]) < 1
      })
      expect(inFrame).toHaveLength(2)
    }
  })

  it('멀미 방지 — 최대 각속도가 예전 풀 오빗(0.03rad/s)의 1/3 이하다', () => {
    let maxOmega = 0
    for (const t of TIMES) {
      const p0 = landingCameraAt(t)
      const p1 = landingCameraAt(t + 0.05)
      // 두 방위각의 차를 외적/내적으로 구한다 — π를 넘어가도 래핑되지 않는다.
      const d = Math.abs(Math.atan2(p0.x * p1.z - p0.z * p1.x, p0.x * p1.x + p0.z * p1.z))
      maxOmega = Math.max(maxOmega, d / 0.05)
    }
    expect(maxOmega).toBeLessThan(0.01)
  })
})
