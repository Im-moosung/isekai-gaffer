import { describe, it, expect } from 'vitest'
import { buildCoachAdvice, coachPhase, hasPatch, type CoachAdvice } from '../coach'
import { createMatch } from '../../engine/simulate'
import { makeTestTeam } from '../../engine/fixtures/testTeams'
import { recommendPlan } from '../scouting'
import { safeguardFilter } from '../../ai/safeguard'
import type { MatchState } from '../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)

/** 기본 MatchState 픽스처(minute 0·빈 스탯·체력 100). 개별 테스트가 필요한 필드만 덮어쓴다. */
function base(): MatchState {
  return createMatch(home, away, { seed: 1 })
}

/** 홈 라인업에서 idx번째 선발의 스태미나를 v로 설정. */
function setLineupStamina(m: MatchState, idx: number, v: number) {
  const id = m.home.tactics.lineup[idx].playerId
  m.home.staminaByPlayer[id] = v
  return home.squad.find(p => p.id === id)!.name.ko
}

const roles = (a: CoachAdvice[]) => a.map(x => x.coach)
const find = (m: MatchState, role: string) => buildCoachAdvice(m, 'home').find(a => a.coach === role)

// ─────────────────────────────────────────────────────────────
// R1. 등장 수 0~4 가변 — 억지 근거 금지
// ─────────────────────────────────────────────────────────────
describe('buildCoachAdvice — R1 등장 수 0~4 가변', () => {
  it('전 스탯 0·체력 100(조별 전반 스크립트 구간)에서는 아무 코치도 등장하지 않는다', () => {
    const m = base()
    m.minute = 22 // 전반 하이드레이션 브레이크
    expect(buildCoachAdvice(m, 'home')).toEqual([])
  })

  it('(회귀) 체력 100인 상태에서는 체력 관련 조언이 절대 나오지 않는다 — 전 국면', () => {
    for (const minute of [10, 22, 40, 45, 60, 70, 80, 89]) {
      const m = base()
      m.minute = minute
      m.score = [0, 2] // 공격 코치는 발동시키되, 피지컬은 침묵해야 한다
      m.stats[0] = { ...m.stats[0], shots: 5, shotsOnTarget: 2, xg: 0.3 }
      m.stats[1] = { ...m.stats[1], shots: 6, shotsOnTarget: 3, xg: 1.4 }
      const a = buildCoachAdvice(m, 'home')
      expect(roles(a)).not.toContain('피지컬 코치')
      for (const c of a) expect(`${c.rationale} ${c.proposal}`).not.toMatch(/체력 \d/)
    }
  })

  it('(회귀) 표본 0에서는 "찬스가 많습니다" 류의 0 기반 우열 비교 문장이 나오지 않는다', () => {
    for (const minute of [5, 22, 44, 45, 55, 80]) {
      const m = base()
      m.minute = minute
      const a = buildCoachAdvice(m, 'home')
      for (const c of a) {
        const text = `${c.rationale} ${c.proposal}`
        expect(text).not.toMatch(/찬스가 많|우세합니다|앞서고 있습니다/)
        expect(text).not.toMatch(/xG 0\.00/)
      }
    }
  })

  it('근거가 쌓이면 4명 전원이 등장할 수 있다', () => {
    const m = base()
    m.minute = 78
    m.score = [1, 2]
    m.stats[0] = { ...m.stats[0], shots: 6, shotsOnTarget: 1, corners: 5, xg: 0.4, possession: 44 }
    m.stats[1] = { ...m.stats[1], shots: 9, shotsOnTarget: 6, corners: 4, fouls: 11, xg: 1.9 }
    m.events = [
      { minute: 71, type: 'save', teamId: 'kor' },
      { minute: 74, type: 'goal', teamId: 'esp' },
    ]
    setLineupStamina(m, 3, 41)
    const a = buildCoachAdvice(m, 'home')
    expect(new Set(roles(a))).toEqual(new Set(['수비 코치', '공격 코치', '피지컬 코치', '세트피스 코치']))
    expect(a.length).toBe(4)
  })

  it('등장 수는 어떤 상태에서도 0~4개', () => {
    for (const minute of [1, 22, 45, 67, 88]) {
      const m = base()
      m.minute = minute
      const n = buildCoachAdvice(m, 'home').length
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(4)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// R2. 국면 축
// ─────────────────────────────────────────────────────────────
describe('coachPhase — 5국면 경계', () => {
  it('경계값', () => {
    expect(coachPhase(0)).toBe('early-first')
    expect(coachPhase(22)).toBe('early-first')
    expect(coachPhase(25)).toBe('early-first')
    expect(coachPhase(26)).toBe('late-first')
    expect(coachPhase(44)).toBe('late-first')
    expect(coachPhase(45)).toBe('halftime')
    expect(coachPhase(46)).toBe('mid-second')
    expect(coachPhase(74)).toBe('mid-second')
    expect(coachPhase(75)).toBe('endgame')
    expect(coachPhase(90)).toBe('endgame')
  })
})

describe('buildCoachAdvice — R2 국면별로 다른 조언', () => {
  /** 같은 데이터(체력 급락)를 국면만 바꿔 넣고 피지컬 코치 문구를 비교한다. */
  function physAt(minute: number) {
    const m = base()
    m.minute = minute
    setLineupStamina(m, 3, 40)
    setLineupStamina(m, 5, 52)
    return find(m, '피지컬 코치')!
  }

  it('같은 체력 데이터라도 국면마다 제안이 다르다', () => {
    const texts = [10, 40, 45, 60, 80].map(mn => physAt(mn).proposal)
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('하프타임에는 교체를 권하고, 전반에는 남은 시간을 근거로 아끼자고 한다', () => {
    expect(physAt(45).proposal).toContain('지금 바꾸십시오')
    expect(physAt(10).proposal).toContain('80분이 남았습니다')
  })

  it('종반에는 잔여 시간과 남은 교체 카드 수를 말한다', () => {
    const m = base()
    m.minute = 82
    m.home.subsUsed = 3
    setLineupStamina(m, 4, 44)
    const phys = find(m, '피지컬 코치')!
    expect(phys.proposal).toContain('8분 남았습니다')
    expect(phys.proposal).toContain('교체 2장')
  })

  it('종반·교체 카드 소진이면 교체가 아니라 버티기를 제안한다', () => {
    const m = base()
    m.minute = 84
    m.home.subsUsed = 5
    setLineupStamina(m, 4, 30)
    const phys = find(m, '피지컬 코치')!
    expect(phys.proposal).toContain('교체 카드가 없습니다')
  })

  it('종반·지고 있음: 피지컬 코치는 강도를 낮추라는 패치를 걸지 않는다(조언 전용 카드)', () => {
    const m = base()
    m.minute = 86
    m.score = [0, 1]
    setLineupStamina(m, 4, 33)
    const phys = find(m, '피지컬 코치')!
    expect(hasPatch(phys.apply)).toBe(false)
    expect(phys.proposal).toContain('교체 카드')
  })

  it('전반 초반의 "지고 있음"만으로는 공격 코치가 등장하지 않는다(킥오프 플랜 존중)', () => {
    const m = base()
    m.minute = 18
    m.score = [0, 1]
    expect(roles(buildCoachAdvice(m, 'home'))).not.toContain('공격 코치')
  })

  it('같은 지고 있는 상태라도 전반 종료 전과 종반의 공격 제안이 다르다', () => {
    const mk = (minute: number) => {
      const m = base()
      m.minute = minute
      m.score = [0, 1]
      return find(m, '공격 코치')!
    }
    const late = mk(40), end = mk(85)
    expect(late.proposal).not.toBe(end.proposal)
    // 종반에만 매우 공격적으로 간다.
    expect(late.apply.mentality).toBe('attacking')
    expect(end.apply.mentality).toBe('very-attacking')
  })
})

// ─────────────────────────────────────────────────────────────
// R3. 코치별 발동 조건 (표본 크기 확인 포함)
// ─────────────────────────────────────────────────────────────
describe('buildCoachAdvice — R3 발동 조건', () => {
  it('수비 코치: 최근 15분 상대 유효슛 2개 → 발동', () => {
    const m = base()
    m.minute = 60
    m.stats[1] = { ...m.stats[1], shotsOnTarget: 7, corners: 6 }
    m.stats[0] = { ...m.stats[0], shotsOnTarget: 6, corners: 1 }
    // ★ save는 막은 GK 팀 teamId로 기록된다 → 상대 유효슛 = goal(esp) + save(kor).
    m.events = [
      { minute: 50, type: 'save', teamId: 'kor' },
      { minute: 57, type: 'save', teamId: 'kor' },
      { minute: 10, type: 'save', teamId: 'kor' }, // 창 밖
      { minute: 55, type: 'save', teamId: 'esp' }, // 상대 GK가 우리 슛을 막음 → 우리 유효슛
    ]
    const def = find(m, '수비 코치')!
    expect(def).toBeTruthy()
    expect(def.rationale).toContain(`최근 15분에만 2개`)
  })

  it('수비 코치: 위협 지표가 전부 0이면 등장하지 않는다', () => {
    const m = base()
    m.minute = 60
    m.stats[0] = { ...m.stats[0], shots: 8, shotsOnTarget: 5 }
    m.stats[1] = { ...m.stats[1], shots: 2, shotsOnTarget: 1 }
    m.events = [{ minute: 54, type: 'save', teamId: 'esp' }] // 상대 GK 선방 = 우리 공세
    expect(roles(buildCoachAdvice(m, 'home'))).not.toContain('수비 코치')
  })

  it('수비 코치: 실점 직후에도 발동한다', () => {
    const m = base()
    m.minute = 52
    m.score = [1, 1]
    m.stats[0] = { ...m.stats[0], shotsOnTarget: 3 }
    m.stats[1] = { ...m.stats[1], shotsOnTarget: 3 }
    m.events = [{ minute: 49, type: 'goal', teamId: 'esp' }]
    const def = find(m, '수비 코치')!
    expect(def.rationale).toContain('실점했습니다')
  })

  it('피지컬 코치: 경고선 아래 선수만 실명으로 부른다(100인 선수는 언급 없음)', () => {
    const m = base()
    m.minute = 70
    const n1 = setLineupStamina(m, 3, 22)
    const n2 = setLineupStamina(m, 5, 31)
    const phys = find(m, '피지컬 코치')!
    expect(phys.rationale).toContain(`${n1} 22`)
    expect(phys.rationale).toContain(`${n2} 31`)
    expect(phys.rationale).toContain('밑도는 선수 2명')
    expect(phys.rationale).not.toContain(' 100')
    expect(phys.apply.instructions!.pressing!).toBeLessThan(m.home.tactics.instructions.pressing)
    expect(phys.apply.groupIntensity!.midfield).toBe(-1)
  })

  it('피지컬 코치: 경고선은 시간 대비다 — 같은 체력 70이 22\'엔 경고, 45\'엔 정상', () => {
    // 엔진 기본 소모가 분당 약 0.55라 고정선(75)을 쓰면 하프타임에 11명 전원이 걸려
    // 변별력이 사라진다. 기준은 "이 시점 기대치보다 밑도는가"다.
    const early = base(); early.minute = 22; setLineupStamina(early, 3, 70)
    expect(roles(buildCoachAdvice(early, 'home'))).toContain('피지컬 코치')
    const half = base(); half.minute = 45; setLineupStamina(half, 3, 70)
    expect(roles(buildCoachAdvice(half, 'home'))).not.toContain('피지컬 코치')
  })

  it('피지컬 코치: 체력이 멀쩡해도 지속 압박 누적이면 발동한다', () => {
    const m = base()
    m.minute = 40
    m.home.tactics.instructions.pressing = 82
    m.home.sustainedPressMinutes = 14
    const phys = find(m, '피지컬 코치')!
    expect(phys.rationale).toContain('압박 82를 14분째')
    // 아무도 경고선 아래가 아니므로 실명·수치 호출은 없다.
    expect(phys.rationale).not.toMatch(/체력 \d+ 이하/)
  })

  it('공격 코치: 표본이 있는데 최근 유효슛 0이면 발동', () => {
    const m = base()
    m.minute = 55
    m.stats[0] = { ...m.stats[0], shots: 2, shotsOnTarget: 0, possession: 42 }
    m.stats[1] = { ...m.stats[1], shots: 3 }
    const atk = find(m, '공격 코치')!
    expect(atk.rationale).toContain('최근 15분 우리 유효슛이 0개')
    expect(atk.rationale).toContain('양 팀 슛 5개')
    expect(atk.apply.groupIntensity!.attack).toBe(1)
    expect(atk.apply.attackPattern).toBeTruthy()
  })

  it('공격 코치: 슛 표본이 부족하면(양 팀 합 2개) 유효슛 0을 열세로 읽지 않는다', () => {
    const m = base()
    m.minute = 55
    m.stats[0] = { ...m.stats[0], shots: 1, shotsOnTarget: 0 }
    m.stats[1] = { ...m.stats[1], shots: 1 }
    expect(roles(buildCoachAdvice(m, 'home'))).not.toContain('공격 코치')
  })

  it('공격 코치: xG 열세는 표본 4개 이상에서만 근거가 된다', () => {
    const thin = base()
    thin.minute = 50
    thin.stats[0] = { ...thin.stats[0], shots: 1, shotsOnTarget: 1, xg: 0.1 }
    thin.stats[1] = { ...thin.stats[1], shots: 1, shotsOnTarget: 1, xg: 0.9 }
    expect(roles(buildCoachAdvice(thin, 'home'))).not.toContain('공격 코치')

    const thick = base()
    thick.minute = 50
    thick.stats[0] = { ...thick.stats[0], shots: 2, shotsOnTarget: 1, xg: 0.2 }
    thick.stats[1] = { ...thick.stats[1], shots: 5, shotsOnTarget: 1, xg: 1.5 }
    expect(find(thick, '공격 코치')!.rationale).toContain('xG는 우리 0.20 대 상대 1.50')
  })

  it('세트피스 코치: 코너 4개 미만 미등장 / 4개 이상 등장 + 키커 실명', () => {
    const few = base()
    few.stats[0] = { ...few.stats[0], corners: 2 }
    expect(roles(buildCoachAdvice(few, 'home'))).not.toContain('세트피스 코치')

    const many = base()
    many.stats[0] = { ...many.stats[0], corners: 5 }
    const sp = find(many, '세트피스 코치')!
    expect(sp.rationale).toContain('코너 5개')
    expect(sp.rationale).toContain('세트피스')
    expect(sp.apply.attackPattern).toBe('cross')
  })

  it('세트피스 코치: 종반에 리드 중이 아니면 코너 2개로도 등장한다(마지막 카드)', () => {
    const mid = base()
    mid.minute = 60
    mid.score = [0, 1]
    mid.stats[0] = { ...mid.stats[0], corners: 2 }
    expect(roles(buildCoachAdvice(mid, 'home'))).not.toContain('세트피스 코치')

    const end = base()
    end.minute = 82
    end.score = [0, 1]
    end.stats[0] = { ...end.stats[0], corners: 2 }
    expect(roles(buildCoachAdvice(end, 'home'))).toContain('세트피스 코치')

    const endLeading = base()
    endLeading.minute = 82
    endLeading.score = [2, 0]
    endLeading.stats[0] = { ...endLeading.stats[0], corners: 2 }
    expect(roles(buildCoachAdvice(endLeading, 'home'))).not.toContain('세트피스 코치')
  })
})

// ─────────────────────────────────────────────────────────────
// R4. 문구 다양화 + 결정론
// ─────────────────────────────────────────────────────────────
describe('buildCoachAdvice — R4 다양화·결정론', () => {
  it('결정론: 동일 상태 두 번 호출은 완전히 동일', () => {
    const m = base()
    m.minute = 63
    m.score = [1, 1]
    m.stats[0] = { ...m.stats[0], shots: 4, shotsOnTarget: 1, corners: 5 }
    m.stats[1] = { ...m.stats[1], shots: 6, shotsOnTarget: 4, xg: 1.2 }
    setLineupStamina(m, 2, 40)
    expect(buildCoachAdvice(m, 'home')).toEqual(buildCoachAdvice(m, 'home'))
  })

  it('같은 국면·같은 코치라도 분·스코어가 다르면 문구가 갈린다', () => {
    const texts = new Set<string>()
    for (const minute of [47, 52, 58, 63, 70, 73]) {
      for (const away of [1, 2]) {
        const m = base()
        m.minute = minute
        m.score = [0, away]
        setLineupStamina(m, 3, 40)
        texts.add(find(m, '피지컬 코치')!.proposal)
      }
    }
    // 국면(mid-second)은 같지만 도입 문구 변형이 갈려 최소 2종은 나와야 한다.
    expect(texts.size).toBeGreaterThanOrEqual(2)
  })

  it('난수·시각 비의존: 같은 입력을 여러 국면에서 반복 호출해도 결과가 흔들리지 않는다', () => {
    // Math.random/Date를 쓰면 반복 호출에서 반드시 깨진다(문구 변형이 해시 기반임을 고정).
    for (const minute of [12, 22, 40, 45, 58, 67, 80, 88]) {
      const mk = () => {
        const m = base()
        m.minute = minute
        m.score = [1, 2]
        m.stats[0] = { ...m.stats[0], shots: 6, shotsOnTarget: 1, corners: 5, xg: 0.4 }
        m.stats[1] = { ...m.stats[1], shots: 8, shotsOnTarget: 5, xg: 1.7 }
        setLineupStamina(m, 3, 38)
        return m
      }
      const first = buildCoachAdvice(mk(), 'home')
      for (let i = 0; i < 5; i++) expect(buildCoachAdvice(mk(), 'home')).toEqual(first)
    }
  })
})

// ─────────────────────────────────────────────────────────────
// R5. 제안이 엔진 밸런스와 어긋나지 않는다
// ─────────────────────────────────────────────────────────────
describe('buildCoachAdvice — R5 제안의 유효성', () => {
  /** 후방 전개 지표를 지정한 상대 팀. 실팀 분포: rsa 53 / cze 59 / kor 64 / esp 78. */
  function oppWithBuildup(id: string, gkBuildup: number, possession: number) {
    const t = makeTestTeam(id, 80)
    t.profile.style = { ...t.profile.style, possession }
    for (const p of t.squad) if (p.gkStats) p.gkStats = { ...p.gkStats, buildup: gkBuildup }
    return t
  }
  /** 수비 코치가 발동하도록 상대 유효슛 격차를 만들어 둔 상태. */
  function underPressure(oppTeam: ReturnType<typeof makeTestTeam>, minute: number, score: [number, number] = [0, 0]) {
    const m = createMatch(home, oppTeam, { seed: 1 })
    m.minute = minute
    m.score = score
    m.stats[1] = { ...m.stats[1], shots: 9, shotsOnTarget: 6 }
    m.stats[0] = { ...m.stats[0], shots: 3, shotsOnTarget: 1 }
    return m
  }

  it('전개가 강한 상대(지표 78)에겐 수비 코치가 라인을 내려 블록을 세운다', () => {
    const def = find(underPressure(oppWithBuildup('esp', 78, 78), 60), '수비 코치')!
    expect(def.apply.instructions!.lineHeight!).toBeLessThan(50)
    // 태세는 trap이 아니라 매치업 우위(engine matchupEdge)가 정한다(E1 후속).
    // 이 픽스처는 상대가 우리보다 강하므로(80 vs 76) 사다리 최하단이다.
    expect(def.apply.mentality).toBe('very-defensive')
    expect(def.proposal).toContain('블록을 세웁시다')
  })

  it('전개가 약한 상대(지표 53)에겐 오히려 라인·압박을 올린다(무조건 "내려라" 금지)', () => {
    const def = find(underPressure(oppWithBuildup('rsa', 50, 56), 60), '수비 코치')!
    expect(def.apply.instructions!.lineHeight!).toBeGreaterThan(50)
    expect(def.apply.instructions!.pressing!).toBeGreaterThan(50)
    // 축과 태세는 이제 서로 다른 판별자에서 나온다(축=trap, 태세=매치업 우위).
    // 이 픽스처는 "전개는 약하지만 우리보다 강한 상대"(80 vs 76) — 전방에서 가두러 나가되
    // 볼을 잃었을 때는 무리하지 않는다. 실측이 지지하는 조합이다(scouting.ts 라인 스윕 표).
    expect(def.apply.mentality).toBe('very-defensive')
    expect(def.proposal).toContain('전방에서 가둘 수 있습니다')
  })

  it('수비 코치의 라인·압박 제안은 킥오프 추천(scouting)과 같은 축을 말한다', () => {
    const opp = oppWithBuildup('cze', 56, 62)
    const def = find(underPressure(opp, 60), '수비 코치')!
    const plan = recommendPlan(home, opp)
    expect(def.apply.instructions!.lineHeight).toBe(plan.patch.instructions!.lineHeight)
    expect(def.apply.instructions!.pressing).toBe(plan.patch.instructions!.pressing)
  })

  it('수비 그룹 적극성은 +1(강화)이다 — 수비를 굳히자면서 -1을 거는 방향 오류 방지', () => {
    const def = find(underPressure(oppWithBuildup('esp', 78, 78), 60), '수비 코치')!
    expect(def.apply.groupIntensity!.defense).toBe(1)
  })

  it('종반에 지고 있으면 수비 코치의 "내려앉자" 처방은 나오지 않는다', () => {
    const m = underPressure(oppWithBuildup('esp', 78, 78), 84, [0, 1])
    expect(roles(buildCoachAdvice(m, 'home'))).not.toContain('수비 코치')
    // 같은 종반이라도 가둘 수 있는 상대면 수비 코치는 계속 말한다.
    const weak = underPressure(oppWithBuildup('rsa', 50, 56), 84, [0, 1])
    expect(roles(buildCoachAdvice(weak, 'home'))).toContain('수비 코치')
  })

  it('압박 제안은 엔진 검증 범위(20 이상)를 벗어나지 않는다', () => {
    const m = base()
    m.minute = 70
    m.home.tactics.instructions.pressing = 25
    setLineupStamina(m, 3, 20)
    expect(find(m, '피지컬 코치')!.apply.instructions!.pressing).toBe(20)
  })

  it('공격 패턴은 상대 라인 높이에서 파생된다(하이라인 → 중앙 침투)', () => {
    const highLine = makeTestTeam('arg', 86)
    highLine.profile.style.lineHeight = 72
    const m = createMatch(home, highLine, { seed: 1 })
    m.minute = 70
    m.score = [0, 1]
    const atk = find(m, '공격 코치')!
    expect(atk.apply.attackPattern).toBe('through')
    expect(atk.proposal).toContain('상대 라인 높이 72 — 높게 서 있어')
  })
})

// ─────────────────────────────────────────────────────────────
// 세이프가드
// ─────────────────────────────────────────────────────────────
describe('buildCoachAdvice — 세이프가드', () => {
  it('모든 발언이 비하어 없이 통과하고 좌우 존을 언급하지 않는다', () => {
    for (const minute of [12, 22, 38, 45, 55, 67, 80, 88]) {
      const m = base()
      m.minute = minute
      m.score = [1, 2]
      m.stats[0] = { ...m.stats[0], shots: 7, shotsOnTarget: 1, corners: 6, xg: 0.5 }
      m.stats[1] = { ...m.stats[1], shots: 10, shotsOnTarget: 8, corners: 7, fouls: 9, xg: 2.1 }
      m.events = [{ minute: minute - 3, type: 'goal', teamId: 'esp' }]
      setLineupStamina(m, 2, 18)
      for (const a of buildCoachAdvice(m, 'home')) {
        for (const text of [a.coach, a.rationale, a.proposal]) {
          expect(safeguardFilter(text)).toBe(true)
          expect(text).not.toMatch(/왼쪽|오른쪽|좌측|우측/)
        }
      }
    }
  })
})
