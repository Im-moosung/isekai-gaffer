// @vitest-environment jsdom
// 선수 조작 언어 계약 — docs/superpowers/specs/2026-07-31-squad-interaction.md
//
// 이 파일이 지키는 단 하나의 핵심: **클릭은 라인업을 바꾸지 않는다.**
// 이전 판은 클릭 → 클릭으로 교체가 성사됐고, 상세를 보려고 두 번째 선수를 누른 순간
// 라인업이 바뀌는 사고가 났다. 그래서 "안 바뀐다"를 회귀 테스트로 못 박는다.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, fireEvent, cleanup, within } from '@testing-library/react'
import { LineupEditor } from '../lineup/LineupScreen'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'
import type { TacticState } from '../../engine/types'

const team = makeTestTeam('kor', 80)
const initial: TacticState = pickBestXI(team)

afterEach(() => cleanup())

/** 제어 컴포넌트를 실제처럼 굴리는 래퍼 — onChange가 곧바로 다음 렌더에 반영돼야
 *  "버튼을 눌렀더니 라인업이 바뀌었다"를 DOM으로 확인할 수 있다. */
function Editor({ onChange, ...rest }: Record<string, unknown> & { onChange?: (t: TacticState) => void }) {
  const [t, setT] = useState<TacticState>(initial)
  return (
    <LineupEditor
      team={team}
      tactics={t}
      onChange={next => { setT(next); onChange?.(next) }}
      {...rest}
    />
  )
}

const chips = (c: HTMLElement) => Array.from(c.querySelectorAll('.lu-chip')) as HTMLElement[]
const cards = (c: HTMLElement) => Array.from(c.querySelectorAll('.lu-card')) as HTMLElement[]
const chipNums = (c: HTMLElement) => chips(c).map(e => e.querySelector('.lu-chip__num')!.textContent)
const cardNums = (c: HTMLElement) => cards(c).map(e => e.querySelector('.lu-card__num')!.textContent)

describe('클릭은 교체하지 않는다 — 실수 경로 제거', () => {
  it('선발 두 명을 차례로 클릭해도 슬롯이 바뀌지 않는다', () => {
    const onChange = vi.fn()
    const { container } = render(<Editor onChange={onChange} />)
    const before = chipNums(container)
    fireEvent.click(chips(container)[3])
    fireEvent.click(chips(container)[10])
    expect(chipNums(container)).toEqual(before)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('선발 → 벤치 클릭으로 교체가 성사되지 않는다', () => {
    const onChange = vi.fn()
    const { container } = render(<Editor onChange={onChange} />)
    const beforeChips = chipNums(container)
    const beforeCards = cardNums(container)
    fireEvent.click(chips(container)[0])
    fireEvent.click(cards(container)[0])
    expect(chipNums(container)).toEqual(beforeChips)
    expect(cardNums(container)).toEqual(beforeCards)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('세 번째 클릭은 누적되지 않고 새 선택으로 초기화된다(비교는 항상 2명)', () => {
    const { container } = render(<Editor />)
    fireEvent.click(chips(container)[0])
    fireEvent.click(chips(container)[1])
    expect(container.querySelector('.cmp')).toBeTruthy()
    fireEvent.click(chips(container)[2])
    // 3번째를 누르면 비교가 닫히고 그 선수 하나만 선택된 상태가 된다.
    expect(container.querySelector('.cmp')).toBeNull()
    expect(container.querySelectorAll('.lu-ord')).toHaveLength(1)
  })
})

describe('1명 클릭 → 선수 상세', () => {
  it('선발 칩을 클릭하면 상세 카드가 뜨고, 재클릭하면 닫힌다', () => {
    const { container } = render(<Editor />)
    expect(container.querySelector('.lu-pop')).toBeNull()
    fireEvent.click(chips(container)[0])
    expect(container.querySelector('.lu-pop .pc')).toBeTruthy()
    expect(container.querySelector('.lu-pop .pc-radar__poly')).toBeTruthy()
    fireEvent.click(chips(container)[0])
    expect(container.querySelector('.lu-pop')).toBeNull()
  })

  it('벤치 행을 클릭해도 같은 상세 카드가 뜬다(선발·벤치 규칙이 같다)', () => {
    const { container } = render(<Editor />)
    fireEvent.click(cards(container)[0])
    expect(container.querySelector('.lu-pop .pc')).toBeTruthy()
  })
})

describe('2명 클릭 → 나란히 비교 + 실행 버튼', () => {
  it('선발+선발이면 [자리 바꾸기]가 뜨고, 눌러야 슬롯이 교환된다', () => {
    const { container, getByRole } = render(<Editor />)
    const before = chipNums(container)
    fireEvent.click(chips(container)[3])
    fireEvent.click(chips(container)[10])

    const cmp = container.querySelector('.cmp') as HTMLElement
    expect(cmp).toBeTruthy()
    // 선택 순서 배지 1·2가 비교 뷰와 피치 양쪽에 붙는다.
    expect(Array.from(cmp.querySelectorAll('.cmp__order')).map(e => e.textContent)).toEqual(['1', '2'])
    expect(container.querySelectorAll('.lu-chip .lu-ord')).toHaveLength(2)
    // 아직은 아무것도 바뀌지 않았다.
    expect(chipNums(container)).toEqual(before)

    fireEvent.click(getByRole('button', { name: '자리 바꾸기' }))
    const after = chipNums(container)
    expect(after[3]).toBe(before[10])
    expect(after[10]).toBe(before[3])
    // 확정 후 선택은 풀린다.
    expect(container.querySelector('.cmp')).toBeNull()
  })

  it('선발+벤치면 [교체하기]가 뜨고, 눌러야 교체된다', () => {
    const { container, getByRole } = render(<Editor />)
    const outNum = chipNums(container)[0]
    const inNum = cardNums(container)[0]
    fireEvent.click(chips(container)[0])
    fireEvent.click(cards(container)[0])

    expect(container.querySelector('.cmp')).toBeTruthy()
    expect(chipNums(container)).toContain(outNum) // 아직 안 바뀜

    fireEvent.click(getByRole('button', { name: '교체하기' }))
    expect(chipNums(container)).toContain(inNum)
    expect(cardNums(container)).toContain(outNum)
    expect(chips(container)).toHaveLength(11)
  })

  it('벤치+벤치면 실행 버튼이 비활성이고 이유를 적는다', () => {
    const { container, getByRole } = render(<Editor />)
    fireEvent.click(cards(container)[0])
    fireEvent.click(cards(container)[1])
    const btn = getByRole('button', { name: '교체하기' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(container.querySelector('.lu-exec__hint')!.textContent).toContain('선발 한 명')
    // 비교 자체는 보여 준다 — 벤치 둘을 견줘 누구를 먼저 쓸지 정하는 것은 정당한 용도다.
    expect(container.querySelector('.cmp')).toBeTruthy()
  })

  it('[선택 해제]가 비교를 닫는다', () => {
    const { container, getByRole } = render(<Editor />)
    fireEvent.click(chips(container)[0])
    fireEvent.click(chips(container)[1])
    fireEvent.click(getByRole('button', { name: '선택 해제' }))
    expect(container.querySelector('.cmp')).toBeNull()
  })
})

describe('비교 뷰 — 차이를 강조한다', () => {
  it('집계 한 줄·발산 막대·델타가 함께 나온다', () => {
    const stamina = Object.fromEntries(team.squad.map((p, i) => [p.id, 40 + i * 2]))
    const { container } = render(<Editor staminaByPlayer={stamina} />)
    fireEvent.click(chips(container)[0])
    fireEvent.click(cards(container)[0])
    const cmp = container.querySelector('.cmp') as HTMLElement
    // (1) 집계 수치 한 줄 (2) 우세 쪽 굵은 수치 (3) 한쪽으로만 뻗는 막대 (4) 델타 숫자
    // ★ (1)은 **결론이 아니다**. 2026-08-01에 "낫습니다"류 단정을 걷어내고 수치만 남겼다
    //   (compare.test.ts의 "결론 문구가 없다"가 그 경계를 고정한다).
    expect(cmp.querySelector('.cmp__readout')!.textContent!.length).toBeGreaterThan(4)
    expect(cmp.querySelectorAll('.cmp__val--win').length).toBeGreaterThan(0)
    expect(cmp.querySelectorAll('.cmp__fill').length).toBeGreaterThan(0)
    expect(Array.from(cmp.querySelectorAll('.cmp__d')).some(e => e.textContent!.startsWith('+'))).toBe(true)
  })

  it('상태 칩(경고·사기)이 비교 뷰에도 반영된다', () => {
    const booked = initial.lineup[4].playerId
    const { container } = render(<Editor cautionByPlayer={{ [booked]: 1 }} />)
    fireEvent.click(chips(container)[4])
    fireEvent.click(cards(container)[0])
    const chip = container.querySelector('.cmp .sx__chip[data-kind="caution"]')
    expect(chip).toBeTruthy()
    expect(chip!.getAttribute('aria-label')).toContain('누적 경고 1장')
  })

  it('자리 바꾸기는 "바꾼 뒤 적합도"를 보여 준다 — 지금 값이 아니라 결과가 판단 재료다', () => {
    const { container } = render(<Editor />)
    fireEvent.click(chips(container)[1])
    fireEvent.click(chips(container)[9])
    const cmp = container.querySelector('.cmp') as HTMLElement
    expect(cmp.textContent).toContain('바꾼 뒤 적합도')
    expect(cmp.querySelector('.cmp__ctx-text')!.textContent).toContain('자리 교환')
  })
})

describe('출장정지 — 어느 경로로도 선택되지 않는다', () => {
  const bannedId = team.squad.find(p => !initial.lineup.some(l => l.playerId === p.id))!.id

  it('정지 선수의 벤치 행은 disabled라 선택 자체가 불가능하다', () => {
    const { container } = render(<Editor unavailableIds={[bannedId]} />)
    const row = container.querySelector('.lu-card--susp') as HTMLButtonElement
    expect(row.disabled).toBe(true)
    fireEvent.click(chips(container)[0])
    fireEvent.click(row) // disabled 버튼은 클릭이 발화하지 않는다
    expect(container.querySelector('.cmp')).toBeNull()
    expect(container.querySelectorAll('.lu-ord')).toHaveLength(1)
  })

  it('키보드 화살표 순회에서도 정지 선수를 건너뛴다', () => {
    // 정지자가 벤치 첫 행이 되도록 팀을 고른다 — 순회가 그 자리를 지나가야 의미가 있다.
    const { container } = render(<Editor unavailableIds={[bannedId]} />)
    const order = [
      ...initial.lineup.map(l => l.playerId),
      ...team.squad.filter(p => !initial.lineup.some(l => l.playerId === p.id)).map(p => p.id),
    ].filter(id => id !== bannedId)
    // 마지막 선발에서 오른쪽으로 가면 정지자가 아닌 첫 벤치 선수가 잡힌다.
    const last = chips(container)[10]
    last.focus()
    fireEvent.keyDown(last, { key: 'ArrowRight' })
    const expected = order[11]
    const active = document.activeElement as HTMLElement
    expect(active.getAttribute('aria-label')).toContain(team.squad.find(p => p.id === expected)!.name.ko)
  })
})

describe('키보드만으로 교체할 수 있다', () => {
  it('스페이스로 집고 화살표로 옮긴 뒤 스페이스로 놓으면 자리가 바뀐다', () => {
    const { container } = render(<Editor />)
    const before = chipNums(container)
    const a = chips(container)[3]
    a.focus()
    fireEvent.keyDown(a, { key: ' ' })
    // 집힌 상태가 시각적으로 구분된다.
    expect(container.querySelectorAll('.lu-chip--grab')).toHaveLength(1)

    fireEvent.keyDown(a, { key: 'ArrowRight' })
    const target = document.activeElement as HTMLElement
    expect(target).toBe(chips(container)[4])
    fireEvent.keyDown(target, { key: ' ' })

    const after = chipNums(container)
    expect(after[3]).toBe(before[4])
    expect(after[4]).toBe(before[3])
    expect(container.querySelectorAll('.lu-chip--grab')).toHaveLength(0)
  })

  it('선발에서 집어 벤치에 놓으면 실제 교체가 된다', () => {
    const { container } = render(<Editor />)
    const outNum = chipNums(container)[0]
    const inNum = cardNums(container)[0]
    const a = chips(container)[0]
    a.focus()
    fireEvent.keyDown(a, { key: ' ' })
    const target = cards(container)[0]
    fireEvent.keyDown(target, { key: ' ' })
    expect(chipNums(container)).toContain(inNum)
    expect(cardNums(container)).toContain(outNum)
  })

  it('Esc로 집기를 취소하면 아무것도 바뀌지 않는다', () => {
    const onChange = vi.fn()
    const { container } = render(<Editor onChange={onChange} />)
    const a = chips(container)[3]
    fireEvent.keyDown(a, { key: ' ' })
    fireEvent.keyDown(a, { key: 'Escape' })
    expect(container.querySelectorAll('.lu-chip--grab')).toHaveLength(0)
    fireEvent.keyDown(chips(container)[4], { key: ' ' })
    // Esc 이후의 스페이스는 새로 "집는" 동작이지 놓기가 아니다.
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.lu-chip--grab')).toHaveLength(1)
  })

  it('스페이스는 선택(비교)을 발생시키지 않는다 — 집기 전용이다', () => {
    const { container } = render(<Editor />)
    fireEvent.keyDown(chips(container)[0], { key: ' ' })
    fireEvent.keyDown(chips(container)[1], { key: ' ' })
    // 두 번의 스페이스는 집기+놓기이므로 비교 뷰가 아니라 실제 이동이 일어난다.
    expect(container.querySelector('.cmp')).toBeNull()
  })

  it('안내 라이브 리전이 조작 결과를 문장으로 알린다', () => {
    const { container } = render(<Editor />)
    const region = container.querySelector('[role="status"][aria-live="polite"]')!
    fireEvent.keyDown(chips(container)[0], { key: ' ' })
    expect(region.textContent).toContain('집었습니다')
    fireEvent.keyDown(chips(container)[1], { key: ' ' })
    expect(region.textContent).toContain('자리를 바꿨습니다')
  })

  it('버튼 경로도 키보드로 도달 가능하다 — 실행 버튼이 포커스 가능한 button이다', () => {
    const { container, getByRole } = render(<Editor />)
    fireEvent.click(chips(container)[0])
    fireEvent.click(cards(container)[0])
    const btn = getByRole('button', { name: '교체하기' }) as HTMLButtonElement
    btn.focus()
    expect(document.activeElement).toBe(btn)
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.disabled).toBe(false)
  })
})

describe('조작 안내', () => {
  it('세 경로(드래그·클릭·키보드)를 상시 노출하고 선수 버튼이 그것을 참조한다', () => {
    const { container } = render(<Editor />)
    const howto = container.querySelector('#lu-howto')!
    expect(howto.textContent).toContain('드래그')
    expect(howto.textContent).toContain('비교')
    expect(howto.textContent).toContain('스페이스')
    expect(within(container).getAllByRole('button')[0]).toBeTruthy()
    expect(chips(container)[0].getAttribute('aria-describedby')).toBe('lu-howto')
  })
})
