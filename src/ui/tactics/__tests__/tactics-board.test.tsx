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
    const { getByRole } = mountAt('paused-break')
    expect(store().engine!.home.tactics.mentality ?? 'balanced').toBe('balanced')
    fireEvent.click(getByRole('button', { name: '공격적', pressed: false }))
    expect(store().engine!.home.tactics.mentality).toBe('attacking')
  })

  it('그룹 적극성: 공격 라인 [적극] → groupIntensity.attack=1', () => {
    const { getByRole } = mountAt('paused-break')
    const grp = getByRole('group', { name: '공격 적극성' })
    fireEvent.click(within(grp).getByRole('button', { name: '적극' }))
    expect(store().engine!.home.tactics.groupIntensity!.attack).toBe(1)
    expect(store().engine!.home.tactics.groupIntensity!.midfield).toBe(0)
  })

  it('공격 패턴 4택: [중거리] 선택 → attackPattern=longshot', () => {
    const { getByRole } = mountAt('paused-break')
    fireEvent.click(getByRole('button', { name: '중거리' }))
    expect(store().engine!.home.tactics.attackPattern).toBe('longshot')
  })

  it('GK 파워플레이: 조건 미충족(1분·비지는중)엔 잠금+사유', () => {
    const { getByRole, getByText } = mountAt('paused-break')
    const btn = getByRole('button', { name: 'GK 전진' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(getByText(/85' 이후에만 가능/)).toBeTruthy()
  })

  it('GK 파워플레이: 85\'+ & 지는 중이면 해제 → 토글 반영', () => {
    const { getByRole } = mountAt('paused-break')
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

  // 네이티브 <select>는 폐지했다(OS 기본 스타일이 그대로 나오고, 7개짜리 배타 선택은
  // 열지 않고도 후보를 보이는 편이 낫다). 세그먼트 버튼으로 같은 계약을 검증한다.
  it('페이즈 포메이션: 공격 시 3-5-2 선택 → phaseFormations.attack', () => {
    const { getByRole } = mountAt('paused-break')
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
    expect(container.querySelector('.tb-foot__reason')!.textContent).toContain('전반 종료')
  })

  it('정지(감독 타임)엔 팀토크 없음 + [전술 확정] 라벨', () => {
    const { getByRole, container } = mountAt('paused-user')
    expect(container.querySelector('.tt-root')).toBeNull()
    expect(getByRole('button', { name: '전술 확정' })).toBeTruthy()
    expect(container.querySelector('.tb-foot__reason')!.textContent).toContain('감독 타임')
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
    expect(notice.textContent).toContain('압박·템포 지시만 가능합니다')
    // 스케줄의 다음 브레이크 분이 문구에 그대로 들어간다(1분 시점 → 첫 하이드레이션).
    expect(notice.textContent).toContain(`${store().schedule!.firstHydration}분`)
    expect((getByRole('button', { name: '5-4-1' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('감독 타임: 교체 탭이 먼저 열리고 교체는 가능하다', () => {
    const { getByRole } = mountAt('paused-user')
    expect(getByRole('tab', { name: '교체' }).getAttribute('aria-selected')).toBe('true')
    const home = store().engine!.home
    const out = home.tactics.lineup[10].playerId
    const inId = home.team.squad.find(p => !home.tactics.lineup.some(l => l.playerId === p.id))!.id
    act(() => { store().submitCommand('home', { type: 'sub', out, in: inId }) })
    expect(store().engine!.home.subsUsed).toBe(1)
  })

  it('감독 타임: 전술 탭은 잠금 안내를 띄우고 멘탈리티 버튼이 비활성이다', () => {
    const { getByRole, container } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    expect(container.querySelector('.tb-locked')!.textContent).toContain('포메이션·태세·세트피스는 잠김')
    expect((getByRole('button', { name: '매우 공격적' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('하이드레이션 브레이크: 안내가 없고 포메이션 버튼이 열린다', () => {
    const { container, getByRole } = mountAt('paused-break')
    expect(container.querySelector('.tb-touchline')).toBeNull()
    expect((getByRole('button', { name: '5-4-1' }) as HTMLButtonElement).disabled).toBe(false)
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
    const { getByRole } = mountAt('paused-break')
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

  it('추천의 근거(상대 GK 제공권·역습 위험 지수)를 화면에 적는다', () => {
    const { container } = mountAt('paused-break')
    const grp = container.querySelector('[aria-label="세트피스"]')!
    expect(grp.textContent).toContain('상대 GK 제공권')
    expect(grp.textContent).toContain('역습 위험 지수')
    expect(grp.querySelector('.tx-btn__rec')).toBeTruthy()
  })

  it('터치라인 등급에서는 세트피스가 잠긴다(훈련장에서 약속하는 루틴)', () => {
    const { getByRole } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    expect((getByRole('button', { name: '코너 루트 니어' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('TacticsBoard — 터치라인 지시 개방(사용자 지시 ③)', () => {
  it('감독 타임: 압박·템포 슬라이더는 열리고 라인·공격방향은 잠긴다', () => {
    const { getByRole, getByLabelText } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    expect((getByLabelText('압박') as HTMLInputElement).disabled).toBe(false)
    expect((getByLabelText('템포') as HTMLInputElement).disabled).toBe(false)
    expect((getByLabelText('라인') as HTMLInputElement).disabled).toBe(true)
    expect((getByRole('button', { name: '좌측' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('감독 타임: 슬라이더 범위 자체가 ±15로 잘린다(끌 수 있는 폭이 곧 규칙)', () => {
    const { getByRole, getByLabelText } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    const cur = store().engine!.home.tactics.instructions.pressing
    const el = getByLabelText('압박') as HTMLInputElement
    expect(Number(el.min)).toBe(Math.max(0, cur - 15))
    expect(Number(el.max)).toBe(Math.min(100, cur + 15))
  })

  it('감독 타임: [터치라인 지시]로 엔진에 반영되고 쿨다운이 걸린다', () => {
    const { getByRole, getByLabelText } = mountAt('paused-user')
    fireEvent.click(getByRole('tab', { name: /전술/ }))
    const cur = store().engine!.home.tactics.instructions.pressing
    fireEvent.change(getByLabelText('압박'), { target: { value: String(cur + 10) } })
    fireEvent.click(getByRole('button', { name: '터치라인 지시' }))
    expect(store().engine!.home.tactics.instructions.pressing).toBe(cur + 10)
    expect(store().lastShoutMinute).toBe(store().engine!.minute)
    // 쿨다운 중에는 같은 축이 다시 잠긴다.
    expect((getByLabelText('압박') as HTMLInputElement).disabled).toBe(true)
  })

  it('하이드레이션 브레이크에서는 4축 전부 열리고 버튼 라벨이 [지시 적용]이다', () => {
    const { getByRole, getByLabelText } = mountAt('paused-break')
    expect((getByLabelText('라인') as HTMLInputElement).disabled).toBe(false)
    expect(getByRole('button', { name: '지시 적용' })).toBeTruthy()
  })
})
