// src/ai/aiClient.ts
// 브라우저 측 AI 내레이션 클라이언트. /api/narrate 프록시를 호출한다.
// 실패·타임아웃·503·세이프가드 위반은 모두 조용히 null 로 폴백하여
// 호출부가 로컬 템플릿(pressconf 등)으로 대체하게 한다(설계 §7 폴백 원칙).

import { safeguardFilter } from './safeguard'
import type { NarrateTask } from './prompts'

/** 클라이언트 측 하드 타임아웃. 서버 내부(2.5s)보다 약간 길게 둔다. */
const CLIENT_TIMEOUT_MS = 3000

/**
 * AI 내레이션을 요청한다. 성공 시 세이프가드를 통과한 텍스트, 그 외에는 null.
 * 콘솔 에러는 남기지 않으며, 폴백 시 경고 1줄만 허용한다.
 */
export async function narrate(
  task: NarrateTask,
  context: Record<string, unknown>,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS)
  try {
    const res = await fetch('/api/narrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, context }),
      signal: controller.signal,
    })
    if (!res.ok) return null // 503(키 부재)·502(업스트림)·기타 비정상
    const data = (await res.json()) as { text?: unknown }
    const text = typeof data?.text === 'string' ? data.text : null
    if (text === null) return null
    if (!safeguardFilter(text)) return null
    return text
  } catch {
    // 네트워크 오류·타임아웃(abort)·JSON 파싱 실패 — 조용한 폴백
    console.warn('[aiClient] AI 내레이션 폴백: 로컬 템플릿을 사용합니다.')
    return null
  } finally {
    clearTimeout(timer)
  }
}
