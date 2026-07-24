// src/online/nickname.ts
// 리더보드 닉네임 정제기 (스펙 §11: 금칙어 필터 + 길이 제한 + 기본 익명).
// 순수 함수 · 결정론. 위반 시 항상 '익명 감독'으로 대체한다.
import { DEROGATORY_WORDS } from '../ai/safeguard'

/** 위반·공백·범위 밖일 때 사용하는 기본 닉네임. */
export const DEFAULT_NICKNAME = '익명 감독'

/** 허용 닉네임 길이(자, trim 후 포함 경계). */
export const MIN_LEN = 2
export const MAX_LEN = 12

/** 욕설 사전 — safeguard의 비하 어휘(DEROGATORY_WORDS)와 합쳐 금칙어 집합을 구성한다. */
export const PROFANITY_WORDS: readonly string[] = [
  '씨발', '시발', '씨팔', '개새', '새끼', '좆', '존나', '지랄',
  '닥쳐', '꺼져', '엿먹', '보지', '자지', '섹스',
  'fuck', 'shit', 'bitch', 'asshole',
]

/** 금칙어 = 비하 어휘(safeguard 재사용) + 욕설. */
export const BANNED_WORDS: readonly string[] = [...DEROGATORY_WORDS, ...PROFANITY_WORDS]

/**
 * 닉네임을 정제한다.
 * - 문자열이 아니면 → 기본값
 * - trim 후 길이가 2~12 범위를 벗어나면 → 기본값
 * - 금칙어(비하·욕설)를 포함하면(대소문자 무시) → 기본값
 * - 그 외 → trim된 원문
 */
export function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_NICKNAME
  const trimmed = raw.trim()
  if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) return DEFAULT_NICKNAME
  const lower = trimmed.toLowerCase()
  for (const w of BANNED_WORDS) {
    if (lower.includes(w.toLowerCase())) return DEFAULT_NICKNAME
  }
  return trimmed
}
