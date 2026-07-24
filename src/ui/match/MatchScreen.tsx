import { useState, useEffect, useMemo, useRef } from 'react'
import type { Team, SideStats, TacticState, MatchEvent, DecisionEntry } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import type { MomentKind } from '../../game/matchSession'
import { commentate } from '../../game/commentary'
import * as ctts from '../../audio/commentary-tts'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { PitchView } from '../pitch/PitchView'
import { buildSequence } from '../pitch/choreography'
import { TacticsBoard } from '../tactics/TacticsBoard'
import { ShootoutPanel } from './ShootoutPanel'
import { ShoutBar } from './ShoutBar'
import { minuteDwellMs, EVENT_DWELL_MS, type PlaybackSpeed } from './playback'
import * as sfx from '../../audio/sfx'
import './match.css'

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
   *  4번째 인자 decisionLog는 이 경기의 감독 개입 기록(기자회견 근거). */
  onMatchEnd?(score: [number, number], staminaByPlayer: Record<string, number>, shootout: [number, number] | undefined, decisionLog: DecisionEntry[]): void
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
      const dwell = minuteDwellMs(m, eventsAtMinute, speed, clutch, diff)
      timer = setTimeout(() => {
        if (cancelled) return
        advanceMinute()
        schedule()
      }, dwell)
    }
    schedule()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [phase, speed, advanceMinute])

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

  // ── 현재 분 하이라이트 안무: 그 분의 최고 가중 이벤트를 골라 시퀀스로 번역 ──
  // engine이 분 단위로 전진하므로 engine 참조가 바뀔 때(=분 전환)만 재계산 → 한 분
  // 재생 동안 시퀀스 참조가 안정적(ChoreoLayer 타이머가 중간에 리셋되지 않음).
  const highlight = useMemo(() => {
    if (!engine) return null
    const m = engine.minute
    let drama: MatchEvent | undefined
    let best = -1
    for (const e of engine.events) {
      if (e.minute !== m) continue
      const w = EVENT_DWELL_MS[e.type] ?? -1
      if (w > best) { best = w; drama = e }
    }
    if (!drama) return null
    const side: 'home' | 'away' = drama.teamId === engine.home.team.id ? 'home' : 'away'
    return { seq: buildSequence(drama, engine.home, engine.away), side }
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

  // TTS 해설: 재생 중 현재 분의 대표 이벤트(goal>save>miss>corner>foul) 1개만 발화(과밀 방지).
  // commentate() 문장을 그대로 읽고, goal·save는 important(rate·pitch 강조 + 발화 중 선점).
  // 분당 1회(spokenMinuteRef)만 발동 — 미지원·보이스 없음·토글 OFF면 조용한 no-op.
  useEffect(() => {
    if (phase !== 'playing' || !engine) return
    const m = engine.minute
    if (spokenMinuteRef.current === m) return
    spokenMinuteRef.current = m
    const eventsAtMinute = engine.events.filter(e => e.minute === m)
    const spoken = ctts.pickSpokenEvent(eventsAtMinute)
    if (!spoken) return
    const important = spoken.type === 'goal' || spoken.type === 'save'
    ctts.speak(commentate(spoken, home, away), { important })
  }, [phase, engine, home, away])

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

  // 토너먼트 무승부 → 승부차기 진입 필요 (캠페인 한정).
  const needsShootout = !!onMatchEnd && !!requireWinner && !!engine && engine.score[0] === engine.score[1]

  // 경기 결과를 캠페인으로 반환한다(홈 종료 스태미나·결정 로그 포함).
  function finishMatch(shootout?: [number, number]) {
    if (!engine || !onMatchEnd) return
    const decisionLog = useMatchStore.getState().decisionLog
    onMatchEnd([engine.score[0], engine.score[1]], { ...engine.home.staminaByPlayer }, shootout, decisionLog)
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
  const lines = shown.map(e => commentate(e, home, away))
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
  // 시퀀스 재생 총 시간 = 그 분의 실제 dwell(재생 루프와 동일 산식).
  const seqDwell = minuteDwellMs(displayMinute, minuteEvents, speed, clutchNow, diffNow)
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

  // 상단 방송 배너 — broadcast 모드(재생 중) 순간 제안만. 정지·하프타임 안내는 작전판이 담당.
  const bannerText = replaying && momentPrompt
    ? `⚡ ${MOMENT_PHRASE[momentPrompt.kind]} — 감독 타임을 쓰시겠습니까?`
    : null

  return (
    <div className={`ms-root ms-root--broadcast${tacticsMounted && !tacticsExiting ? ' ms-root--tactics' : ''}`}>
      <div className={`ms-stage${tacticsMounted && !tacticsExiting ? ' ms-stage--dim' : ''}`}>
        <Scorebug
          home={home}
          away={away}
          score={shownScore}
          minute={displayMinute}
          live={replaying}
          fastForward={fastForward}
          pulse={goalDrama}
        />
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
            className={`ms-banner${momentPrompt && replaying ? ' ms-banner--moment' : ''}`}
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

        {/* ── 피치 — 언제나 보인다(가리는 오버레이 없음) ── */}
        <div className="ms-pitch-wrap">
          <PitchView
            state={engine}
            lastEvent={lastEvent}
            sequence={playSequence ? highlight!.seq : undefined}
            dwellMs={seqDwell}
            sequenceSide={highlight?.side}
          />
        </div>

        <Ticker lines={lines} emphasis={dangerMoment} />

        {/* ── 골 드라마: 플래시 + 대형 타이포 + 득점자 배너 + (스코어버그 펄스) ──
            피치를 가리지 않는 순간 이펙트(pointer-events 없음). key=분으로 골마다 재발동. */}
        {goalDrama && (
          <div
            key={`drama-${displayMinute}`}
            className={`ms-drama ms-drama--${conceded ? 'concede' : 'score'}`}
            aria-hidden="true"
          >
            <span className="ms-drama__flash" />
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

        {/* ── 하단 바: 킥오프(pre) / 풀타임 스탯·액션 — 피치 위가 아니라 아래에 확장 ── */}
        {phase === 'pre' && (
          <div className="ms-bottom">
            <div className="ms-bottom__info">
              <span className="ms-bottom__title">{home.name.ko} vs {away.name.ko}</span>
              {referenceScore && (
                <span className="ms-bottom__note">참고 · 실제 역사 {referenceScore[0]}-{referenceScore[1]}</span>
              )}
            </div>
            <button type="button" className="ms-btn ms-btn--primary" onClick={handleKickoff}>킥오프</button>
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

const STAT_ROWS: { key: keyof SideStats; label: string; fmt: (n: number) => string }[] = [
  { key: 'possession', label: '점유율', fmt: n => `${Math.round(n)}%` },
  { key: 'shots', label: '슛', fmt: n => `${Math.round(n)}` },
  { key: 'shotsOnTarget', label: '유효슛', fmt: n => `${Math.round(n)}` },
  { key: 'xg', label: 'xG', fmt: n => n.toFixed(2) },
  { key: 'fouls', label: '파울', fmt: n => `${Math.round(n)}` },
  { key: 'corners', label: '코너', fmt: n => `${Math.round(n)}` },
]

function StatsTable({ home, away }: { home: SideStats; away: SideStats }) {
  return (
    <table className="ms-stats">
      <tbody>
        {STAT_ROWS.map(({ key, label, fmt }) => (
          <tr key={key}>
            <td className="ms-stats__home">{fmt(home[key])}</td>
            <th className="ms-stats__label" scope="row">{label}</th>
            <td className="ms-stats__away">{fmt(away[key])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
