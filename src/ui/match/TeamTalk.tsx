import { useState } from 'react'
import {
  useMatchStore, scoreSituation, teamExpectation, recommendedTone,
  type TeamTalkTone, type TeamTalkResult,
} from '../../game/matchStore'
import { useCampaignStore } from '../../game/campaignStore'
import { getLine } from '../../game/teamTalkLines'
import './match.css'

const TONES: { tone: TeamTalkTone; label: string }[] = [
  { tone: 'rage', label: '격노' },
  { tone: 'encourage', label: '격려' },
  { tone: 'calm', label: '침착' },
  { tone: 'trust', label: '신뢰' },
]

/** 팀 사기 평균 → 구간별 상태 문구(사전 정보). */
function moraleStatus(avg: number): string {
  if (avg >= 75) return '선수들이 자신감에 차 있습니다'
  if (avg >= 55) return '선수들이 차분하게 준비돼 있습니다'
  if (avg >= 40) return '선수들이 다소 가라앉아 있습니다'
  return '선수들이 위축되어 있습니다'
}

/** 하프타임 팀토크 — 상황(스코어)에 맞는 톤별 문장형 버튼 4개.
 *  선택 시 matchStore.applyTeamTalk가 결정론 테이블(+기대치·반복 감쇠)만큼 사기를 보정하고,
 *  즉시 효과 배너(사기 delta·선수별 반응)를 크게 노출한다. 경기당 1회(선택 후 버튼 비활성). */
export function TeamTalk({ side }: { side: 'home' }) {
  const engine = useMatchStore(s => s.engine)
  const applyTeamTalk = useMatchStore(s => s.applyTeamTalk)
  const talked = useMatchStore(s => s.talked)
  // 반복 감쇠: 지난 경기(캠페인) 팀토크 톤. 이번 경기 톤 기록은 recordResult가 담당(데모는 감쇠 없음).
  const lastTeamTalkTone = useCampaignStore(s => s.lastTeamTalkTone)

  const [result, setResult] = useState<(TeamTalkResult & { tone: TeamTalkTone }) | null>(null)

  if (!engine) return null

  const sideState = engine[side]
  const other = side === 'home' ? 'away' : 'home'
  const situation = scoreSituation(engine.score, side)
  const expectation = teamExpectation(sideState.team.fifaRanking, engine[other].team.fifaRanking)
  const recommended = recommendedTone(situation, expectation)

  // 사전 정보: 선발 라인업(퇴장 제외) 사기 평균.
  const lineupMorale = sideState.tactics.lineup
    .filter(l => !sideState.sentOff.includes(l.playerId))
    .map(l => sideState.moraleByPlayer[l.playerId] ?? 0)
  const avgMorale = lineupMorale.length
    ? Math.round(lineupMorale.reduce((a, b) => a + b, 0) / lineupMorale.length)
    : 0

  const nameOf = (id: string) => sideState.team.squad.find(p => p.id === id)?.name.ko ?? id

  function onSelect(tone: TeamTalkTone) {
    const repeated = lastTeamTalkTone === tone
    const res = applyTeamTalk(side, tone, { expectation, repeated })
    setResult({ ...res, tone })
  }

  return (
    <div className="tt-root">
      <p className="tt-label">팀 토크</p>

      {/* 사전 정보 — 현재 팀 사기 게이지 + 상태 문구 */}
      <div className="tt-morale" aria-label={`팀 사기 ${avgMorale}`}>
        <div className="tt-morale__bar">
          <div className="tt-morale__fill" style={{ width: `${avgMorale}%` }} />
        </div>
        <p className="tt-morale__status">{moraleStatus(avgMorale)} · 사기 {avgMorale}</p>
      </div>

      <div className="tt-btns" role="group" aria-label="팀 토크">
        {TONES.map(({ tone, label }) => {
          const isRec = tone === recommended
          return (
            <button
              key={tone}
              type="button"
              className={`tt-btn${isRec ? ' tt-btn--rec' : ''}`}
              disabled={talked}
              aria-pressed={false}
              onClick={() => onSelect(tone)}
            >
              {isRec && <span className="tt-btn__badge">코치 추천</span>}
              <span className="tt-btn__tone">{label}</span>
              <span className="tt-btn__line">{getLine(tone, situation, engine.seed)}</span>
            </button>
          )
        })}
      </div>

      {/* 선택 즉시 효과 배너 — delta 부호별 색·아이콘 + 선수별 반응 2~3명 */}
      {result && (
        <div
          className={`tt-banner ${result.delta > 0 ? 'tt-banner--up' : result.delta < 0 ? 'tt-banner--down' : 'tt-banner--flat'}`}
          role="status"
        >
          <p className="tt-banner__head">
            <span className="tt-banner__icon" aria-hidden="true">
              {result.delta > 0 ? '🔥' : result.delta < 0 ? '💥' : '😐'}
            </span>
            <span className="tt-banner__text">
              {result.delta > 0
                ? `선수단 사기 상승 (+${result.delta})`
                : result.delta < 0
                  ? `역효과! 선수단 사기 저하 (${result.delta})`
                  : '선수단 반응이 미지근합니다 (±0)'}
            </span>
          </p>
          {result.repeated && (
            <p className="tt-banner__note">지난 경기와 같은 말 — 울림이 덜합니다</p>
          )}
          <ul className="tt-reactions">
            {result.reactions.map(r => (
              <li key={r.playerId} className="tt-reactions__item">
                <span className="tt-reactions__icon" aria-hidden="true">{r.icon}</span>
                <span className="tt-reactions__name">{nameOf(r.playerId)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {talked && !result ? <p className="tt-done">지시 전달 완료</p> : null}
    </div>
  )
}
