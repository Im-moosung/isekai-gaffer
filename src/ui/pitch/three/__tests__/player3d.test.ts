// src/ui/pitch/three/__tests__/player3d.test.ts
// 1부: 순수 포즈 수학(three 무의존).
// 2부: 리그 조립·구동 — **real three를 node에서 로드**해 검증한다. WebGL 컨텍스트 없이도
//      씬 그래프·행렬·바운딩박스는 전부 계산되므로 yaw 규약·캐시 공유·접지·전환 팝을
//      실측할 수 있다(렌더러만 만들지 않는다). canvas가 없는 환경이라 등번호 텍스처
//      폴백 경로도 함께 검증된다.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createPlayer, disposePlayerCaches } from '../player3d'
import { diveHandLocal } from '../pose'
import { DIVE_LAY_U } from '../movement'
import type { PlayerPose } from '../types'
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
  gaitFoot,
  hash01,
  shade,
  mixColor,
  luminance,
  contrastOn,
  rgbToHsl,
  hslToRgb,
  deepKit,
  kitInk,
  ankleFromLeg,
  solveLeg,
  shadowFalloff,
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

  // 갱신(B-2): 예전 계약은 "팔은 같은 쪽 **힙 각도**와 부호가 반대"였다. 접지 역기구학을
  // 도입한 뒤 힙 각도는 무릎 굴곡 때문에 사이클 대부분에서 양수로 치우친다(실제 러너도
  // 그렇다). 교차 스윙의 실제 의미는 "팔이 같은 쪽 **발의 전후 위치**와 반대"이므로
  // 그 쪽으로 옮긴다 — 발 위치가 이제 정본이기 때문이다.
  it('팔은 같은 쪽 발의 전후 위치와 교차한다(부호 반대)', () => {
    for (const p of PHASES) {
      const g = gaitAngles(7, p)
      const fl = gaitFoot(7, p)
      const fr = gaitFoot(7, p + Math.PI)
      if (Math.abs(fl.fx) > 0.05) expect(Math.sign(g.shoulderL)).toBe(-Math.sign(fl.fx))
      if (Math.abs(fr.fx) > 0.05) expect(Math.sign(g.shoulderR)).toBe(-Math.sign(fr.fx))
    }
  })

  // 갱신(B-2): 예전 계약 |hipL + hipR| < 0.5은 "힙 각이 0을 중심으로 대칭 진동한다"는
  // 낡은 사인파 모델의 부산물이었다. 두 다리가 한 몸처럼 움직이는 버그를 잡는 게 원래
  // 의도이므로, 그 의도를 직접 만족하는 **접지 배타성**으로 옮긴다.
  it('두 다리는 반주기 어긋나 있어 접지 구간이 절반 이상 겹치지 않는다', () => {
    for (const s of [1, 3, 6, 8]) {
      let both = 0
      let some = 0
      for (let p = 0; p < TAU; p += TAU / 360) {
        const l = gaitFoot(s, p).grounded
        const r = gaitFoot(s, p + Math.PI).grounded
        if (l && r) both++
        if (l || r) some++
      }
      // 접지율 δ(속도 의존, 0.44→0.21)의 두 배가 "적어도 한 발" 구간이다
      expect(some).toBeGreaterThan(360 * 0.4)
      expect(both).toBeLessThan(360 * 0.1) // 두 발이 동시에 디딤인 구간은 거의 없다
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

  // 갱신(B-2): 예전에는 "힙 각 진폭 ∝ strideLength"가 미끄러짐 방지의 근사 관계였다
  // (힙 각을 사인파로 두고 진폭을 보폭에 맞추는 방식). 이제는 **발 궤적**이 보폭에서
  // 직접 유도되므로, 검증 지점을 근사 관계가 아니라 그 정의식으로 옮긴다.
  it('접지 구간의 발 전후 이동이 정확히 보폭만큼이다(정의식)', () => {
    for (const v of [1, 3, 6, 8]) {
      const f = gaitFoot(v, Math.PI)
      expect(f.grounded).toBe(true)
      expect(f.fx).toBeCloseTo(0, 12) // 접지 중간에서 발이 힙 바로 아래
      // 위상 0.3rad 진행 = 발이 뒤로 0.3·L/2π 이동(접지 구간 반각은 최소 0.66rad).
      // 이것이 "미끄러지지 않는다"의 정의다 — 위상은 이동거리/보폭으로 적분되므로
      // 이 기울기가 곧 발의 대지 속도 0을 뜻한다.
      const d = 0.3
      const back = gaitFoot(v, Math.PI + d).fx - f.fx
      expect(gaitFoot(v, Math.PI + d).grounded).toBe(true)
      expect(back).toBeCloseTo((-d * strideLength(v)) / TAU, 12)
    }
    // 도달거리 E는 속도(=보폭)에 따라 커진다 — 상수 보폭이면 실패한다
    const reach = (v: number): number => Math.abs(gaitFoot(v, Math.PI + 0.5).fx)
    expect(reach(8)).toBeGreaterThan(reach(1) * 1.5)
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

  // 갱신(B-2): 예전 계약은 "bounce ≥ 0, 디딤 중간에서 정확히 0"이었다. 그 부호 규약은
  // 관통 방지 수단이었는데, 이제 관통은 접지 역기구학이 막는다(발을 y=0에 직접 놓는다).
  // 반대로 실제 러닝의 COM은 **디딤 중간에서 가장 낮고 체공에서 가장 높다** — 옛 규약은
  // 그 부호가 뒤집혀 있었다. 새 계약은 그 물리를 단언한다.
  it('골반은 디딤 중간에서 최저, 체공에서 최고다(COM 궤적 부호)', () => {
    for (const s of SPEEDS) {
      for (let p = 0; p < TAU; p += TAU / 180) {
        const b = gaitAngles(s, p).bounce
        expect(b).toBeLessThanOrEqual(1e-12) // 선 자세보다 높아지지 않는다
        expect(gaitAngles(s, p).bob).toBeGreaterThanOrEqual(0)
      }
    }
    // 디딤 중간(위상 0·π)이 최저, 체공(±π/2)이 최고
    const low = gaitAngles(7, Math.PI).bounce
    const high = gaitAngles(7, Math.PI / 2).bounce
    expect(low).toBeLessThan(high)
    expect(gaitAngles(7, 0).bounce).toBeCloseTo(low, 9)
    expect(gaitAngles(7, 0).bob).toBeCloseTo(0, 9)
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
      // 갱신(B-2): 디딤 다리 관절각(hipSupport·kneeSupport)은 접지 IK가 대신 푼다.
      // kickAngles는 하중(plant)만 내보내며, 그 값이 0~1을 벗어나면 IK 입력이 깨진다.
      expect(k.plant).toBeGreaterThanOrEqual(0)
      expect(k.plant).toBeLessThanOrEqual(1)
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
    // 옆으로 누우면 어깨·팔(로컬 z ±0.195)이 아래로 내려온다. 그 반폭을 못 띄우면
    // 몸이 잔디를 파고든다 — 실측으로 0.35가 되어야 양방향 클리어런스 ≥ 0.
    expect(diveAngles(1, 1).lift).toBeGreaterThan(0.25)
    expect(mid).toBeLessThanOrEqual(0.95)
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

// ─────────────────────────────────────────────────────────────────────────────
// 2부: real three 리그 검증 (node, WebGL 없이 씬 그래프만 계산)
// ─────────────────────────────────────────────────────────────────────────────

const KIT = { kit: 0xc8102e, accent: 0xffffff, number: 9, isGk: false }
const DT = 1 / 60

function poseOf(over: Partial<PlayerPose> = {}): PlayerPose {
  return {
    id: 'home-9',
    side: 'home',
    number: 9,
    x: 0,
    z: 0,
    yaw: 0,
    speed: 6,
    action: 'run',
    actionT: 0,
    ...over,
  }
}

/** 리그 안의 모든 메시(컨택트 섀도우 제외) 월드 바운딩박스. */
function bodyBox(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true)
  const box = new THREE.Box3()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    const type = (m.geometry as THREE.BufferGeometry | undefined)?.type
    if (m.isMesh && type !== 'CircleGeometry' && type !== 'PlaneGeometry') box.expandByObject(m)
  })
  return box
}

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh) out.push(m)
  })
  return out
}

describe('createPlayer — 좌표계 계약(yaw)', () => {
  it('root의 로컬 +X(정면)가 월드 (cos yaw, sin yaw)로 향한다', () => {
    const rig = createPlayer(THREE, KIT)
    for (const yaw of [0, Math.PI / 2, 0.7, -1.9, Math.PI]) {
      rig.apply(poseOf({ yaw, x: 12, z: -5, action: 'idle', speed: 0 }), 1)
      rig.root.updateMatrixWorld(true)
      const origin = rig.root.getWorldPosition(new THREE.Vector3())
      const fwd = rig.root.localToWorld(new THREE.Vector3(1, 0, 0)).sub(origin).normalize()
      expect(fwd.x).toBeCloseTo(Math.cos(yaw), 6)
      expect(fwd.z).toBeCloseTo(Math.sin(yaw), 6)
      expect(fwd.y).toBeCloseTo(0, 6)
    }
  })

  it('root.position은 pose의 월드 XZ에 정확히 놓인다(높이는 리그 내부가 담당)', () => {
    const rig = createPlayer(THREE, KIT)
    rig.apply(poseOf({ x: -33.5, z: 21.25 }), 1)
    expect(rig.root.position.x).toBeCloseTo(-33.5, 9)
    expect(rig.root.position.y).toBeCloseTo(0, 9)
    expect(rig.root.position.z).toBeCloseTo(21.25, 9)
  })
})

describe('createPlayer — 공유 캐시·폴백', () => {
  it('22명을 두 번 배치해도 새 지오메트리가 생기지 않는다', () => {
    const make = (i: number): ReturnType<typeof createPlayer> =>
      createPlayer(THREE, {
        kit: i < 11 ? 0xc8102e : 0x1b3a8f,
        accent: i < 11 ? 0xffffff : 0xf5d020,
        number: i + 1,
        isGk: i % 11 === 0,
      })
    const first = new Set<THREE.BufferGeometry>()
    for (let i = 0; i < 22; i++) for (const m of meshesOf(make(i).root)) first.add(m.geometry)

    // 2차 배치(다른 킷·번호) — 지오메트리는 전부 1차에서 재사용되어야 한다
    const fresh: THREE.BufferGeometry[] = []
    for (let i = 0; i < 22; i++) {
      for (const m of meshesOf(make(i + 40).root)) if (!first.has(m.geometry)) fresh.push(m.geometry)
    }
    expect(fresh).toHaveLength(0)
    expect(first.size).toBeLessThan(20) // 선수당 21메시인데 고유 지오메트리는 20종 미만
  })

  it('canvas가 없는 환경에서도 throw 없이 생성·구동된다(단색 폴백)', () => {
    expect(typeof document).toBe('undefined') // node 환경 전제
    const rig = createPlayer(THREE, { ...KIT, isGk: true })
    expect(() => rig.apply(poseOf({ action: 'dive', actionT: 0.5 }), 2)).not.toThrow()
    // 등번호 평면은 텍스처가 없어도 단색으로 존재한다
    const planes = meshesOf(rig.root).filter(
      (m) => (m.geometry as THREE.BufferGeometry).type === 'PlaneGeometry',
    )
    expect(planes.length).toBeGreaterThanOrEqual(1)
    expect(() => rig.dispose()).not.toThrow()
  })
})

describe('createPlayer — 접지·비율', () => {
  it('총신장 약 1.8m (7.5등신 근사)', () => {
    const rig = createPlayer(THREE, KIT)
    rig.apply(poseOf({ action: 'idle', speed: 0 }), 1)
    const box = bodyBox(rig.root)
    expect(box.max.y).toBeGreaterThan(1.7)
    expect(box.max.y).toBeLessThan(1.95)
  })

  it('러닝 한 사이클 내내 발이 잔디를 파고들지 않는다(bounce 부호 회귀)', () => {
    const rig = createPlayer(THREE, KIT)
    let t = 0
    let lowest = 99
    for (let i = 0; i < 200; i++) {
      t += DT
      rig.apply(poseOf({ speed: 7 }), t)
      lowest = Math.min(lowest, bodyBox(rig.root).min.y)
    }
    expect(lowest).toBeGreaterThan(-0.01) // 관통 없음
    expect(lowest).toBeLessThan(0.06) // 공중 부양도 아님
  })

  it('다이브·낙하 자세가 양방향 모두 지면 위에 있다(DIVE_GROUND 회귀)', () => {
    for (const id of ['gkA', 'gkB', 'gk-home', 'gk-away']) {
      const rig = createPlayer(THREE, { ...KIT, isGk: true })
      let lowest = 99
      for (let i = 0; i <= 30; i++) {
        rig.apply(poseOf({ id, action: 'dive', actionT: i / 30, speed: 1 }), 5 + i * DT)
        lowest = Math.min(lowest, bodyBox(rig.root).min.y)
      }
      rig.apply(poseOf({ id, action: 'down', actionT: 1, speed: 0 }), 9)
      lowest = Math.min(lowest, bodyBox(rig.root).min.y)
      expect(lowest).toBeGreaterThan(-0.01)
    }
  })

  // 갱신(B-2): 접지 판정 창을 "최저점 + 2cm 고정"에서 "발 이동 높이의 하위 10%"로
  // 바꾸고 기준을 6% → 5%로 조인다.
  //
  // 창을 바꾼 이유: 발이 실제로 y=0에 붙게 되자 고정 2cm 창이 **유각 프레임을 대량으로
  // 빨아들인다**(변경 전에는 발이 8~12mm 떠 있어 창이 상대적으로 좁았다). 저속일수록
  // 유각 클리어런스가 낮아 창의 대부분이 공중 프레임이 된다 — 즉 이 지표는 속도별로
  // 다른 것을 재고 있었다. 이동 높이 비례 창은 속도에 무관하게 "가장 낮은 구간"을 본다.
  //
  // 같은 계측식으로 잰 변경 전후(평균 슬립 / 몸통 속도):
  //   v=1 106.5% → 3.6% / v=3 5.1% → 0.1% / v=6 4.3% → 0.1%
  //   v=7.5 4.5% → 0.1% / v=9 10.9% → 0.1%
  // 남은 몇 %는 창에 섞인 이착지 직전후 프레임이며, 순수 입각 구간의 슬립은
  // 아래 "입각 구간에서 발의 대지 속도가 정확히 0" 테스트가 0으로 못박는다.
  it('접지 구간 발의 대지 속도가 몸통 속도 대비 5% 이내다(풋 스케이팅 회귀)', () => {
    const measure = (v: number): number => {
      const rig = createPlayer(THREE, KIT)
      const feet = meshesOf(rig.root).filter(
        (m) => (m.geometry as THREE.BufferGeometry).type === 'BoxGeometry',
      )
      let t = 0
      let x = 0
      for (let i = 0; i < 120; i++) {
        t += DT
        x += v * DT
        rig.apply(poseOf({ x, speed: v }), t) // 워밍업
      }
      const frames: { x: number[]; y: number[] }[] = []
      for (let i = 0; i < 240; i++) {
        t += DT
        x += v * DT
        rig.apply(poseOf({ x, speed: v }), t)
        rig.root.updateMatrixWorld(true)
        const p = feet.map((f) => f.getWorldPosition(new THREE.Vector3()))
        frames.push({ x: p.map((q) => q.x), y: p.map((q) => q.y) })
      }
      const ys = frames.flatMap((f) => f.y)
      const floor = Math.min(...ys)
      // 발이 오르내린 높이의 하위 10% — 속도에 무관하게 "가장 낮은 구간"을 고른다
      const win = floor + 0.1 * (Math.max(...ys) - floor)
      let sum = 0
      let n = 0
      for (let i = 1; i < frames.length; i++) {
        for (let k = 0; k < feet.length; k++) {
          if (frames[i].y[k] <= win && frames[i - 1].y[k] <= win) {
            sum += Math.abs(frames[i].x[k] - frames[i - 1].x[k]) / DT / v
            n++
          }
        }
      }
      return sum / Math.max(1, n)
    }
    for (const v of [1, 3, 6, 7.5, 9]) expect(measure(v)).toBeLessThan(0.05)
  })

  /**
   * 엄밀 접지 계약 — B-2의 핵심 산출물.
   *
   * movement가 하는 것과 **똑같이** 보폭 위상을 적분해 리그에 주입하고
   * (gaitPhase += v·dt / strideLength(v)), gaitFoot이 입각기라고 말하는 프레임에서만
   * 부츠의 월드 X 이동량을 잰다. 발이 땅에 붙어 있다면 이 값은 0이어야 한다 —
   * "미끄러짐이 줄었다"가 아니라 "0이다"가 계약이다.
   *
   * 허용 오차 1e-6 m/s의 근거: 궤적이 위상에 대해 정확히 선형이라 이론값이 0이고,
   * 남는 것은 배정밀도 반올림뿐이다(실측 최대 ~1e-13 m/s).
   * 두 계층이 다른 보폭 모델을 쓰면 그 차이가 곧바로 v·|1 - L₁/L₂|로 나타난다.
   */
  it('입각 구간에서 발의 대지 속도가 정확히 0이다(보폭 모델 통일 계약)', () => {
    for (const v of [1, 3, 6, 7.5, 9]) {
      const rig = createPlayer(THREE, KIT)
      const feet = meshesOf(rig.root).filter(
        (m) => (m.geometry as THREE.BufferGeometry).type === 'BoxGeometry',
      )
      const scale = rig.root.scale.x
      const L = strideLength(v)
      let t = 0
      let x = 0
      let ph = 0
      let prevX: number[] | null = null
      let prevG: boolean[] | null = null
      let worst = 0
      let samples = 0
      for (let i = 0; i < 600; i++) {
        t += DT
        x += v * DT
        ph = (ph + (v * DT) / L) % 1 // movement.computeFrame과 동일한 적분식
        rig.apply(poseOf({ x, speed: v, gaitPhase: ph }), t)
        rig.root.updateMatrixWorld(true)
        const phase = ph * TAU
        const g = [gaitFoot(v, phase, scale).grounded, gaitFoot(v, phase + Math.PI, scale).grounded]
        const cur = feet.map((f) => f.getWorldPosition(new THREE.Vector3()).x)
        if (i > 120 && prevX && prevG) {
          for (let k = 0; k < 2; k++) {
            if (g[k] && prevG[k]) {
              worst = Math.max(worst, Math.abs(cur[k] - prevX[k]) / DT)
              samples++
            }
          }
        }
        prevX = cur
        prevG = g
      }
      expect(samples).toBeGreaterThan(50) // 실제로 입각 프레임을 봤는지 확인
      expect(worst).toBeLessThan(1e-6)
    }
  })

  it('입각 중 부츠 바닥이 지면(y=0)에 붙어 있다', () => {
    for (const v of [1, 3, 6, 8]) {
      const rig = createPlayer(THREE, KIT)
      const feet = meshesOf(rig.root).filter(
        (m) => (m.geometry as THREE.BufferGeometry).type === 'BoxGeometry',
      )
      const scale = rig.root.scale.x
      let worst = 0
      for (let i = 0; i < 180; i++) {
        const ph = i / 180
        rig.apply(poseOf({ speed: v, gaitPhase: ph }), 10 + i * DT)
        rig.root.updateMatrixWorld(true)
        const phase = ph * TAU
        const g = [gaitFoot(v, phase, scale).grounded, gaitFoot(v, phase + Math.PI, scale).grounded]
        for (let k = 0; k < 2; k++) {
          if (!g[k]) continue
          const geo = feet[k].geometry as THREE.BufferGeometry
          geo.computeBoundingBox()
          const bb = geo.boundingBox!.clone().applyMatrix4(feet[k].matrixWorld)
          worst = Math.max(worst, Math.abs(bb.min.y))
        }
      }
      // 접지 오차는 0이어야 한다. 보행 롤은 상체에만 걸리므로 다리를 기울이지 않는다
      // (body에 걸면 편심 0.1575m × 롤 0.046rad = 7.2mm가 그대로 오차가 된다).
      // 남는 것은 부동소수 오차뿐이라 0.1mm면 충분하다.
      expect(worst).toBeLessThan(0.0001)
    }
  })

  it('movement가 준 gaitPhase를 그대로 소비한다(자체 적분하지 않는다)', () => {
    // 같은 gaitPhase면 프레임 이력·dt와 무관하게 같은 다리 자세여야 한다.
    const hips = (frames: number, phaseAt: (i: number) => number): number[] => {
      const rig = createPlayer(THREE, KIT)
      let t = 0
      for (let i = 0; i < frames; i++) {
        t += DT
        rig.apply(poseOf({ speed: 6, gaitPhase: phaseAt(i) }), t)
      }
      const body = rig.root.children.find((c) => c.type === 'Group')!
      return body.children
        .filter((c) => c.type === 'Group' && Math.abs(c.position.z) > 1e-9)
        .map((c) => c.rotation.z)
    }
    const a = hips(40, (i) => (0.31 + i * 0.017) % 1)
    const b = hips(90, (i) => (0.31 + (39 + (i - 89)) * 0.017 + 1) % 1) // 다른 이력, 같은 끝 위상
    expect(a).toHaveLength(2)
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 9)
    // 위상을 고정하면 다리가 멈춘다(자체 적분이 남아 있으면 계속 움직인다)
    const frozen = hips(60, () => 0.42)
    const frozen2 = hips(120, () => 0.42)
    for (let i = 0; i < frozen.length; i++) expect(frozen2[i]).toBeCloseTo(frozen[i], 12)
  })
})

describe('createPlayer — 액션 전환 블렌딩', () => {
  interface Step {
    action: PlayerPose['action']
    speed: number
    frames: number
  }

  /**
   * 시퀀스를 구동하며 프레임 간 관절 회전 변화(rad)를 잰다.
   * `transition` = 액션이 바뀐 직후 6프레임(= 전환 팝), `all` = 전 구간 최대.
   * root 자신(위치·yaw)은 제외한다.
   */
  function jointSteps(steps: Step[], startT: number): { all: number; transition: number } {
    const rig = createPlayer(THREE, KIT)
    let prev: number[] | null = null
    let all = 0
    let transition = 0
    let t = startT
    for (let s = 0; s < steps.length; s++) {
      const step = steps[s]
      for (let i = 0; i < step.frames; i++) {
        t += DT
        rig.apply(
          poseOf({
            action: step.action,
            speed: step.speed,
            actionT: i / Math.max(1, step.frames - 1),
          }),
          t,
        )
        const cur: number[] = []
        for (const child of rig.root.children) {
          child.traverse((o) => {
            cur.push(o.rotation.x, o.rotation.y, o.rotation.z)
          })
        }
        if (prev) {
          let step2 = 0
          for (let k = 0; k < cur.length; k++) step2 = Math.max(step2, Math.abs(cur[k] - prev[k]))
          all = Math.max(all, step2)
          if (s > 0 && i < 6) transition = Math.max(transition, step2)
        }
        prev = cur
      }
    }
    return { all, transition }
  }

  const SEQ: Step[] = [
    { action: 'run', speed: 7, frames: 40 },
    { action: 'celebrate', speed: 0, frames: 50 },
    { action: 'idle', speed: 0, frames: 30 },
    { action: 'run', speed: 6, frames: 30 },
    { action: 'kick', speed: 4, frames: 30 },
    { action: 'run', speed: 7, frames: 30 },
    { action: 'dive', speed: 2, frames: 30 },
    { action: 'idle', speed: 0, frames: 30 },
    { action: 'down', speed: 0, frames: 20 },
    { action: 'run', speed: 8, frames: 40 },
  ]

  it('액션 전환 직후 관절 변화가 러닝 연속 기준선의 2배를 넘지 않는다(팝 없음)', () => {
    const base = jointSteps([{ action: 'run', speed: 8, frames: 180 }], 0).all
    expect(base).toBeGreaterThan(0.05) // 러닝이 실제로 움직여야 의미 있는 기준선
    // 전환 순간의 보행 위상에 따라 팝 크기가 달라진다 → 한 주기를 스윕해 최악값을 본다
    let worstTransition = 0
    let worstAll = 0
    for (let k = 0; k < 12; k++) {
      const r = jointSteps(SEQ, 100 + (k / 12) * 0.5)
      worstTransition = Math.max(worstTransition, r.transition)
      worstAll = Math.max(worstAll, r.all)
    }
    // 블렌딩이 없으면 run→celebrate 2.1, dive→idle 2.2 rad까지 튄다
    expect(worstTransition).toBeLessThanOrEqual(2 * base)
    expect(worstTransition).toBeLessThan(0.4)
    // all에는 킥 임팩트 스윙(의도된 폭발적 동작)이 포함된다
    expect(worstAll).toBeLessThan(0.55)
  })

  it('킥 중에도 위상이 계속 적분된다(러닝만 하던 리그와 위상이 일치)', () => {
    // 같은 id·같은 속도열이면 위상은 시드부터 프레임까지 완전히 같아야 한다.
    // 위상 적분이 case 'run' 안으로 들어가면 킥 프레임만큼 위상이 뒤처진다.
    const KICK_FRAMES = 14 // v=6 보행주기(≈28프레임)의 절반 — 뒤처지면 위상이 반대가 된다
    const V = 6
    const hips = (steps: Step[]): number[] => {
      const rig = createPlayer(THREE, KIT)
      let t = 0
      for (const s of steps) {
        for (let i = 0; i < s.frames; i++) {
          t += DT
          rig.apply(
            poseOf({ action: s.action, speed: s.speed, actionT: i / Math.max(1, s.frames - 1) }),
            t,
          )
        }
      }
      const body = rig.root.children.find((c) => c.type === 'Group')!
      return body.children
        .filter((c) => c.type === 'Group' && Math.abs(c.position.z) > 1e-9)
        .map((c) => c.rotation.z)
    }
    const plain = hips([{ action: 'run', speed: V, frames: 40 + KICK_FRAMES + 40 }])
    const kicked = hips([
      { action: 'run', speed: V, frames: 40 },
      { action: 'kick', speed: V, frames: KICK_FRAMES },
      { action: 'run', speed: V, frames: 40 },
    ])
    expect(kicked).toHaveLength(2)
    for (let i = 0; i < plain.length; i++) expect(kicked[i]).toBeCloseTo(plain[i], 9)
    // 그 구간에서 위상이 실제로 크게 움직였음을 보인다(적분이 멈추면 값이 달라진다)
    const half = hips([{ action: 'run', speed: V, frames: 40 + 40 }])
    expect(Math.abs(half[0] - plain[0])).toBeGreaterThan(0.5)
  })

  it('재발동(actionT 되감김)에도 팝이 없다 — 다이브 연속 2회', () => {
    const rig = createPlayer(THREE, KIT)
    let prev: number[] | null = null
    let worst = 0
    let t = 50
    for (let rep = 0; rep < 2; rep++) {
      for (let i = 0; i < 20; i++) {
        t += DT
        rig.apply(poseOf({ action: 'dive', speed: 2, actionT: i / 19 }), t)
        const cur: number[] = []
        for (const child of rig.root.children) {
          child.traverse((o) => cur.push(o.rotation.x, o.rotation.y, o.rotation.z))
        }
        if (prev) {
          for (let k = 0; k < cur.length; k++) worst = Math.max(worst, Math.abs(cur[k] - prev[k]))
        }
        prev = cur
      }
    }
    expect(worst).toBeLessThan(0.5) // 가드가 없으면 2회차 첫 프레임에서 2.2rad
  })

  it('등장 첫 프레임부터 실제 속도의 자세를 취한다(smoothSpeed 시딩)', () => {
    // body의 자식 Group 중 좌우 오프셋이 0인 것이 몸통(힙 그룹은 z=±0.10)
    const torsoOf = (root: THREE.Object3D): THREE.Object3D => {
      const body = root.children.find((c) => c.type === 'Group')!
      return body.children.find((c) => c.type === 'Group' && Math.abs(c.position.z) < 1e-9)!
    }
    const fast = createPlayer(THREE, KIT)
    fast.apply(poseOf({ speed: 8 }), 0)
    // torso.rotation.z = -전경기울기. 시딩이 없으면 첫 프레임이 정지 자세(≈0)가 된다.
    expect(-torsoOf(fast.root).rotation.z).toBeCloseTo(gaitAngles(8, 0).lean, 6)
    expect(-torsoOf(fast.root).rotation.z).toBeGreaterThan(0.2)

    const slow = createPlayer(THREE, KIT)
    slow.apply(poseOf({ speed: 0, action: 'run' }), 0)
    expect(-torsoOf(slow.root).rotation.z).toBeCloseTo(0, 6)
  })
})

describe('disposePlayerCaches', () => {
  it('공유 캐시를 비워도 이후 생성이 정상 동작한다', () => {
    createPlayer(THREE, KIT)
    expect(() => disposePlayerCaches()).not.toThrow()
    const rig = createPlayer(THREE, KIT)
    expect(() => rig.apply(poseOf(), 1)).not.toThrow()
    expect(meshesOf(rig.root).length).toBeGreaterThan(15)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3부: 킷 팔레트 · 접지 그림자 (B-5)
// ─────────────────────────────────────────────────────────────────────────────

describe('HSL 변환', () => {
  it('rgb → hsl → rgb 왕복이 정확하다', () => {
    for (const c of [0xe63946, 0x4895ef, 0xd8ff3c, 0x000000, 0xffffff, 0x7f7f7f, 0x010203]) {
      const { h, s, l } = rgbToHsl(c)
      expect(hslToRgb(h, s, l)).toBe(c)
    }
  })

  it('무채색은 채도 0이고 명도가 밝기를 따른다', () => {
    expect(rgbToHsl(0x000000)).toEqual({ h: 0, s: 0, l: 0 })
    expect(rgbToHsl(0xffffff)).toEqual({ h: 0, s: 0, l: 1 })
  })

  it('hslToRgb는 범위 밖 입력을 감싸거나 잘라 항상 유효한 색을 낸다', () => {
    for (const [h, s, l] of [
      [1.7, -0.3, 0.5],
      [-0.4, 1.8, 0.5],
      [0.3, 0.5, 2],
      [0.3, 0.5, -1],
    ] as const) {
      const c = hslToRgb(h, s, l)
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(0xffffff)
    }
  })
})

describe('deepKit — 팀 보조색', () => {
  // 단순 shade()가 아니라 색상 보존 + 채도 유지여야 하는 이유: 야간 피치에서 두 팀의
  // 어두운 트림이 같은 탁한 회색으로 수렴하면 안 된다.
  it('색상(H)을 보존한다', () => {
    for (const c of [0xe63946, 0x4895ef, 0xf2383d, 0x147df5]) {
      expect(rgbToHsl(deepKit(c)).h).toBeCloseTo(rgbToHsl(c).h, 2)
    }
  })

  it('원색보다 어둡고 채도는 0.7 이상으로 유지된다', () => {
    for (const c of [0xe63946, 0x4895ef, 0xd8ff3c]) {
      const d = deepKit(c)
      expect(luminance(d)).toBeLessThan(luminance(c))
      expect(rgbToHsl(d).s).toBeGreaterThanOrEqual(0.7 - 1e-9)
      expect(rgbToHsl(d).l).toBeCloseTo(0.21, 2) // 8bit 양자화 오차 허용
    }
  })

  it('두 팀의 보조색이 서로 수렴하지 않는다(축소 시 팀 구분의 마지막 보루)', () => {
    const red = deepKit(0xe63946)
    const blue = deepKit(0x4895ef)
    // 채널 최대 차 — 회색으로 수렴하면 이 값이 작아진다
    const dr = Math.abs(((red >> 16) & 255) - ((blue >> 16) & 255))
    const db = Math.abs((red & 255) - (blue & 255))
    expect(Math.max(dr, db)).toBeGreaterThan(60)
  })
})

describe('kitInk — 등번호 색', () => {
  it('밝은 킷에는 잉크블랙, 어두운 킷에는 밝은 글자', () => {
    expect(luminance(kitInk(0xd8ff3c))).toBeLessThan(0.3) // GK 형광 → 검정
    expect(luminance(kitInk(0xe63946))).toBeGreaterThan(0.8)
    expect(luminance(kitInk(0x4895ef))).toBeGreaterThan(0.8)
  })

  it('따뜻한 킷에는 아이보리, 차가운 킷에는 순백', () => {
    expect(kitInk(0xe63946)).toBe(0xfff1d0) // 스칼렛 → 아이보리
    expect(kitInk(0x4895ef)).toBe(0xffffff) // 애저 → 흰색
  })
})

describe('ankleFromLeg — 접지 그림자용 순기구학', () => {
  it('solveLeg의 정확한 역함수다(도달 가능한 목표에 한해)', () => {
    let checked = 0
    for (const fx of [-0.4, -0.1, 0, 0.15, 0.45]) {
      for (const fy of [0.6, 0.75, 0.88]) {
        // 다리 길이를 넘는 목표는 solveLeg이 반경을 클램프하므로 왕복이 성립하지 않는다.
        if (Math.hypot(fx, fy) > 0.92) continue
        checked++
        const { hip, knee } = solveLeg(fx, fy)
        const back = ankleFromLeg(hip, knee)
        expect(back.fx).toBeCloseTo(fx, 9)
        expect(back.fy).toBeCloseTo(fy, 9)
      }
    }
    expect(checked).toBeGreaterThan(8)
  })

  it('도달 불가 목표는 클램프되어도 다리 길이를 넘지 않는다', () => {
    const { hip, knee } = solveLeg(0.5, 1.2)
    const { fx, fy } = ankleFromLeg(hip, knee)
    expect(Math.hypot(fx, fy)).toBeLessThanOrEqual(0.93)
  })
})

describe('shadowFalloff — 블롭 감쇠 곡선', () => {
  it('중심에서 최대, 가장자리에서 정확히 0', () => {
    for (const core of [0.18, 0.34, 0.55, 0.8]) {
      expect(shadowFalloff(0, core)).toBeCloseTo(0.95, 6)
      expect(shadowFalloff(1, core)).toBeCloseTo(0, 6)
    }
  })

  it('단조 감소한다(중간에 밝아지는 링이 생기면 그림자가 도넛이 된다)', () => {
    for (const core of [0.18, 0.55, 0.9]) {
      let prev = Infinity
      for (let i = 0; i <= 100; i++) {
        const v = shadowFalloff(i / 100, core)
        expect(v).toBeLessThanOrEqual(prev + 1e-9)
        expect(v).toBeGreaterThanOrEqual(0)
        prev = v
      }
    }
  })

  it('범위 밖 입력을 클램프한다', () => {
    expect(shadowFalloff(-1, 0.5)).toBeCloseTo(0.95, 6)
    expect(shadowFalloff(2, 0.5)).toBeCloseTo(0, 6)
  })
})

describe('접지 그림자 — 실제 발을 따라간다', () => {
  /** 리그의 그림자 블롭 3장(정점 알파 원판 = 유일한 비인덱스 BufferGeometry 메시). */
  const blobsOf = (root: THREE.Object3D): THREE.Mesh[] =>
    meshesOf(root).filter((m) => !!(m.geometry as THREE.BufferGeometry).getAttribute('color'))

  it('선수마다 발 블롭 2 + 질량 블롭 1을 가진다', () => {
    const rig = createPlayer(THREE, KIT)
    rig.apply(poseOf({ action: 'idle', speed: 0 }), 1)
    expect(blobsOf(rig.root)).toHaveLength(3)
  })

  it('블롭은 항상 지면 높이에 눕는다(몸이 기울어도)', () => {
    const rig = createPlayer(THREE, KIT)
    for (const action of ['run', 'idle', 'kick', 'celebrate', 'dive', 'down'] as const) {
      for (let i = 0; i <= 8; i++) {
        rig.apply(poseOf({ action, actionT: i / 8, speed: 5 }), 3 + i * DT)
        rig.root.updateMatrixWorld(true)
        for (const b of blobsOf(rig.root)) {
          // root.scale(체격 변주 0.965~1.035)이 걸리므로 정확히 0.02는 아니다.
          const y = b.getWorldPosition(new THREE.Vector3()).y
          expect(y).toBeGreaterThan(0.018)
          expect(y).toBeLessThan(0.022)
        }
      }
    }
  })

  it('발 블롭이 실제 부츠의 수평 위치를 따라간다(스케이팅 방지)', () => {
    const rig = createPlayer(THREE, KIT)
    let t = 0
    for (let i = 0; i < 40; i++) {
      t += DT
      rig.apply(poseOf({ speed: 6 }), t)
    }
    rig.root.updateMatrixWorld(true)
    const boots = meshesOf(rig.root)
      .filter((m) => (m.geometry as THREE.BufferGeometry).type === 'BoxGeometry')
      .map((m) => m.getWorldPosition(new THREE.Vector3()))
    const blobs = blobsOf(rig.root).map((m) => m.getWorldPosition(new THREE.Vector3()))
    // 각 부츠마다 수평거리 12cm 이내의 블롭이 있어야 한다(블롭은 발목 기준, 부츠는 앞쪽 오프셋).
    for (const boot of boots) {
      const best = Math.min(...blobs.map((b) => Math.hypot(b.x - boot.x, b.z - boot.z)))
      expect(best).toBeLessThan(0.12)
    }
  })

  it('발이 뜨면 블롭이 옅어지고 넓어진다(접지 순간만 진하다)', () => {
    const rig = createPlayer(THREE, KIT)
    const foot = (): { op: number; sx: number } => {
      const b = blobsOf(rig.root)
      // 질량 블롭은 x=0에 고정 — 발 블롭만 고른다
      const f = b.filter((m) => Math.abs(m.position.z) > 1e-6)
      const hi = f.reduce((a, m) => ((m.material as THREE.MeshBasicMaterial).opacity > a ? (m.material as THREE.MeshBasicMaterial).opacity : a), 0)
      const lo = f.reduce((a, m) => ((m.material as THREE.MeshBasicMaterial).opacity < a ? (m.material as THREE.MeshBasicMaterial).opacity : a), 1)
      const wide = f.reduce((a, m) => (m.scale.x > a ? m.scale.x : a), 0)
      return { op: hi - lo, sx: wide }
    }
    // 스프린트 중에는 한 발이 접지, 한 발이 체공 → 두 블롭의 불투명도 차가 벌어진다
    let t = 0
    let maxGap = 0
    let maxWide = 0
    for (let i = 0; i < 120; i++) {
      t += DT
      rig.apply(poseOf({ speed: 8 }), t)
      const f = foot()
      maxGap = Math.max(maxGap, f.op)
      maxWide = Math.max(maxWide, f.sx)
    }
    expect(maxGap).toBeGreaterThan(0.15) // 접지/체공이 확실히 구분된다
    // 서 있을 때보다 넓게 퍼진 순간이 있다
    rig.apply(poseOf({ action: 'idle', speed: 0 }), t + 1)
    expect(maxWide).toBeGreaterThan(foot().sx * 1.15)
  })

  it('dispose가 인스턴스 소유 그림자 머티리얼을 해제한다(공유 캐시에 없다)', () => {
    const rig = createPlayer(THREE, KIT)
    rig.apply(poseOf(), 1)
    const mats = blobsOf(rig.root).map((m) => m.material as THREE.MeshBasicMaterial)
    let disposed = 0
    for (const m of mats) m.addEventListener('dispose', () => disposed++)
    rig.dispose()
    expect(disposed).toBe(3)
  })
})

describe('★ diveHandLocal — 무브먼트와 렌더러가 같은 손을 본다', () => {
  /**
   * 무브먼트 레이어는 이 순기구학으로 "손이 어디 있는가"를 역산해 GK 몸통 자리를 정하고
   * (movement.gkDiveAnchor) 잡는 세이브에서 공을 손에 붙인다. 렌더러(player3d)의 리그가
   * 다른 팔을 그리면 그 순간 "공 따로 골키퍼 따로"가 된다.
   *
   * 아래 값은 실제 three 리그에 다이브 포즈를 적용해 손 메시의 월드 좌표를 읽어 얻은
   * 실측치다(tools/sim-audit/verify-fk.mjs, 오차 0.0000 m). 리그 치수·다이브 각을 바꾸면
   * 여기서 깨진다 — 그때 무브먼트 쪽 계약도 함께 봐야 한다는 뜻이다.
   */
  const CASES: [number, number, [number, number, number]][] = [
    [0.25, 1, [-0.495, 1.554, 0.668]],
    [0.4, 1, [-0.473, 1.388, 1.597]],
    [0.55, 1, [-0.401, 1.013, 1.804]],
    [1, 1, [-0.401, 0.519, 1.804]],
    [0.55, -1, [-0.401, 1.013, -1.804]],
  ]

  it('실제 three 리그가 만드는 손 위치와 일치한다', () => {
    for (const [t, dir, [x, y, z]] of CASES) {
      const l = diveHandLocal(t, dir)
      expect(l.x, `t=${t} dir=${dir} x`).toBeCloseTo(x, 3)
      expect(l.y, `t=${t} dir=${dir} y`).toBeCloseTo(y, 3)
      expect(l.z, `t=${t} dir=${dir} z`).toBeCloseTo(z, 3)
    }
  })

  it('다이브 방향이 손의 좌우만 뒤집는다(대칭)', () => {
    for (const t of [0.3, 0.55, 0.8, 1]) {
      const a = diveHandLocal(t, 1)
      const b = diveHandLocal(t, -1)
      expect(b.x).toBeCloseTo(a.x, 9)
      expect(b.y).toBeCloseTo(a.y, 9)
      expect(b.z).toBeCloseTo(-a.z, 9)
    }
  })

  it('완전 신전(DIVE_LAY_U)에서 손이 잔디 위에 있고 도달이 측방이다', () => {
    const l = diveHandLocal(DIVE_LAY_U, 1)
    expect(l.y).toBeGreaterThan(0.6) // 공을 쳐낼 수 있는 높이
    // 도달의 대부분이 측방(로컬 Z)이다 — 스칼라 반경 근사가 틀렸던 이유.
    expect(Math.abs(l.z)).toBeGreaterThan(Math.abs(l.x) * 3)
  })
})
