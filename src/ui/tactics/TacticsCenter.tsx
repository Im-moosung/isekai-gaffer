import { useState } from 'react'
import type { AttackPattern, Mentality, TacticState } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { LineupEditor } from '../lineup/LineupScreen'
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

  if (!engine) return null
  const home = engine[SIDE]
  const away = engine.away

  // 선발 편집 결과는 곧바로 엔진 tactics로 커밋한다(store가 진실의 원천).
  const setTactics = (next: TacticState) => {
    submitCommand(SIDE, { type: 'formation', tactics: next })
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
        {/* 화살표는 장식이므로 접근성 이름은 "킥오프"로 고정한다. */}
        <button type="button" className="tc-kickoff" aria-label="킥오프" onClick={onKickoff}>
          킥오프 <span aria-hidden="true">▶</span>
        </button>
      </header>

      <div className="tc-body">
        <aside className="tc-war" aria-label="상대 리포트">
          <OppPanel />
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
              <LineupEditor team={home.team} tactics={home.tactics} onChange={setTactics} embedded />
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

/** 하단 검토 요약 — 형태·태도·공격 루트를 한 줄로 확인시킨다. 리스크 카드는 Task 5에서 채운다. */
function PlanSummary() {
  const engine = useMatchStore(s => s.engine)
  if (!engine) return null
  const t = engine.home.tactics
  const ins = t.instructions
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
    </footer>
  )
}
