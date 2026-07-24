import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '../prompts'

describe('buildSystemPrompt', () => {
  const sys = buildSystemPrompt()
  it('세이프가드 제약문을 포함한다', () => {
    expect(sys).toContain('실존')
    expect(sys).toContain('인용')
    expect(sys).toContain('한국어')
    expect(sys).toContain('대체역사')
    expect(sys).toContain('픽션')
  })
  it('상대 벤치 익명 조항(§7.1(a))을 포함한다', () => {
    expect(sys).toContain('상대 벤치')
    expect(sys).toContain('익명 직함')
  })
})

describe('buildUserPrompt', () => {
  it('pressq: 기자 질문 지시 + 결정로그/스코어 컨텍스트를 주입한다', () => {
    const p = buildUserPrompt('pressq', {
      score: '2-1',
      decisions: ['60\' 압박 55→90', 'HT 팀토크: 격려'],
    })
    expect(p).toContain('기자')
    expect(p).toContain('질문')
    expect(p).toContain('2-1')
    expect(p).toContain('압박 55→90')
  })
  it('headline: 답변 톤을 반영한 헤드라인 지시 + 컨텍스트 주입', () => {
    const p = buildUserPrompt('headline', { result: '승리', answers: ['자신감 넘치는 답변'] })
    expect(p).toContain('헤드라인')
    expect(p).toContain('자신감 넘치는 답변')
  })
  it('epilogue: 여정 요약 지시 + 컨텍스트 주입', () => {
    const p = buildUserPrompt('epilogue', { journey: '조별리그부터 결승까지' })
    expect(p).toContain('요약')
    expect(p).toContain('조별리그부터 결승까지')
  })
  it('순수 함수: 같은 입력 = 같은 출력', () => {
    const ctx = { score: '0-0' }
    expect(buildUserPrompt('pressq', ctx)).toBe(buildUserPrompt('pressq', ctx))
  })
})
