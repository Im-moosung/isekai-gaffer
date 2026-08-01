// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, fireEvent, cleanup, act } from '@testing-library/react'
import { useMatchStore, freeInterventionState, MAX_FREE_INTERVENTIONS } from '../../game/matchStore'
import { MatchScreen } from '../match/MatchScreen'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import type { MatchEvent } from '../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

// 재생 루프는 분당 가변 setTimeout 체인(playback.minuteDwellMs)으로 1분씩 전진한다.
// 각 스텝은 "다음 타이머로 진행"(advanceTimersToNextTimer)으로 dwell 길이와 무관하게
// 정확히 1분씩 넘긴다. act로 감싸 콜백·리렌더를 안정적으로 진행시킨다.
function step(times: number) {
  for (let i = 0; i < times; i++) {
    act(() => { vi.advanceTimersToNextTimer() })
  }
}

// 킥오프 = [킥오프] → 입장 연출 → [건너뛰기]. 유저가 타는 경로 그대로다.
// 연출을 건너뛰어야 phase가 'playing'이 되므로 재생을 보는 테스트는 전부 이걸 쓴다.
// (연출 자체의 계약은 entrance.test.ts·entrance-overlay.jsdom.test.tsx가 검증한다.)
function kickoffNow(getByRole: (role: string, opts: { name: string }) => HTMLElement) {
  fireEvent.click(getByRole('button', { name: '킥오프' }))
  fireEvent.click(getByRole('button', { name: '입장 연출 건너뛰고 바로 킥오프' }))
}

// 목표 phase까지 재생 — 도중 자동 정지(브레이크·하프타임)는 confirmTactics로 재개.
// ★ 2026-08-01: 상한을 400 → 3000으로 올렸다. 한 분에 걸리는 타이머가 늘었다 —
//   결과 노출 게이트(minuteRevealMs)와 발화 지연(REVEAL_LAG_MS)이 각각 타이머를 하나씩
//   더 쓴다. 400번으로는 90분을 못 넘겨 fulltime에 도달하지 못한다.
function replayTo(target: string) {
  for (let i = 0; i < 3000 && store().phase !== target; i++) {
    if (store().phase === 'playing') act(() => { vi.advanceTimersToNextTimer() })
    else act(() => { store().confirmTactics() })
  }
}

// PitchView의 라이브 무브먼트 클럭은 setInterval로 계속 돈다. 가짜 타이머 환경에서
// advanceTimersToNextTimer가 그 인터벌만 소진해 재생 체인(분 전진)이 굶는다.
// 이 파일이 검증하는 것은 재생 루프·모드 전환이므로 reduced-motion으로 클럭을 끈다
// (라이브 클럭 자체는 pitch/__tests__/live-motion.test.ts가 검증한다).
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    configurable: true, writable: true,
  })
  vi.useFakeTimers(); store().reset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const clock = (c: HTMLElement) =>
  parseInt(c.querySelector('.bc-scorebug__clock')!.textContent!.replace(/\D/g, ''), 10)
const svg = (c: HTMLElement) => c.querySelector('svg.pv-root')

describe('MatchScreen 조립 — 오버레이 폐지(피치 상시 노출)', () => {
  it('(a) 렌더 → 하단 바에 킥오프 버튼 + 피치 SVG 존재', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    expect(getByRole('button', { name: '킥오프' })).toBeTruthy()
    // pre 단계에서도 피치는 보인다(가리는 오버레이 없음).
    expect(svg(container as HTMLElement)).toBeTruthy()
  })

  it('(b) 킥오프 → 재생 진행 → Scorebug 분 표기 증가', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    expect(clock(container as HTMLElement)).toBe(0)
    kickoffNow(getByRole)
    step(10)
    expect(clock(container as HTMLElement)).toBeGreaterThan(0)
  })

  it('(b2) [킥오프] → 입장 연출이 뜨고 경기는 아직 시작되지 않는다', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    fireEvent.click(getByRole('button', { name: '킥오프' }))
    // 연출 중에는 phase가 'pre' 그대로다 — 선수가 자리를 잡기 전에 시계가 돌면 안 된다.
    expect(store().phase).toBe('pre')
    expect(container.querySelector('.ent')).toBeTruthy()
    // ★ E-4: 입장 중에는 스코어버그(0:0 0')도 중계 티커도 없다 — 아직 경기 전이다.
    //   대신 프리매치 스트립 한 줄만 남는다.
    expect(container.querySelector('.bc-scorebug')).toBeNull()
    expect(container.querySelector('.bc-ticker')).toBeNull()
    expect(container.querySelector('.ms-prematch')).toBeTruthy()
    // 건너뛰면 비로소 킥오프.
    fireEvent.click(getByRole('button', { name: '입장 연출 건너뛰고 바로 킥오프' }))
    expect(store().phase).toBe('playing')
    expect(container.querySelector('.ent')).toBeNull()
  })

  it('(c) 크래시 없이 halftime 도달 → 작전판(tactics) 모드: 팀토크 카드 + [후반 시작] + 사유', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    replayTo('halftime')
    expect(store().phase).toBe('halftime')
    // 하프타임 = 작전판 진입(다크 보드).
    expect(container.querySelector('.tb-root')).toBeTruthy()
    expect(container.querySelector('.pv-root--tactics')).toBeTruthy()
    // 하프타임 팀토크 카드가 작전판 상단에 존재.
    expect(container.querySelector('.tt-root')).toBeTruthy()
    // 하단 재개 버튼은 [후반 시작] 라벨.
    expect(getByRole('button', { name: '후반 시작' })).toBeTruthy()
    // 정지 사유 표시.
    expect(container.querySelector('.tb-head__reason')!.textContent).toContain('전반 종료')
  })

  it('(e) LIVE 뱃지는 재생 중에만 노출 — 킥오프 전 없음, 재생 중 존재', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    const live = () => container.querySelector('.bc-scorebug__live')
    expect(live()).toBeNull()
    kickoffNow(getByRole)
    step(3)
    expect(live()).not.toBeNull()
    expect(live()!.textContent).toContain('LIVE')
  })

  it('(d) 재생 전 스코어 스포일러 방지 — 킥오프 직후 minute=0이면 0:0', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={6} />)
    kickoffNow(getByRole)
    const nums = container.querySelectorAll('.bc-scorebug__num')
    expect(nums[0].textContent).toBe('0')
    expect(nums[1].textContent).toBe('0')
  })
})

describe('MatchScreen 개입 허브 — 브레이크·순간 제안·풀타임', () => {
  it('(h) paused-break → 작전판: 다크 보드 pitch + [전술 확정] + 사유(하이드레이션)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    replayTo('paused-break')
    expect(store().phase).toBe('paused-break')
    // 작전판 다크 보드.
    expect(container.querySelector('.tb-root')).toBeTruthy()
    expect(container.querySelector('.pv-root--tactics')).toBeTruthy()
    // 하단 [전술 확정] 대형 버튼.
    expect(getByRole('button', { name: '전술 확정' })).toBeTruthy()
    // 정지 사유 문구.
    expect(container.querySelector('.tb-head__reason')!.textContent).toContain('하이드레이션 브레이크')
  })

  it('(i) momentPrompt 배너: [사용]→paused-moment, [흘려보낸다]→playing 유지', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(2)
    expect(store().phase).toBe('playing')
    // 재생 중 순간 제안을 세팅(레이아웃 스모크: 배너 액션 배선 확인).
    act(() => { useMatchStore.setState({ momentPrompt: { kind: 'conceded', minute: 12, title: 't' } }) })
    const banner = container.querySelector('.ms-banner')!
    expect(banner.textContent).toContain('실점 직후')
    // 피치는 순간 제안 중에도 보인다.
    expect(svg(container as HTMLElement)).toBeTruthy()

    // [흘려보낸다] → 재생 유지, 제안만 사라짐.
    fireEvent.click(getByRole('button', { name: '흘려보낸다' }))
    expect(store().phase).toBe('playing')
    expect(store().momentPrompt).toBeNull()

    // 다시 제안 세팅 후 [사용] → paused-moment로 정지.
    act(() => { useMatchStore.setState({ momentPrompt: { kind: 'conceded', minute: 13, title: 't' } }) })
    fireEvent.click(getByRole('button', { name: '사용' }))
    expect(store().phase).toBe('paused-moment')
  })

  // ── 순간 배너는 자원에 따라 두 얼굴이다(사용자 지적 2026-08-01) ──────────
  // *"개입을 다 썼거나 쿨타임일 때도 '개입하시겠습니까?' 버튼이 떠."*
  // 상황 자체는 유저가 알아야 할 경기 정보이므로 숨기지 않는다. 대신 쓸 수 없으면
  // 묻지 않고 **알린다** — 사실 + 왜 못 쓰는지, 버튼 없음.
  it('(i-2) 자원이 없으면 제안이 아니라 알림이다 — [사용]이 없고 사유가 붙는다', () => {
    const { getByRole, container, queryByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(2)
    const c = container as HTMLElement
    act(() => {
      useMatchStore.setState({
        momentPrompt: { kind: 'momentum-lost', minute: 12, title: 't' },
        freeInterventionsUsed: MAX_FREE_INTERVENTIONS,
      })
    })
    const banner = c.querySelector('.ms-banner')!
    // 사실은 그대로 남는다.
    expect(banner.textContent).toContain('흐름이 상대에게 넘어갑니다')
    // 묻지 않는다.
    expect(banner.textContent).not.toContain('쓰시겠습니까')
    expect(queryByRole('button', { name: '사용' })).toBeNull()
    // 대신 왜 못 쓰는지 — store가 정본이다.
    const reason = freeInterventionState(MAX_FREE_INTERVENTIONS, null, store().engine!.minute).blockedReason!
    expect(banner.textContent).toContain(reason)
    // 결정을 요구하지 않으므로 톤도 낮다(브랜드 틴트를 걷는다).
    expect(banner.classList.contains('ms-banner--info')).toBe(true)
  })

  it('(i-3) 쿨다운이 풀리면 같은 배너가 저절로 제안으로 승격한다', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(2)
    const c = container as HTMLElement
    const minute = store().engine!.minute
    act(() => {
      useMatchStore.setState({
        momentPrompt: { kind: 'momentum-lost', minute, title: 't' },
        lastInterventionMinute: minute,
      })
    })
    expect(c.querySelector('.ms-banner--info')).toBeTruthy()
    // 쿨다운만 풀면(같은 제안 그대로) 배너가 제안으로 바뀐다 — 판정이 렌더 시점에 있다.
    act(() => { useMatchStore.setState({ lastInterventionMinute: null }) })
    expect(c.querySelector('.ms-banner--info')).toBeNull()
    expect(c.querySelector('.ms-banner')!.textContent).toContain('쓰시겠습니까')
    expect(getByRole('button', { name: '사용' })).toBeTruthy()
  })

  // ★ 계약 변경: 종료 화면은 **리포트가 전부**다. 예전엔 빈 3D 피치가 화면의 47%를
  //   차지한 채 속도 토글·플랜 배지까지 남아 있었다. 볼 경기가 없으면 피치도 없다.
  it('(j) fulltime: 피치·재생 크롬 언마운트 + 기록 리포트(점유율) + 액션 버튼', () => {
    const onMatchEnd = vi.fn()
    const { container, getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} onMatchEnd={onMatchEnd} />)
    act(() => { store().kickoff() })
    replayTo('fulltime')
    act(() => { vi.advanceTimersByTime(1000) }) // 작전판 역연출 종료
    expect(store().phase).toBe('fulltime')
    // 피치(3D/2D)와 재생 전용 크롬이 사라진다.
    expect(container.querySelector('.ms-pitch-wrap')).toBeNull()
    expect(svg(container as HTMLElement)).toBeNull()
    expect(container.querySelector('.plan-badge')).toBeNull()
    // 기록 리포트 + 액션.
    expect(container.querySelector('.ms-report')).toBeTruthy()
    expect(container.querySelector('.ms-stats')!.textContent).toContain('점유율')
    expect(getByRole('button', { name: '결과 확정' })).toBeTruthy()
  })
})

describe('MatchScreen 재생 루프 — 정지·재개·속도', () => {
  it('(f) 재생 중 pause → 체인 정지(시간 흘려도 분 불변) → confirmTactics 재개', () => {
    const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(4)
    expect(store().phase).toBe('playing')
    const before = store().engine!.minute
    expect(before).toBeGreaterThan(0)

    // [감독 타임] → 체인 정지. 이후 시간을 크게 흘려도 분이 전진하지 않아야 한다.
    // (이모지 ⏸는 걷어냈다 — OS마다 모양·크기가 달라 버튼 폭이 흔들린다.)
    fireEvent.click(getByRole('button', { name: '감독 타임' }))
    expect(store().phase).toBe('paused-user')
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(store().engine!.minute).toBe(before)

    // 전술 확정 → 재개. 시간이 흐르면 분이 다시 늘어난다(전환 연출 타이머와 무관하게).
    fireEvent.click(getByRole('button', { name: '전술 확정' }))
    expect(store().phase).toBe('playing')
    act(() => { vi.advanceTimersByTime(5000) })
    expect(store().engine!.minute).toBeGreaterThan(before)
  })

  it('(g) 속도 토글 — 선택 상태 반영 + 2x가 같은 시간에 더 많이 전진', () => {
    function minutesInBudget(setTo2x: boolean, budgetMs: number): number {
      store().reset()
      const { getByRole } = render(<MatchScreen home={home} away={away} seed={20260724} />)
      kickoffNow(getByRole)
      if (setTo2x) {
        const btn = getByRole('button', { name: '2x' })
        fireEvent.click(btn)
        expect(btn.getAttribute('aria-pressed')).toBe('true')
      }
      act(() => { vi.advanceTimersByTime(budgetMs) })
      const m = store().engine!.minute
      cleanup()
      return m
    }
    const budget = 9000
    const at1x = minutesInBudget(false, budget)
    const at2x = minutesInBudget(true, budget)
    expect(at1x).toBeGreaterThan(0)
    expect(at2x).toBeGreaterThan(at1x)
  })
})

describe('MatchScreen 연출 — 골 드라마·안무·위험 순간', () => {
  // 재생 중 현재 분에 이벤트를 주입해 연출 렌더를 스모크한다(엔진 이벤트 배열에 push).
  function inject(events: MatchEvent[]) {
    const eng = store().engine!
    act(() => { useMatchStore.setState({ engine: { ...eng, events: [...eng.events, ...events] } }) })
  }

  it('(m) 홈 득점 분 → GOAL! 타이포 + 득점자 배너 + 안무 공(.pv-ball) + 스코어버그 펄스', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(3)
    expect(store().phase).toBe('playing')
    const eng = store().engine!
    const scorer = eng.home.tactics.lineup[10].playerId
    inject([{ minute: eng.minute, type: 'goal', teamId: home.id, playerId: scorer }])
    expect(container.querySelector('.ms-drama--score')).toBeTruthy()
    expect(container.querySelector('.ms-drama__word')!.textContent).toContain('GOAL')
    expect(container.querySelector('.ms-scorer')).toBeTruthy()
    // 안무 공이 lastEvent 정적 마커를 대체.
    expect(container.querySelector('.pv-ball')).toBeTruthy()
    // 스코어버그 펄스 클래스.
    expect(container.querySelector('.bc-scorebug__score--pulse')).toBeTruthy()
  })

  it('(n) 상대 득점(실점) → concede 연출로 차별화(어두운 톤·실점 태그)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(3)
    const eng = store().engine!
    inject([{ minute: eng.minute, type: 'goal', teamId: away.id }])
    expect(container.querySelector('.ms-drama--concede')).toBeTruthy()
    // 실점 태그는 공용 배지(.badge--danger)로 통일했다 — 색 하나에 뜻 하나.
    expect(container.querySelector('.ms-scorer__tag.badge--danger')).toBeTruthy()
  })

  it('(o) 큰 장면(xG 0.25+ 세이브) → 비네팅 + 티커 강조', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(3)
    const eng = store().engine!
    inject([{ minute: eng.minute, type: 'save', teamId: home.id, xg: 0.4 }])
    expect(container.querySelector('.ms-vignette')).toBeTruthy()
    expect(container.querySelector('.bc-ticker--emphasis')).toBeTruthy()
  })
})

describe('MatchScreen 모드 분리 — 방송 관전 ↔ 작전 지시', () => {
  it('(k) broadcast(pre·재생)엔 콘솔·작전판이 DOM에 없다', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    // pre = 방송 모드. 작전판 오버레이는 없다.
    // (킥오프 전 워룸은 '설계' 화면이라 그 안에 콘솔이 있을 수 있다 — 여기서 고정하는
    //  계약은 "관전 중에는 지휘 UI가 DOM에 없다"이므로 재생 중 상태로 판정한다.)
    expect(container.querySelector('.tb-root')).toBeNull()
    // 재생 중에는 작전판·콘솔 모두 부재.
    kickoffNow(getByRole)
    step(3)
    expect(store().phase).toBe('playing')
    expect(container.querySelector('.tb-root')).toBeNull()
    expect(container.querySelector('.cs-panel')).toBeNull()
  })

  it('(l) pause → 작전판(콘솔 포함) 렌더 / confirm → 방송 복귀(작전판 언마운트)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    replayTo('paused-break')
    // 작전판 진입 — 보드 + 콘솔이 작전판 안으로 이관됨.
    expect(container.querySelector('.tb-root')).toBeTruthy()
    expect(container.querySelector('.cs-panel')).toBeTruthy()

    // ★ T-2: 오버레이가 뜨면 그 아래 방송 furniture는 **실제로 언마운트**된다.
    //   숨기기만 하면 작전판 문구와 스코어버그·플랜 배지가 겹쳐 쌓인다(실측 92~100%).
    expect(container.querySelector('.bc-scorebug')).toBeNull()
    expect(container.querySelector('.plan-badge')).toBeNull()
    expect(container.querySelector('.bc-ticker')).toBeNull()

    // 전술 확정 → 방송 복귀. 역연출 시간 경과 후 작전판 언마운트.
    fireEvent.click(getByRole('button', { name: '전술 확정' }))
    expect(store().phase).toBe('playing')
    act(() => { vi.advanceTimersByTime(700) })
    expect(container.querySelector('.tb-root')).toBeNull()
  })
})

describe('MatchScreen — 플랜 배지(PlanBadge)', () => {
  const badge = (c: HTMLElement) => c.querySelector('.plan-badge')

  it('킥오프 전엔 배지가 없고, 킥오프 후 "플랜 유지"로 나타난다', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    expect(badge(container as HTMLElement)).toBeNull()
    kickoffNow(getByRole)
    step(3)
    const b = badge(container as HTMLElement)!
    expect(b).toBeTruthy()
    expect(b.textContent).toContain('플랜 유지')
    expect(b.textContent).toContain('팀 이해도 +3%')
    expect(b.className).toContain('plan-badge--ok')
  })

  // ★ 작전판(오버레이) 진입 중에는 배지가 언마운트된다(T-2) — 배지는 **방송 복귀 후**
  //   상태를 말한다. 그래서 전술을 바꾼 뒤 확정하고 돌아와서 읽는다.
  // 2026-08-01: "플랜 이탈 N축" 갈래를 없앴다(사용자 지시). 이탈하면 배지가 사라진다 —
  //   배지의 존재 자체가 "보너스 살아 있음"이다(PlanBadge.tsx 주석의 논증).
  it('구조(포메이션)를 바꾸면 배지가 사라진다(이탈 추궁 문구를 띄우지 않는다)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    replayTo('paused-break')
    fireEvent.click(getByRole('button', { name: '5-4-1' }))
    fireEvent.click(getByRole('button', { name: '전술 확정' }))
    act(() => { vi.advanceTimersByTime(700) })
    expect(badge(container as HTMLElement)).toBeNull()
    expect(container.textContent).not.toContain('플랜 이탈')
    // 집계 자체는 살아 있어야 한다 — 기자회견이 store에서 직접 읽는다.
    expect(store().planDeviation).toBeGreaterThan(0)
  })

  it('지시 미세 조정만으로는 배지가 "플랜 유지"를 유지한다(구조 기준)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    replayTo('paused-break')
    const before = store().engine!.home.tactics.instructions
    act(() => {
      store().submitCommand('home', { type: 'instructions', instructions: { ...before, pressing: 95 } })
    })
    fireEvent.click(getByRole('button', { name: '전술 확정' }))
    act(() => { vi.advanceTimersByTime(700) })
    expect(badge(container as HTMLElement)!.textContent).toContain('플랜 유지')
  })
})

// ── 감독 타임 = 희소 자원. 잔량·쿨다운·막힘 사유가 화면에 있어야 한다 ──────
// 사용자 요구: "개입이 몇 번 남았는지, 개입까지 몇 분인지를 알 수 있어야 해."
// 계획해서 쓰라고 건 제약이므로 잔량이 안 보이면 제약이 설계로 성립하지 않는다.
// 문구의 정본은 store(freeInterventionState.blockedReason)다 — 화면은 그대로 옮긴다.
describe('MatchScreen — 자유 개입 자원 표시(감독 타임)', () => {
  const pod = (c: HTMLElement) => c.querySelector('.ms-controls')!
  const timeBtn = (c: HTMLElement) =>
    [...c.querySelectorAll('.ms-controls button')].find(b => b.textContent?.includes('감독 타임')) as HTMLButtonElement

  it('재생 중 잔량이 항상 보인다(개입 N/5)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(3)
    expect(pod(container as HTMLElement).textContent).toContain(`개입 ${MAX_FREE_INTERVENTIONS}/${MAX_FREE_INTERVENTIONS}`)
    expect(timeBtn(container as HTMLElement).disabled).toBe(false)
  })

  // ★ 2026-08-01 계약 변경(사용자 지시 ①) — 사유는 **상시 노출에서 눌렀을 때 노출로**
  //   옮겼다. 40자 넘는 문장이 버튼 옆에 늘 서서 제어 pod를 두 줄로 만들었는데, "언제
  //   돌아오는가"는 쿨다운 링이 이미 말하고 있었다. 없앤 게 아니라 옮긴 것이므로
  //   **사유의 정확성은 그대로** 검증한다(store의 blockedReason과 문자열이 같아야 한다).
  //   버튼도 disabled가 아니라 aria-disabled다 — disabled면 클릭이 오지 않아 사유를
  //   띄울 기회 자체가 없다("이유 없는 disabled는 고장으로 읽힌다").
  it('횟수를 다 썼을 때: 사유는 평소엔 안 보이고, 누르면 그 문장이 뜬다', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(3)
    act(() => { useMatchStore.setState({ freeInterventionsUsed: MAX_FREE_INTERVENTIONS }) })
    const c = container as HTMLElement
    expect(pod(c).textContent).toContain('개입 0/5')
    const btn = timeBtn(c)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    const reason = freeInterventionState(MAX_FREE_INTERVENTIONS, null, store().engine!.minute).blockedReason!
    expect(reason).toBeTruthy()
    // 평소에는 없다 — 이게 자리를 되찾은 부분이다.
    expect(c.querySelector('.ms-notice')).toBeNull()
    expect(pod(c).textContent).not.toContain(reason)
    // 누르면 뜬다.
    act(() => { fireEvent.click(btn) })
    expect(c.querySelector('.ms-notice')!.textContent).toBe(reason)
    // 그리고 스스로 사라진다(상시 노출로 되돌아가지 않는다).
    act(() => { vi.advanceTimersByTime(4000) })
    expect(c.querySelector('.ms-notice')).toBeNull()
  })

  it('쿨다운 중에도 같다 — 링이 상시로 말하고, 남은 분은 누를 때 말한다', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(3)
    const minute = store().engine!.minute
    act(() => { useMatchStore.setState({ lastInterventionMinute: minute }) })
    const c = container as HTMLElement
    const st = freeInterventionState(0, minute, store().engine!.minute)
    expect(st.cooldownLeft).toBeGreaterThan(0)
    expect(timeBtn(c).getAttribute('aria-disabled')).toBe('true')
    // 링은 상시다 — ShoutBar와 같은 시각 언어이고, 이것이 설명문을 대신한다.
    // (개입 10분 · 외침 5분으로 재는 시계는 다르다. 어느 자원인지는 옆 라벨이 말한다.)
    expect(c.querySelector('.ms-controls .sb-ring')).toBeTruthy()
    expect(pod(c).textContent).not.toContain(st.blockedReason!)
    act(() => { fireEvent.click(timeBtn(c)) })
    const notice = c.querySelector('.ms-notice')!.textContent!
    expect(notice).toBe(st.blockedReason!)
    expect(notice).toContain(String(st.cooldownLeft))
  })

  it('막히지 않았으면 누를 때 알림이 뜨지 않는다(감독 타임이 그냥 열린다)', () => {
    const { getByRole, container } = render(<MatchScreen home={home} away={away} seed={20260724} />)
    kickoffNow(getByRole)
    step(3)
    const c = container as HTMLElement
    act(() => { fireEvent.click(timeBtn(c)) })
    expect(store().phase).toBe('paused-user')
    expect(c.querySelector('.ms-notice')).toBeNull()
  })

  it('두 사유는 서로 다른 문장이다(무엇이 막았는지 구별된다)', () => {
    const spent = freeInterventionState(MAX_FREE_INTERVENTIONS, null, 30).blockedReason
    const cooling = freeInterventionState(0, 25, 30).blockedReason
    expect(spent).toBeTruthy()
    expect(cooling).toBeTruthy()
    expect(spent).not.toBe(cooling)
  })
})
