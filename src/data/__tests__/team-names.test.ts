// src/data/__tests__/team-names.test.ts
// 팀 한국어 표기의 안전망.
//
// 왜 이 파일이 있는가(2026-08-02):
//   기자회견·회견 화면·신문 카드가 각자 `OPPONENT_KO` 표를 복붙해 들고 있었고, 셋 다
//   `?? id` 폴백이라 표에 빠진 팀은 **코드값('rsa')이 그대로** 화면·신문·AI 헤드라인
//   프롬프트로 나갔다. 실패가 실패로 보이지 않는 구조였다.
//   이제 정본은 팀 JSON의 name.ko 하나이고(src/data/loader.ts), 이 테스트가
//   "팀이 늘었는데 이름이 없다"를 커밋 전에 깨뜨린다.
import { describe, it, expect } from 'vitest'
import { TEAM_IDS, teamNameKo, teamNameShortKo, type TeamId } from '../loader'
import { buildQuestions, buildHeadline, describeMatch } from '../../game/pressconf'
import type { MatchRecord } from '../../game/campaignStore'

describe('팀 한국어 표기 정본', () => {
  it('12개국 전부가 한국어 이름을 갖는다', () => {
    expect(TEAM_IDS).toHaveLength(12)
    for (const id of TEAM_IDS) {
      const ko = teamNameKo(id)
      expect(ko.length).toBeGreaterThan(0)
      // 한글이 한 글자라도 있어야 한다 — 코드값('rsa')이 통과하는 것을 막는다.
      expect(ko).toMatch(/[가-힣]/)
    }
  })

  it('이름이 없는 팀은 조용히 코드값을 뱉지 않고 던진다', () => {
    // 존재하지 않는 id는 타입이 먼저 막지만, 데이터가 깨진 경우의 계약도 못 박는다.
    expect(() => teamNameKo('jpn' as TeamId)).toThrow(/teamNameKo/)
  })

  it('짧은 표기는 축약이 필요한 팀만 다르고 나머지는 정본과 같다', () => {
    // 두 표기가 공존하는 유일한 이유는 신문 PNG 스코어박스의 고정 폭이다(loader.ts 주석).
    expect(teamNameShortKo('rsa')).toBe('남아공')
    expect(teamNameKo('rsa')).toBe('남아프리카공화국')
    for (const id of TEAM_IDS) {
      if (id === 'rsa') continue
      expect(teamNameShortKo(id)).toBe(teamNameKo(id))
    }
    // 축약은 실제로 짧아야 의미가 있다.
    expect(teamNameShortKo('rsa').length).toBeLessThan(teamNameKo('rsa').length)
  })
})

function recordFor(opponentId: TeamId): MatchRecord {
  return { stage: 'group1', opponentId, score: [2, 1], decisions: [] }
}

describe('기자회견·신문이 코드값을 화면에 내보내지 않는다', () => {
  it('질문·헤드라인 어디에도 팀 코드가 남지 않는다', () => {
    for (const id of TEAM_IDS) {
      if (id === 'kor') continue // kor은 우리 팀이라 상대가 되지 않는다
      const r = recordFor(id)
      const texts = [
        ...buildQuestions(r, []).flatMap(q => [q.text, ...q.options]),
        ...Object.values(buildHeadline(r, ['최선을 다했습니다.'], '대한민국')),
      ]
      for (const t of texts) {
        // 코드값이 낱말 경계로 튀어나오면 실패. (한국어 문장에 영소문자 3글자 코드가
        // 정상적으로 등장할 일은 없다.)
        expect(t).not.toMatch(new RegExp(`\\b${id}\\b`))
      }
    }
  })

  it('AI 헤드라인 프롬프트의 상대 팀은 한국어 정본이다', () => {
    // 이 값이 신문 1면 제목이 된다 — 코드값이 섞이면 "rsa전 아쉬운 패배"가 인쇄된다.
    const card = describeMatch(recordFor('rsa'), '대한민국')
    expect(card['상대_팀']).toBe('남아프리카공화국')
    expect(card['최종_스코어']).toBe('대한민국 2-1 남아프리카공화국')
    expect(String(card['한줄_사실'])).not.toMatch(/\brsa\b/)
  })
})
