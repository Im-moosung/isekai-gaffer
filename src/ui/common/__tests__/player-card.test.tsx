// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { PlayerCard, radarPoints, playerAxes, avatarInitials, STAT_MAX } from '../PlayerCard'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import type { Player } from '../../../engine/types'

const team = makeTestTeam('kor', 82)
const gk = team.squad.find(p => p.position === 'GK')!
const striker = team.squad.find(p => p.position === 'ST')!

afterEach(() => cleanup())

describe('radarPoints (순수 기하)', () => {
  it('축 0은 12시(위) — cos=0, sin=-1 → 값이 클수록 y가 작아진다', () => {
    const hi = radarPoints([99, 50, 50, 50, 50, 50], { cx: 50, cy: 50, r: 40 })
    const lo = radarPoints([10, 50, 50, 50, 50, 50], { cx: 50, cy: 50, r: 40 })
    // 축 0 좌표: x=cx(중앙), y=cy - r*ratio
    expect(hi[0].x).toBeCloseTo(50, 5)
    expect(lo[0].x).toBeCloseTo(50, 5)
    expect(hi[0].y).toBeCloseTo(50 - 40 * (99 / STAT_MAX), 5)
    expect(hi[0].y).toBeLessThan(lo[0].y) // 값 큰 쪽이 위(작은 y)
  })

  it('점 개수 = 값 개수, 6축/3축 모두 지원', () => {
    expect(radarPoints([1, 2, 3, 4, 5, 6], { cx: 0, cy: 0, r: 10 })).toHaveLength(6)
    expect(radarPoints([1, 2, 3], { cx: 0, cy: 0, r: 10 })).toHaveLength(3)
  })

  it('값=max면 반지름 100%, 값=0이면 중심', () => {
    const pts = radarPoints([STAT_MAX, 0, 0], { cx: 50, cy: 50, r: 30 })
    expect(pts[0].y).toBeCloseTo(50 - 30, 5) // 꼭 반지름만큼
    // 값 0인 축들은 중심에 모임
    expect(pts[1].x).toBeCloseTo(50, 5)
    expect(pts[1].y).toBeCloseTo(50, 5)
  })
})

describe('playerAxes', () => {
  it('필드 선수는 6축(슈팅/패스/드리블/수비/피지컬/스피드)', () => {
    const axes = playerAxes(striker)
    expect(axes.map(a => a.label)).toEqual(['슈팅', '패스', '드리블', '수비', '피지컬', '스피드'])
    expect(axes[0].value).toBe(striker.stats!.shooting)
  })
  it('GK는 3축(선방/공중/빌드업)', () => {
    const axes = playerAxes(gk)
    expect(axes.map(a => a.label)).toEqual(['선방', '공중', '빌드업'])
    expect(axes[0].value).toBe(gk.gkStats!.saving)
  })
})

describe('avatarInitials', () => {
  it('한글 이름은 첫 글자', () => {
    const p = { ...striker, name: { ko: '손흥민', en: 'Son Heung-min' } } as Player
    expect(avatarInitials(p)).toBe('손')
  })
  it('라틴 이름은 두 토큰 이니셜', () => {
    const p = { ...striker, name: { ko: '', en: 'Kylian Mbappe' } } as Player
    expect(avatarInitials(p)).toBe('KM')
  })
})

describe('PlayerCard 렌더', () => {
  it('필드 선수 → 6꼭짓점 폴리곤 + 이름·번호·포지션', () => {
    const { container, getByText } = render(<PlayerCard player={striker} slot="ST" />)
    const poly = container.querySelector('.pc-radar__poly')!
    expect(poly.getAttribute('data-n')).toBe('6')
    const pts = poly.getAttribute('points')!.trim().split(/\s+/)
    expect(pts).toHaveLength(6)
    expect(getByText(String(striker.number))).toBeTruthy()
    expect(getByText(striker.name.ko)).toBeTruthy()
  })

  it('GK → 3꼭짓점 삼각 폴리곤', () => {
    const { container } = render(<PlayerCard player={gk} />)
    expect(container.querySelector('.pc-radar__poly')!.getAttribute('data-n')).toBe('3')
  })

  it('폴리곤 좌표가 스탯을 반영한다(슈팅 높은 선수 top 꼭짓점이 더 위)', () => {
    const strong = { ...striker, stats: { ...striker.stats!, shooting: 99 } } as Player
    const weak = { ...striker, stats: { ...striker.stats!, shooting: 20 } } as Player
    const y = (p: Player) => {
      const { container } = render(<PlayerCard player={p} />)
      const first = container.querySelector('.pc-radar__poly')!.getAttribute('points')!.trim().split(/\s+/)[0]
      cleanup()
      return parseFloat(first.split(',')[1])
    }
    expect(y(strong)).toBeLessThan(y(weak))
  })

  it('주발 없으면(null) 발 아이콘 미표시', () => {
    const noFoot = { ...striker, foot: null } as Player
    const { container } = render(<PlayerCard player={noFoot} />)
    expect(container.querySelector('.pc__foot')).toBeNull()
  })

  it('왼발이면 발 아이콘 + aria-label 왼발', () => {
    const left = { ...striker, foot: 'L' } as Player
    const { getByLabelText } = render(<PlayerCard player={left} />)
    expect(getByLabelText('왼발')).toBeTruthy()
  })

  it('체력/사기 prop 제공 시 게이지, 미제공 시 없음', () => {
    const { container: withG } = render(<PlayerCard player={striker} stamina={64} morale={80} />)
    expect(withG.querySelectorAll('.pc-gauge')).toHaveLength(2)
    cleanup()
    const { container: noG } = render(<PlayerCard player={striker} />)
    expect(noG.querySelector('.pc__gauges')).toBeNull()
  })

  it('compact는 축 라벨을 숨긴다(full은 표시)', () => {
    const { container: c } = render(<PlayerCard player={striker} size="compact" />)
    expect(c.querySelectorAll('.pc-radar__label')).toHaveLength(0)
    cleanup()
    const { container: f } = render(<PlayerCard player={striker} size="full" />)
    expect(f.querySelectorAll('.pc-radar__label')).toHaveLength(6)
  })

  it('star=true → ★ + pc--star', () => {
    const { container, getByLabelText } = render(<PlayerCard player={striker} star />)
    expect(container.querySelector('.pc--star')).toBeTruthy()
    expect(getByLabelText('키 플레이어')).toBeTruthy()
  })
})

// F5-1: 이 경기 개인 기록 블록.
describe('PlayerCard — 이 경기 기록', () => {
  const stats = { shots: 3, shotsOnTarget: 1, goals: 1, assists: 0, fouls: 2, yellows: 1, reds: 0, saves: 0 }

  it('matchStats 미제공 시 블록이 없다(킥오프 전)', () => {
    const { container } = render(<PlayerCard player={striker} />)
    expect(container.querySelector('.pc__match')).toBeNull()
  })

  it('필드 선수는 슛·골·도움·파울·경고를 보여준다 — "유효슛"은 내걸지 않는다', () => {
    const { container } = render(<PlayerCard player={striker} matchStats={stats} />)
    const labels = [...container.querySelectorAll('.pc__stat-label')].map(e => e.textContent)
    expect(labels).toEqual(['슛', '골', '도움', '파울', '경고'])
    // 선방당한 슛은 슈터를 알 수 없어 유효슛을 정직하게 셀 수 없다 → UI에 노출하지 않는다.
    expect(container.textContent).not.toContain('유효슛')
    expect(container.querySelector('.pc__stat--warn')).toBeTruthy() // 경고 1 강조
  })

  it('GK는 선방을 보여준다(슛/골 대신) — save는 막은 GK의 기록이다', () => {
    const { container } = render(
      <PlayerCard player={gk} matchStats={{ ...stats, shots: 0, goals: 0, saves: 4 }} />,
    )
    const labels = [...container.querySelectorAll('.pc__stat-label')].map(e => e.textContent)
    expect(labels).toEqual(['선방', '파울', '경고'])
    expect(container.querySelector('.pc__match')!.textContent).toContain('4')
  })

  it('퇴장은 있을 때만 칩이 붙는다', () => {
    const { container: no } = render(<PlayerCard player={striker} matchStats={stats} />)
    expect(no.querySelector('.pc__stat--red')).toBeNull()
    cleanup()
    const { container: yes } = render(<PlayerCard player={striker} matchStats={{ ...stats, reds: 1 }} />)
    expect(yes.querySelector('.pc__stat--red')).toBeTruthy()
  })
})
