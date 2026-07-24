import type { Team } from '../../engine/types'
import './broadcast.css'

interface ScorebugProps {
  home: Team
  away: Team
  score: [number, number]
  minute: number
  live: boolean
  /** 무사건 분 빨리감기 연출 — 분 숫자에 빠른 틱 펄스를 준다. */
  fastForward?: boolean
}

/** 방송 스코어버그 — 좌상단 고정 컴팩트 바.
 *  팀 칩 2개(국기 이모지 optional + FIFA 코드) + 가운데 스코어 + 분 표시 + LIVE 도트 펄스. */
export function Scorebug({ home, away, score, minute, live, fastForward }: ScorebugProps) {
  return (
    <div className="bc-scorebug" role="status" aria-label="스코어">
      <TeamChip team={home} side="home" />
      <div className="bc-scorebug__center">
        <div className="bc-scorebug__score">
          <span className="bc-scorebug__num">{score[0]}</span>
          <span className="bc-scorebug__dash">:</span>
          <span className="bc-scorebug__num">{score[1]}</span>
        </div>
        <div className="bc-scorebug__meta">
          {live && (
            <span className="bc-scorebug__live">
              <span className="bc-scorebug__live-dot" aria-hidden="true" />
              LIVE
            </span>
          )}
          <span className={`bc-scorebug__clock${fastForward ? ' bc-scorebug__clock--ff' : ''}`}>{minute}&apos;</span>
        </div>
      </div>
      <TeamChip team={away} side="away" />
    </div>
  )
}

function TeamChip({ team, side }: { team: Team; side: 'home' | 'away' }) {
  // Team 타입에 flag 필드가 없어 fifaCode만 사용(옵셔널 flag가 있으면 노출).
  const flag = (team as { flag?: string }).flag
  return (
    <div className={`bc-chip bc-chip--${side}`}>
      <span className={`bc-chip__dot bc-chip__dot--${side}`} aria-hidden="true" />
      {flag && <span className="bc-chip__flag" aria-hidden="true">{flag}</span>}
      <span className="bc-chip__code">{team.fifaCode}</span>
    </div>
  )
}
