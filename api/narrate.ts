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
import { safeguardFilter } from '../src/ai/safeguard'

// 모델 상수 — 배포 시점에 최신 모델로 교체 가능하도록 분리한다.
const OPENAI_MODEL = 'gpt-5-nano'
const GEMINI_MODEL = 'gemini-2.5-flash-lite' // 배포 시 gemini-3.5(-flash-lite) 계열로 교체 가능
const ANTHROPIC_MODEL = 'claude-haiku-4-5'

const MAX_TOKENS = 400
/**
 * 업스트림(모델 API) 내부 타임아웃. 클라이언트보다 **짧아야** 한다 — 그래야 실패가
 * 클라이언트 abort가 아니라 502로 정직하게 돌아온다.
 *
 * ★ 2500ms는 Gemini Flash-Lite 기준이었다. gpt-5 계열은 **추론 모델**이라 그 안에
 *   못 끝낸다 — 배포 실측에서 세 번 모두 2.6~2.8초에 잘렸다(즉 인증이 아니라 시간).
 *   effort를 'minimal'로 낮추니 **실측 1.75초**로 들어왔다. 5000ms는 그 3배 여유다 —
 *   심사 중 업스트림이 느려져도 살아남고, 넘치면 템플릿으로 폴백하므로 손해가 없다.
 */
const UPSTREAM_TIMEOUT_MS = 5000

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

  // 기본 프로바이더는 openai다(2026-08-02 사용자 지정). AI_PROVIDER로 갈아탈 수 있게
  // 남겨 두는 이유: 심사 기간에 한 곳이 죽어도 환경변수 하나로 옮길 수 있어야 한다.
  const provider = (process.env.AI_PROVIDER ?? 'openai').toLowerCase()
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
    } else if (provider === 'gemini') {
      const key = process.env.GEMINI_API_KEY
      if (!key) return json({ error: 'GEMINI_API_KEY 미설정' }, 503)
      text = await callGemini(key, system, user, controller.signal)
    } else {
      const key = process.env.OPENAI_API_KEY
      if (!key) return json({ error: 'OPENAI_API_KEY 미설정' }, 503)
      text = await callOpenAI(key, system, user, controller.signal)
    }
    if (!text || text.trim().length === 0) return json({ error: 'empty response' }, 502)
    // 비하·조롱 표현은 **여기서도** 막는다. 클라이언트가 이미 같은 필터를 걸지만,
    // 걸러진 문장이 네트워크를 타고 브라우저까지 오는 것 자체를 없앤다.
    // 막히면 클라이언트는 조용히 사전 작성 문안으로 되돌아간다(설계 §7 폴백 원칙).
    if (!safeguardFilter(text)) return json({ error: 'safeguard' }, 502)
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
  // (아래 OpenAI 구현과 같은 이유 — 아래 callOpenAI 주석 참조)
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

/**
 * OpenAI Responses API — 기본 프로바이더.
 *
 * ★ `max_output_tokens`는 **추론 토큰까지 포함**한다. gpt-5 계열은 답을 내기 전에
 *   추론을 돌리므로, 400을 그대로 주면 추론이 예산을 다 쓰고 본문이 비어 돌아올 수
 *   있다(status `incomplete`). 서사는 짧은 한국어 몇 문장이라 추론이 필요 없으므로
 *   `reasoning.effort: 'low'`로 낮추고 예산을 넉넉히 준다.
 *
 * ★ 키는 Authorization 헤더로만 보낸다 — URL은 로그·프록시·리퍼러에 남는다.
 */
async function callOpenAI(
  key: string,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string | null> {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal,
    body: JSON.stringify({
      model: OPENAI_MODEL,
      instructions: system,
      input: user,
      max_output_tokens: MAX_TOKENS * 4,
      // 'minimal' — 서사는 짧은 한국어 몇 문장이라 추론이 필요 없다. gpt-5 계열에서
      // 지연을 가장 크게 줄이는 손잡이다(추론 토큰이 곧 대기 시간이다).
      reasoning: { effort: 'minimal' },
    }),
  })
  if (!res.ok) return null
  const data = (await res.json()) as {
    output_text?: string
    output?: { content?: { type?: string; text?: string }[] }[]
  }
  // SDK의 output_text 편의 필드가 있으면 그것을 쓰고, 없으면 output[]에서 직접 모은다.
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text
  const parts: string[] = []
  for (const item of data.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text)
    }
  }
  const joined = parts.join('').trim()
  return joined.length > 0 ? joined : null
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
