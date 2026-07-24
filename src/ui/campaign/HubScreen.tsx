import { useCampaignStore } from '../../game/campaignStore'
import type { CampaignStage, MatchRecord } from '../../game/campaignStore'
import { loadTeam } from '../../data/loader'
import type { TeamId } from '../../data/loader'
import './campaign.css'

/** 진행 바 8칸: 조별 3(cze·mex·rsa) + 토너먼트 5(32강~결승). */
const STAGES: { stage: CampaignStage; label: string }[] = [
  { stage: 'group1', label: '조별 1' },
  { stage: 'group2', label: '조별 2' },
  { stage: 'group3', label: '조별 3' },
  { stage: 'r32', label: '32강' },
  { stage: 'r16', label: '16강' },
  { stage: 'qf', label: '8강' },
  { stage: 'sf', label: '4강' },
  { stage: 'final', label: '결승' },
]

type Outcome = 'W' | 'D' | 'L'

/** 기록 한 건의 승/무/패를 판정한다(토너먼트 무승부는 승부차기로 확정). */
function outcomeOf(r: MatchRecord): Outcome {
  const [a, b] = r.score
  if (a > b) return 'W'
  if (a < b) return 'L'
  if (r.shootout) return r.shootout[0] > r.shootout[1] ? 'W' : 'L'
  return 'D'
}

/** "W 2-1" / 승부차기는 "W 1-1 (4-3)". */
function resultLabel(r: MatchRecord): string {
  const base = `${outcomeOf(r)} ${r.score[0]}-${r.score[1]}`
  return r.shootout ? `${base} (${r.shootout[0]}-${r.shootout[1]})` : base
}

/** 캠페인 허브(워룸 간이판): 진행 바 + 지난 결과 + 다음 상대 카드 + [라인업 짜기].
 *  ended 상태에서는 부모가 EndingScreen으로 전환하므로 방어적으로 null을 반환한다. */
export function HubScreen({ onProceed }: { onProceed(): void }) {
  const stage = useCampaignStore(s => s.stage)
  const records = useCampaignStore(s => s.records)
  const ending = useCampaignStore(s => s.ending)
  const currentOpponent = useCampaignStore(s => s.currentOpponent)

  if (stage === 'ended' || ending) return null

  const byStage = new Map<CampaignStage, MatchRecord>()
  for (const r of records) byStage.set(r.stage, r)

  const opponentId: TeamId = currentOpponent()
  const opp = loadTeam(opponentId)
  const styleNotes = (opp.profile as { styleNotes?: string }).styleNotes

  return (
    <div className="hub-root">
      <header className="hub-head">
        <h2 className="hub-title">대한민국 월드컵 여정</h2>
      </header>

      <ol className="hub-progress" aria-label="스테이지 진행">
        {STAGES.map(({ stage: st, label }) => {
          const rec = byStage.get(st)
          const isCurrent = st === stage
          const cls =
            'hub-step' +
            (isCurrent ? ' hub-step--current' : '') +
            (rec ? ` hub-step--done hub-step--${outcomeOf(rec).toLowerCase()}` : '')
          return (
            <li key={st} className={cls} aria-current={isCurrent ? 'step' : undefined}>
              <span className="hub-step__label">{label}</span>
              <span className="hub-step__result">{rec ? resultLabel(rec) : isCurrent ? '진행 중' : '—'}</span>
            </li>
          )
        })}
      </ol>

      <div className="hub-body">
        <section className="hub-records" aria-label="지난 결과">
          <h3 className="hub-section__title">지난 결과</h3>
          {records.length === 0 ? (
            <p className="hub-records__empty">아직 치른 경기가 없습니다.</p>
          ) : (
            <ul className="hub-records__list">
              {records.map((r, i) => (
                <li key={`${r.stage}-${i}`} className={`hub-record hub-record--${outcomeOf(r).toLowerCase()}`}>
                  <span className="hub-record__opp">
                    {loadTeam(r.opponentId).name.ko}
                  </span>
                  <span className="hub-record__result">{resultLabel(r)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="hub-next" aria-label="다음 상대">
          <h3 className="hub-section__title">다음 상대</h3>
          <article className="hub-oppcard">
            <div className="hub-oppcard__head">
              {opp.flag ? <span className="hub-oppcard__flag" aria-hidden="true">{opp.flag}</span> : null}
              <span className="hub-oppcard__name">{opp.name.ko}</span>
              <span className="hub-oppcard__rank">FIFA {opp.fifaRanking}위</span>
            </div>
            <dl className="hub-oppcard__meta">
              <dt>선호 포메이션</dt>
              <dd>{opp.profile.preferredFormations.join(', ')}</dd>
            </dl>
            {styleNotes ? <p className="hub-oppcard__notes">{styleNotes}</p> : null}
          </article>
        </section>
      </div>

      <footer className="hub-foot">
        <button type="button" className="hub-proceed" onClick={onProceed}>
          라인업 짜기
        </button>
      </footer>
    </div>
  )
}
