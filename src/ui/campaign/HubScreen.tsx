import { useCampaignStore } from '../../game/campaignStore'
import { loadTeam } from '../../data/loader'
import type { TeamId } from '../../data/loader'
import { JourneyLadder } from './JourneyLadder'
import './campaign.css'

/** 캠페인 허브(워룸 간이판): 여정 사다리 + 다음 상대 카드 + [경기 준비].
 *  ended 상태에서는 부모가 EndingScreen으로 전환하므로 방어적으로 null을 반환한다. */
export function HubScreen({ onProceed }: { onProceed(): void }) {
  const stage = useCampaignStore(s => s.stage)
  const records = useCampaignStore(s => s.records)
  const groupRank = useCampaignStore(s => s.groupRank)
  const ending = useCampaignStore(s => s.ending)
  const currentOpponent = useCampaignStore(s => s.currentOpponent)

  if (stage === 'ended' || ending) return null

  const opponentId: TeamId = currentOpponent()
  const opp = loadTeam(opponentId)
  const styleNotes = (opp.profile as { styleNotes?: string }).styleNotes

  return (
    <div className="hub-root">
      <header className="hub-head">
        <h2 className="hub-title">대한민국 월드컵 여정</h2>
        <span className="hub-head__meta">{records.length}경기 완료 · 남은 {8 - records.length}경기</span>
      </header>

      <div className="hub-body">
        <JourneyLadder
          stage={stage}
          records={records}
          groupRank={groupRank}
          ending={ending}
          currentOpponentId={opponentId}
        />

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

          <footer className="hub-foot">
            <button type="button" className="hub-proceed" onClick={onProceed}>
              경기 준비
            </button>
          </footer>
        </section>
      </div>
    </div>
  )
}
