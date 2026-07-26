// F5-1: 선수 개인 경기 스탯(이벤트 파생분).
// 회귀의 핵심은 집계 수치가 아니라 **`save` 이벤트의 의미**다 — playerId가 "막은 GK"라는
// 사실을 반대로 읽어 생긴 버그 전례가 있어(coach.ts recentOppOnTarget) 명시적으로 고정한다.
import { describe, it, expect } from 'vitest'
import { playerMatchStats, hasPlayerMatchStats } from '../playerStats'
import type { MatchEvent } from '../../engine/types'

const HOME = 'kor'
const AWAY = 'cze'

/** 이벤트 한 줄 헬퍼 — minute는 집계에 무관하므로 순번으로만 쓴다. */
function ev(minute: number, type: MatchEvent['type'], teamId: string, extra: Partial<MatchEvent> = {}): MatchEvent {
  return { minute, type, teamId, ...extra }
}

describe('playerMatchStats — 이벤트 조합 집계', () => {
  const events: MatchEvent[] = [
    ev(1, 'kickoff', HOME),
    ev(12, 'miss', HOME, { playerId: 'son', xg: 0.1 }),
    ev(23, 'goal', HOME, { playerId: 'son', assistId: 'hwang', xg: 0.3 }),
    ev(31, 'foul', AWAY, { playerId: 'opp1' }),
    ev(31, 'yellow', AWAY, { playerId: 'opp1' }),
    ev(40, 'save', AWAY, { playerId: 'oppGk', xg: 0.2 }), // 체코 GK가 한국 슛을 막았다
    ev(55, 'corner', HOME),
    ev(66, 'foul', HOME, { playerId: 'son' }),
    ev(70, 'goal', HOME, { playerId: 'hwang', assistId: 'son' }),
    ev(80, 'red', HOME, { playerId: 'kim' }),
  ]

  it('슛·골·파울을 선수별로 집계한다', () => {
    const son = playerMatchStats(events, 'son')
    expect(son.goals).toBe(1)
    expect(son.shots).toBe(2) // miss 1 + goal 1
    expect(son.shotsOnTarget).toBe(1) // 골만 확실한 유효슛
    expect(son.fouls).toBe(1)
    expect(son.yellows).toBe(0)
    expect(son.reds).toBe(0)
    expect(son.saves).toBe(0)
  })

  it('어시스트는 assistId 기준이며 득점과 같은 선수에 이중 계상되지 않는다', () => {
    const son = playerMatchStats(events, 'son')
    expect(son.assists).toBe(1) // 70분 황의 골 어시스트
    const hwang = playerMatchStats(events, 'hwang')
    expect(hwang.goals).toBe(1)
    expect(hwang.assists).toBe(1) // 23분 손의 골 어시스트
    expect(hwang.shots).toBe(1) // 어시스트는 슛으로 세지 않는다
  })

  it('경고·퇴장을 센다', () => {
    expect(playerMatchStats(events, 'opp1').yellows).toBe(1)
    expect(playerMatchStats(events, 'opp1').fouls).toBe(1)
    expect(playerMatchStats(events, 'kim').reds).toBe(1)
  })

  it('기록 없는 선수는 전부 0', () => {
    const none = playerMatchStats(events, 'nobody')
    expect(none).toEqual({
      shots: 0, shotsOnTarget: 0, goals: 0, assists: 0, fouls: 0, yellows: 0, reds: 0, saves: 0,
    })
    expect(hasPlayerMatchStats(none)).toBe(false)
  })

  it('★ save의 playerId는 "막은 GK"다 — 슈터의 슛으로 세지 않는다', () => {
    // 40분 save는 체코 GK(oppGk)의 선방이다.
    const gk = playerMatchStats(events, 'oppGk')
    expect(gk.saves).toBe(1)
    expect(gk.shots).toBe(0) // GK가 슛한 것이 아니다
    expect(gk.shotsOnTarget).toBe(0)
    // 그리고 그 슛을 쏜 선수는 이벤트에 남지 않으므로 어떤 한국 선수의 슛도 늘지 않는다.
    const totalHomeShots = ['son', 'hwang', 'kim'].reduce((n, id) => n + playerMatchStats(events, id).shots, 0)
    expect(totalHomeShots).toBe(3) // miss 1 + goal 2 — 선방당한 1개는 집계 불가(하한선)
  })

  it("현재 미사용인 'shot' 타입은 슛으로만 세고 유효슛에는 넣지 않는다", () => {
    const s = playerMatchStats([ev(5, 'shot', HOME, { playerId: 'son' })], 'son')
    expect(s.shots).toBe(1)
    expect(s.shotsOnTarget).toBe(0)
  })

  it('hasPlayerMatchStats — 선방만 있어도 표시 대상이다', () => {
    const gkOnly = playerMatchStats([ev(9, 'save', AWAY, { playerId: 'gk' })], 'gk')
    expect(hasPlayerMatchStats(gkOnly)).toBe(true)
  })

  it('빈 이벤트 배열에도 안전하다', () => {
    expect(playerMatchStats([], 'son').shots).toBe(0)
  })
})
