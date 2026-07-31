// src/ui/campaign/JourneyLadder.tsx
// 캠페인 여정 사다리 — 조별 3경기 → 진출 관문 → 32강~결승 5경기를 한 줄기로 보여준다.
// 일반 32강 브래킷이 아니라 "한국 한 팀의 경로"만 그리는 이유: 우리 캠페인은 다른 조의
// 대진을 시뮬레이션하지 않는다. 없는 데이터를 그리면 거짓 정보가 된다.
// 탈락하면 남은 칸이 빈 채로 남는다 — "여기서 멈췄다"가 화면에 남는 것이 대체역사 훅이다.
import { useState } from 'react'
import { GROUP_MATCHES } from '../../data/groupStage'
import { loadTeam } from '../../data/loader'
import type { TeamId } from '../../data/loader'
import type { CampaignStage, MatchRecord } from '../../game/campaignStore'

type Outcome = 'W' | 'D' | 'L'

/** 기록 한 건의 승/무/패(토너먼트 무승부는 승부차기로 확정). */
function outcomeOf(r: MatchRecord): Outcome {
  const [a, b] = r.score
  if (a > b) return 'W'
  if (a < b) return 'L'
  if (r.shootout) return r.shootout[0] > r.shootout[1] ? 'W' : 'L'
  return 'D'
}

const OUTCOME_KO: Record<Outcome, string> = { W: '승', D: '무', L: '패' }
/** 역사 대비 판정을 위한 결과 서열. */
const OUTCOME_RANK: Record<Outcome, number> = { W: 2, D: 1, L: 0 }

function scoreOutcome(kor: number, opp: number): Outcome {
  return kor > opp ? 'W' : kor < opp ? 'L' : 'D'
}

/** "2-1" / 승부차기는 "1-1 (4-3)". */
function scoreLabel(r: MatchRecord): string {
  const base = `${r.score[0]}-${r.score[1]}`
  return r.shootout ? `${base} (${r.shootout[0]}-${r.shootout[1]})` : base
}

interface LadderRow {
  stage: Exclude<CampaignStage, 'ended'>
  label: string
  /** 조별 경기 인덱스(실제 역사 대비용). 토너먼트는 undefined. */
  groupIndex?: 0 | 1 | 2
}

const ROWS: LadderRow[] = [
  { stage: 'group1', label: '조별 1차전', groupIndex: 0 },
  { stage: 'group2', label: '조별 2차전', groupIndex: 1 },
  { stage: 'group3', label: '조별 3차전', groupIndex: 2 },
  { stage: 'r32', label: '32강' },
  { stage: 'r16', label: '16강' },
  { stage: 'qf', label: '8강' },
  { stage: 'sf', label: '4강' },
  { stage: 'final', label: '결승' },
]

const STAGE_ORDER: CampaignStage[] = ROWS.map(r => r.stage)

export interface JourneyLadderProps {
  stage: CampaignStage
  records: MatchRecord[]
  groupRank: 1 | 2 | 3 | null
  ending: { reached: CampaignStage; champion: boolean } | null
  /** 현재 스테이지 상대. 토너먼트는 대진에 따라 갈리므로 확정된 것만 넘긴다. */
  currentOpponentId?: TeamId | null
  /** 엔딩 화면용 축약 배치(캡션 유지, 여백 축소). */
  compact?: boolean
  /** 토너먼트 5칸을 기본으로 접는다(허브 전용). 결과가 생기면 자동으로 펼친다. */
  collapsible?: boolean
}

/** 여정 사다리. 허브와 엔딩이 같은 컴포넌트를 공유한다 — 두 화면의 여정 표기가 어긋나지 않게. */
export function JourneyLadder({
  stage, records, groupRank, ending, currentOpponentId, compact, collapsible,
}: JourneyLadderProps) {
  const [userExpanded, setUserExpanded] = useState(false)
  const byStage = new Map<CampaignStage, MatchRecord>()
  for (const r of records) byStage.set(r.stage, r)

  // 토너먼트 5칸이 전부 "상대 미정 —"이면 정보 밀도가 0인 행이 화면 절반을 먹는다(H-5).
  // 다만 접기 자체는 FM25가 저지른 실수라 기본만 접고 1클릭으로 펼친다.
  // 조별을 통과했거나 토너먼트 기록·엔딩이 생기면 접을 이유가 사라지므로 자동 전개한다.
  const tournamentLive =
    !!ending
    || stage === 'ended'
    || STAGE_ORDER.indexOf(stage) >= 3
    || records.some(r => STAGE_ORDER.indexOf(r.stage) >= 3)
  const collapsed = !!collapsible && !tournamentLive && !userExpanded

  // 탈락 지점: 이 인덱스 뒤의 칸은 "치르지 못한 경기"로 비워 둔다.
  const cutIdx = ending && !ending.champion ? STAGE_ORDER.indexOf(ending.reached) : -1

  const gateState: 'pending' | 'pass' | 'fail' =
    groupRank === null ? 'pending' : groupRank === 3 ? 'fail' : 'pass'
  const gateText =
    gateState === 'pending' ? '조 2위 이상 진출'
      : gateState === 'fail' ? `조 ${groupRank}위 · 토너먼트 진출 실패`
        : `조 ${groupRank}위 · 토너먼트 진출`

  const renderRow = (row: LadderRow, i: number) => {
    const rec = byStage.get(row.stage)
    const cut = cutIdx >= 0 && i > cutIdx
    const isCurrent = !ending && row.stage === stage
    const oc = rec ? outcomeOf(rec) : null

    // 상대: 기록 > 조별 고정 대진 > 현재 스테이지 확정 상대 > 미정
    let oppName = '상대 미정'
    let oppUnknown = true
    const oppId: TeamId | null =
      rec?.opponentId
      ?? (row.groupIndex !== undefined ? GROUP_MATCHES[row.groupIndex].opponent : null)
      ?? (isCurrent ? currentOpponentId ?? null : null)
    if (oppId && !cut) {
      oppName = loadTeam(oppId).name.ko
      oppUnknown = false
    }
    if (cut) oppName = '—'

    // 실제 역사 대비: 조별 3경기만 기준선이 있다(리서치 🟢 사실).
    let hist: { line: string; verdict: string | null; verdictKind: string } | null = null
    if (row.groupIndex !== undefined) {
      const real = GROUP_MATCHES[row.groupIndex].realScore
      const realOc = scoreOutcome(real[0], real[1])
      const line = `실제 역사 ${real[0]}-${real[1]} ${OUTCOME_KO[realOc]}`
      let verdict: string | null = null
      let verdictKind = 'same'
      if (oc && rec) {
        const d = OUTCOME_RANK[oc] - OUTCOME_RANK[realOc]
        if (d > 0) { verdict = '역사를 넘었다'; verdictKind = 'over' }
        else if (d < 0) { verdict = '역사에 미치지 못했다'; verdictKind = 'under' }
        else {
          // 승패가 같아도 점수차는 다를 수 있다. 실제 2-1 승을 3-0으로 이겼다면
          // "같은 결과"는 심심하게 읽힌다. 단 반대 방향으로는 강등하지 않는다 —
          // 이긴 경기에 "미치지 못했다"가 붙으면 승리가 부정당하는 것처럼 읽힌다.
          const gd = rec.score[0] - rec.score[1]
          const realGd = real[0] - real[1]
          if (gd > realGd) { verdict = '역사보다 나은 결과'; verdictKind = 'over' }
          else { verdict = '역사와 같은 결과'; verdictKind = 'same' }
        }
      }
      hist = { line, verdict, verdictKind }
    }

    const cls = [
      'jl-row',
      rec ? `jl-row--done jl-row--${oc!.toLowerCase()}` : '',
      isCurrent ? 'jl-row--current' : '',
      cut ? 'jl-row--cut' : '',
      ending?.champion && row.stage === 'final' ? 'jl-row--champion' : '',
    ].filter(Boolean).join(' ')

    return (
      <li key={row.stage} className={cls} aria-current={isCurrent ? 'step' : undefined}>
        <span className="jl-row__rail" aria-hidden="true" />
        <span className="jl-row__stage">{row.label}</span>
        <span className={`jl-row__opp${oppUnknown ? ' jl-row__opp--tbd' : ''}`}>{oppName}</span>
        <span className="jl-row__result">
          {rec ? (
            <>
              <span className="jl-row__score">{scoreLabel(rec)}</span>
              <span className="jl-row__mark">{OUTCOME_KO[oc!]}</span>
            </>
          ) : cut ? (
            // 끊긴 첫 칸에만 문구를 두고 나머지는 빈 칸으로 남긴다(반복 소음 제거).
            <span className="jl-row__pending">{i === cutIdx + 1 ? '치르지 못한 경기' : '—'}</span>
          ) : isCurrent ? (
            <span className="jl-row__now">다음 경기</span>
          ) : (
            <span className="jl-row__pending">—</span>
          )}
        </span>
        {hist && (
          <span className="jl-row__hist">
            {hist.line}
            {hist.verdict && (
              <>
                {' · '}
                <b className={`jl-row__verdict jl-row__verdict--${hist.verdictKind}`}>{hist.verdict}</b>
              </>
            )}
          </span>
        )}
      </li>
    )
  }

  return (
    <section className={`jl${compact ? ' jl--compact' : ''}`} aria-label="캠페인 여정">
      {/* compact(엔딩)에서는 바깥 섹션이 이미 "최종 여정" 제목을 갖는다 — 제목을 두 번 쓰지 않는다. */}
      {!compact && (
        <div className="jl__head">
          <h3 className="jl__title">여정</h3>
          <p className="jl__sub">조별리그 3경기 · 토너먼트 5경기</p>
        </div>
      )}
      <ol className="jl__list">
        {ROWS.slice(0, 3).map((r, i) => renderRow(r, i))}
        <li className={`jl-gate jl-gate--${gateState}`}>
          <span className="jl-row__rail" aria-hidden="true" />
          <span className="jl-gate__label">진출 관문</span>
          <span className="jl-gate__text">{gateText}</span>
        </li>
        {collapsed ? (
          <li className="jl-fold">
            <span className="jl-row__rail" aria-hidden="true" />
            <span className="jl-row__stage">토너먼트</span>
            <span className="jl-fold__text">5경기 · 조별리그를 통과해야 대진이 정해진다</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm jl-fold__toggle"
              aria-expanded="false"
              onClick={() => setUserExpanded(true)}
            >
              펼치기
            </button>
          </li>
        ) : (
          ROWS.slice(3).map((r, i) => renderRow(r, i + 3))
        )}
      </ol>
      {collapsible && !collapsed && !tournamentLive && (
        <button
          type="button"
          className="btn btn--ghost btn--sm jl__collapse"
          aria-expanded="true"
          onClick={() => setUserExpanded(false)}
        >
          접기
        </button>
      )}
      {cutIdx >= 0 && (
        <p className="jl__cutnote">
          {cutIdx === 2 && groupRank === 3
            ? '조별리그에서 여정이 멈췄다. 남은 다섯 경기는 치르지 못했다.'
            // 결승 패배는 "남은 0경기"가 된다 — 여덟 칸을 다 채운 결말이므로 문장이 달라야 한다.
            : cutIdx === ROWS.length - 1
              ? '결승까지 여덟 경기를 모두 치렀다. 마지막 한 걸음에서 멈췄다.'
              : `${ROWS[cutIdx].label}에서 여정이 멈췄다. 남은 ${ROWS.length - 1 - cutIdx}경기는 치르지 못했다.`}
        </p>
      )}
      {ending?.champion && <p className="jl__cutnote jl__cutnote--champion">여덟 경기를 모두 넘어 정상에 섰다.</p>}
    </section>
  )
}
