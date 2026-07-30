// 장면 라이브러리(빌드업 × 마무리 × 레인) 계약 — "전술이 화면에 보인다"를 고정한다.
import { describe, it, expect } from 'vitest'
import type { AttackPattern, MatchEvent, MatchEventType } from '../../../engine/types'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import {
  buildScene, sceneLibrarySize, LANE_COUNT, buildupLabel, BUILDUP_BY_PATTERN,
  BUILDUP_VARIANT_COUNT, FINISH_VARIANT_COUNT,
} from '../scenes'
import { buildSequence, sceneKeyFor } from '../choreography'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const base = createMatch(home, away, { seed: 42 })

const PATTERNS: AttackPattern[] = ['balanced', 'cross', 'through', 'longshot']

function withPattern(p: AttackPattern) {
  const s = structuredClone(base)
  s.home.tactics.attackPattern = p
  return s
}

function ev(type: MatchEventType, over: Partial<MatchEvent> = {}): MatchEvent {
  return { minute: 30, type, teamId: home.id, ...over }
}

describe('장면 라이브러리 규모', () => {
  it('(빌드업 4계열 × 실행 2) × (마무리 5 × 변형 3) × 레인 6 = 720 + 세트피스 4', () => {
    expect(LANE_COUNT).toBe(6)
    expect(BUILDUP_VARIANT_COUNT).toBe(2)
    expect(FINISH_VARIANT_COUNT).toBe(3)
    expect(sceneLibrarySize()).toEqual({ open: 720, setPiece: 4, total: 724, reachablePerMatch: 216 })
  })

  // ★ total(724)은 라이브러리 크기지 한 경기 체감이 아니다. 경기 안에서는 attackPattern이
  //   계열을 고정하고 하이라이트 결과도 3종뿐이라 실제 칸은 216이다 — 반복 게이트가
  //   기준으로 삼아야 할 수는 이쪽이다.
  it('한 경기 도달 가능 조합은 216이다 — 이 수가 반복 게이트의 분모다', () => {
    expect(sceneLibrarySize().reachablePerMatch).toBe(216)
  })

  it('빌드업 계열은 attackPattern 4택과 1:1이고 서로 다르다', () => {
    const ids = PATTERNS.map(p => BUILDUP_BY_PATTERN[p])
    expect(new Set(ids).size).toBe(4)
    for (const p of PATTERNS) expect(buildupLabel(p).length).toBeGreaterThan(0)
  })

  it('실행 변형은 계열 라벨을 바꾸지 않는다 — 유저가 고른 전술 이름은 하나다', () => {
    for (const p of PATTERNS) {
      const keys = [0, 1].map(b => buildScene(p, 'goal', 0, { buildup: b }).key.split('/')[0])
      // 같은 계열, 다른 실행 접미어.
      expect(new Set(keys.map(k => k.split('.')[0])).size).toBe(1)
      expect(new Set(keys).size).toBe(2)
    }
  })
})

describe('변형 축 — 같은 결과를 다른 그림으로', () => {
  it('빌드업 실행 변형 2종은 서로 다른 궤적이다', () => {
    for (const p of PATTERNS) {
      const paths = [0, 1].map(b =>
        buildScene(p, 'goal', 0, { buildup: b }).points.slice(0, 3).map(s => s.ball.join(',')).join('|'))
      expect(new Set(paths).size, p).toBe(2)
    }
  })

  it('마무리 변형 3종은 슈팅 지점과 결과 지점이 모두 다르다', () => {
    const shots = new Set<string>()
    const ends = new Set<string>()
    for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
      const pts = buildScene('cross', 'goal', 0, { finish: f }).points
      shots.add(pts[3].ball.join(','))
      ends.add(pts[4].ball.join(','))
    }
    expect(shots.size).toBe(FINISH_VARIANT_COUNT)
    expect(ends.size).toBe(FINISH_VARIANT_COUNT)
  })

  it('★ 변형이 결과를 바꾸지 않는다 — 골은 항상 네트, 세이브는 GK 앞, 미스는 골문 밖', () => {
    for (const p of PATTERNS) {
      for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
        for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
          for (let l = 0; l < LANE_COUNT; l++) {
            const v = { buildup: b, finish: f }
            const tag = `${p}/b${b}/f${f}/L${l}`
            const goal = buildScene(p, 'goal', l, v).points
            const save = buildScene(p, 'save', l, v).points
            const miss = buildScene(p, 'miss', l, v).points
            const shot = buildScene(p, 'shot', l, v).points
            const chance = buildScene(p, 'chance', l, v).points
            // 골: 골라인에 닿고 골문 폭(레인 압축 후에도 중앙) 안에 들어간다.
            expect(goal[4].ball[0], tag).toBeGreaterThan(98)
            expect(Math.abs(goal[4].ball[1] - 50), tag).toBeLessThanOrEqual(6)
            // 세이브: 골라인 앞에서 멈추고 골문 폭 안(GK가 잡는다).
            expect(save[4].ball[0], tag).toBeLessThan(95)
            expect(save[4].ball[0], tag).toBeGreaterThan(90)
            expect(Math.abs(save[4].ball[1] - 50), tag).toBeLessThanOrEqual(7)
            // 미스: 골라인까지 가지만 골문 폭 밖으로 벗어난다.
            expect(miss[4].ball[0], tag).toBeGreaterThan(98)
            expect(Math.abs(miss[4].ball[1] - 50), tag).toBeGreaterThan(4)
            // 블록: 골문 앞에서 멈춘다(골보다 앞).
            expect(shot[4].ball[0], tag).toBeGreaterThan(90)
            expect(shot[4].ball[0], tag).toBeLessThan(goal[4].ball[0])
            // 찬스: 마무리 자체가 없다 — 슛 계열보다 골문에서 멀다.
            expect(chance).toHaveLength(4)
            expect(chance[3].ball[0], tag).toBeLessThan(shot[4].ball[0])
          }
        }
      }
    }
  })

  it('★ 체류 시간 계약 — 모든 변형에서 t는 단조 증가하고 마지막 ≤ 0.8', () => {
    const finishes = ['goal', 'save', 'miss', 'shot', 'chance'] as const
    for (const p of PATTERNS) {
      for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
        for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
          for (const fin of finishes) {
            const pts = buildScene(p, fin, 0, { buildup: b, finish: f }).points
            for (let i = 1; i < pts.length; i++) expect(pts[i].t).toBeGreaterThan(pts[i - 1].t)
            expect(pts[pts.length - 1].t, `${p}/b${b}/f${f}/${fin}`).toBeLessThanOrEqual(0.8)
          }
        }
      }
    }
  })
})

describe('★ attackPattern이 화면을 바꾼다', () => {
  it('같은 결과(goal)라도 패턴마다 빌드업 궤적이 다르다', () => {
    const paths = PATTERNS.map(p => JSON.stringify(buildSequence(ev('goal'), withPattern(p).home, base.away).slice(0, 3)))
    expect(new Set(paths).size).toBe(4)
  })

  it('크로스는 측면 끝(터치라인)까지 나가고, 중거리는 박스 밖에서 마무리한다', () => {
    const cross = buildScene('cross', 'goal', 0).points
    const long = buildScene('longshot', 'goal', 0).points
    // 크로스 빌드업 마지막 점 = 엔드라인 부근 측면.
    const cl = cross[2].ball
    expect(cl[0]).toBeGreaterThan(75)
    expect(Math.abs(cl[1] - 50)).toBeGreaterThan(30)
    // 중거리 빌드업 마지막 점(=슛 지점)은 박스보다 훨씬 멀다.
    expect(long[2].ball[0]).toBeLessThan(cl[0] - 8)
  })

  it('중앙 침투는 스루패스 구간이 지면(ground)이다 — 뜨면 수비가 따라붙는다', () => {
    const s = buildScene('through', 'goal', 0).points
    expect(s[1].arc).toBe('ground')
  })

  it('측면 전개의 마무리 배달 구간은 크로스 아크로 뜬다', () => {
    expect(buildScene('cross', 'goal', 0).points[3].arc).toBe('cross')
    // 중앙 전개는 크로스가 아니라 슛으로 배달된다.
    expect(buildScene('balanced', 'goal', 0).points[3].arc).toBe('shot')
  })

  it('결과는 엔진이 정한다 — 같은 빌드업이라도 마무리가 결과대로 끝난다', () => {
    const goal = buildScene('balanced', 'goal', 0).points
    const save = buildScene('balanced', 'save', 0).points
    const miss = buildScene('balanced', 'miss', 0).points
    // 골만 골라인(99)에 닿는다. 세이브는 GK 앞에서, 미스는 골문 밖으로.
    expect(goal[goal.length - 1].ball[0]).toBeGreaterThan(98)
    expect(save[save.length - 1].ball[0]).toBeLessThan(95)
    expect(Math.abs(miss[miss.length - 1].ball[1] - 50)).toBeGreaterThan(25)
  })
})

describe('레인 변형 — 좌우 반전으로 공짜 2배', () => {
  it('레인 0과 1은 y가 서로 미러(합 100)', () => {
    const a = buildScene('cross', 'goal', 0).points
    const b = buildScene('cross', 'goal', 1).points
    for (let i = 0; i < a.length; i++) {
      expect(a[i].ball[0]).toBeCloseTo(b[i].ball[0], 6)
      expect(a[i].ball[1] + b[i].ball[1]).toBeCloseTo(100, 6)
    }
  })

  it('레인 6종이 모두 다른 y 프로파일을 만든다', () => {
    const ys = new Set<string>()
    for (let l = 0; l < LANE_COUNT; l++) {
      ys.add(buildScene('through', 'shot', l).points.map(p => p.ball[1].toFixed(2)).join(','))
    }
    expect(ys.size).toBe(LANE_COUNT)
  })
})

describe('결정론', () => {
  it('같은 이벤트는 항상 같은 장면 키', () => {
    const e = ev('goal', { minute: 63, playerId: base.home.tactics.lineup[10].playerId })
    expect(sceneKeyFor(e, base.home, base.away)).toBe(sceneKeyFor(e, base.home, base.away))
  })
  it('장면 키에 빌드업·마무리·레인·공수 주체가 들어간다', () => {
    const k = sceneKeyFor(ev('goal'), withPattern('cross').home, base.away)!
    expect(k).toMatch(/^H\/wing\.[ab]\/goal\.[abc]\/L[0-5]$/)
  })
  it('안무 없는 타입은 키도 없다', () => {
    for (const t of ['kickoff', 'sub', 'halftime', 'fulltime'] as MatchEventType[]) {
      expect(sceneKeyFor(ev(t), base.home, base.away)).toBeNull()
    }
  })
})

describe('역할 배정 — 배역은 엔진이 준다', () => {
  it('무버는 전부 공격 팀의 실제 라인업 선수다', () => {
    const ids = new Set(base.home.tactics.lineup.map(s => s.playerId))
    for (const p of PATTERNS) {
      for (const step of buildSequence(ev('goal'), withPattern(p).home, base.away)) {
        for (const m of step.movers) expect(ids.has(m.playerId)).toBe(true)
      }
    }
  })
  it('같은 무버가 중복 배정되지 않는다', () => {
    const s = buildSequence(ev('goal'), withPattern('cross').home, base.away)
    const ids = s[0].movers.map(m => m.playerId)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('빌드업이 다르면 뽑히는 역할(선수)도 달라질 수 있다', () => {
    const a = buildSequence(ev('goal'), withPattern('cross').home, base.away)[0].movers.map(m => m.playerId)
    const b = buildSequence(ev('goal'), withPattern('longshot').home, base.away)[0].movers.map(m => m.playerId)
    expect(a).not.toEqual(b)
  })
})
