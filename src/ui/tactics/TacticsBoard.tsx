import { useState } from 'react'
import type { FormationId } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { PitchView } from '../pitch/PitchView'
import { ConsolePanel } from '../console/ConsolePanel'
import { SubPanel } from '../console/SubPanel'
import { TacticsExtras } from './TacticsExtras'
import { TeamTalk } from '../match/TeamTalk'
import { autoFill } from '../lineup/swap'
import './tactics.css'

// 유저는 홈팀 감독 — 작전판은 home 고정.
const SIDE = 'home' as const

// 플레이 가능 포메이션 6종(엔진 정본 XI_SLOTS 키와 동일 순서).
const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

type TacticsTab = 'tactics' | 'sub' | 'opp'

/** 정지 사유 → 작전판 하단 표시 문구. moment는 유형별 짧은 문구를 쓴다. */
function reasonText(
  reason: ReturnType<typeof useMatchStore.getState>['pauseReason'],
  halftime: boolean,
): string {
  if (halftime) return '전반 종료'
  if (!reason) return ''
  switch (reason.kind) {
    case 'hydration1':
    case 'hydration2':
      return '🧊 하이드레이션 브레이크'
    case 'halftime':
      return '전반 종료'
    case 'user':
      return '⏸ 감독 타임'
    case 'moment':
      return `⚡ ${reason.moment.title}`
  }
}

/** 작전판(tactics 모드 본체) — 방송 관전과 확연히 다른 다크 전술판 정체성.
 *  중앙 대형 보드(PitchView 재사용, 이름 라벨 + 다크 variant) + 상단 포메이션 셀렉터,
 *  우측 지시 패널(전술=ConsolePanel·교체=SubPanel·상대=Phase 4A T7 예정),
 *  하단 [전술 확정] 대형 버튼(halftime은 [후반 시작]) + 현재 정지 사유.
 *  하프타임엔 팀토크 카드를 상단에 얹는다.
 *
 *  실시간 보드 반영: 포메이션 셀렉터 변경 시 swap.autoFill로 XI를 재배치하고
 *  submitCommand(type:'formation')로 엔진 tactics를 갱신한다 — PitchView가 새
 *  slotCoords로 리렌더되며 tactics.css의 도트 transition(0.5s)으로 이동한다. */
export function TacticsBoard() {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const pauseReason = useMatchStore(s => s.pauseReason)
  const confirmTactics = useMatchStore(s => s.confirmTactics)
  const submitCommand = useMatchStore(s => s.submitCommand)
  const [tab, setTab] = useState<TacticsTab>('tactics')

  if (!engine) return null
  const halftime = phase === 'halftime'
  const home = engine[SIDE]
  const formation = home.tactics.formation

  // 포메이션 변경 — 현재 선발을 우선 유지(preferIds)하며 새 슬롯에 그리디 재배치.
  const changeFormation = (f: FormationId) => {
    if (f === formation) return
    const preferIds = home.tactics.lineup.map(l => l.playerId)
    const lineup = autoFill(home.team, f, preferIds)
    submitCommand(SIDE, { type: 'formation', tactics: { ...home.tactics, formation: f, lineup } })
  }

  return (
    <div className="tb-root" role="dialog" aria-label="작전판" aria-modal="true">
      <div className="tb-head">
        <span className="tb-head__label">작전 타임</span>
        <span className="tb-head__reason">{reasonText(pauseReason, halftime)}</span>
      </div>

      {halftime && (
        <div className="tb-talk">
          <TeamTalk side={SIDE} />
        </div>
      )}

      <div className="tb-main">
        <div className="tb-board">
          <div className="tb-formsel" role="group" aria-label="포메이션">
            {FORMATIONS.map(f => (
              <button
                key={f}
                type="button"
                aria-pressed={f === formation}
                className={`tb-formsel__btn${f === formation ? ' tb-formsel__btn--active' : ''}`}
                onClick={() => changeFormation(f)}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="tb-board__pitch">
            <PitchView state={engine} variant="tactics" nameLabels />
          </div>
        </div>

        <aside className="tb-side">
          <div className="tb-tabs" role="tablist" aria-label="지시 패널">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'tactics'}
              className={`tb-tab${tab === 'tactics' ? ' tb-tab--active' : ''}`}
              onClick={() => setTab('tactics')}
            >
              전술
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'sub'}
              className={`tb-tab${tab === 'sub' ? ' tb-tab--active' : ''}`}
              onClick={() => setTab('sub')}
            >
              교체
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'opp'}
              className={`tb-tab${tab === 'opp' ? ' tb-tab--active' : ''}`}
              onClick={() => setTab('opp')}
            >
              상대
            </button>
          </div>
          <div className="tb-side__body">
            {tab === 'tactics' && (
              <div className="tb-tactics">
                <ConsolePanel side={SIDE} />
                <TacticsExtras side={SIDE} />
              </div>
            )}
            {tab === 'sub' && <SubPanel side={SIDE} />}
            {tab === 'opp' && (
              <div className="tb-opp" aria-label="상대 분석">
                <p className="tb-opp__soon">상대 분석 — 곧 제공됩니다</p>
              </div>
            )}
          </div>
        </aside>
      </div>

      <footer className="tb-foot">
        <span className="tb-foot__reason">{reasonText(pauseReason, halftime)}</span>
        <button
          type="button"
          className="tb-confirm"
          onClick={confirmTactics}
        >
          {halftime ? '후반 시작' : '전술 확정'}
        </button>
      </footer>
    </div>
  )
}
