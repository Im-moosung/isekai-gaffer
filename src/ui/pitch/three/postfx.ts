// src/ui/pitch/three/postfx.ts
// 3D 렌더의 포스트 프로세싱 스택 — 원시 렌더를 "방송 화면"으로 만드는 마지막 단계.
//
// 왜 필요한가:
//   절차 생성 지오메트리는 아무리 잘 만들어도 **원시 렌더 그대로 내보내면 평평하다**.
//   조명탑·골 섬광·LED 광고보드처럼 "빛나야 하는 것"이 그냥 밝은 색 사각형으로 남고,
//   야간 씬 특유의 좁은 톤 범위가 8bit 그라디언트 밴딩으로 드러난다.
//   블룸·톤매핑·비네트·그레인은 그 셋을 정확히 겨냥한 처방이다.
//
// 설계 원칙(Phase 4E Global Constraints 준수):
//  - three는 **인자 주입**(`createPostFX(THREE, ...)`). 애드온(EffectComposer 등)은 이 모듈
//    안에서 **동적 import**한다 → 엔트리 번들 오염 없음. 타입만 `import type`.
//  - **폴백을 절대 깨지 않는다.** 애드온 청크 로드 실패·패스 생성 예외 → 조용히
//    "그냥 renderer.render()"로 되돌아간다(=passthrough). 포스트 프로세싱 실패가
//    Match3D 전체를 PixiPitch로 강등시키면 안 된다.
//  - **Math.random·Date 금지.** 그레인은 픽셀 좌표 해시 + 주입된 시간(three Timer)으로만 만든다.
//  - `prefers-reduced-motion`이면 그레인 애니메이션을 정지(정적 디더로만 남는다).
//
// ── 파이프라인 순서와 근거 ──────────────────────────────────────
//   RenderPass(HDR linear) → UnrealBloom(linear) → OutputPass(톤매핑+sRGB) → Grade(비네트·그레인·디더)
//
//   • 블룸은 **톤매핑 앞**이어야 한다. 톤매퍼가 하이라이트를 눌러 1.0 근처로 모은 뒤에 번지면
//     "번진 흰 얼룩"이 되고, 눌리기 전 HDR 값(조명탑 1.7배)에서 번져야 빛으로 읽힌다.
//     three는 렌더 타깃에 그릴 때 머티리얼 톤매핑을 자동으로 끄므로(WebGLRenderer:
//     `currentRenderTarget === null`일 때만 renderer.toneMapping 적용) RenderPass 출력은
//     선형 HDR이다. EffectComposer의 기본 버퍼 타입도 HalfFloatType이라 1.0 초과가 살아남는다.
//   • 비네트·그레인·디더는 **톤매핑 뒤**여야 한다. 디스플레이 공간(sRGB)에서의 8bit 양자화를
//     겨냥한 처방이라 선형 공간에 넣으면 어두운 쪽에만 몰려 효과가 없다.
//
// ── 넣은 것 / 뺀 것 ─────────────────────────────────────────────
//   ○ 톤매핑     : 이미 renderer에 있었지만 이제 OutputPass가 담당(HDR 블룸 뒤 한 번만).
//   ○ 블룸       : 조명탑·골 섬광·LED 보드. 우리 씬에서 값이 가장 큰 효과.
//   ○ 비네트     : 중앙 집중. 방송 카메라의 렌즈 감쇠 흉내.
//   ○ 그레인·디더: 야간 하늘·포그의 밴딩 제거. 필름 질감은 덤.
//   ○ 색수차     : 화면 가장자리에만 **0.6픽셀** 수준. 렌즈가 있다는 신호만 주고 만다.
//   ✗ god rays   : 조명탑은 화면 상단 모서리에 잠깐 걸릴 뿐 대부분 프레임에서 화면 밖이다.
//                  radial occlusion 패스(추가 렌더 1회 + 블러)의 비용을 정당화하지 못한다.
//   ✗ 애너모픽 스트릭: SF 우주선 조명용 언어다. 축구 중계 카메라는 스트릭을 만들지 않는다.
//   ✗ FXAA/SMAA  : renderer가 이미 `antialias: true`(MSAA)로 뜬다. 다만 컴포저를 쓰면
//                  RenderPass가 자체 렌더 타깃에 그리므로 MSAA가 죽는다 → 그래서
//                  {@link makeRenderTarget}에서 **멀티샘플 렌더 타깃**(samples:4)을 직접 넘겨
//                  MSAA를 되살린다. 포스트 AA 패스를 얹는 것보다 싸고 선명하다.
//   ✗ 방사형 블러 : 우리 카메라는 고속 돌진을 하지 않는다. 비용만 든다.
import type * as THREE_NS from 'three'
import type { ThreeAPI } from './scene'

/**
 * 블룸 임계(선형 휘도). 잔디·관중·흰 라인 마킹은 통과 못 하고 조명탑·섬광·LED만 남는 값.
 * 0.78에서는 골대 프레임과 라인 마킹까지 번져 화면이 뿌옜다(스윕 실측) → 0.85로 올렸다.
 */
export const BLOOM_THRESHOLD = 0.85
/**
 * 블룸 강도. UnrealBloomPass의 권장 예시는 1.5지만 그건 어두운 SF 씬 기준이다.
 * 우리 씬은 조명탑 4기 + LED 보드가 상시 밝아서 강도를 올리면 화면 전체에 뿌연 막이
 * 씌워진 "싸구려 블룸"이 된다. 스윕(tools/tone-stats/sweep.mjs)에서 0.42는 근거리
 * 조명탑이 핵폭발처럼 타서 채도가 0.76→0.38로 무너졌고, 0.30이 조명은 살아나되
 * 관중석 색이 유지되는 지점이었다(채도 0.62).
 */
export const BLOOM_STRENGTH = 0.30
/** 블룸 반경(0~1). 낮으면 점광, 높으면 안개. 야간 스타디움의 습기 낀 공기 느낌으로 중간값. */
export const BLOOM_RADIUS = 0.55

/**
 * 비네트 세기. 0.34는 방송 카메라 앵글에서 피치 네 귀퉁이가 눈에 띄게 죽었다(스윕 실측:
 * 평균 휘도 -8, p99 -23). 0.26이 "렌즈가 있다"는 신호는 주면서 잔디를 잃지 않는 선이다.
 */
export const VIGNETTE_STRENGTH = 0.26
/**
 * 비네트 시작 반경(화면 중심에서 정규화 거리). 이 안쪽은 손대지 않는다.
 * 방송 앵글에서는 화면 절반이 피치라 0.42는 액션 존까지 파고들었다 → 0.5.
 */
export const VIGNETTE_INNER = 0.5
/**
 * 그레인 진폭(0~1, sRGB). 3.2/255 ≈ 0.0125.
 * 8bit 밴딩의 계단폭이 1/255이므로 그 3배 정도를 흔들어야 계단이 확실히 깨진다.
 * 더 올리면 정지 화면에서 노이즈로 인지된다.
 */
export const GRAIN_AMOUNT = 0.0125
/** 색수차 — 화면 가장자리에서의 채널 분리량(정규화 UV). 1080p 기준 약 0.6픽셀. */
export const ABERRATION = 0.00055

/** 포스트 프로세싱 파라미터(전부 선택 — 기본값이 위 상수). */
export interface PostFXOptions {
  /** 모션 최소화 — 그레인 애니메이션을 정지시킨다(정적 디더로만 남는다). */
  reducedMotion?: boolean
  bloomStrength?: number
  bloomRadius?: number
  bloomThreshold?: number
  vignette?: number
  grain?: number
  aberration?: number
}

/** 호출부가 쥐는 핸들. 실패해도 이 인터페이스는 항상 온전히 돌아온다(passthrough). */
export interface PostFX {
  /** 컴포저가 실제로 붙었는가. false면 render()는 renderer.render()와 같다. */
  readonly active: boolean
  /**
   * CSS 픽셀 크기와 유효 픽셀비를 함께 넘긴다. 해상도 스케일 가드가 픽셀비만 바꿔도
   * 컴포저의 모든 렌더 타깃이 함께 줄어야 프레임 예산이 실제로 절약된다.
   */
  setSize(width: number, height: number, pixelRatio: number): void
  /** 매 프레임 1회. dt는 그레인 위상 진행용(초). */
  render(dt: number): void
  /**
   * 블룸만 끈다. 해상도 스케일이 바닥(starving)인데도 느릴 때의 **마지막 수단** —
   * 관중을 지우는 것보다 블룸 한 겹을 포기하는 쪽이 화면 손실이 적다.
   */
  setBloomEnabled(on: boolean): void
  /** 모션 최소화 토글(런타임 변경 대응). */
  setReducedMotion(on: boolean): void
  dispose(): void
}

/**
 * 비네트 + 색수차 + 그레인/디더를 한 패스에 합친 그레이딩 셰이더.
 * 셋을 따로 두면 풀스크린 패스가 3번 = 대역폭 3배. 전부 픽셀 로컬 연산이라 합칠 수 있다.
 * **OutputPass 뒤(=sRGB 디스플레이 공간)** 에서 도는 것을 전제로 한다.
 */
const GRADE_SHADER = {
  name: 'BroadcastGradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE_NS.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: VIGNETTE_STRENGTH },
    uVignetteInner: { value: VIGNETTE_INNER },
    uGrain: { value: GRAIN_AMOUNT },
    uAberration: { value: ABERRATION },
    uAspect: { value: 16 / 9 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uVignetteInner;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uAspect;
    varying vec2 vUv;

    // 좌표 해시(결정론). Math.random을 쓸 수 없고, 써서도 안 된다 —
    // 같은 시간·같은 픽셀이면 같은 그레인이어야 스크린샷 회귀 비교가 가능하다.
    float hash21( vec2 p ) {
      p = fract( p * vec2( 443.8975, 397.2973 ) );
      p += dot( p, p.yx + 19.19 );
      return fract( ( p.x + p.y ) * p.x );
    }

    void main() {
      vec2 c = vUv - 0.5;
      // 종횡비 보정 — 보정하지 않으면 와이드 화면에서 비네트가 타원이 아니라 원이 되어
      // 위아래만 어두워진다.
      vec2 ca = vec2( c.x * uAspect, c.y );
      float r = length( ca ) / length( vec2( 0.5 * uAspect, 0.5 ) );

      // 색수차: 가장자리로 갈수록 R을 바깥으로, B를 안쪽으로. r^2로 실제 렌즈처럼 급히 커진다.
      float shift = uAberration * r * r;
      vec3 col;
      col.r = texture2D( tDiffuse, vUv + c * shift ).r;
      col.g = texture2D( tDiffuse, vUv ).g;
      col.b = texture2D( tDiffuse, vUv - c * shift ).b;

      // 비네트: uVignetteInner 안쪽은 1.0 그대로(피치 밝기 보존), 밖으로 부드럽게 감쇠.
      float v = smoothstep( uVignetteInner, 1.0, r );
      col *= 1.0 - uVignette * v * v;

      // 그레인 + 디더: [-0.5,0.5] 균등 노이즈. uTime이 0으로 고정되면 정적 디더가 된다
      // (reduced-motion에서 깜빡임 없이 밴딩만 제거).
      float n = hash21( gl_FragCoord.xy + vec2( uTime * 141.0, uTime * 97.0 ) ) - 0.5;
      col += n * uGrain;

      gl_FragColor = vec4( col, 1.0 );
    }
  `,
}

/**
 * MSAA를 유지하는 컴포저 입력 렌더 타깃.
 * EffectComposer의 기본 타깃은 samples=0이라 컴포저를 붙이는 순간 캔버스 MSAA가 사라진다
 * (절차 생성 지오메트리는 직선 에지가 많아 계단이 바로 보인다). WebGL2 전용 기능이고
 * 우리는 WebGL2를 이미 전제하므로 samples=4를 직접 준다. 8은 iGPU에서 대역폭이 아깝다.
 */
function makeRenderTarget(THREE: ThreeAPI, w: number, h: number): THREE_NS.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    samples: 4,
  })
}

/** 컴포저 없이 그대로 그리는 폴백 핸들. 계약은 동일하다. */
function passthrough(
  renderer: THREE_NS.WebGLRenderer,
  scene: THREE_NS.Scene,
  camera: THREE_NS.Camera,
): PostFX {
  return {
    active: false,
    setSize(width, height, pixelRatio) {
      renderer.setPixelRatio(pixelRatio)
      renderer.setSize(width, height, false)
    },
    render() {
      renderer.render(scene, camera)
    },
    setBloomEnabled() {
      /* 컴포저가 없으므로 할 일 없음 */
    },
    setReducedMotion() {
      /* 그레인이 없으므로 할 일 없음 */
    },
    dispose() {
      /* 소유한 GPU 자원 없음 */
    },
  }
}

/**
 * 포스트 프로세싱 스택을 만든다. **절대 throw하지 않는다** — 실패하면 passthrough를 돌려준다.
 *
 * @param THREE    주입된 three 네임스페이스
 * @param renderer 호출부 소유 렌더러. `toneMapping`/`outputColorSpace` 설정을 OutputPass가 읽어간다.
 */
export async function createPostFX(
  THREE: ThreeAPI,
  renderer: THREE_NS.WebGLRenderer,
  scene: THREE_NS.Scene,
  camera: THREE_NS.Camera,
  opts: PostFXOptions = {},
): Promise<PostFX> {
  let composerMod: typeof import('three/addons/postprocessing/EffectComposer.js')
  let renderMod: typeof import('three/addons/postprocessing/RenderPass.js')
  let bloomMod: typeof import('three/addons/postprocessing/UnrealBloomPass.js')
  let outputMod: typeof import('three/addons/postprocessing/OutputPass.js')
  let shaderMod: typeof import('three/addons/postprocessing/ShaderPass.js')
  try {
    // 5개를 한 번에 받아야 청크 요청이 직렬화되지 않는다.
    ;[composerMod, renderMod, bloomMod, outputMod, shaderMod] = await Promise.all([
      import('three/addons/postprocessing/EffectComposer.js'),
      import('three/addons/postprocessing/RenderPass.js'),
      import('three/addons/postprocessing/UnrealBloomPass.js'),
      import('three/addons/postprocessing/OutputPass.js'),
      import('three/addons/postprocessing/ShaderPass.js'),
    ])
  } catch {
    // 애드온 청크 로드 실패 — 3D 자체는 멀쩡하다. 원시 렌더로 계속 간다.
    return passthrough(renderer, scene, camera)
  }

  try {
    const size = new THREE.Vector2()
    renderer.getSize(size)
    const pr = renderer.getPixelRatio()
    const target = makeRenderTarget(THREE, size.x * pr, size.y * pr)

    const composer = new composerMod.EffectComposer(renderer, target)
    composer.setPixelRatio(pr)
    composer.setSize(size.x, size.y)

    composer.addPass(new renderMod.RenderPass(scene, camera))

    // UnrealBloomPass는 넘긴 해상도의 **절반**에서 밉 체인(5단)을 시작한다 —
    // 즉 유효 렌더 해상도를 그대로 넘기면 첫 블러가 이미 half-res다. 그 이상 낮추면
    // 조명탑처럼 얇고 밝은 소스가 밉 계단에서 깜빡인다(temporal aliasing).
    const bloom = new bloomMod.UnrealBloomPass(
      new THREE.Vector2(Math.max(1, size.x * pr), Math.max(1, size.y * pr)),
      opts.bloomStrength ?? BLOOM_STRENGTH,
      opts.bloomRadius ?? BLOOM_RADIUS,
      opts.bloomThreshold ?? BLOOM_THRESHOLD,
    )
    composer.addPass(bloom)

    // 톤매핑 + sRGB 변환. renderer.toneMapping/outputColorSpace를 그대로 읽는다.
    composer.addPass(new outputMod.OutputPass())

    const grade = new shaderMod.ShaderPass(GRADE_SHADER)
    // 우리 셰이더에는 <tonemapping_fragment> 청크가 없지만, 캔버스로 직접 그리는 마지막
    // 패스라 three가 톤매핑 정의를 주입할 여지를 아예 없앤다(이중 톤매핑 방지).
    grade.material.toneMapped = false
    grade.uniforms.uVignette.value = opts.vignette ?? VIGNETTE_STRENGTH
    grade.uniforms.uGrain.value = opts.grain ?? GRAIN_AMOUNT
    grade.uniforms.uAberration.value = opts.aberration ?? ABERRATION
    grade.uniforms.uAspect.value = size.y > 0 ? size.x / size.y : 16 / 9
    composer.addPass(grade)

    let reduced = opts.reducedMotion === true
    let time = 0

    return {
      active: true,
      setSize(width, height, pixelRatio) {
        renderer.setPixelRatio(pixelRatio)
        renderer.setSize(width, height, false)
        // composer.setSize가 모든 패스에 effective(=CSS×픽셀비) 크기를 전파한다 —
        // UnrealBloomPass의 밉 체인도 여기서 함께 줄어든다(해상도 스케일이 실효를 갖는 지점).
        composer.setPixelRatio(pixelRatio)
        composer.setSize(width, height)
        grade.uniforms.uAspect.value = height > 0 ? width / height : 16 / 9
      },
      render(dt: number) {
        if (!reduced) {
          // 위상만 필요하다. 1000초에서 되감아 float 정밀도가 무너지지 않게 한다.
          time = (time + (Number.isFinite(dt) ? dt : 0)) % 1000
          grade.uniforms.uTime.value = time
        }
        composer.render(dt)
      },
      setBloomEnabled(on: boolean) {
        bloom.enabled = on
      },
      setReducedMotion(on: boolean) {
        reduced = on
        if (on) grade.uniforms.uTime.value = 0
      },
      dispose() {
        // composer.dispose()가 renderTarget1(=우리가 넘긴 target)과 renderTarget2(clone),
        // copyPass까지 해제한다 → target을 따로 dispose하면 이중 해제다.
        composer.dispose()
        bloom.dispose()
        grade.dispose()
      },
    }
  } catch {
    // 렌더 타깃 할당 실패(메모리 부족 등) → 원시 렌더로 계속.
    return passthrough(renderer, scene, camera)
  }
}
