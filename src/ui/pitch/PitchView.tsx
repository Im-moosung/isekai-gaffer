import { useState, useEffect, useMemo, useRef } from 'react'
import type { MatchState, MatchEvent, SideState } from '../../engine/types'
import { backlineIndices, blockMetrics, liveTeamCoords, separateDots, tacticalCoords, type LiveInput } from './shape'
import type { Coord } from './formations'
import type { ChoreoStep } from './choreography'
import { onPitchMask, sequenceOwner } from './cast'
import { AnalysisLayer, analysisLabels, TAG_FS, type AnalysisGeom, type AnalysisHighlight } from './AnalysisLayer'
import { DOT_BLOCK_R, layoutLabels, textWidth, type Box, type LabelReq, type PlacedLabel } from './labels'
import { PITCH_W, PITCH_H, CENTER_CIRCLE_R, PENALTY_BOX_D, GOAL_AREA_D } from './geometry'
import { displayCoord, endsSwapped } from './ends'
import { moodBadge } from './mood'
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
/** 클럭이 실제로 돌고 있나 — reduced-motion·비활성이면 false(그때는 보간 없이 목표로 스냅한다). */
interface LiveClock extends LiveState { running: boolean }

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
  /** 방금 바뀐 전술 축 강조(작전판이 정착 후 한 번만 올린다). analysis일 때만 의미가 있다. */
  analysisHighlight?: AnalysisHighlight
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
function useSmoothSeparation(raw: Coord[], t: number, on: boolean, active: readonly boolean[]): Coord[] {
  const ref = useRef<{ t: number; off: Coord[]; raw: Coord[] } | null>(null)
  if (!on) {
    ref.current = null
    return raw
  }
  const target = separateDots(raw, active)
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
function useLiveClock(on: boolean, ball: Coord | null, possess: number, paused = false): LiveClock {
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
  return on && !reduced ? { ...live, running: true } : { t: 0, ball, possess, running: false }
}

/** 패스·주행의 시간축(부드럽게 출발·도착). 선수 도트와 공이 **같은 곡선**을 써야
 *  패스가 발밑에서 떠나 발밑에 닿는다 — 서로 다른 easing을 주면 공이 도트를 앞질러 간다. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
/** 마지막 구간(슛)은 직선 가속 — 골문으로 꽂히는 느낌. PixiPitch의 easeFor('shot')과 같은 식. */
const easeShot = (t: number) => t * t

/** SVG 105×68 피치 뷰.
 *  외곽선·센터서클·페널티박스 + 양팀 lineup 11 도트(등번호) + lastEvent 마커.
 *  엔진 호출 없이 전달받은 state만 그린다(컴포넌트는 엔진 타입 import만).
 *  variant='tactics'면 다크 보드 클래스(pv-root--tactics)를 붙여 작전판 톤으로 렌더한다.
 *
 *  ★ analysis=true(2D 작전판)에서는 선수가 **미세하게 계속 움직인다**(shape.liveTeamCoords):
 *    선수별 ±1m 재정렬 + 공·점유에 따른 블록 슬라이드. 공만 왔다갔다 하던 화면을 고친다. */
export function PitchView({ state, lastEvent, variant = 'broadcast', nameLabels = false, highlightId, ghost, onDotClick, sequence, dwellMs, sequenceSide: sideProp = 'home', analysis = false, analysisHighlight, paused = false, onMetrics }: PitchViewProps) {
  const playing = !!sequence && sequence.length > 0
  // ★ prop을 그대로 믿지 않는다 — `save`는 막은 팀의 사건이라 호출자가 반대로 준다(cast.ts).
  const sequenceSide = sequenceOwner(state, sequence, sideProp)
  const dwell = dwellMs ?? 3000
  const stepIdx = Math.min(useChoreoStep(sequence, dwell, paused), (sequence?.length ?? 1) - 1)
  const stepBall = playing ? sequence![stepIdx].ball : null
  // ★ 클럭은 작전판뿐 아니라 **하이라이트 재생 중에도** 돈다. 예전에는 CSS transition이
  //   안무를 재생했는데, 그러면 "지금 이 프레임의 선수 좌표"를 JS가 알 수 없어서 진짜
  //   도트를 옮길 수 없었다(그래서 고스트 무버 원을 따로 그렸다 — 감사 ⑤).
  const clock = useLiveClock(analysis || playing, stepBall, playing ? (sequenceSide === 'home' ? 1 : -1) : 0, paused)

  // ── 안무 구간 진행도 ─────────────────────────────────────────────
  // 스텝 k는 t[k-1]*dwell에 시작해 t[k]*dwell에 도착한다(useChoreoStep과 같은 규약).
  const segT0 = playing && stepIdx > 0 ? sequence![stepIdx - 1].t : 0
  const segDurS = playing ? ((sequence![stepIdx].t - segT0) * dwell) / 1000 : 0
  const segRef = useRef<{ idx: number; seq: ChoreoStep[] | undefined; t0: number }>({ idx: -1, seq: undefined, t0: 0 })
  if (segRef.current.idx !== stepIdx || segRef.current.seq !== sequence) {
    segRef.current = { idx: stepIdx, seq: sequence, t0: clock.t }
  }
  // 클럭이 멈춰 있으면(reduced-motion·비재생) 보간하지 않고 목표 스텝으로 스냅한다.
  const segP = !playing || !clock.running || segDurS <= 0
    ? 1
    : Math.max(0, Math.min(1, (clock.t - segRef.current.t0) / segDurS))
  // 마지막 구간만 슛(직선 가속). 나머지는 선수와 같은 곡선을 써서 공이 발밑을 떠나지 않는다.
  const shotSeg = playing && sequence!.length > 1 && stepIdx === sequence!.length - 1
  const runEase = easeInOutCubic(segP)
  const ballEase = shotSeg ? easeShot(segP) : runEase

  const live: LiveInput | undefined = analysis
    ? { t: clock.t, ball: clock.ball ?? undefined, possess: clock.possess }
    : undefined
  const rawHome = teamCoords(state.home, 'home', live)
  const rawAway = teamCoords(state.away, 'away', live)

  // ★ 공·무버는 안무 좌표(전술 위치 기준)로 오는데 작전판 도트는 라이브로 움직인다 →
  //   그대로 두면 공이 아무도 없는 잔디 위에 뜬다(flow.ts가 애써 없앤 바로 그 문제).
  //   점유 팀의 **블록 평행이동분**을 공·무버에 그대로 얹어 발밑을 유지한다.
  //   ★ 무버 반영 **전의** 좌표에서 재야 한다 — 안 그러면 자기 자신을 되먹인다.
  const ballOffset = analysis && playing
    ? blockOffset(state, sequenceSide, sequenceSide === 'home' ? rawHome : rawAway)
    : ZERO

  // ── ⑤ 진짜 도트를 움직인다 ──────────────────────────────────────
  // 안무가 지정한 이번 프레임의 선수 좌표를 **그 선수의 도트 좌표로** 덮어쓴다.
  // 예전에는 번호 없는 반투명 원(.pv-mover)을 따로 그렸고 진짜 도트는 포메이션 자리에
  // 가만히 있었다 — 사용자가 "3개의 동그란 그림자"라고 부른 것이 그것이다.
  const moverPos = playing ? interpMovers(sequence!, stepIdx, runEase, ballOffset) : EMPTY_POS
  const moved = playing ? applyMovers(sequenceSide === 'home' ? state.home : state.away, moverPos) : null
  const ovHome = moved && sequenceSide === 'home' ? overlay(rawHome, moved) : rawHome
  const ovAway = moved && sequenceSide === 'away' ? overlay(rawAway, moved) : rawAway

  // ★ 가독성 분리 — 도트가 완전히 포개져 한 명이 사라지는 것만 막는다(팀 내·팀 간 모두).
  //   작전판은 20 Hz로 계속 움직이므로 오프셋에 속도 제한을 걸고(useSmoothSeparation),
  //   그 밖(전술판·하이라이트)은 순수 함수 그대로 쓴다 — 좌표가 스텝 단위로만 바뀐다.
  // ── 퇴장 반영 ────────────────────────────────────────────────────
  // 엔진은 이미 10명으로 돌지만(choreography·flow가 sentOff를 거른다) 이 보드만 라인업을
  // 그대로 그려 **퇴장 선수 도트가 남아 있었다**(사용자 실플레이 제보). 인덱스는 좌표·무버의
  // 공통 키라 배열에서 빼지 않고 마스크로 끈다 — 도트·이름표·분리·지표가 전부 이 마스크를 본다.
  const homeOn = useMemo(() => onPitchMask(state.home), [state.home])
  const awayOn = useMemo(() => onPitchMask(state.away), [state.away])
  const merged = useMemo(() => [...ovHome, ...ovAway], [ovHome, ovAway])
  const activeMask = useMemo(() => [...homeOn, ...awayOn], [homeOn, awayOn])
  const smoothed = useSmoothSeparation(merged, clock.t, analysis, activeMask)
  const sep = analysis ? smoothed : separateDots(merged, activeMask)
  const homeC = sep.slice(0, ovHome.length)
  const awayC = sep.slice(ovHome.length)

  // 수비 라인 마커는 **도트 배열의 백라인 평균**에서 뽑는다 — 마커-도트 일치 계약(shape.ts).
  const geom: AnalysisGeom = {
    homeLineX: meanBackline(state.home, homeC, homeOn),
    awayLineX: meanBackline(state.away, awayC, awayOn),
    homeGravity: teamGravity(state.home, 'home', homeOn),
  }

  /**
   * ── 표시 진영(ends.ts) ────────────────────────────────────────
   * 후반이면 피치를 180° 돌려 그린다 — 실제 축구가 하프타임에 진영을 바꾸기 때문이고,
   * 3D도 같은 규칙으로 돌아간다(three/types.rotateFrame). 계산은 전부 엔진 프레임에서
   * 끝내고 **그리기 직전에만** 좌표를 돌린다: 라인 마커·블록 지표·전술 레이어가 전부
   * 같은 엔진 좌표에서 파생돼야 "마커와 도트가 같은 숫자"라는 계약이 유지된다.
   */
  const swapped = endsSwapped(state.minute)
  const rot = (c: Coord): Coord => displayCoord(c, swapped)
  const homeD = swapped ? homeC.map(rot) : homeC
  const awayD = swapped ? awayC.map(rot) : awayC
  // 라벨은 화면 좌표에 붙으므로 돌린 값이 필요하다(전술 레이어 자체는 아래에서 그룹째 돌린다).
  const geomD: AnalysisGeom = swapped
    ? {
      homeLineX: 100 - geom.homeLineX,
      awayLineX: 100 - geom.awayLineX,
      homeGravity: rot(geom.homeGravity),
    }
    : geom

  // 블록 길이·폭도 **화면에 있는 도트**에서만 잰다(퇴장 선수를 세면 지표가 거짓말을 한다).
  const metrics = blockMetrics(homeC, homeOn)
  const mRef = useRef(onMetrics)
  mRef.current = onMetrics
  useEffect(() => {
    mRef.current?.({ lengthM: Math.round(metrics.lengthM), widthM: Math.round(metrics.widthM) })
  }, [metrics.lengthM, metrics.widthM])

  // ── 텍스트 배치 패스(labels.ts) — 피치 위 모든 글자가 여기서 자리를 받는다.
  const stickyRef = useRef(new Map<string, number>())
  const reqs: LabelReq[] = []
  if (analysis) reqs.push(...analysisLabels(state, geomD))
  if (nameLabels) {
    const nameById = new Map(state.home.team.squad.map(p => [p.id, p.name.ko]))
    state.home.tactics.lineup.forEach((slot, i) => {
      const name = nameById.get(slot.playerId)
      // 퇴장 선수는 도트가 없다 → 이름표도 없다(도트 없는 이름이 잔디에 떠 있으면 안 된다).
      if (!name || !homeD[i] || !homeOn[i]) return
      const cx = sx(homeD[i].x)
      const cy = sy(homeD[i].y)
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
  // ── ④ 하이라이트 이름표 — **장면에 관여한 선수만**.
  // 왜 전원이 아닌가: 22명에 이름을 붙이면 40~52px 화면에서 글자가 피치를 덮는다(라벨 폭
  // 합계가 피치 면적의 절반을 넘는다). 안무가 지목한 무버 2~3명 + 볼 캐리어는 "지금 이
  // 장면의 주어"이고, 시청자가 이름을 알고 싶은 유일한 선수들이다. 배치는 작전판과 같은
  // 충돌 회피 패스(labels.ts)를 그대로 쓰고, rank 0으로 두어 먼저 자리를 잡는다.
  if (playing) {
    const attacking = sequenceSide === 'home' ? state.home : state.away
    const coords = sequenceSide === 'home' ? homeD : awayD
    const attOn = sequenceSide === 'home' ? homeOn : awayOn
    const nameById = new Map(attacking.team.squad.map(p => [p.id, p.name.ko]))
    const already = new Set(reqs.map(r => r.id))
    const step = sequence![stepIdx]
    const cast = new Set<string>(step.movers.map(m => m.playerId))
    if (step.carrier) cast.add(step.carrier)
    attacking.tactics.lineup.forEach((slot, i) => {
      if (!cast.has(slot.playerId) || already.has(`nm-${slot.playerId}`) || !attOn[i]) return
      const name = nameById.get(slot.playerId)
      if (!name || !coords[i]) return
      reqs.push({
        id: `nm-${slot.playerId}`,
        text: name,
        ax: sx(coords[i].x),
        ay: sy(coords[i].y),
        fontSize: NAME_FS,
        slots: nameSlots(name),
        rank: 0,
      })
    })
  }
  // 도트·배지는 텍스트가 아니지만 글자에 덮이면 안 된다 → 고정 장애물로 넘긴다.
  const blockers: Box[] = []
  for (const [k, c] of [...homeD, ...awayD].entries()) {
    // 퇴장 선수 자리는 빈 잔디다 — 장애물로 넘기면 라벨이 아무것도 없는 곳을 피해 간다.
    if (!activeMask[k]) continue
    blockers.push({ x: sx(c.x) - DOT_BLOCK_R, y: sy(c.y) - DOT_BLOCK_R, w: DOT_BLOCK_R * 2, h: DOT_BLOCK_R * 2 })
  }
  const layout = layoutLabels(reqs, { x: 0.6, y: 0.6, w: W - 1.2, h: H - 1.2 }, blockers, stickyRef.current)
  useEffect(() => {
    const m = stickyRef.current
    m.clear()
    for (const p of layout.placed) m.set(p.id, p.slot)
  })
  const placedById = new Map(layout.placed.map(p => [p.id, p]))

  // ── 볼 캐리어 — "지금 누가 갖고 있나"를 링으로 말한다.
  // 저술이 캐리어를 명시하면(scenes/flow) 그 선수의 **실제 도트**에 붙인다. 명시가 없으면
  // (공 비행 중) 공에 가장 가까운 도트로 근사한다 — 곧 받을 선수가 미리 표시된다.
  const attackC = sequenceSide === 'home' ? homeD : awayD
  const carrierId = playing ? sequence![stepIdx].carrier : undefined
  const carrierIdx = carrierId
    ? (sequenceSide === 'home' ? state.home : state.away).tactics.lineup.findIndex(s => s.playerId === carrierId)
    : -1
  const ballRaw = playing ? interpBall(sequence!, stepIdx, ballEase, ballOffset) : null
  const ballPos = ballRaw && swapped ? rot(ballRaw) : ballRaw
  // ★ 인덱스 조회(carrierIdx)는 **라인업 정렬** 배열을 써야 하고, 근사 조회(nearestDot)는
  //   퇴장 선수를 빼야 한다 — 유령 도트가 제일 가까우면 터치 링이 빈 잔디에 걸린다.
  const attackOn = sequenceSide === 'home' ? homeOn : awayOn
  const carrier = !playing
    ? null
    : carrierIdx >= 0 && attackC[carrierIdx] && attackOn[carrierIdx]
      ? attackC[carrierIdx]
      : nearestDot(ballPos!, attackC.filter((_, i) => attackOn[i]))

  // z순서 — 이름표가 붙는 쪽(장면의 주어)이 위에 온다. 예전에는 방송 2D에서 어웨이를
  // 마지막에 그려 **우리 도트가 상대 도트에 통째로 가렸고 이름표만 남아** 상대 등번호에
  // 붙어 읽혔다(감사 ⑨). 재생 중이면 공격 팀, 아니면 언제나 우리 팀이 위다.
  const homeOnTop = !playing || sequenceSide === 'home'
  const homeDots = (
    <SideDots side={state.home} which="home" coords={homeD} on={homeOn} highlightId={highlightId} onDotClick={onDotClick} />
  )
  const awayDots = <SideDots side={state.away} which="away" coords={awayD} on={awayOn} />

  return (
    <svg
      className={
        `pv-root${variant === 'tactics' ? ' pv-root--tactics' : ''}${analysis ? ' pv-root--analysis' : ''}`
        // 안무 재생 중에는 CSS 보간을 전부 끈다 — 좌표는 JS 클럭이 이미 매 프레임 준다.
        + (playing ? ' pv-root--choreo' : '')
      }
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="경기 피치 포메이션"
      preserveAspectRatio="xMidYMid meet"
    >
      <PitchMarkings />
      {/* 전술 레이어는 마킹 위·도트 아래 — 선수를 가리지 않는다. */}
      {/* ★ 전술 레이어는 엔진 좌표를 그대로 그리고, 후반이면 **그룹째** 180° 돌린다.
          (레이어 안에는 글자가 없다 — 라벨은 analysisLabels가 따로 내보내 위에서 배치한다.) */}
      {analysis && (
        <g transform={swapped ? `rotate(180 ${W / 2} ${H / 2})` : undefined}>
          <AnalysisLayer state={state} geom={geom} highlight={analysisHighlight} />
        </g>
      )}
      {homeOnTop ? <>{awayDots}{homeDots}</> : <>{homeDots}{awayDots}</>}
      {ghost && <GhostDot side={state.home} slotIndex={ghost.slotIndex} number={ghost.number} swapped={swapped} />}
      {/* 시퀀스 재생 중엔 안무(공) 우선, 아니면 정적 lastEvent 마커.
          무버 고스트 원은 없앴다 — 진짜 도트가 이미 그 자리로 옮겨져 있다(감사 ⑤). */}
      {playing
        ? <ChoreoLayer ball={ballPos!} carrier={carrier} />
        : lastEvent && <EventMarker event={lastEvent} state={state} swapped={swapped} />}
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
 *  마커와 도트가 어긋날 수 없다(shape.ts의 마커-도트 일치 계약).
 *  퇴장 선수는 뺀다 — 화면에 없는 도트가 마커를 끌면 마커-도트 일치가 다시 깨진다.
 *  백라인이 통째로 퇴장한 극단(전원 false)에서는 마스크를 무시하고 원래 평균으로 돌아간다. */
function meanBackline(side: SideState, coords: Coord[], on: readonly boolean[]): number {
  const all = backlineIndices(side.tactics.formation)
  const idx = all.filter(i => on[i] !== false)
  const use = idx.length > 0 ? idx : all
  return use.reduce((s, i) => s + coords[i].x, 0) / use.length
}

/** 팀 무게중심(절대 프레임) — 필드 플레이어 10명의 **전술 좌표** 평균.
 *
 *  ★ 왜 라이브 좌표(도트가 실제로 있는 자리)가 아니라 전술 좌표인가:
 *  라이브 좌표에는 선수별 미세 진동과 **공 위치에 따른 블록 슬라이드**가 얹혀 있다
 *  (shape.liveTeamCoords의 BALL_PULL). 그 평균은 공을 따라 좌우로 계속 흔들려서,
 *  마커에 이동 transition을 걸면 **가만히 있어도 혼자 미끄러지는 상시 모션**이 된다
 *  — 사용자 지시 ①("새 상시 모션을 만들지 않는다")을 정면으로 어긴다. 게다가 그 흔들림
 *  폭이 멘탈리티 한 단계(3.5)보다 커서 정작 봐야 할 변화가 잡음에 묻힌다.
 *  전술 좌표 평균은 감독이 손잡이를 만질 때만 바뀐다 — 그게 이 마커가 말해야 하는 것이다.
 *
 *  ★ GK는 뺀다 — 골키퍼는 태세와 무관하게 골문에 남아 평균을 뒤로 끌어당긴다.
 *    블록 지표(shape.blockMetrics)도 같은 이유로 슬롯 0을 뺀다.
 *  ★ 퇴장 선수도 뺀다 — 화면에 없는 도트가 평균을 끌면 안 된다(meanBackline과 같은 규율). */
function teamGravity(side: SideState, which: 'home' | 'away', on: readonly boolean[]): Coord {
  const { formation, lineup, instructions } = side.tactics
  let sx0 = 0
  let sy0 = 0
  let n = 0
  for (let i = 1; i < lineup.length; i++) {
    if (on[i] === false) continue
    const c = tacticalCoords(formation, i, which, instructions)
    sx0 += c.x
    sy0 += c.y
    n++
  }
  // 필드 플레이어가 전부 사라지는 경우는 없지만(퇴장 상한), 0으로 나누지 않는다.
  return n > 0 ? { x: sx0 / n, y: sy0 / n } : { x: 50, y: 50 }
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

const EMPTY_POS: Map<string, Coord> = new Map()

/** 두 키프레임 사이를 보간한 무버 좌표(playerId → 절대 프레임). 진행도는 호출자가 이징한 값. */
function interpMovers(seq: ChoreoStep[], idx: number, e: number, off: Coord): Map<string, Coord> {
  const cur = seq[idx]
  const prev = idx > 0 ? seq[idx - 1] : cur
  const from = new Map(prev.movers.map(m => [m.playerId, m]))
  const out = new Map<string, Coord>()
  for (const m of cur.movers) {
    const a = from.get(m.playerId) ?? m
    out.set(m.playerId, { x: a.x + (m.x - a.x) * e + off.x, y: a.y + (m.y - a.y) * e + off.y })
  }
  return out
}

/** 두 키프레임 사이를 보간한 공 좌표(절대 프레임). */
function interpBall(seq: ChoreoStep[], idx: number, e: number, off: Coord): Coord {
  const cur = seq[idx]
  const prev = idx > 0 ? seq[idx - 1] : cur
  return {
    x: prev.ball.x + (cur.ball.x - prev.ball.x) * e + off.x,
    y: prev.ball.y + (cur.ball.y - prev.ball.y) * e + off.y,
  }
}

/** 무버 좌표를 **라인업 슬롯 인덱스**로 옮긴다(안무는 playerId로 말하고 도트는 슬롯 순이다). */
function applyMovers(side: SideState, pos: Map<string, Coord>): Map<number, Coord> {
  const out = new Map<number, Coord>()
  if (pos.size === 0) return out
  side.tactics.lineup.forEach((slot, i) => {
    const p = pos.get(slot.playerId)
    if (p) out.set(i, p)
  })
  return out
}

/** 슬롯 좌표 배열에 무버 좌표를 덮어쓴 새 배열. 입력은 건드리지 않는다. */
function overlay(coords: Coord[], moved: Map<number, Coord>): Coord[] {
  if (moved.size === 0) return coords
  return coords.map((c, i) => moved.get(i) ?? c)
}

/** 안무 재생 레이어 — 공(원+그림자)과 볼 캐리어 링.
 *  ★ 좌표 보간은 CSS transition이 아니라 **JS 클럭**이 한다(PitchView.segP). 그래야
 *    "지금 이 프레임의 선수 좌표"를 컴포넌트가 알고 진짜 도트를 그 자리로 옮길 수 있다.
 *    CSS로 미루면 화면만 움직이고 좌표는 키프레임에 머물러, 예전처럼 고스트 원을 따로
 *    그릴 수밖에 없다(감사 ⑤). 덤으로 공과 도트가 정확히 같은 시간축을 쓴다. */
function ChoreoLayer({ ball, carrier }: { ball: Coord; carrier: Coord | null }) {
  const bx = sx(ball.x)
  const by = sy(ball.y)
  return (
    <g className="pv-choreo" aria-hidden="true">
      {/* 볼 터치 링 — 공이 지금 향하는 선수. 공이 추상적으로 떠다니는 게 아니라
          **사람 발밑으로** 간다는 걸 형태로 말한다(패스 중에는 받는 선수를 미리 가리킨다). */}
      {carrier && <circle className="pv-carrier" cx={sx(carrier.x)} cy={sy(carrier.y)} r={3.6} />}
      <ellipse className="pv-ball__shadow" cx={bx} cy={by + 1.2} rx={1.7} ry={0.7} />
      <circle className="pv-ball" cx={bx} cy={by} r={1.5} />
    </g>
  )
}

/** 교체 고스트 도트 — 아웃 선수 슬롯 위치에 반투명 도트+투입 선수 번호. */
function GhostDot({ side, slotIndex, number, swapped }: { side: SideState; slotIndex: number; number?: number; swapped: boolean }) {
  const c = displayCoord(tacticalCoords(side.tactics.formation, slotIndex, 'home', side.tactics.instructions), swapped)
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

function SideDots({ side, which, coords, on, highlightId, onDotClick }: {
  side: SideState; which: 'home' | 'away'; coords: Coord[]
  /** 슬롯별 "피치 위에 있는가"(cast.onPitchMask). false면 도트를 아예 그리지 않는다. */
  on: readonly boolean[]
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
        // ★ 퇴장 선수는 **지운다**(회색으로 남기지 않는다). 이 보드의 첫 번째 일은 "지금
        //   몇 대 몇인가"를 셀 수 있게 하는 것이고, 회색이든 무슨 색이든 원이 하나 더
        //   있으면 11로 세인다. 누가 빠졌는지는 중계·이벤트 피드·교체 패널의 '퇴장' 칩이
        //   말한다(StatusChips). 실제 중계 그래픽도 같은 선택을 한다.
        if (!c || on[i] === false) return null
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
            // SVG <g>는 기본적으로 포커스를 받지 않는다 — tabIndex와 Enter/Space 처리를
            // 직접 얹어야 키보드로도 보드에서 선수를 고를 수 있다(조작 규약의 접근성 요구).
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (e => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDotClick!(slot.playerId) }
            }) : undefined}
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

function EventMarker({ event, state, swapped }: { event: MatchEvent; state: MatchState; swapped: boolean }) {
  const z = displayCoord(eventZone(event, state), swapped)
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
