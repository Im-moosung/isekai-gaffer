// @vitest-environment jsdom
// src/ui/pitch/__tests__/gravity-marker.test.tsx
// 무게중심 마커 = **멘탈리티가 보드에서 보이는 유일한 도형**. 지키는 것은 두 가지다.
//  ① 멘탈리티가 다르면 마커가 실제로 다른 자리에 있다 — 사용자 요구 그 자체다
//     ("멘탈리티를 건드릴 때 눈으로 알 수만 있으면 돼").
//  ② 마커는 **파생 표시**다 — 태세를 바꿔도 선수 도트는 한 칸도 움직이지 않는다.
//     ②가 깨졌다는 건 멘탈리티가 좌표 생성에 스며들었다는 뜻이고, 그러면 shape.ts의
//     "백라인 평균 == lineDepth(lineHeight)" 계약이 위험해진다(그 파일 상단 논증).
import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { PitchView } from '../PitchView'
import { gravityMark } from '../AnalysisLayer'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch } from '../../../engine/simulate'
import { MENTALITIES } from '../../../engine/tactics'
import type { Mentality } from '../../../engine/types'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)

afterEach(cleanup)

function board(mentality: Mentality) {
  const st = createMatch(home, away, { seed: 42 })
  st.home.tactics.mentality = mentality
  return render(<PitchView state={st} variant="tactics" analysis />)
}

/** 마커의 화면 좌표 — translate(x, y)는 인라인 style로 나간다(CSS transition을 태우려고). */
function markerXY(container: HTMLElement): { x: number; y: number } {
  const el = container.querySelector('.an-grav') as SVGGElement | null
  expect(el, '무게중심 마커가 보드에 있어야 한다').not.toBeNull()
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el!.style.transform ?? '')
  expect(m, `translate를 못 읽었다: ${el!.style.transform}`).not.toBeNull()
  return { x: Number(m![1]), y: Number(m![2]) }
}

function dotXs(container: HTMLElement): number[] {
  return [...container.querySelectorAll('.pv-dot--home')].map(n => Number(n.getAttribute('cx')))
}

describe('★ 무게중심 마커 — 멘탈리티가 눈에 보인다', () => {
  it('다섯 단계가 서로 다른 자리에 마커를 놓는다(공격적일수록 앞으로)', () => {
    const xs: number[] = []
    for (const m of MENTALITIES) {
      const { container, unmount } = board(m)
      xs.push(markerXY(container).x)
      unmount()
    }
    expect(new Set(xs).size, `단계별 x: ${xs.join(', ')}`).toBe(MENTALITIES.length)
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1])
    // 양 극단 차이는 viewBox(105m) 기준 10m 이상 — "눈으로 알 수 있다"의 하한.
    expect(xs[xs.length - 1] - xs[0]).toBeGreaterThan(10)
  })

  it('멘탈리티를 바꿔도 선수 도트는 움직이지 않는다(파생 표시 계약)', () => {
    const a = board('very-defensive')
    const before = dotXs(a.container)
    a.unmount()
    const b = board('very-attacking')
    expect(dotXs(b.container)).toEqual(before)
    expect(before.length).toBe(11)
  })
})

describe('무게중심 좌표 계산', () => {
  const BASE = { x: 50, y: 50 }
  it('균형(과 미지정)은 기준점 그대로다', () => {
    expect(gravityMark(BASE, 'balanced')).toEqual(BASE)
    expect(gravityMark(BASE, undefined)).toEqual(BASE)
  })
  it('y는 움직이지 않는다 — 태세는 앞뒤 이야기다', () => {
    for (const m of MENTALITIES) expect(gravityMark({ x: 40, y: 37 }, m).y).toBe(37)
  })
  it('양 극단에서도 피치 밖으로 나가지 않는다', () => {
    for (const m of MENTALITIES) {
      for (const base of [{ x: 2, y: 50 }, { x: 98, y: 50 }]) {
        const g = gravityMark(base, m)
        expect(g.x).toBeGreaterThanOrEqual(5)
        expect(g.x).toBeLessThanOrEqual(95)
      }
    }
  })
})
