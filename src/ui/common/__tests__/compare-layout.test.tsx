// @vitest-environment jsdom
// 비교 뷰가 **좁은 상자 안에서도 깨지지 않는** 구조인지 고정한다.
//
// 사용자 캡처(2026-08-01 ③): 작전판의 선수 비교 팝업에서 이름이 `손...`으로 잘리고
// 요소가 서로 밀려 있었다. jsdom에는 레이아웃이 없어 픽셀로는 못 잡지만, 이 결함의
// **원인은 구조**였으므로 구조로 잡을 수 있다:
//
//   예전 머리 한 칸 = [순서][번호·이름][상태 칩]  ← 셋이 한 줄에서 폭을 다퉜다
//
// 상태 칩은 개수가 상황이 정한다(체력·사기·경고·정지…). 셋 중 유일하게 줄어들 수 있는
// 것이 이름이라, 칩이 붙는 순간 이름이 먼저 잘렸다. 폭이 넉넉하면 안 보이고 좁아질수록
// 심해지는 종류라 미디어 쿼리로는 못 막는다 — 이 컴포넌트는 420px 팝오버 안에도 들어간다.
//
// 처방: **이름이 첫 줄을 통째로 갖는다.** 칩은 포지션 줄로 내려간다.
// 아래 테스트가 그 배치를 못박는다.
//
// ★ container query로 고치려던 시도는 실측으로 기각됐다 — `container-type: inline-size`는
//   내용이 자기 폭에 기여하지 못하게 만들어, shrink-to-fit 팝오버를 44px로 접었다
//   (docs/audit/shots/r10-hud-*). 그 기각은 compare-css.test.ts가 CSS 본문으로 지킨다.
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { PlayerCompare } from '../PlayerCompare'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const team = makeTestTeam('kor', 80)
const byPos = (p: string, n = 0) => team.squad.filter(x => x.position === p)[n]

afterEach(cleanup)

/** 칩이 최대로 붙는 상태 — 체력 낮음 + 사기 낮음 + 누적 경고. */
const LOADED = { stamina: 22, morale: 30, cautions: 1 }

function renderPair() {
  return render(
    <PlayerCompare
      a={{ player: byPos('LW'), slot: 'LW', status: LOADED }}
      b={{ player: byPos('CM'), slot: 'CM', status: LOADED }}
    />,
  )
}

describe('비교 뷰 머리 — 이름은 상태 칩과 폭을 다투지 않는다', () => {
  it('상태 칩이 실제로 붙는 상황을 만든다(전제 확인)', () => {
    const { container } = renderPair()
    expect(container.querySelectorAll('.cmp__head .sx__chip').length).toBeGreaterThan(2)
  })

  it('★ 이름 줄에는 상태 칩이 하나도 없다', () => {
    const { container } = renderPair()
    for (const line of container.querySelectorAll('.cmp__nameline')) {
      expect(line.querySelectorAll('.sx__chip').length).toBe(0)
    }
  })

  it('★ 상태 칩은 포지션 줄(둘째 줄) 안에 있다', () => {
    const { container } = renderPair()
    const lines = [...container.querySelectorAll('.cmp__posline')]
    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(line.querySelectorAll('.sx__chip').length).toBeGreaterThan(0)
    }
  })

  it('머리 칸의 직계 자식은 순서 배지와 신원 두 개뿐이다(칩이 다시 올라오지 않는다)', () => {
    const { container } = renderPair()
    const head = container.querySelector('.cmp__head')!
    expect([...head.children].map(e => e.className.split(' ')[0]))
      .toEqual(['cmp__order', 'cmp__ident'])
  })
})
