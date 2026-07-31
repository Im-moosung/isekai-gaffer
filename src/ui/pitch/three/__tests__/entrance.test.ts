// 입장 연출 순수 로직 계약 — 스토리보드 4컷 · 결정론 · 경기장 이탈 금지 · 보폭 정합 ·
// 킥오프 수렴(표시 진영 회전 포함) · 소개 비트(22명 전원 호명).
import { describe, it, expect } from 'vitest'
import {
  ENTRANCE_DISPERSE_MS,
  ENTRANCE_SPLIT_MS,
  ENTRANCE_TUNNEL_MS,
  ENTRANCE_WALKOUT_MS,
  REFEREE_IDS,
  buildEntranceCast,
  entranceBeatAt,
  entranceBeatIndexAt,
  entranceCameraMode,
  entranceFrame,
  entranceHighlightAt,
  entranceIntroSide,
  entrancePhaseAt,
  entranceScript,
  entranceSubtitle,
  positionLabelKo,
  type EntrancePhase,
} from '../entrance'
import { MIN_GAIT_SPEED, strideLength } from '../player3d'
import { FIRST_HALF_ENDS, toWorld } from '../types'
import { tacticalCoords } from '../../shape'
import { XI_SLOTS } from '../../../../engine/formations'
import { lineupGroupOf } from '../../../../game/commentary'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'

const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 11 })
const cast = buildEntranceCast(state)
const full = entranceScript(cast, 'full')
const short = entranceScript(cast, 'short')

/** 경기장 + 터널 여유 경계. */
const MAX_X = 57
const MAX_Z = 36

const span = (s: typeof full, phase: EntrancePhase) => s.phases.find(p => p.phase === phase)!
/** 단계 안을 n등분해 훑는다(경계 ms는 인접 단계로 샌다). */
function within(s: typeof full, phase: EntrancePhase, n = 9): number[] {
  const sp = span(s, phase)
  const out: number[] = []
  for (let i = 1; i <= n; i++) out.push(sp.start + ((sp.end - sp.start) * i) / (n + 1))
  return out
}

describe('buildEntranceCast', () => {
  it('양 팀 XI를 포메이션 슬롯 순서(0 = GK)로 뽑는다', () => {
    expect(cast.home).toHaveLength(11)
    expect(cast.away).toHaveLength(11)
    const homeSlots = XI_SLOTS[cast.homeFormation]
    cast.home.forEach((m, i) => {
      expect(m.slotIndex).toBe(i)
      expect(homeSlots[i]).toBeDefined()
    })
    expect(homeSlots[0]).toBe('GK')
  })

  it('결정론 — 같은 상태로 두 번 만들면 완전히 같다', () => {
    expect(buildEntranceCast(state)).toEqual(cast)
  })
})

describe('스크립트 · 타임라인', () => {
  it('단계 구간이 빈틈 없이 이어지고 총합과 일치한다', () => {
    for (const s of [full, short]) {
      s.phases.forEach((p, i) => {
        if (i > 0) expect(p.start).toBe(s.phases[i - 1].end)
        expect(p.end).toBeGreaterThanOrEqual(p.start)
      })
      expect(s.phases[s.phases.length - 1].end).toBe(s.totalMs)
    }
  })

  it('고정 단계 길이는 모드와 무관하다', () => {
    for (const s of [full, short]) {
      expect(span(s, 'tunnel').end - span(s, 'tunnel').start).toBe(ENTRANCE_TUNNEL_MS)
      expect(span(s, 'walkout').end - span(s, 'walkout').start).toBe(ENTRANCE_WALKOUT_MS)
      expect(span(s, 'split').end - span(s, 'split').start).toBe(ENTRANCE_SPLIT_MS)
      expect(span(s, 'disperse').end - span(s, 'disperse').start).toBe(ENTRANCE_DISPERSE_MS)
    }
  })

  it('short 모드는 소개 두 컷을 통째로 뺀다(길이 0 · 비트 0)', () => {
    expect(span(short, 'home-intro').end - span(short, 'home-intro').start).toBe(0)
    expect(span(short, 'away-intro').end - span(short, 'away-intro').start).toBe(0)
    expect(short.beats).toHaveLength(0)
    // 길이 0인 단계는 절대 선택되지 않는다.
    for (let ms = 0; ms <= short.totalMs; ms += 25) {
      expect(entrancePhaseAt(short, ms)).not.toBe('home-intro')
      expect(entrancePhaseAt(short, ms)).not.toBe('away-intro')
    }
    expect(short.totalMs).toBe(
      ENTRANCE_TUNNEL_MS + ENTRANCE_WALKOUT_MS + ENTRANCE_SPLIT_MS + ENTRANCE_DISPERSE_MS,
    )
  })

  it('full 모드는 소개 두 컷만큼 더 길다', () => {
    expect(full.totalMs).toBeGreaterThan(short.totalMs)
    // 22명 낭독이므로 최소 30초는 되어야 하고(사용자: "천천히 여유롭게"),
    // 그렇다고 2분짜리 실제 의식을 그대로 옮기지는 않는다.
    expect(full.totalMs).toBeGreaterThan(30_000)
    expect(full.totalMs).toBeLessThan(75_000)
  })

  it('경계 시각의 단계가 정확하다', () => {
    expect(entrancePhaseAt(full, -100)).toBe('tunnel')
    expect(entrancePhaseAt(full, 0)).toBe('tunnel')
    expect(entrancePhaseAt(full, ENTRANCE_TUNNEL_MS)).toBe('walkout')
    expect(entrancePhaseAt(full, span(full, 'split').start)).toBe('split')
    expect(entrancePhaseAt(full, span(full, 'home-intro').start)).toBe('home-intro')
    expect(entrancePhaseAt(full, span(full, 'away-intro').start)).toBe('away-intro')
    expect(entrancePhaseAt(full, span(full, 'disperse').start)).toBe('disperse')
    expect(entrancePhaseAt(full, full.totalMs)).toBe('done')
  })

  it('자막은 단계마다 바뀌고 소개 컷은 그 팀 이름을 쓴다', () => {
    const at = (ms: number) => entranceSubtitle(full, ms)
    expect(at(0)).toBe('심판진 입장')
    expect(at(ENTRANCE_TUNNEL_MS + 10)).toBe('양 팀 선수 입장')
    expect(at(span(full, 'split').start + 10)).toBe('양 팀 정렬')
    expect(at(span(full, 'home-intro').start + 10)).toContain(cast.homeTeamKo)
    expect(at(span(full, 'away-intro').start + 10)).toContain(cast.awayTeamKo)
    expect(at(full.totalMs)).toBe('킥오프')
  })

  it('카메라 스크립트 — 와이드 → 클로즈 → 경기 카메라', () => {
    expect(entranceCameraMode(full, within(full, 'tunnel', 1)[0])).toBe('entrance')
    expect(entranceCameraMode(full, within(full, 'walkout', 1)[0])).toBe('entrance')
    expect(entranceCameraMode(full, within(full, 'split', 1)[0])).toBe('entrance')
    expect(entranceCameraMode(full, within(full, 'home-intro', 1)[0])).toBe('entrance-close')
    expect(entranceCameraMode(full, within(full, 'away-intro', 1)[0])).toBe('entrance-close')
    expect(entranceCameraMode(full, within(full, 'disperse', 1)[0])).toBe('broadcast')
    expect(entranceCameraMode(full, 1e9)).toBe('broadcast')
    // short 모드에는 클로즈 컷이 없다.
    for (let ms = 0; ms <= short.totalMs; ms += 50) {
      expect(entranceCameraMode(short, ms)).not.toBe('entrance-close')
    }
  })
})

describe('소개 비트 — 22명을 포지션 그룹으로 묶어 이름으로 부른다', () => {
  it('비트가 시간순으로 빈틈 없이 이어진다', () => {
    full.beats.forEach((b, i) => {
      expect(b.end).toBeGreaterThan(b.start)
      if (i > 0) expect(b.start).toBe(full.beats[i - 1].end)
    })
    expect(full.beats[0].start).toBe(span(full, 'home-intro').start)
    expect(full.beats[full.beats.length - 1].end).toBe(span(full, 'away-intro').end)
  })

  it('양 팀 22명이 **정확히 한 번씩** 호명된다', () => {
    for (const side of ['home', 'away'] as const) {
      const named = full.beats.filter(b => b.side === side && b.playerId)
      expect(named.map(b => b.playerId)).toEqual((side === 'home' ? cast.home : cast.away).map(m => m.id))
    }
  })

  it('호명 순서가 포지션 그룹 순서(GK → 수비 → 중원 → 공격)다', () => {
    for (const side of ['home', 'away'] as const) {
      const members = side === 'home' ? cast.home : cast.away
      const byId = new Map(members.map(m => [m.id, m]))
      const groups = full.beats
        .filter(b => b.side === side && b.playerId)
        .map(b => lineupGroupOf(byId.get(b.playerId!)!.position))
      const order = ['GK', 'DF', 'MF', 'FW']
      let cursor = -1
      for (const g of groups) {
        const at = order.indexOf(g)
        expect(at).toBeGreaterThanOrEqual(cursor) // 되돌아가지 않는다
        cursor = at
      }
    }
  })

  it('그룹 도입 문장이 인원 수를 한국어 수사로 말한다', () => {
    const dfCount = cast.home.filter(m => lineupGroupOf(m.position) === 'DF').length
    const lead = full.beats.find(b => b.side === 'home' && b.text.startsWith('수비 '))
    expect(lead).toBeDefined()
    expect(lead!.text).toBe(`수비 ${dfCount}명`)
    // 발화에는 숫자를 남기지 않는다(§5.3 — "4명"은 "사명"으로 오독된다).
    expect(lead!.speech).not.toMatch(/[0-9]/)
  })

  it('발화 문자열에 라틴 문자·숫자가 없다(sanitizeSpeech 통과)', () => {
    for (const b of full.beats) {
      expect(b.speech, b.speech).not.toMatch(/[A-Za-z]/)
      expect(b.speech.length).toBeGreaterThan(0)
    }
  })

  it('해설위원은 캐스터 뒤에만 나온다(§1.1 — 해설은 먼저 말하지 않는다)', () => {
    expect(full.beats[0].speaker).toBe('caster')
    full.beats.forEach((b, i) => {
      if (b.speaker === 'analyst') expect(full.beats[i - 1]?.speaker).toBe('caster')
    })
  })

  it('entranceBeatAt / entranceHighlightAt이 비트와 일치한다', () => {
    for (const b of full.beats) {
      const mid = (b.start + b.end) / 2
      expect(entranceBeatAt(full, mid)).toBe(b)
      expect(entranceBeatIndexAt(full, mid)).toBe(full.beats.indexOf(b))
      const hi = entranceHighlightAt(full, mid)
      if (b.playerId) {
        expect(hi?.player.id).toBe(b.playerId)
        expect(hi?.side).toBe(b.side)
      } else {
        expect(hi).toBeNull()
      }
    }
    // 소개 구간 밖이면 없다.
    expect(entranceBeatAt(full, 0)).toBeNull()
    expect(entranceBeatAt(full, full.totalMs)).toBeNull()
    expect(entranceIntroSide(full, 0)).toBeNull()
  })
})

describe('entranceFrame', () => {
  it('언제나 22명 + 심판 3명을 돌려준다', () => {
    for (const ms of [0, 500, 3000, 6500, 12000, full.totalMs]) {
      const f = entranceFrame(full, ms)
      expect(f.players).toHaveLength(22)
      expect(f.referees).toHaveLength(3)
      expect(f.referees.map(r => r.id)).toEqual([...REFEREE_IDS])
      expect(f.referee).toBe(f.referees[0])
      expect(f.players.some(p => REFEREE_IDS.includes(p.id as never))).toBe(false)
      expect(f.players.filter(p => p.side === 'home')).toHaveLength(11)
      expect(f.players.filter(p => p.side === 'away')).toHaveLength(11)
    }
  })

  it('모든 시각에서 배역이 경기장 경계 안에 있다', () => {
    for (const s of [full, short]) {
      for (let ms = -200; ms <= s.totalMs + 200; ms += 100) {
        const f = entranceFrame(s, ms)
        for (const p of [...f.players, ...f.referees]) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(MAX_X)
          expect(Math.abs(p.z)).toBeLessThanOrEqual(MAX_Z)
          expect(Number.isFinite(p.yaw)).toBe(true)
          expect(p.speed).toBeGreaterThanOrEqual(0)
        }
        expect(Math.abs(f.focus.x)).toBeLessThanOrEqual(MAX_X)
        expect(Math.abs(f.focus.z)).toBeLessThanOrEqual(MAX_Z)
      }
    }
  })

  it('결정론 — 같은 (script, ms)면 완전히 같은 프레임', () => {
    for (const ms of [0, 1234, 5678, 15000, full.totalMs]) {
      expect(entranceFrame(full, ms)).toEqual(entranceFrame(full, ms))
      expect(entranceFrame(entranceScript(buildEntranceCast(state), 'full'), ms)).toEqual(entranceFrame(full, ms))
    }
  })

  it('범위 밖 ms는 클램프된다', () => {
    expect(entranceFrame(full, -1000)).toEqual(entranceFrame(full, 0))
    expect(entranceFrame(full, full.totalMs + 5000)).toEqual(entranceFrame(full, full.totalMs))
  })

  it('공은 센터스팟에 놓여 있다', () => {
    const f = entranceFrame(full, 3000)
    expect(f.ball.x).toBe(0)
    expect(f.ball.z).toBe(0)
    expect(f.ball.y).toBeGreaterThan(0)
  })

  // ── 컷1: 터널에서 올라온다 + 심판이 중앙으로 ──────────────────────
  it('컷1 — 두 팀은 카메라 쪽 터널(-Z)에서 출발하고 심판 3인이 중앙에 자리 잡는다', () => {
    const start = entranceFrame(full, 200)
    for (const p of start.players) expect(p.z).toBeLessThan(-30)
    // 워크아웃이 끝나면 심판은 가운데 앞쪽에, 선수들은 그보다 카메라 쪽(아래)에 모인다.
    const after = entranceFrame(full, span(full, 'walkout').end - 1)
    for (const r of after.referees) expect(Math.abs(r.x)).toBeLessThan(4)
    // 심판이 두 줄보다 **피치 안쪽**(+Z)에 있어야 화면에서 선수들 위에 선다(스토리보드 컷1).
    const refZ = Math.min(...after.referees.map(r => r.z))
    expect(Math.max(...after.players.map(p => p.z))).toBeLessThan(refZ)
    // 그리고 아직 터널 쪽(하단)에 머문다 — 센터서클까지 나오지 않는다.
    for (const p of after.players) expect(p.z).toBeLessThan(-20)
  })

  // ── 컷2: 좌우로 갈라진다 ─────────────────────────────────────────
  it('컷2 — 두 팀이 좌우로 갈라지고 심판은 중앙에 남는다', () => {
    const f = entranceFrame(full, span(full, 'split').end - 1)
    const home = f.players.filter(p => p.side === 'home')
    const away = f.players.filter(p => p.side === 'away')
    // 홈은 화면 오른쪽(-X), 어웨이는 왼쪽(+X).
    expect(Math.max(...home.map(p => p.x))).toBeLessThan(0)
    expect(Math.min(...away.map(p => p.x))).toBeGreaterThan(0)
    // 두 줄 사이가 실제로 벌어져 있다(붙어 있으면 "갈라졌다"로 안 읽힌다).
    expect(Math.min(...away.map(p => p.x)) - Math.max(...home.map(p => p.x))).toBeGreaterThan(8)
    for (const r of f.referees) expect(Math.abs(r.x)).toBeLessThan(4)
    // 정지해 메인스탠드를 본다(각도는 2π 주기라 감아서 비교한다).
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
    for (const p of f.players) expect(wrap(p.yaw)).toBeCloseTo(-Math.PI / 2, 2)
  })

  // ── 컷3·컷4: 호명 선수만 한 걸음 앞으로 ───────────────────────────
  it('컷3·컷4 — 호명 중인 선수만 카메라 쪽으로 한 걸음 나온다', () => {
    const base = entranceFrame(full, span(full, 'split').end - 1)
    const baseZ = new Map(base.players.map(p => [p.id, p.z]))
    for (const side of ['home', 'away'] as const) {
      const beat = full.beats.find(b => b.side === side && b.playerId)!
      const ms = (beat.start + beat.end) / 2
      const f = entranceFrame(full, ms)
      for (const p of f.players) {
        const dz = p.z - (baseZ.get(p.id) ?? 0)
        if (p.id === beat.playerId) expect(dz).toBeLessThan(-0.9) // -Z = 카메라 쪽
        // 기준 프레임이 컷2 종료 1 ms 전이라 smoothstep 잔여(≈1e-6 m)가 남는다.
        else expect(Math.abs(dz)).toBeLessThan(1e-4)
      }
    }
  })

  it('소개 중에는 카메라 초점이 **그 팀 줄** 위에 있다', () => {
    for (const side of ['home', 'away'] as const) {
      for (const ms of within(full, side === 'home' ? 'home-intro' : 'away-intro', 7)) {
        const f = entranceFrame(full, ms)
        const line = f.players.filter(p => p.side === side)
        const lo = Math.min(...line.map(p => p.x))
        const hi = Math.max(...line.map(p => p.x))
        // 초점이 줄의 x 범위(여유 3m) 안에 있어야 클로즈업이 아무도 없는 곳을 비추지 않는다.
        expect(f.focus.x).toBeGreaterThan(lo - 3)
        expect(f.focus.x).toBeLessThan(hi + 3)
      }
    }
  })

  // ── 이동 품질 ───────────────────────────────────────────────────
  it('입장 전 구간이 걷기~가벼운 조깅 속도를 넘지 않는다', () => {
    // 이징을 바꾸면 조용히 전력질주가 된다(easeInOutCubic은 평균의 3배까지 치솟는다).
    let peak = 0
    for (let ms = 0; ms <= span(full, 'split').end; ms += 25) {
      for (const p of entranceFrame(full, ms).players) peak = Math.max(peak, p.speed)
    }
    expect(peak).toBeLessThan(5)
  })

  it('gaitPhase가 이동거리·공유 보폭 모델과 정합하며 단조 증가한다(발 미끄러짐 금지)', () => {
    // ★ 적분 격자(GAIT_STEP_MS = 50, 원점 0) 위에서만 **엄밀 등호**가 성립한다.
    //   격자 밖 시각은 마지막 부분 스텝이 끼어 두 표본의 차가 50 ms 시컨트와 달라진다.
    //   그래서 표본을 50의 배수로 스냅한다. 심판은 소개 구간(정지 40초)을 통째로
    //   건너뛰어 격자가 어긋나므로 이 검사에서 빼고, 아래에서 단조성만 본다.
    const STEP = 50
    const check = (from0: number, to: number) => {
      const from = Math.ceil(from0 / STEP) * STEP
      const prevPos = new Map<string, { x: number; z: number }>()
      const prevPhase = new Map<string, number>()
      let checked = 0
      for (let ms = from; ms <= to; ms += STEP) {
        const f = entranceFrame(full, ms)
        for (const p of f.players) {
          const phase = p.gaitPhase!
          expect(phase).toBeGreaterThanOrEqual(0)
          expect(phase).toBeLessThan(1)
          const pp = prevPos.get(p.id)
          const ph = prevPhase.get(p.id)
          if (pp !== undefined && ph !== undefined) {
            const dt = STEP / 1000
            const v = Math.hypot(p.x - pp.x, p.z - pp.z) / dt
            const expected = (Math.max(v, MIN_GAIT_SPEED) * dt) / strideLength(v)
            expect(expected).toBeLessThan(1) // 언랩이 가능한 범위
            const delta = phase >= ph ? phase - ph : phase + 1 - ph
            expect(delta).toBeCloseTo(expected, 6)
            checked++
          }
          prevPos.set(p.id, { x: p.x, z: p.z })
          prevPhase.set(p.id, phase)
        }
      }
      return checked
    }
    expect(check(0, span(full, 'split').end)).toBeGreaterThan(1000)
    expect(check(span(full, 'disperse').start, full.totalMs)).toBeGreaterThan(500)
  })

  it('심판의 보폭 위상도 항상 앞으로만 간다(소개 구간 적분 생략이 위상을 되돌리지 않는다)', () => {
    const prev = new Map<string, number>()
    for (let ms = 0; ms <= full.totalMs; ms += 137) {
      for (const r of entranceFrame(full, ms).referees) {
        const cur = r.gaitPhase!
        expect(cur).toBeGreaterThanOrEqual(0)
        expect(cur).toBeLessThan(1)
        prev.set(r.id, cur)
      }
    }
    expect(prev.size).toBe(3)
  })

  // ── 킥오프 수렴(표시 진영 회전 포함) ─────────────────────────────
  it('마지막 프레임이 **표시 진영으로 돌린** 킥오프 좌표에 수렴한다', () => {
    // Match3D는 경기 프레임을 rotateFrame(frame, FIRST_HALF_ENDS)로 돌려 그리는데
    // 입장 경로는 그 회전을 타지 않는다. 그래서 연출의 도착지가 **이미 돌아가 있어야**
    // 킥오프 첫 프레임에서 22명이 180° 순간이동하지 않는다.
    for (const s of [full, short]) {
      const f = entranceFrame(s, s.totalMs)
      const byId = new Map(f.players.map(p => [p.id, p]))
      const check = (
        members: typeof cast.home,
        side: 'home' | 'away',
        formation: typeof cast.homeFormation,
        ins: typeof cast.homeInstructions,
      ) => {
        for (const m of members) {
          const c = tacticalCoords(formation, m.slotIndex, side, ins)
          const w = toWorld(c.x, c.y)
          const want = FIRST_HALF_ENDS === 1 ? w : { x: -w.x, z: -w.z }
          const pose = byId.get(m.id)
          expect(pose).toBeDefined()
          expect(pose!.x).toBeCloseTo(want.x, 6)
          expect(pose!.z).toBeCloseTo(want.z, 6)
        }
      }
      check(cast.home, 'home', cast.homeFormation, cast.homeInstructions)
      check(cast.away, 'away', cast.awayFormation, cast.awayInstructions)
      // 공격 방향도 같은 회전을 탄다.
      const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
      const homeFace = FIRST_HALF_ENDS === 1 ? 0 : Math.PI
      expect(wrap(byId.get(cast.home[10].id)!.yaw)).toBeCloseTo(wrap(homeFace), 6)
      expect(wrap(byId.get(cast.away[10].id)!.yaw)).toBeCloseTo(wrap(homeFace + Math.PI), 6)
    }
  })
})

describe('포지션 라벨', () => {
  it('한국어다', () => {
    expect(positionLabelKo('GK')).toBe('골키퍼')
    expect(positionLabelKo('ST')).toBe('스트라이커')
  })
})
