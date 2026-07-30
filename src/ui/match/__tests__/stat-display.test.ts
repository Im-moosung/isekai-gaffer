import { describe, it, expect } from 'vitest'
import { possessionView, countLine, GATE_RAW_MIN } from '../stat-display'

describe('possessionView — 초반 표본 억제(사용자 지적 "2분에 100%")', () => {
  it('게이트 A: 5분 미만이면 값을 내지 않고 바는 50:50 중립', () => {
    const v = possessionView(2, 100, 0)
    expect(v.usLabel).toBe('—')
    expect(v.themLabel).toBe('—')
    expect(v.usBar).toBe(50)
    expect(v.suppressed).toBe(true)
    expect(v.caption).toBe('집계 중')
  })

  it('게이트 A: 표본이 충분하면 5분 전이라도 값을 낸다', () => {
    const v = possessionView(3, 60, 40, 40)
    expect(v.suppressed).toBe(false)
  })

  it('데이터가 아예 없으면(합 0) 억제한다 — 0을 색칠하지 않는다', () => {
    expect(possessionView(40, 0, 0).suppressed).toBe(true)
  })

  it('게이트 B: 5~15분은 50%로 수축한다 — 극단값이 완화된다', () => {
    const raw = possessionView(30, 100, 0)
    const shrunk = possessionView(5, 100, 0)
    expect(raw.usBar).toBe(100)
    expect(shrunk.usBar).toBeLessThan(raw.usBar)
    expect(shrunk.usBar).toBeGreaterThan(50)
  })

  it('게이트 B: 수축량은 15분에 가까울수록 줄어든다(단조 수렴)', () => {
    const at5 = possessionView(5, 80, 20).usBar
    const at10 = possessionView(10, 80, 20).usBar
    const at14 = possessionView(14, 80, 20).usBar
    expect(at5).toBeLessThan(at10)
    expect(at10).toBeLessThan(at14)
    expect(at14).toBeLessThan(80)
  })

  it('게이트 C: 15분부터는 원본값 그대로', () => {
    const v = possessionView(GATE_RAW_MIN, 62, 38)
    expect(v.usBar).toBe(62)
    expect(v.usLabel).toBe('62%')
    expect(v.themLabel).toBe('38%')
  })

  it('두 표시값의 합은 언제나 100 — 반올림으로 어긋나지 않는다', () => {
    for (let m = 15; m <= 90; m += 5) {
      for (const us of [33.3, 49.7, 51.4, 66.6]) {
        const v = possessionView(m, us, 100 - us)
        const sum = parseInt(v.usLabel, 10) + parseInt(v.themLabel, 10)
        expect(sum).toBe(100)
      }
    }
  })

  it('소수점을 내지 않는다 — 제공사 간 4~6%p 차이가 나는 지표다', () => {
    expect(possessionView(60, 58.4, 41.6).usLabel).toBe('58%')
  })

  it('비율에는 언제나 분모(표본)를 병기한다', () => {
    expect(possessionView(60, 58, 42).caption).toContain('60분')
  })
})

describe('countLine — 누적량은 억제하지 않는다', () => {
  it('1분부터 정직한 수치를 그대로 이어 붙인다', () => {
    expect(countLine([{ label: '슛', us: 7, them: 3 }, { label: '유효', us: 3, them: 1 }]))
      .toBe('슛 7-3 · 유효 3-1')
  })
})
