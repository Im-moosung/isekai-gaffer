import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, buildUserPrompt } from '../prompts'
import { describeMatch, describeCampaign } from '../../game/pressconf'

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
  // ── 사실 왜곡 방지(2026-08-02 결함: 2-5 패배가 "5-2 대승"으로 뒤집힘) ──
  // 프롬프트 문자열만 읽고도 사람이 승패를 틀릴 수 없어야 한다. 그 조건을
  // "패배 경기 사실 카드"로 만든 실제 문자열에 대해 검사한다.
  const lossCtx = describeMatch(
    { stage: 'group2', opponentId: 'mex', score: [2, 5], decisions: [] },
    '대한민국',
  )

  it('headline: 패배 맥락이면 승패·양 팀 득점이 명시적으로 들어간다', () => {
    const p = buildUserPrompt('headline', lossCtx)
    expect(p).toContain('"우리_팀": "대한민국"')
    expect(p).toContain('"우리_팀_득점": 2')
    expect(p).toContain('"상대_팀": "멕시코"')
    expect(p).toContain('"상대_팀_득점": 5')
    expect(p).toContain('"최종_결과": "패배"')
    expect(p).toContain('대한민국 2-5 멕시코')
    // 배열 인덱스에 의존하는 옛 표현이 남아 있지 않다.
    expect(p).not.toContain('"score"')
    expect(p).not.toContain('opponentId')
    // 주입된 맥락 블록 안에는 승리 어휘가 한 글자도 없다 — 모델이 주워 쓸 근거를 남기지 않는다.
    const injected = p.slice(p.indexOf('맥락(결과·답변 톤): '))
    expect(injected).not.toContain('승리')
    expect(injected).toContain('졌다')
  })

  it('세 task 모두 사실 왜곡 금지 조항을 포함한다', () => {
    for (const task of ['pressq', 'headline', 'epilogue'] as const) {
      const p = buildUserPrompt(task, lossCtx)
      expect(p).toContain('사실 제약')
      expect(p).toContain('바꾸지 마세요')
      expect(p).toContain('지어내지 마세요')
    }
    expect(buildUserPrompt('headline', lossCtx)).toContain('진 경기를 이긴 것처럼')
  })

  it('epilogue: 캠페인 전적·도달 단계·우승 여부가 명시적으로 들어간다', () => {
    const p = buildUserPrompt('epilogue', describeCampaign(
      [
        { stage: 'group1', opponentId: 'cze', score: [0, 1], decisions: [] },
        { stage: 'group2', opponentId: 'mex', score: [2, 5], decisions: [] },
      ],
      { reached: 'group3', champion: false },
    ))
    expect(p).toContain('"통산_전적": "0승 0무 2패"')
    expect(p).toContain('"우승_여부": false')
    expect(p).toContain('조별리그 3차전')
    expect(p).toContain('우승하지 못했다')
  })

  it('순수 함수: 같은 입력 = 같은 출력', () => {
    const ctx = { score: '0-0' }
    expect(buildUserPrompt('pressq', ctx)).toBe(buildUserPrompt('pressq', ctx))
  })
})
