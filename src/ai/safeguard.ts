// src/ai/safeguard.ts
// 출력 후처리 세이프가드 (설계 §7.1의 3단 방어 중 2단).
// AI/템플릿이 만든 텍스트를 표시 직전에 걸러 비하·조롱 표현과 비정상 길이를 차단한다.

/** 비하·조롱 어휘 사전. 테스트·확장용으로 export. */
export const DEROGATORY_WORDS: readonly string[] = [
  '최악', '한심', '형편없', '멍청', '쓰레기',
  '무능', '창피', '수치', '바보', '병신',
  '찌질', '저능', '굴욕', '머저리', '등신',
  '쪽팔', '호구', '졸렬', '추태', '얼간이',
]

/** 허용 최대 길이(자). 이 값을 초과하면 차단. */
export const MAX_TEXT_LENGTH = 600

/**
 * 표시 가능한 텍스트인지 판정한다.
 * (a) 비하 어휘 사전 단어가 포함되면 false
 * (b) 공백 제외 길이 0 또는 원문 길이 600 초과면 false
 * (c) 그 외 true
 */
export function safeguardFilter(text: string): boolean {
  if (typeof text !== 'string') return false
  if (text.trim().length === 0) return false
  if (text.length > MAX_TEXT_LENGTH) return false
  for (const word of DEROGATORY_WORDS) {
    if (text.includes(word)) return false
  }
  return true
}
