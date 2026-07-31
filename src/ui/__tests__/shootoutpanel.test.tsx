// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { ShootoutPanel } from '../match/ShootoutPanel'
import {
  topPenaltyIds, bestGk, autoAwayKickers, buildShootoutParams, onPitchIds, kickerCandidates, N_KICKERS,
} from '../match/shootout-setup'
import { simulateShootout } from '../../engine/shootout'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 78)
const away = makeTestTeam('esp', 86)

afterEach(() => cleanup())

describe('ShootoutPanel 로직(순수 함수)', () => {
  it('topPenaltyIds: penalty 상위 5인, GK 제외, 결정론', () => {
    const ids = topPenaltyIds(home)
    expect(ids).toHaveLength(5)
    const field = home.squad.filter(p => p.position !== 'GK')
    const top = [...field].sort((a, b) => b.penalty - a.penalty || a.id.localeCompare(b.id)).slice(0, 5).map(p => p.id)
    expect(ids).toEqual(top)
    // GK 미포함
    const gkIds = new Set(home.squad.filter(p => p.position === 'GK').map(p => p.id))
    expect(ids.some(id => gkIds.has(id))).toBe(false)
  })

  it('bestGk: saving 최상위 골키퍼', () => {
    const gk = bestGk(home)
    expect(gk.position).toBe('GK')
    const maxSaving = Math.max(...home.squad.filter(p => p.position === 'GK').map(p => p.gkStats!.saving))
    expect(gk.gkStats!.saving).toBe(maxSaving)
  })

  it('buildShootoutParams: UI 선택을 simulateShootout 파라미터로 조립', () => {
    const kickerIds = topPenaltyIds(home)
    const dirs = ['left', 'center', 'right', 'left', 'center'] as const
    const params = buildShootoutParams({ home, away, seed: 5, kickerIds, dirs: [...dirs] })
    expect(params.seed).toBe(5)
    expect(params.homeKickers.map(k => k.player.id)).toEqual(kickerIds)
    expect(params.homeKickers.map(k => k.direction)).toEqual([...dirs])
    expect(params.awayKickers).toEqual(autoAwayKickers(away))
    expect(params.homeGk).toEqual(bestGk(home))
    expect(params.awayGk).toEqual(bestGk(away))
    // 조립된 파라미터가 simulateShootout에서 결정론적으로 승자를 낸다
    const r = simulateShootout(params)
    expect(['home', 'away']).toContain(r.winner)
    expect(r.homeScore).not.toBe(r.awayScore)
  })
})

describe('키커 자격(IFAB 10.3 — 종료 시점 필드에 있던 선수만)', () => {
  const xi = pickBestXI(home).lineup.map(l => l.playerId)

  it('onPitchIds: 라인업에서 퇴장자를 뺀다', () => {
    const sent = xi[5]
    const on = onPitchIds(pickBestXI(home).lineup, [sent])
    expect(on).toHaveLength(10)
    expect(on).not.toContain(sent)
  })

  it('kickerCandidates: 벤치·교체 아웃·퇴장 선수를 후보에서 제외한다', () => {
    const sent = xi.find(id => home.squad.find(p => p.id === id)!.position !== 'GK')!
    const eligible = onPitchIds(pickBestXI(home).lineup, [sent])
    const cands = kickerCandidates(home, eligible).map(p => p.id)
    expect(cands).not.toContain(sent)
    // 벤치 선수(라인업 밖)는 한 명도 들어오지 않는다
    for (const id of cands) expect(eligible).toContain(id)
    // GK는 평소 제외 — 필드 인원이 충분하기 때문
    expect(cands.every(id => home.squad.find(p => p.id === id)!.position !== 'GK')).toBe(true)
  })

  it('kickerCandidates: 필드 인원이 5인 미만이면 GK도 후보에 넣는다(규정상 GK도 찰 수 있다)', () => {
    const gkId = home.squad.find(p => p.position === 'GK')!.id
    const outfield = xi.filter(id => id !== gkId).slice(0, 3)
    const cands = kickerCandidates(home, [gkId, ...outfield]).map(p => p.id)
    expect(cands).toHaveLength(4)
    expect(cands).toContain(gkId)
  })

  it('topPenaltyIds: 자격 명단 안에서만 상위 5인을 고른다', () => {
    const eligible = xi.slice(0, 6)
    const ids = topPenaltyIds(home, N_KICKERS, eligible)
    for (const id of ids) expect(eligible).toContain(id)
  })

  it('패널: 자격 명단을 주면 select 후보가 그 인원으로 줄고 안내가 붙는다', () => {
    const sent = xi.find(id => home.squad.find(p => p.id === id)!.position !== 'GK')!
    const eligible = onPitchIds(pickBestXI(home).lineup, [sent])
    const { container } = render(
      <ShootoutPanel home={home} away={away} seed={3} homeEligibleIds={eligible} onDone={() => {}} />,
    )
    const opts = [...container.querySelectorAll<HTMLSelectElement>('.so-slot__pick')[0].options].map(o => o.value)
    expect(opts).not.toContain(sent)
    const eligibleOutfield = eligible.filter(id => home.squad.find(p => p.id === id)!.position !== 'GK')
    expect(opts.sort()).toEqual([...eligibleOutfield].sort())
    expect(container.querySelector('.so-rule')!.textContent).toContain('그라운드에 있던')
  })
})

describe('ShootoutPanel 렌더 스모크', () => {
  it('키커 5슬롯 + 시작 버튼을 렌더한다', () => {
    const { container, getByRole } = render(
      <ShootoutPanel home={home} away={away} seed={3} onDone={() => {}} />,
    )
    expect(container.querySelectorAll('.so-slot')).toHaveLength(5)
    expect(getByRole('button', { name: '승부차기 시작' })).toBeTruthy()
  })

  it('정규시간 스코어를 받으면 "왜 승부차기인가"를 화면에 남긴다', () => {
    const { container } = render(
      <ShootoutPanel home={home} away={away} seed={3} regulationScore={[1, 1]} onDone={() => {}} />,
    )
    expect(container.querySelector('.eyebrow')!.textContent).toContain('1-1')
  })

  it('킥 공개가 끝나면 자동으로 넘어가지 않고 승패 문구 + [계속]이 뜬다', () => {
    vi.useFakeTimers()
    const onDone = vi.fn()
    const { container, getByRole } = render(
      <ShootoutPanel home={home} away={away} seed={11} onDone={onDone} />,
    )
    fireEvent.click(getByRole('button', { name: '승부차기 시작' }))
    // 한 킥 공개마다 다음 타이머가 잡히므로 0.8초씩 끊어 돌린다.
    for (let i = 0; i < 40; i++) act(() => { vi.advanceTimersByTime(800) })
    expect(container.querySelector('.so-verdict')).toBeTruthy()
    // 자동 진행은 없다 — 결과를 읽을 시간을 준다
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(getByRole('button', { name: '계속' }))
    expect(onDone).toHaveBeenCalledTimes(1)
    const [h, a] = onDone.mock.calls[0][0] as [number, number]
    expect(h).not.toBe(a)
    vi.useRealTimers()
  })

  it('서든데스로 넘어가면 순번이 SD 표기로 바뀌고 구분 표시가 붙는다', () => {
    vi.useFakeTimers()
    // seed 6은 기본 키커·기본 방향에서 서든데스까지 가는 시드다(엔진 결정론).
    const { container, getByRole } = render(
      <ShootoutPanel home={home} away={away} seed={6} onDone={() => {}} />,
    )
    fireEvent.click(getByRole('button', { name: '승부차기 시작' }))
    for (let i = 0; i < 40; i++) act(() => { vi.advanceTimersByTime(800) })
    const homeKicks = container.querySelectorAll('.so-kick--home')
    expect(homeKicks.length).toBeGreaterThan(N_KICKERS) // 서든데스 진입
    expect(container.querySelectorAll('.so-kick--sudden')).toHaveLength(1) // 구분 표시는 한 번만
    expect(container.querySelector('.so-kick--sudden .so-kick__no')!.textContent).toBe('SD1')
    vi.useRealTimers()
  })

  it('상대 킥도 팀명이 아니라 키커 이름으로 표시된다', () => {
    vi.useFakeTimers()
    const { container, getByRole } = render(
      <ShootoutPanel home={home} away={away} seed={11} onDone={() => {}} />,
    )
    fireEvent.click(getByRole('button', { name: '승부차기 시작' }))
    for (let i = 0; i < 40; i++) act(() => { vi.advanceTimersByTime(800) })
    const awayNames = [...container.querySelectorAll('.so-kick--away .so-kick__who')].map(e => e.textContent)
    expect(awayNames.length).toBeGreaterThan(0)
    for (const n of awayNames) expect(n).not.toBe(away.name.ko)
    vi.useRealTimers()
  })
})
