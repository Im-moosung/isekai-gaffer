// 장면 라이브러리(빌드업 × 마무리 × 레인) 계약 — "전술이 화면에 보인다"를 고정한다.
import { describe, it, expect } from 'vitest'
import type { AttackPattern, Instructions, MatchEvent, MatchEventType } from '../../../engine/types'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import {
  buildScene, sceneLibrarySize, LANE_COUNT, buildupLabel, BUILDUP_BY_PATTERN,
  pickBuildup, FINISH_ROUTE_LABELS, BUILDUP_PICTURES, BUILDUP_WEIGHTS, BUILDUP_ORDER,
  SHOT_ZONE_OUT_PCT, pickShotZone, BOX_DEPTH_M, BOX_HALF_M,
  BUILDUP_VARIANT_COUNT, FINISH_VARIANT_COUNT, SCENE_DWELL_MS, SEGMENT_SPEED,
  LANE_WEIGHTS, pickLane,
  CARRIER_RUN_SPEED, SUPPORT_RUN_SPEED, FOOT_OFFSET_M, TOUCH_MS,
  MAX_SHOT_DIST_M,
  type ScenePoint, type SceneFinish,
} from '../scenes'
import { PITCH_H, PITCH_W } from '../geometry'

/** 골문 반폭(m) — 규정 7.32 m. */
const GOAL_HALF_M = 3.66
/** 크로스바 높이(m). */
const CROSSBAR_M = 2.44
import { buildSequence, offsideLineFor, sceneKeyFor } from '../choreography'
import { XI_SLOTS } from '../formations'
import type { FormationId } from '../../../engine/types'

/** 0~100 좌표 두 점의 실제 거리(m). */
const metres = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(((b[0] - a[0]) / 100) * PITCH_W, ((b[1] - a[1]) / 100) * PITCH_H)

/** 결과 키프레임(마지막 = 볼이 골문/GK/박스에 도달한 지점). */
const endOf = (pts: ScenePoint[]) => pts[pts.length - 1]
/** 슈팅 지점 키프레임 = arc가 'shot'인 마지막 스텝. 없으면 null(찬스). */
const shotOf = (pts: ScenePoint[]) => [...pts].reverse().find(p => p.arc === 'shot') ?? null
/** 빌드업 마지막(=배달이 출발하는) 스텝 = arc가 'shot'인 스텝 직전의 출발 키프레임. */
function deliverOf(pts: ScenePoint[]): ScenePoint | null {
  const i = pts.findIndex(p => p.arc === 'shot')
  if (i <= 0) return null
  // 배달 구간의 출발 = 슈팅 지점 바로 앞 키프레임 중 볼이 실제로 움직이는 마지막 것.
  for (let k = i - 1; k >= 0; k--) if (metres(pts[k].ball, pts[k + 1].ball) > 1) return pts[k]
  return null
}

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
  // ★ 2026-08-01(9라운드) 계열 4 → **10**. 사용자 요구: "슈팅까지 가는 패턴도 더 만들어.
  //   5개 더 만들어서 패턴이 10개 되도록." 세는 대상은 **빌드업 계열**이다(득점 루트 5종은
  //   별도 축). 존 축(박스 안/밖)이 박스 밖 전용이 아닌 8계열의 칸을 두 배로 만든다.
  it('(계열 10 → 존 적용 18) × 실행 2 × 마무리 5 × 득점루트 5 × 레인 6 = 5400 + 세트피스 4', () => {
    expect(LANE_COUNT).toBe(6)
    expect(BUILDUP_VARIANT_COUNT).toBe(2)
    // ★ 2026-08-01: 득점 루트를 3 → 5로 늘렸다(크로스 헤더·드리블 돌파 추가).
    expect(FINISH_VARIANT_COUNT).toBe(5)
    expect(sceneLibrarySize()).toEqual({
      buildups: 10, open: 5400, setPiece: 4, total: 5404, reachablePerMatch: 6480,
    })
  })

  it('★ 계열 10종이 서로 다른 라벨과 "한 줄 그림"을 갖는다 — 좌표만 다른 복제가 아니다', () => {
    const ids = Object.keys(BUILDUP_PICTURES)
    expect(ids).toHaveLength(10)
    expect(new Set(Object.values(BUILDUP_PICTURES).map(v => v.label)).size).toBe(10)
    expect(new Set(Object.values(BUILDUP_PICTURES).map(v => v.picture)).size).toBe(10)
    // 박스 밖 전용은 정확히 둘(외곽 순환 · 세트피스 2차 볼)이다.
    expect(ids.filter(id => BUILDUP_PICTURES[id as keyof typeof BUILDUP_PICTURES].alwaysOut))
      .toEqual(['outside', 'secondball'])
  })

  // ★ 2026-08-01: attackPattern이 계열을 **고정하지 않고 기울이기만** 하게 되면서
  //   한 경기에서 4계열 전부가 도달 가능해졌다(예전 216 → 1440).
  it('한 경기 도달 가능 조합은 6480이다 — 이 수가 반복 게이트의 분모다', () => {
    expect(sceneLibrarySize().reachablePerMatch).toBe(6480)
  })

  it('attackPattern의 최빈 계열은 4택과 1:1이고 서로 다르다', () => {
    const ids = PATTERNS.map(p => BUILDUP_BY_PATTERN[p])
    expect(new Set(ids).size).toBe(4)
    for (const p of PATTERNS) expect(buildupLabel(p).length).toBeGreaterThan(0)
  })

  // ★ 5라운드 피드백 ③ — 전술은 분포를 기울일 뿐 고정하지 않는다.
  it('attackPattern은 계열 분포를 기울인다 — 10계열 전부가 나오되 고른 쪽이 최빈이다', () => {
    for (const p of PATTERNS) {
      const count: Record<string, number> = {}
      for (let u = 0; u < 100; u++) {
        const id = pickBuildup(p, u)
        count[id] = (count[id] ?? 0) + 1
      }
      // 10계열 전부 등장하고, 어느 것도 0이 아니다.
      expect(Object.keys(count).length, p).toBe(10)
      for (const id of Object.keys(count)) expect(count[id], `${p}/${id}`).toBeGreaterThanOrEqual(3)
      // 고른 전술의 계열이 최빈이고, 두 번째보다 확실히 크다(화면에서 전술이 보인다).
      const sorted = Object.entries(count).sort((a, b) => b[1] - a[1])
      expect(sorted[0][0], p).toBe(BUILDUP_BY_PATTERN[p])
      expect(sorted[0][1] - sorted[1][1], p).toBeGreaterThanOrEqual(5)
      // 기본(balanced)은 고르게 — 최빈이 3분의 1을 넘지 않는다.
      if (p === 'balanced') expect(sorted[0][1]).toBeLessThanOrEqual(33)
    }
  })

  it('득점 루트는 5종이고 라벨이 서로 다르다 — 헤더·드리블 돌파 포함', () => {
    expect(FINISH_ROUTE_LABELS.length).toBe(5)
    expect(new Set(FINISH_ROUTE_LABELS).size).toBe(5)
    expect(FINISH_ROUTE_LABELS.some(l => l.includes('헤더'))).toBe(true)
    expect(FINISH_ROUTE_LABELS.some(l => l.includes('드리블'))).toBe(true)
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
        buildScene(p, 'goal', 0, { buildup: b }).points.map(s => s.ball.join(',')).join('|'))
      expect(new Set(paths).size, p).toBe(2)
    }
  })

  it('마무리 변형 5종은 슈팅 지점과 결과 지점이 모두 다르다', () => {
    const shots = new Set<string>()
    const ends = new Set<string>()
    for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
      const pts = buildScene('cross', 'goal', 0, { finish: f }).points
      shots.add(shotOf(pts)!.ball.join(','))
      ends.add(endOf(pts).ball.join(','))
    }
    expect(shots.size, '슈팅 지점').toBe(FINISH_VARIANT_COUNT)
    expect(ends.size, '결과 지점').toBe(FINISH_VARIANT_COUNT)
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
            expect(endOf(goal).ball[0], tag).toBeGreaterThan(98)
            expect(Math.abs(endOf(goal).ball[1] - 50), tag).toBeLessThanOrEqual(6)
            // 세이브: **GK가 손으로 닿을 수 있는 띠**에서 멈추고 골문 폭 안이다.
            // ★ 예전 계약은 90 < x < 95, 즉 골라인에서 5.3~10.5 m 앞이었다. GK 박스는
            //   골라인 0.6~6 m이고 신전 반경이 2 m라 그 띠에서는 접촉이 물리적으로
            //   불가능했다(실측 GK-볼 최소거리 7.03 m). 지금은 골라인 1.5~4 m 안이다.
            const saveGap = ((100 - endOf(save).ball[0]) / 100) * PITCH_W
            expect(saveGap, tag).toBeGreaterThan(1.5)
            expect(saveGap, tag).toBeLessThan(4)
            expect(endOf(save).contact, tag).toBe(true)
            expect(Math.abs(endOf(save).ball[1] - 50), tag).toBeLessThanOrEqual(7)
            // 미스: 골라인까지 가지만 **골문 안으로는 들어가지 않는다** — 포스트 밖으로
            // 벗어나거나 크로스바를 넘거나, 둘 다.
            // ★ 예전 계약은 "골문 중앙에서 4 units(2.7 m) 넘게 벗어난다"였고, 실제 저술은
            //   포스트 밖 5.18 / 11.30 / 19.46 m였다 — StatsBomb 실측(오프타깃 7,772건)의
            //   p90~p99 꼬리다. 사용자 지적 "너무 멀찍하게 빗나가서 긴장감이 떨어져"가 그 값이다.
            //   지금은 실측 분포를 따르므로 "골대 근처"가 정상이고, 계약은 방향이 아니라
            //   **골이 아님**을 고정해야 한다.
            expect(endOf(miss).ball[0], tag).toBeGreaterThan(98)
            const missOutZ = Math.abs(endOf(miss).ball[1] - 50) - (GOAL_HALF_M / PITCH_H) * 100
            const missOver = (endOf(miss).endY ?? 0) - CROSSBAR_M
            expect(missOutZ > 0 || missOver > 0, `${tag}: 미스가 골문 안이다`).toBe(true)
            // 그리고 골대에서 8 m 넘게 벗어나지 않는다(실측 p99는 프레임에서 12.6 m,
            // 우리 라이브러리는 그보다 안쪽만 쓴다 — 긴장감이 목적이다).
            expect(Math.hypot(Math.max(0, missOutZ) * PITCH_H / 100, Math.max(0, missOver)), tag).toBeLessThan(8)
            // 블록: 골문 앞에서 멈춘다(골보다 앞).
            expect(endOf(shot).ball[0], tag).toBeGreaterThan(90)
            expect(endOf(shot).ball[0], tag).toBeLessThan(endOf(goal).ball[0])
            // 찬스: 마무리 자체가 없다 — 슛 계열보다 골문에서 멀다.
            expect(shotOf(chance), tag).toBeNull()
            expect(endOf(chance).ball[0], tag).toBeLessThan(endOf(shot).ball[0])
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
  // ★ 2026-08-01 재작성. 전술이 계열을 **고정**하던 시절에는 같은 이벤트 하나로도 패턴마다
  //   궤적이 갈렸다. 지금은 분포를 기울일 뿐이라 이벤트 한 건은 우연히 같은 계열을 뽑을 수
  //   있다 — 대신 **한 경기 분량의 이벤트 집합**에서 분포가 뚜렷이 갈리는지를 본다.
  it('한 경기 분량에서 패턴마다 계열 분포가 다르고, 고른 계열이 최빈이다', () => {
    const famOf = (p: AttackPattern, minute: number) =>
      sceneKeyFor(ev('goal', { minute, playerId: `x${minute}` }), withPattern(p).home, base.away)!
        .split('/')[1].split('.')[0]
    const dist: Record<string, Record<string, number>> = {}
    for (const p of PATTERNS) {
      const c: Record<string, number> = {}
      for (let m = 1; m <= 90; m++) { const f = famOf(p, m); c[f] = (c[f] ?? 0) + 1 }
      dist[p] = c
    }
    for (const p of PATTERNS) {
      // 한 경기(90건)에 여러 계열이 보인다 — 사용자가 "하나만 보인다"고 한 것의 반대.
      expect(Object.keys(dist[p]).length, p).toBeGreaterThanOrEqual(3)
      // 고른 전술의 계열이 최빈이다(전술이 화면에 보인다).
      const top = Object.entries(dist[p]).sort((a, b) => b[1] - a[1])[0][0]
      expect(top, p).toBe(BUILDUP_BY_PATTERN[p])
    }
    // 패턴 넷의 분포가 서로 다르다.
    expect(new Set(PATTERNS.map(p => JSON.stringify(dist[p]))).size).toBe(4)
  })

  it('크로스는 측면 끝(터치라인)까지 나가고, 중거리는 박스 밖에서 마무리한다', () => {
    const cross = buildScene('cross', 'goal', 0).points
    const long = buildScene('longshot', 'goal', 0).points
    // 크로스 빌드업 마지막 점(=배달이 출발하는 곳) = 엔드라인 부근 측면.
    const cl = deliverOf(cross)!.ball
    expect(cl[0]).toBeGreaterThan(75)
    expect(Math.abs(cl[1] - 50)).toBeGreaterThan(30)
    // 중거리는 훨씬 뒤에서 배달한다(그래서 슛도 멀리서 나간다).
    expect(deliverOf(long)!.ball[0]).toBeLessThan(cl[0] - 8)
  })

  it('중앙 침투는 스루패스 구간이 지면(ground)이다 — 뜨면 수비가 따라붙는다', () => {
    const s = buildScene('through', 'goal', 0).points
    // 두 번째 볼 이동 구간(스루패스)이 지면이다.
    const moving = s.filter((p, i) => i + 1 < s.length && metres(p.ball, s[i + 1].ball) > 1)
    expect(moving[1].arc).toBe('ground')
  })

  // ★ R4 회귀 가드(아크 오프바이원). 예전엔 deliverArc가 **슈팅 지점** 스텝에 붙어,
  //   크로스 전술 유저가 모든 골·세이브·미스에서 6 m 떠서 들어가는 슛을 봤다.
  it('측면 전개의 배달 구간이 크로스 아크로 뜨고, 슛 구간은 항상 shot이다', () => {
    const cross = buildScene('cross', 'goal', 0).points
    expect(deliverOf(cross)!.arc).toBe('cross')
    expect(shotOf(cross)!.arc).toBe('shot')
    // 중앙 전개의 배달은 크로스가 아니다(그리고 절대 'shot'이 아니다).
    const mid = buildScene('balanced', 'goal', 0).points
    expect(deliverOf(mid)!.arc).not.toBe('cross')
    expect(deliverOf(mid)!.arc).not.toBe('shot')
  })

  it('★ 배달 구간에 shot 아크가 붙는 조합은 하나도 없다(전수)', () => {
    for (const p of PATTERNS) {
      for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
        for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
          for (let l = 0; l < LANE_COUNT; l++) {
            for (const fin of ['goal', 'save', 'miss', 'shot'] as const) {
              const pts = buildScene(p, fin, l, { buildup: b, finish: f }).points
              const tag = `${p}/b${b}/f${f}/L${l}/${fin}`
              // 'shot' 아크는 정확히 한 번, 그리고 마지막 볼 이동 구간에만 나온다.
              const shots = pts.filter(x => x.arc === 'shot')
              expect(shots, tag).toHaveLength(1)
              expect(shots[0], tag).toBe(shotOf(pts))
            }
          }
        }
      }
    }
  })

  it('결과는 엔진이 정한다 — 같은 빌드업이라도 마무리가 결과대로 끝난다', () => {
    const goal = buildScene('balanced', 'goal', 0).points
    const save = buildScene('balanced', 'save', 0).points
    const miss = buildScene('balanced', 'miss', 0).points
    // 골만 골라인(99)에 닿는다. 세이브는 GK 손이 닿는 띠에서, 미스는 골문 밖으로.
    expect(goal[goal.length - 1].ball[0]).toBeGreaterThan(98)
    expect(save[save.length - 1].ball[0]).toBeLessThan(goal[goal.length - 1].ball[0])
    expect(save[save.length - 1].contact).toBe(true)
    // 미스는 골문 안으로 들어가지 않는다(옆으로 벗어나거나 크로스바를 넘는다).
    const end = miss[miss.length - 1]
    const outZ = Math.abs(end.ball[1] - 50) - (GOAL_HALF_M / PITCH_H) * 100
    expect(outZ > 0 || (end.endY ?? 0) > CROSSBAR_M).toBe(true)
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
    expect(k).toMatch(
      /^H\/(central|wing|through|outside|counter|switch|longball|press|carry|secondball)\.[ab]\/goal\.[abcde]\/L[0-5]\/Z(in|out)$/,
    )
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
  // ★ 계열이 이벤트 해시로 뽑히게 되면서 같은 이벤트의 두 패턴이 우연히 같은 계열을 쓸 수
  //   있다 — 그래서 **계열을 직접 지정**해 역할 원형이 실제로 다른지를 본다.
  it('빌드업 계열이 다르면 역할 원형(뽑히는 선수)도 다르다', () => {
    const rolesOf = (id: string) => {
      for (let u = 0; u < 100; u++) {
        if (pickBuildup('balanced', u) === id) return JSON.stringify(buildScene('balanced', 'goal', 0, { family: u }).roles)
      }
      throw new Error(`no u for ${id}`)
    }
    const all = Object.keys(BUILDUP_PICTURES).map(rolesOf)
    expect(new Set(all).size).toBe(10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 물리 계약 (docs/research/football-sim-physics.md) — 2026-07-30 전면 개편의 본체.
//   예전 저술은 볼 궤적과 무버 궤적을 따로 썼고, 실측에서 둘이 6.7~17.9 m 떨어져 있었다.
//   아래 세 검사가 그 상태로의 회귀를 막는다.
// ─────────────────────────────────────────────────────────────────────────────
describe('★ 볼은 항상 누군가의 발에 있다', () => {
  it('캐리어가 지정된 모든 키프레임에서 볼-발 거리가 FOOT_OFFSET_M ± 5 cm다', () => {
    let worst = 0
    let worstTag = ''
    for (const p of PATTERNS) {
      for (const fin of ['goal', 'save', 'miss', 'shot', 'chance'] as const) {
        for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
          for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
            for (let l = 0; l < LANE_COUNT; l++) {
              const s = buildScene(p, fin, l, { buildup: b, finish: f })
              for (const pt of s.points) {
                if (pt.carrier == null) continue
                const d = metres(pt.movers[pt.carrier], pt.ball)
                if (d > worst) { worst = d; worstTag = `${s.key} t=${pt.t.toFixed(3)}` }
              }
            }
          }
        }
      }
    }
    expect(worst, `최악 볼-발 거리 ${worst.toFixed(3)} m @ ${worstTag}`).toBeLessThan(FOOT_OFFSET_M + 0.05)
  })

  it('세트피스도 같은 계약을 지킨다', () => {
    for (const fin of ['corner', 'foul'] as const) {
      for (let l = 0; l < 2; l++) {
        for (const pt of buildScene('balanced', fin, l).points) {
          if (pt.carrier == null) continue
          expect(metres(pt.movers[pt.carrier], pt.ball)).toBeLessThan(FOOT_OFFSET_M + 0.05)
        }
      }
    }
  })
})

describe('★ 페이싱 — 1x가 진짜 축구다', () => {
  /** 한 장면의 모든 구간을 (dt초, 볼 m/s, 무버 최대 m/s)로 편다. */
  function segments(pattern: AttackPattern, fin: SceneFinish, opts: { buildup: number; finish: number; lane: number }) {
    const s = buildScene(pattern, fin, opts.lane, { buildup: opts.buildup, finish: opts.finish })
    const dwell = SCENE_DWELL_MS[fin]
    const out: { dt: number; ball: number; mover: number; arc?: string; key: string }[] = []
    for (let i = 0; i + 1 < s.points.length; i++) {
      const dt = ((s.points[i + 1].t - s.points[i].t) * dwell) / 1000
      const mover = Math.max(...s.points[i].movers.map((m, k) => metres(m, s.points[i + 1].movers[k]) / dt))
      out.push({ dt, ball: metres(s.points[i].ball, s.points[i + 1].ball) / dt, mover, arc: s.points[i].arc, key: s.key })
    }
    return out
  }

  const all = () => {
    const out: ReturnType<typeof segments> = []
    for (const p of PATTERNS) {
      for (const fin of ['goal', 'save', 'miss', 'shot', 'chance'] as const) {
        for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
          for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
            for (let l = 0; l < LANE_COUNT; l++) out.push(...segments(p, fin, { buildup: b, finish: f, lane: l }))
          }
        }
      }
    }
    return out
  }

  // ★ 사용자 불만 ②의 상한. 예전엔 무버가 초속 14 m(볼트보다 빠름)로 달렸다.
  it('어떤 무버도 인간 스프린트 상한을 넘지 않는다', () => {
    const segs = all()
    const worst = Math.max(...segs.map(s => s.mover))
    expect(worst, `최고 무버 속도 ${worst.toFixed(2)} m/s`).toBeLessThanOrEqual(SUPPORT_RUN_SPEED + 1e-6)
  })

  it('볼 속도가 궤적 종류의 의도 속도를 넘지 않는다(슛 25 · 크로스 20 · 패스 15 · 지면 13)', () => {
    for (const s of all()) {
      const cap = SEGMENT_SPEED[(s.arc ?? 'pass') as keyof typeof SEGMENT_SPEED]
      expect(s.ball, `${s.key} arc=${s.arc}`).toBeLessThanOrEqual(cap + 1e-6)
    }
  })

  // ★ 예전엔 정확히 뒤집혀 있었다 — 빌드업 패스 22~25 m/s, 마무리 슛 14 m/s.
  it('마무리 슛이 빌드업의 어떤 구간보다 빠르다', () => {
    for (const p of PATTERNS) {
      for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
        for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
          const segs = segments(p, 'goal', { buildup: b, finish: f, lane: 0 })
          const shot = segs.find(x => x.arc === 'shot')!
          const build = segs.filter(x => x.arc !== 'shot' && x.ball > 0.1)
          for (const x of build) expect(shot.ball, `${x.key} ${x.arc}`).toBeGreaterThan(x.ball)
        }
      }
    }
  })

  // ★ 예전엔 공이 90분 하이라이트 내내 **한 번도 멈추지 않았다.**
  it('구간 사이에 컨트롤 정지가 들어간다(공이 실제로 멈춘다)', () => {
    for (const p of PATTERNS) {
      const segs = segments(p, 'goal', { buildup: 0, finish: 0, lane: 0 })
      const stops = segs.filter(x => x.ball < 0.05)
      expect(stops.length, p).toBeGreaterThanOrEqual(2)
      for (const st of stops) expect(st.dt * 1000).toBeCloseTo(TOUCH_MS, 3)
    }
  })

  it('캐리어 주행 상한이 지원 무버 상한보다 낮다(공을 받을 사람이 먼저 도착한다)', () => {
    expect(CARRIER_RUN_SPEED).toBeLessThan(SUPPORT_RUN_SPEED)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ★ 슛 거리 — StatsBomb 실측 분포 계약 (사용자 지적 R5 ①)
//
// 대조군: statsbomb/open-data 4,235경기 중 무작위 350경기의 **오픈플레이 슛 8,348건**의
// `location` → 골문 중앙 거리(야드→m).
//   p10 7.4 · p25 10.7 · **p50 16.1** · p75 22.2 · p90 27.1 · p95 30.0 · p99 37.2 m
//   페널티 박스 안 63.8% · 30 m 초과 5.0% · 박스 밖만 보면 p50 22.4 · p90 30.1
//
// 개편 전 실측(전수 576조합): **전 패턴 p50 26.9 m · 박스 안 0%**. 원인은 `finishStations`의
// `launch`가 슈터가 아니라 마지막 패서였고, 그래서 clamp 상한이 하한보다 작아져 슛 지점이
// 항상 하한(x=74)으로 붙은 것이다.
// ═══════════════════════════════════════════════════════════════════════════
describe('★ 슛 발사점 — 실측 분포를 따른다', () => {
  /** 슛 발사점에서 골문 중앙(x=100, y=50)까지의 거리(m). home 프레임. */
  const shotDist = (pts: ScenePoint[]) => {
    const s = shotOf(pts)!
    return metres(s.ball, [100, 50])
  }
  /** 한 빌드업 계열의 전 조합(마무리 4 × 실행 2 × 변형 3 × 레인 6) 슛 거리. */
  function dists(p: AttackPattern): number[] {
    const out: number[] = []
    for (const fin of ['goal', 'save', 'miss', 'shot'] as const) {
      for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
        for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
          for (let l = 0; l < LANE_COUNT; l++) {
            out.push(shotDist(buildScene(p, fin, l, { buildup: b, finish: f }).points))
          }
        }
      }
    }
    return out.sort((a, b) => a - b)
  }
  const p50 = (a: number[]) => a[Math.floor(a.length / 2)]
  /** 페널티 박스 깊이(m) — 실측 대조군의 "박스 안" 기준. */
  const BOX_D = 16.5

  it('★ 어떤 전술·조합에서도 슛 거리가 상한을 넘지 않는다 — 하프라인 중거리 금지', () => {
    for (const p of PATTERNS) {
      const d = dists(p)
      expect(d[d.length - 1], `${p} 최원거리 ${d[d.length - 1].toFixed(1)} m`)
        .toBeLessThanOrEqual(MAX_SHOT_DIST_M + 0.5)
    }
    // 상한 자체가 실측 p95(30.0 m) 근처에 있어야 의미가 있다.
    expect(MAX_SHOT_DIST_M).toBeGreaterThanOrEqual(28)
    expect(MAX_SHOT_DIST_M).toBeLessThanOrEqual(33)
  })

  it('★ longshot이 아니면 슛의 절반 이상이 박스 안이고 중앙값이 실측 근처다', () => {
    // 실측 오픈플레이 p50 16.1 m. balanced(기본값)를 그 값에 맞추고, 크로스·스루는
    // 그보다 가깝다(크로스 마무리와 뒷공간 침투는 실제로 문전에서 끝난다).
    // "박스 안"의 기준은 **골문 중앙 16.5 m 이내**다 — 실측에서 그 비율은 51.6%다
    // (박스 사각형 기준 63.8%보다 낮다: 박스 모서리는 골문에서 25 m다).
    for (const [p, hi] of [['balanced', 18], ['cross', 14], ['through', 15]] as const) {
      const d = dists(p)
      expect(p50(d), `${p} p50 ${p50(d).toFixed(1)} m`).toBeLessThanOrEqual(hi)
      const inBox = d.filter(v => v <= BOX_D).length / d.length
      expect(inBox, `${p} 박스 안 ${(inBox * 100).toFixed(0)}%`).toBeGreaterThan(0.44)
    }
  })

  it('★ longshot을 고르면 박스 밖으로 나가되 실측 중거리 띠에 머문다', () => {
    const d = dists('longshot')
    // 실측 "박스 밖 슛" p50 22.4 · p90 30.1 m.
    expect(p50(d)).toBeGreaterThan(19)
    expect(p50(d)).toBeLessThan(25)
    expect(d.filter(v => v <= BOX_D).length / d.length, '중거리인데 박스 안이 많다')
      .toBeLessThan(0.2)
  })

  it('★ 유저 전술이 화면에서 갈린다 — longshot 중앙값이 나머지보다 5 m 이상 멀다', () => {
    const long = p50(dists('longshot'))
    for (const p of ['balanced', 'cross', 'through'] as const) {
      expect(long - p50(dists(p)), `longshot vs ${p}`).toBeGreaterThan(5)
    }
  })

  it('슈터는 배달 한 구간에 갈 수 있는 곳에서만 찬다(허공 슛 방지)', () => {
    for (const p of PATTERNS) {
      for (const fin of ['goal', 'save', 'miss', 'shot'] as const) {
        for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
          for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
            for (let l = 0; l < LANE_COUNT; l++) {
              const s = buildScene(p, fin, l, { buildup: b, finish: f })
              const i = s.points.findIndex(x => x.arc === 'shot')
              // 배달 구간 = 슛 스텝 직전의 볼이 실제로 움직이는 스텝. 그 스텝의 슬롯 0이
              // 슈터의 출발점이고, 슛 스텝의 슬롯 0이 도착점이다.
              let from = -1
              for (let k = i - 1; k >= 0; k--) if (metres(s.points[k].ball, s.points[k + 1].ball) > 1) { from = k; break }
              const run = metres(s.points[from].movers[0], s.points[i].movers[0])
              expect(run, `${s.key} 슈터 주행 ${run.toFixed(1)} m`).toBeLessThan(13.9)
            }
          }
        }
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ★ 골은 골문 안으로 들어간다 (블라인드 감사 ⑥)
//
// > 득점 순간 리플레이 카메라에서 공이 골망 안이 아니라 골대 오른쪽 기둥 바깥 잔디에 떠 있다.
//
// 실측(전수 144조합): 96조합의 종점이 골 중앙에서 **3.47 m**(포스트 3.66 m — 여유 19 cm,
// 공 반지름 0.11 + 포스트 반지름 0.09를 빼면 0)이고, x는 99 = 골라인 **1.05 m 앞**이었다.
// 원근이 눌리는 골 뒤 카메라에서 그 공은 기둥 바깥으로 읽힌다.
// ═══════════════════════════════════════════════════════════════════════════
describe('★ 골 종점 — 골라인 위, 기둥 안쪽, 크로스바 아래', () => {
  it('전수 조합에서 골이 골문 프레임 안이다', () => {
    for (const p of PATTERNS) {
      for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
        for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
          for (let l = 0; l < LANE_COUNT; l++) {
            const s = buildScene(p, 'goal', l, { buildup: b, finish: f })
            const end = endOf(s.points)
            // 골라인(x=100) 위 — 0~100 좌표계가 표현할 수 있는 최대치다.
            expect(end.ball[0], `${s.key} x`).toBe(100)
            // 기둥 안쪽 여유 ≥ 0.7 m(공 반지름 0.11 + 기둥 반지름 0.09를 빼고도 0.5 m).
            const zM = (Math.abs(end.ball[1] - 50) / 100) * PITCH_H
            expect(GOAL_HALF_M - zM, `${s.key} 기둥 여유 ${(GOAL_HALF_M - zM).toFixed(2)} m`)
              .toBeGreaterThan(0.7)
            // 골은 도착 높이를 저술하지 않는다 — 궤적 기본값(BALL_END.shot 1.05 m)이
            // 크로스바 아래여야 한다.
            expect(end.endY ?? 0, `${s.key} endY`).toBeLessThan(CROSSBAR_M)
          }
        }
      }
    }
  })

  it('세이브 접촉점도 기둥 안쪽이다 — 골문 밖으로 나가는 공을 막지 않는다', () => {
    for (const p of PATTERNS) {
      for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
        for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
          for (let l = 0; l < LANE_COUNT; l++) {
            const s = buildScene(p, 'save', l, { buildup: b, finish: f })
            const zM = (Math.abs(endOf(s.points).ball[1] - 50) / 100) * PITCH_H
            expect(zM, `${s.key} 접촉 z ${zM.toFixed(2)} m`).toBeLessThan(GOAL_HALF_M)
          }
        }
      }
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ★ 박스 안/밖 슛 비율 (2026-08-01 9라운드 사용자 요구)
//
// > 지금도 선수들이 박스 안에서 슈팅하는 게 많이 않아. **균형으로 했을 때 박스 안 슈팅이
// > 70% 이상**이어야 해. **중거리 슛으로 감독이 결정하면 중거리는 실제로 70% 이상** 때리고
// > 시뮬레이션도 그런 화면으로 나와야 해.
//
// 개편 전 실측(90분 실주행 40시드): balanced 박스 안 **56.9%**, longshot 박스 밖 **67.7%**.
// 둘 다 관문 미달이었다. 원인은 (a) 계열별 슛 거리 사다리 3칸 중 2칸이 박스 밖이었고,
// (b) 세이브 하한(SAVE_MIN_M 16~18 m)이 박스 라인 바로 위에 있어 세이브 43%가 밖으로
// 밀렸으며, (c) 존이라는 축 자체가 없어 "중거리 지시"가 `outside` 계열 55%로만 표현됐다.
//
// "박스 안"의 정의는 실측 대조군(StatsBomb)과 같은 **페널티 에어리어 폴리곤**이다:
// 골라인에서 16.5 m 이내 & 폭 40.32 m 이내. (거리 16.5 m 원이 아니다 — 박스 모서리는
// 골문에서 25 m다.)
// ═══════════════════════════════════════════════════════════════════════════
describe('★ 박스 안/밖 슛 비율 — 감독의 결정이 슛 위치를 정한다', () => {
  /** 슛 발사점의 깊이(골라인까지 m)와 좌우(m). */
  const shotGeom = (pts: ScenePoint[]) => {
    const b = shotOf(pts)!.ball
    return { depth: ((100 - b[0]) / 100) * PITCH_W, lat: (Math.abs(b[1] - 50) / 100) * PITCH_H }
  }
  const inBox = (pts: ScenePoint[]) => {
    const g = shotGeom(pts)
    return g.depth <= BOX_DEPTH_M && g.lat <= BOX_HALF_M
  }
  const KINDS = ['goal', 'save', 'miss'] as const
  /** SAVE_MIN_M의 하한(가장 가까운 칸) — GK가 접촉점까지 몸을 보낼 수 있는 최소 거리. */
  const SAVE_MIN_M_FLOOR = 16.0
  const FAMS = Object.keys(BUILDUP_PICTURES) as (keyof typeof BUILDUP_PICTURES)[]
  /** 계열 id → 그 계열을 뽑는 해시값 u(누적 합 탐색이므로 존재가 보장된다). */
  const uFor = (fam: string) => {
    for (let u = 0; u < 100; u++) if (pickBuildup('balanced', u) === fam) return u
    throw new Error(`no u for ${fam}`)
  }
  /** 존 id → 그 존을 뽑는 해시값 u. */
  const zFor = (pattern: AttackPattern, zone: 'in' | 'out') => {
    for (let u = 0; u < 100; u++) if (pickShotZone(pattern, u) === zone) return u
    throw new Error(`no u for ${zone}`)
  }

  // ── ① 기구 계약 — 존이 실제로 슛 깊이를 정한다(오프사이드 없는 순수 저술) ──
  it('★ 존 in은 전 조합에서 박스 안, 존 out은 전 조합에서 박스 밖이다', () => {
    for (const fam of FAMS) {
      const alwaysOut = BUILDUP_PICTURES[fam].alwaysOut
      for (const zone of ['in', 'out'] as const) {
        if (alwaysOut && zone === 'in') continue // 정의상 존재하지 않는 조합
        for (const kind of KINDS) {
          for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
            for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
              for (let l = 0; l < LANE_COUNT; l++) {
                const sc = buildScene('balanced', kind, l, {
                  family: uFor(fam), buildup: b, finish: f, zone: zFor('balanced', zone),
                })
                const g = shotGeom(sc.points)
                const tag = `${sc.key}/${kind} 깊이 ${g.depth.toFixed(1)} 좌우 ${g.lat.toFixed(1)}`
                if (zone === 'in') {
                  expect(g.depth, tag).toBeLessThanOrEqual(BOX_DEPTH_M)
                  expect(g.lat, tag).toBeLessThanOrEqual(BOX_HALF_M)
                } else {
                  expect(g.depth, tag).toBeGreaterThan(BOX_DEPTH_M)
                }
              }
            }
          }
        }
      }
    }
  })

  // ── ② 분포 계약 — 가중치 표가 사용자 요구 비율을 만든다 ──
  it('★ 가중치 표만으로 balanced 박스 안 ≥ 74% · longshot 박스 밖 ≥ 74%', () => {
    /** 한 (계열, 존) 칸의 박스 안 비율 — 실행 2 × 루트 5 × 레인 6 × 결과 3의 평균. */
    const cell = (pattern: AttackPattern, fam: string, zone: 'in' | 'out') => {
      let n = 0
      let hit = 0
      for (const kind of KINDS) {
        for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
          for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
            for (let l = 0; l < LANE_COUNT; l++) {
              n++
              if (inBox(buildScene(pattern, kind, l, {
                family: uFor(fam), buildup: b, finish: f, zone: zFor(pattern, zone),
              }).points)) hit++
            }
          }
        }
      }
      return hit / n
    }
    const share: Record<string, number> = {}
    for (const p of PATTERNS) {
      let acc = 0
      for (const fam of BUILDUP_ORDER) {
        const w = BUILDUP_WEIGHTS[p][fam] / 100
        if (BUILDUP_PICTURES[fam].alwaysOut) { acc += w * cell(p, fam, 'out'); continue }
        const out = SHOT_ZONE_OUT_PCT[p] / 100
        acc += w * ((1 - out) * cell(p, fam, 'in') + out * cell(p, fam, 'out'))
      }
      share[p] = acc
    }
    // 관문에 4 %p 여유를 둔다 — 실주행에는 오프사이드 상한이라는 한쪽 방향 손실이 있다.
    expect(share.balanced, `balanced 박스 안 ${(share.balanced * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.74)
    expect(1 - share.longshot, `longshot 박스 밖 ${((1 - share.longshot) * 100).toFixed(1)}%`)
      .toBeGreaterThanOrEqual(0.74)
    // 크로스·스루는 문전에서 끝나는 전술이다 — 균형보다 박스 안이 많아야 한다.
    expect(share.cross).toBeGreaterThan(share.balanced)
    expect(share.through).toBeGreaterThan(share.balanced)
  })

  // ── ③ 실주행 계약 — 오프사이드 상한을 통과한 뒤에도 관문을 넘는다 ──
  it('★ 90분 분량 이벤트(패턴당 270건)에서 balanced 박스 안 ≥ 70% · longshot 박스 밖 ≥ 70%', () => {
    const measure = (p: AttackPattern) => {
      // ★ 양 팀 모두에 패턴을 건다. `save`는 **막은 팀(수비)의 사건**이라 안무의 공격 팀이
      //   반대편이 된다(choreography.attackingSideOf) — 한쪽만 걸면 세이브 3분의 1이
      //   상대 전술로 그려져 측정이 섞인다.
      const st = withPattern(p)
      st.away.tactics.attackPattern = p
      let n = 0
      let hit = 0
      for (let m = 1; m <= 90; m++) {
        for (const type of KINDS) {
          const seq = buildSequence(
            ev(type, { minute: m, playerId: st.home.tactics.lineup[9].playerId }), st.home, st.away)
          if (seq.length < 2) continue
          const b = seq[seq.length - 2].ball
          // ★ `save`는 막은 팀의 사건이라 공격 팀이 **원정**이고, 안무가 x를 미러한다
          //   (choreography.buildSequence의 fx). 그쪽 골문은 x=0이다.
          const away = type === 'save'
          const depth = ((away ? b.x : 100 - b.x) / 100) * PITCH_W
          const lat = (Math.abs(b.y - 50) / 100) * PITCH_H
          n++
          if (depth <= BOX_DEPTH_M && lat <= BOX_HALF_M) hit++
        }
      }
      return { n, q: hit / n, se: Math.sqrt(((hit / n) * (1 - hit / n)) / n) }
    }
    const bal = measure('balanced')
    const lng = measure('longshot')
    expect(bal.n).toBeGreaterThanOrEqual(250)
    // 관문에서 SE의 2배 이상 떨어져 있어야 "판정 가능"이다(이 프로젝트 규칙).
    expect(bal.q, `balanced 박스 안 ${(bal.q * 100).toFixed(1)}% ±${(bal.se * 100).toFixed(1)}`)
      .toBeGreaterThanOrEqual(0.70 + 2 * bal.se)
    expect(1 - lng.q, `longshot 박스 밖 ${((1 - lng.q) * 100).toFixed(1)}% ±${(lng.se * 100).toFixed(1)}`)
      .toBeGreaterThanOrEqual(0.70 + 2 * lng.se)
  })

  it('세이브는 거리를 줄이지 않고 **각도를 열어** 박스 안으로 들어간다 — GK 접촉 계약이 산다', () => {
    // 존 in의 세이브는 골문 중앙까지의 거리가 SAVE_MIN_M 하한(16.0 m) 아래로 내려가면 안 된다.
    for (let b = 0; b < BUILDUP_VARIANT_COUNT; b++) {
      for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
        for (let l = 0; l < LANE_COUNT; l++) {
          const sc = buildScene('balanced', 'save', l, {
            family: uFor('central'), buildup: b, finish: f, zone: zFor('balanced', 'in'),
          })
          // 볼은 슈터의 **발 앞** FOOT_OFFSET_M에 놓이므로 하한도 그만큼 앞이다
          // (SAVE_MIN_M 주석의 비행 시간 계산이 이미 이 0.45 m를 빼고 있다).
          const d = metres(shotOf(sc.points)!.ball, [100, 50])
          expect(d, `${sc.key} 세이브 슛 거리 ${d.toFixed(2)} m`)
            .toBeGreaterThanOrEqual(SAVE_MIN_M_FLOOR - FOOT_OFFSET_M - 0.05)
        }
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 오프사이드 (2026-08-01 5라운드 피드백 ②)
// 사용자 캡처: 공격수가 박스 안에서 공을 받는데 최종 수비는 하프라인 근처였다.
// 규칙(경기 규칙 11조): 패스가 **출발하는 순간** 공격수가 뒤에서 두 번째 수비수보다
// 앞서면 안 된다. 단 공보다 뒤에 있거나 자기 진영이면 언제나 온사이드다.
// ─────────────────────────────────────────────────────────────────────────────
describe('오프사이드 — 마무리 배역은 최종 2번째 수비 뒤에 선다', () => {
  const FORMATIONS = Object.keys(XI_SLOTS) as FormationId[]

  /** 수비 팀(어웨이) 라인 높이를 바꾼 상태를 만든다. */
  function withDefLine(formation: FormationId, lineHeight: number) {
    const s = structuredClone(base)
    s.away.tactics.formation = formation
    s.away.tactics.instructions = { ...s.away.tactics.instructions, lineHeight }
    return s
  }

  // ★ 2026-08-01(7라운드 ②) 공격 방향 축을 검사에 추가했다. 평행 이동(scenes.FOCUS_SHIFT)은
  //   y만 건드리지만, 이동한 y가 슛 지점 역산을 거쳐 x로 돌아오므로(finishStations의 gz·gx)
  //   상한 검증을 반드시 다시 돌려야 한다.
  const FOCI: Instructions['attackFocus'][] = ['left', 'center', 'right', 'balanced']

  it('라인 10~90 전 구간 × 포메이션 전종 × 패턴 4종 × 공격방향 4종에서 위반 0', () => {
    let checked = 0
    let worst = -Infinity
    let worstTag = ''
    for (const formation of FORMATIONS) {
      for (let lh = 10; lh <= 90; lh += 10) {
        const st = withDefLine(formation, lh)
        // 규칙상의 상한(마진 없이) — 저술이 이 값을 넘으면 오프사이드다.
        const line = offsideLineFor(st.away, true)
        for (const focus of FOCI) {
        st.home.tactics.instructions = { ...st.home.tactics.instructions, attackFocus: focus }
        for (const pattern of PATTERNS) {
          st.home.tactics.attackPattern = pattern
          for (const minute of [3, 17, 34, 58, 77]) {
            for (const type of ['goal', 'save', 'miss', 'shot', 'chance'] as MatchEventType[]) {
              const shooter = st.home.tactics.lineup[9].playerId
              const seq = buildSequence(ev(type, { minute, playerId: shooter }), st.home, st.away)
              for (let k = 0; k + 1 < seq.length; k++) {
                const p = seq[k]
                // 공을 가진 본인은 오프사이드가 될 수 없다.
                if (!p.carrier || p.carrier === shooter) continue
                const m = p.movers.find(mv => mv.playerId === shooter)
                if (!m) continue
                // 상한 = max(뒤에서 두 번째 수비, 공, 하프라인).
                const cap = Math.max(line, p.ball.x, 50)
                checked++
                const gap = m.x - cap
                if (gap > worst) { worst = gap; worstTag = `${formation}/lh${lh}/${focus}/${pattern}/${minute}:${type}/k${k}` }
              }
            }
          }
        }
        }
      }
    }
    expect(checked, '검사 프레임 수').toBeGreaterThan(20000)
    expect(worst, `최악: ${worstTag}`).toBeLessThanOrEqual(0)
  })

  it('상한은 라인 슬라이더를 따라 움직인다 — 고정 상수가 아니다', () => {
    const low = offsideLineFor(withDefLine('4-3-3', 10).away, true)
    const high = offsideLineFor(withDefLine('4-3-3', 90).away, true)
    // 라인을 올리면(90) 수비가 앞으로 나오므로 상한이 **작아진다**.
    expect(high).toBeLessThan(low - 20)
    // 그리고 그 차이가 실제 마무리 지점에도 나타난다.
    const shotX = (lh: number) => {
      const st = withDefLine('4-3-3', lh)
      const seq = buildSequence(ev('goal', { minute: 12, playerId: st.home.tactics.lineup[9].playerId }), st.home, st.away)
      return seq[seq.length - 2].ball.x
    }
    expect(shotX(90)).toBeLessThan(shotX(10))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ★ 공격 방향 (2026-08-01 7라운드 피드백 ②)
// 사용자 지적: "공격 방향을 바꾸면 해당 공격 방향에 맞는 시뮬레이션도 같이 나오게 해줘 —
// 실제 경기에 반영되는 걸 볼 수 있게." 워룸의 `공격방향`은 그때까지 화면에 전혀
// 나타나지 않았다(레인이 균일 추첨이었다).
// 좌우의 정본: **y가 작을수록 공격 팀의 왼쪽**(AnalysisLayer.focusBand · flow.FLOW_PATTERNS).
// ─────────────────────────────────────────────────────────────────────────────
describe('공격 방향 — 레인 분포와 평행 이동', () => {
  const FOCI: Instructions['attackFocus'][] = ['left', 'center', 'right', 'balanced']

  it('균형은 **균일 분포**다 — 기본값에서는 어느 레인도 편애하지 않는다', () => {
    for (const mirror of [false, true]) {
      const hist = new Array(LANE_COUNT).fill(0)
      for (let u = 0; u < 100; u++) hist[pickLane('balanced', u, mirror)]++
      // 6칸 × 100 추첨 → 각 칸이 16 또는 17이어야 한다(정확히 균일).
      for (const n of hist) expect(n).toBeGreaterThanOrEqual(16)
      for (const n of hist) expect(n).toBeLessThanOrEqual(17)
    }
  })

  it('★ 원정은 홈의 정확한 상하 거울이다 — x 미러 계약이 여기에 걸려 있다', () => {
    for (const focus of FOCI) {
      for (let u = 0; u < 100; u++) {
        // 레인 쌍 (0,1) (2,3) (4,5)가 상하 미러다. 하위 1비트만 뒤집혀야 |y-50| 열이
        // 같아지고, 그래야 finishStations의 슛 거리 역산이 같아 x가 미러로 남는다.
        expect(pickLane(focus, u, true), `${focus}/u${u}`).toBe(pickLane(focus, u, false) ^ 1)
      }
    }
    // 좌·우 가중치는 서로의 거울이다(한쪽 지시만 세게 먹으면 안 된다).
    for (let i = 0; i < LANE_COUNT; i++) expect(LANE_WEIGHTS.left[i]).toBe(LANE_WEIGHTS.right[i ^ 1])
    // 중앙은 좌우 대칭이므로 미러가 자기 자신과 짝을 이룬다.
    expect(LANE_WEIGHTS.center[0]).toBe(LANE_WEIGHTS.center[1])
    expect(LANE_WEIGHTS.center[4]).toBe(LANE_WEIGHTS.center[5])
  })

  it('좌측은 위(y<50) 레인이, 우측은 아래 레인이 최빈이다 — 고정이 아니라 기울임', () => {
    for (const [focus, wantOdd] of [['left', true], ['right', false]] as const) {
      const hist = new Array(LANE_COUNT).fill(0)
      for (let u = 0; u < 100; u++) hist[pickLane(focus, u, false)]++
      const odd = hist[1] + hist[3] + hist[5]
      expect(wantOdd ? odd : 100 - odd, focus).toBeGreaterThanOrEqual(70)
      // 반대쪽도 사라지지 않는다(90분 내내 같은 그림이 되면 안 된다).
      expect(wantOdd ? 100 - odd : odd, focus).toBeGreaterThanOrEqual(10)
      // 여섯 레인 전부 도달 가능하다.
      for (let i = 0; i < LANE_COUNT; i++) expect(hist[i], `${focus}/L${i}`).toBeGreaterThan(0)
    }
    expect(FOCI).toHaveLength(4)
  })

  it('평행 이동은 빌드업 볼을 지시한 쪽으로 옮긴다(좌우 대칭)', () => {
    const meanY = (dir: -1 | 0 | 1) => {
      let sum = 0
      let n = 0
      for (const p of PATTERNS) {
        for (let lane = 0; lane < LANE_COUNT; lane++) {
          const s = buildScene(p, 'goal', lane, { buildup: 0, finish: 0, focusDir: dir })
          for (const pt of s.points) { sum += pt.ball[1] - 50; n++ }
        }
      }
      return sum / n
    }
    const L = meanY(-1), C = meanY(0), R = meanY(1)
    expect(L).toBeLessThan(C - 3)
    expect(R).toBeGreaterThan(C + 3)
    // 대칭 — 한쪽만 세게 먹으면 좌우 지시의 체감이 달라진다.
    expect(Math.abs((L - C) + (R - C))).toBeLessThan(0.5)
  })

  it('평행 이동해도 마무리는 문전이다 — 슛 지점과 골문 통과점의 계약이 산다', () => {
    for (const dir of [-1, 0, 1] as const) {
      for (const p of PATTERNS) {
        for (let lane = 0; lane < LANE_COUNT; lane++) {
          for (let f = 0; f < FINISH_VARIANT_COUNT; f++) {
            const s = buildScene(p, 'goal', lane, { buildup: 0, finish: f, focusDir: dir })
            const shot = shotOf(s.points)!
            // 슛 지점은 박스 폭 안(저술 계약 38~62).
            expect(shot.ball[1], `${s.key}/F${dir}`).toBeGreaterThanOrEqual(37)
            expect(shot.ball[1], `${s.key}/F${dir}`).toBeLessThanOrEqual(63)
            // 골 종점은 골문 안.
            const zM = (Math.abs(endOf(s.points).ball[1] - 50) / 100) * PITCH_H
            expect(zM, `${s.key}/F${dir}`).toBeLessThan(GOAL_HALF_M)
          }
        }
      }
    }
  })

  it('공격 방향과 공격 패턴은 직교한다 — 어떤 조합도 장면을 깨지 않는다', () => {
    for (const p of PATTERNS) {
      for (const dir of [-1, 0, 1] as const) {
        for (const finish of ['goal', 'save', 'miss', 'shot', 'chance'] as SceneFinish[]) {
          for (let lane = 0; lane < LANE_COUNT; lane++) {
            const s = buildScene(p, finish, lane, { buildup: 1, finish: 2, focusDir: dir })
            // 키프레임 계약: 첫 t=0, 단조 증가, 마지막 ≤ 0.8.
            expect(s.points[0].t, s.key).toBe(0)
            for (let i = 1; i < s.points.length; i++) {
              expect(s.points[i].t, `${s.key}#${i}`).toBeGreaterThan(s.points[i - 1].t)
            }
            expect(s.points[s.points.length - 1].t, `${s.key}/F${dir}`).toBeLessThanOrEqual(0.8)
            for (const pt of s.points) {
              expect(pt.ball[1], s.key).toBeGreaterThanOrEqual(0)
              expect(pt.ball[1], s.key).toBeLessThanOrEqual(100)
            }
          }
        }
      }
    }
  })
})
