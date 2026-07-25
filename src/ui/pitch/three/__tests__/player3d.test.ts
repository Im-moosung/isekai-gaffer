// src/ui/pitch/three/__tests__/player3d.test.ts
// player3d의 "순수 포즈 수학"만 테스트한다(three 무의존 — node 환경에서 실행).
// 리그 조립(createPlayer)은 WebGL/three 인스턴스가 필요하므로 여기서 다루지 않는다.
import { describe, it, expect } from 'vitest'
import {
  TAU,
  SPRINT_SPEED,
  CELEBRATE_PERIOD,
  CELEBRATE_JUMP,
  gaitAngles,
  kickAngles,
  celebrateOffset,
  diveAngles,
  strideLength,
  advancePhase,
  hash01,
  shade,
  mixColor,
  luminance,
  contrastOn,
} from '../player3d'

/** 위상 스윕(결정론 샘플) */
const PHASES = Array.from({ length: 24 }, (_, i) => (i / 24) * TAU)
const SPEEDS = [0, 0.5, 1.4, 3, 5, 7, 8, 12]

describe('gaitAngles — 좌우 대칭', () => {
  it('오른다리는 왼다리의 정확히 반대 위상(phase+π)이다', () => {
    for (const p of PHASES) {
      const a = gaitAngles(6, p)
      const b = gaitAngles(6, p + Math.PI)
      expect(a.hipR).toBeCloseTo(b.hipL, 12)
      expect(a.kneeR).toBeCloseTo(b.kneeL, 12)
      expect(a.shoulderR).toBeCloseTo(b.shoulderL, 12)
      expect(a.elbowR).toBeCloseTo(b.elbowL, 12)
    }
  })

  it('팔은 같은 쪽 다리와 교차한다(부호 반대)', () => {
    for (const p of PHASES) {
      const g = gaitAngles(7, p)
      // 스윙 성분이 충분히 클 때만(바이어스로 부호가 흐려지는 구간 제외)
      if (Math.abs(g.hipL) > 0.25) expect(Math.sign(g.shoulderL)).toBe(-Math.sign(g.hipL))
      if (Math.abs(g.hipR) > 0.25) expect(Math.sign(g.shoulderR)).toBe(-Math.sign(g.hipR))
    }
  })

  it('양 다리 위상차 때문에 두 힙이 동시에 같은 방향으로 최대가 되지 않는다', () => {
    for (const p of PHASES) {
      const g = gaitAngles(8, p)
      expect(Math.abs(g.hipL + g.hipR)).toBeLessThan(0.5) // 바이어스 합만 남는다
    }
  })
})

describe('gaitAngles — 속도 비례', () => {
  const swing = (speed: number): number =>
    Math.max(...PHASES.map((p) => Math.abs(gaitAngles(speed, p).hipL)))

  it('속도가 높을수록 힙 스윙 진폭이 커진다', () => {
    const amps = [0, 2, 4, 6, 8].map(swing)
    for (let i = 1; i < amps.length; i++) expect(amps[i]).toBeGreaterThan(amps[i - 1])
  })

  it('속도 0에서도 최소 진폭이 남아 "제자리 걸음"이 얼어붙지 않는다', () => {
    expect(swing(0)).toBeGreaterThan(0.05)
  })

  it('전경 기울기(lean)는 속도에 단조 증가한다', () => {
    const leans = [0, 1, 3, 5, 8].map((s) => gaitAngles(s, 0).lean)
    for (let i = 1; i < leans.length; i++) expect(leans[i]).toBeGreaterThan(leans[i - 1])
    expect(gaitAngles(0, 0).lean).toBeCloseTo(0, 6)
  })

  it('SPRINT_SPEED 초과 속도는 포화된다(같은 결과)', () => {
    for (const p of PHASES) {
      expect(gaitAngles(SPRINT_SPEED, p)).toEqual(gaitAngles(SPRINT_SPEED * 5, p))
    }
  })
})

describe('gaitAngles — 범위 클램프', () => {
  it('모든 속도·위상에서 관절 각이 해부학적 범위 안에 있다', () => {
    for (const s of SPEEDS) {
      for (const p of PHASES) {
        const g = gaitAngles(s, p)
        for (const hip of [g.hipL, g.hipR]) expect(Math.abs(hip)).toBeLessThanOrEqual(1.2)
        for (const knee of [g.kneeL, g.kneeR]) {
          expect(knee).toBeLessThanOrEqual(0) // 무릎은 뒤로만 굽는다
          expect(knee).toBeGreaterThanOrEqual(-1.9)
        }
        for (const sh of [g.shoulderL, g.shoulderR]) expect(Math.abs(sh)).toBeLessThanOrEqual(1.2)
        for (const el of [g.elbowL, g.elbowR]) {
          expect(el).toBeGreaterThanOrEqual(0) // 팔꿈치는 앞으로만 굽는다
          expect(el).toBeLessThanOrEqual(1.8)
        }
        expect(Math.abs(g.bounce)).toBeLessThanOrEqual(0.12)
        expect(g.lean).toBeGreaterThanOrEqual(0)
        expect(g.lean).toBeLessThanOrEqual(0.45)
        expect(Math.abs(g.roll)).toBeLessThanOrEqual(0.15)
        expect(Math.abs(g.twist)).toBeLessThanOrEqual(0.3)
        for (const v of Object.values(g)) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('음수 속도도 안전하게 0으로 취급한다', () => {
    expect(gaitAngles(-5, 1.2)).toEqual(gaitAngles(0, 1.2))
  })
})

describe('gaitAngles — 위상 연속성·주기', () => {
  it('phase와 phase+TAU는 같은 포즈(연속 루프)', () => {
    for (const p of PHASES) {
      const a = gaitAngles(6, p)
      const b = gaitAngles(6, p + TAU)
      expect(a.hipL).toBeCloseTo(b.hipL, 9)
      expect(a.kneeL).toBeCloseTo(b.kneeL, 9)
      expect(a.bounce).toBeCloseTo(b.bounce, 9)
    }
  })

  it('위상이 조금 변하면 각도도 조금만 변한다(튐 없음)', () => {
    const d = 0.01
    for (const p of PHASES) {
      const a = gaitAngles(8, p)
      const b = gaitAngles(8, p + d)
      expect(Math.abs(a.hipL - b.hipL)).toBeLessThan(0.05)
      expect(Math.abs(a.kneeL - b.kneeL)).toBeLessThan(0.05)
    }
  })

  it('바운스는 한 스트라이드에 두 번(주기 π) 반복된다', () => {
    for (const p of PHASES) {
      expect(gaitAngles(7, p).bounce).toBeCloseTo(gaitAngles(7, p + Math.PI).bounce, 9)
    }
  })

  it('결정론: 같은 입력은 항상 같은 객체 값', () => {
    expect(gaitAngles(5.5, 1.234)).toEqual(gaitAngles(5.5, 1.234))
  })
})

describe('kickAngles', () => {
  const SAMPLES = Array.from({ length: 101 }, (_, i) => i / 100)

  it('t=0은 중립(스윙 0), t=1은 거의 중립으로 복귀', () => {
    expect(kickAngles(0).hipKick).toBeCloseTo(0, 9)
    expect(kickAngles(0).torsoLean).toBeCloseTo(0, 9)
    expect(Math.abs(kickAngles(1).hipKick)).toBeLessThan(0.05)
    expect(Math.abs(kickAngles(1).torsoLean)).toBeLessThan(0.05)
  })

  it('백스윙 구간은 단조 감소(다리가 뒤로)', () => {
    let prev = Infinity
    for (let t = 0; t <= 0.32; t += 0.01) {
      const h = kickAngles(t).hipKick
      expect(h).toBeLessThanOrEqual(prev + 1e-9)
      prev = h
    }
    expect(kickAngles(0.32).hipKick).toBeLessThan(-0.5)
  })

  it('임팩트 구간은 단조 증가(뒤→앞 스윙)', () => {
    let prev = -Infinity
    for (let t = 0.32; t <= 0.58; t += 0.01) {
      const h = kickAngles(t).hipKick
      expect(h).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = h
    }
    expect(kickAngles(0.58).hipKick).toBeGreaterThan(1)
  })

  it('팔로스루 이후는 단조 감소(회복)', () => {
    let prev = Infinity
    for (let t = 0.58; t <= 1; t += 0.01) {
      const h = kickAngles(t).hipKick
      expect(h).toBeLessThanOrEqual(prev + 1e-9)
      prev = h
    }
  })

  it('앞 스윙이 뒤 스윙보다 크다(임팩트 후 팔로스루)', () => {
    const hs = SAMPLES.map((t) => kickAngles(t).hipKick)
    expect(Math.max(...hs)).toBeGreaterThan(Math.abs(Math.min(...hs)))
  })

  it('무릎은 항상 굴곡 방향(≤0)이고 범위 안이다', () => {
    for (const t of SAMPLES) {
      const k = kickAngles(t)
      expect(k.kneeKick).toBeLessThanOrEqual(0)
      expect(k.kneeKick).toBeGreaterThanOrEqual(-1.5)
      expect(k.kneeSupport).toBeLessThanOrEqual(0)
      expect(k.kneeSupport).toBeGreaterThanOrEqual(-0.8)
      expect(Math.abs(k.torsoLean)).toBeLessThanOrEqual(0.4)
      expect(Math.abs(k.armSwing)).toBeLessThanOrEqual(1.2)
      for (const v of Object.values(k)) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('임팩트 직전에 무릎이 펴진다(백스윙보다 덜 굽음)', () => {
    expect(kickAngles(0.55).kneeKick).toBeGreaterThan(kickAngles(0.3).kneeKick)
  })

  it('t 경계 밖은 클램프된다', () => {
    expect(kickAngles(-1)).toEqual(kickAngles(0))
    expect(kickAngles(2)).toEqual(kickAngles(1))
  })

  it('결정론', () => {
    expect(kickAngles(0.44)).toEqual(kickAngles(0.44))
  })
})

describe('celebrateOffset', () => {
  const TS = Array.from({ length: 60 }, (_, i) => (i / 60) * 3)

  it('점프 오프셋은 항상 비음수', () => {
    for (const t of [...TS, -2, -0.3, 12.7]) {
      expect(celebrateOffset(t).jump).toBeGreaterThanOrEqual(0)
    }
  })

  it('CELEBRATE_PERIOD 주기로 반복된다', () => {
    for (const t of TS) {
      const a = celebrateOffset(t)
      const b = celebrateOffset(t + CELEBRATE_PERIOD)
      expect(a.jump).toBeCloseTo(b.jump, 9)
      expect(a.arm).toBeCloseTo(b.arm, 9)
      expect(a.lean).toBeCloseTo(b.lean, 9)
    }
  })

  it('t=0에서 착지(0), 반주기에서 최고점', () => {
    expect(celebrateOffset(0).jump).toBeCloseTo(0, 9)
    expect(celebrateOffset(CELEBRATE_PERIOD / 2).jump).toBeCloseTo(CELEBRATE_JUMP, 9)
    expect(celebrateOffset(CELEBRATE_PERIOD).jump).toBeCloseTo(0, 9)
  })

  it('팔 올림 계수는 0~1이고 항상 높게 유지된다', () => {
    for (const t of TS) {
      const { arm } = celebrateOffset(t)
      expect(arm).toBeGreaterThanOrEqual(0.5)
      expect(arm).toBeLessThanOrEqual(1)
    }
  })

  it('결정론', () => {
    expect(celebrateOffset(1.11)).toEqual(celebrateOffset(1.11))
  })
})

describe('diveAngles', () => {
  const TS = Array.from({ length: 41 }, (_, i) => i / 40)

  it('롤은 ±90°를 넘지 않고 방향(dir) 부호를 따른다', () => {
    for (const t of TS) {
      const r = diveAngles(t, 1)
      const l = diveAngles(t, -1)
      expect(Math.abs(r.roll)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9)
      expect(l.roll).toBeCloseTo(-r.roll, 12)
      expect(r.roll).toBeGreaterThanOrEqual(0)
    }
  })

  it('t=0은 선 자세, 진행하면서 눕는다(롤 단조 증가)', () => {
    expect(diveAngles(0, 1).roll).toBeCloseTo(0, 9)
    expect(diveAngles(0, 1).lift).toBeCloseTo(0, 9)
    let prev = -Infinity
    for (const t of TS) {
      const r = diveAngles(t, 1).roll
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = r
    }
    expect(diveAngles(1, 1).roll).toBeCloseTo(Math.PI / 2, 6)
  })

  it('체공 높이는 비음수이고 중간에 정점, 끝에서 지면 접촉 높이로 내려온다', () => {
    for (const t of TS) expect(diveAngles(t, 1).lift).toBeGreaterThanOrEqual(0)
    const mid = diveAngles(0.5, 1).lift
    expect(mid).toBeGreaterThan(diveAngles(1, 1).lift)
    expect(diveAngles(1, 1).lift).toBeGreaterThan(0) // 누운 몸통 두께만큼은 떠 있다
    expect(mid).toBeLessThanOrEqual(0.9)
  })

  it('팔은 뻗고 다리는 접히며 범위를 벗어나지 않는다', () => {
    for (const t of TS) {
      const d = diveAngles(t, 1)
      expect(d.armReach).toBeLessThanOrEqual(0)
      expect(d.armReach).toBeGreaterThanOrEqual(-2.6)
      expect(d.tuck).toBeLessThanOrEqual(0)
      expect(d.tuck).toBeGreaterThanOrEqual(-0.9)
      for (const v of Object.values(d)) expect(Number.isFinite(v)).toBe(true)
    }
  })

  it('t 경계 밖 클램프 + dir 0은 안전하게 처리', () => {
    expect(diveAngles(-1, 1)).toEqual(diveAngles(0, 1))
    expect(diveAngles(9, 1)).toEqual(diveAngles(1, 1))
    expect(Number.isFinite(diveAngles(0.5, 0).roll)).toBe(true)
  })

  it('결정론', () => {
    expect(diveAngles(0.37, -1)).toEqual(diveAngles(0.37, -1))
  })
})

describe('strideLength / advancePhase', () => {
  it('스트라이드는 속도에 따라 길어진다(주기가 무한정 빨라지지 않게)', () => {
    const ls = [0, 2, 4, 6, 8].map(strideLength)
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeGreaterThan(ls[i - 1])
    expect(strideLength(0)).toBeGreaterThan(0)
  })

  it('위상은 항상 [0, TAU)로 감싸인다', () => {
    let p = 0
    for (let i = 0; i < 500; i++) {
      p = advancePhase(p, 7, 1 / 60)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(TAU)
    }
  })

  it('연속성: dt를 반으로 나눠 두 번 진행해도 같은 위상', () => {
    const once = advancePhase(0.5, 6, 0.02)
    const twice = advancePhase(advancePhase(0.5, 6, 0.01), 6, 0.01)
    expect(twice).toBeCloseTo(once, 9)
  })

  it('빠를수록 위상이 더 많이 진행한다', () => {
    const slow = advancePhase(0, 1, 0.05)
    const fast = advancePhase(0, 7, 0.05)
    expect(fast).toBeGreaterThan(slow)
  })

  it('속도 0에서도 최소 보행 위상은 진행한다(정지 프리즈 방지)', () => {
    expect(advancePhase(0, 0, 0.05)).toBeGreaterThan(0)
  })

  it('dt는 음수·과대값에서 클램프된다', () => {
    expect(advancePhase(1.3, 6, -1)).toBe(1.3)
    expect(advancePhase(0, 6, 100)).toEqual(advancePhase(0, 6, 0.1))
  })

  it('결정론', () => {
    expect(advancePhase(2.1, 4.4, 0.016)).toEqual(advancePhase(2.1, 4.4, 0.016))
  })
})

describe('결정론 유틸 (Math.random·Date 미사용)', () => {
  it('hash01은 0~1 범위의 결정론 해시', () => {
    for (const id of ['home-1', 'home-2', 'away-11', '', 'GK']) {
      const h = hash01(id)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
      expect(h).toBe(hash01(id))
    }
  })

  it('hash01은 서로 다른 id에 서로 다른 값을 준다(22명 충돌 없음)', () => {
    const ids = Array.from({ length: 22 }, (_, i) => `${i < 11 ? 'home' : 'away'}-${i % 11}`)
    const vals = new Set(ids.map(hash01))
    expect(vals.size).toBe(22)
  })

  it('shade는 채널을 0~255로 클램프한다', () => {
    expect(shade(0x336699, 1)).toBe(0x336699)
    expect(shade(0xffffff, 2)).toBe(0xffffff)
    expect(shade(0x804020, 0)).toBe(0x000000)
    const dark = shade(0x808080, 0.5)
    expect((dark >> 16) & 255).toBe(64)
  })

  it('mixColor 양끝은 원본, 중간은 평균', () => {
    expect(mixColor(0x000000, 0xffffff, 0)).toBe(0x000000)
    expect(mixColor(0x000000, 0xffffff, 1)).toBe(0xffffff)
    expect(mixColor(0x000000, 0xffffff, 0.5)).toBe(0x808080)
  })

  it('luminance / contrastOn — 밝은 킷엔 어두운 번호, 어두운 킷엔 흰 번호', () => {
    expect(luminance(0xffffff)).toBeCloseTo(1, 6)
    expect(luminance(0x000000)).toBeCloseTo(0, 6)
    expect(contrastOn(0xffffff)).not.toBe(contrastOn(0x101820))
    expect(luminance(contrastOn(0xffffff))).toBeLessThan(0.5)
    expect(luminance(contrastOn(0x101820))).toBeGreaterThan(0.5)
  })
})
