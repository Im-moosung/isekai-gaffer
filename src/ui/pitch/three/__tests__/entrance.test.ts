// 입장 연출 순수 로직 계약 — 결정론·경기장 이탈 금지·보폭 정합·킥오프 수렴.
import { describe, it, expect } from 'vitest'
import {
  ENTRANCE_DISPERSE_MS,
  ENTRANCE_INTRO_MS,
  ENTRANCE_LINEUP_MS,
  ENTRANCE_PHASES,
  ENTRANCE_TOTAL_MS,
  ENTRANCE_TUNNEL_MS,
  ENTRANCE_WALKOUT_MS,
  REFEREE_ID,
  buildEntranceCast,
  entranceFrame,
  entrancePhaseAt,
  entranceSubtitle,
  introCardAt,
  positionLabelKo,
} from '../entrance'
import { MIN_GAIT_SPEED, strideLength } from '../player3d'
import { toWorld } from '../types'
import { tacticalCoords } from '../../shape'
import { XI_SLOTS } from '../../../../engine/formations'
import { createMatch } from '../../../../engine/simulate'
import { makeTestTeam } from '../../../../engine/fixtures/testTeams'

const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: 11 })
const cast = buildEntranceCast(state)

/** 경기장 + 터널 여유 경계. */
const MAX_X = 57
const MAX_Z = 36

describe('buildEntranceCast', () => {
  it('양 팀 XI를 포메이션 슬롯 순서(0 = GK)로 뽑는다', () => {
    expect(cast.home).toHaveLength(11)
    expect(cast.away).toHaveLength(11)
    const homeSlots = XI_SLOTS[cast.homeFormation]
    cast.home.forEach((m, i) => {
      expect(m.slotIndex).toBe(i)
      // 라인업은 XI_SLOTS 순서로 채워지므로 슬롯 순서 = 소개 순서다.
      expect(homeSlots[i]).toBeDefined()
    })
    expect(cast.home[0].slotIndex).toBe(0)
    expect(homeSlots[0]).toBe('GK')
  })

  it('선수 메타(등번호·한국어 이름)를 스쿼드에서 정확히 가져온다', () => {
    const squad = new Map(state.home.team.squad.map(p => [p.id, p]))
    for (const m of cast.home) {
      const p = squad.get(m.id)
      expect(p).toBeDefined()
      expect(m.number).toBe(p?.number)
      expect(m.nameKo).toBe(p?.name.ko)
    }
  })

  it('결정론 — 같은 상태로 두 번 만들면 완전히 같다', () => {
    expect(buildEntranceCast(state)).toEqual(cast)
  })
})

describe('타임라인', () => {
  it('단계 길이의 합이 ENTRANCE_TOTAL_MS와 일치한다', () => {
    const sum =
      ENTRANCE_TUNNEL_MS + ENTRANCE_WALKOUT_MS + ENTRANCE_LINEUP_MS + ENTRANCE_INTRO_MS + ENTRANCE_DISPERSE_MS
    expect(sum).toBe(ENTRANCE_TOTAL_MS)
    expect(ENTRANCE_PHASES[ENTRANCE_PHASES.length - 1].end).toBe(ENTRANCE_TOTAL_MS)
    // 구간은 빈틈 없이 이어진다.
    ENTRANCE_PHASES.forEach((span, i) => {
      if (i > 0) expect(span.start).toBe(ENTRANCE_PHASES[i - 1].end)
    })
  })

  it('총 길이는 14초를 넘지 않는다(첫 장면은 빠르게 지나가야 한다)', () => {
    expect(ENTRANCE_TOTAL_MS).toBeLessThanOrEqual(14000)
  })

  it('경계 시각의 단계가 정확하다', () => {
    expect(entrancePhaseAt(-100)).toBe('tunnel')
    expect(entrancePhaseAt(0)).toBe('tunnel')
    expect(entrancePhaseAt(ENTRANCE_TUNNEL_MS - 1)).toBe('tunnel')
    expect(entrancePhaseAt(ENTRANCE_TUNNEL_MS)).toBe('walkout')
    expect(entrancePhaseAt(ENTRANCE_PHASES[2].start)).toBe('lineup')
    expect(entrancePhaseAt(ENTRANCE_PHASES[3].start)).toBe('intro')
    expect(entrancePhaseAt(ENTRANCE_PHASES[4].start)).toBe('disperse')
    expect(entrancePhaseAt(ENTRANCE_TOTAL_MS)).toBe('done')
  })

  it('자막은 단계마다 바뀐다', () => {
    const at = (ms: number) => entranceSubtitle(cast, ms)
    expect(at(0)).toBe('심판진 입장')
    expect(at(ENTRANCE_TUNNEL_MS + 10)).toBe('양 팀 선수 입장')
    expect(at(ENTRANCE_PHASES[2].start + 10)).toContain(cast.homeFormation)
    expect(at(ENTRANCE_PHASES[3].start + 10)).toContain(cast.homeTeamKo)
    expect(at(ENTRANCE_TOTAL_MS)).toBe('킥오프')
  })
})

describe('introCardAt', () => {
  it('intro 단계 밖에서는 null이다', () => {
    expect(introCardAt(cast, 0)).toBeNull()
    expect(introCardAt(cast, ENTRANCE_PHASES[3].start - 1)).toBeNull()
    expect(introCardAt(cast, ENTRANCE_PHASES[3].end)).toBeNull()
    expect(introCardAt(cast, ENTRANCE_TOTAL_MS)).toBeNull()
  })

  it('11명을 포지션 순서대로 정확히 한 번씩 호명한다', () => {
    const seen: number[] = []
    for (let ms = ENTRANCE_PHASES[3].start; ms < ENTRANCE_PHASES[3].end; ms += 10) {
      const card = introCardAt(cast, ms)
      expect(card).not.toBeNull()
      if (!card) continue
      expect(card.total).toBe(11)
      expect(card.u).toBeGreaterThanOrEqual(0)
      expect(card.u).toBeLessThan(1)
      expect(card.player).toBe(cast.home[card.index])
      if (seen[seen.length - 1] !== card.index) seen.push(card.index)
    }
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('포지션 라벨은 한국어다', () => {
    expect(positionLabelKo('GK')).toBe('골키퍼')
    expect(positionLabelKo('ST')).toBe('스트라이커')
  })
})

describe('entranceFrame', () => {
  it('언제나 22명 + 심판 1명을 돌려준다', () => {
    for (const ms of [0, 500, 3000, 6500, 9000, ENTRANCE_TOTAL_MS]) {
      const f = entranceFrame(cast, ms)
      expect(f.players).toHaveLength(22)
      expect(f.referee.id).toBe(REFEREE_ID)
      expect(f.players.some(p => p.id === REFEREE_ID)).toBe(false)
      expect(f.players.filter(p => p.side === 'home')).toHaveLength(11)
      expect(f.players.filter(p => p.side === 'away')).toHaveLength(11)
    }
  })

  it('모든 시각에서 22명+심판이 경기장 경계 안에 있다', () => {
    for (let ms = -200; ms <= ENTRANCE_TOTAL_MS + 200; ms += 50) {
      const f = entranceFrame(cast, ms)
      for (const p of [...f.players, f.referee]) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(MAX_X)
        expect(Math.abs(p.z)).toBeLessThanOrEqual(MAX_Z)
        expect(Number.isFinite(p.yaw)).toBe(true)
        expect(p.speed).toBeGreaterThanOrEqual(0)
      }
      expect(Math.abs(f.focus.x)).toBeLessThanOrEqual(MAX_X)
      expect(Math.abs(f.focus.z)).toBeLessThanOrEqual(MAX_Z)
    }
  })

  it('결정론 — 같은 (cast, ms)면 완전히 같은 프레임', () => {
    for (const ms of [0, 1234, 5678, 9999, ENTRANCE_TOTAL_MS]) {
      expect(entranceFrame(cast, ms)).toEqual(entranceFrame(cast, ms))
      // 캐스트 객체가 달라도(캐시 미스) 결과는 같아야 한다.
      expect(entranceFrame(buildEntranceCast(state), ms)).toEqual(entranceFrame(cast, ms))
    }
  })

  it('범위 밖 ms는 클램프된다', () => {
    expect(entranceFrame(cast, -1000)).toEqual(entranceFrame(cast, 0))
    expect(entranceFrame(cast, ENTRANCE_TOTAL_MS + 5000)).toEqual(entranceFrame(cast, ENTRANCE_TOTAL_MS))
  })

  it('공은 센터스팟에 놓여 있다', () => {
    const f = entranceFrame(cast, 3000)
    expect(f.ball.x).toBe(0)
    expect(f.ball.z).toBe(0)
    expect(f.ball.y).toBeGreaterThan(0)
  })

  it('gaitPhase가 이동거리·공유 보폭 모델과 정합하며 단조 증가한다(발 미끄러짐 금지)', () => {
    const STEP = 50 // 내부 적분 격자와 같은 간격
    const prevPos = new Map<string, { x: number; z: number }>()
    const prevPhase = new Map<string, number>()
    let checked = 0
    for (let ms = 0; ms <= ENTRANCE_TOTAL_MS; ms += STEP) {
      const f = entranceFrame(cast, ms)
      for (const p of [...f.players, f.referee]) {
        const phase = p.gaitPhase
        expect(phase).toBeGreaterThanOrEqual(0)
        expect(phase).toBeLessThan(1)
        const pp = prevPos.get(p.id)
        const ph = prevPhase.get(p.id)
        if (pp !== undefined && ph !== undefined && phase !== undefined) {
          const dt = STEP / 1000
          const v = Math.hypot(p.x - pp.x, p.z - pp.z) / dt
          const expected = (Math.max(v, MIN_GAIT_SPEED) * dt) / strideLength(v)
          expect(expected).toBeLessThan(1) // 언랩이 가능한 범위
          // 위상은 0~1로 감기므로 증가분을 언랩해서 비교한다(= 항상 전진한다).
          const delta = phase >= ph ? phase - ph : phase + 1 - ph
          expect(delta).toBeCloseTo(expected, 6)
          expect(delta).toBeGreaterThan(0)
          checked++
        }
        prevPos.set(p.id, { x: p.x, z: p.z })
        if (phase !== undefined) prevPhase.set(p.id, phase)
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  it('입장(터널·워크아웃)은 걷기~가벼운 조깅 속도를 넘지 않는다', () => {
    // 이징을 바꾸면 조용히 전력질주가 된다(easeInOutCubic은 평균의 3배까지 치솟는다).
    let peak = 0
    for (let ms = 0; ms <= ENTRANCE_PHASES[1].end; ms += 25) {
      for (const p of entranceFrame(cast, ms).players) peak = Math.max(peak, p.speed)
    }
    expect(peak).toBeLessThan(5)
  })

  // 라이브 무브먼트가 tacticalCoords(전술 반영 좌표)로 선수를 세우므로 입장도 거기로
  // 수렴해야 한다. 포메이션 원형(slotCoords)에 세우면 입장이 끝나는 순간 선수가 튄다.
  it('마지막 프레임은 킥오프 포메이션 좌표에 수렴한다', () => {
    const f = entranceFrame(cast, ENTRANCE_TOTAL_MS)
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
        const pose = byId.get(m.id)
        expect(pose).toBeDefined()
        expect(pose?.x).toBeCloseTo(w.x, 6)
        expect(pose?.z).toBeCloseTo(w.z, 6)
      }
    }
    check(cast.home, 'home', cast.homeFormation, cast.homeInstructions)
    check(cast.away, 'away', cast.awayFormation, cast.awayInstructions)
    // 흩어진 뒤에는 각자 공격 방향을 본다.
    expect(byId.get(cast.home[10].id)?.yaw).toBeCloseTo(0, 6)
    expect(byId.get(cast.away[10].id)?.yaw).toBeCloseTo(Math.PI, 6)
  })

  it('정렬(lineup) 단계에서는 두 줄이 정지해 메인스탠드를 바라본다', () => {
    const ms = ENTRANCE_PHASES[2].start + ENTRANCE_LINEUP_MS / 2
    const f = entranceFrame(cast, ms)
    for (const p of f.players) {
      expect(p.speed).toBeLessThan(0.4)
      expect(p.action).toBe('idle')
      expect(p.yaw).toBeCloseTo(-Math.PI / 2, 6)
    }
    // 홈이 앞줄(카메라 쪽), 어웨이가 뒷줄이다.
    const homeZ = f.players.filter(p => p.side === 'home').map(p => p.z)
    const awayZ = f.players.filter(p => p.side === 'away').map(p => p.z)
    expect(Math.max(...homeZ)).toBeLessThan(Math.min(...awayZ))
  })

  it('intro 단계에서는 호명 중인 홈 선수만 한 걸음 앞으로 나온다', () => {
    const base = entranceFrame(cast, ENTRANCE_PHASES[2].start + 10)
    const baseZ = new Map(base.players.map(p => [p.id, p.z]))
    // 카드 슬롯 한가운데(u≈0.5)에서 최대로 나와 있다.
    const per = ENTRANCE_INTRO_MS / 11
    const ms = ENTRANCE_PHASES[3].start + per * 3.5
    const card = introCardAt(cast, ms)
    expect(card?.index).toBe(3)
    const f = entranceFrame(cast, ms)
    for (const p of f.players) {
      const dz = p.z - (baseZ.get(p.id) ?? 0)
      if (p.id === card?.player.id) expect(dz).toBeLessThan(-1) // -Z = 카메라 쪽
      else expect(Math.abs(dz)).toBeLessThan(1e-9)
    }
  })
})
