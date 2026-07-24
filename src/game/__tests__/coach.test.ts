import { describe, it, expect } from 'vitest'
import { buildCoachAdvice } from '../coach'
import { createMatch } from '../../engine/simulate'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import { safeguardFilter } from '../../ai/safeguard'
import type { MatchState } from '../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)

/** 기본 MatchState 픽스처(minute 0·빈 스탯). 개별 테스트가 필요한 필드만 덮어쓴다. */
function base(): MatchState {
  return createMatch(home, away, { seed: 1 })
}

/** 홈 라인업에서 idx번째 선발의 스태미나를 v로 설정. */
function setLineupStamina(m: MatchState, idx: number, v: number) {
  const id = m.home.tactics.lineup[idx].playerId
  m.home.staminaByPlayer[id] = v
  return home.squad.find(p => p.id === id)!.name.ko
}

describe('buildCoachAdvice — 멀티 코치 제안', () => {
  it('상대 슛 몰림 픽스처 → 수비 코치가 상대 유효슛·코너·최근 추이를 근거로 라인 하향 제안', () => {
    const m = base()
    m.minute = 60
    m.stats[1] = { ...m.stats[1], shotsOnTarget: 7, corners: 6 }
    m.stats[0] = { ...m.stats[0], shotsOnTarget: 1, corners: 1 }
    // 최근 15분(46~60) 상대(away=esp)의 유효슛 2개 = goal(teamId=상대) + save(teamId=우리 GK가 막음, kor).
    // ★ save는 수비측(막은 GK 팀) teamId로 기록되므로 "상대 유효슛" save는 우리팀(kor) teamId다.
    m.events = [
      { minute: 50, type: 'save', teamId: 'kor' }, // 우리 GK가 상대 슛을 막음 → 상대 유효슛
      { minute: 57, type: 'goal', teamId: 'esp' },  // 상대 득점 → 상대 유효슛
      { minute: 10, type: 'save', teamId: 'kor' },  // 창 밖 → 최근 카운트 제외
      { minute: 55, type: 'save', teamId: 'esp' },  // 상대 GK가 우리 슛을 막음 → 상대 위협 아님(카운트 제외)
    ]
    const advice = buildCoachAdvice(m, 'home')
    const def = advice.find(a => a.coach === '수비 코치')!
    expect(def).toBeTruthy()
    expect(def.rationale).toContain('유효슛 7')
    expect(def.rationale).toContain('코너 6')
    expect(def.rationale).toContain('최근 15분 상대 유효슛 2')
    // 압박이 몰릴 때 라인을 낮추는 방향(현재값보다 낮게).
    expect(def.apply.instructions!.lineHeight!).toBeLessThan(m.home.tactics.instructions.lineHeight)
    expect(def.apply.groupIntensity!.defense).toBe(-1)
    expect(def.apply.mentality).toBe('defensive')
    expect(def.proposal).toContain('자제로')
  })

  it('우리가 압도(우리 goal/miss·상대 GK save 다수, 우리 GK save 0) → 수비 코치 heavyPressure 미발동', () => {
    const m = base()
    m.minute = 60
    m.stats[0] = { ...m.stats[0], shotsOnTarget: 8, corners: 6 }
    m.stats[1] = { ...m.stats[1], shotsOnTarget: 1, corners: 1 }
    // 우리 공세: goal(kor)·miss(kor)·상대 GK save(teamId=esp) 다수. 상대 유효슛(goal esp / save kor)=0.
    m.events = [
      { minute: 48, type: 'goal', teamId: 'kor' },
      { minute: 51, type: 'miss', teamId: 'kor' },
      { minute: 54, type: 'save', teamId: 'esp' }, // 상대 GK가 우리 슛 막음 → 상대 위협 아님
      { minute: 58, type: 'save', teamId: 'esp' },
    ]
    const def = buildCoachAdvice(m, 'home').find(a => a.coach === '수비 코치')!
    // recentOppShots=0, opp.shotsOnTarget(1) < own(8)+2 → heavyPressure 미발동.
    expect(def.rationale).toContain('최근 15분 상대 유효슛 0')
    expect(def.apply.mentality).toBeUndefined()
    expect(def.proposal).toContain('안정적으로')
  })

  it('체력 급락 픽스처 → 피지컬 코치가 하위 3인 실명+수치를 사실 서술하고 압박 하향', () => {
    const m = base()
    m.minute = 70
    const n1 = setLineupStamina(m, 3, 22)
    const n2 = setLineupStamina(m, 5, 31)
    const n3 = setLineupStamina(m, 7, 40)
    const phys = buildCoachAdvice(m, 'home').find(a => a.coach === '피지컬 코치')!
    expect(phys).toBeTruthy()
    for (const n of [n1, n2, n3]) expect(phys.rationale).toContain(n)
    expect(phys.rationale).toContain('22')
    expect(phys.rationale).toContain('31')
    expect(phys.rationale).toContain('40')
    // 압박을 낮추는 방향.
    expect(phys.apply.instructions!.pressing!).toBeLessThan(m.home.tactics.instructions.pressing)
    expect(phys.apply.groupIntensity!.midfield).toBe(-1)
  })

  it('공격 코치는 우리 xG·점유·멘탈리티/패턴 상향을 제안(공격 그룹 +1)', () => {
    const m = base()
    m.minute = 55
    m.score = [0, 1] // 홈 지는 중
    m.stats[0] = { ...m.stats[0], shotsOnTarget: 1, xg: 0.4, possession: 42 }
    m.stats[1] = { ...m.stats[1], xg: 1.6 }
    const atk = buildCoachAdvice(m, 'home').find(a => a.coach === '공격 코치')!
    expect(atk.rationale).toContain('xG 0.40')
    expect(atk.rationale).toContain('42%')
    expect(atk.rationale).toContain('찬스가 적습니다')
    expect(atk.apply.mentality).toBe('very-attacking') // 지는 중이므로
    expect(atk.apply.groupIntensity!.attack).toBe(1)
    expect(atk.apply.attackPattern).toBeTruthy()
  })

  it('세트피스 코치는 코너 조건부(4개 미만 미등장, 4개 이상 등장)', () => {
    const few = base()
    few.stats[0] = { ...few.stats[0], corners: 2 }
    expect(buildCoachAdvice(few, 'home').some(a => a.coach === '세트피스 코치')).toBe(false)

    const many = base()
    many.stats[0] = { ...many.stats[0], corners: 5 }
    const sp = buildCoachAdvice(many, 'home').find(a => a.coach === '세트피스 코치')!
    expect(sp).toBeTruthy()
    expect(sp.rationale).toContain('코너 5')
    expect(sp.apply.attackPattern).toBe('cross')
  })

  it('제안 개수는 상황에 따라 2~4개(코어 3 + 세트피스 조건부)', () => {
    const m = base()
    const n = buildCoachAdvice(m, 'home').length
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(4)
  })

  it('결정론: 동일 상태 두 번 호출은 동일 결과', () => {
    const m = base()
    m.minute = 63
    m.score = [1, 1]
    expect(buildCoachAdvice(m, 'home')).toEqual(buildCoachAdvice(m, 'home'))
  })

  it('세이프가드 스모크: 모든 발언이 비하어 없이 통과하고 좌우 존을 언급하지 않는다', () => {
    const m = base()
    m.minute = 70
    m.score = [1, 2]
    m.stats[0] = { ...m.stats[0], corners: 6 }
    m.stats[1] = { ...m.stats[1], shotsOnTarget: 8, corners: 7 }
    setLineupStamina(m, 2, 18)
    for (const a of buildCoachAdvice(m, 'home')) {
      for (const text of [a.coach, a.rationale, a.proposal]) {
        expect(safeguardFilter(text)).toBe(true)
        expect(text).not.toMatch(/왼쪽|오른쪽|좌측|우측/)
      }
    }
  })
})
