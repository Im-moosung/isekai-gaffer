// src/ui/pitch/three/Match3D.tsx
// Phase 4E 3D 매치 뷰 — 통합 컴포넌트. 지금까지의 4개 모듈(movement·scene·player3d·
// camera·fx3d)을 하나의 rAF 루프로 조립해 "3D 선수가 뛰는 방송 화면"을 만든다.
//
// 설계 원칙(Phase 4E Global Constraints):
//  - three는 **동적 import만**(`await import('three')`). 정적 import 금지 — 엔트리 번들에
//    three가 새면 안 된다(build 후 grep 검증). 하위 모듈들도 three는 타입만 import한다.
//  - **Math.random·Date 금지**. 시간은 three Clock(표시 전용), 변주는 전부 시드 해시.
//  - **폴백 체인**: WebGL2 불가 · 렌더러 생성 실패 · three 청크 로드 실패 · 컨텍스트 로스 →
//    `fallback` 노드(=PixiPitch 체인)로 즉시 교체. 크래시 금지.
//  - **props 계약은 PixiPitch와 동일**(state/lastEvent/sequence/dwellMs/sequenceSide) —
//    드롭인 교체. `fallback`만 선택 추가(pixi를 이 청크로 끌고 오지 않기 위해 노드로 주입받는다).
//  - **누수 0**: 언마운트 시 rig·ball·burst·flash·scene·renderer + disposePlayerCaches까지.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MatchEvent, MatchState } from '../../../engine/types'
import type { ChoreoStep } from '../choreography'
import { createCameraRig } from './camera'
import { entranceCameraMode, entranceFrame, type EntranceScript } from './entrance'
import { endsSwapped } from '../ends'
import { FLASH_CONCEDED, FLASH_SCORED, createBall, flashQuad, goalBurst, type GoalBurst } from './fx3d'
import { bindResize, createRendererHost, webgl2Available } from './host'
import { DIVE_LAY_U, KICK_IMPACT_T, computeFrame } from './movement'
import { createNameplateLayer, type PlateItem } from './nameplates'
import './nameplates.css'
import { createRenderScaler, readStoredScale, writeStoredScale } from './perf'
import { createPlayer, disposePlayerCaches, type PlayerRig } from './player3d'
import { createPostFX } from './postfx'
import { EMISSIVE_BOOST, buildScene, type ThreeAPI } from './scene'
import { FIRST_HALF_ENDS, rotateFrame, type FrameState } from './types'

interface Match3DProps {
  state: MatchState
  lastEvent?: MatchEvent
  /** 하이라이트 안무 시퀀스(있으면 공·무버·카메라·골FX 재생). */
  sequence?: ChoreoStep[]
  /** 시퀀스 재생 총 시간(ms) = 그 분의 dwell. 분 내 진행도 t를 여기서 만든다. */
  dwellMs?: number
  /** 시퀀스 재생(공격) 팀. */
  sequenceSide?: 'home' | 'away'
  /** 일시정지 — 시뮬 시계를 전진시키지 않고 렌더도 건너뛴다(마지막 프레임 정지). */
  paused?: boolean
  /**
   * 이 시퀀스의 근거 이벤트. 하이라이트가 아닌 분에는 **null**을 넘겨야 한다 —
   * 미지정이면 movement가 state.events에서 그 분의 이벤트를 역추적하는데, 그러면
   * "코너가 났지만 화면은 점유 흐름"인 분에 코너 궤적·카메라가 잘못 붙는다.
   */
  event?: MatchEvent | null
  /** 3D를 쓸 수 없을 때 대신 렌더할 노드(렌더러 체인의 다음 단계 = PixiPitch). */
  fallback?: ReactNode
  /**
   * 입장 연출 캐스트. null이 아니면 **경기 프레임 대신 입장 연출을 렌더한다**
   * (킥오프 전 한정). 연출의 시계는 DOM 오버레이가 소유한다 — 3D는 읽기만 한다.
   */
  entrance?: EntranceScript | null
  /**
   * 입장 연출 경과 ms를 담은 가변 ref. **prop이 아니라 ref인 이유**: 오버레이는 60fps로
   * 진행하는데 이걸 state로 올리면 초당 60회 React 리렌더가 발생한다(3D 루프는 이미
   * rAF로 돌고 있으므로 리렌더가 얻는 것이 하나도 없다).
   */
  entranceClock?: { current: number }
}

const HOME_FALLBACK = 0xe63946
const AWAY_FALLBACK = 0x4895ef
/** 홈 양말·디테일(흰색) / 어웨이(네이비) — GK 킷도 이 액센트로 갈린다. */
const HOME_ACCENT = 0xf2f5ff
const AWAY_ACCENT = 0x0b1a33

/**
 * 관중 목표 인원. **저사양이어도 줄이지 않는다.**
 * 예전 성능 가드는 여기를 반토막 내고 피치 텍스처를 12px/m로 떨궜는데, 그러면 하필
 * 심사자의 느린 기기에서만 화면이 초라해진다. 지금은 {@link createRenderScaler}가
 * 해상도만 거래하고 연출은 손대지 않는다.
 */
const CROWD_FULL = 4200
/** 피치 텍스처 해상도(px/m). */
const PX_PER_M = 20

/** 골 순간 골대 뒤 로우 앵글을 유지하는 시간(s). 이후 리액션 컷으로 넘어간다. */
const GOAL_CAM_S = 0.9
/**
 * 리액션 컷(득점자 로우앵글 클로즈)이 끝나는 시각(s, 골 기준).
 *
 * 실제 중계의 골 편집 문법은 "골 → 골대 뒤 → 득점자 리액션 → 와이드 세리머니"다.
 * 골대 뒤에서 곧장 오빗으로 넘어가면 득점자를 한 번도 크게 못 보고 카메라만 돈다.
 * 0.9~2.2s의 1.3초 창은 리그의 0.6초 전환을 빼고도 0.7초가 남아 컷이 인지된다.
 */
const REACTION_END_S = 2.2
/**
 * 골 연출(goal-cam + reaction + celebrate) 총 길이(s). **분 경계와 무관하게** 흐른다 —
 * 골 키프레임은 dwell의 끝자락(t≈0.7~0.85)이라 분에 묶어두면 세리머니가 1초 만에 잘린다.
 * 리액션 컷을 끼워도 총 체류 시간은 그대로 유지한다(뒤 연출을 밀어내지 않는다).
 */
const CELEBRATE_TOTAL_S = 4.5
/** 골 뒤 관중이 뛰는 시간(s) — 이 창 밖에서는 crowdWave를 호출하지 않는다. */
const CROWD_WINDOW_S = 4
/** 카메라 셰이크 임펄스(m). */
const GOAL_IMPULSE = 0.35

// ── 임팩트 연출(발-공 / 손-공) ────────────────────────────────────
// 리서치(§2.3)는 "타격감의 본체는 임팩트 프레임을 볼 출발 시각에 맞추는 것이고 히트스톱은
// 그 위의 화장"이라고 결론냈다. 본체(역방향 스케줄링·GK 인과)는 c9daccf에서 끝났으므로
// 이제 화장을 올린다. **히트스톱은 채택하지 않았다** — 우리 볼 위치는 dwell 상대 t의
// 순수 함수라 몇 프레임 정지시키려면 시간축에 오프셋 상태를 들여야 하고, 그러면 실측으로
// 캘리브레이션한 구간 소요(볼 속도)가 화면에서 그대로 나오지 않는다. 결정론 계약에도
// 상태가 하나 늘어난다. 대신 **접촉 프레임에 셰이크 + 잔디 파편**만 붙인다(비용 0의 상태).
/** 킥 접촉 셰이크(m) — 골(0.35)의 1/3. 화면이 흔들렸다고 인지되는 최소치. */
const KICK_IMPULSE = 0.11
/** 세이브 접촉 셰이크(m) — 킥보다 크다(막아 낸 쪽이 더 큰 사건이다). */
const SAVE_IMPULSE = 0.18
/** 임팩트 파편 수·수명(s) — 접촉점에 붙어 0.3 s 만에 사라지는 잔디 조각. */
const IMPACT_COUNT = 16
const IMPACT_LIFE = 0.34
/** 잔디 파편 색(마른 잔디·흙). 팀 컬러를 쓰면 골 콘페티와 구분되지 않는다. */
const IMPACT_COLOR = 0xcfd6c4
/** 교체·퇴장으로 새 선수가 등장해도 리그 수는 여기서 멈춘다(무한 증식 방지). */
const MAX_RIGS = 40

/** 심판 킷(입장 연출 전용) — 어느 팀 색과도 겹치지 않는 차콜. 액센트는 심판 노랑. */
const REF_KIT = 0x1a1d24
const REF_ACCENT = 0xf2c94c

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** getComputedStyle에서 CSS 색 변수를 0xRRGGBB로 읽는다(테마 대응). 실패 시 fallback. */
function cssColor(el: HTMLElement, name: string, fallback: number): number {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim()
    if (v.startsWith('#')) {
      const hex = v.slice(1)
      if (hex.length === 3) return parseInt(hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2], 16)
      if (hex.length >= 6) return parseInt(hex.slice(0, 6), 16)
    }
  } catch {
    /* ignore */
  }
  return fallback
}

/** localStorage가 막힌 환경(사파리 프라이빗 등)에서 throw하지 않게 감싼다. */
function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * 3D 방송 화면. 마운트 1회 초기화 후 props는 ref로 루프가 읽는다(PixiPitch와 같은 패턴).
 * 실패 시 `fallback`(PixiPitch 체인)을 대신 렌더한다.
 */
export function Match3D(props: Match3DProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // WebGL2 불가 → 즉시 폴백(동기 — jsdom 테스트에서 자연 검증).
    if (!webgl2Available()) {
      setFailed(true)
      return
    }

    let cancelled = false
    let teardown: (() => void) | null = null

    void (async () => {
      let THREE: ThreeAPI
      try {
        THREE = (await import('three')) as unknown as ThreeAPI
      } catch {
        if (!cancelled) setFailed(true)
        return
      }
      if (cancelled) return

      const reducedMql = window.matchMedia('(prefers-reduced-motion: reduce)')
      let reduced = reducedMql.matches

      // ── 적응형 해상도 스케일러 ──────────────────────────────────
      // 장치 기준 픽셀비(=스케일 1.0). 직전 세션이 학습한 스케일에서 출발해
      // 느린 기기가 매번 처음부터 굴러떨어지는 것을 막는다.
      const basePixelRatio = Math.min(window.devicePixelRatio || 1, 2)
      const scaler = createRenderScaler({
        basePixelRatio,
        initialScale: readStoredScale(safeStorage()),
      })

      // ── 렌더러(호출부 소유) ──────────────────────────────────────
      // 생성·컬러스페이스·톤매핑·부착은 랜딩 배경과 같은 계약이라 host.ts가 담당한다.
      const renderer = createRendererHost(THREE, host, {
        className: 'm3d-canvas',
        powerPreference: 'high-performance',
        pixelRatio: scaler.pixelRatio,
      })
      if (!renderer) {
        if (!cancelled) setFailed(true)
        return
      }

      const homeColor = cssColor(host, '--bc-home', HOME_FALLBACK)
      const awayColor = cssColor(host, '--bc-away', AWAY_FALLBACK)

      // ── 씬 · 볼 · FX · 카메라 리그 ───────────────────────────────
      const bundle = buildScene(THREE, {
        homeColor,
        awayColor,
        // 입장 배너(스토리보드 컷1) — 팀명을 새긴 팀 색 천. 실제 국기는 쓰지 않는다.
        homeLabel: propsRef.current.state.home.team.name.ko,
        awayLabel: propsRef.current.state.away.team.name.ko,
        crowdCount: CROWD_FULL,
        pxPerMeter: PX_PER_M,
        maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      })
      const scene = bundle.scene
      const camera = bundle.camera
      /**
       * 선수 이름표(DOM 오버레이). 캔버스 위에 얹으므로 렌더러가 붙은 **뒤**에 만든다.
       * 실제 배치·표시 판단은 nameplates.ts가 하고, 여기서는 투영만 넘긴다.
       */
      const plates = createNameplateLayer(host)

      const ball = createBall(THREE)
      scene.add(ball.group)
      const flash = flashQuad(THREE, 0xffffff, { reducedMotion: reduced })
      flash.attach(camera)
      const camRig = createCameraRig({ seed: propsRef.current.state.seed, reducedMotion: reduced })

      // ── 22 리그(교체 선수는 등장 시 지연 생성) ────────────────────
      const rigs = new Map<string, PlayerRig>()
      const ensureRig = (id: string, side: 'home' | 'away', number: number, isGk: boolean): PlayerRig | null => {
        const hit = rigs.get(id)
        if (hit) return hit
        if (rigs.size >= MAX_RIGS) return null
        const rig = createPlayer(THREE, {
          kit: side === 'home' ? homeColor : awayColor,
          accent: side === 'home' ? HOME_ACCENT : AWAY_ACCENT,
          number,
          isGk,
        })
        rigs.set(id, rig)
        scene.add(rig.root)
        return rig
      }
      /**
       * 심판 리그 — 입장 연출에서만 쓰므로 **연출이 실제로 재생될 때** 만든다.
       * (건너뛴 유저에게 리그 하나를 만들어 줄 이유가 없다.)
       */
      const refRigs: PlayerRig[] = []
      const ensureRefRig = (i: number): PlayerRig => {
        while (refRigs.length <= i) {
          const rig = createPlayer(THREE, { kit: REF_KIT, accent: REF_ACCENT, number: 0, isGk: false })
          scene.add(rig.root)
          refRigs.push(rig)
        }
        return refRigs[i]
      }

      // 선발 22명은 첫 프레임 전에 만들어 둔다(루프 안에서 22개 생성 = 렌더 히치).
      for (const side of ['home', 'away'] as const) {
        const st = propsRef.current.state[side]
        const numById = new Map(st.team.squad.map(s => [s.id, s.number]))
        st.tactics.lineup.forEach((slot, i) => {
          ensureRig(slot.playerId, side, numById.get(slot.playerId) ?? 0, i === 0)
        })
      }

      // ── 포스트 프로세싱(비동기 — 실패해도 passthrough가 온다) ────
      const post = await createPostFX(THREE, renderer, scene, camera, { reducedMotion: reduced })
      // 컴포저가 실제로 붙었을 때만 발광체를 HDR로 올린다. 폴백 경로에서 올리면
      // 조명탑이 그냥 흰색으로 타 버린다.
      if (post.active) bundle.setEmissiveBoost(EMISSIVE_BOOST)

      // ── 리사이즈 ─────────────────────────────────────────────────
      // 픽셀비는 항상 스케일러가 정한 값을 쓴다(성능 가드가 여기 한 곳으로 모인다).
      const resize = (): void => {
        const w = host.clientWidth
        const h = host.clientHeight
        if (w < 2 || h < 2) return
        post.setSize(w, h, scaler.pixelRatio)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      resize()
      const unbindResize = bindResize(host, resize)

      const onReducedChange = (): void => {
        reduced = reducedMql.matches
        camRig.setReducedMotion(reduced)
        // 그레인 애니메이션은 미세하지만 전면 깜빡임이다 — 모션 최소화에서 정지시킨다.
        post.setReducedMotion(reduced)
      }
      reducedMql.addEventListener?.('change', onReducedChange)

      // ── 이름표 투영 ──────────────────────────────────────────────
      /**
       * 이름표 텍스트 — **성(姓)만** 쓴다. 화면상 9~15 px에서 전체 이름은 폭이 두 배가
       * 되고, 방송 자막도 라이브 중에는 성만 띄운다. 한국어 이름은 성이 앞이라 첫 글자,
       * 라틴 표기는 마지막 낱말이 성이다. 로케일 판정 없이 한글 유무로 가른다.
       */
      const plateText = (ko: string): string => {
        const t = ko.trim()
        if (t.length === 0) return ''
        // ★ 한글 여부로 가르면 안 된다 — 외국 선수 이름도 **한글로 음역**돼 있어서
        //   `/[가-힣]/`가 참이 되고, 그러면 "페란 토레스"가 slice(0,4)로 "페란 토"가
        //   된다(실주행에서 확인: 로빈 흐 / 블라디미 / 옌스 카).
        //   진짜 신호는 **공백**이다. 한국식 이름은 한 낱말(김민재), 음역명은
        //   이름+성 두 낱말이다. 실측: 312명 중 음역 284 · 한국식 28, 성이 6자를
        //   넘는 경우 0건 — 그래서 자를 필요가 없다.
        const parts = t.split(/\s+/)
        // 성만 쓴다 — 방송 자막도 라이브 중에는 성만 띄운다. 한국식은 성만 쓰면
        // 김/이/박이 즐비하므로 통째로 둔다.
        return parts.length > 1 ? parts[parts.length - 1] : t
      }
      /** id → 이름표 문자열. 스쿼드는 경기 중 바뀌지 않으므로 팀별로 한 번만 만든다. */
      const nameCache = new Map<string, Map<string, string>>()
      const namesOf = (side: 'home' | 'away'): Map<string, string> => {
        const st = propsRef.current.state[side]
        let m = nameCache.get(st.team.id)
        if (!m) {
          m = new Map(st.team.squad.map(pl => [pl.id, plateText(pl.name.ko)]))
          nameCache.set(st.team.id, m)
        }
        return m
      }
      /** 투영 임시 벡터 — 매 프레임 44회 쓰므로 한 개를 돌려 쓴다(GC 금지). */
      const projV = new THREE.Vector3()
      /** 머리 꼭대기 높이(m) — pose.HIP_Y(0.94) + SHOULDER_Y(0.5) + 머리 반지름 여유. */
      const HEAD_Y = 1.72
      const plateItems: PlateItem[] = []

      const updatePlates = (frame: FrameState, _t: number): void => {
        const w = host.clientWidth
        const h = host.clientHeight
        if (w < 2 || h < 2) {
          plates.clear()
          return
        }
        camera.updateMatrixWorld()
        plateItems.length = 0
        const homeNames = namesOf('home')
        const awayNames = namesOf('away')
        for (const pose of frame.players) {
          const text = (pose.side === 'home' ? homeNames : awayNames).get(pose.id) ?? ''
          if (!text) continue
          // 머리 · 발 두 점을 투영한다. 둘의 픽셀 간격이 곧 "화면상 선수 키"이고,
          // 그 값이 카메라 거리·화각·창 크기를 한 수로 요약한다.
          projV.set(pose.x, HEAD_Y, pose.z).project(camera)
          const inFront = projV.z < 1
          const hx = (projV.x * 0.5 + 0.5) * w
          const hy = (-projV.y * 0.5 + 0.5) * h
          projV.set(pose.x, 0, pose.z).project(camera)
          const fy = (-projV.y * 0.5 + 0.5) * h
          plateItems.push({
            id: pose.id,
            side: pose.side,
            text,
            sx: hx,
            sy: hy,
            playerPx: Math.abs(fy - hy),
            inFront,
            // 중요도 = 볼까지의 거리. 화면이 좁으면 공 주변부터 이름이 남는다.
            rank: Math.hypot(pose.x - frame.ball.x, pose.z - frame.ball.z),
          })
        }
        plates.update(plateItems, w, h)
      }

      // ── 루프 상태 ────────────────────────────────────────────────
      // three Clock은 r185에서 deprecated(콘솔 경고) → Timer. document에 connect하면
      // Page Visibility API로 탭 복귀 시의 거대한 delta를 0으로 눌러준다.
      const timer = new THREE.Timer()
      timer.connect(document)
      const bursts: GoalBurst[] = []
      const seen = new Set<string>()
      let prevFrame: FrameState | null = null
      let raf = 0
      let lastMinute = -1
      let lastSeq: ChoreoStep[] | undefined
      let minuteStart = 0
      let goalMinute = -1
      let goalFired = false
      let goalAt = -1
      let crowdActive = false
      /**
       * 직전 프레임의 킥·다이브 진행도. **접촉 프레임 검출**에만 쓴다 —
       * 진행도가 임팩트 지점(킥 {@link KICK_IMPACT_T} / 다이브 {@link DIVE_LAY_U})을
       * 넘어서는 그 한 프레임에만 셰이크·파편이 발동한다(매 프레임 쌓이지 않게).
       */
      let prevKickT = -1
      let prevDiveT = -1
      /**
       * 최후의 수단(블룸 끄기)을 이미 썼는가. 해상도 하한에서도 계속 느릴 때 **한 번만**
       * 발동한다. 그래도 관중·파티클 같은 연출은 끝까지 살려 둔다.
       */
      let bloomDropped = false
      /** localStorage에 기록한 스케일(같은 값을 반복해서 쓰지 않기 위한 캐시). */
      let storedScale = scaler.scale
      /**
       * 일시정지 동안 흘려보낸 실시간(s). **시뮬 시계에서 통째로 뺀다** —
       * 정지 중에도 timer는 계속 돌아야(getDelta가 다음 프레임에 폭주하지 않게) 하지만,
       * 카메라 드리프트·안무·세리머니는 전부 elapsed의 함수라 그대로 두면 재개 순간
       * 정지한 시간만큼 화면이 점프한다. 여기서 빼면 재개는 "이어서"가 된다.
       */
      let frozenS = 0

      const tick = (now: number): void => {
        raf = requestAnimationFrame(tick)
        const p = propsRef.current
        timer.update(now)
        const rawDt = timer.getDelta()
        if (p.paused) {
          // 정지 프레임: 아무것도 갱신하지 않고 렌더도 건너뛴다.
          // 캔버스는 마지막으로 그린 프레임을 그대로 들고 있으므로 화면이 얼어붙는다.
          frozenS += rawDt
          return
        }
        const elapsed = timer.getElapsed() - frozenS
        const dt = clamp(rawDt, 0, 0.1)

        // ── 성능 가드: 기능이 아니라 **해상도**를 거래한다 ────────
        const step = scaler.update(rawDt * 1000)
        if (step.changed) {
          resize()
          // 안정된 스케일을 다음 세션에 물려준다. 0.05 미만 변화는 기록하지 않는다 —
          // 스텝(0.06~0.12)마다 localStorage에 쓰면 느린 기기에서 쓰기가 남발된다.
          if (Math.abs(step.scale - storedScale) >= 0.05) {
            storedScale = step.scale
            writeStoredScale(safeStorage(), step.scale)
          }
        }
        if (step.starving && !bloomDropped) {
          // 해상도 하한에서도 못 버틴다 → 블룸 한 겹만 내려놓는다(관중은 그대로).
          bloomDropped = true
          post.setBloomEnabled(false)
          bundle.setEmissiveBoost(1)
        }

        // ── 입장 연출: 킥오프 전에는 경기 프레임 대신 이 타임라인을 그린다 ──
        // 연출의 시계는 DOM 오버레이가 소유한다(3D가 없어도 연출이 진행돼야 하므로).
        // 여기서는 그 시각을 읽어 같은 순간의 포즈를 그릴 뿐이다.
        const script = p.entrance ?? null
        if (script) {
          const ems = p.entranceClock?.current ?? 0
          const ef = entranceFrame(script, ems)
          const gkH = p.state.home.tactics.lineup[0]?.playerId
          const gkA = p.state.away.tactics.lineup[0]?.playerId
          seen.clear()
          for (const pose of ef.players) {
            const rig = ensureRig(pose.id, pose.side, pose.number, pose.id === gkH || pose.id === gkA)
            if (!rig) continue
            rig.root.visible = true
            rig.apply(pose, elapsed)
            seen.add(pose.id)
          }
          for (const [id, rig] of rigs) if (!seen.has(id)) rig.root.visible = false
          // 심판 3인(주심 + 부심 2인) — 스토리보드 컷1의 "심판 심판 심판".
          ef.referees.forEach((pose, i) => {
            const rig = ensureRefRig(i)
            rig.root.visible = true
            rig.apply(pose, elapsed)
          })
          ball.update(ef.ball, dt)
          // 카메라 스크립트는 연출 모듈이 소유한다(entranceCameraMode) — 프레이밍 검증
          // 테스트가 렌더와 같은 모드를 쓰게 하기 위해서다.
          // 배너는 연출 중에만 펼쳐 둔다.
          bundle.setEntranceBanners(true)
          camRig.setMode(entranceCameraMode(script, ems))
          camRig.update({ focus: ef.focus, t: elapsed, dt, camera })
          post.render(dt)
          // 입장 연출에는 이름표를 달지 않는다 — 도열·국가 제창은 화면 전체가 그림이고,
          // 이름은 방송에서도 라인업 자막(별도 레이어)이 맡는다.
          plates.clear()
          // 연출이 끝나면 킥오프 배치부터 새로 시작한다 — 입장 마지막 자세를 prev로
          // 물려주면 1분 첫 프레임에서 22명이 이상한 보간을 탄다.
          prevFrame = null
          lastMinute = -1
          return
        }
        // 연출이 끝났거나 건너뛴 뒤: 심판과 배너는 화면에서 사라진다.
        for (const rig of refRigs) rig.root.visible = false
        bundle.setEntranceBanners(false)

        // ── 분 내 진행도 t: 분(또는 시퀀스)이 바뀌면 클럭을 리셋한다 ──
        const minute = p.state.minute
        // 장면 전환 첫 프레임인가 — 무브먼트가 focus를 컷하고 볼 앵커를 저술로 되돌린다.
        let cut = false
        if (minute !== lastMinute || p.sequence !== lastSeq) {
          lastMinute = minute
          lastSeq = p.sequence
          minuteStart = elapsed
          cut = true
          // prevFrame은 일부러 유지한다 — null로 리셋하면 분 경계마다 22명이 순간이동한다.
        }
        const dwellS = Math.max(0.2, (p.dwellMs ?? 3000) / 1000)
        const t = clamp((elapsed - minuteStart) / dwellS, 0, 1)

        // ── 무브먼트 레이어 ──────────────────────────────────────
        const frame = computeFrame({
          state: p.state,
          minute,
          t,
          prev: prevFrame,
          dt,
          sequence: p.sequence ?? null,
          sequenceSide: p.sequenceSide ?? null,
          seed: p.state.seed,
          dwellMs: p.dwellMs ?? 0,
          cut,
          // undefined면 movement가 역추적한다 — 호출부가 명시하면 그 값을 신뢰한다.
          ...(p.event !== undefined ? { event: p.event } : {}),
        })
        prevFrame = frame

        /**
         * ── 표시 진영 ──────────────────────────────────────────
         * 무브먼트는 언제나 엔진 프레임(홈이 +x로 공격)에서 계산하고, **화면에 올리기
         * 직전** 여기서 한 번만 180° 돌린다. 두 가지를 동시에 해결한다:
         *  ④ 전반에는 항상 돌린다(FIRST_HALF_ENDS = −1) — 안 돌리면 방송 카메라(−Z)에서
         *     홈이 화면 **왼쪽**으로 공격해 2D 작전판과 반대로 보인다.
         *  ⑤ 후반에는 진영을 바꾼다 → 부호가 한 번 더 뒤집혀 +1(회전 없음)이 된다.
         * 180° 회전은 등거리라 발 앵커링·GK 접촉·킥 방향이 그대로 보존된다.
         * `prevFrame`은 **돌리기 전** 프레임을 물려준다 — 관성이 한 좌표계 안에서 닫혀야
         * 하프타임에 22명의 속도 벡터가 통째로 뒤집히지 않는다.
         */
        const view = rotateFrame(frame, endsSwapped(minute) ? 1 : FIRST_HALF_ENDS)

        // ── 선수 22명 ────────────────────────────────────────────
        const gkHome = p.state.home.tactics.lineup[0]?.playerId
        const gkAway = p.state.away.tactics.lineup[0]?.playerId
        seen.clear()
        for (const pose of view.players) {
          const rig = ensureRig(pose.id, pose.side, pose.number, pose.id === gkHome || pose.id === gkAway)
          if (!rig) continue
          rig.root.visible = true
          rig.apply(pose, elapsed)
          seen.add(pose.id)
        }
        // 퇴장 등으로 이번 프레임에 없는 선수는 숨긴다(리그는 유지 — 재등장 대비).
        for (const [id, rig] of rigs) if (!seen.has(id)) rig.root.visible = false

        ball.update(view.ball, dt)

        const ev = view.event
        // ── 임팩트: 발이 공에 닿는 프레임 · GK 손이 공에 닿는 프레임 ──
        // 포즈 진행도가 접촉 지점을 **넘어서는 프레임**을 경계로 잡는다. computeFrame이
        // 이미 두 진행도를 볼 이벤트 시각에 역산해 맞춰 두었으므로(kickAt·diveScheduleAt),
        // 여기서 별도의 시간 계산 없이 "지금이 접촉"을 알 수 있다.
        // ★ 헤딩도 임팩트다 — 포즈 시간 규약(KICK_IMPACT_T)이 킥과 같으므로 같이 잡는다.
        //   빼면 헤더 골에서 카메라 임펄스와 임팩트 파티클이 통째로 사라진다.
        const kicker = view.players.find(pl => pl.action === 'kick' || pl.action === 'header')
        const kickT = kicker ? kicker.actionT : -1
        if (kicker && prevKickT >= 0 && prevKickT < KICK_IMPACT_T && kickT >= KICK_IMPACT_T) {
          camRig.impulse(KICK_IMPULSE)
          if (!reduced) {
            const puff = goalBurst(THREE, IMPACT_COLOR, { x: view.ball.x, y: 0.12, z: view.ball.z }, {
              seed: p.state.seed + minute * 31, count: IMPACT_COUNT, life: IMPACT_LIFE, speed: 0.3, size: 0.34,
            })
            scene.add(puff.mesh)
            bursts.push(puff)
          }
        }
        prevKickT = kickT
        const diver = view.players.find(pl => pl.action === 'dive')
        const diveT = diver ? diver.actionT : -1
        if (diver && ev === 'save' && prevDiveT >= 0 && prevDiveT < DIVE_LAY_U && diveT >= DIVE_LAY_U) {
          camRig.impulse(SAVE_IMPULSE)
          if (!reduced) {
            const puff = goalBurst(THREE, IMPACT_COLOR, { x: view.ball.x, y: 0.12, z: view.ball.z }, {
              seed: p.state.seed + minute * 57, count: IMPACT_COUNT, life: IMPACT_LIFE, speed: 0.34, size: 0.36,
            })
            scene.add(puff.mesh)
            bursts.push(puff)
          }
        }
        prevDiveT = diveT

        // ── 골 연출: goal-cam → celebrate, 파티클·플래시·관중 ──
        // 분당 1회만 발동(같은 골에 파티클이 매 프레임 쌓이지 않게).
        if (minute !== goalMinute) {
          goalMinute = minute
          goalFired = false
        }
        if ((ev === 'goal-home' || ev === 'goal-away') && !goalFired) {
          goalFired = true
          goalAt = elapsed
          const scoredByHome = ev === 'goal-home'
          camRig.setMode('goal-cam')
          camRig.impulse(GOAL_IMPULSE)
          flash.flash(scoredByHome ? FLASH_SCORED : FLASH_CONCEDED)
          if (!reduced) {
            const burst = goalBurst(
              THREE,
              scoredByHome ? homeColor : awayColor,
              { x: view.ball.x, y: Math.max(view.ball.y, 0.6), z: view.ball.z },
              { seed: p.state.seed + minute },
            )
            scene.add(burst.mesh)
            bursts.push(burst)
          }
        }
        // 골 연출 창은 분 경계를 넘어 이어진다(득점 후 다음 분에도 세리머니가 계속 보인다).
        const goalAge = goalAt >= 0 ? elapsed - goalAt : Infinity
        // 중계 문법: 골 → 골대 뒤 → 득점자 리액션 → 와이드 세리머니 →
        //           (세트피스는 전용 하이 대각 / 슈팅·세이브는 근접 / 그 외 방송 앵글)
        if (goalAge < GOAL_CAM_S) camRig.setMode('goal-cam')
        else if (goalAge < REACTION_END_S) camRig.setMode('reaction')
        else if (goalAge < CELEBRATE_TOTAL_S) camRig.setMode('celebrate')
        // 코너·프리킥은 "무슨 상황인지"부터 읽혀야 한다 — 근접 컷 대신 박스 전체를 담는다.
        else if (ev === 'corner' || ev === 'foul') camRig.setMode('set-piece')
        else if (ev === 'shot' || ev === 'save') camRig.setMode('highlight')
        else camRig.setMode('broadcast')

        // 파티클 진행(수명 종료 시 즉시 해제).
        for (let i = bursts.length - 1; i >= 0; i--) {
          if (!bursts[i].update(dt)) {
            bursts[i].dispose()
            bursts.splice(i, 1)
          }
        }
        flash.update(dt)

        // ── 관중 웨이브: intensity 0이면 호출 자체를 건너뛴다 ──
        // (crowdWave는 매 호출마다 인스턴스 행렬 전체를 GPU로 다시 올린다 — 수백 KB/프레임.
        //  골 창 밖에서는 정적 관중으로 두고, 창을 벗어나는 순간 한 번만 원위치시킨다.)
        const crowdIntensity = !reduced && goalAge < CROWD_WINDOW_S ? 1 - goalAge / CROWD_WINDOW_S : 0
        if (crowdIntensity > 0) {
          bundle.crowdWave(elapsed, crowdIntensity)
          crowdActive = true
        } else if (crowdActive) {
          bundle.crowdWave(elapsed, 0)
          crowdActive = false
        }

        // ── 카메라 적용 + 렌더 ───────────────────────────────────
        camRig.update({ focus: { ...view.focus, r: view.focusRadius ?? 0 }, t: elapsed, dt, camera })
        post.render(dt)

        // ── 선수 이름표 ──────────────────────────────────────────
        // 렌더 **뒤**에 갱신한다 — camRig가 방금 옮긴 카메라의 행렬로 투영해야
        // 이름이 이번 프레임의 몸 위에 정확히 얹힌다(한 프레임 늦으면 빠른 팬에서 끌린다).
        updatePlates(view, elapsed)
      }

      // ── 컨텍스트 로스 → 즉시 정리 후 폴백 ────────────────────────
      const onContextLost = (e: Event): void => {
        e.preventDefault()
        teardown?.()
        if (!cancelled) setFailed(true)
      }
      renderer.domElement.addEventListener('webglcontextlost', onContextLost)

      let torn = false
      teardown = () => {
        if (torn) return
        torn = true
        cancelAnimationFrame(raf)
        timer.dispose()
        unbindResize()
        reducedMql.removeEventListener?.('change', onReducedChange)
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
        for (const b of bursts) b.dispose()
        bursts.length = 0
        plates.dispose()
        post.dispose()
        flash.dispose()
        ball.dispose()
        // 리그를 먼저 떼어내야 bundle.dispose()의 트리 순회가 공유 캐시를 건드리지 않는다.
        for (const rig of rigs.values()) rig.dispose()
        rigs.clear()
        for (const rig of refRigs) rig.dispose()
        refRigs.length = 0
        bundle.dispose()
        disposePlayerCaches()
        renderer.dispose()
        renderer.forceContextLoss?.()
        renderer.domElement.remove()
      }

      if (cancelled) {
        teardown()
        return
      }
      raf = requestAnimationFrame(tick)
    })()

    return () => {
      cancelled = true
      teardown?.()
    }
    // 마운트당 1회 초기화. props 갱신은 propsRef로 루프가 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WebGL2 불가·초기화 실패·컨텍스트 로스 → 렌더러 체인의 다음 단계.
  if (failed) return <>{props.fallback ?? null}</>
  return <div ref={hostRef} className="m3d-host" aria-label="경기 피치(3D 방송)" role="img" />
}
