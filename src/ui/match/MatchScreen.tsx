import { useState, useEffect, useMemo, useRef, lazy, Suspense, Component, type ReactNode } from 'react'
import type { Team, TacticState, MatchEvent, DecisionEntry } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import type { MomentKind } from '../../game/matchSession'
import { commentateAll, commentateAt } from '../../game/commentary'
import * as ctts from '../../audio/commentary-tts'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { PitchView } from '../pitch/PitchView'
import { buildSequence } from '../pitch/choreography'
import { TacticsBoard } from '../tactics/TacticsBoard'
import { TacticsCenter } from '../tactics/TacticsCenter'
import { PlanBadge } from '../tactics/PlanBadge'
import { ShootoutPanel } from './ShootoutPanel'
// 스탯 표는 워룸·작전판과 공유하기 위해 별도 모듈로 뽑았다(StatsTable.tsx).
import { StatsTable } from './StatsTable'
import { ShoutBar } from './ShoutBar'
import {
  minuteDwellWithSpeech, pickDramaEvent, isImportantEvent, eventIndex, type PlaybackSpeed,
} from './playback'
import * as sfx from '../../audio/sfx'
import './match.css'

// ★ 코드 스플릿: PixiPitch(→ pixi.js 전체)는 메인 번들에서 제외하고 지연 로드한다.
// 정적 import 시 pixi.js(~수백 kB)가 엔트리 청크에 정적으로 끌려와 500kB 경고를 유발했다.
// 로딩 순간에는 Suspense 폴백으로 동일 props의 SVG PitchView를 노출한다(피치 상시 노출 원칙 유지 —
// SVG가 잠깐 보였다가 Pixi로 교체). WebGL 불가 폴백 로직은 PixiPitch 내부에 그대로 있다.
const PixiPitch = lazy(() => import('../pitch/pixi/PixiPitch').then(m => ({ default: m.PixiPitch })))

// ★ 3D 매치 뷰(Phase 4E) — three.js는 pixi보다 훨씬 무거우므로 같은 방식으로 지연 로드한다.
// Match3D 내부에서 three를 다시 dynamic import하므로 three는 별도 청크로 분리된다
// (엔트리 청크에 three 시그니처 부재를 build 후 grep으로 검증).
const Match3D = lazy(() => import('../pitch/three/Match3D').then(m => ({ default: m.Match3D })))

/** 2D/3D 렌더러 선택 기억(기본 3D). 심사·저사양 배려로 언제든 2D로 내릴 수 있다. */
const RENDER3D_KEY = 'rematch-render3d'

function read3dPref(): boolean {
  try {
    return localStorage.getItem(RENDER3D_KEY) !== '0'
  } catch {
    return true
  }
}

function write3dPref(on: boolean): void {
  try {
    localStorage.setItem(RENDER3D_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** PixiPitch 청크 로드 실패(네트워크 오류·배포 중 404) 시 React.lazy가 렌더 중 에러를
 *  throw한다. 에러 바운더리가 없으면 이 에러가 위로 전파되어 앱 전체가 백지가 된다
 *  (PixiPitch 내부 WebGL 폴백은 컴포넌트가 로드된 뒤에만 작동 → 이 경로를 못 막는다).
 *  경량 클래스 바운더리로 감싸 실패 시 동일 props의 SVG PitchView(fallback)로 대체한다
 *  — 피치 상시 노출·크래시 금지 원칙 유지. */
class PitchBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** 위험 순간 강조 xG 임계(찬스 큰 세이브·유효 미스). */
const DANGER_XG = 0.25

// 방송 모드↔작전판 모드 전환 연출 지속(ms). 작전판 이탈 시 역연출을 위해
// 이 시간만큼 마운트를 유지한다(CSS transition/animation 길이와 일치).
const MODE_TRANSITION_MS = 600

// 동적 순간 유형별 방송 배너 문구(제안 시). matchSession.DecisionMoment.title과 별개로,
// 배너에서는 감독에게 말 거는 어투로 노출한다(스펙 §17.2 방송 배너).
// broadcast 모드(재생 중)에서만 노출 — 정지·하프타임 안내는 작전판이 담당한다.
const MOMENT_PHRASE: Record<MomentKind, string> = {
  conceded: '실점 직후입니다',
  'momentum-lost': '흐름이 상대에게 넘어갑니다',
  scored: '득점 직후 — 더 몰아칠까요?',
  clutch: '승부의 시간입니다',
  fatigue: '주력 선수 체력이 바닥납니다',
}

interface MatchScreenProps {
  home: Team
  away: Team
  seed: number
  /** 라인업 화면에서 확정한 홈 전술(캠페인·데모). 미지정 시 엔진 기본 XI. */
  initialTactics?: TacticState
  /** 조별 경기: 전반 재현 스크립트(전반은 시뮬 대신 이 결과를 사용). */
  firstHalfScript?: { events: MatchEvent[]; score: [number, number] }
  /** 체력 이월: 홈 선수별 시작 스태미나 덮어쓰기(캠페인). */
  staminaOverride?: Record<string, number>
  /** 조별 경기 참고 표시용 실제 스코어 [한국, 상대]. */
  referenceScore?: [number, number]
  /** 토너먼트: 무승부 시 승부차기로 승자를 가려야 한다. */
  requireWinner?: boolean
  /** 캠페인: 경기 종료 시 결과 콜백. 미지정 시 데모 동작([다시 보기]).
   *  4번째 인자 decisionLog는 이 경기의 감독 개입 기록(기자회견 근거).
   *  5번째 인자 finalTactics는 종료 시점 홈 전술 — 다음 경기 초기값 이월용
   *  (허브 복귀 후엔 matchStore가 reset될 수 있으므로 여기서 미리 붙들어 넘긴다). */
  onMatchEnd?(
    score: [number, number],
    staminaByPlayer: Record<string, number>,
    shootout: [number, number] | undefined,
    decisionLog: DecisionEntry[],
    finalTactics: TacticState,
  ): void
}

/** 경기 화면 조립 — ★ 2모드 분리(스펙 §17 Task 4): "시뮬 관전 중인지 작전 지시
 *  중인지" 절대 헷갈리지 않도록 시각 정체성을 분리한다.
 *  - **broadcast**(playing/pre/fulltime): 그린 피치 와이드 관전. 스코어버그·티커·
 *    속도 토글·[⏸ 감독 타임]·재생 중 순간 배너만. 콘솔 없음.
 *  - **tactics**(정지·하프타임): 다크 전술판(TacticsBoard) — 포메이션 셀렉터·
 *    지시/교체/상대 탭·[전술 확정]. 방송 위로 슬라이드 업(0.6s 전환 연출, 방송은 디밍).
 *  전환은 CSS transition/animation(reduced-motion 대응). 복귀는 역연출 후 언마운트.
 *  ★ 오버레이 폐지 원칙은 broadcast 내에서 유지 — 피치 SVG는 관전 중 언제나 보인다.
 *
 *  재생은 매치데이 2.0 세션(matchStore): advanceMinute()로 1분씩 전진하며
 *  engine.minute가 곧 표시 분이다(엔진이 앞서 달리지 않아 스포일러 없음).
 *  재생 타이밍은 분당 가변 setTimeout 체인(하이라이트 리듬) — 사건 큰 분은 오래
 *  머물고 무사건 분은 빨리 넘긴다(playback.minuteDwellMs, Math.random·Date 금지).
 *  속도 토글 1x/1.5x/2x로 dwell을 나눈다.
 *  onMatchEnd 유무로 데모/캠페인 동작을 분기(props 하위호환). */
export function MatchScreen({
  home, away, seed,
  initialTactics, firstHalfScript, staminaOverride, referenceScore, requireWinner, onMatchEnd,
}: MatchScreenProps) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const momentPrompt = useMatchStore(s => s.momentPrompt)
  const oppNotices = useMatchStore(s => s.oppNotices)
  const startMatch = useMatchStore(s => s.startMatch)
  const kickoff = useMatchStore(s => s.kickoff)
  const advanceMinute = useMatchStore(s => s.advanceMinute)
  const pauseByUser = useMatchStore(s => s.pauseByUser)
  const acceptMoment = useMatchStore(s => s.acceptMoment)
  const dismissMoment = useMatchStore(s => s.dismissMoment)
  const logShootoutSetup = useMatchStore(s => s.logShootoutSetup)
  const reset = useMatchStore(s => s.reset)

  const [shootoutOpen, setShootoutOpen] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(1)
  // 렌더러 선택 — 3D(three) ↔ 2D(pixi). localStorage 기억, 기본 3D.
  const [render3d, setRender3d] = useState(read3dPref)
  // 사운드 — 음소거 상태(sfx 모듈 = localStorage 진실원)와 관중 스웰(골 직후 4초).
  const [muted, setMutedUi] = useState(() => sfx.isMuted())
  // 한국어 TTS 해설 토글(음소거와 별개, localStorage 기억) — 스코어버그 옆 [🎙].
  const [ttsOn, setTtsOnUi] = useState(() => ctts.isTtsEnabled())
  const [crowdSwell, setCrowdSwell] = useState(false)
  const swellTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const firedGoalMinuteRef = useRef(-1)
  const spokenMinuteRef = useRef(-1)
  const prevPhaseRef = useRef<string | null>(null)

  // 경기 초기화(마운트/픽스처 변경 시). 엔진은 pre 상태로 준비.
  // initialTactics/firstHalfScript/staminaOverride는 매치별로 안정 참조(App에서 memo).
  useEffect(() => {
    setShootoutOpen(false)
    firedGoalMinuteRef.current = -1
    spokenMinuteRef.current = -1
    startMatch(home, away, seed, {
      ...(initialTactics ? { homeTactics: initialTactics } : {}),
      ...(firstHalfScript ? { firstHalfScript } : {}),
      ...(staminaOverride ? { staminaOverride } : {}),
    })
  }, [home, away, seed, startMatch, initialTactics, firstHalfScript, staminaOverride])

  // 재생 중 = playing. 시간 정지(카운트다운 없음)는 phase가 playing이 아닐 때.
  const replaying = phase === 'playing'
  const paused = phase === 'paused-break' || phase === 'paused-user' || phase === 'paused-moment'
  // ★ 모드 분리: 정지·하프타임이면 작전판(tactics), 그 외(재생·킥오프 전·종료)는 방송(broadcast).
  const tacticsMode = paused || phase === 'halftime'

  // 재생 루프 — 분당 가변 setTimeout 체인(하이라이트 리듬).
  // 현재 분의 이벤트로 dwell을 계산해 그만큼 머문 뒤 advanceMinute()로 1분 전진.
  // playing이 아니면(정지·하프타임·풀타임) 체인을 걸지 않는다 → 자동 정지.
  // confirmTactics/kickoff로 phase가 'playing'이 되면 effect가 재실행되어 재개.
  // speed 변경 시에도 재실행되어 즉시 반영. 언마운트/전환 시 타이머 정리.
  useEffect(() => {
    if (phase !== 'playing') return
    let timer: ReturnType<typeof setTimeout>
    let cancelled = false
    const schedule = () => {
      const st = useMatchStore.getState()
      const eng = st.engine
      if (cancelled || !eng || st.phase !== 'playing') return
      const m = eng.minute
      const eventsAtMinute = eng.events.filter(e => e.minute === m)
      const diff = Math.abs(eng.score[0] - eng.score[1])
      const clutch = m >= 80 && diff <= 1
      // 블로우아웃(3골차+) 가속 — 승부 갈린 뒤 늘어짐 방지.
      // 해설이 들리는 상태면 주인공 이벤트 발화 길이를 dwell 하한으로 쓴다(말 잘림 방지).
      const dwell = minuteDwellWithSpeech(
        m, eventsAtMinute, home, away, speed, clutch, diff, ctts.willSpeak(),
      )
      timer = setTimeout(() => {
        if (cancelled) return
        advanceMinute()
        schedule()
      }, dwell)
    }
    schedule()
    return () => { cancelled = true; clearTimeout(timer) }
    // ttsOn: 해설 토글이 dwell 하한(발화 길이 보정)을 켜고 끄므로 의존에 포함한다.
  }, [phase, speed, advanceMinute, home, away, ttsOn])

  // ── 모드 전환 연출: 작전판 마운트/이탈 ──────────────────────────────
  // tacticsMode 진입 시 즉시 마운트(entrance 애니메이션은 CSS가 담당),
  // 이탈 시 --exiting 클래스로 역연출을 재생한 뒤 MODE_TRANSITION_MS 후 언마운트한다.
  // broadcast 순수 상태(작전판 미마운트)에선 콘솔이 DOM에 없다 → 관전에 콘솔 부재.
  const [tacticsMounted, setTacticsMounted] = useState(false)
  const [tacticsExiting, setTacticsExiting] = useState(false)
  useEffect(() => {
    if (tacticsMode) {
      setTacticsExiting(false)
      setTacticsMounted(true)
      return
    }
    if (!tacticsMounted) return
    // 이탈 — 역연출 후 언마운트.
    setTacticsExiting(true)
    const t = setTimeout(() => { setTacticsMounted(false); setTacticsExiting(false) }, MODE_TRANSITION_MS)
    return () => clearTimeout(t)
  }, [tacticsMode, tacticsMounted])

  // ── 현재 분 하이라이트 안무: 그 분의 **주인공 이벤트**를 시퀀스로 번역 ──
  // ★ 주인공은 pickDramaEvent 하나가 정한다 — 아래 TTS 효과도 같은 함수를 쓰므로
  //   "말한 이벤트 = 그린 이벤트"가 구조적으로 보장된다(예전엔 규칙이 둘이었다).
  // engine이 분 단위로 전진하므로 engine 참조가 바뀔 때(=분 전환)만 재계산 → 한 분
  // 재생 동안 시퀀스 참조가 안정적(ChoreoLayer 타이머가 중간에 리셋되지 않음).
  const highlight = useMemo(() => {
    if (!engine) return null
    const m = engine.minute
    const drama = pickDramaEvent(engine.events.filter(e => e.minute === m))
    if (!drama) return null
    const seq = buildSequence(drama, engine.home, engine.away)
    if (seq.length === 0) return null
    const side: 'home' | 'away' = drama.teamId === engine.home.team.id ? 'home' : 'away'
    return { seq, side }
  }, [engine])

  // ── 사운드 배선(매치데이 2.0) — 모두 sfx는 미지원 환경 no-op ──────────
  // 휘슬: phase 전이 1회. 하프 2회·풀타임 3회(+관중 정지)·브레이크 짧게. 킥오프는 버튼 핸들러(제스처).
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    if (prev === phase) return
    if (phase === 'halftime') sfx.whistle('halftime')
    else if (phase === 'fulltime') { sfx.whistle('fulltime'); sfx.crowdLoop('stop') }
    else if (phase === 'paused-break') sfx.whistle('break')
  }, [phase])

  // 골 사운드: 재생 중 현재 분의 골에 1회 발동(우리=goalBurst / 실점=concedeMurmur) + 관중 스웰 4초.
  useEffect(() => {
    if (phase !== 'playing' || !engine) return
    const m = engine.minute
    const goal = engine.events.find(e => e.type === 'goal' && e.minute === m)
    if (!goal || firedGoalMinuteRef.current === m) return
    firedGoalMinuteRef.current = m
    if (goal.teamId !== engine.home.team.id) sfx.concedeMurmur()
    else sfx.goalBurst()
    setCrowdSwell(true)
    if (swellTimerRef.current) clearTimeout(swellTimerRef.current)
    swellTimerRef.current = setTimeout(() => setCrowdSwell(false), 4000)
  }, [phase, engine])

  // TTS 해설: 재생 중 현재 분의 **주인공 이벤트** 1개만 발화(과밀 방지).
  // ★ 위 highlight 안무와 동일한 pickDramaEvent를 쓴다 — 말하는 이벤트와 그리는
  //   이벤트가 항상 같아야 한다(이 계약은 MatchScreen 테스트가 고정한다).
  // Line.speech(TTS 전용 문자열)를 읽고, goal·save는 important(rate·pitch 강조 + 발화 중 선점).
  // ★ 화면에 뿌리는 Line.text와 다른 문자열이다 — `고오오올`·`…`·`!!!`은 ko-KR 보이스에서
  //   말더듬·오독이 되므로 발화에는 정규화된 speech를 쓴다(리서치 §5.2).
  // 분당 1회(spokenMinuteRef)만 발동 — 미지원·보이스 없음·토글 OFF면 조용한 no-op.
  useEffect(() => {
    if (phase !== 'playing' || !engine) return
    const m = engine.minute
    if (spokenMinuteRef.current === m) return
    spokenMinuteRef.current = m
    const all = engine.events.filter(e => e.minute <= m)
    const spoken = pickDramaEvent(all.filter(e => e.minute === m))
    if (!spoken) return
    // 히스토리를 넘겨야 streak·골 종류·변형 억제가 산다(맥락 없는 단발 호출은 로봇 신호).
    const line = commentateAt(all, eventIndex(all, spoken), home, away, seed)
    // speed를 함께 넘긴다 — 빨리감기 중계는 발화도 빨라져야 체류 시간과 맞는다.
    ctts.speak(line.speech, { important: isImportantEvent(spoken), speed })
  }, [phase, engine, home, away, speed, seed])

  // 작전판 진입·pause 시 진행 중 발화를 취소한다(작전 지시 중 해설이 새지 않게).
  useEffect(() => {
    if (tacticsMode) ctts.stopAll()
  }, [tacticsMode])

  // 관중 함성 강도: 기본 0.3, 클러치(80분+·1골차 이내) 0.5, 골 직후 스웰 0.8. crowdLoop('start')는 게인만 갱신(멱등).
  useEffect(() => {
    if (phase !== 'playing' || !engine) return
    const m = engine.minute
    const clutch = m >= 80 && Math.abs(engine.score[0] - engine.score[1]) <= 1
    sfx.crowdLoop('start', crowdSwell ? 0.8 : clutch ? 0.5 : 0.3)
  }, [phase, engine, crowdSwell])

  // 언마운트: 스웰 타이머 정리 + 관중 루프 정지(다음 화면으로 함성이 새지 않게).
  useEffect(() => () => {
    if (swellTimerRef.current) clearTimeout(swellTimerRef.current)
    sfx.crowdLoop('stop')
    ctts.stopAll()
  }, [])

  // 킥오프: 유저 제스처에서 AudioContext init → 휘슬 1회 + 관중 루프 시작. TTS 보이스 탐색도 여기서.
  function handleKickoff() {
    sfx.init()
    ctts.initVoice()
    sfx.whistle('kickoff')
    sfx.crowdLoop('start', 0.3)
    kickoff()
  }

  // 음소거 토글(sfx가 localStorage 기억) — UI 아이콘 동기화.
  function toggleMute() {
    setMutedUi(sfx.toggleMuted())
  }

  // TTS 해설 토글(commentary-tts가 localStorage 기억) — UI 동기화. OFF 시 진행 발화 중단.
  function toggleTts() {
    setTtsOnUi(ctts.toggleTts())
  }

  // 2D/3D 렌더러 토글 — 선택을 localStorage에 기억한다(저사양·심사 환경 배려).
  function toggleRender3d() {
    const next = !render3d
    setRender3d(next)
    write3dPref(next)
  }

  // 토너먼트 무승부 → 승부차기 진입 필요 (캠페인 한정).
  const needsShootout = !!onMatchEnd && !!requireWinner && !!engine && engine.score[0] === engine.score[1]

  // 경기 결과를 캠페인으로 반환한다(홈 종료 스태미나·결정 로그 포함).
  function finishMatch(shootout?: [number, number]) {
    if (!engine || !onMatchEnd) return
    const decisionLog = useMatchStore.getState().decisionLog
    onMatchEnd(
      [engine.score[0], engine.score[1]],
      { ...engine.home.staminaByPlayer },
      shootout,
      decisionLog,
      structuredClone(engine.home.tactics),
    )
  }

  // 승부차기 진입 — 키커 순서 확정을 결정 로그에 기록.
  function openShootout() {
    logShootoutSetup('PK: 키커 순서 확정')
    setShootoutOpen(true)
  }

  if (!engine) return <div className="ms-root ms-root--empty" />

  const displayMinute = engine.minute
  // 현재 분까지 도달한 이벤트만 노출. 엔진이 분 단위로 전진하므로 engine.score와
  // 일치하지만, Ticker/PitchView와 동일 필터로 골 이벤트에서 표시 스코어를 파생한다.
  const shown = engine.events.filter(e => e.minute <= displayMinute)
  // 라인은 배열 단위로 만든다 — 접두 안정성이 있어 매 분 다시 계산해도 앞 줄이 바뀌지 않는다.
  const commentaryLines = commentateAll(shown, home, away, seed)
  const tickerLines = commentaryLines.map(l => ({ minute: l.minute, text: l.text }))
  const lastEvent = shown[shown.length - 1]
  const shownScore: [number, number] = [0, 0]
  for (const e of shown) {
    if (e.type === 'goal') shownScore[e.teamId === home.id ? 0 : 1] += 1
  }
  // 빨리감기 연출: 재생 중 현재 분에 이벤트가 없으면 분 숫자가 빠르게 넘어간다.
  const fastForward = replaying && !engine.events.some(e => e.minute === displayMinute)

  // ── 이번 분 연출 플래그(재생 중에만) ──────────────────────────────
  const minuteEvents = engine.events.filter(e => e.minute === displayMinute)
  const diffNow = Math.abs(shownScore[0] - shownScore[1])
  const clutchNow = displayMinute >= 80 && diffNow <= 1
  // 시퀀스 재생 총 시간 = 그 분의 실제 dwell(재생 루프와 동일 함수 — 어긋나면 안무가
  // 분 전환보다 늦게 끝나거나 일찍 끝나 정적이 생긴다).
  const seqDwell = minuteDwellWithSpeech(
    displayMinute, minuteEvents, home, away, speed, clutchNow, diffNow, ctts.willSpeak(), shown, seed,
  )
  const playSequence = replaying && !!highlight
  // 골 드라마: 이번 분 득점. 상대 골이면 실점 연출로 차별화.
  const goalEvent = minuteEvents.find(e => e.type === 'goal')
  const goalDrama = replaying && !!goalEvent
  const conceded = !!goalEvent && goalEvent.teamId !== home.id
  const scorerTeam = goalEvent ? (goalEvent.teamId === home.id ? home : away) : undefined
  const scorerName = goalEvent?.playerId && scorerTeam
    ? scorerTeam.squad.find(p => p.id === goalEvent.playerId)?.name.ko
    : undefined
  // 위험 순간: xG 0.25+ 세이브·미스.
  const dangerEvent = minuteEvents.find(e => (e.type === 'save' || e.type === 'miss') && (e.xg ?? 0) >= DANGER_XG)
  const dangerMoment = replaying && !!dangerEvent

  // 상단 방송 배너 — broadcast 모드(재생 중) 순간 제안이 우선. 정지·하프타임 안내는 작전판이 담당.
  // 제안이 없을 때만 상대 감독의 최근 변경 통보를 3분간 흘려보낸다(슬롯 1개를 공유하므로
  // 감독의 결정 기회를 상대 통보가 가리면 안 된다).
  const momentBanner = replaying && momentPrompt
    ? `⚡ ${MOMENT_PHRASE[momentPrompt.kind]} — 감독 타임을 쓰시겠습니까?`
    : null
  const lastNotice = oppNotices.length > 0 ? oppNotices[oppNotices.length - 1] : null
  const recentNotice = lastNotice && displayMinute - lastNotice.minute < 3 ? lastNotice.text : null
  const bannerText = momentBanner ?? recentNotice

  // ── 렌더러 체인 조립(모든 단계가 같은 props 계약을 받는다) ──────────
  // 3D는 이 2D 체인을 fallback 노드로 주입받는다 — Match3D가 pixi를 정적으로
  // import하면 three 청크에 pixi가 딸려오므로, 노드로 넘겨 청크 분리를 유지한다.
  const pitchProps = {
    state: engine,
    lastEvent,
    sequence: playSequence ? highlight!.seq : undefined,
    dwellMs: seqDwell,
    sequenceSide: highlight?.side,
  }
  const pitchSvg = <PitchView {...pitchProps} />
  const pitch2d = (
    <PitchBoundary fallback={pitchSvg}>
      <Suspense fallback={pitchSvg}>
        <PixiPitch {...pitchProps} />
      </Suspense>
    </PitchBoundary>
  )

  return (
    <div className={`ms-root ms-root--broadcast${tacticsMounted && !tacticsExiting ? ' ms-root--tactics' : ''}`}>
      <div className={`ms-stage${tacticsMounted && !tacticsExiting ? ' ms-stage--dim' : ''}${phase === 'pre' ? ' ms-stage--pre' : ''}`}>
        <Scorebug
          home={home}
          away={away}
          score={shownScore}
          minute={displayMinute}
          live={replaying}
          fastForward={fastForward}
          pulse={goalDrama}
        />
        {/* 플랜 상태 배지 — 스코어버그 옆(우측). 킥오프 후에만 나타난다.
            "계획을 지키면 팀 이해도 +3%, 버리면 몇 축을 버렸는지"를 상시 노출해
            하프타임에 전부 갈아엎는 선택에 눈에 보이는 값을 붙인다. */}
        <PlanBadge />
        {/* 음소거 토글 — 스코어버그 옆. 항상 노출(localStorage 기억). */}
        <button
          type="button"
          className="ms-mute"
          aria-label={muted ? '소리 켜기' : '음소거'}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        {/* 한국어 TTS 해설 토글 — 음소거 옆. 음소거와 별개(localStorage 'rematch-tts'). */}
        <button
          type="button"
          className="ms-tts"
          aria-label={ttsOn ? '해설 음성 끄기' : '해설 음성 켜기'}
          aria-pressed={ttsOn}
          onClick={toggleTts}
        >
          🎙
        </button>
        {/* 2D/3D 렌더러 토글 — TTS 옆. 현재 모드를 표시하고, 누르면 반대로 전환된다. */}
        <button
          type="button"
          className="ms-r3d"
          aria-label={render3d ? '2D 화면으로 전환' : '3D 화면으로 전환'}
          aria-pressed={render3d}
          onClick={toggleRender3d}
        >
          {render3d ? '3D' : '2D'}
        </button>
        {/* 재생 중 감독 타임 버튼 — 스코어버그 옆. pauseByUser로 자유 일시정지. */}
        {replaying && (
          <div className="ms-live-controls">
            <button type="button" className="ms-btn ms-btn--sm" onClick={pauseByUser}>⏸ 감독 타임</button>
          </div>
        )}
        <SpeedToggle speed={speed} onChange={setSpeed} />

        {/* ── 상단 방송 배너(피치 밖, 스코어버그 아래 얇은 바) ── */}
        {bannerText && (
          <div
            className={`ms-banner${momentBanner ? ' ms-banner--moment' : ' ms-banner--opp'}`}
            role="status"
          >
            <span className="ms-banner__text">{bannerText}</span>
            {replaying && momentPrompt && (
              <span className="ms-banner__actions">
                <button type="button" className="ms-btn ms-btn--sm" onClick={acceptMoment}>사용</button>
                <button type="button" className="ms-btn ms-btn--sm ms-btn--ghost" onClick={dismissMoment}>흘려보낸다</button>
              </span>
            )}
          </div>
        )}

        {/* ── 피치 — 언제나 보인다(가리는 오버레이 없음).
            렌더러 체인: Match3D(three) → PixiPitch(pixi) → PitchView(SVG).
            각 단계는 청크 로드 실패를 PitchBoundary가, 런타임 미지원(WebGL 불가·
            컨텍스트 로스)을 컴포넌트 내부 폴백이 받아 다음 단계로 넘긴다.
            토글로 3D를 끄면 2D 체인만 남는다(key로 바운더리 상태까지 리셋). ── */}
        <div className="ms-pitch-wrap">
          {render3d ? (
            <PitchBoundary key="chain-3d" fallback={pitch2d}>
              <Suspense fallback={pitchSvg}>
                <Match3D {...pitchProps} fallback={pitch2d} />
              </Suspense>
            </PitchBoundary>
          ) : (
            pitch2d
          )}
        </div>

        <Ticker lines={tickerLines} emphasis={dangerMoment} />

        {/* ── 골 드라마: 대형 타이포 + 득점자 배너 + (스코어버그 펄스) ──
            풀스크린 플래시·파티클·카메라 셰이크는 PixiPitch(WebGL)가 담당한다
            (중복이던 DOM ms-drama__flash 제거 — Task 13 보고). GOAL 타이포는 DOM 유지.
            피치를 가리지 않는 순간 이펙트(pointer-events 없음). key=분으로 골마다 재발동. */}
        {goalDrama && (
          <div
            key={`drama-${displayMinute}`}
            className={`ms-drama ms-drama--${conceded ? 'concede' : 'score'}`}
            aria-hidden="true"
          >
            <span className="ms-drama__word">{conceded ? '실점…' : 'GOAL!'}</span>
          </div>
        )}
        {goalDrama && (
          <div key={`scorer-${displayMinute}`} className="ms-scorer" role="status">
            <span className={`ms-scorer__tag${conceded ? ' ms-scorer__tag--concede' : ''}`}>
              {conceded ? '실점' : '골'}
            </span>
            <span className="ms-scorer__name">{scorerName ?? scorerTeam?.name.ko ?? ''}</span>
            <span className="ms-scorer__min">{displayMinute}&apos;</span>
          </div>
        )}
        {/* ── 위험 순간: 비네팅(가장자리 어두워짐) 0.5s ── */}
        {dangerMoment && <span key={`vig-${displayMinute}`} className="ms-vignette" aria-hidden="true" />}

        {/* ── 터치라인 외침 바(broadcast 하단) — 재생 중에만. 정지 없이 즉시 사기 보정. ── */}
        {replaying && <ShoutBar />}

        {/* ── 킥오프 전 전술 센터 — 예전 [킥오프] 하단 바를 대체한다.
            방송 스테이지(피치)는 배경으로 남고, 워룸이 그 아래에 붙는다.
            tacticsMode에 'pre'를 넣지 않는 이유: TacticsBoard 오버레이가 전술 센터
            위에 이중으로 뜬다. 'pre'의 지휘 UI는 전술 센터 하나뿐이다. ── */}
        {phase === 'pre' && (
          <div className="ms-precenter">
            <TacticsCenter onKickoff={handleKickoff} referenceScore={referenceScore} />
          </div>
        )}

        {phase === 'fulltime' && (
          <div className="ms-bottom ms-bottom--full">
            {shootoutOpen ? (
              <ShootoutPanel home={home} away={away} seed={seed} onDone={result => finishMatch(result)} />
            ) : (
              <>
                <div className="ms-final">
                  <span className="ms-final__code">{home.fifaCode}</span>
                  <span className="ms-final__score">{engine.score[0]} : {engine.score[1]}</span>
                  <span className="ms-final__code">{away.fifaCode}</span>
                </div>
                <StatsTable home={engine.stats[0]} away={engine.stats[1]} />
                {!onMatchEnd ? (
                  <button
                    type="button"
                    className="ms-btn ms-btn--primary"
                    onClick={() => { reset(); startMatch(home, away, seed) }}
                  >
                    다시 보기
                  </button>
                ) : needsShootout ? (
                  <button type="button" className="ms-btn ms-btn--primary" onClick={openShootout}>승부차기로</button>
                ) : (
                  <button type="button" className="ms-btn ms-btn--primary" onClick={() => finishMatch()}>결과 확정</button>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── 작전판 오버레이(tactics 모드) — 방송 위로 슬라이드 업. 이탈 시 역연출. ──
          broadcast 순수 상태에선 마운트되지 않아 콘솔이 DOM에 존재하지 않는다. */}
      {tacticsMounted && (
        <div className={`ms-tactics-layer${tacticsExiting ? ' ms-tactics-layer--exiting' : ''}`}>
          <TacticsBoard />
        </div>
      )}
    </div>
  )
}

const SPEEDS: PlaybackSpeed[] = [1, 1.5, 2]

/** 재생 속도 토글 — 스코어버그 맞은편(우상단). 선택 상태 하이라이트, 재생 중 변경 즉시 반영. */
function SpeedToggle({ speed, onChange }: { speed: PlaybackSpeed; onChange(s: PlaybackSpeed): void }) {
  return (
    <div className="ms-speed" role="group" aria-label="재생 속도">
      {SPEEDS.map(s => (
        <button
          key={s}
          type="button"
          aria-pressed={speed === s}
          className={`ms-speed__btn${speed === s ? ' ms-speed__btn--active' : ''}`}
          onClick={() => onChange(s)}
        >
          {s}x
        </button>
      ))}
    </div>
  )
}
