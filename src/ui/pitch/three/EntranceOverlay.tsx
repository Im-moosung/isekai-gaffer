// src/ui/pitch/three/EntranceOverlay.tsx
// 입장 연출 DOM 오버레이 — 자막 · 선수 소개 카드 · 라인업 시트 · 건너뛰기.
//
// 설계 원칙:
//  - **three 무의존**: 이 파일은 엔트리 번들에 정적으로 실린다. three가 새면 3D 코드
//    스플릿이 깨지므로 타입조차 import하지 않는다(entrance.ts와 같은 규칙).
//  - **자체 클럭이 정본**: 3D를 못 쓰는 폴백(PixiPitch/SVG)에서도 연출이 그대로 돌아야
//    하므로 시간은 오버레이가 소유한다. rAF 콜백이 주는 now의 첫 값을 t0로 잡고
//    (Date.now 금지·performance.now 불필요), 매 프레임 onProgress로 경과 ms를 알린다 —
//    3D 씬은 이 값을 받아 같은 클럭으로 entranceFrame을 그린다.
//  - **리렌더 최소화**: 60fps로 setState하지 않는다. 자막 단계나 소개 카드가 바뀌는
//    순간(총 15회 남짓)에만 리렌더하고, 카드의 등장·퇴장은 CSS 애니메이션이 맡는다.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  ENTRANCE_TOTAL_MS,
  entrancePhaseAt,
  entranceSubtitle,
  introCardAt,
  positionLabelKo,
  type EntranceCast,
} from './entrance'
import './entrance.css'

export interface EntranceOverlayProps {
  cast: EntranceCast
  /** 연출이 끝났을 때(자연 종료·건너뛰기 모두) **정확히 한 번** 호출된다. */
  onDone: () => void
  /** 사용자가 건너뛰었을 때만 추가로 호출된다(onDone보다 먼저). */
  onSkip?: () => void
  /** 매 프레임 경과 ms. 3D 씬이 같은 클럭을 공유하는 통로다. */
  onProgress?: (ms: number) => void
  /** 시작 오프셋(ms). 기본 0 — 데모·테스트에서 특정 단계부터 보고 싶을 때만 쓴다. */
  startMs?: number
}

/** 자막·카드가 바뀌는 순간만 리렌더하기 위한 키. */
function viewKey(cast: EntranceCast, ms: number): string {
  return `${entrancePhaseAt(ms)}:${introCardAt(cast, ms)?.index ?? -1}`
}

export function EntranceOverlay({ cast, onDone, onSkip, onProgress, startMs = 0 }: EntranceOverlayProps): ReactElement {
  const [ms, setMs] = useState(startMs)

  // 콜백은 ref로 들고 있는다 — 부모가 인라인 함수를 넘겨도 클럭이 재시작되지 않는다.
  const doneRef = useRef(onDone)
  const skipRef = useRef(onSkip)
  const progressRef = useRef(onProgress)
  doneRef.current = onDone
  skipRef.current = onSkip
  progressRef.current = onProgress

  const rafRef = useRef(0)
  const finishedRef = useRef(false)

  /** 종료는 단 한 번. rAF도 여기서 확실히 끊는다(언마운트 후 콜백 0). */
  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    if (rafRef.current && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    doneRef.current()
  }, [])

  const skip = useCallback(() => {
    if (finishedRef.current) return
    skipRef.current?.()
    finish()
  }, [finish])

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return
    // ★ 이펙트가 다시 돌면 클럭도 다시 산다. 정리(cleanup)가 finishedRef를 세워 두는데
    //   이걸 되돌리지 않으면 **두 번째 실행의 loop가 첫 줄에서 즉시 리턴해 연출이
    //   영구 정지**한다. React StrictMode(dev)는 마운트 직후 이펙트를 정리→재실행하므로
    //   개발 모드에서 항상 "심판진 입장"에 멈추고 건너뛰기도 먹지 않았다.
    //   (prod 빌드는 재실행이 없어 증상이 안 보였다 — 그래서 오래 살아남았다.)
    finishedRef.current = false
    let t0: number | null = null
    let key = viewKey(cast, startMs)
    const loop = (now: number) => {
      if (finishedRef.current) return
      if (t0 === null) t0 = now
      const elapsed = now - t0 + startMs
      progressRef.current?.(elapsed)
      const next = viewKey(cast, elapsed)
      if (next !== key) {
        key = next
        setMs(elapsed)
      }
      if (elapsed >= ENTRANCE_TOTAL_MS) {
        finish()
        return
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => {
      // 언마운트 = 더 이상 프레임을 돌리지 않는다. finishedRef로 이미 예약된
      // 콜백까지 무력화한다(취소가 늦어도 본문이 즉시 리턴한다).
      finishedRef.current = true
      if (rafRef.current && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }
  }, [cast, startMs, finish])

  // Esc를 포함한 아무 키로도 건너뛴다 — 연출은 절대 사용자를 붙잡아두지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return
      skip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [skip])

  const phase = entrancePhaseAt(ms)
  const card = introCardAt(cast, ms)
  const subtitle = entranceSubtitle(cast, ms)
  const showSheet = phase === 'lineup' || phase === 'intro' || phase === 'disperse'

  return (
    <div className="ent" data-phase={phase} data-testid="entrance-overlay">
      <div className="ent__bar">
        <span className="ent__accent" aria-hidden="true" />
        <span className="ent__subtitle" role="status">{subtitle}</span>
        <span className="ent__formation">{cast.homeFormation}</span>
      </div>

      {card && (
        // key = 순번 → 카드가 바뀔 때마다 마운트되어 CSS 등장 애니메이션이 다시 재생된다.
        <div className="ent__card" key={card.index} data-testid="entrance-card">
          <span className="ent__card-num">{card.player.number}</span>
          <span className="ent__card-body">
            <span className="ent__card-name">{card.player.nameKo}</span>
            <span className="ent__card-pos">{positionLabelKo(card.player.position)}</span>
          </span>
          <span className="ent__card-count">
            {card.index + 1} / {card.total}
          </span>
        </div>
      )}

      {showSheet && (
        <ul className="ent__sheet" aria-label={`${cast.homeTeamKo} 선발 라인업`}>
          {cast.home.map((m, i) => (
            <li
              key={m.id}
              className={'ent__chip' + (card && card.index === i ? ' ent__chip--on' : '')}
            >
              <span className="ent__chip-num">{m.number}</span>
              <span className="ent__chip-name">{m.nameKo}</span>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="ent__skip"
        aria-label="입장 연출 건너뛰고 바로 킥오프"
        onClick={skip}
      >
        건너뛰기
      </button>
    </div>
  )
}
