// src/ui/flags/flags.ts
// 국기 자산(public/flags/*.svg)의 정본 — 팀 id → 국기 파일 매핑과 로더.
//
// ★ 왜 국기를 쓰는가
//   설계 스펙 §9.1이 금지한 것은 **협회 엠블럼·대표팀 크레스트·FIFA/월드컵 공식 로고**이고,
//   같은 문장이 팀 식별 수단으로 지정한 것이 **국기(퍼블릭 도메인) + 국가명 텍스트**다.
//   (docs/superpowers/specs/2026-07-23-worldcup-manager-sim-design.md:182)
//   초기 입장 연출은 이를 오독해 "국기 금지"로 구현됐다 — 팀 색 tifo 배너.
//   2026-08-01 정정으로 국기로 되돌렸다(정정 경위는 2026-08-01-entrance-storyboard.md 하단).
//
// ★ 왜 이모지 국기(🇰🇷)가 아닌가
//   docs/research/ui-redesign.md G-4·H-6이 결함으로 잡았다: OS마다 도안이 다르고
//   **Windows에서는 국가 코드 두 글자("KR")로 렌더된다.** 처방이 SVG 자산이다.
//
// ★ 자산 출처·라이선스는 docs/assets-licenses.md §국기 원장이 정본이다(MIT · lipis/flag-icons).
//
// 결정론: 이 모듈은 Math.random·Date를 쓰지 않는다. 로딩은 비동기지만 **그림 내용은
// 파일에만 의존**하므로 같은 시드 → 같은 프레임이 유지된다(로드 실패 시 폴백 도안도 결정적).
import type { TeamId } from '../../data/loader'

/**
 * 팀 id → 국기 파일 basename. 파일명은 ISO 3166-1 alpha-2(잉글랜드만 예외로
 * `gb-eng` — 주권국이 아니라 알파-2 코드가 없다. flag-icons의 하위 구역 코드를 따른다).
 *
 * 12개국 전부를 덮는다 — `TEAM_IDS`(src/data/loader.ts)가 12개이고 캠페인은 그 안에서만
 * 상대를 고른다. `Record<TeamId, …>`라 팀이 늘면 **타입 에러로 먼저 걸린다**.
 */
export const FLAG_FILE: Record<TeamId, string> = {
  kor: 'kr',
  cze: 'cz',
  mex: 'mx',
  rsa: 'za',
  ecu: 'ec',
  eng: 'gb-eng',
  nor: 'no',
  arg: 'ar',
  esp: 'es',
  can: 'ca',
  mar: 'ma',
  fra: 'fr',
}

/**
 * 임의의 팀 id 문자열을 국기가 있는 {@link TeamId}로 좁힌다. 없으면 undefined.
 *
 * `Team.id`는 엔진 타입상 그냥 `string`이라(engine/types.ts) 호출부가 캐스팅하게
 * 두면 팀이 늘었을 때 조용히 404가 난다. 여기서 **런타임으로 확인**해 국기가 없는
 * 팀은 애초에 로드를 시도하지 않게 한다.
 */
export function flagTeamId(id: string): TeamId | undefined {
  return Object.prototype.hasOwnProperty.call(FLAG_FILE, id) ? (id as TeamId) : undefined
}

/**
 * public/ 아래 자산의 절대 경로(Vite base 고려).
 *
 * `src/audio/sfx.ts`의 `audioAssetUrl`과 같은 계산이지만 **일부러 복제**했다 —
 * 이 모듈은 3D 청크(textures/scene)에서 쓰이므로 오디오 모듈을 import하면
 * 사운드 코드가 3D 청크로 끌려 들어간다(코드 스플릿이 깨진다).
 */
function assetUrl(path: string): string {
  let base = '/'
  try {
    const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env
    if (env?.BASE_URL) base = env.BASE_URL
  } catch {
    /* import.meta 미지원 — 루트 기준 */
  }
  if (!base.endsWith('/')) base += '/'
  return `${base}${path}`
}

/** 팀 국기 SVG의 URL. 예: '/flags/kr.svg'. */
export function flagUrl(team: TeamId): string {
  return assetUrl(`flags/${FLAG_FILE[team]}.svg`)
}

/**
 * 국기 SVG를 `<img>`로 로드한다. **실패해도 절대 throw하지 않고 null**을 준다 —
 * 호출부(배너)는 국기가 없으면 팀 색 폴백 도안으로 계속 간다.
 *
 * jsdom에는 SVG 래스터라이저가 없어 onload가 오지 않는다. 그래서
 *  - `Image`·`document`가 없으면 즉시 null,
 *  - 있어도 {@link timeoutMs} 안에 안 오면 null로 매듭짓는다(테스트가 매달리지 않게).
 *
 * SVG는 같은 오리진(public/)에서 오므로 캔버스를 오염(taint)시키지 않는다 —
 * WebGL `texImage2D`가 오염된 캔버스에서 던지는 문제를 피하는 조건이다.
 */
export function loadFlagImage(
  team: TeamId, timeoutMs = 8000,
): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null)
  return new Promise(resolve => {
    let done = false
    const finish = (img: HTMLImageElement | null): void => {
      if (done) return
      done = true
      resolve(img)
    }
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => finish(img)
    img.onerror = () => finish(null)
    if (typeof setTimeout === 'function') {
      const t = setTimeout(() => finish(null), timeoutMs)
      if (typeof (t as unknown as { unref?: () => void }).unref === 'function') {
        (t as unknown as { unref: () => void }).unref()
      }
    }
    img.src = flagUrl(team)
  })
}
