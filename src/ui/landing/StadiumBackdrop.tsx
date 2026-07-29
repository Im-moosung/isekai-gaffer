// src/ui/landing/StadiumBackdrop.tsx
// 랜딩 첫인상용 3D 스타디움 라이브 배경 — 실제 경기 화면과 **같은 씬 자산**(scene.buildScene)을
// 재사용해 "3D가 진짜다"를 첫 화면에서 증명한다. 선수·공·FX는 없다(빈 경기장 + 관중 + 조명).
//
// 설계 원칙(Match3D와 동일 계약):
//  - three는 **동적 import만**. 이 모듈 자체도 App에서 lazy로 부른다 → 문안·버튼이 먼저 뜬다.
//  - WebGL2 불가 · 렌더러 생성 실패 · 청크 로드 실패 · 컨텍스트 로스 → **조용히 사라진다**
//    (아무것도 렌더하지 않음). 랜딩 CSS 그라디언트가 그대로 배경으로 남는다.
//  - Math.random·Date 금지. 카메라 궤적은 `./camera`의 순수 함수(상수 + 삼각함수),
//    시간은 three Timer. 구도의 근거와 조명탑 회피 계산은 camera.ts 헤더에 있다.
//  - prefers-reduced-motion → rAF 루프 없이 **1프레임만** 그린다(정지 화면).
//  - 포스트 프로세싱(블룸·비네트·그레인)을 **경기 화면과 같은 스택**으로 얹는다. 첫인상
//    화면이라 값이 가장 크고, 조명탑이 halo를 얻는 순간 "절차 생성 티"가 크게 줄어든다.
//    실패하면 createPostFX가 passthrough를 주므로 배경은 그대로 뜬다(강등 없음).
//  - 언마운트 시 bundle.dispose()(disposeTree가 InstancedMesh 분기까지 처리) + renderer.dispose()
//    + forceContextLoss로 GPU 컨텍스트를 즉시 반납한다.
import { useEffect, useRef, useState } from 'react'
import { createPostFX } from '../pitch/three/postfx'
import { EMISSIVE_BOOST, buildScene, type ThreeAPI } from '../pitch/three/scene'
import { FOV, LOOK_AT_Y, landingCameraAt } from './camera'

/** 랜딩 배경은 경기 화면보다 가벼워야 한다(첫 로드 체감) — 관중 절반, 피치 텍스처 저해상도. */
const CROWD_COUNT = 2000
const PX_PER_M = 10

/** 픽셀비 상한 — 배경일 뿐이므로 2까지 올릴 이유가 없다. */
const MAX_DPR = 1.5

/** WebGL2 사용 가능 여부(동기). jsdom은 getContext가 null → false → 배경 없음. */
function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    // 탐지용 컨텍스트도 브라우저 컨텍스트 상한(≈16)을 잡아먹는다 — 즉시 반납한다.
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return !!gl
  } catch {
    return false
  }
}

/**
 * 랜딩 3D 배경. 준비되면 CSS 트랜지션으로 페이드인한다.
 * 실패하면 null을 렌더한다 — 호출부(랜딩)는 아무 처리도 하지 않아도 정적 배경으로 남는다.
 */
export function StadiumBackdrop() {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
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

      let renderer: import('three').WebGLRenderer
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'default' })
      } catch {
        if (!cancelled) setFailed(true)
        return
      }
      const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DPR)
      renderer.setPixelRatio(pixelRatio)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      // 경기 화면과 같은 톤매퍼를 써야 랜딩→경기 전환에서 색이 튀지 않는다(근거는 scene.ts 헤더).
      renderer.toneMapping = THREE.NeutralToneMapping
      renderer.toneMappingExposure = 1.15
      renderer.domElement.className = 'landing-bg__canvas'
      host.appendChild(renderer.domElement)

      // matchMedia가 없는 환경(테스트 jsdom 등)에서는 모션을 켠 것으로 본다.
      const reduced =
        typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

      const bundle = buildScene(THREE, { crowdCount: CROWD_COUNT, pxPerMeter: PX_PER_M })
      const scene = bundle.scene
      const camera = bundle.camera
      camera.fov = FOV
      camera.updateProjectionMatrix()

      const place = (t: number): void => {
        const p = landingCameraAt(t)
        camera.position.set(p.x, p.y, p.z)
        camera.lookAt(0, LOOK_AT_Y, 0)
      }

      const post = await createPostFX(THREE, renderer, scene, camera, { reducedMotion: reduced })
      if (post.active) bundle.setEmissiveBoost(EMISSIVE_BOOST)

      const resize = (): void => {
        const w = host.clientWidth
        const h = host.clientHeight
        if (w < 2 || h < 2) return
        post.setSize(w, h, pixelRatio)
        camera.aspect = w / h
        camera.updateProjectionMatrix()
      }
      resize()
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null
      ro?.observe(host)
      if (!ro) window.addEventListener('resize', resize)

      const timer = new THREE.Timer()
      timer.connect(document)
      let raf = 0
      const tick = (now: number): void => {
        raf = requestAnimationFrame(tick)
        timer.update(now)
        place(timer.getElapsed())
        post.render(timer.getDelta())
      }

      // 컨텍스트 로스 → 즉시 정리하고 정적 배경으로 되돌린다(랜딩은 깨지지 않는다).
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
        renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
        post.dispose()
        bundle.dispose()
        renderer.dispose()
        renderer.forceContextLoss?.()
        renderer.domElement.remove()
      }

      if (cancelled) {
        teardown()
        return
      }

      if (reduced) {
        // 모션 최소화 — 카메라를 시작 위치에 세우고 1프레임만 그린다(rAF 없음).
        place(0)
        post.render(0)
      } else {
        raf = requestAnimationFrame(tick)
      }
      setReady(true)
    })()

    return () => {
      cancelled = true
      teardown?.()
    }
    // 마운트당 1회 초기화(랜딩은 props가 없다).
  }, [])

  if (failed) return null
  return <div ref={hostRef} className={`landing-bg__host${ready ? ' is-ready' : ''}`} aria-hidden="true" />
}
