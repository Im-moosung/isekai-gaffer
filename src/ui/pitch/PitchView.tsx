import { useState, useEffect, useMemo, useRef } from 'react'
import type { MatchState, MatchEvent, SideState } from '../../engine/types'
import { backlineIndices, blockMetrics, liveTeamCoords, separateDots, tacticalCoords, type LiveInput } from './shape'
import type { Coord } from './formations'
import type { ChoreoStep } from './choreography'
import { AnalysisLayer, analysisLabels, TAG_FS, type AnalysisGeom } from './AnalysisLayer'
import { DOT_BLOCK_R, layoutLabels, textWidth, type Box, type LabelReq, type PlacedLabel } from './labels'
import { PITCH_W, PITCH_H, CENTER_CIRCLE_R, PENALTY_BOX_D, GOAL_AREA_D } from './geometry'
import './pitch.css'

// 피치 실측 비율(m) — viewBox 0 0 105 68. 치수 정본은 ./geometry(3개 렌더러 공용).
const W = PITCH_W
const H = PITCH_H
// slotCoords의 0~100 좌표를 viewBox 좌표로 스케일.
const sx = (x: number) => (x / 100) * W
const sy = (y: number) => (y / 100) * H

/** 이름 라벨 폰트(viewBox 단위) — pitch.css의 `.pv-root .pv-name`과 **같은 값**이어야
 *  배치 패스가 잰 박스와 실제 글자 폭이 맞는다. */
const NAME_FS = 2.5
/** 라이브 무브먼트 틱 — rAF 3프레임마다 1회(≈20Hz). CSS 보간을 쓰지 않으므로(pitch.css 참조)
 *  이 값이 곧 프레임레이트다. 시간은 프레임 수로만 센다(Date 계열 금지, 결정론). */
const FRAMES_PER_TICK = 3
const TICK_S = FRAMES_PER_TICK / 60
/** 공 위치 평활 계수(틱당). 0.045 @20Hz ≈ 시상수 1.1초 — 블록이 스텝 경계에서 튀지 않고 미끄러진다. */
const BALL_SMOOTH = 0.045
/** 평활된 공이 한 틱에 움직일 수 있는 최대 거리(0~100 프레임).
 *  왜 필요한가: 지수 평활만으로는 **처음 몇 틱**이 가장 빠르다. 분이 바뀌어 공이 반대편으로
 *  건너뛰면 블록이 0.2초에 4유닛(≈21m/s) 미끄러져 글리치로 읽혔다(실측). 0.5/틱 @20Hz면
 *  블록 슬라이드가 최대 초속 2.2유닛(≈1.6m/s) — 실제 팀이 옆으로 미는 속도다. */
const MAX_BALL_STEP = 0.5
/** 점유 전환도 계단이 아니라 경사로 — 2.5초에 걸쳐 뒤집힌다(2/(2.5*20)). */
const POSSESS_STEP = 2 / (2.5 * 20)
/** 공이 없을 때 블록이 되돌아갈 중립점. */
const CENTER = { x: 50, y: 50 }

interface LiveTarget { ball: Coord | null; possess: number }
interface LiveState { t: number; ball: Coord | null; possess: number }

interface PitchViewProps {
  state: MatchState
  lastEvent?: MatchEvent
  /** 'broadcast'(기본, 그린 피치) | 'tactics'(다크 전술판 — 색은 tactics.css가 pv-root--tactics로 덮음). */
  variant?: 'broadcast' | 'tactics'
  /** 홈 도트에 선수 이름 라벨 표시(작전판 — "이 선수가 어디 포지션인지" 가시화). */
  nameLabels?: boolean
  /** 홈 도트 중 발광 링으로 강조할 선수 id(선택·교체 아웃 대상). */
  highlightId?: string | null
  /** 교체 미리보기 고스트 도트 — 홈 슬롯 인덱스에 반투명 도트+번호 표시. */
  ghost?: { slotIndex: number; number?: number } | null
  /** 홈 도트 클릭 콜백(작전판 보드 상호작용). */
  onDotClick?: (playerId: string) => void
  /** 하이라이트 안무 시퀀스(choreography.buildSequence). 있으면 공·무버 도트를
   *  이 키프레임대로 재생하고 lastEvent 마커 대신 노출한다(broadcast). */
  sequence?: ChoreoStep[]
  /** 시퀀스 재생 총 시간(ms) — 해당 분 dwell. 스텝 간 transition 길이 산출에 쓴다. */
  dwellMs?: number
  /** 시퀀스를 재생하는 공격 팀(공·무버 색). 미지정 시 'home'. */
  sequenceSide?: 'home' | 'away'
  /** 일시정지 — 안무 스텝 전진과 라이브 무브먼트 클럭을 멈춘다. */
  paused?: boolean
  /** 전술 시각화 레이어(수비 라인·압박 존·패스 레인) + 라이브 무브먼트 — 2D 작전판 전용. */
  analysis?: boolean
  /** 블록 지표(길이·폭 m) 콜백 — 작전판 칩이 실시간 수치를 띄운다. */
  onMetrics?: (m: { lengthM: number; widthM: number }) => void
}

/** 가독성 분리 오프셋이 한 틱에 변할 수 있는 최대치(0~100 프레임). 20Hz에서 7유닛/초(≈6m/s). */
const SEP_RATE = 0.35
/** raw 좌표가 이보다 크게 바뀌면(슬라이더·포메이션·교체) 보간하지 않고 즉시 맞춘다. */
const SEP_SNAP = 2.0

/**
 * 도트 가독성 분리 + **시간 평활**.
 *
 * 왜 평활이 필요한가: `separateDots`는 매 프레임 독립적으로 푸는 순수 함수라, 두 선수가
 * 서로를 스쳐 지나가면 밀어내는 방향이 뒤집히며 한 프레임에 1.8유닛(≈1.8m)까지 튄다
 * (실측). 오프셋 자체는 최대 1.8유닛으로 작으니 **오프셋에만** 속도 제한을 걸면
 * 전술 위치(raw)의 반응성은 그대로 두고 튐만 없앨 수 있다.
 */
function useSmoothSeparation(raw: Coord[], t: number, on: boolean): Coord[] {
  const ref = useRef<{ t: number; off: Coord[]; raw: Coord[] } | null>(null)
  if (!on) {
    ref.current = null
    return raw
  }
  const target = separateDots(raw)
  const aim = target.map((c, i) => ({ x: c.x - raw[i].x, y: c.y - raw[i].y }))
  const prev = ref.current
  let off = aim
  if (prev && prev.off.length === raw.length) {
    let jump = 0
    for (let i = 0; i < raw.length; i++) {
      jump = Math.max(jump, Math.hypot(raw[i].x - prev.raw[i].x, raw[i].y - prev.raw[i].y))
    }
    if (jump <= SEP_SNAP) {
      // 같은 틱의 재렌더에서는 값을 고정한다(렌더 횟수에 결과가 의존하면 안 된다).
      off = prev.t === t ? prev.off : aim.map((c, i) => {
        const dx = c.x - prev.off[i].x
        const dy = c.y - prev.off[i].y
        const d = Math.hypot(dx, dy)
        const k = d > SEP_RATE ? SEP_RATE / d : 1
        return { x: prev.off[i].x + dx * k, y: prev.off[i].y + dy * k }
      })
    }
  }
  ref.current = { t, off, raw: raw.map(c => ({ x: c.x, y: c.y })) }
  return raw.map((c, i) => ({ x: c.x + off[i].x, y: c.y + off[i].y }))
}

/** 안무 스텝 인덱스 — 이전에 ChoreoLayer 안에 있었지만, 공 위치가 **도트 배치(블록 이동)**
 *  에도 필요해져 PitchView로 끌어올렸다. */
function useChoreoStep(sequence: ChoreoStep[] | undefined, dwellMs: number, paused = false): number {
  const [target, setTarget] = useState(0)
  /** 지금 재생 중인 스텝. 정지 후 재개할 때 **여기서부터** 다시 예약한다. */
  const curRef = useRef(0)
  /** 직전 시퀀스 참조. 시퀀스 교체(=분 전환)와 정지 재개를 구분하는 유일한 근거다 —
   *  둘을 구분하지 못하면 재개할 때마다 안무가 처음으로 되감긴다. */
  const seqRef = useRef<ChoreoStep[] | undefined>(undefined)
  useEffect(() => {
    if (seqRef.current !== sequence) {
      seqRef.current = sequence
      curRef.current = 0
      setTarget(0)
    }
    if (!sequence || paused) return
    const cur = curRef.current
    const base = cur > 0 ? sequence[cur - 1].t : 0
    const timers: ReturnType<typeof setTimeout>[] = []
    // 남은 스텝만 이어서 예약한다. 정지 중 흐른 시간은 세지 않으므로 재개하면
    // 현재 스텝의 잔여 시간이 처음부터 다시 흐른다 — SVG 폴백에서 허용하는 근사다
    // (3D·Pixi는 진행도 기준점을 밀어 정확히 이어 붙인다).
    for (let k = cur + 1; k < sequence.length; k++) {
      timers.push(setTimeout(() => { curRef.current = k; setTarget(k) }, (sequence[k - 1].t - base) * dwellMs))
    }
    return () => timers.forEach(clearTimeout)
  }, [sequence, dwellMs, paused])
  return target
}

/**
 * 라이브 무브먼트 클럭. 결정론: Math.random·Date를 쓰지 않고 **틱 카운터만** 센다
 * (같은 틱이면 언제나 같은 좌표). prefers-reduced-motion이면 아예 돌리지 않는다.
 *
 * 공 위치는 안무 스텝 경계에서 계단식으로 바뀌므로 지수 평활을 걸어 넘긴다 —
 * 블록 전체가 한 프레임에 4m 순간이동하면 시각화가 아니라 글리치로 읽힌다.
 */
function useLiveClock(on: boolean, ball: Coord | null, possess: number, paused = false): LiveState {
  const targetRef = useRef<LiveTarget>({ ball, possess })
  targetRef.current = { ball, possess }
  const [live, setLive] = useState<LiveState>({ t: 0, ball, possess })
  const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    // ★ 정지에서는 루프만 멈추고 **반환값은 그대로 live**를 쓴다(아래 return 참조).
    //   on을 내려 버리면 평활 이전의 raw 좌표로 되돌아가 블록이 한 프레임에 튄다.
    if (!on || paused || reduced || typeof requestAnimationFrame !== 'function') return
    // ★ setInterval이 아니라 rAF다. 이 컴포넌트는 경기 내내 마운트되어 있어서 타이머를
    //   물고 있으면 재생 체인의 "다음 타이머"를 매번 가로챈다(MatchScreen 재생 루프가
    //   advanceTimersToNextTimer로 1분씩 넘어간다). rAF는 그 큐에 끼지 않는다.
    let frame = 0
    let id = 0
    const loop = () => {
      id = requestAnimationFrame(loop)
      if (++frame % FRAMES_PER_TICK) return
      setLive(p => {
        const tgt = targetRef.current
        // ★ 목표가 사라져도 null로 되돌리지 않는다 — 시퀀스가 끊길 때마다 블록이
        //   순간이동한다. 대신 피치 중앙(중립)으로 **천천히** 되돌아간다.
        const aim = tgt.ball ?? CENTER
        const from = p.ball ?? aim
        let dx = (aim.x - from.x) * BALL_SMOOTH
        let dy = (aim.y - from.y) * BALL_SMOOTH
        const d = Math.hypot(dx, dy)
        if (d > MAX_BALL_STEP) { dx *= MAX_BALL_STEP / d; dy *= MAX_BALL_STEP / d }
        const dp = Math.max(-POSSESS_STEP, Math.min(POSSESS_STEP, tgt.possess - p.possess))
        return { t: p.t + TICK_S, ball: { x: from.x + dx, y: from.y + dy }, possess: p.possess + dp }
      })
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [on, paused, reduced])
  // 정지 모드(reduced/off)에서는 목표값을 그대로 쓴다 — 움직이지 않되 위치는 맞는다.
  // 일시정지는 여기 해당하지 않는다 — 마지막으로 평활된 위치에서 얼어붙어야 한다.
  return on && !reduced ? live : { t: 0, ball, possess }
}

/** SVG 105×68 피치 뷰.
 *  외곽선·센터서클·페널티박스 + 양팀 lineup 11 도트(등번호) + lastEvent 마커.
 *  엔진 호출 없이 전달받은 state만 그린다(컴포넌트는 엔진 타입 import만).
 *  variant='tactics'면 다크 보드 클래스(pv-root--tactics)를 붙여 작전판 톤으로 렌더한다.
 *
 *  ★ analysis=true(2D 작전판)에서는 선수가 **미세하게 계속 움직인다**(shape.liveTeamCoords):
 *    선수별 ±1m 재정렬 + 공·점유에 따른 블록 슬라이드. 공만 왔다갔다 하던 화면을 고친다. */
export function PitchView({ state, lastEvent, variant = 'broadcast', nameLabels = false, highlightId, ghost, onDotClick, sequence, dwellMs, sequenceSide = 'home', analysis = false, paused = false, onMetrics }: PitchViewProps) {
  const playing = !!sequence && sequence.length > 0
  const stepIdx = Math.min(useChoreoStep(sequence, dwellMs ?? 3000, paused), (sequence?.length ?? 1) - 1)
  const stepBall = playing ? sequence![stepIdx].ball : null
  const clock = useLiveClock(analysis, stepBall, playing ? (sequenceSide === 'home' ? 1 : -1) : 0, paused)

  const live: LiveInput | undefined = analysis
    ? { t: clock.t, ball: clock.ball ?? undefined, possess: clock.possess }
    : undefined
  const rawHome = teamCoords(state.home, 'home', live)
  const rawAway = teamCoords(state.away, 'away', live)
  // ★ 작전판에서만 가독성 분리를 건다 — 도트가 완전히 포개져 한 명이 사라지는 것만 막는다.
  //   방송 2D·전술판은 3D와 좌표가 같아야 하므로 손대지 않는다.
  const sep = useSmoothSeparation(useMemo(() => [...rawHome, ...rawAway], [rawHome, rawAway]), clock.t, analysis)
  const homeC = analysis ? sep.slice(0, rawHome.length) : rawHome
  const awayC = analysis ? sep.slice(rawHome.length) : rawAway

  // 수비 라인 마커는 **도트 배열의 백라인 평균**에서 뽑는다 — 마커-도트 일치 계약(shape.ts).
  const geom: AnalysisGeom = {
    homeLineX: meanBackline(state.home, homeC),
    awayLineX: meanBackline(state.away, awayC),
  }

  const metrics = blockMetrics(homeC)
  const mRef = useRef(onMetrics)
  mRef.current = onMetrics
  useEffect(() => {
    mRef.current?.({ lengthM: Math.round(metrics.lengthM), widthM: Math.round(metrics.widthM) })
  }, [metrics.lengthM, metrics.widthM])

  // ── 텍스트 배치 패스(labels.ts) — 피치 위 모든 글자가 여기서 자리를 받는다.
  const stickyRef = useRef(new Map<string, number>())
  const reqs: LabelReq[] = []
  if (analysis) reqs.push(...analysisLabels(state, geom))
  if (nameLabels) {
    const nameById = new Map(state.home.team.squad.map(p => [p.id, p.name.ko]))
    state.home.tactics.lineup.forEach((slot, i) => {
      const name = nameById.get(slot.playerId)
      if (!name || !homeC[i]) return
      const cx = sx(homeC[i].x)
      const cy = sy(homeC[i].y)
      reqs.push({
        id: `nm-${slot.playerId}`,
        text: name,
        ax: cx,
        ay: cy,
        fontSize: NAME_FS,
        slots: nameSlots(name),
        rank: 1,
      })
    })
  }
  // 도트·배지는 텍스트가 아니지만 글자에 덮이면 안 된다 → 고정 장애물로 넘긴다.
  const blockers: Box[] = []
  for (const c of [...homeC, ...awayC]) {
    blockers.push({ x: sx(c.x) - DOT_BLOCK_R, y: sy(c.y) - DOT_BLOCK_R, w: DOT_BLOCK_R * 2, h: DOT_BLOCK_R * 2 })
  }
  const layout = layoutLabels(reqs, { x: 0.6, y: 0.6, w: W - 1.2, h: H - 1.2 }, blockers, stickyRef.current)
  useEffect(() => {
    const m = stickyRef.current
    m.clear()
    for (const p of layout.placed) m.set(p.id, p.slot)
  })
  const placedById = new Map(layout.placed.map(p => [p.id, p]))

  // ★ 공·무버는 안무 좌표(전술 위치 기준)로 오는데 도트는 라이브로 움직인다 → 그대로 두면
  //   공이 아무도 없는 잔디 위에 뜬다(flow.ts가 애써 없앤 바로 그 문제). 점유 팀의
  //   **블록 평행이동분**을 공·무버에 그대로 얹어 발밑을 유지한다.
  const ballOffset = analysis && playing ? blockOffset(state, sequenceSide, sequenceSide === 'home' ? homeC : awayC) : ZERO
  const carrier = analysis && playing
    ? nearestDot(
        { x: sequence![stepIdx].ball.x + ballOffset.x, y: sequence![stepIdx].ball.y + ballOffset.y },
        sequenceSide === 'home' ? homeC : awayC,
      )
    : null

  return (
    <svg
      className={`pv-root${variant === 'tactics' ? ' pv-root--tactics' : ''}${analysis ? ' pv-root--analysis' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="경기 피치 포메이션"
      preserveAspectRatio="xMidYMid meet"
    >
      <PitchMarkings />
      {/* 전술 레이어는 마킹 위·도트 아래 — 선수를 가리지 않는다. */}
      {analysis && <AnalysisLayer state={state} geom={geom} />}
      {/* z순서 — 작전판에서는 상대를 먼저 깔고 우리 팀을 위에 올린다(보드의 주어는 우리다). */}
      {analysis && <SideDots side={state.away} which="away" coords={awayC} />}
      <SideDots side={state.home} which="home" coords={homeC} highlightId={highlightId} onDotClick={onDotClick} />
      {!analysis && <SideDots side={state.away} which="away" coords={awayC} />}
      {ghost && <GhostDot side={state.home} slotIndex={ghost.slotIndex} number={ghost.number} />}
      {/* 시퀀스 재생 중엔 안무(공·무버) 우선, 아니면 정적 lastEvent 마커. */}
      {playing
        ? <ChoreoLayer sequence={sequence!} dwellMs={dwellMs ?? 3000} idx={stepIdx} side={sequenceSide}
            offset={ballOffset} carrier={carrier} movers={!analysis} />
        : lastEvent && <EventMarker event={lastEvent} state={state} />}
      {/* 라벨 레이어는 최상단 — 배치 패스가 서로 겹치지 않음을 보장한다. */}
      <g className="pv-labels" aria-hidden="true">
        {[...placedById.values()].map(p => <LabelText key={p.id} p={p} />)}
      </g>
    </svg>
  )
}

/**
 * 이름 라벨의 후보 자리 — 아래 → 위 → 대각 4방 → 좌우 → 멀리 아래/위.
 * 가로 오프셋은 **그 이름의 실제 폭**에서 계산한다(3글자와 7글자가 같은 자리를 쓸 수 없다).
 * 후보가 많을수록 혼잡한 포메이션(5-4-1 로우블록)에서 지워지는 이름이 줄어든다.
 */
function nameSlots(name: string): { dx: number; dy: number }[] {
  const half = (textWidth(name, NAME_FS) + 1) / 2
  const side = DOT_BLOCK_R + half + 0.3
  return [
    { dx: 0, dy: 5.2 }, { dx: 0, dy: -5.2 },
    { dx: side * 0.7, dy: 4.4 }, { dx: -side * 0.7, dy: 4.4 },
    { dx: side * 0.7, dy: -4.4 }, { dx: -side * 0.7, dy: -4.4 },
    { dx: side, dy: 0 }, { dx: -side, dy: 0 },
    { dx: 0, dy: 8.3 }, { dx: 0, dy: -8.3 },
  ]
}

/** 배치된 라벨 하나 — 라인 태그는 플레이트(불투명 판)를, 이름은 후광(paint-order)을 쓴다. */
function LabelText({ p }: { p: PlacedLabel }) {
  const tag = p.id.startsWith('an-tag-')
  const cls = tag ? `an-line__tag an-line__tag--${p.id.endsWith('home') ? 'home' : 'away'}` : 'pv-name'
  return (
    <g>
      {tag && <rect className="an-tag__plate" x={p.box.x} y={p.box.y} width={p.box.w} height={p.box.h} rx={0.8} />}
      <text className={cls} x={p.x} y={p.y} style={tag ? { fontSize: `${TAG_FS}px` } : undefined}>{p.text}</text>
    </g>
  )
}

/** 팀 좌표 11개. analysis면 라이브 무브먼트, 아니면 기존 정적 전술 좌표(3D·방송과 동일). */
function teamCoords(side: SideState, which: 'home' | 'away', live: LiveInput | undefined): Coord[] {
  const { formation, lineup, instructions } = side.tactics
  if (live) return liveTeamCoords(formation, which, instructions, live)
  return lineup.map((_, i) => tacticalCoords(formation, i, which, instructions))
}

/** 백라인 평균 x — 수비 라인 마커의 정본. **실제 도트 좌표**에서 뽑으므로
 *  마커와 도트가 어긋날 수 없다(shape.ts의 마커-도트 일치 계약). */
function meanBackline(side: SideState, coords: Coord[]): number {
  const idx = backlineIndices(side.tactics.formation)
  return idx.reduce((s, i) => s + coords[i].x, 0) / idx.length
}

const ZERO = { x: 0, y: 0 }

/** 라이브 좌표가 전술 좌표에서 통째로 얼마나 밀려났나(팀 평균) — 공·무버를 같이 옮기는 값. */
function blockOffset(state: MatchState, which: 'home' | 'away', coords: Coord[]): Coord {
  const side = which === 'home' ? state.home : state.away
  const { formation, instructions } = side.tactics
  let dx = 0
  let dy = 0
  for (let i = 0; i < coords.length; i++) {
    const base = tacticalCoords(formation, i, which, instructions)
    dx += coords[i].x - base.x
    dy += coords[i].y - base.y
  }
  return coords.length ? { x: dx / coords.length, y: dy / coords.length } : ZERO
}

/** 공에 가장 가까운 도트 인덱스 — "지금 누가 갖고 있나"를 링으로 말한다. */
function nearestDot(ball: Coord, coords: Coord[]): Coord | null {
  let best: Coord | null = null
  let bd = Infinity
  for (const c of coords) {
    const d = (c.x - ball.x) ** 2 + (c.y - ball.y) ** 2
    if (d < bd) { bd = d; best = c }
  }
  // 12 유닛(≈12m)보다 멀면 아무도 안 가진 것으로 본다(전환 중인 공).
  return bd <= 144 ? best : null
}

/** 안무 재생 레이어 — 공(원+그림자)과 무버 도트를 키프레임대로 CSS transition 재생.
 *  스텝 k로 넘어가는 전환은 이전 스텝 시각(t[k-1]*dwell)에 시작해 (t[k]-t[k-1])*dwell 동안
 *  진행되어 t[k]*dwell에 도착한다(데드타임 없이 마지막 결과가 dwell 80% 내 완료).
 *  transition 길이는 --pv-dur(ms) 커스텀 프로퍼티로 전달 → reduced-motion 시 CSS가 무효화. */
function ChoreoLayer({ sequence, dwellMs, idx, side, carrier, offset, movers }: {
  sequence: ChoreoStep[]; dwellMs: number; idx: number; side: 'home' | 'away'
  carrier: Coord | null; offset: Coord
  /** 무버 고스트 도트를 그릴까. 작전판에서는 끈다 — 실제 도트가 이미 그 자리에 있어서
   *  번호 없는 반투명 원이 하나 더 뜨면 버그로 읽힌다(감사 A-6). */
  movers: boolean
}) {
  const cur = sequence[idx]
  const durMs = idx > 0 ? Math.max(0, (sequence[idx].t - sequence[idx - 1].t) * dwellMs) : 0
  const durStyle = { '--pv-dur': `${Math.round(durMs)}ms` } as React.CSSProperties
  const bx = sx(cur.ball.x + offset.x)
  const by = sy(cur.ball.y + offset.y)
  return (
    <g className="pv-choreo" aria-hidden="true">
      {/* 볼 터치 링 — 공이 지금 향하는 선수. 공이 추상적으로 떠다니는 게 아니라
          **사람 발밑으로** 간다는 걸 형태로 말한다(패스 중에는 받는 선수를 미리 가리킨다). */}
      {carrier && <circle className="pv-carrier" cx={sx(carrier.x)} cy={sy(carrier.y)} r={3.6} style={durStyle} />}
      {movers && cur.movers.map(m => (
        <circle key={m.playerId} className={`pv-mover pv-mover--${side}`} cx={sx(m.x + offset.x)} cy={sy(m.y + offset.y)} r={2.2} style={durStyle} />
      ))}
      <ellipse className="pv-ball__shadow" cx={bx} cy={by + 1.2} rx={1.7} ry={0.7} style={durStyle} />
      <circle className="pv-ball" cx={bx} cy={by} r={1.5} style={durStyle} />
    </g>
  )
}

/** 교체 고스트 도트 — 아웃 선수 슬롯 위치에 반투명 도트+투입 선수 번호. */
function GhostDot({ side, slotIndex, number }: { side: SideState; slotIndex: number; number?: number }) {
  const c = tacticalCoords(side.tactics.formation, slotIndex, 'home', side.tactics.instructions)
  const cx = sx(c.x)
  const cy = sy(c.y)
  return (
    <g className="pv-ghost" aria-label="교체 미리보기">
      <circle className="pv-ghost__dot" cx={cx} cy={cy} r={2.4} />
      {number != null && <text className="pv-num pv-ghost__num" x={cx} y={cy}>{number}</text>}
    </g>
  )
}

function PitchMarkings() {
  const cy = H / 2
  // 페널티박스: 깊이 PENALTY_BOX_D / 골박스: 깊이 GOAL_AREA_D (geometry.ts 정본).
  // 폭만 리터럴로 남긴다 — 3D는 규칙값 40.32/18.32를 쓰는데 2D는 예전부터 40.3/18.3이다.
  // 서브픽셀 차이지만 리팩터링 커밋에서 렌더 결과를 바꾸지 않기로 해 통일하지 않았다
  // (geometry.PENALTY_BOX_W 주석 참조).
  const penH = 40.3
  const penTop = (H - penH) / 2
  const goalH = 18.3
  const goalTop = (H - goalH) / 2
  return (
    <g>
      <rect className="pv-stripe" x={0} y={0} width={W / 2} height={H} />
      {/* 외곽선 */}
      <rect className="pv-line" x={0.5} y={0.5} width={W - 1} height={H - 1} />
      {/* 하프라인 */}
      <line className="pv-line" x1={W / 2} y1={0.5} x2={W / 2} y2={H - 0.5} />
      {/* 센터서클 + 킥오프 점 */}
      <circle className="pv-line" cx={W / 2} cy={cy} r={CENTER_CIRCLE_R} />
      <circle cx={W / 2} cy={cy} r={0.5} fill="var(--bc-pitch-line)" />
      {/* 좌측(홈) 페널티/골 박스 */}
      <rect className="pv-line" x={0.5} y={penTop} width={PENALTY_BOX_D} height={penH} />
      <rect className="pv-line" x={0.5} y={goalTop} width={GOAL_AREA_D} height={goalH} />
      {/* 우측(어웨이) 페널티/골 박스 */}
      <rect className="pv-line" x={W - 0.5 - PENALTY_BOX_D} y={penTop} width={PENALTY_BOX_D} height={penH} />
      <rect className="pv-line" x={W - 0.5 - GOAL_AREA_D} y={goalTop} width={GOAL_AREA_D} height={goalH} />
    </g>
  )
}

function SideDots({ side, which, coords, highlightId, onDotClick }: {
  side: SideState; which: 'home' | 'away'; coords: Coord[]
  highlightId?: string | null; onDotClick?: (playerId: string) => void
}) {
  // ★ 도트 좌표는 포메이션 원형이 아니라 **전술 변환 + (작전판에선) 라이브 무브먼트**를
  //   거친 좌표다 — 라인을 내리면 수비진이 실제로 내려가고, 공이 왼쪽에 있으면 블록이 쏠린다.
  const numberById = new Map(side.team.squad.map(p => [p.id, p.number]))
  const nameById = new Map(side.team.squad.map(p => [p.id, p.name.ko]))
  return (
    <g>
      {side.tactics.lineup.map((slot, i) => {
        const c = coords[i]
        if (!c) return null
        const cx = sx(c.x)
        const cy = sy(c.y)
        const num = numberById.get(slot.playerId)
        const name = nameById.get(slot.playerId)
        const highlit = highlightId != null && slot.playerId === highlightId
        const clickable = which === 'home' && !!onDotClick
        const mood = moodBadge(side.moraleByPlayer[slot.playerId])
        return (
          <g
            key={`${which}-${i}`}
            className={`pv-dotg${clickable ? ' pv-dotg--click' : ''}`}
            onClick={clickable ? () => onDotClick!(slot.playerId) : undefined}
            role={clickable ? 'button' : undefined}
            aria-label={clickable && name ? `${name} 선택` : undefined}
          >
            {highlit && <circle className="pv-ring" cx={cx} cy={cy} r={3.6} />}
            <circle className={`pv-dot pv-dot--${which}${highlit ? ' pv-dot--hl' : ''}`} cx={cx} cy={cy} r={2.4} />
            {num != null && (
              <text className="pv-num" x={cx} y={cy}>{num}</text>
            )}
            {mood && (
              <text className="pv-mood" x={cx + 2.7} y={cy - 2.4} aria-hidden="true">{mood}</text>
            )}
          </g>
        )
      })}
    </g>
  )
}

/** 바디랭귀지 미니 배지 — 사기 75+ 자신감(🔥) / 35- 위축(😰). 결정론(사기값만 참조). */
function moodBadge(morale: number | undefined): string | null {
  if (morale == null) return null
  if (morale >= 75) return '🔥'
  if (morale <= 35) return '😰'
  return null
}

/** 이벤트 타입별 근사 존 좌표(0~100) — 득점/슈팅 팀의 공격 방향 기준. */
function eventZone(event: MatchEvent, state: MatchState): { x: number; y: number } {
  const isHome = event.teamId === state.home.team.id
  // 홈은 우측(x 큰 쪽) 공격, 어웨이는 좌측 공격.
  const attackX = isHome ? 88 : 12
  // 분(minute)으로 결정론적 y 분산(코너/파울 등 위치 다양화).
  const yJitter = 35 + ((event.minute * 7) % 30)
  switch (event.type) {
    case 'corner':
      return { x: attackX, y: event.minute % 2 === 0 ? 8 : 92 }
    case 'foul':
    case 'yellow':
    case 'red':
      return { x: 50 + (isHome ? 12 : -12), y: yJitter }
    default: // goal, shot, save, miss, chance ...
      return { x: attackX, y: yJitter }
  }
}

function EventMarker({ event, state }: { event: MatchEvent; state: MatchState }) {
  const z = eventZone(event, state)
  const cx = sx(z.x)
  const cy = sy(z.y)
  if (event.type === 'goal') {
    return (
      <g className="pv-marker pv-marker--goal" aria-label="득점 위치">
        <circle cx={cx} cy={cy} r={3} fill="none" />
        <circle className="pv-pulse" cx={cx} cy={cy} r={1.5} fill="none" />
      </g>
    )
  }
  if (event.type === 'foul' || event.type === 'yellow' || event.type === 'red') {
    // ▲ 삼각형
    const s = 2.6
    const d = `M ${cx} ${cy - s} L ${cx + s} ${cy + s} L ${cx - s} ${cy + s} Z`
    return <path className="pv-marker pv-marker--foul" d={d} aria-label="파울 위치" />
  }
  // miss / save / shot 등 → × 마커
  const s = 2.2
  return (
    <g className="pv-marker pv-marker--x" aria-label="슈팅 위치">
      <line x1={cx - s} y1={cy - s} x2={cx + s} y2={cy + s} />
      <line x1={cx - s} y1={cy + s} x2={cx + s} y2={cy - s} />
    </g>
  )
}
