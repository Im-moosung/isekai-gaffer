// @vitest-environment jsdom
// 교체 탭에서 "교체로 나간 선수"가 어떻게 보이는가. 감사 재현: 1차 브레이크에서 뺀
// 선수가 2차 브레이크 벤치에 기록(도움 1 · 슛 2)과 함께 그대로 돌아와 재선택됐다.
// 정책: 목록에서 지우지 않고 잠근다 — 그 카드의 기록이 "그 교체가 옳았나"의 근거다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useMatchStore } from '../../game/matchStore'
import { SubPanel } from '../console/SubPanel'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())
afterEach(() => cleanup())

function pauseAtBreak() {
  useMatchStore.setState({ phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
}

/** 홈 벤치(선발 밖) 첫 선수 id. */
function benchId(): string {
  const st = store().engine!.home
  const starters = new Set(st.tactics.lineup.map(l => l.playerId))
  return st.team.squad.find(p => !starters.has(p.id))!.id
}

/** 교체 1건을 실행하고 나간 선수 id를 돌려준다. */
function doSub(): string {
  store().startMatch(home, away, 42)
  pauseAtBreak()
  const outId = store().engine!.home.tactics.lineup[9].playerId
  store().submitCommand('home', { type: 'sub', out: outId, in: benchId() })
  pauseAtBreak()
  return outId
}

/** 이름으로 벤치 카드를 찾는다. */
function cardOf(container: HTMLElement, playerId: string): HTMLButtonElement | null {
  const name = home.squad.find(p => p.id === playerId)!.name.ko
  return [...container.querySelectorAll<HTMLButtonElement>('.cs-sub__bench .cs-card')]
    .find(el => el.querySelector('.cs-card__name')?.textContent === name) ?? null
}

describe('교체 탭 — 교체 아웃 선수', () => {
  it('벤치 목록에서 사라지지 않는다 — 그 경기 기록을 계속 보여주기 위해', () => {
    const outId = doSub()
    const { container } = render(<SubPanel side="home" />)
    expect(cardOf(container, outId)).toBeTruthy()
  })

  it('선택할 수 없고 "교체 아웃" 사유가 붙는다', () => {
    const outId = doSub()
    const { container } = render(<SubPanel side="home" />)
    const card = cardOf(container, outId)!
    expect(card.classList.contains('cs-card--out')).toBe(true)
    expect(card.disabled).toBe(true)
    const chip = card.querySelector('.sx__chip[data-kind="out"]')
    expect(chip?.getAttribute('title')).toContain('교체 아웃')
    expect(chip?.getAttribute('title')).toContain('IFAB 제3조')
  })

  it('교체 아웃 칩은 단독으로 뜬다 — 못 뛰는 선수의 체력·사기는 잡음이다', () => {
    const outId = doSub()
    const { container } = render(<SubPanel side="home" />)
    expect(cardOf(container, outId)!.querySelectorAll('.sx__chip')).toHaveLength(1)
  })

  it('아웃 선수를 고르지 않은 다른 벤치 선수는 여전히 정상 표시된다', () => {
    doSub()
    const { container } = render(<SubPanel side="home" />)
    const cards = [...container.querySelectorAll('.cs-sub__bench .cs-card')]
    expect(cards.filter(c => c.classList.contains('cs-card--out'))).toHaveLength(1)
  })

  it('제어 모드로 강제 선택해도 [교체 확정]이 규정 사유로 거부한다', () => {
    const outId = doSub()
    const stillOn = store().engine!.home.tactics.lineup[3].playerId
    const { container, getByText } = render(
      <SubPanel side="home" outId={stillOn} inId={outId} onSelectOut={() => {}} onSelectIn={() => {}} />,
    )
    fireEvent.click(getByText('교체 확정'))
    expect(container.querySelector('.cs-error')?.textContent).toContain('IFAB 제3조')
    // 실제로 라인업이 바뀌지 않았다.
    expect(store().engine!.home.tactics.lineup.map(l => l.playerId)).not.toContain(outId)
  })
})
