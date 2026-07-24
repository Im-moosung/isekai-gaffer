import { useMatchStore, type TeamTalkTone } from '../../game/matchStore'
import './match.css'

const TONES: { tone: TeamTalkTone; label: string }[] = [
  { tone: 'rage', label: '격노' },
  { tone: 'encourage', label: '격려' },
  { tone: 'calm', label: '침착' },
  { tone: 'trust', label: '신뢰' },
]

/** 하프타임 팀토크 — 4톤 버튼. 선택 시 matchStore.applyTeamTalk(side, tone)로
 *  moraleByPlayer를 결정론 테이블만큼 일괄 보정한다. 경기당 1회(선택 후 버튼 비활성). */
export function TeamTalk({ side }: { side: 'home' }) {
  const applyTeamTalk = useMatchStore(s => s.applyTeamTalk)
  const talked = useMatchStore(s => s.talked)

  return (
    <div className="tt-root">
      <p className="tt-label">팀 토크</p>
      <div className="tt-btns" role="group" aria-label="팀 토크">
        {TONES.map(({ tone, label }) => (
          <button
            key={tone}
            type="button"
            className="tt-btn"
            disabled={talked}
            aria-pressed={false}
            onClick={() => applyTeamTalk(side, tone)}
          >
            {label}
          </button>
        ))}
      </div>
      {talked ? <p className="tt-done">지시 전달 완료</p> : null}
    </div>
  )
}
