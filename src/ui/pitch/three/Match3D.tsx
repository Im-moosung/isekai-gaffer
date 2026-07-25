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
import { FLASH_CONCEDED, FLASH_SCORED, createBall, flashQuad, goalBurst, type GoalBurst } from './fx3d'
import { computeFrame } from './movement'
import { createPlayer, disposePlayerCaches, type PlayerRig } from './player3d'
import { buildScene, type ThreeAPI } from './scene'
import type { FrameState } from './types'

interface Match3DProps {
  state: MatchState
  lastEvent?: MatchEvent
  /** 하이라이트 안무 시퀀스(있으면 공·무버·카메라·골FX 재생). */
  sequence?: ChoreoStep[]
  /** 시퀀스 재생 총 시간(ms) = 그 분의 dwell. 분 내 진행도 t를 여기서 만든다. */
  dwellMs?: number
  /** 시퀀스 재생(공격) 팀. */
  sequenceSide?: 'home' | 'away'
  /** 3D를 쓸 수 없을 때 대신 렌더할 노드(렌더러 체인의 다음 단계 = PixiPitch). */
  fallback?: ReactNode
}

const HOME_FALLBACK = 0xe63946
const AWAY_FALLBACK = 0x4895ef
/** 홈 양말·디테일(흰색) / 어웨이(네이비) — GK 킷도 이 액센트로 갈린다. */
const HOME_ACCENT = 0xf2f5ff
const AWAY_ACCENT = 0x0b1a33

/** 저사양 강등 기억(다음 마운트부터 낮은 텍스처·관중으로 시작). */
const LOW_KEY = 'rematch-3d-low'
/** 평상시 관중 목표 인원 / 강등 시. */
const CROWD_FULL = 4200
const CROWD_LOW = 1800
/** 피치 텍스처 해상도(px/m) — 강등 시 12. */
const PX_PER_M = 20
const PX_PER_M_LOW = 12

/** 골 순간 골대 뒤 로우 앵글을 유지하는 시간(s). 이후 세리머니 오빗으로 넘어간다. */
const GOAL_CAM_S = 0.9
/**
 * 골 연출(goal-cam + celebrate) 총 길이(s). **분 경계와 무관하게** 흐른다 —
 * 골 키프레임은 dwell의 끝자락(t≈0.7~0.85)이라 분에 묶어두면 세리머니가 1초 만에 잘린다.
 */
const CELEBRATE_TOTAL_S = 4.5
/** 골 뒤 관중이 뛰는 시간(s) — 이 창 밖에서는 crowdWave를 호출하지 않는다. */
const CROWD_WINDOW_S = 4
/** 카메라 셰이크 임펄스(m). */
const GOAL_IMPULSE = 0.35
/** 프레임 예산(s) — 이보다 느린 프레임이 연속 30회면 1회 강등. */
const SLOW_FRAME_S = 1 / 45
const SLOW_STREAK = 30
/** 초기 컴파일·업로드 구간은 측정에서 제외한다. */
const WARMUP_FRAMES = 90
/** 교체·퇴장으로 새 선수가 등장해도 리그 수는 여기서 멈춘다(무한 증식 방지). */
const MAX_RIGS = 40

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

/** WebGL2 사용 가능 여부(동기). jsdom은 getContext가 null → false → 폴백. */
function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!c.getContext('webgl2')
  } catch {
    return false
  }
}

/**
 * 직전 세션에서 강등됐는지 읽고 **즉시 지운다**(1회용).
 * 텍스처 해상도·관중 수는 buildScene 시점에만 정할 수 있어 다음 마운트로 기억을 넘기지만,
 * 영구 저장하면 일시적 끊김 한 번으로 화질이 영영 내려간다. 여전히 느리면 런타임 가드가
 * 다시 강등하며 다시 기록하므로, 회복 가능한 상태가 된다.
 */
function readLowPower(): boolean {
  try {
    const hit = localStorage.getItem(LOW_KEY) === '1'
    if (hit) localStorage.removeItem(LOW_KEY)
    return hit
  } catch {
    return false
  }
}

function writeLowPower(): void {
  try {
    localStorage.setItem(LOW_KEY, '1')
  } catch {
    /* ignore */
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

      // ── 렌더러(호출부 소유) ──────────────────────────────────────
      let renderer: import('three').WebGLRenderer
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
      } catch {
        if (!cancelled) setFailed(true)
        return
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      renderer.setPixelRatio(dpr)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05
      renderer.domElement.className = 'm3d-canvas'
      host.appendChild(renderer.domElement)

      const reducedMql = window.matchMedia('(prefers-reduced-motion: reduce)')
      let reduced = reducedMql.matches
      const lowPower = readLowPower()

      const homeColor = cssColor(host, '--bc-home', HOME_FALLBACK)
      const awayColor = cssColor(host, '--bc-away', AWAY_FALLBACK)

      // ── 씬 · 볼 · FX · 카메라 리그 ───────────────────────────────
      const bundle = buildScene(THREE, {
        homeColor,
        awayColor,
        crowdCount: lowPower ? CROWD_LOW : CROWD_FULL,
        pxPerMeter: lowPower ? PX_PER_M_LOW : PX_PER_M,
        maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
      })
      const scene = bundle.scene
      const camera = bundle.camera

      const ball = createBall(THREE, { reducedMotion: reduced })
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
      // 선발 22명은 첫 프레임 전에 만들어 둔다(루프 안에서 22개 생성 = 렌더 히치).
      for (const side of ['home', 'away'] as const) {
        const st = propsRef.current.state[side]
        const numById = new Map(st.team.squad.map(s => [s.id, s.number]))
        st.tactics.lineup.forEach((slot, i) => {
          ensureRig(slot.playerId, side, numById.get(slot.playerId) ?? 0, i === 0)
        })
      }

      // ── 리사이즈 ─────────────────────────────────────────────────
      const resize = (): void => {
        const w = host.clientWidth
        const h = host.clientHeight
        if (w < 2 || h < 2) return
        renderer.setSize(w, h, false)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      resize()
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null
      ro?.observe(host)
      if (!ro) window.addEventListener('resize', resize)

      const onReducedChange = (): void => {
        reduced = reducedMql.matches
        camRig.setReducedMotion(reduced)
      }
      reducedMql.addEventListener?.('change', onReducedChange)

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
      let slowStreak = 0
      let frameNo = 0
      // 직전 세션 강등을 물려받아도 가드는 계속 무장해 둔다 — 여전히 느리면 한 단계 더
      // 내리고(관중 절반·dpr 1) 다음 마운트에도 기억한다.
      let degraded = false
      let particlesOff = lowPower

      /** 저사양 자동 강등 — 1회, 조용히(로그 없음). 다음 마운트에도 기억한다. */
      const degrade = (): void => {
        degraded = true
        particlesOff = true
        writeLowPower()
        const crowd = bundle.crowd
        if (crowd) crowd.count = Math.floor(bundle.crowdCount / 2)
        for (const b of bursts) b.dispose()
        bursts.length = 0
        renderer.setPixelRatio(1)
        resize()
      }

      const tick = (now: number): void => {
        raf = requestAnimationFrame(tick)
        const p = propsRef.current
        timer.update(now)
        const rawDt = timer.getDelta()
        const elapsed = timer.getElapsed()
        const dt = clamp(rawDt, 0, 0.1)

        // 성능 가드: 워밍업 이후 연속 30프레임이 45fps 미만이면 1회 강등.
        frameNo++
        if (!degraded && frameNo > WARMUP_FRAMES) {
          if (rawDt > SLOW_FRAME_S) {
            slowStreak++
            if (slowStreak >= SLOW_STREAK) degrade()
          } else {
            slowStreak = 0
          }
        }

        // ── 분 내 진행도 t: 분(또는 시퀀스)이 바뀌면 클럭을 리셋한다 ──
        const minute = p.state.minute
        if (minute !== lastMinute || p.sequence !== lastSeq) {
          lastMinute = minute
          lastSeq = p.sequence
          minuteStart = elapsed
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
        })
        prevFrame = frame

        // ── 선수 22명 ────────────────────────────────────────────
        const gkHome = p.state.home.tactics.lineup[0]?.playerId
        const gkAway = p.state.away.tactics.lineup[0]?.playerId
        seen.clear()
        for (const pose of frame.players) {
          const rig = ensureRig(pose.id, pose.side, pose.number, pose.id === gkHome || pose.id === gkAway)
          if (!rig) continue
          rig.root.visible = true
          rig.apply(pose, elapsed)
          seen.add(pose.id)
        }
        // 퇴장 등으로 이번 프레임에 없는 선수는 숨긴다(리그는 유지 — 재등장 대비).
        for (const [id, rig] of rigs) if (!seen.has(id)) rig.root.visible = false

        ball.update(frame.ball, dt)

        // ── 골 연출: goal-cam → celebrate, 파티클·플래시·관중 ──
        const ev = frame.event
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
          if (!particlesOff && !reduced) {
            const burst = goalBurst(
              THREE,
              scoredByHome ? homeColor : awayColor,
              { x: frame.ball.x, y: Math.max(frame.ball.y, 0.6), z: frame.ball.z },
              { seed: p.state.seed + minute },
            )
            scene.add(burst.mesh)
            bursts.push(burst)
          }
        }
        // 골 연출 창은 분 경계를 넘어 이어진다(득점 후 다음 분에도 세리머니가 계속 보인다).
        const goalAge = goalAt >= 0 ? elapsed - goalAt : Infinity
        if (goalAge < GOAL_CAM_S) camRig.setMode('goal-cam')
        else if (goalAge < CELEBRATE_TOTAL_S) camRig.setMode('celebrate')
        else if (ev === 'shot' || ev === 'save' || ev === 'corner') camRig.setMode('highlight')
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
        camRig.update({ focus: frame.focus, t: elapsed, dt, camera })
        renderer.render(scene, camera)
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
        ro?.disconnect()
        if (!ro) window.removeEventListener('resize', resize)
        reducedMql.removeEventListener?.('change', onReducedChange)
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
        for (const b of bursts) b.dispose()
        bursts.length = 0
        flash.dispose()
        ball.dispose()
        // 리그를 먼저 떼어내야 bundle.dispose()의 트리 순회가 공유 캐시를 건드리지 않는다.
        for (const rig of rigs.values()) rig.dispose()
        rigs.clear()
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
