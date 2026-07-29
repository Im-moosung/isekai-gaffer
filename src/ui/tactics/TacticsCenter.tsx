import { useState } from 'react'
import type { AttackPattern, Mentality, TacticState } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { planRisks, recommendPlan } from '../../game/scouting'
import { LineupEditor } from '../lineup/LineupScreen'
import { autoFill } from '../lineup/swap'
import { ConsolePanel } from '../console/ConsolePanel'
import { TacticsExtras } from './TacticsExtras'
import { OppPanel } from './OppPanel'
import './TacticsCenter.css'

// 유저는 홈팀 감독 — 전술 센터는 home 고정(작전판과 동일 규약).
const SIDE = 'home' as const

type CenterTab = 'lineup' | 'team'

const MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비', defensive: '수비', balanced: '균형',
  attacking: '공격', 'very-attacking': '매우 공격',
}
const PATTERN_KO: Record<AttackPattern, string> = {
  balanced: '균형', cross: '크로스', through: '중앙 침투', longshot: '중거리',
}

/** 킥오프 전 워룸. 좌측에 상대 리포트를 상시 고정하고, 우측 탭에서 선발과 팀 전술을 설계한다.
 *  경기 중 작전판(TacticsBoard)과 같은 컨트롤(ConsolePanel·TacticsExtras)을 재사용해
 *  유저가 한 번 배운 UI를 두 시점에서 쓰게 한다. 새 컴포넌트를 만들지 않는 이유이기도 하다 —
 *  이들은 이미 store 바인딩이라 'pre'가 개입 phase가 되는 순간 무수정으로 동작한다. */
export function TacticsCenter({ onKickoff, referenceScore }: {
  onKickoff(): void
  referenceScore?: [number, number]
}) {
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)
  const [tab, setTab] = useState<CenterTab>('lineup')
  // 코치진 권고는 적용 후에도 닫기 전까지 남긴다 — 근거를 읽으며 수치를 다듬는 것이
  // 이 화면의 본래 용도이므로, 자동 사라짐(타이머)은 오히려 방해다.
  const [reasons, setReasons] = useState<{ field: string; text: string }[]>([])

  if (!engine) return null
  const home = engine[SIDE]
  const away = engine.away

  // 선발 편집 결과는 곧바로 엔진 tactics로 커밋한다(store가 진실의 원천).
  const setTactics = (next: TacticState) => {
    submitCommand(SIDE, { type: 'formation', tactics: next })
  }

  // 추천은 현재 전술 위에 덮어쓰는 patch다. 포메이션이 바뀌면 새 슬롯에 재배치한다
  // (①선발 탭의 포메이션 버튼과 동일 규칙 — 기본 scope 'squad').
  // 킥오프 전이므로 후보는 스쿼드 전체다. 이전엔 현재 선발을 무조건 우선해 3-5-2 추천이
  // 남아도는 풀백을 ST에 세웠다(김문환 RB@ST 적합도 0.40). 감독의 11인은 **적합도가 같을 때**
  // 유지된다 — 되돌릴 수 없는 버튼이 되지 않도록 선발 탭에서 언제든 되돌릴 수 있다.
  const applyRecommendation = () => {
    const rec = recommendPlan(home.team, away.team)
    const formation = rec.patch.formation ?? home.tactics.formation
    const merged: TacticState = {
      ...home.tactics,
      ...rec.patch,
      instructions: { ...home.tactics.instructions, ...(rec.patch.instructions ?? {}) },
      lineup: formation === home.tactics.formation
        ? home.tactics.lineup
        : autoFill(home.team, formation, home.tactics.lineup.map(l => l.playerId)),
    }
    submitCommand(SIDE, { type: 'formation', tactics: merged })
    setReasons(rec.reasons)
  }

  return (
    <div className="tc-root" aria-label="전술 센터">
      <header className="tc-head">
        <div className="tc-head__match">
          <span className="tc-head__teams">{home.team.name.ko} vs {away.team.name.ko}</span>
          {referenceScore && (
            <span className="tc-head__ref">참고 · 실제 역사 {referenceScore[0]}-{referenceScore[1]}</span>
          )}
        </div>
        <div className="tc-head__actions">
          <button type="button" className="tc-recbtn" onClick={applyRecommendation}>
            <span aria-hidden="true">🧠</span> 추천 적용
          </button>
          {/* 화살표는 장식이므로 접근성 이름은 "킥오프"로 고정한다. */}
          <button type="button" className="tc-kickoff" aria-label="킥오프" onClick={onKickoff}>
            킥오프 <span aria-hidden="true">▶</span>
          </button>
        </div>
      </header>

      <div className="tc-body">
        {/* 권고는 스카우팅 리포트의 결론이므로 상대 리포트와 같은 열에 둔다.
            본문 위(세로 흐름)에 놓으면 권고를 여는 순간 아래 컨트롤이 화면 밖으로
            밀린다 — "기능을 켜면 다른 부분이 쪼그라드는" 그 증상 그대로다.
            이 열은 높이가 38vh로 고정돼 있어 권고가 떠도 레이아웃이 움직이지 않는다. */}
        <aside className="tc-war" aria-label="상대 리포트">
          {reasons.length > 0 && (
            <div className="tc-reasons" role="status">
              <div className="tc-reasons__head">
                <strong>코치진 권고</strong>
                <button type="button" className="tc-reasons__x" onClick={() => setReasons([])} aria-label="권고 닫기">✕</button>
              </div>
              <span className="tc-reasons__note">감독 판단으로 수정하십시오</span>
              <ul className="tc-reasons__list">
                {reasons.map((r, i) => <li key={`${r.field}-${i}`}>{r.text}</li>)}
              </ul>
            </div>
          )}
          <div className="tc-war__body">
            <OppPanel />
          </div>
        </aside>

        <section className="tc-main">
          <div className="tc-tabs" role="tablist" aria-label="전술 설계">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'lineup'}
              className={`tc-tab${tab === 'lineup' ? ' tc-tab--active' : ''}`}
              onClick={() => setTab('lineup')}
            >
              ① 선발
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'team'}
              className={`tc-tab${tab === 'team' ? ' tc-tab--active' : ''}`}
              onClick={() => setTab('team')}
            >
              ② 팀 전술
            </button>
          </div>
          <div className="tc-tabbody">
            {tab === 'lineup' && (
              // 컨디션은 킥오프 전에 가장 중요한 정보다(캠페인 이월 체력이 여기 반영돼 있다 —
              // matchStore.startMatch가 staminaOverride로 엔진 초기값을 이미 덮어썼으므로
              // 여기서 campaignStore를 다시 읽지 않는다. 진실의 원천은 엔진 하나다).
              <LineupEditor
                team={home.team}
                tactics={home.tactics}
                onChange={setTactics}
                embedded
                staminaByPlayer={home.staminaByPlayer}
                moraleByPlayer={home.moraleByPlayer}
              />
            )}
            {tab === 'team' && (
              <div className="tc-team">
                <ConsolePanel side={SIDE} />
                <TacticsExtras side={SIDE} />
              </div>
            )}
          </div>
        </section>
      </div>

      <PlanSummary />
    </div>
  )
}

/** 하단 검토 요약 — 형태·태도·공격 루트·리스크를 한 줄로 확인시킨다.
 *  리스크는 킥오프 직전에 "이대로 나가면 무엇이 위험한가"를 알려주는 마지막 관문이다. */
function PlanSummary() {
  const engine = useMatchStore(s => s.engine)
  if (!engine) return null
  const t = engine.home.tactics
  const ins = t.instructions
  const risks = planRisks(engine.home.team, t, engine.home.staminaByPlayer)
  return (
    <footer className="tc-summary" aria-label="킥오프 전 검토">
      <div className="tc-card">
        <span className="tc-card__label">형태</span>
        <span className="tc-card__value">{t.formation}</span>
        {t.phaseFormations?.attack && <span className="tc-card__sub">공격 {t.phaseFormations.attack}</span>}
        {t.phaseFormations?.defense && <span className="tc-card__sub">수비 {t.phaseFormations.defense}</span>}
      </div>
      <div className="tc-card">
        <span className="tc-card__label">태도</span>
        <span className="tc-card__value">{MENTALITY_KO[t.mentality ?? 'balanced']}</span>
        <span className="tc-card__sub">라인 {ins.lineHeight} · 압박 {ins.pressing} · 템포 {ins.tempo}</span>
      </div>
      <div className="tc-card">
        <span className="tc-card__label">공격 루트</span>
        <span className="tc-card__value">{PATTERN_KO[t.attackPattern ?? 'balanced']}</span>
      </div>
      <div className="tc-card tc-card--risk">
        <span className="tc-card__label">리스크</span>
        <ul className="tc-risks">
          {risks.map((r, i) => (
            <li key={`${r.level}-${i}`} className={r.level === 'warn' ? 'tc-risk tc-risk--warn' : 'tc-risk'}>
              <span aria-hidden="true">{r.level === 'warn' ? '⚠' : '✅'}</span> {r.text}
            </li>
          ))}
        </ul>
      </div>
    </footer>
  )
}
