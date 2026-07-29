import { useState } from 'react'
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import type { Team, TacticState, FormationId, LineupSlot, Player, Position } from '../../engine/types'
import { slotCoords } from '../pitch/formations'
import { swapPlayers, substitute, autoFill, fitLevel } from './swap'
import { PlayerCard, PlayerRadar } from '../common/PlayerCard'
import './lineup.css'

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

interface LineupScreenProps {
  team: Team
  initial: TacticState
  onConfirm(t: TacticState): void
}

/** 선발 편집 UI(제어 컴포넌트). 자체 전술 상태를 갖지 않고 tactics를 받아 onChange로 올린다.
 *  LineupScreen(레거시 단독 화면)과 TacticsCenter(① 선발 탭)가 같은 UI를 공유하기 위한 추출이다.
 *
 *  포메이션 6종 전환(적합도순 자동 재배치) + 피치 미니뷰(home 슬롯 좌표 재사용) +
 *  드래그앤드롭·클릭 스왑 병행 + 슬롯별 적합도 경고 색. 상태 변경은 전부 swap.ts 순수 함수 경유.
 *  DnD 상호작용 자체는 수동 검증; 여기선 렌더·확정·순수 로직만 테스트한다.
 *
 *  @param embedded 전술 센터 탭 안에 끼워 넣는 모드 — 전체화면 높이·배경을 벗는다.
 *  @param staminaByPlayer 킥오프 전 컨디션(캠페인 이월 체력 포함). 주면 칩·벤치 카드에
 *    작은 게이지가 붙고 선택 카드에 체력 게이지가 뜬다 — 선발을 짜는 1차 근거라
 *    "카드를 열어야만 보이는" 정보로 두지 않는다.
 *  @param moraleByPlayer 사기(선택 카드 게이지에만 — 리스트까지 두 줄이면 칩이 뭉갠다). */
export function LineupEditor({ team, tactics, onChange, embedded, staminaByPlayer, moraleByPlayer }: {
  team: Team
  tactics: TacticState
  onChange(next: TacticState): void
  embedded?: boolean
  staminaByPlayer?: Record<string, number>
  moraleByPlayer?: Record<string, number>
}) {
  const [selected, setSelected] = useState<string | null>(null)

  // 클릭 드래그 오인 방지: 4px 이동 후에야 드래그 시작(짧은 탭은 클릭 스왑으로).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const { formation, lineup } = tactics
  const byId = (id: string): Player | undefined => team.squad.find(p => p.id === id)
  const lineupIds = new Set(lineup.map(l => l.playerId))
  const bench = team.squad.filter(p => !lineupIds.has(p.id))
  const selectedPlayer = selected ? byId(selected) : undefined
  const selectedSlot = selected ? lineup.find(l => l.playerId === selected)?.slot : undefined

  const setLineup = (next: LineupSlot[]) => onChange({ ...tactics, lineup: next })

  function changeFormation(f: FormationId) {
    // 라인업 편집기는 킥오프 전에만 열린다(워룸 ①선발 탭 / 레거시 단독 화면) —
    // 벤치 투입이 자유로운 시점이므로 후보는 스쿼드 전체다(기본 scope 'squad').
    // 현재 선발은 적합도가 같을 때만 유지된다. 경기 중 작전판은 'starters-only'를 쓴다.
    onChange({ ...tactics, formation: f, lineup: autoFill(team, f, lineup.map(l => l.playerId)) })
    setSelected(null)
  }

  /** 두 선수 id 사이의 이동을 상황(선발/벤치)에 맞는 순수 함수로 분기 적용. */
  function applyMove(aId: string, bId: string) {
    if (aId === bId) return
    const aStarter = lineupIds.has(aId)
    const bStarter = lineupIds.has(bId)
    if (aStarter && bStarter) setLineup(swapPlayers(lineup, aId, bId))
    else if (aStarter && !bStarter) setLineup(substitute(lineup, aId, bId)) // aId 아웃, bId 투입
    else if (!aStarter && bStarter) setLineup(substitute(lineup, bId, aId)) // bId 아웃, aId 투입
    // 벤치↔벤치: 변화 없음
  }

  function handleClick(id: string) {
    if (selected == null) { setSelected(id); return }
    if (selected === id) { setSelected(null); return }
    applyMove(selected, id)
    setSelected(null)
  }

  function handleDragEnd(e: DragEndEvent) {
    const a = e.active?.id
    const b = e.over?.id
    setSelected(null)
    if (a != null && b != null) applyMove(String(a), String(b))
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className={`lu-root${embedded ? ' lu-root--embed' : ''}`}>
        <header className="lu-head">
          <h2 className="lu-title">{team.name.ko} 선발 라인업</h2>
          <div className="lu-formations" role="group" aria-label="포메이션 선택">
            {FORMATIONS.map(f => (
              <button
                key={f}
                type="button"
                className={`lu-fbtn${f === formation ? ' lu-fbtn--active' : ''}`}
                aria-pressed={f === formation}
                onClick={() => changeFormation(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </header>

        <div className="lu-pitch" role="group" aria-label="선발 배치">
          {lineup.map((slot, i) => {
            const player = byId(slot.playerId)
            if (!player) return null
            const c = slotCoords(formation, i, 'home')
            return (
              <PitchChip
                key={slot.playerId}
                player={player}
                slot={slot.slot}
                x={c.x}
                y={c.y}
                stamina={staminaByPlayer?.[slot.playerId]}
                selected={selected === slot.playerId}
                onClick={() => handleClick(slot.playerId)}
              />
            )
          })}
          {selectedPlayer && (
            <div className="lu-pop" role="group" aria-label="선수 카드">
              <PlayerCard
                player={selectedPlayer}
                slot={selectedSlot ?? selectedPlayer.position}
                stamina={staminaByPlayer?.[selectedPlayer.id]}
                morale={moraleByPlayer?.[selectedPlayer.id]}
              />
            </div>
          )}
        </div>

        <section className="lu-bench" aria-label="벤치">
          <h3 className="lu-bench__title">벤치 ({bench.length})</h3>
          <div className="lu-bench__list">
            {bench.map(player => (
              <BenchCard
                key={player.id}
                player={player}
                stamina={staminaByPlayer?.[player.id]}
                selected={selected === player.id}
                onClick={() => handleClick(player.id)}
              />
            ))}
          </div>
        </section>
      </div>
    </DndContext>
  )
}

/** 선발 라인업 편집 화면(레거시 단독 화면) — LineupEditor + 로컬 draft + [라인업 확정].
 *  캠페인/데모 라우팅은 전술 센터로 흡수됐지만, 단독 편집 화면 계약은 그대로 유지한다. */
export function LineupScreen({ team, initial, onConfirm }: LineupScreenProps) {
  const [tactics, setTactics] = useState<TacticState>(initial)

  return (
    <div className="lu-screen">
      <LineupEditor team={team} tactics={tactics} onChange={setTactics} />
      <footer className="lu-foot">
        {/* 확정은 tactics 전체를 넘긴다 — mentality·groupIntensity 등 확장 필드 유실 방지. */}
        <button type="button" className="lu-confirm" onClick={() => onConfirm(tactics)}>
          라인업 확정
        </button>
      </footer>
    </div>
  )
}

/** 드래그(이동 소스) + 드롭(교환 타깃)을 겸하는 노드용 훅. dnd 변환은 core만으로 수동 계산. */
function useDragDrop(id: string) {
  const drag = useDraggable({ id })
  const drop = useDroppable({ id })
  const setRef = (el: HTMLElement | null) => { drag.setNodeRef(el); drop.setNodeRef(el) }
  const dragStyle = drag.transform
    ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 20 }
    : undefined
  return { setRef, attributes: drag.attributes, listeners: drag.listeners, isDragging: drag.isDragging, isOver: drop.isOver, dragStyle }
}

/** 체력 임계 — 40 미만은 경고, 70 미만은 주의. 교체 판단의 눈금이라 색으로만 구분한다
 *  (수치는 게이지 옆에 함께 적어 색맹 사용자도 읽을 수 있게 한다). */
function staminaTone(pct: number): 'low' | 'mid' | 'ok' {
  if (pct < 40) return 'low'
  if (pct < 70) return 'mid'
  return 'ok'
}

/** 리스트용 초소형 체력 게이지 — 칩·벤치 카드에 한 줄로 붙는다. */
function MiniStamina({ value, showValue }: { value: number; showValue?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  return (
    <span className="lu-sta" aria-label={`체력 ${pct}%`}>
      <span className="lu-sta__track">
        {/* 데이터 바인딩 폭(%)만 인라인 — pitch 기하 예외와 동일 취급. 색은 토큰. */}
        <span className={`lu-sta__bar lu-sta__bar--${staminaTone(pct)}`} style={{ width: `${pct}%` }} />
      </span>
      {showValue && <span className="lu-sta__val">{pct}</span>}
    </span>
  )
}

function PitchChip({ player, slot, x, y, stamina, selected, onClick }: {
  player: Player; slot: Position; x: number; y: number; stamina?: number
  selected: boolean; onClick(): void
}) {
  const { setRef, attributes, listeners, isDragging, isOver, dragStyle } = useDragDrop(player.id)
  const level = fitLevel(player, slot)
  const staLabel = stamina != null ? ` 체력 ${Math.round(stamina)}` : ''
  return (
    <button
      ref={setRef}
      type="button"
      className={`lu-chip lu-chip--${level}${selected ? ' lu-chip--sel' : ''}${isOver ? ' lu-chip--over' : ''}${isDragging ? ' lu-chip--drag' : ''}`}
      style={{ left: `${x}%`, top: `${y}%`, ...dragStyle }}
      {...attributes}
      {...listeners}
      aria-label={`${player.name.ko} ${slot} 적합도 ${level}${staLabel}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="lu-chip__num">{player.number}</span>
      <span className="lu-chip__name">{player.name.ko}</span>
      <span className="lu-chip__slot">{slot}</span>
      {stamina != null && <MiniStamina value={stamina} />}
    </button>
  )
}

function BenchCard({ player, stamina, selected, onClick }: {
  player: Player; stamina?: number; selected: boolean; onClick(): void
}) {
  const { setRef, attributes, listeners, isDragging, isOver, dragStyle } = useDragDrop(player.id)
  const staLabel = stamina != null ? ` 체력 ${Math.round(stamina)}` : ''
  return (
    <button
      ref={setRef}
      type="button"
      className={`lu-card${selected ? ' lu-card--sel' : ''}${isOver ? ' lu-card--over' : ''}${isDragging ? ' lu-card--drag' : ''}`}
      style={dragStyle}
      {...attributes}
      {...listeners}
      aria-label={`${player.name.ko} ${player.position} 벤치${staLabel}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      <span className="lu-card__head">
        <span className="lu-card__num">{player.number}</span>
        <span className="lu-card__name">{player.name.ko}</span>
        <span className="lu-card__pos">{player.position}</span>
      </span>
      <PlayerRadar player={player} className="lu-card__radar" />
      {stamina != null && <MiniStamina value={stamina} showValue />}
    </button>
  )
}
