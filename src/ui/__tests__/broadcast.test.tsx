// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

describe('broadcast components', () => {
  it('Scorebug: 팀 코드·스코어·분 표시', () => {
    render(<Scorebug home={makeTestTeam('kor', 78)} away={makeTestTeam('esp', 88)} score={[1, 2]} minute={67} live />)
    expect(screen.getByText(/KOR/)).toBeTruthy()
    expect(screen.getByText(/1/)).toBeTruthy()
    expect(screen.getByText(/67/)).toBeTruthy()
    expect(screen.getByText(/LIVE/)).toBeTruthy()
  })
  it('Ticker: 마지막 해설 라인 표시', () => {
    render(<Ticker lines={[{ minute: 12, text: '첫 해설' }, { minute: 20, text: '두 번째 해설' }]} />)
    expect(screen.getByText('두 번째 해설')).toBeTruthy()
  })
  it('Ticker: 해설위원 라인은 배지로 화자를 표시한다(캐스터는 배지 없음)', () => {
    const { container, rerender } = render(
      <Ticker lines={[{ minute: 20, text: '캐스터 문장', speaker: 'caster' }]} />,
    )
    expect(container.querySelector('.bc-ticker__who')).toBeNull()
    rerender(<Ticker lines={[{ minute: 20, text: '해설 문장', speaker: 'analyst' }]} />)
    expect(container.querySelector('.bc-ticker__who')?.textContent).toBe('해설')
    expect(container.querySelector('.bc-ticker__line--analyst')).toBeTruthy()
  })
  it('Ticker: speaker 미지정은 캐스터로 취급(기존 호출부 호환)', () => {
    const { container } = render(<Ticker lines={[{ minute: 5, text: '화자 없음' }]} />)
    expect(container.querySelector('.bc-ticker__who')).toBeNull()
  })
})
