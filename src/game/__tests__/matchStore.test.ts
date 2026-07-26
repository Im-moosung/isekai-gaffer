import { describe, it, expect, beforeEach } from 'vitest'
import {
  useMatchStore, TEAM_TALK_TABLE, scoreSituation, SHOUT_TABLE, SHOUT_COOLDOWN,
  teamExpectation, recommendedTone, EXPECTATION_ADJUST, computeDeviation,
  interventionLevel, nextBreakMinute, touchlineNotice,
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
    store().shout('urge')
    expect(store().phase).toBe('playing') // 정지 없음
    expect(store().lastShoutMinute).toBe(m)
    const delta = SHOUT_TABLE[situation].urge.morale
    for (const id of Object.keys(before)) {
      expect(store().engine!.home.moraleByPlayer[id]).toBe(Math.max(0, Math.min(100, before[id] + delta)))
    }
    const log = store().decisionLog
    expect(log[log.length - 1].summary).toBe(`${m}' 외침: 독려`)
  })

  it('10분 쿨다운: 외침 직후 재외침은 throw, 쿨다운 경과 후 허용', () => {
    playTo(20)
    store().shout('calm')
    const first = store().lastShoutMinute!
    expect(SHOUT_COOLDOWN).toBe(10)
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

describe('감독 타임(자유 정지)은 지시 부스트를 주지 않는다', () => {
  // pauseByUser에 횟수 제한이 없어, 확정마다 부스트를 주면 8분 주기로
  // 정지·확정만 반복해 부스트를 상시 유지하는 공짜 이득이 생긴다.
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

  /** 감독 타임에 들어간 상태를 만든다(터치라인 등급). */
  function toManagerTime() {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    store().pauseByUser()
  }

  /** 라인업 밖 벤치 선수 1명(결정론 — squad 순서). */
  const benchId = () => {
    const home = store().engine!.home
    return home.team.squad.find(p => !home.tactics.lineup.some(l => l.playerId === p.id))!.id
  }

  it('등급 판정: 킥오프 전·하이드레이션·하프타임은 full, 감독 타임·상황 개입은 touchline', () => {
    expect(interventionLevel('pre', null)).toBe('full')
    expect(interventionLevel('paused-break', { kind: 'hydration1' })).toBe('full')
    expect(interventionLevel('paused-break', { kind: 'hydration2' })).toBe('full')
    expect(interventionLevel('halftime', { kind: 'halftime' })).toBe('full')
    expect(interventionLevel('paused-user', { kind: 'user' })).toBe('touchline')
    expect(interventionLevel('playing', null)).toBe('none')
    expect(interventionLevel('fulltime', null)).toBe('none')
  })

  it('감독 타임에서 instructions 명령은 거부된다', () => {
    toManagerTime()
    const before = store().engine!.home.tactics.instructions.pressing
    expect(() => store().submitCommand('home', { type: 'instructions', instructions: INS }))
      .toThrow('교체와 외침만')
    expect(store().engine!.home.tactics.instructions.pressing).toBe(before)
  })

  it('감독 타임에서 formation 명령은 거부된다(확장 필드 포함)', () => {
    toManagerTime()
    const t = store().engine!.home.tactics
    expect(() => store().submitCommand('home', { type: 'formation', tactics: { ...t, formation: '5-4-1' } }))
      .toThrow()
    expect(() => store().submitCommand('home', { type: 'formation', tactics: { ...t, mentality: 'very-attacking' } }))
      .toThrow()
    expect(store().engine!.home.tactics.formation).toBe(t.formation)
  })

  it('감독 타임에서도 교체(sub)는 허용된다 — 감독이 무력해지면 안 된다', () => {
    toManagerTime()
    const out = store().engine!.home.tactics.lineup[10].playerId
    store().submitCommand('home', { type: 'sub', out, in: benchId() })
    expect(store().engine!.home.subsUsed).toBe(1)
  })

  it('하이드레이션·하프타임에서는 세 명령 모두 허용된다', () => {
    store().startMatch(a, b, 42)
    store().kickoff()
    store().advanceMinute()
    pauseAtBreak()
    store().submitCommand('home', { type: 'instructions', instructions: INS })
    expect(store().engine!.home.tactics.instructions.pressing).toBe(88)
    const t = store().engine!.home.tactics
    store().submitCommand('home', { type: 'formation', tactics: { ...t, formation: '5-4-1' } })
    expect(store().engine!.home.tactics.formation).toBe('5-4-1')
    const out = store().engine!.home.tactics.lineup[10].playerId
    store().submitCommand('home', { type: 'sub', out, in: benchId() })
    expect(store().engine!.home.subsUsed).toBe(1)
  })

  it('다음 브레이크 분: 지난 시점은 건너뛰고, 남은 게 없으면 null', () => {
    const sched = { firstHydration: 22, secondHydration: 67 }
    expect(nextBreakMinute(10, sched)).toBe(22)
    expect(nextBreakMinute(30, sched)).toBe(45)
    expect(nextBreakMinute(50, sched)).toBe(67)
    expect(nextBreakMinute(70, sched)).toBeNull()
  })

  it('터치라인 안내에 다음 브레이크 분이 들어가고, 없으면 그 사실을 알린다', () => {
    const sched = { firstHydration: 22, secondHydration: 67 }
    expect(touchlineNotice(50, sched)).toContain('다음 브레이크(67분)')
    expect(touchlineNotice(50, sched)).toContain('교체와 외침만')
    expect(touchlineNotice(80, sched)).toContain('남은 브레이크가 없습니다')
  })
})
