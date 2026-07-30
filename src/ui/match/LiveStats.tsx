import type { SideStats } from '../../engine/types'
import { countLine, possessionView } from './stat-display'

interface LiveStatsProps {
  us: SideStats
  them: SideStats
  minute: number
  usCode: string
  themCode: string
}

/**
 * 라이브 스탯 HUD — 재생 중 좌하단 "game assist" 슬롯.
 *
 * 관전 중 감독이 답을 알아야 하는 질문은 둘뿐이다: "우리가 공을 갖고 있나",
 * "우리가 더 만들고 있나". 그 둘만 한 덩어리로 답한다 — 점유율 단일 바 + 누적량 한 줄.
 * 나머지 기록은 정지·하프타임(읽는 모드)의 작전판 대시보드가 담당한다.
 *
 * 표시 규칙은 stat-display.ts(순수 함수·단위 테스트)가 소유한다. 특히 초반 표본 억제 —
 * "2분에 점유율 100%"는 엔진이 아니라 표시 규칙의 문제다.
 */
export function LiveStats({ us, them, minute, usCode, themCode }: LiveStatsProps) {
  const poss = possessionView(minute, us.possession, them.possession)
  const counts = countLine([
    { label: '슛', us: Math.round(us.shots), them: Math.round(them.shots) },
    { label: '유효', us: Math.round(us.shotsOnTarget), them: Math.round(them.shotsOnTarget) },
  ])
  return (
    <section className="ms-hud" aria-label="라이브 스탯">
      <div className="ms-hud__head">
        <span className="ms-hud__code num">{usCode}</span>
        <span className="ms-hud__title">점유율</span>
        <span className="ms-hud__code num">{themCode}</span>
      </div>
      <div className="statbar">
        <span className="statbar__val num">{poss.usLabel}</span>
        {/* 데이터 바인딩 폭(%)만 인라인 — 파생 좌표 예외. 색은 전부 토큰. */}
        <span className={`statbar__track${poss.suppressed ? ' statbar__track--muted' : ''}`}>
          <span className="statbar__us" style={{ width: `${poss.usBar}%` }} />
          <span className="statbar__them" style={{ width: `${100 - poss.usBar}%` }} />
        </span>
        <span className="statbar__val num">{poss.themLabel}</span>
      </div>
      <p className="ms-hud__counts num">{counts}</p>
      <p className="ms-hud__caption">{poss.caption}</p>
    </section>
  )
}
