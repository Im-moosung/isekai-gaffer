import { useState } from 'react'
import type { FormationId, GroupIntensity, Player, TacticState } from '../../engine/types'
import { useMatchStore } from '../../game/matchStore'
import { buildCoachAdvice, type TacticPatch } from '../../game/coach'
import { PitchView } from '../pitch/PitchView'
import { ConsolePanel } from '../console/ConsolePanel'
import { SubPanel } from '../console/SubPanel'
import { OppPanel } from './OppPanel'
import { PlayerCard } from '../common/PlayerCard'
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
  // 보드 상호작용 상태: 팝오버 대상(any) + 교체 아웃/인(교체 미리보기 고스트·비교 카드).
  const [pop, setPop] = useState<string | null>(null)
  const [subOut, setSubOut] = useState<string | null>(null)
  const [subIn, setSubIn] = useState<string | null>(null)

  if (!engine) return null
  const halftime = phase === 'halftime'
  const home = engine[SIDE]
  const formation = home.tactics.formation
  const byId = (id: string | null): Player | undefined =>
    id ? home.team.squad.find(p => p.id === id) : undefined

  // 포메이션 변경 — 현재 선발을 우선 유지(preferIds)하며 새 슬롯에 그리디 재배치.
  const changeFormation = (f: FormationId) => {
    if (f === formation) return
    const preferIds = home.tactics.lineup.map(l => l.playerId)
    const lineup = autoFill(home.team, f, preferIds)
    submitCommand(SIDE, { type: 'formation', tactics: { ...home.tactics, formation: f, lineup } })
  }

  // 보드 도트/이름 클릭 → 팝오버. 교체 탭이면 아웃 선수로도 선택(고스트 미리보기 리셋).
  const onDotClick = (playerId: string) => {
    setPop(playerId)
    if (tab === 'sub') { setSubOut(playerId); setSubIn(null) }
  }
  const resetSub = () => { setSubOut(null); setSubIn(null); setPop(null) }

  // 교체 미리보기 고스트: 아웃 선수의 슬롯 인덱스에 투입 선수 번호를 반투명 표시.
  const outIdx = subOut ? home.tactics.lineup.findIndex(l => l.playerId === subOut) : -1
  const inPlayer = byId(subIn)
  const ghost = tab === 'sub' && subOut && subIn && outIdx >= 0
    ? { slotIndex: outIdx, number: inPlayer?.number }
    : null
  const highlightId = tab === 'sub' ? subOut : pop
  // 팝오버: 교체 비교(아웃+인) 우선, 없으면 단일 선택 카드.
  const outPlayer = byId(subOut)
  const popPlayer = byId(pop)
  const compare = tab === 'sub' && outPlayer && inPlayer

  return (
    <div className="tb-root" role="dialog" aria-label="작전판" aria-modal="true">
      <div className="tb-head">
        <span className="tb-head__label">작전 타임</span>
        <span className="tb-head__reason">{reasonText(pauseReason, halftime)}</span>
      </div>

      {/* 코치 회의 — 작전판 최상단(진입 시 가장 먼저). 멀티 코치·[감독 판단대로 간다] 포함. */}
      <CoachMeeting />

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
            <PitchView
              state={engine}
              variant="tactics"
              nameLabels
              highlightId={highlightId}
              ghost={ghost}
              onDotClick={onDotClick}
            />
            {(compare || popPlayer) && (
              <div className="tb-pop" role="group" aria-label="선수 카드">
                {compare ? (
                  <div className="tb-pop__compare">
                    <PlayerCard player={outPlayer!} size="compact" side={SIDE} role="OUT" stamina={home.staminaByPlayer[outPlayer!.id]} />
                    <span className="tb-pop__arrow" aria-hidden="true">→</span>
                    <PlayerCard player={inPlayer!} size="compact" side={SIDE} role="IN" stamina={home.staminaByPlayer[inPlayer!.id]} />
                  </div>
                ) : (
                  <PlayerCard
                    player={popPlayer!}
                    side={SIDE}
                    stamina={home.staminaByPlayer[popPlayer!.id]}
                    morale={home.moraleByPlayer[popPlayer!.id]}
                  />
                )}
                <button type="button" className="tb-pop__close" aria-label="카드 닫기" onClick={() => { setPop(null) }}>✕</button>
              </div>
            )}
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
            {tab === 'sub' && (
              <SubPanel
                side={SIDE}
                outId={subOut}
                inId={subIn}
                onSelectOut={id => { setSubOut(id); setSubIn(null); setPop(id) }}
                onSelectIn={id => { setSubIn(id); setPop(id) }}
                onConfirmed={resetSub}
              />
            )}
            {tab === 'opp' && <OppPanel />}
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

const DEFAULT_GI: GroupIntensity = { attack: 0, midfield: 0, defense: 0 }

/** 코치 회의 카드 리스트 — 수비/공격/피지컬(+세트피스) 코치가 서로 다른 관점을 제안한다.
 *  각 카드 [채택]은 부분 전술(TacticPatch)을 현재 draft에 병합해 즉시 반영한다(유저가 이후 수정 가능).
 *  맨 아래 [감독 판단대로 간다]는 전체 카드를 접는다(전부 무시 — 감독의 딜레마 존중). */
function CoachMeeting() {
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)
  const [dismissed, setDismissed] = useState(false)

  if (!engine || dismissed) return null
  const advice = buildCoachAdvice(engine, SIDE)
  if (advice.length === 0) return null

  // TacticPatch → 현재 tactics에 병합 후 formation 명령으로 제출(엔진은 tactics 통째 교체).
  const adopt = (p: TacticPatch) => {
    const t = engine[SIDE].tactics
    const merged: TacticState = {
      ...t,
      ...(p.instructions ? { instructions: { ...t.instructions, ...p.instructions } } : {}),
      ...(p.mentality ? { mentality: p.mentality } : {}),
      ...(p.groupIntensity ? { groupIntensity: { ...(t.groupIntensity ?? DEFAULT_GI), ...p.groupIntensity } } : {}),
      ...(p.attackPattern ? { attackPattern: p.attackPattern } : {}),
    }
    submitCommand(SIDE, { type: 'formation', tactics: merged })
  }

  return (
    <section className="tb-coach" aria-label="코치 회의">
      <h3 className="tb-coach__title">코치 회의</h3>
      <ul className="tb-coach__list">
        {advice.map((a, i) => (
          <li key={`${a.coach}-${i}`} className="tb-coach__card">
            <div className="tb-coach__role">{a.coach}</div>
            <p className="tb-coach__rationale">{a.rationale}</p>
            <p className="tb-coach__proposal">{a.proposal}</p>
            <button type="button" className="tb-coach__adopt" onClick={() => adopt(a.apply)}>
              채택
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="tb-coach__dismiss" onClick={() => setDismissed(true)}>
        감독 판단대로 간다
      </button>
    </section>
  )
}
