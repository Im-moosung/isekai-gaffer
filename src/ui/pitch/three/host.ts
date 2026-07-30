// src/ui/pitch/three/host.ts
// three 렌더러를 DOM 호스트에 붙이는 **부트스트랩 공통 계층**.
//
// 왜 있나: 3D를 띄우는 곳이 둘이다(경기 화면 Match3D, 랜딩 배경 StadiumBackdrop).
// 둘은 렌더러 생성 → 컬러스페이스·톤매핑 설정 → canvas 부착 → 리사이즈 바인딩까지
// 같은 순서를 복사해 쓰고 있었다. 특히 **톤매핑 계약**(NeutralToneMapping + 노출 1.15)은
// 두 화면이 반드시 같아야 한다 — 랜딩에서 경기로 넘어갈 때 색이 튀면 안 되기 때문이며,
// 그 근거는 scene.ts 헤더에 있다. 값이 두 곳에 흩어져 있으면 한쪽만 고쳐 놓고 모른다.
//
// three는 **타입으로만** 참조한다(`import type`은 컴파일에서 지워진다). 이 모듈이
// 엔트리 청크에 들어가도 three가 딸려오지 않는다 — 코드 스플릿 유지.
import type * as THREE_NS from 'three'

type ThreeAPI = typeof THREE_NS

export interface RendererHostOptions {
  /** canvas에 붙일 CSS 클래스(호출부 스타일). */
  className: string
  /** WebGL powerPreference — 경기는 'high-performance', 랜딩 배경은 'default'. */
  powerPreference: 'high-performance' | 'default'
  /** 초기 픽셀비. 경기 화면은 적응형 스케일러가 이후에 다시 만진다. */
  pixelRatio: number
}

/**
 * 렌더러를 만들어 호스트에 부착한다. 생성 실패(WebGL 거부·컨텍스트 상한)면 **throw하지 않고
 * null**을 돌려준다 — 호출부는 각자의 폴백(랜딩=배경 없음, 경기=PixiPitch 체인)으로 내려간다.
 */
export function createRendererHost(
  THREE: ThreeAPI,
  host: HTMLElement,
  opts: RendererHostOptions,
): THREE_NS.WebGLRenderer | null {
  let renderer: THREE_NS.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: opts.powerPreference })
  } catch {
    return null
  }
  renderer.setPixelRatio(opts.pixelRatio)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // ── 톤매핑 계약(두 화면 공통) ──
  // ACESFilmic → Neutral: ACES의 깊은 토우가 야간 씬의 1/4을 순검정으로 뭉개고
  // 관중석 채도를 절반으로 깎았다(tools/tone-stats 실측). 근거는 scene.ts 헤더.
  renderer.toneMapping = THREE.NeutralToneMapping
  // 노출 1.05 → 1.15: Neutral은 0.8 위를 롤오프하므로 같은 노출에서 ACES보다 하이라이트가
  // 낮게 나온다(p99 192→169). 1.15면 하이라이트를 되찾으면서도 암부는 여전히 안 뭉갠다.
  renderer.toneMappingExposure = 1.15
  renderer.domElement.className = opts.className
  host.appendChild(renderer.domElement)
  return renderer
}

/**
 * 호스트 크기 변화를 구독한다. ResizeObserver가 없는 환경(구형·일부 테스트 환경)에서는
 * window resize로 내려간다 — 두 호출부가 같은 폴백을 각자 들고 있을 이유가 없다.
 * @returns 구독 해제 함수(teardown에서 호출).
 */
export function bindResize(host: HTMLElement, onResize: () => void): () => void {
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => onResize()) : null
  if (ro) {
    ro.observe(host)
    return () => ro.disconnect()
  }
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
}
