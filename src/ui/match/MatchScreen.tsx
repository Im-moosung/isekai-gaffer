import { useState, useEffect } from 'react'
import type { Team, SideStats, TacticState, MatchEvent } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { commentate } from '../../game/commentary'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { PitchView } from '../pitch/PitchView'
import { ConsolePanel } from '../console/ConsolePanel'
import { SubPanel } from '../console/SubPanel'
import { TeamTalk } from './TeamTalk'
import { ShootoutPanel } from './ShootoutPanel'
import './match.css'

// 유저는 홈팀 감독. 콘솔/교체는 home 고정.
const SIDE = 'home' as const

interface MatchScreenProps {
  home: Team
  away: Team
  seed: number
  /** 라인업 화면에서 확정한 홈 전술(캠페인). 미지정 시 엔진 기본 XI. */
  initialTactics?: TacticState
  /** 조별 경기: 전반 재현 스크립트(전반은 시뮬 대신 이 결과를 사용). */
  firstHalfScript?: { events: MatchEvent[]; score: [number, number] }
  /** 체력 이월: 홈 선수별 시작 스태미나 덮어쓰기(캠페인). */
  staminaOverride?: Record<string, number>
  /** 조별 경기 참고 표시용 실제 스코어 [한국, 상대]. */
  referenceScore?: [number, number]
  /** 토너먼트: 무승부 시 승부차기로 승자를 가려야 한다. */
  requireWinner?: boolean
  /** 캠페인: 경기 종료 시 결과 콜백. 미지정 시 데모 동작([다시 보기]). */
  onMatchEnd?(score: [number, number], staminaByPlayer: Record<string, number>, shootout?: [number, number]): void
}

/** 경기 화면 조립 — 좌 경기 뷰(스코어버그·피치·티커) / 우 감독 콘솔.
 *  엔진은 순간 계산(playTo), UI는 displayMinute 기준 재생 루프로 이벤트를 누적 노출한다.
 *  재생 타이밍은 setInterval 고정 간격만 사용(Math.random·Date 금지).
 *  onMatchEnd 유무로 데모/캠페인 동작을 분기(props 하위호환). */
export function MatchScreen({
  home, away, seed,
  initialTactics, firstHalfScript, staminaOverride, referenceScore, requireWinner, onMatchEnd,
}: MatchScreenProps) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const displayMinute = useMatchStore(s => s.displayMinute)
  const pendingDecision = useMatchStore(s => s.pendingDecision)
  const startMatch = useMatchStore(s => s.startMatch)
  const playTo = useMatchStore(s => s.playTo)
  const tickDisplay = useMatchStore(s => s.tickDisplay)
  const resumeFromDecision = useMatchStore(s => s.resumeFromDecision)
  const reset = useMatchStore(s => s.reset)

  const [tab, setTab] = useState<'console' | 'sub'>('console')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [shootoutOpen, setShootoutOpen] = useState(false)

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

  // 재생 여부: 표시 분이 엔진 계산 분에 못 미치면 재생 중.
  const replaying = !!engine && displayMinute < engine.minute
  const caughtUp = !!engine && displayMinute >= engine.minute

  // 재생 루프 — 200ms 고정 간격 tickDisplay. 도달 시/언마운트/phase 변경 시 정리.
  useEffect(() => {
    if (!replaying) return
    const id = setInterval(() => tickDisplay(), 200)
    return () => clearInterval(id)
  }, [replaying, phase, engine, displayMinute, tickDisplay])

  // decision 오버레이 노출 중 20초 카운트다운(1초 간격). 만료 시 자동 재개.
  const decisionOpen = phase === 'decision' && caughtUp
  useEffect(() => {
    if (!decisionOpen) { setCountdown(null); return }
    setCountdown(pendingDecision?.timeLimitSec ?? 20)
    const id = setInterval(() => setCountdown(c => (c == null ? c : Math.max(0, c - 1))), 1000)
    return () => clearInterval(id)
  }, [decisionOpen, pendingDecision])

  useEffect(() => {
    if (decisionOpen && countdown === 0) handleResume()
    // countdown 만료만 트리거 — 나머지 의존은 안정적.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, decisionOpen])

  function handleResume() {
    // "그대로 간다" 클릭과 카운트다운 만료가 겹치면 resumeFromDecision이 이중 호출되어
    // 두 번째 호출이 throw(엔진 가드)한다. decision 상태가 아니면 조기 반환.
    if (useMatchStore.getState().phase !== 'decision') return
    resumeFromDecision()
    playTo(90)
  }

  // 토너먼트 무승부 → 승부차기 진입 필요 (캠페인 한정).
  const needsShootout = !!onMatchEnd && !!requireWinner && !!engine && engine.score[0] === engine.score[1]

  // 경기 결과를 캠페인으로 반환한다(홈 종료 스태미나 포함).
  function finishMatch(shootout?: [number, number]) {
    if (!engine || !onMatchEnd) return
    onMatchEnd([engine.score[0], engine.score[1]], { ...engine.home.staminaByPlayer }, shootout)
  }

  if (!engine) return <div className="ms-root ms-root--empty" />

  // displayMinute까지 도달한 이벤트만 순서대로 노출.
  const shown = engine.events.filter(e => e.minute <= displayMinute)
  const lines = shown.map(e => commentate(e, home, away))
  const lastEvent = shown[shown.length - 1]
  // 표시 스코어는 재생된 골 이벤트에서 파생 — engine.score(세그먼트 최종)를 그대로 쓰면
  // 재생 중 최종 스코어가 미리 노출된다(스포일러). Ticker/PitchView와 동일 필터.
  const shownScore: [number, number] = [0, 0]
  for (const e of shown) {
    if (e.type === 'goal') shownScore[e.teamId === home.id ? 0 : 1] += 1
  }

  return (
    <div className="ms-root">
      <div className="ms-stage">
        <Scorebug
          home={home}
          away={away}
          score={shownScore}
          minute={displayMinute}
          live={replaying}
        />
        <div className="ms-pitch-wrap">
          <PitchView state={engine} lastEvent={lastEvent} />
        </div>
        <Ticker lines={lines} />

        {phase === 'pre' && (
          <Overlay title={onMatchEnd ? `${home.name.ko} vs ${away.name.ko}` : '데모 경기'}>
            <p className="ms-overlay__note">{home.name.ko} vs {away.name.ko}</p>
            {referenceScore && (
              <p className="ms-overlay__note">
                참고 · 실제 역사 {referenceScore[0]}-{referenceScore[1]}
              </p>
            )}
            <button type="button" className="ms-btn ms-btn--primary" onClick={() => playTo(45)}>
              킥오프
            </button>
          </Overlay>
        )}

        {phase === 'halftime' && caughtUp && (
          <Overlay title="전반 종료">
            <TeamTalk side={SIDE} />
            <p className="ms-overlay__note">콘솔에서 개입하세요</p>
            <button type="button" className="ms-btn ms-btn--primary" onClick={() => playTo(90)}>
              후반 시작
            </button>
          </Overlay>
        )}

        {decisionOpen && pendingDecision && (
          <Overlay title={pendingDecision.title}>
            <p className="ms-overlay__count" aria-label="남은 시간">
              {countdown ?? pendingDecision.timeLimitSec}초
            </p>
            <p className="ms-overlay__note">콘솔·교체로 지시하거나 그대로 진행하세요</p>
            <button type="button" className="ms-btn ms-btn--primary" onClick={handleResume}>
              그대로 간다
            </button>
          </Overlay>
        )}

        {phase === 'fulltime' && caughtUp && shootoutOpen && (
          <Overlay title="승부차기">
            <ShootoutPanel
              home={home}
              away={away}
              seed={seed}
              onDone={result => finishMatch(result)}
            />
          </Overlay>
        )}

        {phase === 'fulltime' && caughtUp && !shootoutOpen && (
          <Overlay title="경기 종료">
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
              <button
                type="button"
                className="ms-btn ms-btn--primary"
                onClick={() => setShootoutOpen(true)}
              >
                승부차기로
              </button>
            ) : (
              <button
                type="button"
                className="ms-btn ms-btn--primary"
                onClick={() => finishMatch()}
              >
                결과 확정
              </button>
            )}
          </Overlay>
        )}
      </div>

      <aside className="ms-side">
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
      </aside>
    </div>
  )
}

function Overlay({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ms-overlay" role="dialog" aria-label={title}>
      <div className="ms-overlay__card">
        <h2 className="ms-overlay__title">{title}</h2>
        {children}
      </div>
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
