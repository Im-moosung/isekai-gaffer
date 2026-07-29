// createPostFX의 계약 검증 — "포스트 프로세싱은 실패해도 3D를 끌어내리지 않는다".
//
// 왜 이런 구조인가:
//   1) vitest 기본 환경(node)에는 WebGL이 없다. three 애드온의 **생성자**는 순수 JS라
//      node에서도 통과하지만(실험으로 확인), 패스의 render()는 renderer의 GL 상태 API를
//      호출한다 → 렌더러는 스파이 객체로 대체한다.
//   2) 활성 경로의 관측 대상(composer 크기 전파, grade uniform의 uTime, bloom.enabled,
//      렌더 타깃 이중 해제)은 전부 createPostFX가 **밖으로 내보내지 않는 내부 객체**다.
//      그래서 활성 경로 검증은 애드온 5종을 vi.doMock으로 가짜 클래스로 갈아끼워
//      내부 상태를 직접 들여다본다(= 브리프의 (B) 접근).
//   3) 다만 가짜 클래스만 쓰면 "실제 애드온과의 계약이 맞는가"가 빠진다 → 실제 애드온으로
//      스모크 1건(생성 성공 + active=true + dispose 무예외)을 따로 둔다(= (A) 접근 일부).
//   Math.random/Date는 쓰지 않는다(프로젝트 금지 규칙).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import type * as THREE_NS from 'three'
import {
  BLOOM_THRESHOLD,
  BLOOM_STRENGTH,
  BLOOM_RADIUS,
  VIGNETTE_STRENGTH,
  VIGNETTE_INNER,
  GRAIN_AMOUNT,
  ABERRATION,
} from '../postfx'
import type { PostFX, PostFXOptions } from '../postfx'

// ── 가짜 렌더러 ────────────────────────────────────────────────────
// createPostFX가 실제로 만지는 것만 채운다: 크기·픽셀비 질의/설정, 원시 render.
// (톤매핑/컬러스페이스 필드는 실제 OutputPass가 생성자에서 읽을 수 있어 함께 둔다.)
interface FakeRenderer {
  toneMapping: THREE_NS.ToneMapping
  outputColorSpace: string
  getSize: ReturnType<typeof vi.fn>
  getPixelRatio: ReturnType<typeof vi.fn>
  setPixelRatio: ReturnType<typeof vi.fn>
  setSize: ReturnType<typeof vi.fn>
  render: ReturnType<typeof vi.fn>
}

function makeRenderer(width = 1280, height = 720, pixelRatio = 2): FakeRenderer {
  return {
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    getSize: vi.fn((v: THREE_NS.Vector2) => v.set(width, height)),
    getPixelRatio: vi.fn(() => pixelRatio),
    setPixelRatio: vi.fn(),
    setSize: vi.fn(),
    render: vi.fn(),
  }
}

function asRenderer(r: FakeRenderer): THREE_NS.WebGLRenderer {
  return r as unknown as THREE_NS.WebGLRenderer
}

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera()

// ── 가짜 애드온 ────────────────────────────────────────────────────
// 실제 애드온과 같은 "관측 가능한 표면"만 흉내 낸다.
interface Uniform {
  value: unknown
}
interface FakePass {
  kind: string
  enabled: boolean
  disposed: number
}
interface FakeShaderPass extends FakePass {
  uniforms: Record<string, Uniform>
  material: { toneMapped: boolean }
}
interface FakeComposer {
  renderTarget1: THREE_NS.WebGLRenderTarget
  passes: FakePass[]
  pixelRatio: number
  size: { width: number; height: number } | null
  renderedWith: number[]
  disposed: number
}

interface ActiveHarness {
  composer: FakeComposer
  bloomArgs: { resolution: THREE_NS.Vector2; strength: number; radius: number; threshold: number }
}

/**
 * 애드온 5종을 가짜로 갈아끼운 뒤 postfx 모듈을 새로 로드한다.
 * createPostFX가 애드온을 **동적 import**하므로 vi.resetModules + vi.doMock 순서가 중요하다
 * (앞선 테스트가 캐시해 둔 실제 애드온을 지워야 가짜가 먹는다).
 */
async function loadWithFakeAddons(): Promise<{
  createPostFX: typeof import('../postfx').createPostFX
  harness: ActiveHarness
}> {
  const harness = { composer: null, bloomArgs: null } as unknown as ActiveHarness

  vi.resetModules()
  vi.doMock('three/addons/postprocessing/EffectComposer.js', () => ({
    EffectComposer: class {
      renderTarget1: THREE_NS.WebGLRenderTarget
      passes: FakePass[] = []
      pixelRatio = 1
      size: { width: number; height: number } | null = null
      renderedWith: number[] = []
      disposed = 0
      constructor(_renderer: unknown, target: THREE_NS.WebGLRenderTarget) {
        this.renderTarget1 = target
        harness.composer = this as unknown as FakeComposer
      }
      setPixelRatio(p: number): void {
        this.pixelRatio = p
      }
      setSize(width: number, height: number): void {
        this.size = { width, height }
      }
      addPass(p: FakePass): void {
        this.passes.push(p)
      }
      render(dt: number): void {
        this.renderedWith.push(dt)
      }
      dispose(): void {
        this.disposed += 1
        // 실제 EffectComposer.dispose()는 넘겨받은 renderTarget1까지 해제한다.
        // 이중 해제 회귀를 잡으려면 이 동작을 흉내 내야 의미가 있다.
        this.renderTarget1.dispose()
      }
    },
  }))
  vi.doMock('three/addons/postprocessing/RenderPass.js', () => ({
    RenderPass: class {
      kind = 'render'
      enabled = true
      disposed = 0
      scene: unknown
      camera: unknown
      constructor(s: unknown, c: unknown) {
        this.scene = s
        this.camera = c
      }
    },
  }))
  vi.doMock('three/addons/postprocessing/UnrealBloomPass.js', () => ({
    UnrealBloomPass: class {
      kind = 'bloom'
      enabled = true
      disposed = 0
      constructor(
        resolution: THREE_NS.Vector2,
        strength: number,
        radius: number,
        threshold: number,
      ) {
        harness.bloomArgs = { resolution, strength, radius, threshold }
      }
      dispose(): void {
        this.disposed += 1
      }
    },
  }))
  vi.doMock('three/addons/postprocessing/OutputPass.js', () => ({
    OutputPass: class {
      kind = 'output'
      enabled = true
      disposed = 0
    },
  }))
  vi.doMock('three/addons/postprocessing/ShaderPass.js', () => ({
    ShaderPass: class {
      kind = 'shader'
      enabled = true
      disposed = 0
      uniforms: Record<string, Uniform>
      material = { toneMapped: true }
      constructor(shader: { uniforms: Record<string, Uniform> }) {
        // 실제 ShaderPass는 UniformsUtils.clone을 쓴다 — 모듈 전역 GRADE_SHADER를
        // 테스트가 오염시키지 않도록 여기서도 반드시 복제한다.
        this.uniforms = Object.fromEntries(
          Object.entries(shader.uniforms).map(([k, u]) => [k, { value: u.value }]),
        )
      }
      dispose(): void {
        this.disposed += 1
      }
    },
  }))

  const mod = await import('../postfx')
  return { createPostFX: mod.createPostFX, harness }
}

async function makeActive(
  renderer: FakeRenderer,
  opts: PostFXOptions = {},
): Promise<{ fx: PostFX; harness: ActiveHarness }> {
  const { createPostFX, harness } = await loadWithFakeAddons()
  const fx = await createPostFX(THREE, asRenderer(renderer), scene, camera, opts)
  return { fx, harness }
}

function grade(harness: ActiveHarness): FakeShaderPass {
  return harness.composer.passes[3] as FakeShaderPass
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.doUnmock('three/addons/postprocessing/EffectComposer.js')
  vi.doUnmock('three/addons/postprocessing/RenderPass.js')
  vi.doUnmock('three/addons/postprocessing/UnrealBloomPass.js')
  vi.doUnmock('three/addons/postprocessing/OutputPass.js')
  vi.doUnmock('three/addons/postprocessing/ShaderPass.js')
  vi.resetModules()
})

// ── passthrough(폴백) 경로 ─────────────────────────────────────────
describe('createPostFX 폴백', () => {
  /** 청크 로드 실패를 흉내 낸 postfx 로드. 이 파일에서 가장 중요한 시나리오다. */
  async function loadWithBrokenAddon(): Promise<typeof import('../postfx').createPostFX> {
    vi.resetModules()
    vi.doMock('three/addons/postprocessing/EffectComposer.js', () => {
      // 지연 청크 로드 실패(네트워크 끊김·CDN 404)와 같은 형태의 실패.
      throw new Error('chunk load failed')
    })
    const mod = await import('../postfx')
    return mod.createPostFX
  }

  it('애드온 청크 로드가 실패해도 reject하지 않고 active=false 핸들을 준다', async () => {
    const createPostFX = await loadWithBrokenAddon()
    const renderer = makeRenderer()
    // reject하면 호출부(Match3D)가 3D 전체를 포기하고 PixiPitch로 강등된다 → 절대 금지.
    const fx = await createPostFX(THREE, asRenderer(renderer), scene, camera)
    expect(fx.active).toBe(false)
  })

  it('렌더 타깃 생성이 실패해도(할당 예외) passthrough로 내려간다', async () => {
    const { createPostFX } = await loadWithFakeAddons()
    const renderer = makeRenderer()
    // WebGLRenderTarget 생성이 던지는 상황(메모리 부족 등)을 흉내 낸다.
    // ESM 네임스페이스는 spyOn으로 덮을 수 없으므로, three가 **주입**된다는 설계를 이용해
    // 해당 생성자만 바꿔 낀 프록시 네임스페이스를 넘긴다.
    const brokenThree = {
      ...THREE,
      WebGLRenderTarget: class {
        constructor() {
          throw new Error('out of memory')
        }
      },
    } as unknown as typeof THREE

    const fx = await createPostFX(brokenThree, asRenderer(renderer), scene, camera)
    expect(fx.active).toBe(false)
    // passthrough 계약은 그대로여야 한다.
    fx.render(0.016)
    expect(renderer.render).toHaveBeenCalledWith(scene, camera)
  })

  it('render()는 renderer.render(scene, camera)를 그대로 호출한다', async () => {
    const createPostFX = await loadWithBrokenAddon()
    const renderer = makeRenderer()
    const fx = await createPostFX(THREE, asRenderer(renderer), scene, camera)

    fx.render(0.016)

    expect(renderer.render).toHaveBeenCalledTimes(1)
    expect(renderer.render).toHaveBeenCalledWith(scene, camera)
  })

  it('setSize()는 픽셀비를 먼저 반영하고 setSize(w, h, false)로 캔버스 CSS 크기를 건드리지 않는다', async () => {
    const createPostFX = await loadWithBrokenAddon()
    const renderer = makeRenderer()
    const fx = await createPostFX(THREE, asRenderer(renderer), scene, camera)

    fx.setSize(800, 600, 1.5)

    expect(renderer.setPixelRatio).toHaveBeenCalledWith(1.5)
    // 세 번째 인자 false = updateStyle 끄기. true면 해상도 스케일이 CSS 크기까지 흔든다.
    expect(renderer.setSize).toHaveBeenCalledWith(800, 600, false)
  })

  it('setBloomEnabled·setReducedMotion·dispose는 no-op이고 throw하지 않는다', async () => {
    const createPostFX = await loadWithBrokenAddon()
    const renderer = makeRenderer()
    const fx = await createPostFX(THREE, asRenderer(renderer), scene, camera)

    // 호출부는 active 여부를 신경 쓰지 않고 이 메서드들을 부른다 → 계약상 안전해야 한다.
    expect(() => {
      fx.setBloomEnabled(false)
      fx.setBloomEnabled(true)
      fx.setReducedMotion(true)
      fx.dispose()
      fx.dispose()
    }).not.toThrow()
  })
})

// ── 활성 경로 ──────────────────────────────────────────────────────
describe('createPostFX 활성 경로', () => {
  it('패스를 RenderPass → UnrealBloom → OutputPass → Grade 순서로 붙인다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())

    expect(fx.active).toBe(true)
    // 순서가 곧 화질이다: 블룸은 톤매핑(OutputPass) 앞, 그레이딩은 뒤여야 한다.
    expect(harness.composer.passes.map((p) => p.kind)).toEqual([
      'render',
      'bloom',
      'output',
      'shader',
    ])
  })

  it('블룸 파라미터 기본값은 상수이고 해상도는 CSS 크기 × 픽셀비다', async () => {
    const { harness } = await makeActive(makeRenderer(1280, 720, 2))

    expect(harness.bloomArgs.strength).toBe(BLOOM_STRENGTH)
    expect(harness.bloomArgs.radius).toBe(BLOOM_RADIUS)
    expect(harness.bloomArgs.threshold).toBe(BLOOM_THRESHOLD)
    // 밉 체인이 유효 렌더 해상도에서 시작해야 얇은 조명탑이 깜빡이지 않는다.
    expect(harness.bloomArgs.resolution.x).toBe(2560)
    expect(harness.bloomArgs.resolution.y).toBe(1440)
  })

  it('opts가 상수 기본값을 덮어쓴다', async () => {
    const { harness } = await makeActive(makeRenderer(), {
      bloomStrength: 0.11,
      bloomRadius: 0.22,
      bloomThreshold: 0.33,
      vignette: 0.44,
      grain: 0.055,
      aberration: 0.0066,
    })

    expect(harness.bloomArgs.strength).toBe(0.11)
    expect(harness.bloomArgs.radius).toBe(0.22)
    expect(harness.bloomArgs.threshold).toBe(0.33)
    const u = grade(harness).uniforms
    expect(u.uVignette.value).toBe(0.44)
    expect(u.uGrain.value).toBe(0.055)
    expect(u.uAberration.value).toBe(0.0066)
  })

  it('그레이딩 패스는 톤매핑 주입을 막고 초기 종횡비를 실제 크기에서 얻는다', async () => {
    const { harness } = await makeActive(makeRenderer(1600, 800, 1))
    const g = grade(harness)

    // 마지막 패스가 캔버스로 직접 그리므로 three가 톤매핑을 한 번 더 끼얹으면 이중 톤매핑이다.
    expect(g.material.toneMapped).toBe(false)
    expect(g.uniforms.uAspect.value).toBe(2)
    expect(g.uniforms.uVignetteInner.value).toBe(VIGNETTE_INNER)
  })

  it('setSize는 renderer와 composer 양쪽에 픽셀비·크기를 전파한다', async () => {
    const renderer = makeRenderer()
    const { fx, harness } = await makeActive(renderer)

    fx.setSize(900, 450, 1.25)

    expect(renderer.setPixelRatio).toHaveBeenCalledWith(1.25)
    expect(renderer.setSize).toHaveBeenCalledWith(900, 450, false)
    // composer까지 줄지 않으면 해상도 스케일 가드가 프레임 예산을 전혀 절약하지 못한다(회귀 지점).
    expect(harness.composer.pixelRatio).toBe(1.25)
    expect(harness.composer.size).toEqual({ width: 900, height: 450 })
    expect(grade(harness).uniforms.uAspect.value).toBe(2)
  })

  it('setSize의 높이가 0이어도 종횡비가 NaN/Infinity로 오염되지 않는다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())

    fx.setSize(800, 0, 1)

    expect(grade(harness).uniforms.uAspect.value).toBe(16 / 9)
  })

  it('render(dt)가 uTime을 누적하고 composer에 dt를 넘긴다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())
    const g = grade(harness)

    fx.render(0.5)
    expect(g.uniforms.uTime.value).toBeCloseTo(0.5, 10)
    fx.render(0.25)
    expect(g.uniforms.uTime.value).toBeCloseTo(0.75, 10)
    expect(harness.composer.renderedWith).toEqual([0.5, 0.25])
  })

  it('dt가 NaN/Infinity여도 uTime이 오염되지 않는다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())
    const g = grade(harness)

    fx.render(0.5)
    fx.render(Number.NaN)
    fx.render(Number.POSITIVE_INFINITY)

    // NaN이 한 번 섞이면 이후 모든 프레임의 그레인이 죽는다 → 무시하고 위상을 보존해야 한다.
    expect(g.uniforms.uTime.value).toBeCloseTo(0.5, 10)
  })

  it('uTime은 1000초에서 되감아 float 정밀도를 지킨다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())
    const g = grade(harness)

    fx.render(999.5)
    fx.render(1)

    expect(g.uniforms.uTime.value).toBeCloseTo(0.5, 6)
  })

  it('reducedMotion이면 uTime이 0에 고정되고 더 진행하지 않는다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())
    const g = grade(harness)

    fx.render(0.5)
    fx.setReducedMotion(true)
    expect(g.uniforms.uTime.value).toBe(0)

    fx.render(0.5)
    fx.render(0.5)
    // 정적 디더로만 남아야 한다(밴딩은 계속 제거, 깜빡임은 없음).
    expect(g.uniforms.uTime.value).toBe(0)
    // 그래도 프레임은 계속 그려져야 한다.
    expect(harness.composer.renderedWith).toHaveLength(3)
  })

  it('opts.reducedMotion=true로 시작하면 처음부터 uTime이 진행하지 않는다', async () => {
    const { fx, harness } = await makeActive(makeRenderer(), { reducedMotion: true })

    fx.render(0.5)

    expect(grade(harness).uniforms.uTime.value).toBe(0)
  })

  it('setReducedMotion(false)로 되돌리면 다시 진행한다', async () => {
    const { fx, harness } = await makeActive(makeRenderer(), { reducedMotion: true })
    const g = grade(harness)

    fx.render(0.5)
    fx.setReducedMotion(false)
    fx.render(0.25)

    expect(g.uniforms.uTime.value).toBeCloseTo(0.25, 10)
  })

  it('setBloomEnabled(false)가 bloom 패스만 끈다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())
    const bloom = harness.composer.passes[1]

    fx.setBloomEnabled(false)
    expect(bloom.enabled).toBe(false)
    // 마지막 수단이므로 다른 패스는 건드리지 않는다.
    expect(harness.composer.passes.map((p) => p.enabled)).toEqual([true, false, true, true])

    fx.setBloomEnabled(true)
    expect(bloom.enabled).toBe(true)
  })

  it('dispose()가 composer·bloom·grade를 해제하고 렌더 타깃을 이중 해제하지 않는다', async () => {
    const { fx, harness } = await makeActive(makeRenderer())
    const target = harness.composer.renderTarget1
    const targetDispose = vi.spyOn(target, 'dispose')

    fx.dispose()

    expect(harness.composer.disposed).toBe(1)
    expect(harness.composer.passes[1].disposed).toBe(1)
    expect(grade(harness).disposed).toBe(1)
    // composer.dispose()가 이미 renderTarget1을 해제한다 → 우리가 또 부르면 이중 해제다.
    expect(targetDispose).toHaveBeenCalledTimes(1)
  })
})

// ── 실제 애드온 스모크 ─────────────────────────────────────────────
describe('createPostFX 실제 애드온', () => {
  it('node(WebGL 없음)에서도 실제 애드온으로 체인이 구성되고 해제된다', async () => {
    vi.resetModules()
    const { createPostFX } = await import('../postfx')
    const renderer = makeRenderer(640, 360, 1)

    // 애드온 생성자는 순수 JS(렌더 타깃·머티리얼 객체 생성)라 GL 컨텍스트 없이도 통과한다.
    // render()만은 GL 상태 API를 부르므로 여기서는 호출하지 않는다.
    const fx = await createPostFX(THREE, asRenderer(renderer), scene, camera)

    expect(fx.active).toBe(true)
    expect(() => {
      fx.setBloomEnabled(false)
      fx.setSize(320, 180, 1)
      fx.dispose()
    }).not.toThrow()
  })
})

// ── 상수 가드 ──────────────────────────────────────────────────────
describe('포스트 프로세싱 상수', () => {
  it('블룸 상수가 "방송 화면" 범위 안에 있다', () => {
    // 0.6 이상은 화면 전체에 뿌연 막이 씌워지는 "싸구려 블룸" 영역(스윕 실측 근거).
    expect(BLOOM_STRENGTH).toBeLessThan(0.6)
    expect(BLOOM_STRENGTH).toBeGreaterThan(0)
    // 임계가 낮으면 잔디·라인 마킹까지 번진다.
    expect(BLOOM_THRESHOLD).toBeGreaterThanOrEqual(0.8)
    expect(BLOOM_THRESHOLD).toBeLessThan(1)
    expect(BLOOM_RADIUS).toBeGreaterThan(0)
    expect(BLOOM_RADIUS).toBeLessThanOrEqual(1)
  })

  it('그레이딩 상수가 과하지 않다', () => {
    // 0.3을 넘으면 방송 앵글에서 피치 네 귀퉁이가 눈에 띄게 죽는다.
    expect(VIGNETTE_STRENGTH).toBeLessThan(0.3)
    expect(VIGNETTE_STRENGTH).toBeGreaterThan(0)
    // 안쪽 반경이 너무 작으면 액션 존까지 어두워진다.
    expect(VIGNETTE_INNER).toBeGreaterThanOrEqual(0.45)
    expect(VIGNETTE_INNER).toBeLessThan(1)
    // 그레인은 8bit 계단(1/255)의 몇 배 수준. 0.03을 넘으면 정지 화면에서 노이즈로 인지된다.
    expect(GRAIN_AMOUNT).toBeGreaterThan(1 / 255)
    expect(GRAIN_AMOUNT).toBeLessThan(0.03)
    // 색수차는 1080p에서 1픽셀 미만이어야 "렌즈 신호"로만 남는다.
    expect(ABERRATION).toBeGreaterThan(0)
    expect(ABERRATION * 1920).toBeLessThan(1.5)
  })
})
