// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { LineupScreen } from '../lineup/LineupScreen'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'
import type { TacticState } from '../../engine/types'

const team = makeTestTeam('kor', 80)
const initial: TacticState = pickBestXI(team)

afterEach(() => cleanup())

describe('LineupScreen 스모크', () => {
  it('선발 11칩 + 벤치 카드(스쿼드-11)를 렌더한다', () => {
    const { container } = render(<LineupScreen team={team} initial={initial} onConfirm={() => {}} />)
    expect(container.querySelectorAll('.lu-chip')).toHaveLength(11)
    expect(container.querySelectorAll('.lu-card')).toHaveLength(team.squad.length - 11)
  })

  it('포메이션 6종 버튼을 렌더하고, 전환해도 11칩을 유지한다', () => {
    const { getByRole, container } = render(<LineupScreen team={team} initial={initial} onConfirm={() => {}} />)
    const btn = getByRole('button', { name: '4-4-2' })
    fireEvent.click(btn)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelectorAll('.lu-chip')).toHaveLength(11)
    // 슬롯 라벨이 4-4-2 순서(ST 2개)로 재배치됐는지 얕게 확인
    const slots = Array.from(container.querySelectorAll('.lu-chip__slot')).map(e => e.textContent)
    expect(slots.filter(s => s === 'ST')).toHaveLength(2)
  })

  it('[라인업 확정] 클릭 → onConfirm이 현재 formation·lineup·initial.instructions로 호출된다', () => {
    const onConfirm = vi.fn()
    const { getByRole } = render(<LineupScreen team={team} initial={initial} onConfirm={onConfirm} />)
    fireEvent.click(getByRole('button', { name: '3-5-2' }))
    fireEvent.click(getByRole('button', { name: '라인업 확정' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const arg = onConfirm.mock.calls[0][0] as TacticState
    expect(arg.formation).toBe('3-5-2')
    expect(arg.lineup).toHaveLength(11)
    expect(arg.instructions).toEqual(initial.instructions)
  })

  it('클릭 스왑: 선발 칩 두 개를 차례로 클릭하면 슬롯이 맞교환된다', () => {
    const { container } = render(<LineupScreen team={team} initial={initial} onConfirm={() => {}} />)
    const chips = () => Array.from(container.querySelectorAll('.lu-chip')) as HTMLElement[]
    const numOf = (el: HTMLElement) => el.querySelector('.lu-chip__num')!.textContent
    const before = chips().map(numOf)
    fireEvent.click(chips()[3])
    fireEvent.click(chips()[10])
    const after = chips().map(numOf)
    expect(after[3]).toBe(before[10])
    expect(after[10]).toBe(before[3])
  })

  it('클릭 스왑: 선발 → 벤치 카드 클릭으로 교체 투입된다', () => {
    const { container } = render(<LineupScreen team={team} initial={initial} onConfirm={() => {}} />)
    const firstChip = container.querySelector('.lu-chip') as HTMLElement
    const outNum = firstChip.querySelector('.lu-chip__num')!.textContent
    const benchCard = container.querySelector('.lu-card') as HTMLElement
    const inNum = benchCard.querySelector('.lu-card__num')!.textContent
    fireEvent.click(firstChip)
    fireEvent.click(benchCard)
    const chipNums = Array.from(container.querySelectorAll('.lu-chip__num')).map(e => e.textContent)
    const cardNums = Array.from(container.querySelectorAll('.lu-card__num')).map(e => e.textContent)
    expect(chipNums).toContain(inNum) // 벤치 선수가 선발로
    expect(cardNums).toContain(outNum) // 아웃된 선발이 벤치로
    expect(container.querySelectorAll('.lu-chip')).toHaveLength(11)
  })
})
