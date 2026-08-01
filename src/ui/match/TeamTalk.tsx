import { useState } from 'react'
import {
  useMatchStore, scoreSituation, teamExpectation, recommendedTone,
  type TeamTalkTone, type TeamTalkResult,
} from '../../game/matchStore'
import { useCampaignStore } from '../../game/campaignStore'
import { scoreMoraleShift } from '../../engine/simulate'
import { getLine } from '../../game/teamTalkLines'
import './match.css'

const TONES: { tone: TeamTalkTone; label: string }[] = [
  { tone: 'rage', label: '격노' },
  { tone: 'encourage', label: '격려' },
  { tone: 'calm', label: '침착' },
  { tone: 'trust', label: '신뢰' },
]

/** 선수 반응 아이콘(스토어가 이모지로 준다) → 평문 한글 라벨.
 *  이모지는 OS마다 모양·크기가 달라 톤이 무너지고, 무엇보다 "🔥가 좋은 건가"를
 *  설명해 주지 않는다. 방송도 픽토그램 대신 평문 배너를 쓴다. */
const REACTION_KO: Record<string, string> = {
  '🔥': '불붙음',
  '😐': '미지근함',
  '😰': '위축됨',
}

/** 팀 사기 평균 → 구간별 상태 문구(사전 정보).
 *
 *  ★ 구간은 **기준선 70을 중심으로** 잡는다. 예전 경계(75/55/40)는 중립 구간이 55~74로
 *    넓어서, 스코어 변위(simulate.scoreMoraleShift, 골차당 ±6)를 반영해도 1-2로 뒤진
 *    라커룸이 여전히 "차분하게 준비돼 있습니다"로 읽혔다. 한 골 차 열세(−6)가 문구를
 *    실제로 바꾸도록 폭을 좁혔다: 70(동점) 차분 · 64(한 골 차 열세) 가라앉음 ·
 *    82(두 골 차 리드) 자신감 · 58(두 골 차 열세) 위축. */
function moraleStatus(avg: number): string {
  if (avg >= 80) return '선수들이 자신감에 차 있습니다'
  if (avg >= 66) return '선수들이 차분하게 준비돼 있습니다'
  if (avg >= 60) return '선수들이 다소 가라앉아 있습니다'
  return '선수들이 위축되어 있습니다'
}

/** 톤 값 → 라벨. 접힌 뒤에는 카드가 사라지므로 "무엇을 골랐는지"를 이 표로 되살린다. */
const TONE_LABEL: Record<TeamTalkTone, string> =
  Object.fromEntries(TONES.map(t => [t.tone, t.label])) as Record<TeamTalkTone, string>

/** 하프타임 팀토크 — 상황(스코어)에 맞는 톤별 문장형 버튼 4개.
 *  선택 시 matchStore.applyTeamTalk가 결정론 테이블(+기대치·반복 감쇠)만큼 사기를 보정하고,
 *  즉시 효과 배너(사기 delta·선수별 반응)를 노출한다.
 *
 *  ★ 선택 후에는 **선택 UI 전체를 접는다**(카드 4장 + 사기 게이지 제거, 결과만 남김).
 *    팀토크는 경기당 1회(matchStore.applyTeamTalk가 talked를 보고 throw)라 되돌릴 수 없으므로
 *    "다시 펼치기" 토글은 누를 이유가 없는 컨트롤만 하나 늘린다 — 접기는 단방향이다.
 *    작전판은 세로 공간이 귀한 화면인데 이 블록이 폭·높이를 통째로 먹고 있었고,
 *    선택이 끝난 뒤의 카드 4장은 이미 disabled라 정보값이 0이었다. */
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

  // 사전 정보: 선발 라인업(퇴장 제외) 사기 평균 + **스코어가 주는 변위**.
  //
  // ★ 예전에는 moraleByPlayer만 읽었고, 그 값은 팀토크·외침으로만 움직였다. 그래서 1-2로
  //   뒤진 하프타임에도 헤더가 "선수들이 차분하게 준비돼 있습니다 · 사기 70"이었다
  //   (감사 결함 ⑤). 라커룸의 공기가 스코어보드를 모르는 화면이었다.
  //   스코어 변위를 엔진 상태(zoneStrength 경로)에 태우지 않는 이유는
  //   engine/simulate.scoreMoraleShift 주석 참조 — momentum이 이미 같은 일을 하고 있어
  //   이중 계상이 되고, 실측에서 실팀 캘리브레이션(±25%)이 깨졌다.
  const lineupMorale = sideState.tactics.lineup
    .filter(l => !sideState.sentOff.includes(l.playerId))
    .map(l => sideState.moraleByPlayer[l.playerId] ?? 0)
  const [ownGoals, oppGoals] = side === 'home'
    ? [engine.score[0], engine.score[1]]
    : [engine.score[1], engine.score[0]]
  const avgMorale = lineupMorale.length
    ? Math.max(0, Math.min(100, Math.round(
        lineupMorale.reduce((a, b) => a + b, 0) / lineupMorale.length + scoreMoraleShift(ownGoals, oppGoals),
      )))
    : 0

  const nameOf = (id: string) => sideState.team.squad.find(p => p.id === id)?.name.ko ?? id

  function onSelect(tone: TeamTalkTone) {
    const repeated = lastTeamTalkTone === tone
    const res = applyTeamTalk(side, tone, { expectation, repeated })
    setResult({ ...res, tone })
  }

  // 접힌 뒤에도 사기 수치는 남긴다 — 팀토크가 실제로 무엇을 바꿨는지 보여 주는 값이다.
  // 다만 게이지 바 + 상태 문구(2줄)는 결과 줄에 `사기 78` 한 토막으로 압축한다.
  // 사전 정보로서의 가치(무슨 말을 고를지 판단)는 선택이 끝난 순간 사라지기 때문이다.
  if (talked) {
    return (
      <div className="tt-root">
        <p className="tt-label">팀 토크</p>
        {result ? (
          <div
            className={`tt-banner tt-banner--done ${result.delta > 0 ? 'tt-banner--up' : result.delta < 0 ? 'tt-banner--down' : 'tt-banner--flat'}`}
            role="status"
          >
            <span className="tt-banner__tone">{TONE_LABEL[result.tone]}</span>
            <span className="tt-banner__text">
              {result.delta > 0
                ? `선수단 사기 상승 (+${result.delta})`
                : result.delta < 0
                  ? `역효과! 선수단 사기 저하 (${result.delta})`
                  : '선수단 반응이 미지근합니다 (±0)'}
            </span>
            <span className="tt-banner__morale">사기 {avgMorale}</span>
            {/* 반응은 세로 목록이면 최대 3줄을 먹는다 — 칩으로 눕혀 한 줄에 흘린다. */}
            <ul className="tt-reactions">
              {result.reactions.map(r => (
                <li key={r.playerId} className="tt-reactions__item">
                  <span className="tt-reactions__name">{nameOf(r.playerId)}</span>
                  <span className="badge">{REACTION_KO[r.icon] ?? r.icon}</span>
                </li>
              ))}
            </ul>
            {result.repeated && (
              <p className="tt-banner__note">지난 경기와 같은 말 — 울림이 덜합니다</p>
            )}
          </div>
        ) : (
          // 작전판을 닫았다 다시 열면 컴포넌트가 재마운트돼 result(로컬 state)가 날아간다.
          // 상세는 복원할 수 없으니 "이미 전달했다"는 사실 + 현재 사기만 한 줄로 남긴다.
          <p className="tt-done">팀 토크 전달 완료 · 사기 {avgMorale}</p>
        )}
      </div>
    )
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
    </div>
  )
}
