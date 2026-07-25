import { useState } from 'react'
import type { FormationId, GroupIntensity, Mentality, Player, TacticState } from '../../engine/types'
import { canIntervene, useMatchStore } from '../../game/matchStore'
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

/** 플랜 대비 목록에 쓰는 지시 축·멘탈리티 한국어 라벨. */
const PLAN_AXIS_LABEL: Record<'lineHeight' | 'pressing' | 'tempo', string> = {
  lineHeight: '라인', pressing: '압박', tempo: '템포',
}
const PLAN_MENTALITY_KO: Record<Mentality, string> = {
  'very-defensive': '매우 수비적', 'defensive': '수비적', 'balanced': '균형',
  'attacking': '공격적', 'very-attacking': '매우 공격적',
}

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
  const matchPlan = useMatchStore(s => s.matchPlan)
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

      {/* 플랜 대비 — 킥오프 때 세운 계획과 지금의 차이를 축별로 보여준다.
          작전판에서 지시를 만질 때 "무엇을 계획했었는지"가 눈앞에 없으면
          이탈이 누적되는 줄도 모르고 매번 갈아엎게 된다. */}
      {matchPlan && <PlanDiff plan={matchPlan} current={home.tactics} />}

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
          // 작전판 이탈 애니메이션(600ms) 동안 버튼이 DOM에 남아 있어 연타가 가능하다.
          // 두 번째 클릭은 이미 phase가 'playing'이라 store가 throw한다 — 개입 가능할 때만 보낸다.
          disabled={!canIntervene(phase)}
          onClick={() => { if (canIntervene(phase)) confirmTactics() }}
        >
          {halftime ? '후반 시작' : '전술 확정'}
        </button>
      </footer>
    </div>
  )
}

/** 킥오프 플랜 대비 현재 전술의 차이 목록. 차이가 없으면 "계획대로 가는 중"을 명시한다
 *  — 아무것도 안 보여주면 유지 중인지 기능이 죽은 건지 구분되지 않는다. */
function PlanDiff({ plan, current }: { plan: TacticState; current: TacticState }) {
  const rows: string[] = []
  if (plan.formation !== current.formation) {
    rows.push(`계획: 포메이션 ${plan.formation} → 현재 ${current.formation}`)
  }
  const pm = plan.mentality ?? 'balanced', cm = current.mentality ?? 'balanced'
  if (pm !== cm) rows.push(`계획: 멘탈리티 ${PLAN_MENTALITY_KO[pm]} → 현재 ${PLAN_MENTALITY_KO[cm]}`)
  for (const k of ['lineHeight', 'pressing', 'tempo'] as const) {
    if (plan.instructions[k] !== current.instructions[k]) {
      rows.push(`계획: ${PLAN_AXIS_LABEL[k]} ${plan.instructions[k]} → 현재 ${current.instructions[k]}`)
    }
  }
  return (
    <section className="tb-plan" aria-label="플랜 대비">
      {rows.length === 0
        ? <span className="tb-plan__row tb-plan__row--ok">킥오프 플랜대로 가는 중 — 팀 이해도 +3%</span>
        : rows.map(r => <span key={r} className="tb-plan__row">{r}</span>)}
    </section>
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
