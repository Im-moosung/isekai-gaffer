import { describe, it, expect } from 'vitest'
import { TEAM_TALK_LINES, getLine } from '../teamTalkLines'
import type { ScoreSituation, TeamTalkTone } from '../matchStore'

const TONES: TeamTalkTone[] = ['rage', 'encourage', 'calm', 'trust']
const SITUATIONS: ScoreSituation[] = ['losing', 'drawing', 'winning']

// 리서치 문서 docs/research/team-talk-styles.md Part 2 표의 금지어 검수 대상.
const BANNED = ['최악', '한심', '형편없', '멍청']

describe('teamTalkLines (24문장 세트)', () => {
  it('4톤 × 상황 3 × 변형 2 = 24문장이 모두 존재한다', () => {
    let count = 0
    for (const tone of TONES) {
      for (const sit of SITUATIONS) {
        const pair = TEAM_TALK_LINES[tone][sit]
        expect(pair).toHaveLength(2)
        for (const line of pair) {
          expect(typeof line).toBe('string')
          expect(line.length).toBeGreaterThan(0)
          count++
        }
      }
    }
    expect(count).toBe(24)
  })

  it('금지어가 하나도 없다', () => {
    for (const tone of TONES) {
      for (const sit of SITUATIONS) {
        for (const line of TEAM_TALK_LINES[tone][sit]) {
          for (const w of BANNED) expect(line).not.toContain(w)
        }
      }
    }
  })

  it('리서치 정본 표본 전사(셀 대조)', () => {
    expect(TEAM_TALK_LINES.rage.losing[0]).toBe('이 유니폼이 무겁게 느껴진다면, 그 무게로 뛰어라.')
    expect(TEAM_TALK_LINES.encourage.losing[0]).toBe('우린 이런 밤을 위해 뛴다. 잃을 게 없다, 가자.')
    expect(TEAM_TALK_LINES.calm.winning[1]).toBe('집중만 유지하면 된다. 마지막 15분, 우리가 관리한다.')
    expect(TEAM_TALK_LINES.trust.drawing[1]).toBe('서로를 믿어라. 우린 한 가족처럼 이 경기를 끌고 간다.')
  })

  it('getLine: 시드 홀짝으로 변형 A/B 결정론 선택', () => {
    // 짝수 시드 → A, 홀수 시드 → B, 음수도 안전.
    expect(getLine('rage', 'losing', 42)).toBe(TEAM_TALK_LINES.rage.losing[0])
    expect(getLine('rage', 'losing', 43)).toBe(TEAM_TALK_LINES.rage.losing[1])
    expect(getLine('calm', 'drawing', 0)).toBe(TEAM_TALK_LINES.calm.drawing[0])
    expect(getLine('calm', 'drawing', -1)).toBe(TEAM_TALK_LINES.calm.drawing[1])
    // 동일 인자 반복 → 동일 결과(재현성)
    expect(getLine('trust', 'winning', 7)).toBe(getLine('trust', 'winning', 7))
  })
})
