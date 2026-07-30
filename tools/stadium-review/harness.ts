// tools/stadium-review/harness.ts
// 스타디움 클로즈업 리뷰 하네스 — `docs/refs/stadium/*.png` 레퍼런스와 **같은 프레이밍**으로
// 프로덕션 씬을 렌더해 사이드바이사이드 비교용 스크린샷을 만든다.
// `tools/stadium-review/run.mjs`가 CDP로 이 페이지를 띄우고
// `window.__stadiumReview.run(...)`을 호출한다.
//
// 왜 tools/에 있는가(= three 정적 import가 허용되는 이유):
//   앱 번들(index.html)에 포함되지 않는다. `src/`의 "three는 동적 import만" 규칙은 엔트리
//   번들 오염 방지가 목적이고, 이 페이지는 vite dev가 개별 진입점으로 서빙할 뿐
//   `npm run build` 산출물에 들어가지 않는다. 자세한 근거는 tools/tone-stats/harness.ts 헤더.
//
// 결정론: Math.random · Date.now · new Date 금지. 카메라 값은 전부 아래 상수 표에 박혀 있다.
// 프레임타임은 재지 않는다 — 목적은 "스크린샷 한 장"이다.
import * as THREE from 'three'
import { createPostFX, type PostFX } from '../../src/ui/pitch/three/postfx'
import { EMISSIVE_BOOST, buildScene, type SceneBundle, type ThreeAPI } from '../../src/ui/pitch/three/scene'

/** 리뷰 뷰 = 레퍼런스 이미지 한 장에 대응하는 카메라 프레이밍. */
export type ViewName = 'goal-front' | 'goal-3q' | 'corner-flag' | 'adboard' | 'crowd-far' | 'stadium-wide'

export const VIEW_NAMES: readonly ViewName[] = [
  'goal-front',
  'goal-3q',
  'corner-flag',
  'adboard',
  'crowd-far',
  'stadium-wide',
]

export interface RunOptions {
  view: ViewName
  width: number
  height: number
  /** 포스트 프로세싱(블룸·비네트·그레인 + 발광체 HDR)을 붙일지. */
  post: boolean
}

export interface RunResult {
  view: ViewName
  width: number
  height: number
  /** 포스트FX가 실제로 붙었는가(애드온 로드 실패 시 false). */
  postActive: boolean
  /** 실제 씬에 생성된 관중 인스턴스 수 — 프레이밍 판정 시 디테일 밀도의 근거. */
  crowdCount: number
}

// ── 씬 파라미터 ───────────────────────────────────────────────────
/** 랜딩과 동일한 저해상 세팅 — 광각 뷰는 디테일보다 실루엣이 중요하고 빌드가 빠르다. */
const WIDE_SCENE = { crowdCount: 2000, pxPerMeter: 10 }
/**
 * 클로즈업 세팅. 관중 박스와 잔디·광고판 텍셀을 코앞에서 보므로 경기 화면(Match3D)과
 * 같은 4200/20을 쓴다. 그 아래로는 관중이 성기게 보여 레퍼런스와 비교가 불가능하다.
 */
const CLOSE_SCENE = { crowdCount: 4200, pxPerMeter: 20 }

interface ViewSpec {
  /** 세로 화각(deg). */
  fov: number
  /** 카메라 월드 위치. */
  pos: [number, number, number]
  /** 주시점. */
  look: [number, number, number]
  scene: { crowdCount: number; pxPerMeter: number }
  /** 근평면 — 코너 깃발처럼 3m 앞을 보는 뷰는 기본 0.5로 충분하지만 명시해 둔다. */
  near: number
  far: number
}

// ── 카메라 상수(전부 씬 실측 좌표에서 역산) ──────────────────────
// 공통 계산: 세로 화각 fov, 종횡비 a=16/9일 때
//   가로로 보이는 폭 W(거리 d) = 2·d·a·tan(fov/2)
//   세로로 보이는 높이 H(거리 d) = 2·d·tan(fov/2)
// 씬 실측치: 피치 105×68(x ±52.5, z ±34) · 골대 GOAL_W 7.32 / GOAL_H 2.44(x=±52.5)
//   네트 깊이 2.0 · 롱사이드 관중석 안쪽 z=±41, 엔드 x=±59.5 · STAND_DEPTH 26
//   RAKE 0.5rad(rise = 26·tan0.5 = 14.2) · STAND_H0 2.4 · 광고판 롱사이드 z=±37, y=0.55
const VIEWS: Record<ViewName, ViewSpec> = {
  /**
   * 골대 정면. 골대 폭 7.32m가 프레임 폭의 80%를 채우려면 가시 폭 W=9.15m가 필요하다.
   * fov 40°·a=16/9 → tan(hfov/2)=1.7778·tan20°=0.6471 → d = 9.15/(2·0.6471) = 7.07m.
   * 골라인 x=-52.5에서 피치 쪽으로 7.07m 물러난 x=-45.4, 눈높이 1.6m.
   */
  'goal-front': {
    fov: 40,
    pos: [-45.43, 1.6, 0],
    look: [-52.5, 1.15, 0],
    scene: CLOSE_SCENE,
    near: 0.2,
    far: 900,
  },
  /**
   * 같은 골대를 높은 3/4 사선에서. 레퍼런스 아래쪽 컷처럼 크로스바 윗면·측면 네트·
   * 뒷면 네트가 한 프레임에 들어와야 하므로 골 중심에서 +x·-z 대각으로 물러나 내려다본다.
   * 사선 뷰는 골대 장축이 깊이 방향으로 누워 화각 대비 크기가 비선형이다 — 실측으로 잡았다:
   *   d=14.2m → 골대 폭 38%(잔디만 넓은 빈 컷) · d=9.4m → 47%지만 크로스바가 상단에서 잘림
   *   d=11m  → 골대가 프레임 폭의 약 55%, 크로스바·좌우 포스트 모두 안쪽
   * 방위 45°(+x와 -z 사이) · 앙각 18°: 수평 11·cos18 = 10.46(=dx 7.4, dz -7.4),
   * 높이 11·sin18 = 3.4. 골 중심(-53.4, 1.3, 0) 기준 pos = (-46.0, 4.7, -7.4).
   * 이 각도에서 크로스바 윗면·측면 네트·뒷면 네트가 한 프레임에 들어온다.
   */
  'goal-3q': {
    fov: 40,
    pos: [-46.0, 4.7, -7.4],
    look: [-53.4, 1.3, 0],
    scene: CLOSE_SCENE,
    near: 0.2,
    far: 900,
  },
  /**
   * 코너 깃발(x=-52.5, z=-34). 규정 폴 높이 1.5m가 프레임 세로의 75%를 채우려면
   * 가시 높이 H=2.0m → fov 40°에서 d = 2.0/(2·tan20°) = 2.75m.
   * 카메라는 **피치 안쪽** 대각(+x, +z)에 둔다: 2.75/√2 = 1.95씩 → (-50.55, 0.95, -32.05).
   * 처음엔 러너프 쪽(z=-35.9)에서 봤는데 배경이 광고판 띠로 잘려 흰 폴 실루엣이 묻혔다(실측).
   * 안쪽에서 보면 코너 아크·골라인·터치라인이 모두 화면 중앙으로 모이고 배경은 어두운
   * 코너 스탠드라 레퍼런스(남색 배경 위 흰 폴)와 대비 조건이 같아진다.
   * 시선은 폴 중간 높이 0.8m — 지면(0)~폴 끝(1.5)이 세로 프레임 중앙에 온다.
   * ※ 아직 코너 깃발 오브젝트가 씬에 없으면 잔디만 보이는 것이 정상이다.
   */
  'corner-flag': {
    fov: 40,
    pos: [-50.55, 0.95, -32.05],
    look: [-52.5, 0.8, -34.0],
    scene: CLOSE_SCENE,
    near: 0.1,
    far: 900,
  },
  /**
   * 롱사이드 LED 광고판(z=+37, y=0.55). 100m 박스에 텍스처를 4회 반복하고 타일 하나에
   * AD_TEXTS 7개 패널이 들어가므로 패널 하나는 100/(4·7) = 3.57m다.
   * 패널 3.5장 ≈ 12.5m가 가로로 꽉 차게: d = 12.5/(2·0.6471) = 9.66m → z = 37-9.66 = 27.34.
   * ※ 이 거리는 textures.ts의 AD_TEXTS 개수에 의존한다 — 패널 수가 바뀌면 다시 잰다.
   * 거의 정면(눈높이 1.1m)에서 보드 중앙(y 0.6)을 살짝 내려다본다.
   */
  adboard: {
    fov: 40,
    pos: [0, 1.1, 27.34],
    look: [0, 0.6, 37],
    scene: CLOSE_SCENE,
    near: 0.2,
    far: 900,
  },
  /**
   * 반대편(+z) 롱사이드 관중석만으로 프레임을 채운다.
   * 관중 띠는 안쪽 (z=41, y≈3.3)에서 바깥 (z=67, y≈17.5)까지다. 카메라 (0,12,-10)에서
   * 두 끝의 앙각은 각각 atan(-8.7/51) = -9.7°와 atan(5.5/77) = +4.1° — 세로로 13.8°뿐이다.
   * 하늘·피치·광고판을 모두 잘라내려면 fov가 그보다 작아야 하므로 11°를 쓴다
   * (프레임 상하 ±5.5°가 전부 관중 띠 안에 들어간다). 시선은 띠 중앙 (z=54, y≈10.4).
   * 가로로는 2·60·1.7778·tan5.5° ≈ 20.5m — 158m 스탠드 안이라 끝이 보이지 않는다.
   */
  'crowd-far': {
    fov: 11,
    pos: [0, 12, -10],
    look: [0, 10.2, 54],
    scene: CLOSE_SCENE,
    near: 1,
    far: 900,
  },
  /**
   * 경기장 외부까지 보이는 광각. 랜딩(orbitR 110 · orbitY 50 · phase 3.3 · fov 38)과 같은
   * 방위각을 유지하되 반경·높이를 크게 키워 외벽과 밤하늘이 프레임 절반을 차지하게 한다.
   * phase 3.3 → (cos, sin) = (-0.9875, -0.1577). 반경 210에서는 경기장이 너무 작아졌고(실측),
   * 175 · 높이 82가 볼(bowl) 전체와 조명탑 4기를 담으면서 바깥 여백을 절반쯤 남기는 지점이다.
   */
  'stadium-wide': {
    fov: 42,
    pos: [-172.8, 82, -27.6],
    look: [0, 8, 0],
    scene: WIDE_SCENE,
    near: 1,
    far: 900,
  },
}

const HOME_COLOR = 0xe63946
const AWAY_COLOR = 0x4895ef

interface Live {
  renderer: THREE.WebGLRenderer
  bundle: SceneBundle
  post: PostFX
  camera: THREE.PerspectiveCamera
  /**
   * 씬 재사용 판정 키(씬 파라미터 + 해상도 + post). 6개 뷰 중 5개가 CLOSE_SCENE을 공유하므로
   * 카메라만 다시 겨누면 된다 — 씬 빌드(관중 4200 인스턴스 + 2100×1360 피치 텍스처)가
   * 이 도구의 실행 시간 대부분이다.
   */
  key: string
}

/** 씬을 다시 지어야 하는지 판정하는 키. 카메라 값은 **포함하지 않는다**. */
function sceneKey(opts: RunOptions): string {
  const s = VIEWS[opts.view]
  if (!s) throw new Error(`알 수 없는 뷰: ${opts.view}`)
  return `${s.scene.crowdCount}/${s.scene.pxPerMeter}|${opts.width}x${opts.height}|${opts.post ? 'post' : 'raw'}`
}

/** 뷰 스펙대로 카메라를 겨눈다(씬 재사용 경로와 신규 빌드 경로가 같은 코드를 쓰게). */
function aimCamera(camera: THREE.PerspectiveCamera, spec: ViewSpec, width: number, height: number): void {
  camera.fov = spec.fov
  camera.near = spec.near
  camera.far = spec.far
  camera.aspect = width / height
  camera.position.set(spec.pos[0], spec.pos[1], spec.pos[2])
  camera.lookAt(spec.look[0], spec.look[1], spec.look[2])
  camera.updateProjectionMatrix()
}

let live: Live | null = null

function teardown(): void {
  if (!live) return
  live.post.dispose()
  live.bundle.dispose()
  live.renderer.dispose()
  live.renderer.forceContextLoss?.()
  live.renderer.domElement.remove()
  live = null
}

/** 포스트FX 없이 렌더할 때 쓰는 최소 스텁(tone-stats 하네스와 같은 형태). */
function passthroughPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): PostFX {
  return {
    active: false,
    setSize: (w: number, h: number, pr: number) => {
      renderer.setPixelRatio(pr)
      renderer.setSize(w, h, false)
    },
    render: () => renderer.render(scene, camera),
    setBloomEnabled: () => {},
    setReducedMotion: () => {},
    dispose: () => {},
  }
}

async function build(opts: RunOptions): Promise<Live> {
  const host = document.getElementById('host')
  if (!host) throw new Error('#host 없음')
  const spec = VIEWS[opts.view]
  if (!spec) throw new Error(`알 수 없는 뷰: ${opts.view}`)

  // preserveDrawingBuffer: CDP Page.captureScreenshot이 렌더 직후가 아닐 수 있다.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(1)
  renderer.setSize(opts.width, opts.height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // 프로덕션(포스트FX 적용본)과 같은 톤매핑. raw 비교가 필요하면 --no-post로 ACES 기준선을 본다.
  renderer.toneMapping = opts.post ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = opts.post ? 1.15 : 1.05
  host.appendChild(renderer.domElement)

  const bundle = buildScene(THREE as unknown as ThreeAPI, {
    homeColor: HOME_COLOR,
    awayColor: AWAY_COLOR,
    crowdCount: spec.scene.crowdCount,
    pxPerMeter: spec.scene.pxPerMeter,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    emissiveBoost: opts.post ? EMISSIVE_BOOST : 1,
  })
  // 관중 아이들 모션은 t=0 고정(결정론). 호출하지 않으면 baseY 그대로라 결과는 같지만,
  // "정지 컷 한 장"의 기준 시각을 명시해 둔다.
  bundle.crowdWave(0, 0)

  const camera = bundle.camera
  aimCamera(camera, spec, opts.width, opts.height)

  const post = opts.post
    ? await createPostFX(THREE as unknown as ThreeAPI, renderer, bundle.scene, camera, {})
    : passthroughPost(renderer, bundle.scene, camera)
  if (opts.post && post.active) bundle.setEmissiveBoost(EMISSIVE_BOOST)
  post.setSize(opts.width, opts.height, 1)

  return { renderer, bundle, post, camera, key: sceneKey(opts) }
}

async function run(opts: RunOptions): Promise<RunResult> {
  const key = sceneKey(opts)
  if (live?.key !== key) {
    teardown()
    live = await build(opts)
  } else {
    aimCamera(live.camera, VIEWS[opts.view], opts.width, opts.height)
  }
  const { renderer, post, bundle } = live

  // 셰이더 컴파일·텍스처 업로드가 첫 프레임에 몰린다. 몇 장 버리고 마지막 한 장을 남긴다.
  for (let i = 0; i < 4; i++) post.render(1 / 60)

  // GPU 완료 보장. gl.finish()만으로는 Chrome이 커맨드 제출까지만 기다리고 돌아오므로
  // 백버퍼를 강제로 읽어 파이프라인을 비운다(tone-stats 하네스에서 실측으로 확인된 함정).
  const gl = renderer.getContext()
  const px = new Uint8Array(4)
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
  gl.finish()

  return {
    view: opts.view,
    width: opts.width,
    height: opts.height,
    postActive: post.active,
    crowdCount: bundle.crowdCount,
  }
}

declare global {
  interface Window {
    __stadiumReview?: {
      run(opts: RunOptions): Promise<RunResult>
      teardown(): void
    }
  }
}

window.__stadiumReview = { run, teardown }
