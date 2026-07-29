// api/narrate.ts
// 프로바이더 중립 AI 프록시 (Vercel 서버리스 함수).
//
// ⚠️ 실행 환경: 이 파일은 Vercel 배포 환경에서만 /api/narrate 로 매핑되어 실행된다.
//    로컬 `vite dev` 에서는 실행되지 않는다(정적 프론트만 서빙). 로컬에서 /api/narrate 호출은
//    실패하고, aiClient.narrate() 가 조용히 null 로 폴백해 템플릿을 사용한다.
//
// 형식: Web API Request/Response 핸들러(Vercel Node/Edge 런타임 규약).
// 임포트 경로: api/ 는 프로젝트 루트의 별도 디렉터리 → src 로의 상대경로는 ../src/... 이다.
// 이 파일은 vite/앱 빌드 대상(src/)이 아니며, 로직은 최소화하고 프롬프트·세이프가드는
// 공유 모듈(src/ai/prompts.ts)에 둔다.

import { buildSystemPrompt, buildUserPrompt } from '../src/ai/prompts'
import { validateNarrateRequest, firstForwardedIp, rateLimitCheck } from '../src/ai/requestGuard'

// 모델 상수 — 배포 시점에 최신 모델로 교체 가능하도록 분리한다.
const GEMINI_MODEL = 'gemini-2.5-flash-lite' // 배포 시 gemini-3.5(-flash-lite) 계열로 교체 가능
const ANTHROPIC_MODEL = 'claude-haiku-4-5'

const MAX_TOKENS = 400
/** 업스트림(모델 API) 내부 타임아웃. 클라이언트(3s)보다 짧게. */
const UPSTREAM_TIMEOUT_MS = 2500

// 레이트리밋 상태: IP별 요청 타임스탬프.
// 서버리스 인스턴스별 베스트에포트 — 프로덕션은 KV/Upstash 권장
// (스펙 §7 남용 제어의 1차 구현, 공통 응답 캐시는 Phase 4 배포 시).
const rateLimitBuckets = new Map<string, number[]>()

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Vercel 런타임 선언 — 이 핸들러는 Web Request/Response 시그니처를 쓴다.
// 선언이 없으면 Vercel이 Node 런타임 (req, res) 규약으로 호출해 req.json()에서
// 즉시 크래시한다(FUNCTION_INVOCATION_FAILED). Edge는 fetch·AbortController·
// process.env를 모두 지원하므로 이 파일에 필요한 것이 전부 있다.
export const config = { runtime: 'edge' }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // 레이트리밋(비용 남용 방어) — 본문 파싱 전에 가장 저렴한 방어부터 적용한다.
  const ip = firstForwardedIp(req.headers.get('x-forwarded-for'))
  const now = Date.now()
  const rl = rateLimitCheck(rateLimitBuckets.get(ip) ?? [], now)
  rateLimitBuckets.set(ip, rl.timestamps) // 정리된 배열을 되써 메모리 누수 방지
  if (!rl.allowed) return json({ error: 'rate limit exceeded' }, 429)

  // 입력 크기·유효성 검증(원문 길이 캡·task 화이트리스트·context object 필수).
  const rawBody = await req.text()
  const parsed = validateNarrateRequest(rawBody)
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status)
  const { task, context } = parsed

  const provider = (process.env.AI_PROVIDER ?? 'gemini').toLowerCase()
  const system = buildSystemPrompt()
  const user = buildUserPrompt(task, context)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    let text: string | null
    if (provider === 'anthropic') {
      const key = process.env.ANTHROPIC_API_KEY
      if (!key) return json({ error: 'ANTHROPIC_API_KEY 미설정' }, 503)
      text = await callAnthropic(key, system, user, controller.signal)
    } else {
      const key = process.env.GEMINI_API_KEY
      if (!key) return json({ error: 'GEMINI_API_KEY 미설정' }, 503)
      text = await callGemini(key, system, user, controller.signal)
    }
    if (!text || text.trim().length === 0) return json({ error: 'empty response' }, 502)
    return json({ text }, 200)
  } catch {
    return json({ error: 'upstream error' }, 502)
  } finally {
    clearTimeout(timer)
  }
}

/** Google Generative Language API (Gemini) — v1beta generateContent. */
async function callGemini(
  key: string,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string | null> {
  // 키는 쿼리스트링(?key=) 대신 x-goog-api-key 헤더로 전달한다 —
  // URL은 로그·프록시·리퍼러에 남기 쉬워 크리덴셜이 노출될 수 있다.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null
}

/** Anthropic Messages API. */
async function callAnthropic(
  key: string,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string | null> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    signal,
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as { content?: { type?: string; text?: string }[] }
  const block = data.content?.find((b) => b.type === 'text') ?? data.content?.[0]
  return block?.text ?? null
}
