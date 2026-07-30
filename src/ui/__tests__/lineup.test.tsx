// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import { LineupScreen, LineupEditor } from '../lineup/LineupScreen'
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

describe('LineupScreen — PlayerCard 팝오버·벤치 컴팩트 카드 (Task 7)', () => {
  // 벤치 행에 붙어 있던 60px 육각 레이더는 걷어냈다 — 축 라벨이 없고 15명 전부
  // 수치가 100이라 정보량이 0인데 카드 면적의 절반을 먹었다(감사 W-10).
  // 대신 능력치 열람 자체는 반드시 남아야 한다: FM26은 벤치 항목에서 능력치 조회를
  // 막아 "CM 96/97에도 있던 기능"이라고 비판받았다. 행의 [상세]가 그 계약이다.
  it('벤치 행에 상시 레이더는 없고, [상세]로 능력치 카드를 펼친다', () => {
    const { container, getAllByRole } = render(
      <LineupScreen team={team} initial={initial} onConfirm={() => {}} />,
    )
    const row = container.querySelector('.lu-bench__item') as HTMLElement
    expect(row.querySelector('.pc-radar__poly')).toBeNull()
    const detailBtn = getAllByRole('button', { name: /능력치 펼치기$/ })[0]
    fireEvent.click(detailBtn)
    const detail = container.querySelector('.lu-bench__detail') as HTMLElement
    expect(detail).toBeTruthy()
    expect(detail.querySelector('.pc-radar__poly')).toBeTruthy()
  })

  // 스크롤 어포던스: 벤치는 이 화면에서 유일하게 허용되는 내부 스크롤 컨테이너다.
  // 가시 스크롤바(.scroll-y) + 하단 페이드 + 총원 카운트가 없으면 73%가 은닉된다.
  it('벤치에 가시 스크롤바·하단 페이드·총원 카운트가 붙는다', () => {
    const { container } = render(<LineupScreen team={team} initial={initial} onConfirm={() => {}} />)
    expect(container.querySelector('.lu-bench__list.scroll-y')).toBeTruthy()
    expect(container.querySelector('.lu-bench .scroll-pane__fade')).toBeTruthy()
    expect(container.querySelector('.lu-bench__count')!.textContent)
      .toContain(String(team.squad.length - 11))
    // 슬롯 ID는 고정이다(S1…Sn).
    expect(container.querySelector('.lu-card__slotid')!.textContent).toBe('S1')
  })

  it('칩 클릭(선택) → 선수 카드 팝오버 표시, 재클릭 해제 시 사라짐', () => {
    const { container } = render(<LineupScreen team={team} initial={initial} onConfirm={() => {}} />)
    expect(container.querySelector('.lu-pop')).toBeNull()
    const chip = container.querySelector('.lu-chip') as HTMLElement
    fireEvent.click(chip)
    expect(container.querySelector('.lu-pop .pc')).toBeTruthy()
    expect(container.querySelector('.lu-pop .pc-radar__poly')).toBeTruthy()
    fireEvent.click(chip) // 같은 칩 재클릭 → 선택 해제
    expect(container.querySelector('.lu-pop')).toBeNull()
  })
})

// F3: 킥오프 전 컨디션 노출. 배선이 끊기면 "체력을 추가했는데 안 보인다"가 재발하므로
// (1) 리스트에 게이지가 뜨는지 (2) 선택 카드에 체력·사기 게이지가 붙는지를 함께 고정한다.
describe('LineupEditor — 컨디션 표시 (F3)', () => {
  const stamina: Record<string, number> = Object.fromEntries(
    team.squad.map((p, i) => [p.id, 20 + ((i * 7) % 80)]),
  )
  const morale: Record<string, number> = Object.fromEntries(team.squad.map(p => [p.id, 72]))

  it('컨디션을 주지 않으면 게이지가 없다(레거시 단독 화면 계약 유지)', () => {
    const { container } = render(<LineupScreen team={team} initial={initial} onConfirm={() => {}} />)
    expect(container.querySelector('.lu-sta')).toBeNull()
  })

  it('선발 칩·벤치 카드 전부에 체력 게이지가 붙는다', () => {
    const { container } = render(
      <LineupEditor team={team} tactics={initial} onChange={() => {}} staminaByPlayer={stamina} />,
    )
    expect(container.querySelectorAll('.lu-chip .lu-sta')).toHaveLength(11)
    expect(container.querySelectorAll('.lu-card .lu-sta')).toHaveLength(team.squad.length - 11)
  })

  it('체력 구간별로 색 클래스가 갈린다(위험/주의/양호)', () => {
    const ids = team.squad.map(p => p.id)
    const tri: Record<string, number> = { [ids[0]]: 12, [ids[1]]: 55, [ids[2]]: 95 }
    const { container } = render(
      <LineupEditor team={team} tactics={initial} onChange={() => {}} staminaByPlayer={tri} />,
    )
    expect(container.querySelector('.lu-sta__bar--low')).toBeTruthy()
    expect(container.querySelector('.lu-sta__bar--mid')).toBeTruthy()
    expect(container.querySelector('.lu-sta__bar--ok')).toBeTruthy()
  })

  it('선수 선택 카드에 체력·사기 게이지가 함께 뜬다', () => {
    const { container } = render(
      <LineupEditor
        team={team}
        tactics={initial}
        onChange={() => {}}
        staminaByPlayer={stamina}
        moraleByPlayer={morale}
      />,
    )
    fireEvent.click(container.querySelector('.lu-chip') as HTMLElement)
    const pop = container.querySelector('.lu-pop') as HTMLElement
    expect(pop.querySelector('.pc-gauge--stamina')).toBeTruthy()
    expect(pop.querySelector('.pc-gauge--morale')).toBeTruthy()
  })
})
