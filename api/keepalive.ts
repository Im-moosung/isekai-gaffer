// api/keepalive.ts
// Supabase 무료 티어 자동 정지 방지 핑 (Vercel Cron).
//
// 왜 필요한가: 무료 플랜은 **7일 비활성 시 프로젝트를 자동 정지**시킨다. 마감(2026-08-03)
// 이후 심사 기간에 정지되면 리더보드가 죽고, 규정상 "동적 인터랙션이 실제로 작동하지
// 않는 경우 해당 기능은 평가에서 제외"에 걸린다. 설계 스펙 §11이 이 위험과 대책
// (Cron keep-alive)을 미리 적어 두었다 — 그 구현이다.
//
// 무엇을 하는가: leaderboard를 **1행만 읽는다**. 쓰기가 아니라 읽기인 이유는 이 핑이
// 데이터를 만들면 안 되기 때문이다(리더보드에 유령 기록이 쌓인다). 읽기만으로도
// 프로젝트는 "활성"으로 집계된다.
//
// 키: VITE_ 접두사가 붙은 anon 키를 그대로 쓴다. 이미 클라이언트 번들에 공개돼 있는
// 값이라 서버에서 쓴다고 더 위험해지지 않고, 별도 변수를 늘리지 않는 편이 낫다.

export const config = { runtime: 'edge' }

export default async function handler(): Promise<Response> {
  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  // 설정이 없으면 조용히 성공으로 끝낸다 — 크론 실패 알림이 쌓이면 진짜 장애를 가린다.
  if (!url || !key) return json({ ok: true, skipped: 'supabase 미설정' })

  try {
    const res = await fetch(`${url}/rest/v1/leaderboard?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    return json({ ok: res.ok, status: res.status })
  } catch {
    return json({ ok: false, error: 'unreachable' }, 502)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}
