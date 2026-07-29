import { describe, it, expect } from 'vitest'
import { swapPlayers, substitute, autoFill, fitLevel, MIN_FIT } from '../lineup/swap'
import { positionFitness } from '../../engine/fitness'
import { XI_SLOTS } from '../pitch/formations'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'
import type { FormationId, Player } from '../../engine/types'

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']
const team = makeTestTeam('kor', 80)
const byId = (id: string) => team.squad.find(p => p.id === id) as Player
const gkIds = team.squad.filter(p => p.position === 'GK').map(p => p.id)

describe('swapPlayers', () => {
  const base = pickBestXI(team).lineup
  const a = base[3].playerId // LB
  const b = base[10].playerId // ST

  it('선발 두 명의 자리(playerId)만 맞교환하고 슬롯 순서는 보존한다', () => {
    const out = swapPlayers(base, a, b)
    expect(out[3].playerId).toBe(b)
    expect(out[10].playerId).toBe(a)
    expect(out.map(s => s.slot)).toEqual(base.map(s => s.slot))
    expect(out.length).toBe(11)
  })

  it('두 번 적용하면 원복된다(대칭)', () => {
    expect(swapPlayers(swapPlayers(base, a, b), a, b)).toEqual(base)
  })

  it('같은 선수거나 한쪽이 선발이 아니면 원본 그대로', () => {
    expect(swapPlayers(base, a, a)).toBe(base)
    const benchId = team.squad.find(p => !base.some(s => s.playerId === p.id))!.id
    expect(swapPlayers(base, a, benchId)).toBe(base)
  })

  it('교환 후에도 playerId 11개가 모두 유일하다', () => {
    const out = swapPlayers(base, a, b)
    expect(new Set(out.map(s => s.playerId)).size).toBe(11)
  })
})

describe('substitute', () => {
  const base = pickBestXI(team).lineup
  const outId = base[6].playerId
  const benchId = team.squad.find(p => !base.some(s => s.playerId === p.id))!.id

  it('벤치 선수를 선발 자리에 투입 — 슬롯 유지·11인 유지', () => {
    const out = substitute(base, outId, benchId)
    expect(out[6].playerId).toBe(benchId)
    expect(out[6].slot).toBe(base[6].slot)
    expect(out.length).toBe(11)
    expect(out.some(s => s.playerId === outId)).toBe(false)
  })

  it('inId가 이미 선발이면(중복) 원본 그대로', () => {
    const otherStarter = base[2].playerId
    expect(substitute(base, outId, otherStarter)).toBe(base)
  })

  it('outId가 선발이 아니면 원본 그대로', () => {
    const bench2 = team.squad.find(p => !base.some(s => s.playerId === p.id) && p.id !== benchId)!.id
    expect(substitute(base, bench2, benchId)).toBe(base)
  })

  it('투입 후 playerId 11개가 모두 유일하다', () => {
    const out = substitute(base, outId, benchId)
    expect(new Set(out.map(s => s.playerId)).size).toBe(11)
  })
})

describe('autoFill', () => {
  it('6종 포메이션 모두 11 슬롯·유일 선수·XI_SLOTS 순서 일치', () => {
    for (const f of FORMATIONS) {
      const lu = autoFill(team, f)
      expect(lu).toHaveLength(11)
      expect(lu.map(s => s.slot)).toEqual(XI_SLOTS[f])
      expect(new Set(lu.map(s => s.playerId)).size).toBe(11)
    }
  })

  it('GK 슬롯(0)에는 GK 포지션 선수가 배치되고 필드 슬롯엔 GK가 오지 않는다', () => {
    for (const f of FORMATIONS) {
      const lu = autoFill(team, f)
      expect(gkIds).toContain(lu[0].playerId)
      for (let i = 1; i < 11; i++) expect(gkIds).not.toContain(lu[i].playerId)
    }
  })

  it("scope 'starters-only'는 preferIds 안에서만 채운다(경기 중 포메이션 변경)", () => {
    const prefer = pickBestXI(team).lineup.map(s => s.playerId)
    for (const f of FORMATIONS) {
      const lu = autoFill(team, f, prefer, 'starters-only')
      // 경기 중 벤치 자동 투입은 교체 카드를 몰래 쓰는 것이므로 절대 일어나선 안 된다.
      expect(lu.every(s => prefer.includes(s.playerId))).toBe(true)
    }
  })

  it('각 슬롯 배치 선수의 적합도가 남은 후보 대비 최선(그리디)', () => {
    const lu = autoFill(team, '4-3-3')
    // GK 슬롯: 배치된 선수의 GK 적합도가 1.0
    expect(byId(lu[0].playerId).position).toBe('GK')
  })
})

// 회귀: 킥오프 전 [추천 적용]이 4-2-3-1 → 3-5-2로 바꿀 때 남아도는 풀백이 ST 슬롯에
// 꽂히던 문제. 원인은 preferIds(현재 선발)를 적합도보다 우선한 것이었다.
describe("autoFill scope 'squad' — 킥오프 전에는 벤치도 후보다", () => {
  const prefer = pickBestXI(team).lineup.map(s => s.playerId)

  it('포메이션 6종 모두 임계(MIN_FIT) 미만 배치를 만들지 않는다', () => {
    for (const f of FORMATIONS) {
      for (const l of autoFill(team, f, prefer)) {
        expect(positionFitness(byId(l.playerId), l.slot)).toBeGreaterThanOrEqual(MIN_FIT)
      }
    }
  })

  it('3-5-2에서 ST 슬롯 둘 다 ST 적합도 ≥ MIN_FIT — 풀백을 최전방에 세우지 않는다', () => {
    const lu = autoFill(team, '3-5-2', prefer)
    const sts = lu.filter(l => l.slot === 'ST')
    expect(sts).toHaveLength(2)
    for (const s of sts) {
      const p = byId(s.playerId)
      expect(positionFitness(p, 'ST')).toBeGreaterThanOrEqual(MIN_FIT)
      expect(['LB', 'RB', 'CB', 'GK']).not.toContain(p.position)
    }
    // 기존 판은 여기서 풀백을 세웠다 — 벤치 ST가 실제로 투입됐는지 확인한다.
    expect(sts.some(s => !prefer.includes(s.playerId))).toBe(true)
  })

  it('적합도가 같으면 현재 선발을 유지한다(동점 tiebreak)', () => {
    // 감독이 벤치 CB를 선발로 올려 둔 상태. 같은 1.0끼리라면 그 선택이 이겨야 한다 —
    // 적합도 우선이 "감독의 11인을 마음대로 갈아엎는다"는 뜻이 되면 안 된다.
    const base = pickBestXI(team).lineup
    const outCb = base.find(l => l.slot === 'CB')!.playerId
    const benchCb = team.squad.find(p => p.position === 'CB' && !base.some(l => l.playerId === p.id))!
    const swapped = base.map(l => (l.playerId === outCb ? benchCb.id : l.playerId))
    const lu = autoFill(team, '4-3-3', swapped)
    expect([...lu.map(l => l.playerId)].sort()).toEqual([...swapped].sort())
  })

  it('결정론 — 같은 입력에 같은 XI', () => {
    for (const f of FORMATIONS) {
      expect(autoFill(team, f, prefer)).toEqual(autoFill(team, f, prefer))
    }
  })
})

describe('fitLevel', () => {
  it('임계값: ≥0.85 good / ≥0.65 ok / 미만 bad', () => {
    const st = team.squad.find(p => p.position === 'ST')!
    // 정포지션(1.0) → good
    expect(fitLevel(st, 'ST')).toBe('good')
    // altPositions(0.85) → good (ST의 alt에 LW 포함)
    expect(fitLevel(st, 'LW')).toBe('good')
    // 인접(0.65, alt 아님) → ok. ST의 인접 RW는 alt(LW·AM)에 없다.
    expect(fitLevel(st, 'RW')).toBe('ok')
    // 무관(0.4) → bad. CB를 ST에.
    const cb = team.squad.find(p => p.position === 'CB')!
    expect(fitLevel(cb, 'ST')).toBe('bad')
    // GK를 필드(0.2) → bad
    const gk = team.squad.find(p => p.position === 'GK')!
    expect(fitLevel(gk, 'CB')).toBe('bad')
  })
})
