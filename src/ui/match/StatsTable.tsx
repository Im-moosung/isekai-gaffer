import type { SideStats } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { possessionView } from './stat-display'
import './StatsTable.css'

/** 풀타임/하프타임 리포트 행 — **방송 표준 순서**다.
 *  점유율 → 슛 → 유효슛 → xG → 파울 → 코너. 순서를 바꾸지 마라(시청자 기대 순서). */
const STAT_ROWS: { key: keyof SideStats; label: string; fmt: (n: number) => string }[] = [
  { key: 'possession', label: '점유율', fmt: n => `${Math.round(n)}%` },
  { key: 'shots', label: '슛', fmt: n => `${Math.round(n)}` },
  { key: 'shotsOnTarget', label: '유효슛', fmt: n => `${Math.round(n)}` },
  { key: 'xg', label: 'xG', fmt: n => n.toFixed(2) },
  { key: 'fouls', label: '파울', fmt: n => `${Math.round(n)}` },
  { key: 'corners', label: '코너', fmt: n => `${Math.round(n)}` },
]

/** 두 팀 합을 100%로 정규화한 홈 몫. 합이 0이면 반반(0을 색칠하지 않기 위한 중립). */
function share(h: number, a: number): number {
  const total = h + a
  return total <= 0 ? 50 : (h / total) * 100
}

/**
 * 풀타임·하프타임 기록 리포트.
 *
 * 예전에는 3열 텍스트 표 + 헤어라인뿐이었고, 숫자에 팀 색(홈 빨강 / 원정 파랑)을
 * 칠했다. **빨간 숫자는 "나쁨"으로 읽힌다** — 소속은 좌우 위치와 상단 킷 칩이
 * 이미 말하고 있으므로 숫자는 전부 --t-hi다.
 *
 * 각 행은 두 팀 합을 100%로 정규화한 **대칭 발산 바** 하나 + 바 바깥의 숫자 둘이다
 * (Broadage 방송 규격 "numbers and bars", "relative for both team").
 */
export function StatsTable({ home, away, homeCode, awayCode }: {
  home: SideStats
  away: SideStats
  /** 킷 칩 라벨. 미지정 시 칩 행을 생략한다(기존 호출부 호환). */
  homeCode?: string
  awayCode?: string
}) {
  return (
    <div className="ms-stats" role="table" aria-label="경기 기록">
      {homeCode && awayCode && (
        <div className="ms-stats__legend" role="row">
          <span className="ms-stats__team" role="columnheader">
            <span className="kit-strip kit-strip--us" aria-hidden="true" />
            <span className="num">{homeCode}</span>
          </span>
          <span className="ms-stats__team ms-stats__team--away" role="columnheader">
            <span className="num">{awayCode}</span>
            <span className="kit-strip kit-strip--them" aria-hidden="true" />
          </span>
        </div>
      )}
      {STAT_ROWS.map(({ key, label, fmt }) => {
        const pct = share(home[key], away[key])
        return (
          <div className="ms-stats__row" key={key} role="row">
            <span className="ms-stats__val num" role="cell">{fmt(home[key])}</span>
            <span className="ms-stats__mid">
              <span className="ms-stats__label" role="rowheader">{label}</span>
              <span className="ms-stats__bar">
                {/* 데이터 바인딩 폭(%)만 인라인 — 파생 좌표 예외. 색은 토큰. */}
                <span className="ms-stats__bar-us" style={{ width: `${pct.toFixed(1)}%` }} />
                <span className="ms-stats__bar-them" style={{ width: `${(100 - pct).toFixed(1)}%` }} />
              </span>
            </span>
            <span className="ms-stats__val num" role="cell">{fmt(away[key])}</span>
          </div>
        )
      })}
    </div>
  )
}

/** 경기 중 패널에 쓰는 행 — 리포트보다 한 줄(패스 성공률) 많다. */
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
  return share(h, a)
}

/**
 * 워룸(전술 센터)·작전판 공용 팀 경기 스탯 패널.
 *
 * ★ 아직 한 분도 진행되지 않았으면 스탯이 전부 0이다 — 0을 그대로 늘어놓으면
 *   "숫자가 있는데 아무 의미가 없는" 화면이 되므로 수치 대신 안내 문구만 둔다.
 *   판정은 phase가 아니라 **engine.minute**로 한다: 조별 경기는 전반이 스크립트로
 *   재현돼 phase==='pre'인데도 이미 45분치 기록(근사)이 들어 있다.
 *
 * ★ 점유율은 stat-display.possessionView를 거친다 — 초반 표본에서 0/100으로 튀는 값을
 *   그대로 보여주면 패널 전체의 신뢰가 무너진다(사용자 지적 "2분에 점유율 100%").
 */
export function MatchStatsPanel() {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  if (!engine) return null

  const homeCode = engine.home.team.fifaCode
  const awayCode = engine.away.team.fifaCode

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

  const poss = possessionView(engine.minute, h.possession, a.possession)

  return (
    <section className="mst" aria-label="경기 스탯">
      <header className="mst__head">
        <h4 className="mst__title">경기 스탯</h4>
        {/* 조별 경기의 킥오프 전 화면은 '전반 재현' 결과를 보고 있는 것이다 — 그렇게 적는다. */}
        <span className="mst__minute num">{phase === 'pre' ? `전반 재현 · ${engine.minute}'` : `${engine.minute}'`}</span>
      </header>
      <div className="mst__teams">
        <span className="mst__code num">
          <span className="kit-strip kit-strip--us" aria-hidden="true" />
          {homeCode}
        </span>
        <span className="mst__code mst__code--away num">
          {awayCode}
          <span className="kit-strip kit-strip--them" aria-hidden="true" />
        </span>
      </div>
      <ul className="mst__rows">
        {PANEL_ROWS.map(({ key, label, fmt, bar }) => {
          const isPoss = key === 'possession'
          const pct = isPoss ? poss.usBar : homeShare(h[key], a[key], bar)
          return (
            <li key={key} className="mst__row">
              <span className="mst__val num">{isPoss ? poss.usLabel : fmt(h[key])}</span>
              <span className="mst__mid">
                <span className="mst__label">{label}</span>
                <span className={`mst__bar${isPoss && poss.suppressed ? ' mst__bar--muted' : ''}`}>
                  {/* 데이터 바인딩 폭(%)만 인라인 — 파생 좌표 예외. 색은 토큰. */}
                  <span className="mst__bar-home" style={{ width: `${pct.toFixed(1)}%` }} />
                </span>
              </span>
              <span className="mst__val num">{isPoss ? poss.themLabel : fmt(a[key])}</span>
            </li>
          )
        })}
      </ul>
      <p className="mst__caption">{poss.caption}</p>
    </section>
  )
}
