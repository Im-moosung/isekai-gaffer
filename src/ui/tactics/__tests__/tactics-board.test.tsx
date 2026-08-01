// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, cleanup, act, within } from '@testing-library/react'
import { useMatchStore } from '../../../game/matchStore'
import { TacticsBoard } from '../TacticsBoard'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const store = () => useMatchStore.getState()

// 작전판을 특정 정지 phase에 놓고 렌더한다. 엔진은 kickoff 후 1분 전진시켜 준비.
function mountAt(phase: 'paused-user' | 'paused-break' | 'halftime') {
  store().reset()
  store().startMatch(home, away, 20260724)
  act(() => { store().kickoff() })
  act(() => { store().advanceMinute() })
  act(() => {
    useMatchStore.setState({
      phase,
      pauseReason: phase === 'halftime' ? { kind: 'halftime' }
        : phase === 'paused-break' ? { kind: 'hydration1' as const }
        : { kind: 'user' as const },
    })
  })
  return render(<TacticsBoard />)
}

/** 전술 탭 안의 서브탭 전환(지시 / 태세 / 세트피스·대형).
 *  비활성 서브탭은 `hidden`이라 접근성 트리에서 빠진다 — 그게 이 설계의 요점이므로
 *  (스크린리더·탭 이동이 숨은 컨트롤에 닿지 않는다) 테스트도 사람과 같은 경로로 연다. */
function openSubtab(container: HTMLElement, label: '지시' | '태세' | '세트피스') {
  const tab = Array.from(container.querySelectorAll('.tw-tab'))
    .find(el => el.textContent!.includes(label))
  if (!tab) throw new Error(`서브탭 없음: ${label}`)
  fireEvent.click(tab)
}

beforeEach(() => { store().reset() })
afterEach(() => { cleanup() })

const homeCxs = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.pv-dot--home')).map(d => d.getAttribute('cx'))

describe('TacticsBoard — 실시간 보드 반영(포메이션 변경)', () => {
  it('포메이션 셀렉터 변경 → 엔진 formation 갱신 + 보드 도트 좌표 변화', () => {
    const { getByRole, container } = mountAt('paused-break')
    // 기본 4-3-3 (테스트팀 preferredFormations[0]).
    expect(store().engine!.home.tactics.formation).toBe('4-3-3')
    const before = homeCxs(container as HTMLElement)
    expect(before.length).toBe(11)

    // 3-5-2로 변경 → autoFill 재배치 + submitCommand(type:'formation').
    fireEvent.click(getByRole('button', { name: '3-5-2' }))
    expect(store().engine!.home.tactics.formation).toBe('3-5-2')

    // 보드 도트 좌표가 새 slotCoords로 바뀐다(변경→시각 피드백 루프).
    const after = homeCxs(container as HTMLElement)
    expect(after).not.toEqual(before)
  })

  it('같은 포메이션 재클릭은 무변경(no-op)', () => {
    const { getByRole, container } = mountAt('paused-break')
    const before = homeCxs(container as HTMLElement)
    fireEvent.click(getByRole('button', { name: '4-3-3' }))
    expect(store().engine!.home.tactics.formation).toBe('4-3-3')
    expect(homeCxs(container as HTMLElement)).toEqual(before)
  })
})

describe('TacticsBoard — 확장 전술 지시(Task 5)', () => {
  it('멘탈리티 5버튼 + 클릭 시 엔진 tactics.mentality 갱신', () => {
    const { getByRole, container } = mountAt('paused-break')
    openSubtab(container, '태세')
    expect(store().engine!.home.tactics.mentality ?? 'balanced').toBe('balanced')
    fireEvent.click(getByRole('button', { name: '공격적', pressed: false }))
    expect(store().engine!.home.tactics.mentality).toBe('attacking')
  })

  it('그룹 적극성: 공격 라인 [적극] → groupIntensity.attack=1', () => {
    const { getByRole, container } = mountAt('paused-break')
    openSubtab(container, '태세')
    const grp = getByRole('group', { name: '공격 적극성' })
    fireEvent.click(within(grp).getByRole('button', { name: '적극' }))
    expect(store().engine!.home.tactics.groupIntensity!.attack).toBe(1)
    expect(store().engine!.home.tactics.groupIntensity!.midfield).toBe(0)
  })

  it('공격 패턴 4택: [중거리] 선택 → attackPattern=longshot', () => {
    const { getByRole, container } = mountAt('paused-break')
    openSubtab(container, '태세')
    fireEvent.click(getByRole('button', { name: '중거리' }))
    expect(store().engine!.home.tactics.attackPattern).toBe('longshot')
  })

  it('GK 파워플레이: 조건 미충족(1분·비지는중)엔 잠금+사유', () => {
    const { getByRole, getByText, container } = mountAt('paused-break')
    openSubtab(container, '태세')
    const btn = getByRole('button', { name: 'GK 전진' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(getByText(/85' 이후에만 효과가 있습니다/)).toBeTruthy()
  })

  it('GK 파워플레이: 85\'+ & 지는 중이면 해제 → 토글 반영', () => {
    const { getByRole, container } = mountAt('paused-break')
    openSubtab(container, '태세')
    act(() => {
      const eng = structuredClone(store().engine!)
      eng.minute = 87; eng.score = [0, 1] // 홈 지는 중
      useMatchStore.setState({ engine: eng })
    })
    const btn = getByRole('button', { name: 'GK 전진' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(store().engine!.home.tactics.gkPowerplay).toBe(true)
  })

  // ★ 결함 회귀(2026-08-01): 예전에는 버튼이 `!open || !ppUnlocked`로 막히는데 안내문은
  //   ppUnlocked만 봤다. 85분이 지나면 "해제됐다"는 문구가 뜬 채 버튼이 죽어 있었다.
  //   잠금 조건이 여럿이면 **지금 막고 있는 조건 전부**가 화면에 있어야 한다.
  it("GK 파워플레이: 85'+·지는 중이어도 개입 창 밖이면 그 사실을 화면이 말한다", () => {
    const { getByRole, container } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    openSubtab(container, '태세')
    act(() => {
      const eng = structuredClone(store().engine!)
      eng.minute = 87; eng.score = [0, 1]
      // 쿨다운 중 = 개입 자원이 막힌 상태. 엔진 조건은 충족돼 있다.
      useMatchStore.setState({ engine: eng, lastInterventionMinute: 85, touchlineWindow: null })
    })
    const btn = getByRole('button', { name: 'GK 전진' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // 화면이 "해제됐다"고 말하면 안 된다 — 막고 있는 것은 쿨다운이고, 그것을 말해야 한다.
    const grp = container.querySelector('[aria-label="GK 파워플레이"]')!
    expect(grp.textContent).toContain('잠김')
    expect(grp.textContent).toContain('쿨다운')
  })

  it('GK 파워플레이: 켜 둔 상태는 조건이 사라져도 끌 수 있다', () => {
    const { getByRole, container } = mountAt('paused-break')
    openSubtab(container, '태세')
    act(() => {
      const eng = structuredClone(store().engine!)
      eng.minute = 87; eng.score = [0, 1]
      eng.home.tactics = { ...eng.home.tactics, gkPowerplay: true }
      useMatchStore.setState({ engine: eng })
    })
    const btn = getByRole('button', { name: 'GK 전진' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(store().engine!.home.tactics.gkPowerplay).toBe(false)
  })

  // 네이티브 <select>는 폐지했다(OS 기본 스타일이 그대로 나오고, 7개짜리 배타 선택은
  // 열지 않고도 후보를 보이는 편이 낫다). 세그먼트 버튼으로 같은 계약을 검증한다.
  it('페이즈 포메이션: 공격 시 3-5-2 선택 → phaseFormations.attack', () => {
    const { getByRole, container } = mountAt('paused-break')
    openSubtab(container, '세트피스')
    fireEvent.click(getByRole('button', { name: '공격 시 3-5-2' }))
    expect(store().engine!.home.tactics.phaseFormations!.attack).toBe('3-5-2')
    // 되돌리기: [기본 유지]는 undefined로 지운다.
    fireEvent.click(getByRole('button', { name: '공격 시 기본 유지' }))
    expect(store().engine!.home.tactics.phaseFormations!.attack).toBeUndefined()
  })

  it('압박 슬라이더 옆 체력 소모 트레이드오프(⚡) 표시', () => {
    const { getByText } = mountAt('paused-break')
    expect(getByText(/체력 소모 \+40%/)).toBeTruthy()
    expect(getByText(/뒷공간 노출/)).toBeTruthy()
  })
})

describe('TacticsBoard — 코치 회의 (근거가 있는 코치만 등장)', () => {
  /** 코치 발동 조건을 만족하는 실측 데이터를 엔진에 심는다 —
   *  코치는 근거 없이는 등장하지 않으므로 카드를 보려면 데이터가 있어야 한다. */
  function seedCoachData() {
    const e = store().engine!
    const next = {
      ...e,
      minute: 60,
      score: [0, 1] as [number, number],
      stats: [
        { ...e.stats[0], shots: 4, shotsOnTarget: 1, corners: 5, xg: 0.3 },
        { ...e.stats[1], shots: 9, shotsOnTarget: 6, corners: 3, xg: 1.8 },
      ] as typeof e.stats,
      home: { ...e.home, staminaByPlayer: { ...e.home.staminaByPlayer, [e.home.tactics.lineup[3].playerId]: 40 } },
    }
    act(() => { useMatchStore.setState({ engine: next }) })
  }

  it('근거가 없으면(킥오프 직후·전 스탯 0) 카드 대신 "특별히 드릴 말씀 없습니다" 한 줄만 나온다', () => {
    const { container } = mountAt('paused-break')
    expect(container.querySelectorAll('.tb-coach__card').length).toBe(0)
    expect(container.querySelector('.tb-coach__quiet')!.textContent).toContain('특별히 드릴 말씀 없습니다')
  })

  it('근거가 쌓이면 팝업(role=dialog)으로 뜨고 [감독 판단대로 간다]가 있다', () => {
    const r = mountAt('halftime')
    seedCoachData()
    const pop = r.container.querySelector('.tb-coachpop')!
    expect(pop).toBeTruthy()
    expect(pop.getAttribute('role')).toBe('dialog')
    expect(pop.getAttribute('aria-modal')).toBe('true')
    expect(pop.querySelectorAll('.tb-coach__card').length).toBeGreaterThanOrEqual(2)
    expect(r.getByRole('button', { name: '감독 판단대로 간다' })).toBeTruthy()
  })

  it('[채택] → 반영되고 팝업이 사라진다(사용자 지시)', () => {
    const r = mountAt('halftime')
    seedCoachData()
    const cards = r.container.querySelectorAll('.tb-coach__card')
    const defCard = Array.from(cards).find(c => c.querySelector('.tb-coach__role')!.textContent === '수비 코치')!
    fireEvent.click(defCard.querySelector('.tb-coach__adopt') as HTMLElement)
    expect(store().engine!.home.tactics.instructions.lineHeight).toBe(55)
    expect(r.container.querySelector('.tb-coachpop')).toBeNull()
  })

  it('닫은 뒤 [코치 회의 열기]로 다시 열 수 있다(실수로 닫았을 때)', () => {
    const r = mountAt('halftime')
    seedCoachData()
    fireEvent.click(r.getByRole('button', { name: '감독 판단대로 간다' }))
    expect(r.container.querySelector('.tb-coachpop')).toBeNull()
    fireEvent.click(r.getByRole('button', { name: '코치 회의 열기' }))
    expect(r.container.querySelector('.tb-coachpop')).toBeTruthy()
  })

  it('[채택] → 부분 전술이 draft(엔진 tactics)에 병합된다', () => {
    const r = mountAt('halftime')
    seedCoachData()
    void r
    const cards = r.container.querySelectorAll('.tb-coach__card')
    const defCard = Array.from(cards).find(c => c.querySelector('.tb-coach__role')!.textContent === '수비 코치')!
    fireEvent.click(defCard.querySelector('.tb-coach__adopt') as HTMLElement)
    const after = store().engine!.home.tactics
    // 수비 코치는 상대 후방 전개 지표에서 라인·압박을 함께 뽑는다(scouting과 같은 축).
    expect(after.instructions.lineHeight).toBe(55)
    expect(after.instructions.pressing).toBe(55)
    // +1이 '적극(강화)'이다 — 수비를 굳히자면서 -1을 걸면 존 전력이 오히려 떨어진다.
    expect(after.groupIntensity!.defense).toBe(1)
  })

  // ★ 확장 개방(2026-08-01): [채택]을 등급 하나로 끄지 않는다 — **패치 내용으로 판정**한다.
  //   코치 조언은 대개 터치라인에서도 성립하고, 폭을 넘는 카드만 막혀야 한다.
  it('감독 타임: 폭 안의 조언은 채택되고, 폭을 넘는 조언은 사유와 함께 막힌다', () => {
    const r = mountAt('paused-user')
    seedCoachData()
    const cards = Array.from(r.container.querySelectorAll('.tb-coach__card'))
      .filter(c => c.querySelector('.tb-coach__adopt'))
    expect(cards.length).toBeGreaterThan(0)
    // 막힌 카드는 반드시 사유를 그 자리에 적는다(이유 없는 disabled 금지).
    for (const c of cards) {
      const btn = c.querySelector('.tb-coach__adopt') as HTMLButtonElement
      if (btn.disabled) expect(c.querySelector('.tb-coach__block')!.textContent!.length).toBeGreaterThan(0)
    }
    // 열려 있는 카드는 실제로 반영된다.
    const openCard = cards.find(c => !(c.querySelector('.tb-coach__adopt') as HTMLButtonElement).disabled)
    if (openCard) {
      const before = JSON.stringify(store().engine!.home.tactics)
      fireEvent.click(openCard.querySelector('.tb-coach__adopt') as HTMLElement)
      expect(JSON.stringify(store().engine!.home.tactics)).not.toBe(before)
    }
  })

  it('감독 타임: 대형을 바꾸는 조언은 채택이 막힌다(포메이션의 경계)', () => {
    const r = mountAt('paused-user')
    seedCoachData()
    // 멘탈리티를 두 단계 미는 패치를 만들 수는 없으므로, 창 스냅샷을 반대편 끝으로 옮겨
    // 코치의 태세 제안이 두 단계가 되게 한다 — 그러면 그 카드만 막혀야 한다.
    act(() => {
      const eng = structuredClone(store().engine!)
      eng.home.tactics = { ...eng.home.tactics, mentality: 'very-defensive' }
      useMatchStore.setState({ engine: eng, touchlineWindow: null })
    })
    const blocked = Array.from(r.container.querySelectorAll('.tb-coach__card'))
      .filter(c => (c.querySelector('.tb-coach__adopt') as HTMLButtonElement | null)?.disabled)
    for (const c of blocked) {
      expect(c.querySelector('.tb-coach__block')).toBeTruthy()
    }
  })

  it('[감독 판단대로 간다] → 아무것도 반영하지 않고 팝업만 닫는다(전부 무시 경로)', () => {
    const r = mountAt('paused-break')
    seedCoachData()
    const before = JSON.stringify(store().engine!.home.tactics)
    expect(r.container.querySelectorAll('.tb-coach__card').length).toBeGreaterThan(0)
    fireEvent.click(r.getByRole('button', { name: '감독 판단대로 간다' }))
    expect(r.container.querySelector('.tb-coach')).toBeNull()
    expect(JSON.stringify(store().engine!.home.tactics)).toBe(before)
  })
})

describe('TacticsBoard — 보드 하이라이트·팝오버 (Task 7)', () => {
  it('보드 도트 클릭 → 발광 링 + PlayerCard 팝오버', () => {
    const { container } = mountAt('paused-break')
    expect(container.querySelector('.pv-ring')).toBeNull()
    expect(container.querySelector('.tb-pop')).toBeNull()
    const dot = container.querySelector('.pv-dotg--click') as HTMLElement
    fireEvent.click(dot)
    // 클릭한 선수 도트에 발광 링 + 옆 팝오버 카드.
    expect(container.querySelector('.pv-ring')).toBeTruthy()
    const pop = container.querySelector('.tb-pop .pc')
    expect(pop).toBeTruthy()
    expect(container.querySelector('.tb-pop .pc-radar__poly')).toBeTruthy()
  })

  it('팝오버 닫기 버튼 → 카드·링 제거', () => {
    const { container, getByLabelText } = mountAt('paused-break')
    fireEvent.click(container.querySelector('.pv-dotg--click') as HTMLElement)
    fireEvent.click(getByLabelText('카드 닫기'))
    expect(container.querySelector('.tb-pop')).toBeNull()
    expect(container.querySelector('.pv-ring')).toBeNull()
  })
})

describe('TacticsBoard — 교체 미리보기 → 확정 (Task 7)', () => {
  function openSub(c: ReturnType<typeof mountAt>) {
    fireEvent.click(c.getByRole('tab', { name: '교체' }))
  }

  it('아웃 선택 → 보드 링 강조(고스트 없음)', () => {
    const c = mountAt('paused-break')
    openSub(c)
    const outCard = c.container.querySelector('.cs-sub__lineup .cs-card') as HTMLElement
    fireEvent.click(outCard)
    expect(c.container.querySelector('.pv-ring')).toBeTruthy()
    expect(c.container.querySelector('.pv-ghost')).toBeNull()
  })

  it('아웃+인 선택 → 고스트 도트 미리보기 + 두 카드 비교', () => {
    const c = mountAt('paused-break')
    openSub(c)
    fireEvent.click(c.container.querySelector('.cs-sub__lineup .cs-card') as HTMLElement)
    fireEvent.click(c.container.querySelector('.cs-sub__bench .cs-card') as HTMLElement)
    // 들어갈 슬롯 위치에 고스트 도트.
    expect(c.container.querySelector('.pv-ghost')).toBeTruthy()
    // 워룸과 **같은** 비교 컴포넌트(PlayerCompare)가 뜬다 — 조작 규약 공통.
    const compare = c.container.querySelector('.tb-pop--cmp .cmp')
    expect(compare).toBeTruthy()
    expect(compare!.querySelectorAll('.cmp__head')).toHaveLength(2)
  })

  it('[교체 확정] → submitCommand(sub) 호출 + subsUsed 증가 + 상태 리셋', () => {
    const c = mountAt('paused-break')
    openSub(c)
    const before = store().engine!.home.subsUsed
    fireEvent.click(c.container.querySelector('.cs-sub__lineup .cs-card') as HTMLElement)
    fireEvent.click(c.container.querySelector('.cs-sub__bench .cs-card') as HTMLElement)
    fireEvent.click(c.getByRole('button', { name: '교체 확정' }))
    expect(store().engine!.home.subsUsed).toBe(before + 1)
    // 확정 후 고스트·비교 카드 사라짐(리셋).
    expect(c.container.querySelector('.pv-ghost')).toBeNull()
    expect(c.container.querySelector('.tb-pop--cmp')).toBeNull()
  })
})

describe('TacticsBoard — 하프타임 팀토크 + 사유', () => {
  it('halftime → 팀토크 카드 + [후반 시작] 라벨 + 사유(전반 종료)', () => {
    const { getByRole, container } = mountAt('halftime')
    expect(container.querySelector('.tt-root')).toBeTruthy()
    expect(getByRole('button', { name: '후반 시작' })).toBeTruthy()
    // 사유는 헤더에 한 번만 적는다 — 푸터의 중복 표기와 함께 있던 주 CTA를 헤더로 올렸다.
    expect(container.querySelector('.tb-head__reason')!.textContent).toContain('전반 종료')
  })

  it('정지(감독 타임)엔 팀토크 없음 + [전술 확정] 라벨', () => {
    const { getByRole, container } = mountAt('paused-user')
    expect(container.querySelector('.tt-root')).toBeNull()
    expect(getByRole('button', { name: '전술 확정' })).toBeTruthy()
    expect(container.querySelector('.tb-head__reason')!.textContent).toContain('감독 타임')
  })
})

describe('TacticsBoard — 플랜 대비(킥오프 계획 vs 현재)', () => {
  it('킥오프 직후엔 차이가 없어 "계획대로 가는 중"을 표시한다', () => {
    const { container } = mountAt('paused-break')
    const plan = container.querySelector('.tb-plan')!
    expect(plan).toBeTruthy()
    expect(plan.textContent).toContain('플랜대로 가는 중')
  })

  it('지시를 바꾸면 "계획: 압박 N → 현재 M" 행이 나타난다', () => {
    const { container } = mountAt('paused-break')
    const before = store().engine!.home.tactics.instructions
    act(() => {
      store().submitCommand('home', {
        type: 'instructions', instructions: { ...before, pressing: 75 },
      })
    })
    const text = container.querySelector('.tb-plan')!.textContent!
    expect(text).toContain(`계획: 압박 ${before.pressing} → 현재 75`)
    expect(text).not.toContain('플랜대로 가는 중')
  })

  it('포메이션을 바꾸면 구조 변경 행이 나타난다', () => {
    const { getByRole, container } = mountAt('paused-break')
    fireEvent.click(getByRole('button', { name: '5-4-1' }))
    expect(container.querySelector('.tb-plan')!.textContent).toContain('계획: 포메이션 4-3-3 → 현재 5-4-1')
  })
})

describe('TacticsBoard — 개입 권한 2등급', () => {
  it('감독 타임: 포메이션 버튼이 잠기고, 잠긴 이유와 다음 브레이크 분을 알린다', () => {
    const { container, getByRole } = mountAt('paused-user')
    const notice = container.querySelector('.tb-touchline')!
    // 확장 개방 이후로는 **잠긴 쪽이 소수**다 — 안내도 그렇게 말해야 화면이 사실과 맞는다.
    expect(notice.textContent).toContain('포메이션')
    expect(notice.textContent).toContain('라인·압박·템포')
    expect(notice.textContent).not.toContain('압박·템포 지시만')
    // 스케줄의 다음 브레이크 분이 문구에 그대로 들어간다(1분 시점 → 첫 하이드레이션).
    expect(notice.textContent).toContain(`${store().schedule!.firstHydration}분`)
    expect((getByRole('button', { name: '5-4-1' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('감독 타임: 전술 탭이 먼저 열린다(대형만 잠기므로 첫 화면이 고장으로 읽히지 않는다)', () => {
    const { getByRole } = mountAt('paused-user')
    expect(getByRole('tab', { name: /전술/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('감독 타임: 교체는 여전히 가능하다', () => {
    mountAt('paused-user')
    const home = store().engine!.home
    const out = home.tactics.lineup[10].playerId
    const inId = home.team.squad.find(p => !home.tactics.lineup.some(l => l.playerId === p.id))!.id
    act(() => { store().submitCommand('home', { type: 'sub', out, in: inId }) })
    expect(store().engine!.home.subsUsed).toBe(1)
  })

  it('감독 타임: 멘탈리티는 한 칸 옆까지 열리고 두 칸은 잠긴다(±1단계)', () => {
    const { getByRole, container } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    // 터치라인 안내는 화면에 **한 번만** 있다(상단 배너). 예전에는 전술 탭 안에 같은
    // 문장을 한 번 더 적었고, 보드와 패널이 나란히 서면서 둘이 동시에 보였다.
    expect(container.querySelector('.tb-touchline')!.textContent).toContain('포메이션')
    expect(container.querySelector('.tb-locked')).toBeNull()
    openSubtab(container, '태세')
    // 기준은 현재값(균형). 공격적/수비적은 한 칸이라 열리고, 매우 공격적은 두 칸이라 잠긴다.
    expect((getByRole('button', { name: '공격적' }) as HTMLButtonElement).disabled).toBe(false)
    expect((getByRole('button', { name: '수비적' }) as HTMLButtonElement).disabled).toBe(false)
    expect((getByRole('button', { name: '매우 공격적' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(getByRole('button', { name: '공격적' }))
    expect(store().engine!.home.tactics.mentality).toBe('attacking')
  })

  it('감독 타임: 페이즈 포메이션만 잠기고, 왜·언제 풀리는지가 화면에 있다', () => {
    const { getByRole, container } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    // 잠긴 축이 어느 서브탭에 있는지는 열기 전에 탭 라벨이 말한다.
    expect(container.querySelector('.tw-tab__lock')!.textContent).toContain('대형 잠김')
    openSubtab(container, '세트피스')
    expect((getByRole('button', { name: '공격 시 3-5-2' }) as HTMLButtonElement).disabled).toBe(true)
    const grp = container.querySelector('[aria-label="페이즈 포메이션"]')!
    expect(grp.textContent).toContain('잠김')
    expect(grp.textContent).toContain('대형')
    expect(grp.textContent).toContain(`${store().schedule!.firstHydration}분`)
  })

  it('하이드레이션 브레이크: 안내가 없고 포메이션 버튼이 열린다', () => {
    const { container, getByRole } = mountAt('paused-break')
    expect(container.querySelector('.tb-touchline')).toBeNull()
    expect((getByRole('button', { name: '5-4-1' }) as HTMLButtonElement).disabled).toBe(false)
    // 전원 소집이면 서브탭에 잠금 표시가 없다.
    expect(container.querySelector('.tw-tab__lock')).toBeNull()
    openSubtab(container, '태세')
    expect((getByRole('button', { name: '매우 공격적' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('TacticsBoard — 전술 시각화 즉시 반영(사용자 지시 ②)', () => {
  const pressRect = (c: HTMLElement) =>
    c.querySelector('.an-team--home .an-press') as SVGRectElement | null

  it('작전판 보드에 전술 레이어(수비 라인·압박 존·패스 레인)가 그려진다', () => {
    const { container } = mountAt('paused-break')
    expect(container.querySelector('.pv-root--analysis')).toBeTruthy()
    expect(container.querySelector('.an-team--home .an-line')).toBeTruthy()
    expect(pressRect(container as HTMLElement)).toBeTruthy()
    expect(container.querySelector('.an-lane')).toBeTruthy()
  })

  it('압박 슬라이더를 만지면 [지시 적용] 전에도 압박 존이 즉시 움직인다(미리보기)', () => {
    const { container, getByLabelText } = mountAt('paused-break')
    const before = pressRect(container as HTMLElement)!.getAttribute('width')
    const engineBefore = store().engine!.home.tactics.instructions.pressing
    fireEvent.change(getByLabelText('압박'), { target: { value: String(engineBefore + 25) } })
    // 존 폭이 그 자리에서 바뀐다.
    expect(pressRect(container as HTMLElement)!.getAttribute('width')).not.toBe(before)
    // 그러나 엔진은 아직 그대로다 — 반영은 [지시 적용]에서만 일어난다.
    expect(store().engine!.home.tactics.instructions.pressing).toBe(engineBefore)
  })

  it('공격방향을 바꾸면 집중 밴드가 그 영역으로 옮겨 간다', () => {
    const { container, getByRole } = mountAt('paused-break')
    fireEvent.click(getByRole('button', { name: '좌측' }))
    const band = container.querySelector('.an-focus__fill') as SVGRectElement
    expect(band).toBeTruthy()
    // left = y 0~30 → 상단 밴드(y=0).
    expect(Number(band.getAttribute('y'))).toBe(0)
  })

  it('템포는 도형이 없으므로 패스 레인의 흐름 주기(--an-flow)로 표현한다', () => {
    const { container, getByLabelText } = mountAt('paused-break')
    const root = () => container.querySelector('.an-root') as SVGGElement
    const before = root().getAttribute('style')
    fireEvent.change(getByLabelText('템포'), { target: { value: '95' } })
    expect(root().getAttribute('style')).not.toBe(before)
    expect(root().getAttribute('style')).toContain('--an-flow')
  })
})

describe('TacticsBoard — 세트피스 UI(결함 ④)', () => {
  it('코너 루트·박스 인원·수비 마킹 3축이 있고 즉시 반영된다', () => {
    const { getByRole, container } = mountAt('paused-break')
    openSubtab(container, '세트피스')
    expect(store().engine!.home.tactics.setPiece).toBeUndefined()
    fireEvent.click(getByRole('button', { name: '코너 루트 니어' }))
    expect(store().engine!.home.tactics.setPiece!.route).toBe('near')
    fireEvent.click(getByRole('button', { name: '박스 인원 많이' }))
    expect(store().engine!.home.tactics.setPiece!.boxLoad).toBe('heavy')
    fireEvent.click(getByRole('button', { name: '수비 마킹 맨투맨' }))
    expect(store().engine!.home.tactics.setPiece!.marking).toBe('man')
    // 앞서 고른 값이 유지된다(부분 갱신이 서로를 지우지 않는다).
    expect(store().engine!.home.tactics.setPiece!.route).toBe('near')
  })

  // ★ 2026-08-01: "추천" 배지·단정 문구를 걷어내고 **선택지별 배수**로 바꿨다.
  //   원칙은 "사실과 수치는 보여주고 결론은 유저가 낸다"다 — 어느 값이 낫다고 화면이
  //   말하는 대신, 엔진이 실제로 쓰는 숫자를 셋 다 펴 놓는다.
  it('판별자와 선택지별 배수를 적고, 어느 값을 고르라고는 하지 않는다', () => {
    const { container } = mountAt('paused-break')
    openSubtab(container, '세트피스')
    const grp = container.querySelector('[aria-label="세트피스"]')!
    expect(grp.textContent).toContain('상대 GK 제공권')
    expect(grp.textContent).toContain('역습 위험 지수')
    // 선택지 셋의 전환 배수가 전부 적혀 있다.
    const readouts = Array.from(grp.querySelectorAll('.tx-hint--readout')).map(e => e.textContent!)
    expect(readouts.length).toBe(2)
    for (const ko of ['니어', '파', '짧게']) expect(readouts[0]).toContain(ko)
    for (const ko of ['적게', '표준', '많이']) expect(readouts[1]).toContain(ko)
    expect(readouts[0]).toMatch(/\d\.\d\d/)
    // 판정은 없다.
    expect(grp.querySelector('.tx-btn__rec')).toBeNull()
    expect(grp.textContent).not.toContain('추천')
  })

  // 등급 재판정(2026-08-01 확장 개방): 훈련장에서 약속하는 것은 **루틴 자체**이고,
  // 코너 앞에서 감독이 하는 일은 이미 약속된 것 중 하나를 고르는 것이다(손짓 하나).
  // 대형 재배치가 아니므로 터치라인에서 연다.
  it('터치라인 등급에서도 세트피스는 열린다(약속된 루틴 중 하나를 고르는 일)', () => {
    const { getByRole, container } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    openSubtab(container, '세트피스')
    const btn = getByRole('button', { name: '코너 루트 니어' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(store().engine!.home.tactics.setPiece!.route).toBe('near')
  })
})

describe('TacticsBoard — 터치라인 지시 개방(사용자 지시 ③)', () => {
  it('감독 타임: 지시 4축이 전부 열린다(라인·공격방향 포함)', () => {
    const { getByRole, getByLabelText } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    expect((getByLabelText('압박') as HTMLInputElement).disabled).toBe(false)
    expect((getByLabelText('템포') as HTMLInputElement).disabled).toBe(false)
    expect((getByLabelText('라인') as HTMLInputElement).disabled).toBe(false)
    expect((getByRole('button', { name: '좌측' }) as HTMLButtonElement).disabled).toBe(false)
  })

  // ★ 3f4af06은 슬라이더 min/max를 base±15로 잘라 규칙을 표현했다. 그 결정을 뒤집었다
  //   (사용자 보고 2026-08-01: 지시 적용 후 손잡이가 중앙에 서서 "명령이 안 먹힌 줄 알았다").
  //   좌표계는 절대 0~100 고정, 속도 제한은 클램프 + 밴드 표식으로 표현한다.
  it('감독 타임: 슬라이더 좌표계는 절대 0~100이고 값은 실제 지시값이다', () => {
    const { getByRole, getByLabelText, container } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    const cur = store().engine!.home.tactics.instructions.pressing
    const el = getByLabelText('압박') as HTMLInputElement
    expect(Number(el.min)).toBe(0)
    expect(Number(el.max)).toBe(100)
    expect(Number(el.value)).toBe(cur)
    // 허용 밴드는 좌표계가 아니라 트랙 위 표식으로 그린다.
    const band = container.querySelectorAll('.cs-axis__band')
    expect(band.length).toBe(3)
  })

  it('감독 타임: 밴드 밖으로 끌면 ±15 경계로 클램프된다(store 판정과 같은 기준)', () => {
    const { getByRole, getByLabelText } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    const cur = store().engine!.home.tactics.instructions.pressing
    const el = getByLabelText('압박') as HTMLInputElement
    fireEvent.change(el, { target: { value: '100' } })
    expect(Number(el.value)).toBe(Math.min(100, cur + 15))
    fireEvent.change(el, { target: { value: '0' } })
    expect(Number(el.value)).toBe(Math.max(0, cur - 15))
    // 클램프된 값은 store가 받아 준다 — 화면과 정본 판정이 어긋나지 않는다.
    fireEvent.click(getByRole('button', { name: '터치라인 지시' }))
    expect(store().engine!.home.tactics.instructions.pressing).toBe(Math.max(0, cur - 15))
  })

  it('감독 타임: [터치라인 지시]가 반영되고 그 분에 창이 열린다(추가 비용 없음)', () => {
    const { getByRole, getByLabelText } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    const cur = store().engine!.home.tactics.instructions.pressing
    fireEvent.change(getByLabelText('압박'), { target: { value: String(cur + 10) } })
    fireEvent.click(getByRole('button', { name: '터치라인 지시' }))
    expect(store().engine!.home.tactics.instructions.pressing).toBe(cur + 10)
    expect(store().lastInterventionMinute).toBe(store().engine!.minute)
    expect(store().touchlineWindow!.minute).toBe(store().engine!.minute)
    // 같은 창 안이므로 슬라이더는 계속 열려 있고,
    const el = getByLabelText('압박') as HTMLInputElement
    expect(el.disabled).toBe(false)
    // ★ 사용자 보고의 재현 방지: 적용 후에도 좌표계는 절대 0~100이고 손잡이는 적용값에 선다.
    //   (예전엔 min/max가 base±15로 잘려 적용값이 늘 트랙 한가운데로 보였다.)
    expect(Number(el.min)).toBe(0)
    expect(Number(el.max)).toBe(100)
    expect(Number(el.value)).toBe(cur + 10)
    // **폭의 기준점은 창 스냅샷 그대로**다 — 여기서 다시 +15를 얻어 우회할 수 없다.
    fireEvent.change(el, { target: { value: '100' } })
    expect(Number(el.value)).toBe(Math.min(100, cur + 15))
  })

  it('감독 타임: 쿨다운 중(창 없음)에는 슬라이더가 잠기고 남은 분이 화면에 있다', () => {
    const { getByRole, getByLabelText, container } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    act(() => {
      useMatchStore.setState({ lastInterventionMinute: store().engine!.minute, touchlineWindow: null })
    })
    expect((getByLabelText('압박') as HTMLInputElement).disabled).toBe(true)
    expect(container.querySelector('.cs-touchline')!.textContent).toContain('쿨다운')
  })

  it('하이드레이션 브레이크에서는 4축 전부 열리고 버튼 라벨이 [지시 적용]이다', () => {
    const { getByRole, getByLabelText } = mountAt('paused-break')
    expect((getByLabelText('라인') as HTMLInputElement).disabled).toBe(false)
    expect(getByRole('button', { name: '지시 적용' })).toBeTruthy()
  })
})

// ── 작전판 재설계(사용자 지시 2026-08-01) ───────────────────────────────
// 두 가지를 고정한다. (1) 주 CTA는 헤더 우측에 있고 푸터에는 없다 — 900px 높이에서
// 접힌 아래로 가지 않는 유일한 방법이 sticky 헤더다. (2) 전술 탭은 서브탭 3장으로
// 나뉘되 서브탭 전환이 유저 입력을 잃지 않는다.
describe('TacticsBoard — 주 CTA는 헤더 우측(스크롤과 무관)', () => {
  it('[후반 시작]이 헤더 안에 있고 푸터는 없다', () => {
    const { container } = mountAt('halftime')
    const go = container.querySelector('.tb-head__go') as HTMLButtonElement
    expect(go).toBeTruthy()
    expect(go.textContent).toContain('후반 시작')
    // 헤더의 자손이어야 한다 — 문서 아래에 또 하나 두면 "어느 쪽이 진짜냐"가 된다.
    expect(container.querySelector('.tb-head')!.contains(go)).toBe(true)
    expect(container.querySelector('.tb-foot')).toBeNull()
    expect(container.querySelectorAll('.tb-head__go').length).toBe(1)
  })

  it('스코어를 밀어내지 않는다 — 스코어가 남아 있고 CTA는 그 오른쪽이다', () => {
    const { container } = mountAt('paused-break')
    const score = container.querySelector('.tb-head__score')!
    const go = container.querySelector('.tb-head__go')!
    expect(score).toBeTruthy()
    // 문서 순서가 곧 시각 순서다(둘 다 .tb-head__right의 형제).
    expect(score.compareDocumentPosition(go) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('CTA를 누르면 재개된다(푸터에 있던 계약 그대로)', () => {
    const { getByRole } = mountAt('halftime')
    fireEvent.click(getByRole('button', { name: '후반 시작' }))
    expect(store().phase).not.toBe('halftime')
  })
})

describe('TacticsBoard — 전술 탭 서브탭(지시 / 태세 / 세트피스·대형)', () => {
  it('서브탭 3장이 뜨고 기본은 지시다', () => {
    const { container } = mountAt('paused-break')
    const labels = Array.from(container.querySelectorAll('.tw-tab')).map(e => e.textContent)
    expect(labels.length).toBe(3)
    expect(labels[0]).toContain('지시')
    expect(labels[1]).toContain('태세')
    expect(labels[2]).toContain('세트피스')
    expect(container.querySelector('.tw-tab--active')!.textContent).toContain('지시')
  })

  it('서브탭을 옮겼다 돌아와도 만지던 슬라이더 값이 남는다(입력 보존)', () => {
    const { container, getByLabelText } = mountAt('paused-break')
    const cur = store().engine!.home.tactics.instructions.pressing
    fireEvent.change(getByLabelText('압박'), { target: { value: String(cur + 20) } })
    expect(Number((getByLabelText('압박') as HTMLInputElement).value)).toBe(cur + 20)
    // 태세 → 세트피스 → 지시로 한 바퀴 돌고 온다.
    openSubtab(container, '태세')
    openSubtab(container, '세트피스')
    openSubtab(container, '지시')
    expect(Number((getByLabelText('압박') as HTMLInputElement).value)).toBe(cur + 20)
    // 엔진은 여전히 그대로다 — 반영은 [지시 적용]에서만.
    expect(store().engine!.home.tactics.instructions.pressing).toBe(cur)
  })

  it('미적용 변경이 있으면 지시 탭에 표시가 붙고, 다른 탭에서는 한 줄로 알린다', () => {
    const { container, getByLabelText, getByRole } = mountAt('paused-break')
    expect(container.querySelector('.tw-tab__mark')).toBeNull()
    expect(container.querySelector('.tw-dirty')).toBeNull()

    const cur = store().engine!.home.tactics.instructions.tempo
    fireEvent.change(getByLabelText('템포'), { target: { value: String(cur + 10) } })
    // 지시 탭에 "미적용" 평문 배지(이모지·색점이 아니다).
    const mark = container.querySelector('.tw-tab__mark')!
    expect(mark.textContent).toBe('미적용')
    expect(mark.closest('.tw-tab')!.textContent).toContain('지시')
    // 지시 탭에 있는 동안에는 안내를 겹쳐 적지 않는다 — [지시 적용] 버튼이 이미 말한다.
    expect(container.querySelector('.tw-dirty')).toBeNull()

    openSubtab(container, '태세')
    expect(container.querySelector('.tw-dirty')!.textContent).toContain('적용하지 않은 변경')

    // 적용하면 표시가 사라진다.
    openSubtab(container, '지시')
    fireEvent.click(getByRole('button', { name: '지시 적용' }))
    expect(store().engine!.home.tactics.instructions.tempo).toBe(cur + 10)
    expect(container.querySelector('.tw-tab__mark')).toBeNull()
  })

  it('태세·세트피스는 즉시 반영이므로 미적용 표시를 만들지 않는다', () => {
    const { container, getByRole } = mountAt('paused-break')
    openSubtab(container, '태세')
    fireEvent.click(getByRole('button', { name: '크로스' }))
    expect(store().engine!.home.tactics.attackPattern).toBe('cross')
    expect(container.querySelector('.tw-tab__mark')).toBeNull()
    expect(container.querySelector('.tw-dirty')).toBeNull()
  })

  it('감독 타임: 잠긴 축이 열기 전에 탭 라벨에 표시되고, 열면 이유가 있다', () => {
    const { container } = mountAt('paused-user')
    const lock = container.querySelector('.tw-tab__lock')!
    expect(lock.textContent).toContain('대형 잠김')
    expect(lock.closest('.tw-tab')!.textContent).toContain('세트피스')
    openSubtab(container, '세트피스')
    // 탭 전체가 죽은 것이 아니다 — 세트피스 3축은 열려 있다.
    const sp = container.querySelector('[aria-label="세트피스"]')!
    expect(Array.from(sp.querySelectorAll('button')).every(b => (b as HTMLButtonElement).disabled)).toBe(false)
    // 잠긴 축에는 이유와 해제 시점이 붙어 있다.
    const pf = container.querySelector('[aria-label="페이즈 포메이션"]')!
    expect(pf.textContent).toContain('잠김')
    expect(pf.textContent).toContain(`${store().schedule!.firstHydration}분`)
  })
})
