import { describe, it, expect, beforeEach } from 'vitest'
import {
  useMatchStore, TEAM_TALK_TABLE, scoreSituation, SHOUT_TABLE, SHOUT_COOLDOWN, INTERVENTION_COOLDOWN, shoutState,
  teamExpectation, recommendedTone, EXPECTATION_ADJUST, computeDeviation,
  interventionLevel, nextBreakMinute, touchlineNotice, touchlineOrderError,
  touchlineTacticsError, tacticsDiff, freeInterventionState, MAX_FREE_INTERVENTIONS,
  MOMENT_PROMPT_TTL,
} from '../matchStore'
import { makeTestTeam, pickBestXI } from '../../engine/fixtures/testTeams'
import { loadTeam } from '../../data/loader'
import type { TacticState } from '../../engine/types'

const a = makeTestTeam('a', 78), b = makeTestTeam('b', 78)
const store = () => useMatchStore.getState()

beforeEach(() => store().reset())

/** 전술 변경은 '전원 소집' 등급(하이드레이션·하프타임·킥오프 전)에서만 가능하다.
 *  감독 타임(paused-user)은 교체·열람만 되는 터치라인 등급이라, 지시/포메이션을
 *  검증하는 테스트는 하이드레이션 브레이크 정지를 써야 한다. */
function pauseAtBreak() {
  useMatchStore.setState({ phase: 'paused-break', pauseReason: { kind: 'hydration1' } })
}

/** 킥오프 후 하프타임까지 재생 — 도중 하이드레이션 브레이크는 confirmTactics로 재개.
 *  경기가 시작 안 됐으면 기본 매치(a,b,42)로 시작한다. */
function toHalftime() {
  if (!store().engine) store().startMatch(a, b, 42)
  store().kickoff()
  let guard = 0
  while (store().phase !== 'halftime' && guard++ < 200) {
    if (store().phase === 'playing') store().advanceMinute()
    else store().confirmTactics()
  }
}

/** 브레이크·순간 무시하며 풀타임까지 재생. */
function toFulltime() {
  if (!store().engine) store().startMatch(a, b, 42)
  store().kickoff()
  let guard = 0
  while (store().phase !== 'fulltime' && guard++ < 500) {
    if (store().momentPrompt) store().dismissMoment()
    if (store().phase === 'playing') store().advanceMinute()
    else store().confirmTactics()
  }
}

describe('재생 세션 상태 머신', () => {
  it('startMatch → pre 준비, engine·schedule 생성', () => {
    store().startMatch(a, b, 42)
    expect(store().engine).not.toBeNull()
    expect(store().phase).toBe('pre')
    expect(store().schedule).not.toBeNull()
  })
  it('kickoff → playing', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(store().phase).toBe('playing')
  })
  it('advanceMinute은 1분씩 전진(엔진 스텝)', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    expect(store().engine!.minute).toBe(1)
    store().advanceMinute()
    expect(store().engine!.minute).toBe(2)
  })
  it('정지 중 advanceMinute은 no-op(재개는 confirmTactics로만)', () => {
    store().startMatch(a, b, 42)
    // pre에서 advanceMinute은 진행하지 않는다
    store().advanceMinute()
    expect(store().engine!.minute).toBe(0)
  })
  it('advanceMinute이 22±2 하이드레이션 창에서 자동 paused-break', () => {
    store().startMatch(a, b, 42)
    const sched = store().schedule!
    expect(sched.firstHydration).toBeGreaterThanOrEqual(20)
    expect(sched.firstHydration).toBeLessThanOrEqual(24)
    store().kickoff()
    let guard = 0
    while (store().phase === 'playing' && store().engine!.minute < sched.firstHydration && guard++ < 60) store().advanceMinute()
    expect(store().engine!.minute).toBe(sched.firstHydration)
    expect(store().phase).toBe('paused-break')
    expect(store().pauseReason).toEqual({ kind: 'hydration1' })
  })
  it('두 번째 하이드레이션(67±2)에서도 자동 정지', () => {
    store().startMatch(a, b, 42)
    const sched = store().schedule!
    expect(sched.secondHydration).toBeGreaterThanOrEqual(65)
    expect(sched.secondHydration).toBeLessThanOrEqual(69)
    store().kickoff()
    let guard = 0
    while (store().engine!.minute < sched.secondHydration && guard++ < 200) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    expect(store().engine!.minute).toBe(sched.secondHydration)
    expect(store().phase).toBe('paused-break')
    expect(store().pauseReason).toEqual({ kind: 'hydration2' })
  })
  it('45분 도달 시 halftime 자동 정지', () => {
    toHalftime()
    expect(store().phase).toBe('halftime')
    expect(store().engine!.minute).toBe(45)
    expect(store().pauseReason).toEqual({ kind: 'halftime' })
  })
  it('confirmTactics가 정지를 해제하고 boostUntil을 minute+8로 설정', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    let guard = 0
    while (store().phase === 'playing' && guard++ < 60) store().advanceMinute() // 첫 브레이크에서 정지
    expect(store().phase).toBe('paused-break')
    const m = store().engine!.minute
    store().confirmTactics()
    expect(store().phase).toBe('playing')
    expect(store().boostUntil).toBe(m + 8)
  })
  it('정지가 아닐 때 confirmTactics는 throw', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(() => store().confirmTactics()).toThrow()
  })
  it('pauseByUser는 playing에서만 paused-user로', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().pauseByUser()
    expect(store().phase).toBe('paused-user')
    expect(store().pauseReason).toEqual({ kind: 'user' })
  })
  it('풀타임 도달 → fulltime, minute 90', () => {
    toFulltime()
    expect(store().phase).toBe('fulltime')
    expect(store().engine!.minute).toBe(90)
  })
  it('halftime에 submitCommand(지시 변경)가 엔진에 반영된다', () => {
    toHalftime()
    const before = store().engine!.home.tactics.instructions.pressing
    store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(90)
    expect(before).not.toBe(90)
  })
  it('하이드레이션 브레이크에서 submitCommand 허용', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 77, tempo: 50, attackFocus: 'balanced' } })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(77)
  })
  it('playing 중 submitCommand는 throw', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(() => store().submitCommand('home', { type: 'instructions', instructions: { lineHeight: 50, pressing: 90, tempo: 50, attackFocus: 'balanced' } })).toThrow()
  })
  it('DecisionPrompt·카운트다운 필드가 없다(시간 정지 구조)', () => {
    const s = store() as unknown as Record<string, unknown>
    expect('pendingDecision' in s).toBe(false)
    expect('displayMinute' in s).toBe(false)
    expect('playTo' in s).toBe(false)
    expect('tickDisplay' in s).toBe(false)
  })
})

describe('동적 순간(momentPrompt)', () => {
  it('acceptMoment는 제안이 없으면 throw', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    expect(() => store().acceptMoment()).toThrow()
  })
  it('모든 유형이 이미 발동됐으면 재생 내내 momentPrompt가 뜨지 않는다(유형당 1회)', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    useMatchStore.setState({ firedMoments: ['conceded', 'scored', 'momentum-lost', 'clutch', 'fatigue'] })
    let guard = 0
    while (store().phase !== 'fulltime' && guard++ < 500) {
      expect(store().momentPrompt).toBeNull()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
  })
  it('발동된 순간 유형에 중복이 없다(경기 전체)', () => {
    toFulltime()
    const fired = store().firedMoments
    expect(new Set(fired).size).toBe(fired.length)
  })
  it('acceptMoment → paused-moment, dismissMoment는 재생 유지', () => {
    // 순간이 실제로 떠오르는 지점까지 재생
    store().startMatch(a, b, 3)
    store().kickoff()
    let guard = 0
    while (!store().momentPrompt && store().phase !== 'fulltime' && guard++ < 500) {
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    if (store().momentPrompt) {
      store().acceptMoment()
      expect(store().phase).toBe('paused-moment')
      expect(store().pauseReason?.kind).toBe('moment')
    }
  })
})

describe('startMatch opts 확장', () => {
  it('homeTactics를 홈 진영 전술에 반영한다', () => {
    const t = pickBestXI(a)
    t.formation = '4-4-2'
    store().startMatch(a, b, 42, { homeTactics: t })
    expect(store().engine!.home.tactics.formation).toBe('4-4-2')
  })
  it('staminaOverride는 지정 선수만 홈 시작 스태미나를 덮어쓴다', () => {
    const id = a.squad[0].id
    store().startMatch(a, b, 42, { staminaOverride: { [id]: 55, ghost: 12 } })
    expect(store().engine!.home.staminaByPlayer[id]).toBe(55)
    expect(store().engine!.home.staminaByPlayer[a.squad[1].id]).toBe(100)
    expect(store().engine!.home.staminaByPlayer['ghost']).toBeUndefined()
  })
  // 엔진/스토어 기능 계약이므로 유지한다. 단 App은 더 이상 이 옵션을 넘기지 않는다
  // (F1 B안 · 2026-07-26 — 조별 경기도 전반부터 완전 시뮬).
  // 아래 팀토크 테스트들도 "하프타임에 지고 있는 상태"를 만들려고 이 옵션을 도구로 쓸 뿐이다.
  it('firstHalfScript 전달 시 전반은 시뮬 대신 스크립트 스코어를 재현한다', () => {
    const events = [{ minute: 30, type: 'goal' as const, teamId: a.id }]
    store().startMatch(a, b, 42, { firstHalfScript: { events, score: [1, 0] } })
    toHalftime()
    expect(store().engine!.score).toEqual([1, 0])
  })
})

describe('applyTeamTalk (결정론 사기 보정)', () => {
  it('보정 테이블: 지는 중 격노 +8 / 이기는 중 격노 -4 / 비기는 중 격려 +5', () => {
    expect(TEAM_TALK_TABLE.losing.rage).toBe(8)
    expect(TEAM_TALK_TABLE.winning.rage).toBe(-4)
    expect(TEAM_TALK_TABLE.drawing.encourage).toBe(5)
  })
  it('scoreSituation은 팀 관점으로 판정한다', () => {
    expect(scoreSituation([0, 1], 'home')).toBe('losing')
    expect(scoreSituation([0, 1], 'away')).toBe('winning')
    expect(scoreSituation([2, 2], 'home')).toBe('drawing')
  })
  it('halftime이 아니면 throw', () => {
    store().startMatch(a, b, 42)
    expect(() => store().applyTeamTalk('home', 'rage')).toThrow()
  })
  it('지는 중 격노 → 홈 전원 사기 +8 (0~100 클램프)', () => {
    store().startMatch(a, b, 42, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    toHalftime()
    expect(store().phase).toBe('halftime')
    const before = { ...store().engine!.home.moraleByPlayer }
    store().applyTeamTalk('home', 'rage')
    for (const id of Object.keys(before)) {
      expect(store().engine!.home.moraleByPlayer[id]).toBe(Math.min(100, before[id] + 8))
    }
  })
  it('팀토크는 경기당 1회만 가능(두 번째 호출 throw)', () => {
    toHalftime()
    store().applyTeamTalk('home', 'calm')
    expect(store().talked).toBe(true)
    expect(() => store().applyTeamTalk('home', 'trust')).toThrow()
  })
  it('결과 반환: delta·repeated·선수 반응(2~3명, 결정론) 포함', () => {
    store().startMatch(a, b, 42, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    toHalftime()
    const res = store().applyTeamTalk('home', 'rage') // 지는 중 격노 +8
    expect(res.delta).toBe(8)
    expect(res.repeated).toBe(false)
    expect(res.reactions.length).toBeGreaterThanOrEqual(2)
    expect(res.reactions.length).toBeLessThanOrEqual(3)
    // 강한 긍정(+8) → 앞선 선수들 🔥
    expect(res.reactions[0].icon).toBe('🔥')
    // 결정론: 같은 시드·같은 톤이면 동일 반응
    store().reset()
    store().startMatch(a, b, 42, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    toHalftime()
    const res2 = store().applyTeamTalk('home', 'rage')
    expect(res2.reactions).toEqual(res.reactions)
  })
  it('반복 감쇠: repeated면 delta 반감', () => {
    store().startMatch(a, b, 42, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    toHalftime()
    const res = store().applyTeamTalk('home', 'rage', { repeated: true }) // 8 → 4
    expect(res.delta).toBe(4)
    expect(res.repeated).toBe(true)
  })
  it('기대치 보정: 페이버릿×지는중이면 격노가 강화(+11)', () => {
    store().startMatch(a, b, 42, { firstHalfScript: { events: [{ minute: 20, type: 'goal', teamId: b.id }], score: [0, 1] } })
    toHalftime()
    const res = store().applyTeamTalk('home', 'rage', { expectation: 'favorite' }) // 8 + 3
    expect(res.delta).toBe(11)
  })
})

describe('기대치·코치 추천(결정론)', () => {
  it('teamExpectation: 랭킹 차 ≥15 언더독/페이버릿, 그 사이 even', () => {
    expect(teamExpectation(25, 5)).toBe('underdog')  // 우리가 20 낮음(약체)
    expect(teamExpectation(25, 60)).toBe('favorite') // 우리가 35 높음(강팀)
    expect(teamExpectation(25, 30)).toBe('even')
    expect(teamExpectation(25, 10)).toBe('underdog') // 정확히 15
  })
  it('even 보정은 전부 0(기존 동작 불변)', () => {
    for (const sit of ['losing', 'drawing', 'winning'] as const) {
      for (const tone of ['rage', 'encourage', 'calm', 'trust'] as const) {
        expect(EXPECTATION_ADJUST.even[sit][tone]).toBe(0)
      }
    }
  })
  it('추천 톤이 기대치에 따라 바뀐다', () => {
    // 지는 중: even→격노, 언더독→침착, 페이버릿→격노
    expect(recommendedTone('losing', 'even')).toBe('rage')
    expect(recommendedTone('losing', 'underdog')).toBe('calm')
    expect(recommendedTone('losing', 'favorite')).toBe('rage')
    // 비기는 중: even→격려, 페이버릿→격노
    expect(recommendedTone('drawing', 'even')).toBe('encourage')
    expect(recommendedTone('drawing', 'favorite')).toBe('rage')
    // 이기는 중: 침착 계열 최대
    expect(recommendedTone('winning', 'even')).toBe('calm')
    expect(recommendedTone('winning', 'underdog')).toBe('calm')
  })
})

describe('터치라인 외침 (shout)', () => {
  /** kickoff 후 지정 분까지 재생(브레이크·순간 무시). */
  function playTo(minute: number) {
    store().startMatch(a, b, 42)
    store().kickoff()
    let guard = 0
    while (store().engine!.minute < minute && guard++ < 300) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
  }

  it('상황별 부호: 이기는데 [더 뛰어]=사기 저하·체력 소모 / 지는데 [독려]=사기 상승 / 이기는데 [침착]=사기 상승', () => {
    expect(SHOUT_TABLE.winning.work.morale).toBeLessThan(0)
    expect(SHOUT_TABLE.winning.work.stamina).toBeLessThan(0)
    expect(SHOUT_TABLE.losing.urge.morale).toBeGreaterThan(0)
    expect(SHOUT_TABLE.losing.praise.morale).toBeLessThan(0) // 지는데 칭찬=공허(역효과)
    expect(SHOUT_TABLE.winning.calm.morale).toBeGreaterThan(0)
  })

  it('재생 중이 아니면 throw', () => {
    store().startMatch(a, b, 42)
    expect(() => store().shout('urge')).toThrow()
  })

  it('playing 중 외침은 정지 없이 홈 사기를 즉시 보정하고 lastShoutMinute·로그 기록', () => {
    playTo(30)
    expect(store().phase).toBe('playing')
    const before = { ...store().engine!.home.moraleByPlayer }
    const situation = scoreSituation(store().engine!.score, 'home')
    const m = store().engine!.minute
    const res = store().shout('urge')
    expect(store().phase).toBe('playing') // 정지 없음
    expect(store().lastShoutMinute).toBe(m)
    // 외침은 **자유 개입이 아니다** — 개입 시계도 잔량도 건드리지 않는다(2026-08-01 분리).
    expect(store().lastInterventionMinute).toBeNull()
    expect(store().freeInterventionsUsed).toBe(0)
    const delta = SHOUT_TABLE[situation].urge.morale
    const picked = new Set(res.targets.map(t => t.playerId))
    for (const id of Object.keys(before)) {
      const now = store().engine!.home.moraleByPlayer[id]
      if (picked.has(id)) {
        // 뽑힌 선수는 일괄분 **위에** 추가분을 더 받는다(같은 부호).
        expect(now).toBeGreaterThan(before[id])
        expect(now - before[id]).toBeGreaterThanOrEqual(delta)
      } else {
        expect(now).toBe(Math.max(0, Math.min(100, before[id] + delta)))
      }
    }
    const log = store().decisionLog
    expect(log[log.length - 1].summary).toBe(`${m}' 외침: 독려`)
  })

  it('5분 쿨다운: 외침 직후 재외침은 throw, 쿨다운 경과 후 허용', () => {
    playTo(20)
    store().shout('calm')
    const first = store().lastShoutMinute!
    // 개입(10분)의 절반이다 — 외침은 자원이 아니라 습관이라는 판정의 수치적 실체.
    expect(SHOUT_COOLDOWN).toBe(5)
    // 쿨다운 내(경과<10) 재외침 throw
    let guard = 0
    while (store().engine!.minute - first < SHOUT_COOLDOWN - 1 && guard++ < 30) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    if (store().phase === 'playing') {
      expect(() => store().shout('urge')).toThrow()
    }
    // 쿨다운 경과까지 진행 후 재외침 허용
    guard = 0
    while (store().engine!.minute - first < SHOUT_COOLDOWN && guard++ < 30) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase === 'playing') store().advanceMinute()
      else store().confirmTactics()
    }
    if (store().phase === 'playing') {
      expect(() => store().shout('urge')).not.toThrow()
      expect(store().lastShoutMinute).toBe(store().engine!.minute)
    }
  })

  it('reset 시 lastShoutMinute 초기화', () => {
    playTo(15)
    store().shout('praise')
    expect(store().lastShoutMinute).not.toBeNull()
    store().reset()
    expect(store().lastShoutMinute).toBeNull()
  })

  // ── 외침 결과(사용자 지시 ②) — "누가 얼마나" + 매번 다르게, 그러나 재현 가능하게 ──
  //
  // 이 두 요구는 겉으로 충돌한다. 무작위여야 하는데 리플레이·리더보드는 재현을 요구한다.
  // 해법은 무작위성의 출처를 **시드 파생**으로 옮긴 것이고(matchStore의 SHOUT_SEED 주석),
  // 아래 두 테스트가 그 계약의 양쪽 끝을 못박는다.

  it('결정론 계약 — 같은 시드·같은 분·같은 외침이면 대상과 증감이 완전히 같다', () => {
    const run = () => {
      store().reset()
      store().startMatch(a, b, 777)
      store().kickoff()
      let guard = 0
      while (store().engine!.minute < 30 && guard++ < 80) {
        if (store().momentPrompt) store().dismissMoment()
        if (store().phase === 'playing') store().advanceMinute()
        else store().confirmTactics()
      }
      return store().phase === 'playing' ? store().shout('work') : null
    }
    const first = run()
    const second = run()
    expect(first).not.toBeNull()
    // Math.random을 쓰면 여기서 갈린다 — 이 단언이 결정론 계약의 자물쇠다.
    expect(second).toEqual(first)
    expect(first!.targets.length).toBeGreaterThanOrEqual(2)
    for (const t of first!.targets) {
      expect(t.name).not.toBe('') // 이름이 있어야 "누가"가 성립한다
      expect(t.morale).not.toBe(0) // 얼마나 — 0이면 보여 줄 이유가 없다
    }
  })

  it('그런데 유저에게는 매번 다르다 — 분이 바뀌면 대상 명단도 바뀐다', () => {
    store().startMatch(a, b, 20260801)
    store().kickoff()
    const seen: string[] = []
    let guard = 0
    // 쿨다운(5분)을 지키며 여러 번 외친다 — 실제 플레이와 같은 리듬이다.
    while (seen.length < 4 && guard++ < 120) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase !== 'playing') { store().confirmTactics(); continue }
      if (shoutState(store().lastShoutMinute, store().engine!.minute).canShout) {
        seen.push(store().shout('urge').targets.map(t => t.playerId).sort().join('|'))
      }
      store().advanceMinute()
    }
    expect(seen.length).toBeGreaterThanOrEqual(3)
    // 같은 명단만 반복되면 사용자가 지적한 바로 그 증상("매번 같은 선수들")이다.
    expect(new Set(seen).size).toBeGreaterThan(1)
  })

  it('대상 선정은 상태를 따른다 — [더 뛰어]는 다리가 남은 선수에게 간다', () => {
    store().startMatch(a, b, 4242)
    store().kickoff()
    store().advanceMinute()
    // 절반은 방전, 절반은 생생하게 만들어 놓고 외친다.
    const eng = structuredClone(store().engine!)
    const ids = eng.home.tactics.lineup.map(l => l.playerId)
    const fresh = new Set(ids.slice(0, 5))
    for (const id of ids) eng.home.staminaByPlayer[id] = fresh.has(id) ? 95 : 12
    useMatchStore.setState({ engine: eng })
    // 가중치는 확률이지 규칙이 아니다(하한 0.2) — 여러 분에 걸쳐 경향을 본다.
    let hit = 0, total = 0, guard = 0
    while (total < 6 && guard++ < 150) {
      if (store().momentPrompt) store().dismissMoment()
      if (store().phase !== 'playing') { store().confirmTactics(); continue }
      if (shoutState(store().lastShoutMinute, store().engine!.minute).canShout) {
        const r = store().shout('work')
        for (const t of r.targets) { total++; if (fresh.has(t.playerId)) hit++ }
      }
      store().advanceMinute()
    }
    // 무작위였다면 기대치는 5/11 ≈ 0.45다. 체력 가중이 걸려 있으면 그보다 확실히 높다.
    expect(hit / total).toBeGreaterThan(0.6)
  })
})

describe('decisionLog 수집 (기자회견 근거)', () => {
  it('startMatch 시 decisionLog는 빈 배열', () => {
    store().startMatch(a, b, 42)
    expect(store().decisionLog).toEqual([])
  })
  it('지시 변경 → 로그 1건, summary에 바뀐 축만 나열', () => {
    toHalftime()
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, pressing: 90 } })
    const log = store().decisionLog
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('instructions')
    expect(log[0].summary).toBe(`HT 지시 변경: 압박 ${cur.pressing}→90`)
    expect(log[0].summary).not.toContain('템포')
    expect(log[0].summary).not.toContain('라인')
  })
  it('무변경 지시 재적용 → 로그에 엔트리를 추가하지 않는다 (깨진 요약 방지)', () => {
    toHalftime()
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur } })
    expect(store().decisionLog).toHaveLength(0)
  })
  it('교체 → 로그에 IN/OUT 선수 이름(name.ko) 포함', () => {
    toHalftime()
    const lineupIds = store().engine!.home.tactics.lineup.map(l => l.playerId)
    const out = lineupIds[10]
    const inId = a.squad.find(p => !lineupIds.includes(p.id))!.id
    const outName = a.squad.find(p => p.id === out)!.name.ko
    const inName = a.squad.find(p => p.id === inId)!.name.ko
    store().submitCommand('home', { type: 'sub', out, in: inId })
    const log = store().decisionLog
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('sub')
    expect(log[0].summary).toBe(`HT 교체: ${inName} IN, ${outName} OUT`)
  })
  it('포메이션 변경 → HT 포메이션 로그', () => {
    toHalftime()
    const t = pickBestXI(a)
    t.formation = '3-5-2'
    store().submitCommand('home', { type: 'formation', tactics: t })
    const log = store().decisionLog
    expect(log[0].summary).toBe('HT 포메이션: 4-3-3→3-5-2')
  })
  it('팀토크 → 로그에 HT 팀토크 톤 라벨', () => {
    toHalftime()
    store().applyTeamTalk('home', 'encourage')
    const log = store().decisionLog
    expect(log).toHaveLength(1)
    expect(log[0].kind).toBe('teamtalk')
    expect(log[0].summary).toBe('HT 팀토크: 격려')
  })
  it('logShootoutSetup → shootout-setup 엔트리', () => {
    store().startMatch(a, b, 42)
    store().logShootoutSetup('PK: 키커 순서 확정')
    const log = store().decisionLog
    expect(log[0].kind).toBe('shootout-setup')
    expect(log[0].summary).toBe('PK: 키커 순서 확정')
  })
  it('여러 개입이 순서대로 누적되고, reset 시 초기화된다', () => {
    toHalftime()
    const cur = store().engine!.home.tactics.instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, tempo: 80 } })
    store().applyTeamTalk('home', 'rage')
    expect(store().decisionLog).toHaveLength(2)
    expect(store().decisionLog.map(d => d.kind)).toEqual(['instructions', 'teamtalk'])
    store().reset()
    expect(store().decisionLog).toEqual([])
  })
})

describe("'pre'에서 전술 개입이 가능하다", () => {
  it("phase 'pre'에서 submitCommand가 throw하지 않는다", () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 777)
    expect(store().phase).toBe('pre')
    const eng = store().engine!
    expect(() => store().submitCommand('home', {
      type: 'instructions',
      instructions: { ...eng.home.tactics.instructions, pressing: 75 },
    })).not.toThrow()
    expect(store().engine!.home.tactics.instructions.pressing).toBe(75)
  })

  it("'pre'의 결정 로그는 \"킥오프 전\"으로 표기된다", () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 777)
    const eng = store().engine!
    store().submitCommand('home', {
      type: 'instructions',
      instructions: { ...eng.home.tactics.instructions, lineHeight: 30 },
    })
    const log = store().decisionLog
    expect(log[0].summary).toContain('킥오프 전')
  })

  it("'pre'의 confirmTactics는 부스트를 설정하지 않고 재생도 시작하지 않는다", () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 777)
    store().confirmTactics()
    expect(store().boostUntil).toBe(0)
    // 'pre'의 확정은 재생을 시작하지 않는다 — 킥오프는 별도 버튼
    expect(store().phase).toBe('pre')
  })
})

describe('pickBestXI는 프로필 스타일로 지시를 시딩한다', () => {
  it('한국의 초기 지시가 50/50/50이 아니라 프로필 값이다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    expect(t.instructions.pressing).toBe(kor.profile.style.pressing)
    expect(t.instructions.lineHeight).toBe(kor.profile.style.lineHeight)
    expect(t.instructions.tempo).toBe(kor.profile.style.tempo)
  })
})

describe('computeDeviation', () => {
  it('멘탈리티·포메이션·4축 각각을 1로 센다', () => {
    const base = pickBestXI(loadTeam('kor'))
    const changed: TacticState = {
      ...base, mentality: 'attacking',
      instructions: { ...base.instructions, pressing: base.instructions.pressing + 30 },
    }
    expect(computeDeviation(base, changed)).toBe(2)
  })

  it('지시 축은 10 이상 차이날 때만 이탈로 센다(미세 조정 면제)', () => {
    const base = pickBestXI(loadTeam('kor'))
    const tweaked: TacticState = {
      ...base, instructions: { ...base.instructions, tempo: base.instructions.tempo + 5 },
    }
    expect(computeDeviation(base, tweaked)).toBe(0)
    const shifted: TacticState = {
      ...base, instructions: { ...base.instructions, tempo: base.instructions.tempo + 10 },
    }
    expect(computeDeviation(base, shifted)).toBe(1)
  })

  it('포메이션·attackFocus·attackPattern도 각각 1축이다', () => {
    const base = pickBestXI(loadTeam('kor'))
    expect(computeDeviation(base, { ...base, formation: '5-4-1' })).toBe(1)
    expect(computeDeviation(base, {
      ...base, instructions: { ...base.instructions, attackFocus: 'left' },
    })).toBe(1)
    expect(computeDeviation(base, { ...base, attackPattern: 'cross' })).toBe(1)
  })

  it('선택 필드 미지정은 balanced로 정규화해 비교한다(명시만 해도 이탈로 세지 않는다)', () => {
    const base = pickBestXI(loadTeam('kor'))
    expect(computeDeviation(base, { ...base, mentality: 'balanced', attackPattern: 'balanced' })).toBe(0)
  })

  it('구조 변경 + 지시 3축을 모두 갈아엎으면 이탈이 기자회견 임계(4)를 넘는다', () => {
    const base = pickBestXI(loadTeam('kor'))
    const wrecked: TacticState = {
      ...base, formation: '5-4-1', mentality: 'very-defensive',
      instructions: { lineHeight: 10, pressing: 90, tempo: 10, attackFocus: 'left' },
    }
    expect(computeDeviation(base, wrecked)).toBeGreaterThanOrEqual(4)
  })
})

describe('플랜 스냅샷과 이탈 계산', () => {
  it('kickoff이 현재 전술을 matchPlan으로 고정한다', () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    const eng = store().engine!
    store().submitCommand('home', {
      type: 'instructions', instructions: { ...eng.home.tactics.instructions, pressing: 40 },
    })
    // 킥오프 전 변경은 '플랜을 짜는 중'이므로 이탈이 아니다.
    expect(store().planDeviation).toBe(0)
    store().kickoff()
    expect(store().matchPlan!.instructions.pressing).toBe(40)
    expect(store().planDeviation).toBe(0)
  })

  it('킥오프 후 축을 바꾸면 planDeviation이 증가한다', () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    const eng = store().engine!
    store().submitCommand('home', {
      type: 'instructions', instructions: { ...eng.home.tactics.instructions, pressing: 90, lineHeight: 20 },
    })
    expect(store().planDeviation).toBe(2)
  })

  it('planDeviation은 누적 최대치라 되돌려도 줄지 않는다', () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    const orig = store().engine!.home.tactics.instructions
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    store().submitCommand('home', { type: 'instructions', instructions: { ...orig, pressing: 90 } })
    expect(store().planDeviation).toBe(1)
    store().submitCommand('home', { type: 'instructions', instructions: { ...orig } })
    expect(store().planDeviation).toBe(1)
  })

  it('상대(away)의 전술 변경은 홈 planDeviation에 잡히지 않는다', () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    const away = store().engine!.away.tactics
    store().submitCommand('away', {
      type: 'formation', tactics: { ...away, formation: '5-4-1', mentality: 'very-defensive' },
    })
    expect(store().planDeviation).toBe(0)
    expect(store().adaptUntil).toBe(0)
  })

  it('구조 변경(포메이션)만 적응 지연을 건다 — 지시 미세 조정은 걸지 않는다', () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    const eng = store().engine!
    store().submitCommand('home', {
      type: 'instructions', instructions: { ...eng.home.tactics.instructions, pressing: 90 },
    })
    expect(store().adaptUntil).toBe(0)
    const t = store().engine!.home.tactics
    store().submitCommand('home', { type: 'formation', tactics: { ...t, formation: '5-4-1' } })
    expect(store().adaptUntil).toBe(store().engine!.minute + 3)
  })

  it('멘탈리티 변경도 적응 지연을 건다', () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    const t = store().engine!.home.tactics
    store().submitCommand('home', { type: 'formation', tactics: { ...t, mentality: 'very-attacking' } })
    expect(store().adaptUntil).toBeGreaterThan(0)
  })

  it('reset·startMatch가 플랜 상태를 초기화한다', () => {
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 111)
    store().kickoff()
    expect(store().matchPlan).not.toBeNull()
    store().startMatch(loadTeam('kor'), loadTeam('cze'), 222)
    expect(store().matchPlan).toBeNull()
    expect(store().planDeviation).toBe(0)
    expect(store().adaptUntil).toBe(0)
  })
})

describe('자유 개입(감독 타임·순간 제안)은 지시 부스트를 주지 않는다', () => {
  // 2026-08-01 재판정. 예전 근거는 "pauseByUser에 횟수 제한이 없어 8분 주기로 정지·확정만
  // 반복하면 부스트가 상시 유지된다"였고, 5회+쿨다운이 생기면서 그 전제는 사라졌다.
  // 그래서 다시 재 봤더니(tools/touchline-balance · n=400 페어드) **전술을 하나도 바꾸지
  // 않고 5회를 소진만 하는 전략**이 상대 5팀 전부에서 +1.3~+2.3pp(SE 0.6~0.7)로 유의했다.
  // "판단 없이 정지 버튼만 다섯 번"이 공짜 승률이 되는 것이 정확히 지배 전략이라 거뒀다.
  // 부스트는 **자원을 소모하지 않는 개입**(하이드레이션·하프타임)에만 붙는다.
  it('감독 타임 확정은 boostUntil을 올리지 않는다', () => {
    const s = store()
    s.startMatch(a, b, 4242)
    s.kickoff()
    store().advanceMinute()
    store().pauseByUser()
    expect(store().pauseReason?.kind).toBe('user')
    store().confirmTactics()
    expect(store().boostUntil).toBe(0)
    expect(store().phase).toBe('playing')
  })

  it('하이드레이션 브레이크 확정은 boostUntil을 설정한다', () => {
    const s = store()
    s.startMatch(a, b, 4242)
    s.kickoff()
    const sched = store().schedule!
    while (store().phase === 'playing' && store().engine!.minute < sched.firstHydration) {
      store().advanceMinute()
    }
    expect(store().pauseReason?.kind).toBe('hydration1')
    const at = store().engine!.minute
    store().confirmTactics()
    expect(store().boostUntil).toBeGreaterThan(at)
  })
})


describe('개입 권한 2등급 — 전원 소집 vs 터치라인', () => {
  const INS = { lineHeight: 50, pressing: 88, tempo: 50, attackFocus: 'balanced' } as const

  /** 감독 타임에 들어간 상태를 만든다(터치라인 등급).
   *  ★ 2026-08-01: 감독 타임 진입 자체가 자유 개입 1회를 쓰고, 그 분에 **창**을 연다
   *  — 그 창 안의 지시는 추가 비용이 없다(touchlineWindow). */
  function toManagerTime() {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    store().pauseByUser()
  }

  /** 창 없이 터치라인 등급만 만든다 — 창·쿨다운 규칙 자체를 검증할 때 쓴다. */
  function toTouchlineWithoutWindow() {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    useMatchStore.setState({ phase: 'paused-user', pauseReason: { kind: 'user' } })
  }

  /** 라인업 밖 벤치 선수 1명(결정론 — squad 순서). */
  const benchId = () => {
    const home = store().engine!.home
    return home.team.squad.find(p => !home.tactics.lineup.some(l => l.playerId === p.id))!.id
  }
  const tac = () => store().engine!.home.tactics

  it('등급 판정: 킥오프 전·하이드레이션·하프타임은 full, 감독 타임·상황 개입은 touchline', () => {
    expect(interventionLevel('pre', null)).toBe('full')
    expect(interventionLevel('paused-break', { kind: 'hydration1' })).toBe('full')
    expect(interventionLevel('paused-break', { kind: 'hydration2' })).toBe('full')
    expect(interventionLevel('halftime', { kind: 'halftime' })).toBe('full')
    expect(interventionLevel('paused-user', { kind: 'user' })).toBe('touchline')
    expect(interventionLevel('playing', null)).toBe('none')
    expect(interventionLevel('fulltime', null)).toBe('none')
  })

  // ── 터치라인 확장 개방(2026-08-01) ───────────────────────────────
  // 열린 축: 지시 4축(라인·압박·템포 ±15, 공격방향 범주) · 멘탈리티(±1단계) ·
  //          그룹 적극성(라인당 ±1단계) · 공격 패턴 · 세트피스 3축 · GK 파워플레이(엔진 조건 유지)
  // 잠긴 축: 포메이션 · 페이즈 포메이션 · 자리 배치(lineup) — 전부 "대형"이다.

  it('감독 타임: 지시 3축이 모두 ±15까지 열린다(라인 포함)', () => {
    toManagerTime()
    const cur = tac().instructions
    store().submitCommand('home', {
      type: 'instructions',
      instructions: { ...cur, lineHeight: cur.lineHeight + 15, pressing: cur.pressing + 15, tempo: cur.tempo - 15 },
    })
    expect(tac().instructions.lineHeight).toBe(cur.lineHeight + 15)
    expect(tac().instructions.pressing).toBe(cur.pressing + 15)
    expect(tac().instructions.tempo).toBe(cur.tempo - 15)
  })

  it('감독 타임: 공격방향은 범주 축이라 폭 제한 없이 바뀐다', () => {
    toManagerTime()
    const cur = tac().instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, attackFocus: 'left' } })
    expect(tac().instructions.attackFocus).toBe('left')
  })

  it('감독 타임: ±15를 넘는 지시는 거부된다(속도 제한)', () => {
    toManagerTime()
    const cur = tac().instructions
    expect(() => store().submitCommand('home', {
      type: 'instructions', instructions: { ...cur, lineHeight: cur.lineHeight + 16 },
    })).toThrow('15보다 크게')
    expect(tac().instructions.lineHeight).toBe(cur.lineHeight)
  })

  it('감독 타임: 멘탈리티는 한 단계까지만 움직인다', () => {
    toManagerTime()
    const t = tac()
    store().submitCommand('home', { type: 'formation', tactics: { ...t, mentality: 'attacking' } })
    expect(tac().mentality).toBe('attacking')
    // 같은 창 안에서 한 단계 더 미는 것은 창 스냅샷(balanced) 기준이라 두 단계다 → 거부.
    expect(() => store().submitCommand('home', { type: 'formation', tactics: { ...tac(), mentality: 'very-attacking' } }))
      .toThrow('한 단계')
    expect(tac().mentality).toBe('attacking')
  })

  it('감독 타임: 그룹 적극성은 라인당 한 단계 — 자제에서 적극으로 한 번에 못 간다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    // 브레이크(전원 소집)에서 공격 라인을 '자제'로 내려 둔 상태를 만든다.
    pauseAtBreak()
    store().submitCommand('home', {
      type: 'formation',
      tactics: { ...tac(), groupIntensity: { attack: -1, midfield: 0, defense: 0 } },
    })
    store().confirmTactics()
    store().pauseByUser()
    // 자제(-1) → 적극(+1)은 두 단계라 거부, 기본(0)은 한 단계라 통과.
    expect(() => store().submitCommand('home', {
      type: 'formation', tactics: { ...tac(), groupIntensity: { attack: 1, midfield: 0, defense: 0 } },
    })).toThrow('한 단계')
    store().submitCommand('home', {
      type: 'formation', tactics: { ...tac(), groupIntensity: { attack: 0, midfield: 0, defense: 0 } },
    })
    expect(tac().groupIntensity!.attack).toBe(0)
  })

  it('감독 타임: 공격 패턴·세트피스는 범주 축이라 그대로 통과한다', () => {
    toManagerTime()
    store().submitCommand('home', { type: 'formation', tactics: { ...tac(), attackPattern: 'longshot' } })
    expect(tac().attackPattern).toBe('longshot')
    store().submitCommand('home', {
      type: 'formation',
      tactics: { ...tac(), setPiece: { route: 'near', boxLoad: 'heavy', marking: 'man' } },
    })
    expect(tac().setPiece).toEqual({ route: 'near', boxLoad: 'heavy', marking: 'man' })
  })

  it("감독 타임: GK 파워플레이는 등급 잠금이 풀리되 엔진 조건(85'+·지는 중)은 남는다", () => {
    toManagerTime()
    expect(() => store().submitCommand('home', { type: 'formation', tactics: { ...tac(), gkPowerplay: true } }))
      .toThrow("85'")
    // 85분·지는 중으로 옮기면 통과한다.
    const eng = structuredClone(store().engine!)
    eng.minute = 87
    eng.score = [0, 1]
    useMatchStore.setState({ engine: eng, touchlineWindow: null })
    store().submitCommand('home', { type: 'formation', tactics: { ...tac(), gkPowerplay: true } })
    expect(tac().gkPowerplay).toBe(true)
    // 끄는 것은 조건과 무관하게 허용한다(위험한 상태를 되돌리는 길까지 막지 않는다).
    const eng2 = structuredClone(store().engine!)
    eng2.score = [1, 0]
    useMatchStore.setState({ engine: eng2 })
    store().submitCommand('home', { type: 'formation', tactics: { ...tac(), gkPowerplay: false } })
    expect(tac().gkPowerplay).toBe(false)
  })

  it('감독 타임: 포메이션·페이즈 포메이션·자리 배치는 잠긴다(대형은 소리쳐 전달되지 않는다)', () => {
    toManagerTime()
    const t = tac()
    expect(() => store().submitCommand('home', { type: 'formation', tactics: { ...t, formation: '5-4-1' } }))
      .toThrow('포메이션 변경')
    expect(() => store().submitCommand('home', {
      type: 'formation', tactics: { ...t, phaseFormations: { attack: '3-5-2' } },
    })).toThrow('페이즈 포메이션')
    const swapped = t.lineup.map((l, i) => (i === 1 ? { ...l, playerId: t.lineup[2].playerId } : i === 2 ? { ...l, playerId: t.lineup[1].playerId } : l))
    expect(() => store().submitCommand('home', { type: 'formation', tactics: { ...t, lineup: swapped } }))
      .toThrow('자리 배치')
    expect(tac().formation).toBe(t.formation)
  })

  it('잠금 사유는 언제 풀리는지를 함께 말한다(다음 브레이크 분)', () => {
    toManagerTime()
    const next = nextBreakMinute(store().engine!.minute, store().schedule)!
    let msg = ''
    try { store().submitCommand('home', { type: 'formation', tactics: { ...tac(), formation: '5-4-1' } }) }
    catch (e) { msg = (e as Error).message }
    expect(msg).toContain(`다음 브레이크(${next}분)`)
  })

  // ── 창(window) — 같은 분의 여러 지시를 한 번의 개입으로 묶는다 ──────
  it('감독 타임 진입이 창을 연다 — 그 안의 추가 지시는 쿨다운을 다시 소모하지 않는다', () => {
    toManagerTime()
    const at = store().engine!.minute
    expect(store().touchlineWindow?.minute).toBe(at)
    expect(store().lastInterventionMinute).toBe(at)
    const cur = tac().instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, pressing: cur.pressing + 10 } })
    // 두 번째·세 번째 지시도 그대로 통과한다(같은 개입이므로).
    store().submitCommand('home', { type: 'formation', tactics: { ...tac(), attackPattern: 'cross' } })
    store().submitCommand('home', { type: 'formation', tactics: { ...tac(), mentality: 'attacking' } })
    expect(tac().attackPattern).toBe('cross')
    expect(tac().mentality).toBe('attacking')
    expect(store().lastInterventionMinute).toBe(at)
  })

  it('창 안에서 여러 번 눌러도 폭 제한은 창 스냅샷 기준이다(우회 차단)', () => {
    toManagerTime()
    const cur = tac().instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, pressing: cur.pressing + 15 } })
    // 현재값 기준이면 +30이 통과하지만, 창 스냅샷 기준이라 거부된다.
    expect(() => store().submitCommand('home', {
      type: 'instructions', instructions: { ...tac().instructions, pressing: cur.pressing + 30 },
    })).toThrow('15보다 크게')
    expect(tac().instructions.pressing).toBe(cur.pressing + 15)
  })

  it('창이 없으면 터치라인 지시가 쿨다운을 새로 소모한다(감독 타임과 같은 시계)', () => {
    toTouchlineWithoutWindow()
    const cur = tac().instructions
    store().submitCommand('home', { type: 'instructions', instructions: { ...cur, pressing: cur.pressing + 10 } })
    expect(store().lastInterventionMinute).toBe(store().engine!.minute)
    // 창을 지우고 같은 분에 새 지시를 시도하면 쿨다운에 걸린다.
    useMatchStore.setState({ touchlineWindow: null })
    expect(() => store().submitCommand('home', {
      type: 'instructions', instructions: { ...tac().instructions, tempo: tac().instructions.tempo + 5 },
    })).toThrow('쿨다운')
  })

  it('값이 그대로면 창도 쿨다운도 소모하지 않는다', () => {
    toTouchlineWithoutWindow()
    store().submitCommand('home', { type: 'instructions', instructions: { ...tac().instructions } })
    expect(store().lastInterventionMinute).toBeNull()
    expect(store().touchlineWindow).toBeNull()
  })

  // ★ 2026-08-01 계약 반전 — 외침은 개입 시계를 **건드리지 않는다**.
  //   예전에는 "외치면 터치라인 지시 쿨다운도 같이 돈다"였고, 그 전제(둘은 같은 행위다)가
  //   기각됐다. 지금 지켜야 할 것은 반대다: 외쳤다는 이유로 지시가 막히면 안 되고,
  //   그렇다고 외침이 창을 여는 것도 아니다(창은 개입의 산물이다).
  it('외침은 창을 열지도, 개입 시계를 돌리지도 않는다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    store().shout('urge')
    const at = store().engine!.minute
    expect(store().lastShoutMinute).toBe(at)
    expect(store().lastInterventionMinute).toBeNull()
    expect(store().touchlineWindow).toBeNull()
    // 같은 분에 터치라인 등급으로 들어가면(창 없음) 지시는 그대로 통과한다 —
    // 외침이 개입 자원을 소모하지 않았기 때문이다. 그리고 그 지시가 창을 연다.
    useMatchStore.setState({ phase: 'paused-user', pauseReason: { kind: 'user' } })
    const before = tac().instructions.pressing
    store().submitCommand('home', {
      type: 'instructions', instructions: { ...tac().instructions, pressing: before + 5 },
    })
    expect(tac().instructions.pressing).toBe(before + 5)
    expect(store().lastInterventionMinute).toBe(at)
  })

  it('터치라인 지시는 결정 로그를 남긴다(기자회견 근거) — 확장 축까지 한 줄로', () => {
    toManagerTime()
    const before = store().decisionLog.length
    store().submitCommand('home', { type: 'formation', tactics: { ...tac(), mentality: 'attacking', attackPattern: 'cross' } })
    const log = store().decisionLog
    expect(log.length).toBe(before + 1)
    expect(log[log.length - 1].summary).toContain('터치라인 지시')
    expect(log[log.length - 1].summary).toContain('멘탈리티')
    expect(log[log.length - 1].summary).toContain('공격 패턴')
  })

  it('킥오프 전 슬라이더 드래그(formation 명령)는 로그를 남기지 않는다(노이즈 방지)', () => {
    store().startMatch(a, b, 42)
    const t = tac()
    store().submitCommand('home', {
      type: 'formation',
      tactics: { ...t, instructions: { ...t.instructions, pressing: t.instructions.pressing + 3 } },
    })
    expect(store().decisionLog.length).toBe(0)
  })

  it('감독 타임에서도 교체(sub)는 허용된다 — 감독이 무력해지면 안 된다', () => {
    toManagerTime()
    const out = tac().lineup[10].playerId
    store().submitCommand('home', { type: 'sub', out, in: benchId() })
    expect(store().engine!.home.subsUsed).toBe(1)
  })

  it('하이드레이션·하프타임에서는 세 명령 모두 허용된다(폭 제한 없음)', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    store().submitCommand('home', { type: 'instructions', instructions: INS })
    expect(tac().instructions.pressing).toBe(88)
    const t = tac()
    store().submitCommand('home', { type: 'formation', tactics: { ...t, formation: '5-4-1', mentality: 'very-attacking' } })
    expect(tac().formation).toBe('5-4-1')
    expect(tac().mentality).toBe('very-attacking')
    const out = tac().lineup[10].playerId
    store().submitCommand('home', { type: 'sub', out, in: benchId() })
    expect(store().engine!.home.subsUsed).toBe(1)
  })

  // ── 순수 판정 함수 ────────────────────────────────────────────────
  it('touchlineOrderError: 수치 축 폭만 본다(공격방향은 통과)', () => {
    const base = { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' as const }
    expect(touchlineOrderError(base, { ...base, lineHeight: 65, pressing: 65, tempo: 35 })).toBeNull()
    expect(touchlineOrderError(base, { ...base, pressing: 66 })).toContain('15보다 크게')
    expect(touchlineOrderError(base, { ...base, lineHeight: 66 })).toContain('15보다 크게')
    expect(touchlineOrderError(base, { ...base, attackFocus: 'right' })).toBeNull()
  })

  it('touchlineTacticsError: 대형은 막고 태도 축은 한 단계까지 통과시킨다', () => {
    store().startMatch(a, b, 42)
    const cur = store().engine!.home.tactics
    const ctx = { minute: 30, losing: false, nextBreak: 67 }
    expect(touchlineTacticsError(cur, cur, ctx)).toBeNull()
    expect(touchlineTacticsError(cur, { ...cur, formation: '5-4-1' }, ctx)).toContain('포메이션 변경')
    expect(touchlineTacticsError(cur, { ...cur, phaseFormations: { attack: '4-4-2' } }, ctx)).toContain('페이즈 포메이션')
    expect(touchlineTacticsError(cur, { ...cur, mentality: 'attacking' }, ctx)).toBeNull()
    expect(touchlineTacticsError(cur, { ...cur, mentality: 'very-attacking' }, ctx)).toContain('한 단계')
    expect(touchlineTacticsError(cur, { ...cur, groupIntensity: { attack: 1, midfield: 0, defense: 0 } }, ctx)).toBeNull()
    expect(touchlineTacticsError(cur, { ...cur, attackPattern: 'through' }, ctx)).toBeNull()
    expect(touchlineTacticsError(cur, { ...cur, gkPowerplay: true }, ctx)).toContain("85'")
    expect(touchlineTacticsError(cur, { ...cur, gkPowerplay: true }, { minute: 87, losing: true, nextBreak: null })).toBeNull()
    // 잠금 사유에는 언제 풀리는지가 들어간다.
    expect(touchlineTacticsError(cur, { ...cur, formation: '5-4-1' }, ctx)).toContain('67분')
    expect(touchlineTacticsError(cur, { ...cur, formation: '5-4-1' }, { ...ctx, nextBreak: null })).toContain('남은 브레이크가 없어')
  })

  it('tacticsDiff: 확장 축까지 한국어 한 줄로 나열한다', () => {
    store().startMatch(a, b, 42)
    const cur = store().engine!.home.tactics
    const changed = tacticsDiff(cur, {
      ...cur,
      instructions: { ...cur.instructions, pressing: cur.instructions.pressing + 10 },
      mentality: 'attacking',
      groupIntensity: { attack: 1, midfield: 0, defense: 0 },
      attackPattern: 'cross',
      setPiece: { route: 'near' },
    })
    expect(changed.join(', ')).toContain('압박')
    expect(changed.join(', ')).toContain('멘탈리티 균형→공격적')
    expect(changed.join(', ')).toContain('공격 적극성 기본→적극')
    expect(changed.join(', ')).toContain('공격 패턴 균형→크로스')
    expect(changed.join(', ')).toContain('코너 루트 파→니어')
  })

  it('다음 브레이크 분: 지난 시점은 건너뛰고, 남은 게 없으면 null', () => {
    const sched = { firstHydration: 22, secondHydration: 67 }
    expect(nextBreakMinute(10, sched)).toBe(22)
    expect(nextBreakMinute(30, sched)).toBe(45)
    expect(nextBreakMinute(50, sched)).toBe(67)
    expect(nextBreakMinute(70, sched)).toBeNull()
  })

  it('터치라인 안내는 열린 것과 잠긴 것을 정확히 말한다', () => {
    const sched = { firstHydration: 22, secondHydration: 67 }
    const msg = touchlineNotice(50, sched)
    expect(msg).toContain('다음 브레이크(67분)')
    expect(msg).toContain('포메이션')
    expect(msg).toContain('라인·압박·템포')
    // "압박·템포만 가능"이라는 옛 계약 문구가 남아 있으면 화면이 거짓말을 한다.
    expect(msg).not.toContain('압박·템포 지시만')
    expect(touchlineNotice(80, sched)).toContain('남은 브레이크가 없습니다')
  })
})

describe('자유 개입 자원 — 5회 + 10분 쿨다운(외침과는 다른 시계)', () => {
  it('freeInterventionState: 잔량·쿨다운·사유를 한 번에 답한다', () => {
    const fresh = freeInterventionState(0, null, 10)
    expect(fresh.left).toBe(MAX_FREE_INTERVENTIONS)
    expect(fresh.cooldownLeft).toBe(0)
    expect(fresh.canPause).toBe(true)
    expect(fresh.blockedReason).toBeNull()

    const cooling = freeInterventionState(1, 25, 30)
    expect(cooling.cooldownLeft).toBe(INTERVENTION_COOLDOWN - 5)
    expect(cooling.canPause).toBe(false)
    expect(cooling.blockedReason).toContain('쿨다운')
    expect(cooling.blockedReason).toContain(String(INTERVENTION_COOLDOWN - 5))
    // 개입 시계는 외침 시계의 두 배다 — 둘이 같은 값이면 분리가 화면에서 안 보인다.
    expect(INTERVENTION_COOLDOWN).toBe(SHOUT_COOLDOWN * 2)

    const spent = freeInterventionState(MAX_FREE_INTERVENTIONS, null, 30)
    expect(spent.left).toBe(0)
    expect(spent.canPause).toBe(false)
    expect(spent.blockedReason).toContain('모두 썼습니다')
  })

  it('두 사유는 구별된다 — 소진이 쿨다운보다 우선한다(더 오래 막는 쪽)', () => {
    const both = freeInterventionState(MAX_FREE_INTERVENTIONS, 25, 30)
    expect(both.blockedReason).toBe(freeInterventionState(MAX_FREE_INTERVENTIONS, null, 30).blockedReason)
    expect(both.blockedReason).not.toBe(freeInterventionState(0, 25, 30).blockedReason)
    // 쿨다운은 기다리면 풀리고, 소진은 풀리지 않는다 — 문장이 그 차이를 말해야 한다.
    expect(freeInterventionState(0, 25, 30).blockedReason).toContain('뒤에')
    expect(both.blockedReason).toContain('브레이크')
  })

  it('pauseByUser가 횟수를 소모하고, 소진되면 store가 거절한다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    store().pauseByUser()
    expect(store().freeInterventionsUsed).toBe(1)
    store().confirmTactics()
    // 쿨다운 중에는 들어갈 수 없다.
    store().advanceMinute()
    store().pauseByUser()
    expect(store().phase).toBe('playing')
    expect(store().freeInterventionsUsed).toBe(1)
    // 소진 상태를 직접 만들어도 store가 최종 방어선이다.
    useMatchStore.setState({ freeInterventionsUsed: MAX_FREE_INTERVENTIONS, lastInterventionMinute: null })
    store().pauseByUser()
    expect(store().phase).toBe('playing')
  })

  it('브레이크·하프타임 정지는 자유 개입을 세지 않는다(규칙이 주는 것이다)', () => {
    store().startMatch(a, b, 4242)
    store().kickoff()
    let guard = 0
    while (store().phase === 'playing' && guard++ < 60) store().advanceMinute()
    expect(store().pauseReason?.kind).toBe('hydration1')
    expect(store().freeInterventionsUsed).toBe(0)
    store().confirmTactics()
    expect(store().freeInterventionsUsed).toBe(0)
  })

  it('acceptMoment도 자유 개입 1회를 쓴다 — [흘려보낸다]가 실제 선택이 되게', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    const engine = structuredClone(store().engine!)
    engine.minute = 20
    useMatchStore.setState({
      engine, phase: 'playing',
      momentPrompt: { kind: 'conceded', minute: 20, title: '실점 직후' },
      momentPromptScore: [0, 1],
    })
    store().acceptMoment()
    expect(store().phase).toBe('paused-moment')
    expect(store().freeInterventionsUsed).toBe(1)
    expect(store().lastInterventionMinute).toBe(20)
    // 진입이 창도 연다 — 그 안의 지시는 추가 비용이 없다.
    expect(store().touchlineWindow?.minute).toBe(20)
  })

  it('startMatch·reset이 자유 개입 자원과 창을 초기화한다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    store().pauseByUser()
    expect(store().freeInterventionsUsed).toBe(1)
    expect(store().touchlineWindow).not.toBeNull()
    store().startMatch(a, b, 43)
    expect(store().freeInterventionsUsed).toBe(0)
    expect(store().touchlineWindow).toBeNull()
    expect(store().lastShoutMinute).toBeNull()
    expect(store().lastInterventionMinute).toBeNull()
    store().reset()
    expect(store().freeInterventionsUsed).toBe(0)
    expect(store().touchlineWindow).toBeNull()
  })

  it('순간 제안 유효 기간은 노출 게이트 지연을 흡수한다(TTL ≥ 6)', () => {
    // MatchScreen이 배너에 revealed 노출 게이트를 걸어 배너가 최대 그 분의 dwell 하나만큼
    // 늦게 뜬다(골 안무 8.6s 중 reveal 6~7s). 반응할 창이 함께 밀리므로 1분을 되돌려 준다.
    expect(MOMENT_PROMPT_TTL).toBeGreaterThanOrEqual(6)
  })
})
