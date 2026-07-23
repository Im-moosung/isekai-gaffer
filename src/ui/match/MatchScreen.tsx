import { useState, useEffect } from 'react'
import type { Team, SideStats } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { commentate } from '../../game/commentary'
import { Scorebug } from '../broadcast/Scorebug'
import { Ticker } from '../broadcast/Ticker'
import { PitchView } from '../pitch/PitchView'
import { ConsolePanel } from '../console/ConsolePanel'
import { SubPanel } from '../console/SubPanel'
import './match.css'

// 유저는 홈팀 감독. 콘솔/교체는 home 고정.
const SIDE = 'home' as const

/** 경기 화면 조립 — 좌 경기 뷰(스코어버그·피치·티커) / 우 감독 콘솔.
 *  엔진은 순간 계산(playTo), UI는 displayMinute 기준 재생 루프로 이벤트를 누적 노출한다.
 *  재생 타이밍은 setInterval 고정 간격만 사용(Math.random·Date 금지). */
export function MatchScreen({ home, away, seed }: { home: Team; away: Team; seed: number }) {
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

  // 경기 초기화(마운트/픽스처 변경 시). 엔진은 pre 상태로 준비.
  useEffect(() => { startMatch(home, away, seed) }, [home, away, seed, startMatch])

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
    resumeFromDecision()
    playTo(90)
  }

  if (!engine) return <div className="ms-root ms-root--empty" />

  // displayMinute까지 도달한 이벤트만 순서대로 노출.
  const shown = engine.events.filter(e => e.minute <= displayMinute)
  const lines = shown.map(e => commentate(e, home, away))
  const lastEvent = shown[shown.length - 1]

  return (
    <div className="ms-root">
      <div className="ms-stage">
        <Scorebug
          home={home}
          away={away}
          score={engine.score}
          minute={displayMinute}
          live={phase === 'playing'}
        />
        <div className="ms-pitch-wrap">
          <PitchView state={engine} lastEvent={lastEvent} />
        </div>
        <Ticker lines={lines} />

        {phase === 'pre' && (
          <Overlay title="데모 경기">
            <p className="ms-overlay__note">{home.name.ko} vs {away.name.ko}</p>
            <button type="button" className="ms-btn ms-btn--primary" onClick={() => playTo(45)}>
              킥오프
            </button>
          </Overlay>
        )}

        {phase === 'halftime' && caughtUp && (
          <Overlay title="전반 종료">
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

        {phase === 'fulltime' && caughtUp && (
          <Overlay title="경기 종료">
            <div className="ms-final">
              <span className="ms-final__code">{home.fifaCode}</span>
              <span className="ms-final__score">{engine.score[0]} : {engine.score[1]}</span>
              <span className="ms-final__code">{away.fifaCode}</span>
            </div>
            <StatsTable home={engine.stats[0]} away={engine.stats[1]} />
            <button
              type="button"
              className="ms-btn ms-btn--primary"
              onClick={() => { reset(); startMatch(home, away, seed) }}
            >
              다시 보기
            </button>
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
