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
  /** 득점 순간 스코어 펄스(골 드라마 연동). */
  pulse?: boolean
  /** 컨텍스트 스트립 문구(대회·라운드). 방송 스코어버그의 최상단 한 줄. */
  context?: string
}

/**
 * 방송 스코어버그 — 2026 월드피드 구조의 **3단 데크**.
 *
 *   ┌ 컨텍스트 스트립 (대회 · 라운드)      ← --fs-xs, --t-low
 *   ├ ▌KOR   3 : 2   CZE▐                 ← 킷 스트립 3px + 코드 + 스코어
 *   └                    ● LIVE 67'       ← 시계 pill(다른 배경색)
 *
 * ★ 시계를 본체와 물리적으로 분리한 이유: 시계는 초 단위, 스코어는 이벤트 단위로
 *   갱신 주기가 다르다. 같은 컨테이너에 두면 시계가 바뀔 때마다 눈이 스코어 영역까지
 *   다시 훑는다. 방송이 시계를 별도 슬래브에 두는 것도 같은 이유다.
 * ★ 킷 스트립 색(--team-us/--team-them)은 피치 위 도트 색과 같은 토큰이다. 이 일치가
 *   깨지면 스코어버그가 피치를 설명하지 못한다.
 * ★ 스코어 숫자 자체는 애니메이션하지 않는다(펄스는 컨테이너에만).
 */
export function Scorebug({
  home, away, score, minute, live, fastForward, pulse, context = 'FIFA 월드컵 2026',
}: ScorebugProps) {
  return (
    <div className="bc-scorebug" role="status" aria-label="스코어">
      <div className="bc-scorebug__ctx">{context}</div>

      <div className={`bc-scorebug__deck${pulse ? ' bc-scorebug__score--pulse' : ''}`}>
        <TeamChip team={home} side="home" />
        <div className="bc-scorebug__score">
          <span className="bc-scorebug__num num">{score[0]}</span>
          <span className="bc-scorebug__dash">:</span>
          <span className="bc-scorebug__num num">{score[1]}</span>
        </div>
        <TeamChip team={away} side="away" />
      </div>

      <div className="bc-scorebug__meta">
        {live && (
          <span className="bc-scorebug__live">
            <span className="live-dot bc-scorebug__live-dot" aria-hidden="true" />
            LIVE
          </span>
        )}
        <span className={`bc-scorebug__clock num${fastForward ? ' bc-scorebug__clock--ff' : ''}`}>
          {minute}&apos;
        </span>
      </div>
    </div>
  )
}

/** 팀 칩 — 킷 스트립 3px + FIFA 코드. 스트립은 홈이 왼쪽, 원정이 오른쪽 바깥으로 간다. */
function TeamChip({ team, side }: { team: Team; side: 'home' | 'away' }) {
  const strip = (
    <span
      className={`kit-strip kit-strip--${side === 'home' ? 'us' : 'them'}`}
      aria-hidden="true"
    />
  )
  return (
    <div className={`bc-chip bc-chip--${side}`}>
      {side === 'home' && strip}
      <span className="bc-chip__code num">{team.fifaCode}</span>
      {side === 'away' && strip}
    </div>
  )
}
