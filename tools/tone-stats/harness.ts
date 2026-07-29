// tools/tone-stats/harness.ts
// 톤 통계 계측 하네스 — 브라우저 안에서 대표 장면을 **결정론적으로** 렌더하고
// 픽셀 히스토그램·프레임타임을 돌려준다. `tools/tone-stats/run.mjs`가 CDP로 이 페이지를
// 띄우고 `window.__toneHarness.run(...)`을 호출한다.
//
// 왜 이 파일이 tools/에 있는가:
//  - 앱 번들(index.html)에 포함되지 않는다 → 여기서는 three를 **정적 import 해도 안전하다**.
//    (`src/`의 규칙 "three는 동적 import만"은 엔트리 번들 오염 방지가 목적이고, 이 페이지는
//     vite dev가 개별 진입점으로 서빙할 뿐 `npm run build` 산출물에 들어가지 않는다.)
//  - 대신 **씬·포스트FX·카메라·선수 리그는 전부 프로덕션 모듈을 그대로 쓴다.** 계측이
//    실제 화면과 다른 코드를 재면 의미가 없다.
//
// 결정론: Math.random·Date 금지. 시간은 전부 호출부가 주는 상수(고정 t)로만 흐른다.
import * as THREE from 'three'
import { createMatch } from '../../src/engine/simulate'
import { makeTestTeam } from '../../src/engine/fixtures/testTeams'
import { createCameraRig, type CameraMode } from '../../src/ui/pitch/three/camera'
import { FLASH_SCORED, createBall, flashQuad, goalBurst } from '../../src/ui/pitch/three/fx3d'
import { computeFrame } from '../../src/ui/pitch/three/movement'
import { createPlayer, disposePlayerCaches, type PlayerRig } from '../../src/ui/pitch/three/player3d'
import { createPostFX, type PostFX } from '../../src/ui/pitch/three/postfx'
import { EMISSIVE_BOOST, buildScene, type SceneBundle, type ThreeAPI } from '../../src/ui/pitch/three/scene'
import { toneStats, type ToneStats } from '../../src/ui/pitch/three/tone'

/** 계측 대상 장면. Match3D·StadiumBackdrop의 대표 순간을 재현한다. */
export type SceneName = 'landing' | 'broadcast' | 'goal'

export interface RunOptions {
  scene: SceneName
  /** 포스트 프로세싱 스택을 붙일지. false면 변경 전(원시 렌더) 기준선이 된다. */
  post: boolean
  width: number
  height: number
  /** 프레임타임 측정 횟수(0이면 측정 생략). */
  frames: number
  /** 톤매퍼 비교용 오버라이드. 미지정이면 프로덕션 기본값. */
  tonemap?: 'aces' | 'neutral' | 'agx' | 'none'
  exposure?: number
  /** 포스트FX 계수 스윕용 오버라이드. */
  bloomStrength?: number
  bloomThreshold?: number
  bloomRadius?: number
  emissiveBoost?: number
  skyBoost?: number
  vignette?: number
  grain?: number
}

export interface RunResult {
  scene: SceneName
  post: boolean
  /** 포스트FX가 실제로 붙었는가(애드온 로드 실패 시 false). */
  postActive: boolean
  width: number
  height: number
  stats: ToneStats
  /** gl.finish()로 GPU 완료까지 포함해 잰 프레임타임(ms). */
  frameMs: { mean: number; p50: number; p95: number; min: number; max: number }
}

// ── 고정 파라미터(전부 결정론) ────────────────────────────────────
/** 엔진 시드 — 스크린샷 회귀 비교를 위해 절대 바꾸지 않는다. */
const SEED = 11
/** 계측용 고정 분·분내진행도. 킥오프 배치보다 필드가 넓게 퍼지는 지점. */
const MINUTE = 34
const FRAME_T = 0.5
/** 카메라 워크에 넣을 고정 경과 시간(s) — 오퍼레이터 호흡 위상까지 고정된다. */
const CAM_T = 12
/**
 * 골 장면: 파티클 수명 중 가장 화려한 시점(s)과 섬광 진행 시점(s).
 * 섬광은 0.55s 동안 감쇠하는데 0.1s에서는 화면의 90%가 흰색이라 톤 통계가 "섬광 밝기"만
 * 재게 된다. 0.38s면 잔광이 남은 채로 골대 뒤 로우앵글·파티클·관중이 함께 보인다.
 */
const BURST_AGE = 0.28
const FLASH_AGE = 0.38

/** 랜딩 배경 카메라(StadiumBackdrop 상수와 동일해야 계측이 의미를 갖는다). */
const LANDING = { orbitR: 148, orbitY: 62, phase: 0.85, fov: 38, crowd: 2000, pxPerMeter: 10 }
/** 경기 화면 씬 파라미터(Match3D 상수와 동일). */
const MATCH = { crowd: 4200, pxPerMeter: 20 }

const HOME_COLOR = 0xe63946
const AWAY_COLOR = 0x4895ef
const HOME_ACCENT = 0xf2f5ff
const AWAY_ACCENT = 0x0b1a33

const state = createMatch(makeTestTeam('kor', 78), makeTestTeam('esp', 86), { seed: SEED })

interface Live {
  renderer: THREE.WebGLRenderer
  bundle: SceneBundle
  post: PostFX
  camera: THREE.PerspectiveCamera
  rigs: PlayerRig[]
  extras: Array<{ dispose(): void }>
}

let live: Live | null = null

function teardown(): void {
  if (!live) return
  live.post.dispose()
  for (const e of live.extras) e.dispose()
  for (const r of live.rigs) r.dispose()
  live.bundle.dispose()
  disposePlayerCaches()
  live.renderer.dispose()
  live.renderer.forceContextLoss?.()
  live.renderer.domElement.remove()
  live = null
}

/** 정렬된 배열에서 퍼센타일(선형 보간 없이 가장 가까운 하한 인덱스). */
function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))
  return sorted[i]
}

async function build(opts: RunOptions): Promise<Live> {
  const host = document.getElementById('host')
  if (!host) throw new Error('#host 없음')

  // preserveDrawingBuffer: 렌더 직후가 아니어도 drawImage로 픽셀을 꺼낼 수 있어야 한다.
  // 프로덕션에는 없는 플래그다(대역폭 비용) — 계측 전용.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  })
  renderer.setPixelRatio(1)
  renderer.setSize(opts.width, opts.height, false)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  const TONEMAP = {
    aces: THREE.ACESFilmicToneMapping,
    neutral: THREE.NeutralToneMapping,
    agx: THREE.AgXToneMapping,
    none: THREE.NoToneMapping,
  }
  // 기본값은 **변경 전/후를 그대로 재현**한다:
  //   raw  = 변경 전 프로덕션(ACESFilmic + 원시 렌더)
  //   post = 변경 후 프로덕션(Neutral + 블룸·비네트·그레인)
  // 스윕에서만 opts.tonemap으로 덮어쓴다.
  renderer.toneMapping = TONEMAP[opts.tonemap ?? (opts.post ? 'neutral' : 'aces')]
  renderer.toneMappingExposure = opts.exposure ?? (opts.post ? 1.15 : 1.05)
  host.appendChild(renderer.domElement)

  const landing = opts.scene === 'landing'
  const bundle = buildScene(THREE as unknown as ThreeAPI, {
    homeColor: HOME_COLOR,
    awayColor: AWAY_COLOR,
    crowdCount: landing ? LANDING.crowd : MATCH.crowd,
    pxPerMeter: landing ? LANDING.pxPerMeter : MATCH.pxPerMeter,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    // 블룸이 붙을 때만 조명탑·LED를 HDR로 올린다(포스트FX 없이는 그냥 흰색 클리핑이다).
    emissiveBoost: opts.post ? (opts.emissiveBoost ?? EMISSIVE_BOOST) : 1,
    skyBoost: opts.post ? opts.skyBoost : 1,
  })
  const camera = bundle.camera
  camera.aspect = opts.width / opts.height
  const rigs: PlayerRig[] = []
  const extras: Array<{ dispose(): void }> = []

  if (landing) {
    camera.fov = LANDING.fov
    camera.position.set(
      Math.cos(LANDING.phase) * LANDING.orbitR,
      LANDING.orbitY,
      Math.sin(LANDING.phase) * LANDING.orbitR,
    )
    camera.lookAt(0, 6, 0)
    camera.updateProjectionMatrix()
  } else {
    const frame = computeFrame({
      state,
      minute: MINUTE,
      t: FRAME_T,
      prev: null,
      dt: 1 / 60,
      sequence: null,
      sequenceSide: null,
      seed: SEED,
      dwellMs: 3000,
    })

    const gkHome = state.home.tactics.lineup[0]?.playerId
    const gkAway = state.away.tactics.lineup[0]?.playerId
    for (const pose of frame.players) {
      const rig = createPlayer(THREE as unknown as ThreeAPI, {
        kit: pose.side === 'home' ? HOME_COLOR : AWAY_COLOR,
        accent: pose.side === 'home' ? HOME_ACCENT : AWAY_ACCENT,
        number: pose.number,
        isGk: pose.id === gkHome || pose.id === gkAway,
      })
      rig.apply(pose, CAM_T)
      bundle.scene.add(rig.root)
      rigs.push(rig)
    }

    const ball = createBall(THREE as unknown as ThreeAPI, {})
    ball.update(frame.ball, 1 / 60)
    bundle.scene.add(ball.group)
    extras.push(ball)

    const mode: CameraMode = opts.scene === 'goal' ? 'goal-cam' : 'broadcast'
    const rig = createCameraRig({ seed: SEED, mode })
    rig.update({ focus: frame.focus, t: CAM_T, dt: 1 / 60, camera })

    if (opts.scene === 'goal') {
      const burst = goalBurst(
        THREE as unknown as ThreeAPI,
        HOME_COLOR,
        { x: frame.ball.x, y: Math.max(frame.ball.y, 0.6), z: frame.ball.z },
        { seed: SEED + MINUTE },
      )
      // 파티클을 고정 스텝으로 BURST_AGE까지 진행(가변 dt를 쓰면 결정론이 깨진다).
      const step = 1 / 120
      for (let s = 0; s < BURST_AGE; s += step) burst.update(step)
      bundle.scene.add(burst.mesh)
      extras.push(burst)

      const flash = flashQuad(THREE as unknown as ThreeAPI, 0xffffff, {})
      flash.attach(camera)
      flash.flash(FLASH_SCORED)
      for (let s = 0; s < FLASH_AGE; s += step) flash.update(step)
      extras.push(flash)

      // 골 세리머니 창의 관중(파도타기 정점) — 골 장면의 밝기 분포에 크게 기여한다.
      bundle.crowdWave(CAM_T, 1)
    }
  }
  camera.updateProjectionMatrix()

  const post = opts.post
    ? await createPostFX(THREE as unknown as ThreeAPI, renderer, bundle.scene, camera, {
        bloomStrength: opts.bloomStrength,
        bloomRadius: opts.bloomRadius,
        bloomThreshold: opts.bloomThreshold,
        vignette: opts.vignette,
        grain: opts.grain,
      })
    : {
        active: false,
        setSize: (w: number, h: number, pr: number) => {
          renderer.setPixelRatio(pr)
          renderer.setSize(w, h, false)
        },
        render: () => renderer.render(bundle.scene, camera),
        setBloomEnabled: () => {},
        setReducedMotion: () => {},
        dispose: () => {},
      }
  post.setSize(opts.width, opts.height, 1)

  return { renderer, bundle, post, camera, rigs, extras }
}

/** 캔버스 픽셀을 RGBA8로 꺼낸다(2D 캔버스 경유 = 화면에 실제로 보이는 sRGB 값). */
function readPixels(canvas: HTMLCanvasElement): Uint8ClampedArray {
  const c2 = document.createElement('canvas')
  c2.width = canvas.width
  c2.height = canvas.height
  const ctx = c2.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D 컨텍스트를 만들 수 없다')
  ctx.drawImage(canvas, 0, 0)
  return ctx.getImageData(0, 0, c2.width, c2.height).data
}

async function run(opts: RunOptions): Promise<RunResult> {
  teardown()
  live = await build(opts)
  const { renderer, post } = live
  const gl = renderer.getContext()

  // GPU 완료를 **강제로** 기다린다. gl.finish()만으로는 Chrome이 커맨드 버퍼 제출까지만
  // 기다리고 돌아와서 0.3ms 같은 거짓 수치가 나온다(실측으로 확인). 1픽셀 readPixels는
  // 백버퍼를 읽어야 하므로 파이프라인 전체가 반드시 비워진다.
  const px = new Uint8Array(4)
  const sync = (): void => {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.finish()
  }

  // 워밍업 — 첫 렌더는 셰이더 컴파일·텍스처 업로드가 섞여 프레임타임이 무의미하다.
  for (let i = 0; i < 5; i++) post.render(1 / 60)
  sync()

  const samples: number[] = []
  for (let i = 0; i < opts.frames; i++) {
    const t0 = performance.now()
    post.render(1 / 60)
    // CPU/GPU 오버랩이 사라져 실제 파이프라인보다 비관적이지만, raw와 post를 **같은 조건**으로
    // 재므로 증분(=포스트FX가 먹는 시간)은 정확하다.
    sync()
    samples.push(performance.now() - t0)
  }
  // 통계용 최종 프레임(스크린샷도 이 프레임을 찍는다).
  post.render(1 / 60)
  sync()

  samples.sort((a, b) => a - b)
  const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0

  return {
    scene: opts.scene,
    post: opts.post,
    postActive: post.active,
    width: opts.width,
    height: opts.height,
    stats: toneStats(readPixels(renderer.domElement)),
    frameMs: {
      mean,
      p50: pct(samples, 0.5),
      p95: pct(samples, 0.95),
      min: samples.length ? samples[0] : 0,
      max: samples.length ? samples[samples.length - 1] : 0,
    },
  }
}

declare global {
  interface Window {
    __toneHarness?: {
      run(opts: RunOptions): Promise<RunResult>
      teardown(): void
    }
  }
}

window.__toneHarness = { run, teardown }
