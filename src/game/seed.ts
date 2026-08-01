// src/game/seed.ts
// 캠페인 시드 발급 — **엔트로피 경계는 여기 한 곳뿐이다.**
//
// 설계 §99의 계약은 "시드가 정해지면 결과가 하나"다. 그 계약은 그대로다.
// 바뀌는 것은 **시드를 고르는 방법**뿐이다: 예전에는 App.tsx의 상수 20260724였고,
// 그래서 누가 언제 캠페인을 시작하든 1경기(체코전)가 같은 시드로 돌았다.
// 전술을 바꿔도 초반 대본(1' 우리 슛 빗나감 → 2' 체코 골)이 그대로였던 이유가 이것이다.
// 전술은 확률의 문턱만 옮기는데, 분마다 뽑히는 난수열이 시드에 고정돼 있어
// 뽑힌 값이 문턱에서 멀면 결과가 뒤집히지 않는다.
//
// 규칙:
//  - 엔진(src/engine/**)은 여전히 Math.random·Date 금지다. 여기서 뽑은 수는
//    **캠페인 시작 시점에 딱 한 번** 스토어로 들어가고, 그 뒤는 전부 결정론이다.
//  - 엔트로피 원천은 주입 가능하다(newCampaignSeed(entropy)). 테스트는 고정 함수를 넣어
//    지금까지처럼 완전 결정론으로 돈다.

/** 시드의 표시 범위 — 6자리 정수.
 *  자릿수를 6으로 고정한 이유는 사람이 눈으로 읽고 그대로 옮겨 적을 수 있는 하한이기 때문이다.
 *  경우의 수 90만은 "매 판이 다르다"를 만드는 데 충분하고(같은 시드를 다시 뽑을 확률 ≈ 0.0001%),
 *  32비트 난수를 그대로 노출했을 때의 10자리("3947281052")보다 공유가 쉽다. */
export const SEED_MIN = 100_000
export const SEED_MAX = 999_999

/** 엔트로피 원천. 0 이상의 정수를 돌려주면 된다(상한 무관 — 내부에서 범위로 접는다). */
export type EntropySource = () => number

/**
 * 기본 엔트로피 — 이 프로젝트가 오디오(AudioContext)·캔버스(WebGL)에서 쓰는 것과 같은
 * "기능 탐지 후 단계적 폴백" 방식이다. 어느 층이 없어도 크래시하지 않는다.
 *
 *  1순위 crypto.getRandomValues — 브라우저·Node 18+·jsdom 모두 표준이고 편향이 없다.
 *  2순위 Math.random — 구형 브라우저·비보안 컨텍스트(http)에서 crypto가 없거나 막힌 경우.
 *  3순위 Date.now — 위 둘이 모두 없는 극단(일부 SSR 런타임). 같은 밀리초에 두 번 부르면
 *         같은 값이 나오지만, 캠페인 시작은 사용자 클릭당 한 번이라 실사용 충돌이 없다.
 */
export function defaultEntropy(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto
  if (typeof c?.getRandomValues === 'function') {
    try {
      return c.getRandomValues(new Uint32Array(1))[0]
    } catch {
      /* 폴백으로 진행 */
    }
  }
  const rand = (globalThis as { Math?: { random?: () => number } }).Math?.random
  if (typeof rand === 'function') return Math.floor(rand() * 0x1_0000_0000)
  return Date.now()
}

/**
 * 새 캠페인 시드를 발급한다. 반환값은 항상 SEED_MIN~SEED_MAX의 정수다.
 * @param entropy 테스트·리플레이용 주입점. 미지정이면 defaultEntropy.
 */
export function newCampaignSeed(entropy: EntropySource = defaultEntropy): number {
  const span = SEED_MAX - SEED_MIN + 1
  const raw = entropy()
  const n = Number.isFinite(raw) ? Math.floor(Math.abs(raw)) : 0
  return SEED_MIN + (n % span)
}

/**
 * 사용자가 준 문자열을 시드로 해석한다. 범위를 벗어나거나 숫자가 아니면 null.
 * "같은 판을 다시/친구와 함께"의 입구라서 관대하게 받되(공백·앞의 0 허용) 조용히 실패한다 —
 * 잘못된 시드로 시작하는 것보다 새 판을 뽑아 주는 편이 안전하다.
 */
export function parseSeed(input: string | null | undefined): number | null {
  if (input == null) return null
  const s = input.trim()
  if (!/^\d{1,7}$/.test(s)) return null
  const n = Number(s)
  if (!Number.isInteger(n) || n < SEED_MIN || n > SEED_MAX) return null
  return n
}

/**
 * 주소의 `?seed=` 파라미터를 읽는다. 없거나 잘못됐으면 null.
 *
 * [판단] 시드 "입력창"을 화면에 두지 않고 URL 파라미터로 받는 이유:
 *  이 프로젝트는 컨트롤 과밀을 경계한다. 랜딩에 입력 필드를 하나 더 놓으면
 *  첫 화면의 결정 지점이 [캠페인][데모] 둘에서 셋으로 늘고, 그 세 번째는
 *  99%의 플레이어가 쓰지 않는다(친구와 같은 판을 겨루는 사람만 쓴다).
 *  URL은 **공유 그 자체가 링크**라 컨트롤이 0개이면서 기능은 더 낫다 —
 *  엔딩 화면의 [링크 복사]가 그대로 초대장이 된다.
 *
 * @param search 미지정이면 location.search(없는 환경이면 빈 문자열).
 */
export function seedFromLocation(search?: string): number | null {
  let query = search
  if (query === undefined) {
    const loc = (globalThis as { location?: { search?: string } }).location
    query = typeof loc?.search === 'string' ? loc.search : ''
  }
  if (!query) return null
  try {
    return parseSeed(new URLSearchParams(query).get('seed'))
  } catch {
    return null
  }
}

/** 이 시드로 같은 판을 여는 공유 주소. location이 없으면 null(복사 UI를 숨긴다). */
export function shareUrlForSeed(seed: number): string | null {
  const loc = (globalThis as { location?: { origin?: string; pathname?: string } }).location
  if (!loc || typeof loc.origin !== 'string') return null
  return `${loc.origin}${loc.pathname ?? '/'}?seed=${seed}`
}
