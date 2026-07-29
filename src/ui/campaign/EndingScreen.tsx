import { useMemo, useState } from 'react'
import { useCampaignStore } from '../../game/campaignStore'
import type { CampaignStage, MatchRecord } from '../../game/campaignStore'
import { loadAllTeams } from '../../data/loader'
import { computeScore, submitScore, topScores } from '../../online/leaderboard'
import type { LeaderboardMode, LeaderboardRow, ScoreBreakdown } from '../../online/leaderboard'
import { sanitizeNickname } from '../../online/nickname'
import { buildEpilogue } from '../../game/pressconf'
import { JourneyLadder } from './JourneyLadder'
import './campaign.css'

const STAGE_LABEL: Record<CampaignStage, string> = {
  group1: '조별 1차전', group2: '조별 2차전', group3: '조별리그',
  r32: '32강', r16: '16강', qf: '8강', sf: '4강', final: '준우승', ended: '여정의 끝',
}

/** 점수 브레이크다운 표에 표시할 항목 순서·라벨. */
const SCORE_ROWS: [keyof Pick<ScoreBreakdown, 'roundPts' | 'matchPts' | 'goalDiffPts' | 'upsetPts' | 'cleanSheetPts'>, string][] = [
  ['roundPts', '진출 라운드'],
  ['matchPts', '승점 (승3·무1)'],
  ['goalDiffPts', '득실차'],
  ['upsetPts', '업셋 보너스'],
  ['cleanSheetPts', '무실점'],
]

/** 라운드별 엔딩 헤드라인 — 사실 서술형. 실존 인물·팀 비하 금지. */
function headlineFor(reached: CampaignStage, champion: boolean): { title: string; body: string } {
  if (champion) {
    return {
      title: '세계를 제패하다',
      body: '대한민국, 월드컵 정상에 올랐다. 조별리그부터 결승까지 이어진 완주의 끝에서 이룬 위대한 성취.',
    }
  }
  switch (reached) {
    case 'final':
      return {
        title: '준우승, 위대한 여정',
        body: '결승에서 아쉽게 멈췄지만, 세계 무대 정상을 눈앞에 둔 역사에 남을 여정이었다.',
      }
    case 'sf':
      return {
        title: '4강 진출, 세계 4위',
        body: '준결승 무대까지 오르며 세계 네 팀 안에 이름을 올린 값진 대회였다.',
      }
    case 'qf':
      return {
        title: '8강 진출',
        body: '아시아를 넘어 세계 강호들과 어깨를 나란히 한 대회, 8강에서 여정을 마쳤다.',
      }
    case 'r16':
      return {
        title: '16강 진출',
        body: '조별리그를 통과해 토너먼트 무대에서 당당히 겨룬 대회였다.',
      }
    case 'r32':
      return {
        title: '32강 진출',
        body: '조별리그를 넘어 토너먼트에 올랐다. 다음을 기약하는 경험이 된 대회.',
      }
    case 'group3':
    default:
      return {
        title: '실제 역사와 같은 결말 — 조별리그 탈락',
        body: '조별리그에서 여정을 마쳤다. 아쉬움을 뒤로하고 다음 대회를 준비한다.',
      }
  }
}

interface Tally { w: number; d: number; l: number; gf: number; ga: number }

function tally(records: MatchRecord[]): Tally {
  const t: Tally = { w: 0, d: 0, l: 0, gf: 0, ga: 0 }
  for (const r of records) {
    const [a, b] = r.score
    t.gf += a
    t.ga += b
    if (a > b) t.w++
    else if (a < b) t.l++
    else if (r.shootout) (r.shootout[0] > r.shootout[1] ? t.w++ : t.l++)
    else t.d++
  }
  return t
}

/** 캠페인 엔딩 화면 — campaignStore.ending 기반 헤드라인 + 기록 요약 + [처음부터]. */
function fmtPts(n: number): string {
  return n > 0 ? `+${n}` : `${n}`
}

/** 캠페인 엔딩 화면 — 헤드라인 + 기록 요약 + 점수 브레이크다운 + 리더보드 등록/순위. */
export function EndingScreen({ onRestart }: { onRestart(): void }) {
  const ending = useCampaignStore(s => s.ending)
  const records = useCampaignStore(s => s.records)
  const groupRank = useCampaignStore(s => s.groupRank)

  const [nickname, setNickname] = useState('')
  const [busy, setBusy] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [myNick, setMyNick] = useState('')
  const [rows, setRows] = useState<LeaderboardRow[]>([])
  const [mode, setMode] = useState<LeaderboardMode>('local')

  // computeScore는 순수 함수 — 기록/엔딩 변화 시에만 재계산.
  const breakdown = useMemo<ScoreBreakdown | null>(
    () => (ending ? computeScore(records, ending, loadAllTeams()) : null),
    [records, ending],
  )
  // 캠페인 여정 에필로그(3~5문장, 사실 서술) — 리더보드 위에 표시.
  const epilogue = useMemo<string[]>(
    () => (ending ? buildEpilogue(records, ending) : []),
    [records, ending],
  )

  if (!ending || !breakdown) return null

  const { title, body } = headlineFor(ending.reached, ending.champion)
  const t = tally(records)
  const diff = t.gf - t.ga
  const diffLabel = diff > 0 ? `+${diff}` : `${diff}`

  async function handleSubmit() {
    if (busy || submitted || !breakdown) return
    setBusy(true)
    const nick = sanitizeNickname(nickname)
    setMyNick(nick)
    await submitScore(nick, breakdown)
    const res = await topScores(10)
    setRows(res.rows)
    setMode(res.mode)
    setSubmitted(true)
    setBusy(false)
  }

  return (
    <div className={`end-root${ending.champion ? ' end-root--champion' : ''}`}>
      <div className="end-card">
        <h1 className="end-headline">{title}</h1>
        <p className="end-body">{body}</p>

        <dl className="end-summary" aria-label="기록 요약">
          <div className="end-summary__item">
            <dt>전적</dt>
            <dd>{t.w}승 {t.d}무 {t.l}패</dd>
          </div>
          <div className="end-summary__item">
            <dt>득실</dt>
            <dd>{t.gf}득점 {t.ga}실점 ({diffLabel})</dd>
          </div>
        </dl>

        {/* 최종 여정 — 어디서 멈췄는지가 남는다. 허브와 같은 컴포넌트라 표기가 어긋나지 않는다. */}
        <div className="end-journey">
          <JourneyLadder
            stage="ended"
            records={records}
            groupRank={groupRank}
            ending={ending}
            compact
          />
        </div>

        <table className="end-score" aria-label="점수 상세">
          <tbody>
            {SCORE_ROWS.map(([key, label]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                <td>{fmtPts(breakdown[key])}</td>
              </tr>
            ))}
            <tr className="end-score__total">
              <th scope="row">합계</th>
              <td>{breakdown.total}</td>
            </tr>
          </tbody>
        </table>

        {epilogue.length > 0 && (
          <div className="end-epilogue" aria-label="여정 에필로그">
            {epilogue.map((p, i) => (
              <p key={i} className="end-epilogue__p">{p}</p>
            ))}
          </div>
        )}

        {!submitted ? (
          <div className="end-submit">
            <input
              className="end-nick"
              type="text"
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              placeholder="닉네임 (2~12자, 미입력 시 익명 감독)"
              maxLength={12}
              aria-label="닉네임"
            />
            <button
              type="button"
              className="end-register"
              onClick={handleSubmit}
              disabled={busy}
            >
              {busy ? '등록 중…' : '기록 등록'}
            </button>
          </div>
        ) : (
          <div className="end-board">
            <div className="end-board__head">
              <h2 className="end-board__title">리더보드 TOP 10</h2>
              {mode === 'local' && (
                <span className="end-board__badge">이 기기 기록</span>
              )}
            </div>
            <ol className="end-board__list">
              {rows.map((r, i) => {
                const mine = r.nickname === myNick && r.total === breakdown.total
                return (
                  <li
                    key={`${r.nickname}-${r.total}-${i}`}
                    className={`end-board__row${mine ? ' end-board__row--me' : ''}`}
                  >
                    <span className="end-board__rank">{i + 1}</span>
                    <span className="end-board__nick">{r.nickname}</span>
                    <span className="end-board__reached">
                      {r.champion ? '우승' : STAGE_LABEL[r.reached]}
                    </span>
                    <span className="end-board__pts">{r.total}</span>
                  </li>
                )
              })}
            </ol>
          </div>
        )}

        <button type="button" className="end-restart" onClick={onRestart}>
          처음부터
        </button>
      </div>
    </div>
  )
}
