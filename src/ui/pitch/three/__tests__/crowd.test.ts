// crowd.ts 단위 테스트 — buildCrowd / crowdCapacity / personGeometry.
//
// scene.test.ts가 buildScene을 통한 통합 경로를 덮는 반면, 여기서는 모듈을 직접 불러
// **좌석 격자 공식·색 팔레트 지분·웨이브의 프레임 비용**이라는 세 가지 계약을 좁게 고정한다.
// crowd.ts는 canvas를 전혀 쓰지 않으므로(색은 전부 상수 팔레트에서 나온다) 이 파일에는
// 캔버스 스텁이 필요 없다.
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  ROW_STEP,
  SEAT_PITCH,
  buildCrowd,
  crowdCapacity,
  personGeometry,
  type CrowdOptions,
  type CrowdStand,
} from '../crowd'
import { PITCH_W, PITCH_H } from '../types'

// ── 테스트용 스탠드 레이아웃 ────────────────────────────────────
// scene.ts의 SIDES와 같은 규격(롱사이드 158m · 엔드 121m · 깊이 26m · 경사 0.5rad)을
// 직접 재현한다. scene.ts에서 import하지 않는 이유: 그 상수는 export되지 않으며,
// 여기서 필요한 것은 "현실적인 한 벌의 입력"이지 프로덕션 값 그 자체가 아니다.
const STAND_DEPTH = 26
const RAKE = 0.5
const STAND_H0 = 1.9
const SEAT_LIFT = 1.6 / 2 / Math.cos(RAKE)
const SIDE_INNER = PITCH_H / 2 + 7
const END_INNER = PITCH_W / 2 + 7
const SIDE_LEN = 2 * (END_INNER + STAND_DEPTH * 0.75)
const END_LEN = 2 * (SIDE_INNER + STAND_DEPTH * 0.75)

const SIDES: readonly CrowdStand[] = [
  { c: 1, s: 0, inner: SIDE_INNER, length: SIDE_LEN, bias: 'mix' },
  { c: -1, s: 0, inner: SIDE_INNER, length: SIDE_LEN, bias: 'mix' },
  { c: 0, s: 1, inner: END_INNER, length: END_LEN, bias: 'away' },
  { c: 0, s: -1, inner: END_INNER, length: END_LEN, bias: 'home' },
]

function opts(over: Partial<CrowdOptions> = {}): CrowdOptions {
  return {
    stands: SIDES,
    homeColor: 0xff0000,
    awayColor: 0x0000ff,
    standDepth: STAND_DEPTH,
    rake: RAKE,
    standH0: STAND_H0,
    seatLift: SEAT_LIFT,
    ...over,
  }
}

describe('crowdCapacity', () => {
  it('detail 1에서 4면 × round(길이/좌석피치) × floor(깊이/열간격)과 같다', () => {
    // 정원을 "목표 인원"이 아니라 **현실 좌석 치수**에서 유도한다는 것이 이 모듈의
    // 핵심 결정이다. 공식이 흔들리면 인스턴스 하나가 다시 사람 크기를 벗어난다.
    const rows = Math.floor(STAND_DEPTH / ROW_STEP)
    const expected = SIDES.reduce((a, st) => a + Math.round(st.length / SEAT_PITCH) * rows, 0)
    expect(crowdCapacity(SIDES, STAND_DEPTH, 1)).toBe(expected)
    expect(rows).toBe(28)
  })

  it('detail을 낮추면 정원이 단조 감소한다', () => {
    const series = [1, 0.9, 0.75, 0.6, 0.45, 0.35].map((d) => crowdCapacity(SIDES, STAND_DEPTH, d))
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeLessThan(series[i - 1])
    }
  })

  it('detail을 0.35~1로 클램프하고 NaN·undefined는 1로 취급한다', () => {
    const full = crowdCapacity(SIDES, STAND_DEPTH, 1)
    const floor = crowdCapacity(SIDES, STAND_DEPTH, 0.35)
    expect(crowdCapacity(SIDES, STAND_DEPTH, 0.01)).toBe(floor)
    expect(crowdCapacity(SIDES, STAND_DEPTH, -5)).toBe(floor)
    expect(crowdCapacity(SIDES, STAND_DEPTH, 4)).toBe(full)
    expect(crowdCapacity(SIDES, STAND_DEPTH, Number.NaN)).toBe(full)
    expect(crowdCapacity(SIDES, STAND_DEPTH)).toBe(full)
  })
})

describe('personGeometry', () => {
  it('몸통·머리 두 박스를 비인덱스 삼각형으로 편다', () => {
    const geo = personGeometry(THREE)
    const pos = geo.getAttribute('position')
    // 박스 1개 = 6면 × 2삼각 × 3정점 = 36. 몸통 + 머리 = 72.
    expect(pos.count).toBe(72)
    expect(geo.index).toBeNull()
    geo.dispose()
  })

  it('면 밝기가 정점 색에 구워져 있다(unlit인데도 방향성 음영이 남는 유일한 수단)', () => {
    const geo = personGeometry(THREE)
    const col = geo.getAttribute('color')
    expect(col.count).toBe(geo.getAttribute('position').count)
    const shades = new Set<string>()
    for (let i = 0; i < col.count; i++) {
      const r = col.getX(i)
      expect(Number.isFinite(r)).toBe(true)
      // 0(순검정)이 나오면 그늘 면이 통째로 죽어 "검은 벽"이 된다 — 하한 가드.
      expect(r).toBeGreaterThan(0)
      // 회색 계열이어야 인스턴스 색(팀 컬러)이 그대로 곱해진다.
      expect(col.getY(i)).toBeCloseTo(r, 6)
      expect(col.getZ(i)).toBeCloseTo(r, 6)
      shades.add(r.toFixed(4))
    }
    // 단일 값이면 음영이 없는 것과 같다.
    expect(shades.size).toBeGreaterThanOrEqual(3)
    geo.dispose()
  })
})

describe('buildCrowd 구조', () => {
  it('정원만큼 인스턴스를 만들고 컬링·색 버퍼를 준비한다', () => {
    const b = buildCrowd(THREE, opts())
    expect(b.count).toBe(crowdCapacity(SIDES, STAND_DEPTH, 1))
    expect(b.mesh.count).toBe(b.count)
    expect(b.mesh.instanceColor).not.toBeNull()
    // 25,000개 바운딩 갱신은 순수 낭비다(볼 전체가 항상 카메라 주변에 있다).
    expect(b.mesh.frustumCulled).toBe(false)
  })

  it('좌석이 전부 피치 밖이고 경사만큼 올라간다', () => {
    const b = buildCrowd(THREE, opts())
    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    let inside = 0
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < b.count; i++) {
      b.mesh.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)
      if (Math.abs(p.x) < PITCH_W / 2 && Math.abs(p.z) < PITCH_H / 2) inside++
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    expect(inside).toBe(0)
    // 첫 열 좌석면은 슬래브 윗면(standH0 + seatLift) 위다.
    expect(minY).toBeGreaterThanOrEqual(STAND_H0 + SEAT_LIFT)
    // 상승량은 (열수-1) × 열간격 × tan(rake)이므로 깊이×tan(rake)보다 조금 작다.
    const rise = STAND_DEPTH * Math.tan(RAKE)
    const span = maxY - minY
    expect(span).toBeLessThan(rise)
    expect(span).toBeGreaterThan(rise - 2 * ROW_STEP * Math.tan(RAKE))
  })

  it('두 번 빌드하면 행렬·색·웨이브 속성이 완전히 같다(Math.random·Date 미사용)', () => {
    const a = buildCrowd(THREE, opts())
    const c = buildCrowd(THREE, opts())
    expect(Array.from(a.mesh.instanceMatrix.array)).toEqual(Array.from(c.mesh.instanceMatrix.array))
    expect(Array.from(a.mesh.instanceColor!.array)).toEqual(Array.from(c.mesh.instanceColor!.array))
    expect(Array.from(a.mesh.geometry.getAttribute('aWave').array)).toEqual(
      Array.from(c.mesh.geometry.getAttribute('aWave').array),
    )
  })

  it('aWave가 인스턴스당 (위상, 방위각)을 0~2π로 싣는다', () => {
    const b = buildCrowd(THREE, opts())
    const attr = b.mesh.geometry.getAttribute('aWave')
    expect(attr).toBeInstanceOf(THREE.InstancedBufferAttribute)
    expect(attr.itemSize).toBe(2)
    expect(attr.count).toBe(b.count)
    const TAU = Math.PI * 2
    for (let i = 0; i < b.count; i += 61) {
      expect(attr.getX(i)).toBeGreaterThanOrEqual(0)
      expect(attr.getX(i)).toBeLessThanOrEqual(TAU)
      expect(attr.getY(i)).toBeGreaterThanOrEqual(0)
      expect(attr.getY(i)).toBeLessThanOrEqual(TAU + 1e-6)
    }
  })
})

describe('buildCrowd 웨이브', () => {
  it('유니폼에 t와 클램프된 intensity만 싣는다', () => {
    const b = buildCrowd(THREE, opts())
    b.wave(3.7, 0.4)
    expect(b.waveUniforms.uCrowdTime.value).toBe(3.7)
    expect(b.waveUniforms.uCrowdIntensity.value).toBeCloseTo(0.4, 6)
    b.wave(-2, 5)
    expect(b.waveUniforms.uCrowdTime.value).toBe(-2)
    expect(b.waveUniforms.uCrowdIntensity.value).toBe(1)
    b.wave(0, -3)
    expect(b.waveUniforms.uCrowdIntensity.value).toBe(0)
  })

  it('인스턴스 행렬을 건드리지 않는다(프레임마다 GPU 재업로드 없음)', () => {
    // 이 리팩터의 존재 이유가 여기 있다. 예전 구현은 매 프레임 25,000개 행렬을 다시
    // 써서 1.6MB를 업로드했다. version이 오르는 순간 그 비용이 돌아온다.
    const b = buildCrowd(THREE, opts())
    const before = Array.from(b.mesh.instanceMatrix.array)
    const v0 = b.mesh.instanceMatrix.version
    for (let f = 0; f < 5; f++) b.wave(f * 0.016, 1)
    expect(Array.from(b.mesh.instanceMatrix.array)).toEqual(before)
    expect(b.mesh.instanceMatrix.version).toBe(v0)
  })

  it('메시에 걸린 waveUniforms가 반환값과 같은 객체다(셰이더 주입 경로의 유일한 관측점)', () => {
    const b = buildCrowd(THREE, opts())
    expect(b.mesh.userData.waveUniforms).toBe(b.waveUniforms)
  })
})

describe('buildCrowd 팔레트', () => {
  /** 세 채널 모두 선형 0.25 미만 = 레퍼런스의 "어두운 질량". */
  function darkShare(mesh: THREE.InstancedMesh, count: number): number {
    const arr = mesh.instanceColor!.array
    let dark = 0
    for (let i = 0; i < count; i++) {
      if (arr[i * 3] < 0.25 && arr[i * 3 + 1] < 0.25 && arr[i * 3 + 2] < 0.25) dark++
    }
    return dark / count
  }

  /** 순빨강(홈 컬러)만 g·b가 정확히 0이다 — 어두운 팔레트·액센트에는 그런 색이 없다. */
  function homeShare(mesh: THREE.InstancedMesh, count: number): number {
    const arr = mesh.instanceColor!.array
    let n = 0
    for (let i = 0; i < count; i++) {
      if (arr[i * 3] > 0 && arr[i * 3 + 1] === 0 && arr[i * 3 + 2] === 0) n++
    }
    return n / count
  }

  it('어두운 질량이 60%를 넘는다(원색 블록으로 뒤덮이는 회귀 가드)', () => {
    const b = buildCrowd(THREE, opts({ homeColor: 0xff0000, awayColor: 0x0000ff }))
    const arr = b.mesh.instanceColor!.array
    for (let i = 0; i < arr.length; i++) {
      expect(arr[i]).toBeGreaterThanOrEqual(0)
      expect(arr[i]).toBeLessThanOrEqual(1)
    }
    expect(darkShare(b.mesh, b.count)).toBeGreaterThan(0.6)
  })

  it('bias가 서포터 구역을 실제로 만든다(홈 스탠드의 홈 컬러 지분 > 원정 스탠드)', () => {
    // 스탠드를 하나만 넣으면 좌석 인덱스·해시가 두 경우에서 동일하므로 차이는
    // 오직 bias에서만 온다 — 편향 로직만 고립해 검증할 수 있다.
    const one = (bias: CrowdStand['bias']): CrowdStand[] => [
      { c: 0, s: -1, inner: END_INNER, length: END_LEN, bias },
    ]
    const home = buildCrowd(THREE, opts({ stands: one('home') }))
    const away = buildCrowd(THREE, opts({ stands: one('away') }))
    expect(home.count).toBe(away.count)
    expect(homeShare(home.mesh, home.count)).toBeGreaterThan(
      homeShare(away.mesh, away.count) * 2,
    )
  })
})
