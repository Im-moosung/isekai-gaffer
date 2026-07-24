// src/ai/requestGuard.ts
// 프록시(api/narrate.ts) 입력 검증 + 레이트리밋 판정의 순수 함수 모음.
// DOM/네트워크/모듈 스코프 상태 없음 — vitest(node)에서 그대로 단위 테스트 가능하도록
// 순수하게 유지한다. Map 등 상태 보관은 호출부(api/narrate.ts)가 담당한다.

import type { NarrateTask } from './prompts'

/** 요청 body 원문(JSON 직렬화) 최대 길이(자). 초과 시 413. */
export const MAX_BODY_CHARS = 4000
/** 분당 IP별 최대 요청 수. 초과 시 429. */
export const RATE_LIMIT_MAX = 10
/** 레이트리밋 윈도(ms). */
export const RATE_LIMIT_WINDOW_MS = 60_000

const VALID_TASKS: readonly NarrateTask[] = ['pressq', 'headline', 'epilogue']

export type ValidationResult =
  | { ok: true; task: NarrateTask; context: Record<string, unknown> }
  | { ok: false; status: number; error: string }

/**
 * 요청 body 원문(문자열)을 검증한다.
 * (a) 원문 길이 MAX_BODY_CHARS 초과 → 413
 * (b) JSON 파싱 실패 → 400
 * (c) task가 'pressq'|'headline'|'epilogue' 외 → 400
 * (d) context가 object(비배열·비null)가 아니면 → 400
 */
export function validateNarrateRequest(rawBody: string): ValidationResult {
  if (rawBody.length > MAX_BODY_CHARS) {
    return { ok: false, status: 413, error: 'payload too large' }
  }
  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { ok: false, status: 400, error: 'invalid json body' }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: 400, error: 'invalid body' }
  }
  const { task, context } = body as { task?: unknown; context?: unknown }
  if (!VALID_TASKS.includes(task as NarrateTask)) {
    return { ok: false, status: 400, error: 'invalid task' }
  }
  if (typeof context !== 'object' || context === null || Array.isArray(context)) {
    return { ok: false, status: 400, error: 'invalid context' }
  }
  return { ok: true, task: task as NarrateTask, context: context as Record<string, unknown> }
}

/** x-forwarded-for 헤더에서 클라이언트 IP(첫 항목)를 추출한다. 없으면 'unknown'. */
export function firstForwardedIp(header: string | null | undefined): string {
  const first = (header ?? '').split(',')[0]?.trim()
  return first && first.length > 0 ? first : 'unknown'
}

/**
 * 슬라이딩 윈도 레이트리밋 판정(순수).
 * @param timestamps 해당 IP의 기존 요청 타임스탬프(ms) 배열
 * @param now 현재 시각(ms)
 * @returns allowed 판정 + 윈도 밖 항목을 정리하고(now 포함 시) 갱신된 배열.
 *          호출부는 반환된 timestamps를 그대로 다시 저장하면 메모리 누수가 방지된다.
 */
export function rateLimitCheck(
  timestamps: readonly number[],
  now: number,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
  max: number = RATE_LIMIT_MAX,
): { allowed: boolean; timestamps: number[] } {
  const kept = timestamps.filter((t) => now - t < windowMs)
  if (kept.length >= max) return { allowed: false, timestamps: kept }
  kept.push(now)
  return { allowed: true, timestamps: kept }
}
