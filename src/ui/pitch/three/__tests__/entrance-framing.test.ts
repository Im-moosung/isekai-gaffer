// 입장 연출 **프레이밍 전수 검사**(영구 회귀 테스트).
//
// 왜 필요한가: 무대 배치(entrance.ts)와 카메라 프리셋(camera.ts)은 서로 다른 파일에서
// 따로 자란다. 실제로 두 파일이 각자 그럴듯한 상수를 갖고도 어긋나 있었고, 그 결과
// **터널 단계에서 카메라가 텅 빈 미드필드를 비추며 배포됐다** — 자막은 "심판진 입장"인데
// 화면에는 잔디와 센터서클뿐이었다. 배역 23명의 NDC y가 -0.86 ~ -1.14, 즉 화면 하단 7 %
// 띠에 몰리고 절반은 프레임 밖이었다. 눈으로는 "조금 아래쪽에 있네" 정도로만 보여서
// 뷰포트 종횡비가 바뀔 때까지 아무도 못 잡았다.
//
// 그래서 여기서는 렌더러와 **똑같은 경로**(entranceFrame → entranceCameraMode →
// cameraFor)를 돌리고 월드→스크린 투영을 직접 계산해, 각 단계마다 몇 명이 실제로
// 화면에 있는지를 못 박는다. three는 쓰지 않는다(순수 모듈만으로 재현 가능해야 한다).
import { describe, expect, it } from 'vitest'
import { cameraFor, type CameraShot } from '../camera'
import {
  ENTRANCE_PHASES,
  buildEntranceCast,
  entranceCameraMode,
  entranceFrame,
  introCardAt,
} from '../entrance'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'

const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 11 })
const cast = buildEntranceCast(state)

/**
 * 검사할 뷰포트 종횡비.
 *  - 1.544 = CSS 공칭(`.m3d-host { aspect-ratio: 105/68 }`) — 세로가 넉넉한 창에서의 모양.
 *  - 1.778 = 16:9.
 *  - 2.722 = 1600×900 실주행 실측(캔버스 1568×576). 레이아웃이 피치를 상단 60 %로
 *    줄이면서 `max-height`가 걸려 CSS 공칭보다 훨씬 넓어진다.
 * three의 PerspectiveCamera.fov는 **수직** 화각이라 종횡비가 넓어져도 세로 프레이밍은
 * 변하지 않는다 — 가로만 넓어진다. 즉 **가로 잘림의 최악 케이스는 항상 가장 좁은 1.544**다.
 */
const ASPECTS = [1.544, 1.778, 2.722]

/** player3d 리그의 머리/발 높이 근사(m). */
const HEAD_Y = 1.75
const FOOT_Y = 0.05

interface V3 {
  x: number
  y: number
  z: number
}
const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
function norm(v: V3): V3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}

/**
 * 월드점 → NDC(-1~1). three의 lookAt 규약(up = +Y)과 같은 기저를 손으로 만든다.
 * @returns 카메라 뒤쪽이면 null
 */
function project(shot: CameraShot, aspect: number, p: V3): { x: number; y: number } | null {
  const fwd = norm(sub(shot.lookAt, shot.pos))
  const right = norm(cross(fwd, { x: 0, y: 1, z: 0 }))
  const up = cross(right, fwd)
  const d = sub(p, shot.pos)
  const zc = dot(d, fwd)
  if (zc <= 0.01) return null
  const tanH = Math.tan((shot.fov * Math.PI) / 360)
  return { x: dot(d, right) / (zc * tanH * aspect), y: dot(d, up) / (zc * tanH) }
}

/**
 * 방송 세이프 에어리어(중앙 90 %) 안인가.
 * 프레임(±1) 기준으로만 세면 화면 맨 끝 1 % 띠에 걸친 사람도 1명으로 세어져,
 * 숫자는 "12명 보임"인데 화면은 텅 빈 사고를 그대로 통과시킨다.
 */
const SAFE = 0.9
const inSafe = (n: { x: number; y: number } | null): boolean =>
  n !== null && Math.abs(n.x) <= SAFE && Math.abs(n.y) <= SAFE

/** 그 시각에 세이프 에어리어 안에 **온몸이** 들어온 배역 수(심판 포함). */
function safeCount(ms: number, aspect: number): number {
  const f = entranceFrame(cast, ms)
  const shot = cameraFor(entranceCameraMode(ms), f.focus, ms / 1000, state.seed)
  const actors = [...f.players, f.referee]
  return actors.filter(
    a =>
      inSafe(project(shot, aspect, { x: a.x, y: HEAD_Y, z: a.z })) &&
      inSafe(project(shot, aspect, { x: a.x, y: FOOT_Y, z: a.z })),
  ).length
}

const span = (phase: string) => ENTRANCE_PHASES.find(s => s.phase === phase)!
/** 단계 안을 n등분해 훑는다(경계 ms는 인접 단계로 새므로 제외). */
function within(phase: string, n = 9): number[] {
  const s = span(phase)
  const out: number[] = []
  for (let i = 1; i <= n; i++) out.push(s.start + ((s.end - s.start) * i) / (n + 1))
  return out
}

describe('입장 연출 프레이밍 — 와이드 단계는 23명 전원이 화면 안에 있다', () => {
  // 터널·워크아웃은 "무언가 시작된다"를 보여 주는 단계다. 여기가 비면 심사자가 보는
  // 첫 경기 장면이 빈 잔디가 된다 — 예외 없이 전원이 세이프 에어리어 안이어야 한다.
  for (const phase of ['tunnel', 'walkout'] as const) {
    for (const aspect of ASPECTS) {
      it(`${phase} @ aspect ${aspect}`, () => {
        for (const ms of within(phase)) {
          expect(`${phase} ${Math.round(ms)}ms: ${safeCount(ms, aspect)}`).toBe(`${phase} ${Math.round(ms)}ms: 23`)
        }
      })
    }
  }
})

describe('입장 연출 프레이밍 — 클로즈 단계', () => {
  it('정렬·소개는 클로즈업이라 전원은 못 담지만 절반 이상은 항상 화면에 있다', () => {
    for (const phase of ['lineup', 'intro'] as const) {
      for (const aspect of ASPECTS) {
        for (const ms of within(phase, 21)) {
          expect(safeCount(ms, aspect)).toBeGreaterThanOrEqual(11)
        }
      }
    }
  })

  it('호명 중인 선수는 **언제나** 프레임 안에 있다(카드와 화면이 어긋나지 않는다)', () => {
    for (const aspect of ASPECTS) {
      for (const ms of within('intro', 33)) {
        const card = introCardAt(cast, ms)
        expect(card).not.toBeNull()
        const f = entranceFrame(cast, ms)
        const shot = cameraFor(entranceCameraMode(ms), f.focus, ms / 1000, state.seed)
        const p = f.players.find(x => x.id === card!.player.id)
        expect(p).toBeDefined()
        const n = project(shot, aspect, { x: p!.x, y: 0.95, z: p!.z })
        expect(n).not.toBeNull()
        expect(Math.abs(n!.x)).toBeLessThanOrEqual(SAFE)
        expect(Math.abs(n!.y)).toBeLessThanOrEqual(SAFE)
      }
    }
  })
})

describe('입장 연출 카메라 스크립트', () => {
  it('단계별 모드 — 와이드 → 사선 클로즈 → 경기 카메라', () => {
    const at = (phase: string) => entranceCameraMode(within(phase, 1)[0])
    expect(at('tunnel')).toBe('entrance')
    expect(at('walkout')).toBe('entrance')
    expect(at('lineup')).toBe('entrance-close')
    expect(at('intro')).toBe('entrance-close')
    // 흩어짐부터는 경기 카메라 — 킥오프 휘슬에서 카메라가 또 움직이지 않는다.
    expect(at('disperse')).toBe('broadcast')
    expect(entranceCameraMode(1e9)).toBe('broadcast')
  })

  it('카메라 위치가 단계 안에서 튀지 않는다(연속성)', () => {
    // reaction을 재사용하던 시절, 소개 6번째에서 focus.x가 0을 통과하면 방위각 부호가
    // 뒤집혀 카메라가 19 m 순간이동했다. 같은 모드라 리그의 0.6 s 전환도 타지 않는다.
    for (const phase of ['tunnel', 'walkout', 'lineup', 'intro', 'disperse'] as const) {
      const s = span(phase)
      let prev: CameraShot | null = null
      for (let ms = s.start + 1; ms < s.end; ms += 20) {
        const f = entranceFrame(cast, ms)
        const shot = cameraFor(entranceCameraMode(ms), f.focus, ms / 1000, state.seed)
        if (prev) {
          const jump = Math.hypot(shot.pos.x - prev.pos.x, shot.pos.y - prev.pos.y, shot.pos.z - prev.pos.z)
          // 20 ms에 0.3 m = 15 m/s. 연출 카메라가 이보다 빨리 움직일 이유가 없다.
          expect(`${phase} ${ms}ms jump ${jump.toFixed(3)}m`).toBe(`${phase} ${ms}ms jump ${Math.min(jump, 0.3).toFixed(3)}m`)
        }
        prev = shot
      }
    }
  })
})
