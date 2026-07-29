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
})
