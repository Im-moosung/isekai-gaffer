// src/ui/pitch/three/EntranceOverlay.tsx
// 입장 연출 DOM 오버레이 — 자막 · 중계 문장 · 포메이션 도해 + 선수 명단 · 건너뛰기.
//
// 사용자 스토리보드 4컷 중 **컷3·컷4가 이 파일이다.** 3D는 뒤에서 줄을 비춰 주는
// 배경이고, "포메이션 전술보드 + 선수 명단을 나란히 띄우고 선수 한 명씩 하이라이트"는
// 여기 DOM이 그린다(손그림에도 컷3은 통째로 두 패널이다).
//
// 설계 원칙:
//  - **three 무의존**: 이 파일은 엔트리 번들에 정적으로 실린다. three가 새면 3D 코드
//    스플릿이 깨지므로 타입조차 import하지 않는다(entrance.ts와 같은 규칙).
//  - **자체 클럭이 정본**: 3D를 못 쓰는 폴백(PixiPitch/SVG)에서도 연출이 그대로 돌아야
//    하므로 시간은 오버레이가 소유한다. rAF 콜백이 주는 now의 첫 값을 t0로 잡고
//    (Date.now 금지·performance.now 불필요), 매 프레임 onProgress로 경과 ms를 알린다 —
//    3D 씬은 이 값을 받아 같은 클럭으로 entranceFrame을 그린다.
//  - **리렌더 최소화**: 60fps로 setState하지 않는다. 자막 단계나 비트가 바뀌는
//    순간(총 30~40회)에만 리렌더하고, 나머지는 CSS 애니메이션이 맡는다.
//  - **발화는 부모가 한다**: onBeat를 비트당 정확히 한 번 부른다. 오버레이는 TTS를
//    모른다(테스트가 오디오 없이 돈다).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  entranceBeatIndexAt,
  entranceHighlightAt,
  entranceIntroSide,
  entrancePhaseAt,
  entranceSubtitle,
  positionLabelKo,
  type EntranceBeat,
  type EntranceCastMember,
  type EntranceScript,
} from './entrance'
import { tacticalCoords } from '../shape'
import type { FormationId, Instructions } from '../../../engine/types'
import './entrance.css'

export interface EntranceOverlayProps {
  script: EntranceScript
  /** 연출이 끝났을 때(자연 종료·건너뛰기 모두) **정확히 한 번** 호출된다. */
  onDone: () => void
  /** 사용자가 건너뛰었을 때만 추가로 호출된다(onDone보다 먼저). */
  onSkip?: () => void
  /** 매 프레임 경과 ms. 3D 씬이 같은 클럭을 공유하는 통로다. */
  onProgress?: (ms: number) => void
  /** 비트(중계 한 문장)가 시작될 때 **한 번**. 부모가 이걸 받아 발화한다. */
  onBeat?: (beat: EntranceBeat) => void
  /** short 모드에서 "선수 소개까지 보기"를 눌렀을 때. 없으면 버튼을 그리지 않는다. */
  onExpand?: () => void
  /** 시작 오프셋(ms). 기본 0 — 데모·테스트에서 특정 단계부터 보고 싶을 때만 쓴다. */
  startMs?: number
}

/** 자막·비트가 바뀌는 순간만 리렌더하기 위한 키. */
function viewKey(script: EntranceScript, ms: number): string {
  return `${entrancePhaseAt(script, ms)}:${entranceBeatIndexAt(script, ms)}`
}

/**
 * 포메이션 도해 한 장(11 도트). 전술이 반영된 좌표를 쓴다 — 작전판에서 라인을 올려
 * 두었으면 소개 도해에서도 수비진이 올라가 있어야 "내 팀"으로 읽힌다.
 *
 * 세로 피치로 그린다(공격 방향 위쪽). 가로 피치는 명단 패널과 나란히 놓으면 납작해져
 * 390 px에서 도트가 서로 붙는다 — 세로면 같은 폭에서 라인 간격이 두 배가 된다.
 */
function FormationMap({
  members, formation, instructions, activeId,
}: {
  members: readonly EntranceCastMember[]
  formation: FormationId
  instructions: Instructions
  activeId: string | null
}): ReactElement {
  // 좌표는 언제나 'home' 프레임으로 뽑는다 — 도해는 "그 팀의 모양"이지 화면 진영이 아니다.
  // (away를 넘기면 x가 미러되어 같은 4-2-3-1이 뒤집혀 보인다.)
  const dots = useMemo(
    () =>
      members.map(m => {
        const c = tacticalCoords(formation, m.slotIndex, 'home', instructions)
        // 0~100 가로 피치 → 세로 피치. 공격 방향(+x)이 위(y 작아짐)로 간다.
        return { id: m.id, number: m.number, cx: c.y, cy: 100 - c.x }
      }),
    [members, formation, instructions],
  )
  return (
    <svg className="ent__map" viewBox="0 0 100 100" role="img" aria-label="포메이션 도해">
      <rect className="ent__map-turf" x="0" y="0" width="100" height="100" rx="2" />
      <line className="ent__map-line" x1="0" y1="50" x2="100" y2="50" />
      <circle className="ent__map-line" cx="50" cy="50" r="9" fill="none" />
      <rect className="ent__map-line" x="28" y="0" width="44" height="16" fill="none" />
      {dots.map(d => (
        <g key={d.id} className={'ent__dot' + (d.id === activeId ? ' ent__dot--on' : '')}>
          <circle cx={d.cx} cy={d.cy} r="5.2" />
          <text x={d.cx} y={d.cy} dy="1.9" textAnchor="middle">{d.number}</text>
        </g>
      ))}
    </svg>
  )
}

export function EntranceOverlay({
  script, onDone, onSkip, onProgress, onBeat, onExpand, startMs = 0,
}: EntranceOverlayProps): ReactElement {
  const [ms, setMs] = useState(startMs)

  // 콜백은 ref로 들고 있는다 — 부모가 인라인 함수를 넘겨도 클럭이 재시작되지 않는다.
  const doneRef = useRef(onDone)
  const skipRef = useRef(onSkip)
  const progressRef = useRef(onProgress)
  const beatRef = useRef(onBeat)
  doneRef.current = onDone
  skipRef.current = onSkip
  progressRef.current = onProgress
  beatRef.current = onBeat

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
    let key = viewKey(script, startMs)
    // 비트는 **인덱스가 바뀌는 순간** 한 번만 알린다. 시작 오프셋 안에 이미 들어와 있는
    // 비트는 알리지 않는다(중간부터 재생할 때 지나간 문장을 몰아서 말하면 안 된다).
    let lastBeat = entranceBeatIndexAt(script, startMs)
    const loop = (now: number) => {
      if (finishedRef.current) return
      if (t0 === null) t0 = now
      const elapsed = now - t0 + startMs
      progressRef.current?.(elapsed)
      const bi = entranceBeatIndexAt(script, elapsed)
      if (bi !== lastBeat) {
        lastBeat = bi
        const beat = bi >= 0 ? script.beats[bi] : null
        if (beat) beatRef.current?.(beat)
      }
      const next = viewKey(script, elapsed)
      if (next !== key) {
        key = next
        setMs(elapsed)
      }
      if (elapsed >= script.totalMs) {
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
  }, [script, startMs, finish])

  // Esc를 포함한 아무 키로도 건너뛴다 — 연출은 절대 사용자를 붙잡아두지 않는다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return
      skip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [skip])

  const cast = script.cast
  const phase = entrancePhaseAt(script, ms)
  const subtitle = entranceSubtitle(script, ms)
  const side = entranceIntroSide(script, ms)
  const hi = entranceHighlightAt(script, ms)
  const beatIndex = entranceBeatIndexAt(script, ms)
  const beat = beatIndex >= 0 ? script.beats[beatIndex] : null

  const members = side === 'home' ? cast.home : cast.away
  const teamKo = side === 'home' ? cast.homeTeamKo : cast.awayTeamKo
  const formation = side === 'home' ? cast.homeFormation : cast.awayFormation
  const instructions = side === 'home' ? cast.homeInstructions : cast.awayInstructions

  return (
    <div className="ent" data-phase={phase} data-side={side ?? 'none'} data-testid="entrance-overlay">
      <div className="ent__bar">
        <span className="ent__subtitle" role="status">{subtitle}</span>
        <span className="ent__formation">{side ? formation : cast.homeFormation}</span>
      </div>

      {side && (
        // 컷3·컷4 — 왼쪽 도해, 오른쪽 명단. 손그림 그대로의 2단 구성이다.
        <section className="ent__close" key={side} aria-label={`${teamKo} 선발 라인업`}>
          <header className="ent__close-head">
            <span className={`ent__close-kit ent__close-kit--${side === 'home' ? 'us' : 'them'}`} aria-hidden="true" />
            <span className="ent__close-team">{teamKo}</span>
            <span className="ent__close-form">{formation}</span>
          </header>
          <div className="ent__close-body">
            <FormationMap
              members={members}
              formation={formation}
              instructions={instructions}
              activeId={hi?.player.id ?? null}
            />
            <ol className="ent__roster">
              {members.map(m => (
                <li
                  key={m.id}
                  className={'ent__row' + (hi?.player.id === m.id ? ' ent__row--on' : '')}
                  aria-current={hi?.player.id === m.id ? 'true' : undefined}
                >
                  <span className="ent__row-num">{m.number}</span>
                  <span className="ent__row-name">{m.nameKo}</span>
                  <span className="ent__row-pos">{positionLabelKo(m.position)}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

      {beat && (
        // 중계 자막 — 입장부터 캐스터·해설위원의 말이 글로도 보인다(TTS가 없어도 읽힌다).
        <p
          className={`ent__line ent__line--${beat.speaker}`}
          key={beatIndex}
          data-testid="entrance-line"
          role="status"
        >
          <span className="ent__line-who">{beat.speaker === 'analyst' ? '해설' : '캐스터'}</span>
          <span className="ent__line-text">{beat.text}</span>
        </p>
      )}

      <div className="ent__actions">
        {onExpand && (
          <button type="button" className="ent__more" onClick={onExpand}>
            선수 소개 보기
          </button>
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
    </div>
  )
}
