import { useState, useEffect } from 'react'
import type { Team, SideStats, TacticState, MatchEvent, DecisionEntry } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import type { MomentKind } from '../../game/matchSession'
import { commentate } from '../../game/commentary'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { PitchView } from '../pitch/PitchView'
import { ConsolePanel } from '../console/ConsolePanel'
import { SubPanel } from '../console/SubPanel'
import { TeamTalk } from './TeamTalk'
import { ShootoutPanel } from './ShootoutPanel'
import { minuteDwellMs, type PlaybackSpeed } from './playback'
import './match.css'

// 유저는 홈팀 감독. 콘솔/교체는 home 고정.
const SIDE = 'home' as const

// 동적 순간 유형별 방송 배너 문구(제안 시). matchSession.DecisionMoment.title과 별개로,
// 배너에서는 감독에게 말 거는 어투로 노출한다(스펙 §17.2 방송 배너).
const MOMENT_PHRASE: Record<MomentKind, string> = {
  conceded: '실점 직후입니다',
  'momentum-lost': '흐름이 상대에게 넘어갑니다',
  scored: '득점 직후 — 더 몰아칠까요?',
  clutch: '승부의 시간입니다',
  fatigue: '주력 선수 체력이 바닥납니다',
}

// 정지·하프타임 상태별 방송 배너 문구(개입 안내). moment 제안은 별도 처리(액션 버튼 포함).
const BREAK_BANNER = '🧊 하이드레이션 브레이크 — 전술을 조정하세요'
const HALFTIME_BANNER = '전반 종료 — 팀토크와 전술 조정 후 후반을 시작하세요'
const USER_PAUSE_BANNER = '⏸ 감독 타임 — 전술 확정 시 재개'

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

/** 경기 화면 조립 — 좌 경기 뷰(스코어버그·피치·티커) / 우 감독 콘솔(개입 허브).
 *  ★ 오버레이 폐지(스펙 §17.2): 어떤 상태에서도 피치 SVG는 가려지지 않는다.
 *  킥오프·브레이크·하프타임·결정 순간·풀타임은 모두 피치 밖 요소로 표현한다 —
 *  상단 방송 배너(상태 문구+액션) + 우측 콘솔(개입 허브, 정지 시 강조·하단 [전술 확정])
 *  + 하단 바(킥오프·풀타임 스탯). 피치는 언제나 flex 영역을 채운다.
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
  const confirmTactics = useMatchStore(s => s.confirmTactics)
  const acceptMoment = useMatchStore(s => s.acceptMoment)
  const dismissMoment = useMatchStore(s => s.dismissMoment)
  const logShootoutSetup = useMatchStore(s => s.logShootoutSetup)
  const reset = useMatchStore(s => s.reset)

  const [tab, setTab] = useState<'console' | 'sub'>('console')
  const [shootoutOpen, setShootoutOpen] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(1)

  // 경기 초기화(마운트/픽스처 변경 시). 엔진은 pre 상태로 준비.
  // initialTactics/firstHalfScript/staminaOverride는 매치별로 안정 참조(App에서 memo).
  useEffect(() => {
    setShootoutOpen(false)
    startMatch(home, away, seed, {
      ...(initialTactics ? { homeTactics: initialTactics } : {}),
      ...(firstHalfScript ? { firstHalfScript } : {}),
      ...(staminaOverride ? { staminaOverride } : {}),
    })
  }, [home, away, seed, startMatch, initialTactics, firstHalfScript, staminaOverride])

  // 재생 중 = playing. 시간 정지(카운트다운 없음)는 phase가 playing이 아닐 때.
  const replaying = phase === 'playing'
  const paused = phase === 'paused-break' || phase === 'paused-user' || phase === 'paused-moment'
  // 개입 허브 강조(콘솔 발광) + 하단 [전술 확정] 노출 조건.
  const intervening = paused || phase === 'halftime'
  const halftime = phase === 'halftime'

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
      const clutch = m >= 80 && Math.abs(eng.score[0] - eng.score[1]) <= 1
      const dwell = minuteDwellMs(m, eventsAtMinute, speed, clutch)
      timer = setTimeout(() => {
        if (cancelled) return
        advanceMinute()
        schedule()
      }, dwell)
    }
    schedule()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [phase, speed, advanceMinute])

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

  // 상단 방송 배너 문구 — 상태별. 재생 중 순간 제안이 있으면 그 배너(액션 포함)가 우선.
  let bannerText: string | null = null
  if (replaying && momentPrompt) bannerText = `⚡ ${MOMENT_PHRASE[momentPrompt.kind]} — 감독 타임을 쓰시겠습니까?`
  else if (phase === 'paused-break') bannerText = BREAK_BANNER
  else if (halftime) bannerText = HALFTIME_BANNER
  else if (phase === 'paused-user' || phase === 'paused-moment') bannerText = USER_PAUSE_BANNER

  return (
    <div className="ms-root">
      <div className="ms-stage">
        <Scorebug
          home={home}
          away={away}
          score={shownScore}
          minute={displayMinute}
          live={replaying}
          fastForward={fastForward}
        />
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
          <PitchView state={engine} lastEvent={lastEvent} />
        </div>

        <Ticker lines={lines} />

        {/* ── 하단 바: 킥오프(pre) / 풀타임 스탯·액션 — 피치 위가 아니라 아래에 확장 ── */}
        {phase === 'pre' && (
          <div className="ms-bottom">
            <div className="ms-bottom__info">
              <span className="ms-bottom__title">{home.name.ko} vs {away.name.ko}</span>
              {referenceScore && (
                <span className="ms-bottom__note">참고 · 실제 역사 {referenceScore[0]}-{referenceScore[1]}</span>
              )}
            </div>
            <button type="button" className="ms-btn ms-btn--primary" onClick={kickoff}>킥오프</button>
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

      {/* ── 우: 감독 콘솔 = 개입 허브. 정지·하프타임 시 강조 테두리(발광). ── */}
      <aside className={`ms-side${intervening ? ' ms-side--hub' : ''}`}>
        {/* 하프타임: 팀토크를 콘솔 상단 카드로(피치는 계속 보임). */}
        {halftime && (
          <div className="ms-side__talk">
            <TeamTalk side={SIDE} />
          </div>
        )}
        <div className="ms-tabs" role="tablist" aria-label="감독 콘솔">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'console'}
            className={`ms-tab${tab === 'console' ? ' ms-tab--active' : ''}`}
            onClick={() => setTab('console')}
          >
            지시
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sub'}
            className={`ms-tab${tab === 'sub' ? ' ms-tab--active' : ''}`}
            onClick={() => setTab('sub')}
          >
            교체
          </button>
        </div>
        <div className="ms-side__body">
          {tab === 'console' ? <ConsolePanel side={SIDE} /> : <SubPanel side={SIDE} />}
        </div>
        {/* 콘솔 하단 고정 재개 버튼 — 모든 정지 공통. 하프타임은 [후반 시작] 라벨. */}
        {intervening && (
          <button type="button" className="ms-btn ms-btn--primary ms-side__resume" onClick={confirmTactics}>
            {halftime ? '후반 시작' : '전술 확정'}
          </button>
        )}
      </aside>
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
