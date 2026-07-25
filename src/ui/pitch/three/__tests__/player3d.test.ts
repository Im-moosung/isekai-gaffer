// src/ui/pitch/three/__tests__/player3d.test.ts
// 1부: 순수 포즈 수학(three 무의존).
// 2부: 리그 조립·구동 — **real three를 node에서 로드**해 검증한다. WebGL 컨텍스트 없이도
//      씬 그래프·행렬·바운딩박스는 전부 계산되므로 yaw 규약·캐시 공유·접지·전환 팝을
//      실측할 수 있다(렌더러만 만들지 않는다). canvas가 없는 환경이라 등번호 텍스처
//      폴백 경로도 함께 검증된다.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { createPlayer, disposePlayerCaches } from '../player3d'
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

  it('진폭이 실제로 속도에 비례한다(상수 진폭이면 실패하는 비율 단언)', () => {
    // φ=π/2는 스윙 최대 지점. 바이어스 항이 아니라 스윙 항이 커져야 한다.
    const fast = gaitAngles(8, Math.PI / 2).hipL
    const slow = gaitAngles(1, Math.PI / 2).hipL
    expect(fast / slow).toBeGreaterThan(2)
    // 힙 진폭은 보폭(strideLength)에 연동된다 — 접지 슬립을 없애는 핵심 관계
    const ampAt = (v: number): number => (gaitAngles(v, Math.PI / 2).hipL - gaitAngles(v, 0).hipL) / 1
    expect(ampAt(8) / ampAt(2)).toBeCloseTo(strideLength(8) / strideLength(2), 6)
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

  it('바운스는 절대 음수가 되지 않는다(발이 잔디를 파고들지 않게)', () => {
    for (const s of SPEEDS) {
      for (let p = 0; p < TAU; p += TAU / 180) {
        expect(gaitAngles(s, p).bounce).toBeGreaterThanOrEqual(0)
      }
    }
    // 디딤 중간(위상 0·π)에서 정확히 0 — 이때 발이 지면에 닿는다
    expect(gaitAngles(7, 0).bounce).toBeCloseTo(0, 9)
    expect(gaitAngles(7, Math.PI).bounce).toBeCloseTo(0, 9)
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

  it('접지 중 발의 대지 속도가 몸통 속도 대비 6% 이내다(풋 스케이팅 회귀)', () => {
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
      const floor = Math.min(...frames.flatMap((f) => f.y))
      let sum = 0
      let n = 0
      for (let i = 1; i < frames.length; i++) {
        for (let k = 0; k < feet.length; k++) {
          // 실제로 땅에 붙어 있는 프레임만(최저점 +2cm 이내)
          if (frames[i].y[k] <= floor + 0.02 && frames[i - 1].y[k] <= floor + 0.02) {
            sum += Math.abs(frames[i].x[k] - frames[i - 1].x[k]) / DT / v
            n++
          }
        }
      }
      return sum / Math.max(1, n)
    }
    for (const v of [3, 5, 8]) expect(measure(v)).toBeLessThan(0.06)
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
    const seq = jointSteps(SEQ, 100)
    // 블렌딩이 없으면 run→celebrate 2.1, dive→idle 2.2 rad까지 튄다
    expect(seq.transition).toBeLessThanOrEqual(2 * base)
    expect(seq.transition).toBeLessThan(0.3)
  })

  it('시퀀스 전 구간에서 프레임 간 변화가 0.5rad 이하다(킥 스윙 포함)', () => {
    expect(jointSteps(SEQ, 100).all).toBeLessThan(0.5)
  })

  it('킥·세리머니 중에도 위상이 계속 적분돼 러닝 복귀가 매끄럽다', () => {
    const rig = createPlayer(THREE, KIT)
    let t = 0
    for (let i = 0; i < 60; i++) rig.apply(poseOf({ speed: 7 }), (t += DT))
    // 킥 1초 동안 위상이 멈춰 있으면 복귀 프레임에서 다리가 튄다
    for (let i = 0; i < 60; i++) rig.apply(poseOf({ action: 'kick', speed: 1, actionT: i / 59 }), (t += DT))
    for (let i = 0; i < 40; i++) rig.apply(poseOf({ speed: 7 }), (t += DT))
    // 블렌딩이 끝난 뒤에도 러닝 사이클이 살아 있어야 한다
    const before: number[] = []
    rig.root.children[1].traverse((o) => before.push(o.rotation.z))
    rig.apply(poseOf({ speed: 7 }), (t += DT))
    const after: number[] = []
    rig.root.children[1].traverse((o) => after.push(o.rotation.z))
    const moved = before.some((v, i) => Math.abs(v - after[i]) > 1e-4)
    expect(moved).toBe(true)
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
