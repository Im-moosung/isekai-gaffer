// @vitest-environment jsdom
// src/ui/common/__tests__/status-chips.test.tsx
// 상태 칩 — "나쁠 때만 뜬다"와 "형태 + 색"이 이 기능의 전부다. 둘 다 여기서 고정한다.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { statusChips, StatusChips } from '../StatusChips'

describe('statusChips — 표시 정책', () => {
  it('아무 문제가 없으면 칩이 하나도 없다', () => {
    expect(statusChips({ stamina: 100, morale: 70, cautions: 0 })).toEqual([])
  })

  it('출장정지는 단독 표시 — 뛰지 않는 선수의 체력·사기는 잡음이다', () => {
    const chips = statusChips({ suspended: true, stamina: 10, morale: 20, cautions: 1 })
    expect(chips).toHaveLength(1)
    expect(chips[0].kind).toBe('susp')
  })

  it('누적 경고 1장은 warn, 임계(2장) 도달은 danger', () => {
    expect(statusChips({ cautions: 1 })[0]).toMatchObject({ kind: 'caution', tone: 'warn', text: '1' })
    expect(statusChips({ cautions: 1, matchYellows: 1 })[0]).toMatchObject({ tone: 'danger', text: '2' })
  })

  it('임계 도달 라벨은 "확정"을, 미달 라벨은 남은 장수를 말한다', () => {
    expect(statusChips({ cautions: 1 })[0].label).toContain('1장 더')
    expect(statusChips({ cautions: 2 })[0].label).toContain('확정')
  })

  it('퇴장은 경고 칩을 대체한다(같은 사실을 두 번 말하지 않는다)', () => {
    const chips = statusChips({ sentOff: true, matchYellows: 2, cautions: 1 })
    expect(chips.map(c => c.kind)).toEqual(['sent'])
  })

  it('체력은 70 미만에서만, 40 미만이면 danger', () => {
    expect(statusChips({ stamina: 70 })).toEqual([])
    expect(statusChips({ stamina: 69 })[0]).toMatchObject({ kind: 'fit', tone: 'warn', text: '69' })
    expect(statusChips({ stamina: 30 })[0]).toMatchObject({ tone: 'danger' })
  })

  it('사기는 55 미만(침체)·85 이상(고조)에서만 뜨고 방향이 도형으로 갈린다', () => {
    expect(statusChips({ morale: 70 })).toEqual([])
    expect(statusChips({ morale: 40 })[0]).toMatchObject({ kind: 'mood', shape: 'tri-down', tone: 'warn' })
    expect(statusChips({ morale: 90 })[0]).toMatchObject({ shape: 'tri-up', tone: 'good' })
  })

  it('동시에 붙는 칩은 최대 3개이고 심각도 순으로 정렬된다', () => {
    const chips = statusChips({ cautions: 1, stamina: 30, morale: 40 })
    expect(chips.map(c => c.kind)).toEqual(['caution', 'fit', 'mood'])
  })

  it('색만으로 구분하지 않는다 — 톤이 같아도 도형이 다르다', () => {
    const chips = statusChips({ cautions: 1, stamina: 50, morale: 40 })
    const shapes = new Set(chips.map(c => c.shape))
    expect(chips.every(c => c.tone === 'warn')).toBe(true)
    expect(shapes.size).toBe(chips.length)
  })

  it('모든 칩은 수치·사유를 담은 접근 가능 이름을 가진다', () => {
    for (const c of statusChips({ cautions: 1, stamina: 30, morale: 40 })) {
      expect(c.label.length).toBeGreaterThan(4)
    }
  })
})

describe('<StatusChips>', () => {
  it('표시할 것이 없으면 아무 요소도 남기지 않는다', () => {
    const { container } = render(<StatusChips input={{ stamina: 100, morale: 70 }} />)
    expect(container.firstChild).toBeNull()
  })

  it('칩마다 aria-label과 title이 붙는다(툴팁으로 정확한 수치)', () => {
    const { container } = render(<StatusChips input={{ cautions: 1, stamina: 33 }} />)
    const chips = container.querySelectorAll('.sx__chip')
    expect(chips).toHaveLength(2)
    for (const c of chips) {
      expect(c.getAttribute('aria-label')).toBeTruthy()
      expect(c.getAttribute('title')).toBe(c.getAttribute('aria-label'))
    }
  })

  it('도형·톤이 클래스로 나간다(CSS가 실루엣을 그린다)', () => {
    const { container } = render(<StatusChips input={{ suspended: true }} />)
    expect(container.querySelector('.sx__chip--card.sx__chip--danger')).toBeTruthy()
    expect(container.querySelector('.sx__mark')).toBeTruthy()
  })
})
