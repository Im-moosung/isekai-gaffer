import type { SideStats } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import './StatsTable.css'

/** 풀타임 표에 쓰는 행 정의(홈 | 라벨 | 원정). */
const STAT_ROWS: { key: keyof SideStats; label: string; fmt: (n: number) => string }[] = [
  { key: 'possession', label: '점유율', fmt: n => `${Math.round(n)}%` },
  { key: 'shots', label: '슛', fmt: n => `${Math.round(n)}` },
  { key: 'shotsOnTarget', label: '유효슛', fmt: n => `${Math.round(n)}` },
  { key: 'xg', label: 'xG', fmt: n => n.toFixed(2) },
  { key: 'fouls', label: '파울', fmt: n => `${Math.round(n)}` },
  { key: 'corners', label: '코너', fmt: n => `${Math.round(n)}` },
]

/** 풀타임 스탯 표 — 기존 마크업·클래스(.ms-stats, match.css) 그대로. */
export function StatsTable({ home, away }: { home: SideStats; away: SideStats }) {
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

/** 경기 중 패널에 쓰는 행 — 풀타임 표보다 한 줄(패스 성공률) 많고 막대 비교가 붙는다. */
const PANEL_ROWS: {
  key: keyof SideStats
  label: string
  fmt: (n: number) => string
  /** 막대 비율의 기준: 'share'=두 팀 합 대비 / 'abs'=값 그대로(%) */
  bar: 'share' | 'abs'
}[] = [
  { key: 'possession', label: '점유율', fmt: n => `${Math.round(n)}%`, bar: 'abs' },
  { key: 'passAccuracy', label: '패스 성공률', fmt: n => `${Math.round(n)}%`, bar: 'abs' },
  { key: 'shots', label: '슛', fmt: n => `${Math.round(n)}`, bar: 'share' },
  { key: 'shotsOnTarget', label: '유효슛', fmt: n => `${Math.round(n)}`, bar: 'share' },
  { key: 'xg', label: 'xG', fmt: n => n.toFixed(2), bar: 'share' },
  { key: 'corners', label: '코너', fmt: n => `${Math.round(n)}`, bar: 'share' },
  { key: 'fouls', label: '파울', fmt: n => `${Math.round(n)}`, bar: 'share' },
]

/** 홈 몫(0~100). share는 합 대비 비율, abs는 값 자체를 %로 읽는다. 합이 0이면 반반. */
function homeShare(h: number, a: number, mode: 'share' | 'abs'): number {
  if (mode === 'abs') return Math.max(0, Math.min(100, h))
  const total = h + a
  return total <= 0 ? 50 : (h / total) * 100
}

/**
 * 워룸(전술 센터)·작전판 공용 팀 경기 스탯 패널.
 *
 * ★ 아직 한 분도 진행되지 않았으면 스탯이 전부 0이다 — 0을 그대로 늘어놓으면
 *   "숫자가 있는데 아무 의미가 없는" 화면이 되므로 수치 대신 안내 문구만 둔다.
 *   판정은 phase가 아니라 **engine.minute**로 한다: 조별 경기는 전반이 스크립트로
 *   재현돼 phase==='pre'인데도 이미 45분치 기록(근사)이 들어 있다. phase로 끊으면
 *   그 기록을 "경기 전"이라며 감추게 된다.
 *
 * 스토어 바인딩이라 어느 화면에 꽂아도 동작한다. 세로 길이가 판정선인 화면
 * (전술 센터 1440px 무스크롤)에 들어가므로 행 높이를 최소로 유지한다.
 */
export function MatchStatsPanel() {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  if (!engine) return null

  const homeCode = engine.home.team.fifaCode
  const awayCode = engine.away.team.fifaCode

  // 패스 성공률은 이제 엔진이 분마다 실제로 집계한다(simulate.ts trackPasses) —
  // 시즌 평균 폴백과 각주를 걷어냈다. 킥오프 전(minute 0)에는 아래에서 통째로 감춘다.
  const h = engine.stats[0]
  const a = engine.stats[1]

  if (engine.minute <= 0) {
    return (
      <section className="mst" aria-label="경기 스탯">
        <header className="mst__head">
          <h4 className="mst__title">경기 스탯</h4>
          <span className="mst__minute">경기 전</span>
        </header>
        <p className="mst__empty">킥오프 후 집계됩니다 — 아직 기록이 없습니다.</p>
      </section>
    )
  }

  return (
    <section className="mst" aria-label="경기 스탯">
      <header className="mst__head">
        <h4 className="mst__title">경기 스탯</h4>
        {/* 조별 경기의 킥오프 전 화면은 '전반 재현' 결과를 보고 있는 것이다 — 그렇게 적는다. */}
        <span className="mst__minute">{phase === 'pre' ? `전반 재현 · ${engine.minute}'` : `${engine.minute}'`}</span>
      </header>
      <div className="mst__teams">
        <span className="mst__code mst__code--home">{homeCode}</span>
        <span className="mst__code mst__code--away">{awayCode}</span>
      </div>
      <ul className="mst__rows">
        {PANEL_ROWS.map(({ key, label, fmt, bar }) => {
          const pct = homeShare(h[key], a[key], bar)
          return (
            <li key={key} className="mst__row">
              <span className="mst__val mst__val--home">{fmt(h[key])}</span>
              <span className="mst__mid">
                <span className="mst__label">{label}</span>
                <span className="mst__bar">
                  {/* 데이터 바인딩 폭(%)만 인라인 — pitch 기하 예외와 동일 취급. 색은 토큰. */}
                  <span className="mst__bar-home" style={{ width: `${pct.toFixed(1)}%` }} />
                </span>
              </span>
              <span className="mst__val mst__val--away">{fmt(a[key])}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
