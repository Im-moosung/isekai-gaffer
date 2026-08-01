// src/ai/aiClient.ts
// 브라우저 측 AI 내레이션 클라이언트. /api/narrate 프록시를 호출한다.
// 실패·타임아웃·503·세이프가드 위반은 모두 조용히 null 로 폴백하여
// 호출부가 로컬 템플릿(pressconf 등)으로 대체하게 한다(설계 §7 폴백 원칙).

import { safeguardFilter } from './safeguard'
import type { NarrateTask } from './prompts'

/** 클라이언트 측 하드 타임아웃. 서버 내부(2.5s)보다 약간 길게 둔다. */
/**
 * 클라이언트 상한. 서버 상한(9s)보다 길어야 서버의 502가 유저에게 닿는다.
 *
 * ★ 3000ms는 Gemini Flash-Lite 기준이었다. gpt-5-nano로 바꾸면서 늘렸다.
 *   **기다리게 해도 되는 이유**: 두 호출부 모두 화면을 막지 않는다 — 엔딩은 템플릿을
 *   먼저 그려 놓고 도착하면 갈아끼우고, 기자회견은 아래 HEADLINE_TIMEOUT_MS로 따로
 *   짧게 잡는다(그쪽은 await가 화면을 막는다).
 */
const CLIENT_TIMEOUT_MS = 6000

/** 기자회견 헤드라인 전용 상한 — 그 호출은 await로 화면을 막는다. */
export const HEADLINE_TIMEOUT_MS = 6000  // 실측 1.75초 · 서버 상한 5초보다 길게

/**
 * AI 내레이션을 요청한다. 성공 시 세이프가드를 통과한 텍스트, 그 외에는 null.
 * 콘솔 에러는 남기지 않으며, 폴백 시 경고 1줄만 허용한다.
 */
export async function narrate(
  task: NarrateTask,
  context: Record<string, unknown>,
  timeoutMs: number = CLIENT_TIMEOUT_MS,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
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
