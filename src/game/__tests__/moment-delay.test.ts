// 순간 제안의 **노출 지연** — 사용자 신고(2026-08-02):
//
//   *"'득점 직후 — 더 몰아칠까요? — 감독 타임을 쓰시겠습니까?' 이게 골보다 또 빨리 나와.
//     골 들어가고 게임시간 1분 뒤에 나오도록 강제해. 굳이 바로 나올 필요도 없는 거잖아."*
//
// advanceMinute이 그 분을 시뮬레이션한 직후 같은 틱에 제안을 세우는 반면, 골 장면과 중계는
// 재생 dwell + reveal 게이트로 6~7초 뒤에야 나온다 — 문장이 장면을 앞질러 결과를 말했다.
// 처방은 store의 지연 큐(pendingMoment)다: 감지된 순간은 큐에 들어가 **다음 게임 분**에
// momentPrompt로 승격한다. 실제 시간이 아니라 게임 분이므로 배속과 무관하게 같은 간격이다.
import { describe, it, expect, beforeEach } from 'vitest'
import { useMatchStore, pendingMomentVerdict, MOMENT_PROMPT_DELAY } from '../matchStore'
import { makeTestTeam } from '../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 82), away = makeTestTeam('esp', 84)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

describe('pendingMomentVerdict — 순수 판정', () => {
  const pending = { moment: { kind: 'scored' as const, minute: 20, title: '득점 직후' }, score: [1, 0] as [number, number] }

  it('감지된 그 분에는 아직 띄우지 않는다', () => {
    expect(pendingMomentVerdict(pending, 20, [1, 0])).toBe('wait')
  })

  it('DELAY분 뒤에 승격한다', () => {
    expect(pendingMomentVerdict(pending, 20 + MOMENT_PROMPT_DELAY, [1, 0])).toBe('promote')
  })

  it('기다리는 사이 스코어가 바뀌면 버린다 — "득점 직후"가 이미 낡은 말이다', () => {
    expect(pendingMomentVerdict(pending, 20 + MOMENT_PROMPT_DELAY, [1, 1])).toBe('drop')
    expect(pendingMomentVerdict(pending, 20 + MOMENT_PROMPT_DELAY, [2, 0])).toBe('drop')
    // 승격 분을 기다리지 않고 즉시 버린다(만료 판정과 같은 원칙).
    expect(pendingMomentVerdict(pending, 20, [1, 1])).toBe('drop')
  })

  it('큐가 비었으면 할 일이 없다', () => {
    expect(pendingMomentVerdict(null, 20, [0, 0])).toBe('wait')
  })
})

describe('advanceMinute — 골이 터진 분에는 제안이 뜨지 않는다', () => {
  /** 스코어가 처음 바뀌는 분까지 재생한다. 경계 분(하프타임·하이드레이션)에 걸리면 null. */
  function playToFirstGoal(seed: number): number | null {
    store().startMatch(home, away, seed)
    store().kickoff()
    let guard = 0
    while (store().phase === 'playing' && guard++ < 95) {
      const before = store().engine!.score
      store().advanceMinute()
      const after = store().engine!.score
      if (store().phase !== 'playing') return null // 경계에서 골이 났다 — 이 시드는 조건 밖
      if (after[0] !== before[0] || after[1] !== before[1]) return store().engine!.minute
    }
    return null
  }

  it('★ 골이 들어간 분에는 momentPrompt가 null이고, 큐에만 들어간다', () => {
    let found = false
    for (const seed of [1, 3, 7, 11, 42, 101, 777, 1234, 2026]) {
      store().reset()
      const goalMinute = playToFirstGoal(seed)
      if (goalMinute === null) continue
      found = true
      // 배너는 아직 없다 — 화면이 골을 보여주기도 전에 문장이 먼저 나오면 안 된다.
      expect(store().momentPrompt).toBeNull()
      // 대신 지연 큐에 감지 결과가 들어 있다(스코어 변화이므로 scored/conceded 중 하나).
      const pending = store().pendingMoment
      expect(pending).not.toBeNull()
      expect(['scored', 'conceded']).toContain(pending!.moment.kind)
      expect(pending!.moment.minute).toBe(goalMinute)
      // 감지 시점에는 유형을 소비하지 않는다 — 승격해야 비로소 제안으로 성립한다.
      expect(store().firedMoments).not.toContain(pending!.moment.kind)
      break
    }
    expect(found).toBe(true)
  })

  it('★ 다음 분에 뜬다 — 스코어가 그대로라면', () => {
    let found = false
    for (const seed of [1, 3, 7, 11, 42, 101, 777, 1234, 2026]) {
      store().reset()
      const goalMinute = playToFirstGoal(seed)
      if (goalMinute === null) continue
      const pending = store().pendingMoment!
      const before = store().engine!.score
      store().advanceMinute()
      if (store().phase !== 'playing') continue // 다음 분이 경계였다 — 버리는 게 계약이다
      const after = store().engine!.score
      if (after[0] !== before[0] || after[1] !== before[1]) continue // 연속 골 — 버리는 게 계약이다
      found = true
      expect(store().engine!.minute).toBe(goalMinute + MOMENT_PROMPT_DELAY)
      expect(store().momentPrompt).toEqual(pending.moment)
      // 문장이 가리키는 장면은 여전히 **골이 난 분**이다(MatchScreen의 노출 게이트가 이 값을 쓴다).
      expect(store().momentPrompt!.minute).toBe(goalMinute)
      expect(store().pendingMoment).toBeNull()
      break
    }
    expect(found).toBe(true)
  })

  it('★ 지연 중에 스코어가 또 바뀌면 뜨지 않는다', () => {
    store().startMatch(home, away, 42)
    store().kickoff()
    store().advanceMinute()
    const engine = structuredClone(store().engine!)
    engine.minute = 30
    engine.score = [1, 0]
    // 30'에 득점이 감지돼 큐에 들어간 상태를 직접 만든다(감지 조건에 의존하지 않는 재현).
    useMatchStore.setState({
      engine, phase: 'playing', momentPrompt: null, momentPromptScore: null,
      firedMoments: [],
      pendingMoment: { moment: { kind: 'scored', minute: 30, title: '득점 직후' }, score: [1, 0] },
    })
    // 승격 전에 한 골 더 들어간다.
    const bumped = structuredClone(store().engine!)
    bumped.score = [1, 1]
    useMatchStore.setState({ engine: bumped })
    store().advanceMinute()
    expect(store().momentPrompt).toBeNull()
    expect(store().pendingMoment).toBeNull()
    // 버려진 제안은 유형도 소비하지 않는다 — 배너가 한 번도 뜨지 않았기 때문이다.
    expect(store().firedMoments).not.toContain('scored')
  })
})

describe('경계 — 하프타임·경기 종료를 건너뛰지 않는다', () => {
  /** 큐에 든 상태를 특정 분에 심는다. */
  function seedPending(minute: number) {
    store().startMatch(home, away, 42)
    store().kickoff()
    const engine = structuredClone(store().engine!)
    engine.minute = minute
    useMatchStore.setState({
      engine, phase: 'playing', firedMoments: [],
      pendingMoment: {
        moment: { kind: 'scored', minute, title: '득점 직후' },
        score: [engine.score[0], engine.score[1]],
      },
    })
  }

  it('하프타임 직전에 감지된 제안은 45\'에 승격하지 않고 버려진다', () => {
    seedPending(44)
    store().advanceMinute()
    expect(store().phase).toBe('halftime')
    expect(store().momentPrompt).toBeNull()
    expect(store().pendingMoment).toBeNull()
  })

  it('종료 직전에 감지된 제안도 버려진다 — 띄울 화면이 없다', () => {
    seedPending(89)
    store().advanceMinute()
    expect(store().phase).toBe('fulltime')
    expect(store().momentPrompt).toBeNull()
    expect(store().pendingMoment).toBeNull()
  })

  it('개입으로 재개할 때도 큐를 비운다 — 개입은 방금 주어졌다', () => {
    seedPending(30)
    useMatchStore.setState({ phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
    store().confirmTactics()
    expect(store().pendingMoment).toBeNull()
  })
})
