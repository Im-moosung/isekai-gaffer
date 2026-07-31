// camera.ts는 three를 전혀 import하지 않는 순수 수학 모듈이다(코드 스플릿 보장).
// 따라서 이 테스트도 three 없이 돈다 — applyCamera만 구조적 스텁 카메라로 검증한다.
import { describe, it, expect } from 'vitest'
import {
  BROADCAST_FOLLOW,
  BROADCAST_FOV,
  BROADCAST_FOV_TIGHT,
  BROADCAST_MAX_PAN,
  BROADCAST_Y,
  BROADCAST_Y_TIGHT,
  BROADCAST_Z,
  BROADCAST_Z_TIGHT,
  CAM_MAX_X,
  CAM_MAX_Z,
  CAM_MIN_Y,
  CELEBRATE_PIVOT_X,
  CELEBRATE_PIVOT_Z,
  CELEBRATE_RADIUS,
  END_STAND_INNER_X,
  HIGHLIGHT_DIST,
  HIGHLIGHT_DIST_TIGHT,
  HIGHLIGHT_FOV,
  HIGHLIGHT_FOV_TIGHT,
  HIGHLIGHT_Y,
  HIGHLIGHT_Y_TIGHT,
  REACTION_DIST,
  REACTION_FOV,
  REACTION_Y,
  SET_PIECE_FOV,
  SET_PIECE_Y,
  SHAKE_MAX,
  SIDE_STAND_INNER_Z,
  TRANSITION_S,
  applyCamera,
  cameraFor,
  clampShot,
  createCameraRig,
  danger,
  easeInOutCubic,
  lerpShot,
  shake,
  type CameraLike,
  type CameraMode,
  type CameraShot,
} from '../camera'
import { PITCH_W } from '../types'

const MODES: CameraMode[] = [
  'broadcast',
  'highlight',
  'goal-cam',
  'celebrate',
  'reaction',
  'set-piece',
  'entrance',
  'entrance-close',
]

/** applyCamera 검증용 구조적 카메라 스텁(호출 순서까지 기록). */
function stubCamera(fov = 40): CameraLike & {
  log: string[]
  pos: { x: number; y: number; z: number }
  target: { x: number; y: number; z: number }
  projUpdates: number
} {
  const pos = { x: 0, y: 0, z: 0 }
  const target = { x: 0, y: 0, z: 0 }
  const log: string[] = []
  return {
    log,
    pos,
    target,
    projUpdates: 0,
    fov,
    position: {
      set(x: number, y: number, z: number) {
        pos.x = x
        pos.y = y
        pos.z = z
        log.push('position')
      },
    },
    lookAt(x: number, y: number, z: number) {
      target.x = x
      target.y = y
      target.z = z
      log.push('lookAt')
    },
    updateProjectionMatrix() {
      this.projUpdates++
      log.push('proj')
    },
  }
}

const horiz = (s: CameraShot, f: { x: number; z: number }) =>
  Math.hypot(s.pos.x - f.x, s.pos.z - f.z)

/** 부동소수 누적(0.1+0.1+0.1)이 끼는 비교용 — 값은 여전히 전 필드를 대조한다. */
function expectShotClose(got: CameraShot, want: CameraShot): void {
  for (const key of ['pos', 'lookAt'] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(got[key][axis]).toBeCloseTo(want[key][axis], 9)
    }
  }
  expect(got.fov).toBeCloseTo(want.fov, 9)
}

describe('danger — 중계 문법의 축', () => {
  it('센터서클은 0, 골문 앞은 1, 그 사이는 단조 증가한다', () => {
    expect(danger(0, 0)).toBe(0)
    expect(danger(48, 0)).toBe(1)
    expect(danger(-48, 0)).toBe(1)
    let prev = -1
    for (let x = 0; x <= 52; x += 2) {
      const g = danger(x, 0)
      expect(g).toBeGreaterThanOrEqual(prev)
      prev = g
    }
    // 좌우 대칭이고 x=0에서 튀지 않는다(가까운 골문으로 계산하기 때문)
    expect(danger(30, 7)).toBeCloseTo(danger(-30, -7), 12)
    expect(danger(0.001, 0)).toBeCloseTo(danger(-0.001, 0), 12)
  })

  it('연속 함수다(급격한 컷이 생기지 않는다)', () => {
    let prev = danger(-56, 3)
    for (let x = -56; x <= 56; x += 0.25) {
      const g = danger(x, 3)
      expect(Math.abs(g - prev)).toBeLessThan(0.03)
      prev = g
    }
  })
})

describe('cameraFor — broadcast', () => {
  it('사이드라인 상단에 서고 FOV는 방송 화각', () => {
    const s = cameraFor('broadcast', { x: 0, z: 0 }, 0, 7)
    expect(s.pos.z).toBe(BROADCAST_Z)
    expect(s.pos.z).toBeLessThan(-40) // 터치라인 바깥
    expect(s.pos.y).toBeGreaterThan(BROADCAST_Y - 1)
    expect(s.pos.y).toBeLessThan(BROADCAST_Y + 1)
    expect(s.fov).toBe(BROADCAST_FOV)
    expect(BROADCAST_FOV).toBe(34)
  })

  it('빌드업은 넓게, 박스 근처는 좁게(연속 보간)', () => {
    const mid = cameraFor('broadcast', { x: 0, z: 0 }, 0, 7)
    const box = cameraFor('broadcast', { x: 47, z: 4 }, 0, 7)
    // 마무리 국면: 앞으로 나오고, 낮아지고, 화각이 좁아진다
    expect(box.pos.z).toBeCloseTo(BROADCAST_Z_TIGHT, 6)
    expect(box.pos.y).toBeGreaterThan(BROADCAST_Y_TIGHT - 1)
    expect(box.pos.y).toBeLessThan(BROADCAST_Y_TIGHT + 1)
    expect(box.fov).toBeCloseTo(BROADCAST_FOV_TIGHT, 6)
    expect(box.pos.z).toBeGreaterThan(mid.pos.z)
    expect(box.pos.y).toBeLessThan(mid.pos.y)
    expect(box.fov).toBeLessThan(mid.fov)
    // 중간 지점은 양 끝 사이 — 점프가 아니라 램프다
    const between = cameraFor('broadcast', { x: 24, z: 0 }, 0, 7)
    expect(between.fov).toBeLessThan(mid.fov)
    expect(between.fov).toBeGreaterThan(box.fov)
  })

  it('focus.x를 게인만큼 부분 추종하고(스무딩) lookAt은 완전 추종한다', () => {
    const f = { x: 20, z: 6 } // 중원 — 위험도가 낮아 기본 게인 근처
    const s = cameraFor('broadcast', f, 0, 3)
    expect(s.pos.x).toBeGreaterThan(f.x * BROADCAST_FOLLOW - 0.5)
    expect(s.pos.x).toBeLessThan(f.x * (BROADCAST_FOLLOW + 0.1) + 0.5)
    // 완전 추종(=1.0)도 정지(=0)도 아니다
    expect(s.pos.x).toBeLessThan(f.x - 5)
    expect(s.pos.x).toBeGreaterThan(5)
    expect(s.lookAt.x).toBe(f.x)
  })

  it('팬은 단조 증가하되 한계에서 포화한다', () => {
    const at = (x: number) => cameraFor('broadcast', { x, z: 0 }, 0, 5).pos.x
    expect(at(10)).toBeLessThan(at(20))
    expect(at(20)).toBeLessThan(at(30))
    expect(at(-30)).toBeLessThan(at(-10))
    // 볼이 코너 밖으로 튀어도 카메라는 팬 한계를 넘지 않는다
    expect(at(5000)).toBeLessThanOrEqual(BROADCAST_MAX_PAN + 0.5)
    expect(at(-5000)).toBeGreaterThanOrEqual(-BROADCAST_MAX_PAN - 0.5)
    expect(at(5000)).toBeGreaterThan(BROADCAST_MAX_PAN - 0.5)
  })
})

describe('cameraFor — highlight', () => {
  it('액션 존으로 하강·근접한다(broadcast보다 낮고 가깝다)', () => {
    const f = { x: 12, z: -4 }
    const s = cameraFor('highlight', f, 0, 11)
    expect(s.pos.y).toBeLessThanOrEqual(HIGHLIGHT_Y)
    expect(s.pos.y).toBeGreaterThanOrEqual(HIGHLIGHT_Y_TIGHT)
    expect(horiz(s, f)).toBeLessThanOrEqual(HIGHLIGHT_DIST + 1e-6)
    const b = cameraFor('broadcast', f, 0, 11)
    expect(s.pos.y).toBeLessThan(b.pos.y - 8)
    expect(horiz(s, f)).toBeLessThan(horiz(b, f))
    expect(s.lookAt.x).toBeCloseTo(f.x, 6)
    expect(s.lookAt.z).toBeCloseTo(f.z, 6)
  })

  it('위험도에 따라 거리·높이·화각이 좁혀진다(빌드업 40m → 마무리 24m)', () => {
    const wide = { x: 0, z: 0 }
    const tight = { x: 47, z: 2 }
    const w = cameraFor('highlight', wide, 0, 2)
    const g = cameraFor('highlight', tight, 0, 2)
    expect(horiz(w, wide)).toBeCloseTo(HIGHLIGHT_DIST, 6)
    expect(w.pos.y).toBeCloseTo(HIGHLIGHT_Y, 6)
    expect(w.fov).toBeCloseTo(HIGHLIGHT_FOV, 6)
    expect(horiz(g, tight)).toBeCloseTo(HIGHLIGHT_DIST_TIGHT, 6)
    expect(g.pos.y).toBeCloseTo(HIGHLIGHT_Y_TIGHT, 6)
    expect(g.fov).toBeCloseTo(HIGHLIGHT_FOV_TIGHT, 6)
  })

  it('거리는 같은 위험도라면 시간과 무관하다(각도만 흔들린다)', () => {
    for (const t of [0, 0.7, 4.3, 30]) {
      for (const f of [{ x: -30, z: 20 }, { x: 0, z: 0 }, { x: 20, z: -6 }]) {
        const d0 = horiz(cameraFor('highlight', f, 0, 2), f)
        expect(horiz(cameraFor('highlight', f, t, 2), f)).toBeCloseTo(d0, 6)
      }
    }
  })
})

describe('cameraFor — set-piece', () => {
  it('높은 대각선에서 박스 쪽을 내려다본다', () => {
    for (const f of [{ x: 50, z: 32 }, { x: -50, z: -32 }, { x: 46, z: -30 }]) {
      const s = cameraFor('set-piece', f, 0, 3)
      expect(s.pos.y).toBeCloseTo(SET_PIECE_Y, 6)
      expect(s.fov).toBeCloseTo(SET_PIECE_FOV, 6)
      // 시선은 focus와 골문 앞 박스 중심 사이 — focus 쪽 골문 방향이다
      expect(Math.sign(s.lookAt.x)).toBe(Math.sign(f.x))
      expect(Math.abs(s.lookAt.x)).toBeLessThan(Math.abs(f.x) + 1)
      // 카메라는 골라인 쪽이 아니라 피치 중앙 쪽에서 대각으로 잡는다
      expect(Math.abs(s.pos.x)).toBeLessThan(Math.abs(f.x))
      // highlight보다 확실히 높고 멀다(박스 전체가 들어와야 한다)
      const h = cameraFor('highlight', f, 0, 3)
      expect(s.pos.y).toBeGreaterThan(h.pos.y + 10)
      expect(horiz(s, f)).toBeGreaterThan(horiz(h, f))
    }
  })

  it('코너 좌우가 대칭이다', () => {
    const a = cameraFor('set-piece', { x: 50, z: 30 }, 0, 3)
    const b = cameraFor('set-piece', { x: -50, z: 30 }, 0, 3)
    expect(a.pos.x).toBeCloseTo(-b.pos.x, 6)
    expect(a.pos.y).toBeCloseTo(b.pos.y, 6)
  })
})

describe('cameraFor — reaction', () => {
  it('득점 지점을 낮게 올려다보는 클로즈 컷', () => {
    const f = { x: 44, z: 6 }
    const s = cameraFor('reaction', f, 0, 5)
    expect(s.pos.y).toBeGreaterThanOrEqual(CAM_MIN_Y)
    expect(s.pos.y).toBeLessThan(REACTION_Y + 1) // 로우앵글
    expect(s.lookAt.y).toBeGreaterThan(1.5) // 선수 상반신
    expect(s.fov).toBeCloseTo(REACTION_FOV, 6)
    expect(s.lookAt.x).toBeCloseTo(f.x, 6)
    expect(s.lookAt.z).toBeCloseTo(f.z, 6)
    // 세리머니 오빗(반경 20m)보다 확실히 가깝다 — 클로즈 → 와이드 순서가 성립한다
    expect(horiz(s, f)).toBeCloseTo(REACTION_DIST, 6)
    expect(REACTION_DIST).toBeLessThan(CELEBRATE_RADIUS)
  })

  it('코너 근처 득점에서도 관중석으로 밀려나지 않고, 클램프는 더 가까워지는 쪽이다', () => {
    for (const f of [{ x: 52, z: 33 }, { x: -52, z: -33 }, { x: 52, z: -33 }]) {
      const s = cameraFor('reaction', f, 0.5, 9)
      expect(Math.abs(s.pos.x)).toBeLessThanOrEqual(END_STAND_INNER_X)
      expect(Math.abs(s.pos.z)).toBeLessThanOrEqual(SIDE_STAND_INNER_Z)
      // 클램프가 걸려도 클로즈 컷의 성격(가까움)은 유지된다
      expect(horiz(s, f)).toBeLessThanOrEqual(REACTION_DIST + 1e-6)
      expect(horiz(s, f)).toBeGreaterThan(4)
    }
  })
})

describe('cameraFor — goal-cam', () => {
  it('focus에 가까운 골대 뒤 낮은 앵글에서 액션을 본다', () => {
    const east = cameraFor('goal-cam', { x: 40, z: 4 }, 0, 9)
    expect(east.pos.x).toBeGreaterThan(PITCH_W / 2) // 골라인 밖
    expect(east.pos.y).toBeGreaterThan(CAM_MIN_Y - 0.001)
    expect(east.pos.y).toBeLessThan(9) // 낮은 앵글
    expect(east.lookAt.x).toBeLessThan(east.pos.x) // 피치 안쪽(서쪽)을 본다

    const west = cameraFor('goal-cam', { x: -40, z: -4 }, 0, 9)
    expect(west.pos.x).toBeLessThan(-PITCH_W / 2)
    expect(west.lookAt.x).toBeGreaterThan(west.pos.x)
    expect(west.pos.x).toBeCloseTo(-east.pos.x, 6)
  })

  it('골 뒤 카메라는 관중석 안으로 들어가지 않는다(러너프 위에 머문다)', () => {
    // 회귀: GOAL_CAM_BEHIND가 12였을 때 x=±64.5로 END_STAND_INNER_X(59.5)를 넘어
    // 카메라가 관중 인스턴스 사이에 박혔다 — 골 순간 화면 절반이 거대한 색 상자였다.
    for (const fx of [-48, -20, 0, 20, 48]) {
      for (const z of [-30, 0, 30]) {
        const s = cameraFor('goal-cam', { x: fx, z }, 0.7, 5)
        expect(Math.abs(s.pos.x)).toBeLessThan(END_STAND_INNER_X)
      }
    }
  })

  it('골 뒤 카메라는 골대 폭 근처에 머문다(코너로 도망가지 않음)', () => {
    for (const z of [-34, -10, 0, 12, 34]) {
      const s = cameraFor('goal-cam', { x: 48, z }, 1.3, 4)
      expect(Math.abs(s.pos.z)).toBeLessThan(14)
    }
  })
})

describe('cameraFor — celebrate', () => {
  it('득점 지점 피벗 주위를 일정 반경으로 오빗한다', () => {
    const f = { x: 30, z: -8 }
    // 피벗은 focus를 피치 중앙 쪽으로 당긴 점 — 코너 득점에서도 원이 볼 안에 남는다.
    const pivot = { x: f.x * CELEBRATE_PIVOT_X, z: f.z * CELEBRATE_PIVOT_Z }
    for (const t of [0, 0.5, 1.7, 6]) {
      expect(horiz(cameraFor('celebrate', f, t, 6), pivot)).toBeCloseTo(CELEBRATE_RADIUS, 6)
    }
    expect(cameraFor('celebrate', f, 0, 6).lookAt.x).toBeCloseTo(f.x, 6)
    expect(cameraFor('celebrate', f, 0, 6).lookAt.z).toBeCloseTo(f.z, 6)
  })

  it('코너 득점에서도 관중석 슬래브를 통과하지 않는다(회귀: 반경 22 → 20 + 피벗)', () => {
    // 예전엔 focus (58.5, 38) 부근 오빗이 x=80.5·z=60까지 나가 관중 사이를 지나갔다.
    for (const t of [0, 1.1, 2.7, 4.4]) {
      const s = cameraFor('celebrate', { x: 58, z: 38 }, t, 6)
      expect(Math.abs(s.pos.z)).toBeLessThan(41)
      expect(Math.abs(s.pos.x)).toBeLessThan(63)
    }
  })

  it('각속도가 결정론적이며 실제로 회전한다', () => {
    const f = { x: 0, z: 0 }
    const ang = (t: number) => {
      const s = cameraFor('celebrate', f, t, 6)
      return Math.atan2(s.pos.z - f.z, s.pos.x - f.x)
    }
    const a0 = ang(0)
    const a1 = ang(1)
    let d = a1 - a0
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    // 1초에 완만히(0.2~1.2rad) 돈다 — 정지도, 빙글빙글도 아니다
    expect(Math.abs(d)).toBeGreaterThan(0.2)
    expect(Math.abs(d)).toBeLessThan(1.2)
    // 시드가 각속도를 바꾼다(결정론적 변주)
    const other = cameraFor('celebrate', f, 1, 6)
    expect(cameraFor('celebrate', f, 1, 6)).toEqual(other)
  })
})

describe('cameraFor — 공통 불변식', () => {
  it('어떤 모드·focus·시간에도 피치 아래·뒤로 빠지지 않는다', () => {
    for (const mode of MODES) {
      for (const x of [-5000, -60, -30, 0, 30, 60, 5000]) {
        for (const z of [-500, -40, 0, 40, 500]) {
          for (const t of [0, 0.37, 3.1, 12.9, 600]) {
            const s = cameraFor(mode, { x, z }, t, 13)
            expect(Number.isFinite(s.pos.x)).toBe(true)
            expect(Number.isFinite(s.pos.y)).toBe(true)
            expect(Number.isFinite(s.pos.z)).toBe(true)
            expect(s.pos.y).toBeGreaterThan(3)
            expect(Math.abs(s.pos.z)).toBeLessThanOrEqual(CAM_MAX_Z)
            expect(Math.abs(s.pos.x)).toBeLessThanOrEqual(CAM_MAX_X)
            expect(s.fov).toBeGreaterThan(10)
            expect(s.fov).toBeLessThan(80)
          }
        }
      }
    }
  })

  it('완전 결정론(Math.random·Date 미사용)', () => {
    for (const mode of MODES) {
      const f = { x: 17, z: -9 }
      expect(cameraFor(mode, f, 2.5, 42)).toEqual(cameraFor(mode, f, 2.5, 42))
    }
  })

  it('시드가 다르면 미세 변주가 달라진다', () => {
    for (const mode of MODES) {
      const f = { x: 5, z: 5 }
      expect(cameraFor(mode, f, 0.9, 1)).not.toEqual(cameraFor(mode, f, 0.9, 2))
    }
  })
})

describe('shake', () => {
  it('amp 0 이하이면 정확히 0(reduced-motion)', () => {
    expect(shake(1.23, 0, 5)).toEqual({ x: 0, y: 0, z: 0 })
    expect(shake(9.9, -3, 5)).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('진폭을 절대 넘지 않는다', () => {
    const amp = 0.35
    for (let i = 0; i < 400; i++) {
      const s = shake(i * 0.017, amp, 3)
      expect(Math.abs(s.x)).toBeLessThanOrEqual(amp)
      expect(Math.abs(s.y)).toBeLessThanOrEqual(amp)
      expect(Math.abs(s.z)).toBeLessThanOrEqual(amp)
    }
  })

  it('amp에 선형 비례한다(상수 흔들림이 아니다)', () => {
    for (const t of [0.13, 1.7, 5.5]) {
      const a = shake(t, 0.2, 8)
      const b = shake(t, 0.4, 8)
      expect(b.x).toBeCloseTo(a.x * 2, 10)
      expect(b.y).toBeCloseTo(a.y * 2, 10)
      expect(b.z).toBeCloseTo(a.z * 2, 10)
      expect(Math.abs(a.x) + Math.abs(a.y) + Math.abs(a.z)).toBeGreaterThan(0)
    }
  })

  it('실제로 진동한다(부호가 바뀌고 진폭 근처까지 도달)', () => {
    const amp = 0.4
    let maxAbs = 0
    let pos = 0
    let neg = 0
    for (let i = 0; i < 500; i++) {
      const s = shake(i * 0.013, amp, 21)
      maxAbs = Math.max(maxAbs, Math.abs(s.x), Math.abs(s.y))
      if (s.x > 0) pos++
      if (s.x < 0) neg++
    }
    expect(maxAbs).toBeGreaterThan(amp * 0.5)
    expect(pos).toBeGreaterThan(50)
    expect(neg).toBeGreaterThan(50)
  })

  it('과도한 amp는 상한에서 포화하고, 결정론적이며 시드에 반응한다', () => {
    const big = shake(0.4, 1000, 2)
    expect(Math.abs(big.x)).toBeLessThanOrEqual(SHAKE_MAX)
    expect(Math.abs(big.y)).toBeLessThanOrEqual(SHAKE_MAX)
    expect(shake(0.4, 0.3, 2)).toEqual(shake(0.4, 0.3, 2))
    expect(shake(0.4, 0.3, 2)).not.toEqual(shake(0.4, 0.3, 3))
  })
})

describe('clampShot', () => {
  it('낮은 샷은 관중석 안쪽 경계를 아예 못 넘는다', () => {
    const s = clampShot({
      pos: { x: 900, y: -12, z: -400 },
      lookAt: { x: 1, y: 2, z: 3 },
      fov: 200,
    })
    expect(s.pos.y).toBe(CAM_MIN_Y) // 피치 아래 금지
    // y=4에서는 좌석 표면(첫 열 2.4m) + 여유 6m를 만족하는 침투가 0이다.
    expect(s.pos.x).toBe(END_STAND_INNER_X)
    expect(s.pos.z).toBe(-SIDE_STAND_INNER_Z)
    expect(s.fov).toBeLessThan(80)
    expect(s.lookAt).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('높은 샷은 경사면 위 공중을 그만큼 더 쓸 수 있다(하드 박스에서 포화)', () => {
    const high = clampShot({
      pos: { x: 900, y: 30, z: -400 },
      lookAt: { x: 0, y: 0, z: 0 },
      fov: 34,
    })
    expect(high.pos.x).toBe(CAM_MAX_X)
    expect(high.pos.z).toBe(-CAM_MAX_Z)
    // 중간 높이는 두 극단 사이 — 높이에 따라 연속으로 넓어진다
    const mid = clampShot({ pos: { x: 900, y: 12, z: -400 }, lookAt: { x: 0, y: 0, z: 0 }, fov: 34 })
    expect(mid.pos.x).toBeGreaterThan(END_STAND_INNER_X)
    expect(mid.pos.x).toBeLessThan(CAM_MAX_X)
    expect(Math.abs(mid.pos.z)).toBeGreaterThan(SIDE_STAND_INNER_Z)
    expect(Math.abs(mid.pos.z)).toBeLessThan(CAM_MAX_Z)
  })

  it('정상 범위 샷은 건드리지 않는다', () => {
    const ok: CameraShot = { pos: { x: 10, y: 20, z: -55 }, lookAt: { x: 0, y: 1, z: 0 }, fov: 34 }
    expect(clampShot(ok)).toEqual(ok)
  })
})

describe('easeInOutCubic · lerpShot', () => {
  it('0·0.5·1 고정점과 단조 증가', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(1)).toBe(1)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10)
    expect(easeInOutCubic(-1)).toBe(0)
    expect(easeInOutCubic(2)).toBe(1)
    // 선형이 아니라 실제로 가감속한다
    expect(easeInOutCubic(0.25)).toBeLessThan(0.25)
    expect(easeInOutCubic(0.75)).toBeGreaterThan(0.75)
    let prev = -1
    for (let i = 0; i <= 20; i++) {
      const v = easeInOutCubic(i / 20)
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
  })

  it('lerpShot은 양 끝과 중간을 정확히 보간한다', () => {
    const a: CameraShot = { pos: { x: 0, y: 10, z: -50 }, lookAt: { x: 0, y: 0, z: 0 }, fov: 30 }
    const b: CameraShot = { pos: { x: 10, y: 20, z: -30 }, lookAt: { x: 4, y: 2, z: 6 }, fov: 40 }
    expect(lerpShot(a, b, 0)).toEqual(a)
    expect(lerpShot(a, b, 1)).toEqual(b)
    const m = lerpShot(a, b, 0.5)
    expect(m.pos).toEqual({ x: 5, y: 15, z: -40 })
    expect(m.lookAt).toEqual({ x: 2, y: 1, z: 3 })
    expect(m.fov).toBe(35)
  })
})

describe('applyCamera', () => {
  it('위치→lookAt 순서로 갱신하고 FOV 변경 시에만 투영행렬을 다시 만든다', () => {
    const cam = stubCamera(40)
    const shot: CameraShot = { pos: { x: 1, y: 2, z: 3 }, lookAt: { x: 4, y: 5, z: 6 }, fov: 34 }
    applyCamera(cam, shot)
    expect(cam.pos).toEqual({ x: 1, y: 2, z: 3 })
    expect(cam.target).toEqual({ x: 4, y: 5, z: 6 })
    expect(cam.fov).toBe(34)
    expect(cam.projUpdates).toBe(1)
    // lookAt은 position 이후여야 방향이 맞는다
    expect(cam.log.indexOf('position')).toBeLessThan(cam.log.indexOf('lookAt'))

    // 같은 FOV면 투영행렬 재계산 없음(매 프레임 낭비 금지)
    applyCamera(cam, { ...shot, pos: { x: 9, y: 9, z: 9 } })
    expect(cam.projUpdates).toBe(1)
    expect(cam.pos.x).toBe(9)
    applyCamera(cam, { ...shot, fov: 30 })
    expect(cam.projUpdates).toBe(2)
  })
})

describe('createCameraRig', () => {
  const focus = { x: 20, z: -6 }

  it('초기 샷은 기본 모드의 cameraFor와 같다', () => {
    const rig = createCameraRig({ seed: 4 })
    expect(rig.mode).toBe('broadcast')
    const s = rig.update({ focus, t: 0, dt: 0 })
    expect(s).toEqual(cameraFor('broadcast', focus, 0, 4))
    expect(rig.shot).toEqual(s)
  })

  it('모드 전환을 easeInOutCubic으로 0.6초 보간한다', () => {
    expect(TRANSITION_S).toBe(0.6)
    const rig = createCameraRig({ seed: 4 })
    const from = rig.update({ focus, t: 0, dt: 0 })
    rig.setMode('highlight')
    expect(rig.mode).toBe('highlight')

    const to = cameraFor('highlight', focus, 0, 4)
    // dt는 0.1로 클램프되므로 0.6초 전환은 6프레임이 필요하다.
    let mid: CameraShot = from
    for (let i = 0; i < 3; i++) mid = rig.update({ focus, t: 0, dt: 0.1 })
    expect(rig.transitionU).toBeCloseTo(0.5, 10)
    expectShotClose(mid, lerpShot(from, to, easeInOutCubic(0.5)))
    expect(mid.fov).toBeGreaterThan(Math.min(from.fov, to.fov))
    expect(mid.fov).toBeLessThan(Math.max(from.fov, to.fov))

    let end: CameraShot = mid
    for (let i = 0; i < 3; i++) end = rig.update({ focus, t: 0, dt: 0.1 })
    expect(end).toEqual(to)
    expect(rig.transitionU).toBe(1)
  })

  it('같은 모드로의 setMode는 무시되고, instant는 즉시 전환한다', () => {
    const rig = createCameraRig({ seed: 4 })
    rig.update({ focus, t: 0, dt: 0 })
    rig.setMode('broadcast')
    expect(rig.transitionU).toBe(1)
    expect(rig.update({ focus, t: 0, dt: 0.05 })).toEqual(cameraFor('broadcast', focus, 0, 4))

    rig.setMode('goal-cam', { instant: true })
    expect(rig.update({ focus, t: 0, dt: 0.05 })).toEqual(cameraFor('goal-cam', focus, 0, 4))
  })

  it('impulse가 셰이크를 넣고 시간이 지나면 감쇠한다', () => {
    const rig = createCameraRig({ seed: 4 })
    rig.update({ focus, t: 0, dt: 0 })
    const clean = cameraFor('broadcast', focus, 0.05, 4)
    rig.impulse(0.5)
    const shaken = rig.update({ focus, t: 0.05, dt: 0.05 })
    const off = Math.hypot(
      shaken.pos.x - clean.pos.x,
      shaken.pos.y - clean.pos.y,
      shaken.pos.z - clean.pos.z,
    )
    expect(off).toBeGreaterThan(1e-4)
    expect(Math.abs(shaken.pos.x - clean.pos.x)).toBeLessThanOrEqual(0.5)
    const first = rig.shakeAmp
    for (let i = 0; i < 40; i++) rig.update({ focus, t: 1 + i * 0.05, dt: 0.05 })
    expect(rig.shakeAmp).toBeLessThan(first * 0.2)
    // 충분히 지나면 완전히 멎는다
    for (let i = 0; i < 200; i++) rig.update({ focus, t: 5 + i * 0.05, dt: 0.05 })
    expect(rig.shakeAmp).toBe(0)
  })

  it('reduced-motion이면 impulse가 화면을 흔들지 않는다', () => {
    const rig = createCameraRig({ seed: 4, reducedMotion: true })
    rig.update({ focus, t: 0, dt: 0 })
    rig.impulse(1.2)
    expect(rig.update({ focus, t: 0.05, dt: 0.05 })).toEqual(cameraFor('broadcast', focus, 0.05, 4))
    expect(rig.shakeAmp).toBe(0)

    // 런타임 토글도 즉시 반영된다
    const live = createCameraRig({ seed: 4 })
    live.update({ focus, t: 0, dt: 0 })
    live.impulse(0.6)
    live.setReducedMotion(true)
    expect(live.update({ focus, t: 0.05, dt: 0.05 })).toEqual(cameraFor('broadcast', focus, 0.05, 4))
  })

  it('카메라를 넘기면 그 자리에서 적용하고, 셰이크 후에도 불변식을 지킨다', () => {
    const cam = stubCamera(40)
    const rig = createCameraRig({ seed: 4, mode: 'goal-cam' })
    rig.impulse(3)
    const s = rig.update({ focus: { x: 50, z: 30 }, t: 0.2, dt: 0.2, camera: cam })
    expect(cam.pos).toEqual({ x: s.pos.x, y: s.pos.y, z: s.pos.z })
    expect(cam.fov).toBe(s.fov)
    expect(s.pos.y).toBeGreaterThan(3)
    expect(Math.abs(s.pos.z)).toBeLessThan(80)
  })

  it('거대한 dt에도 전환이 끝나고 값이 유한하다(탭 복귀)', () => {
    const rig = createCameraRig({ seed: 4 })
    rig.update({ focus, t: 0, dt: 0 })
    rig.setMode('celebrate')
    // dt는 내부에서 클램프되므로 한 프레임에 전환이 끝나지는 않지만 폭주하지 않는다
    for (let i = 0; i < 20; i++) rig.update({ focus, t: 10, dt: 999 })
    const s = rig.update({ focus, t: 10, dt: 999 })
    expect(s).toEqual(cameraFor('celebrate', focus, 10, 4))
  })
})
