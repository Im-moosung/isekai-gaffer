import { useState } from 'react'
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import type { Team, TacticState, FormationId, LineupSlot, Player, Position } from '../../engine/types'
import { slotCoords } from '../pitch/formations'
import { swapPlayers, substitute, autoFill, fitLevel } from './swap'
import { PlayerCard } from '../common/PlayerCard'
import { StatusChips, type StatusInput } from '../common/StatusChips'
import './lineup.css'

const FORMATIONS: FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

interface LineupScreenProps {
  team: Team
  initial: TacticState
  onConfirm(t: TacticState): void
}

/** 세로 피치 좌표 변환 — 엔진 좌표는 가로(x: 자기 골 6 → 상대 골 94, y: 좌 0 → 우 100)다.
 *  보드는 세로로 세운다(우리 골이 아래, 공격 방향이 위). 카드가 절반씩 걸쳐 잘리지 않도록
 *  가장자리에서 안쪽으로 물린다 — GK(x=6)와 윙백(y=12/88)이 정확히 그 경계에 산다. */
function boardPos(x: number, y: number): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  return { left: clamp(y, 11, 89), top: clamp(100 - x, 5, 95) }
}

/** 긴 한글 이름은 성만 남긴다 — 칩 폭(피치 폭의 22%)에서 세 글자를 넘기면 잘린다.
 *  "옌스 카스트..." 같은 말줄임을 만드는 대신 의미가 남는 쪽을 고른다. */
function shortName(ko: string): string {
  const trimmed = ko.trim()
  if (trimmed.length <= 4) return trimmed
  const head = trimmed.split(/\s+/)[0]
  return head.length <= 4 ? head : trimmed.slice(0, 3)
}

/** 선발 편집 UI(제어 컴포넌트). 자체 전술 상태를 갖지 않고 tactics를 받아 onChange로 올린다.
 *  LineupScreen(레거시 단독 화면)과 TacticsCenter(선발 섹션)가 같은 UI를 공유하기 위한 추출이다.
 *
 *  ★ 재설계(감사 W-2·W-8·W-9·W-10): 보드는 다크 네이비 세로 피치 + 페널티 박스·골 에어리어,
 *  선수는 라인을 가리는 불투명 카드, 벤치는 슬롯 ID를 가진 행 리스트 + 가시 스크롤바.
 *  벤치 카드의 60px 육각 레이더(15명 전부 100 = 정보량 0)는 걷어내고, 능력치는 행의
 *  [상세] 버튼으로 펼치는 인라인 카드에서 본다 — FM26이 벤치에서 능력치 조회를 막아
 *  "CM 96/97에도 있던 기능"이라고 비판받은 것을 되풀이하지 않는다.
 *
 *  @param embedded 전술 센터 안에 끼워 넣는 모드 — 전체화면 높이·배경을 벗는다.
 *  @param staminaByPlayer 킥오프 전 컨디션(캠페인 이월 체력 포함).
 *  @param moraleByPlayer 사기. 상세 카드에는 게이지로, 목록에는 상태 칩으로 나간다.
 *  @param unavailableIds 출장정지 등 이번 경기에 쓸 수 없는 선수 — 선택·자동배치에서 잠근다.
 *  @param cautionByPlayer 대회 미소멸 누적 경고(선수 id → 장수).
 *
 *  ★ 상태 칩(StatusChips)에 **체력은 넣지 않는다.** 이 화면에는 이미 MiniStamina가
 *    같은 3단 눈금(40/70)으로 선발·벤치 전원에 붙어 있어, 칩까지 얹으면 같은 값이 한 행에
 *    두 번 나온다. 칩은 여기서 "체력만으로는 알 수 없는 것" — 징계·경고·사기 — 만 말한다.
 *    반대로 작전판 교체 탭(SubPanel)에는 숫자 눈금이 없으므로 거기서는 체력도 칩으로 낸다. */
export function LineupEditor({
  team, tactics, onChange, embedded, staminaByPlayer, moraleByPlayer, unavailableIds, cautionByPlayer,
}: {
  team: Team
  tactics: TacticState
  onChange(next: TacticState): void
  embedded?: boolean
  staminaByPlayer?: Record<string, number>
  moraleByPlayer?: Record<string, number>
  unavailableIds?: readonly string[]
  cautionByPlayer?: Record<string, number>
}) {
  const [selected, setSelected] = useState<string | null>(null)
  // 벤치 상세는 선택(교체)과 별개다 — 행 클릭은 교체 선택, [상세]는 능력치 열람.
  const [detail, setDetail] = useState<string | null>(null)

  // 클릭 드래그 오인 방지: 4px 이동 후에야 드래그 시작(짧은 탭은 클릭 스왑으로).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const { formation, lineup } = tactics
  const byId = (id: string): Player | undefined => team.squad.find(p => p.id === id)
  const lineupIds = new Set(lineup.map(l => l.playerId))
  const bench = team.squad.filter(p => !lineupIds.has(p.id))
  const selectedPlayer = selected ? byId(selected) : undefined
  const selectedSlot = selected ? lineup.find(l => l.playerId === selected)?.slot : undefined

  const setLineup = (next: LineupSlot[]) => onChange({ ...tactics, lineup: next })

  const banned = new Set(unavailableIds ?? [])
  const suspendedBench = bench.filter(p => banned.has(p.id))
  const chipInput = (id: string) => ({
    suspended: banned.has(id),
    cautions: cautionByPlayer?.[id] ?? 0,
    morale: moraleByPlayer?.[id],
  })

  function changeFormation(f: FormationId) {
    // 라인업 편집기는 킥오프 전에만 열린다 — 벤치 투입이 자유로운 시점이므로 후보는
    // 스쿼드 전체다(기본 scope 'squad'). 현재 선발은 적합도가 같을 때만 유지된다.
    // 자동 배치도 정지 선수를 세우면 안 된다 — 잠근 자리로 자동으로 들어가면 잠금이 무의미하다.
    onChange({ ...tactics, formation: f, lineup: autoFill(team, f, lineup.map(l => l.playerId), 'squad', unavailableIds) })
    setSelected(null)
  }

  /** 두 선수 id 사이의 이동을 상황(선발/벤치)에 맞는 순수 함수로 분기 적용. */
  function applyMove(aId: string, bId: string) {
    if (aId === bId) return
    // 정지 선수는 선발로 올라갈 수 없다. 클릭·드래그 양쪽이 여기로 모이므로 한 곳에서 막는다.
    if (banned.has(aId) || banned.has(bId)) return
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

  const detailPlayer = detail ? byId(detail) : undefined

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className={`lu-root${embedded ? ' lu-root--embed' : ''}`}>
        <header className="lu-head section__head">
          <h2 className="lu-title section__title">{team.name.ko} 선발 라인업</h2>
          <div className="lu-formations seg" role="group" aria-label="포메이션 선택">
            {FORMATIONS.map(f => (
              <button
                key={f}
                type="button"
                className="seg__item num"
                aria-pressed={f === formation}
                onClick={() => changeFormation(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </header>

        <div className="lu-boardcol">
          <div className="lu-pitch" role="group" aria-label="선발 배치">
            <PitchMarkings />
            {lineup.map((slot, i) => {
              const player = byId(slot.playerId)
              if (!player) return null
              const c = slotCoords(formation, i, 'home')
              const pos = boardPos(c.x, c.y)
              return (
                <PitchChip
                  key={slot.playerId}
                  player={player}
                  slot={slot.slot}
                  left={pos.left}
                  top={pos.top}
                  stamina={staminaByPlayer?.[slot.playerId]}
                  status={chipInput(slot.playerId)}
                  selected={selected === slot.playerId}
                  onClick={() => handleClick(slot.playerId)}
                />
              )
            })}
          </div>

          {/* 선택 카드는 피치 위 팝오버가 아니라 아래 흐름에 둔다 — 피치가
              overflow:hidden이라 겹쳐 놓으면 카드 하단(체력·사기)이 매번 잘렸다. */}
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

        <section className="lu-bench section" aria-label="벤치">
          <header className="lu-bench__head section__head">
            <h3 className="lu-bench__title section__title">벤치</h3>
            {/* 스크롤 컨테이너에는 반드시 전체 개수를 붙인다 — 4명만 보이는데
                총원이 몇인지 모르면 스크롤할 이유 자체가 전달되지 않는다. */}
            <span className="lu-bench__count section__meta">
              전체 <span className="num">{bench.length}</span>명 · S1–S{bench.length}
              {/* 정지자가 있으면 헤더에서 먼저 말한다 — 목록을 끝까지 훑어야 알 수 있으면
                  "왜 이 선수가 안 골라지지"를 스크롤하다가 발견하게 된다. */}
              {suspendedBench.length > 0 && (
                <>
                  {' · '}
                  <span className="lu-bench__susp">
                    출장정지 <span className="num">{suspendedBench.length}</span>명
                    {' '}({suspendedBench.map(p => p.name.ko).join(', ')})
                  </span>
                </>
              )}
            </span>
          </header>
          <div className="lu-bench__pane scroll-pane">
            <ul className="lu-bench__list scroll-y">
              {bench.map((player, i) => (
                <li key={player.id} className="lu-bench__item">
                  <BenchRow
                    player={player}
                    slotId={`S${i + 1}`}
                    stamina={staminaByPlayer?.[player.id]}
                    status={chipInput(player.id)}
                    suspended={banned.has(player.id)}
                    selected={selected === player.id}
                    expanded={detail === player.id}
                    onClick={() => handleClick(player.id)}
                    onToggleDetail={() => setDetail(detail === player.id ? null : player.id)}
                  />
                  {detail === player.id && detailPlayer && (
                    <div className="lu-bench__detail">
                      <PlayerCard
                        player={detailPlayer}
                        size="compact"
                        stamina={staminaByPlayer?.[detailPlayer.id]}
                        morale={moraleByPlayer?.[detailPlayer.id]}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <span className="scroll-pane__fade" aria-hidden="true" />
          </div>
        </section>
      </div>
    </DndContext>
  )
}

/** 세로 피치 마킹 — 하프라인·센터서클만으로는 절대 위치를 읽을 수 없다.
 *  페널티 박스·골 에어리어·페널티 스폿까지 실제 규격(68×105m)으로 그린다. */
function PitchMarkings() {
  return (
    <svg className="lu-pitch__lines" viewBox="0 0 68 105" aria-hidden="true" focusable="false">
      <rect className="lu-pitch__line" x="1.5" y="1.5" width="65" height="102" />
      <line className="lu-pitch__line" x1="1.5" y1="52.5" x2="66.5" y2="52.5" />
      <circle className="lu-pitch__line" cx="34" cy="52.5" r="9.15" />
      <circle className="lu-pitch__spot" cx="34" cy="52.5" r="0.7" />
      {/* 우리 진영(아래) */}
      <rect className="lu-pitch__line" x="13.84" y="87" width="40.32" height="16.5" />
      <rect className="lu-pitch__line" x="24.84" y="98" width="18.32" height="5.5" />
      <circle className="lu-pitch__spot" cx="34" cy="92.5" r="0.7" />
      {/* 상대 진영(위) */}
      <rect className="lu-pitch__line" x="13.84" y="1.5" width="40.32" height="16.5" />
      <rect className="lu-pitch__line" x="24.84" y="1.5" width="18.32" height="5.5" />
      <circle className="lu-pitch__spot" cx="34" cy="12.5" r="0.7" />
    </svg>
  )
}

/** 선발 라인업 편집 화면(레거시 단독 화면) — LineupEditor + 로컬 draft + [라인업 확정]. */
export function LineupScreen({ team, initial, onConfirm }: LineupScreenProps) {
  const [tactics, setTactics] = useState<TacticState>(initial)

  return (
    <div className="lu-screen">
      <LineupEditor team={team} tactics={tactics} onChange={setTactics} />
      <footer className="lu-foot">
        {/* 확정은 tactics 전체를 넘긴다 — mentality·groupIntensity 등 확장 필드 유실 방지. */}
        <button type="button" className="btn btn--primary btn--lg" onClick={() => onConfirm(tactics)}>
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

/** 체력 임계 — 40 미만 위험 / 70 미만 주의 / 이상 양호.
 *  PlayerCard의 conditionTone과 같은 눈금이다(임계가 갈리면 같은 선수가 화면마다
 *  다른 색으로 보인다). 값을 바꾸면 양쪽을 함께 바꿔라. */
function staminaTone(pct: number): 'low' | 'mid' | 'ok' {
  if (pct < 40) return 'low'
  if (pct < 70) return 'mid'
  return 'ok'
}

/** 리스트용 컨디션 표시.
 *  ★ 100%에 100% 만재 바를 그리지 않는다 — 15명 전원 풀바는 정보량이 0인데 면적만 먹는다.
 *  등급 텍스트 + (100 미만일 때만) 바 + 수치. Hattrick의 텍스트 등급 방식. */
function MiniStamina({ value, showValue }: { value: number; showValue?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  const tone = staminaTone(pct)
  return (
    <span className={`lu-sta lu-sta--${tone}`} aria-label={`체력 ${pct}%`}>
      {pct < 100 && (
        <span className="lu-sta__track">
          {/* 데이터 바인딩 폭(%)만 인라인 — pitch 기하 예외와 동일 취급. 색은 토큰. */}
          <span className={`lu-sta__bar lu-sta__bar--${tone}`} style={{ width: `${pct}%` }} />
        </span>
      )}
      {showValue && <span className="lu-sta__val num">{pct}</span>}
    </span>
  )
}

function PitchChip({ player, slot, left, top, stamina, status, selected, onClick }: {
  player: Player; slot: Position; left: number; top: number; stamina?: number
  status?: StatusInput
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
      style={{ left: `${left}%`, top: `${top}%`, ...dragStyle }}
      {...attributes}
      {...listeners}
      aria-label={`${player.name.ko} ${slot} 적합도 ${level}${staLabel}`}
      aria-pressed={selected}
      onClick={onClick}
    >
      {/* 번호·포지션을 윗줄에 묶고 이름에 아랫줄 전폭을 준다 — 한 줄에 셋을 넣으면
          칩 폭(피치의 19%)에서 이름이 가장 먼저 잘린다("옌스 카스트…"). */}
      <span className="lu-chip__line">
        <span className="lu-chip__num num">{player.number}</span>
        <span className="lu-chip__slot">{slot}</span>
      </span>
      <span className="lu-chip__name">{shortName(player.name.ko)}</span>
      {stamina != null && <MiniStamina value={stamina} />}
      {status && <StatusChips className="lu-chip__sx" input={status} />}
    </button>
  )
}

/** 벤치 행 — 슬롯 ID(S1…)·번호·이름·포지션·컨디션 한 줄.
 *  행 자체는 교체 선택(드래그·클릭), 오른쪽 [상세]는 능력치 카드 토글이다.
 *  버튼 안에 버튼을 넣을 수 없어 형제로 둔다. */
function BenchRow({ player, slotId, stamina, status, suspended, selected, expanded, onClick, onToggleDetail }: {
  player: Player; slotId: string; stamina?: number; selected: boolean; expanded: boolean
  status?: StatusInput
  /** 출장정지 — 행 자체를 비활성화하고 이유를 적는다. [상세]는 계속 열린다. */
  suspended?: boolean
  onClick(): void; onToggleDetail(): void
}) {
  const { setRef, attributes, listeners, isDragging, isOver, dragStyle } = useDragDrop(player.id)
  const staLabel = stamina != null ? ` 체력 ${Math.round(stamina)}` : ''
  return (
    <div className="lu-bench__row">
      <button
        ref={setRef}
        type="button"
        className={`lu-card${selected ? ' lu-card--sel' : ''}${isOver ? ' lu-card--over' : ''}${isDragging ? ' lu-card--drag' : ''}${suspended ? ' lu-card--susp' : ''}`}
        style={dragStyle}
        {...attributes}
        {...listeners}
        aria-label={`${player.name.ko} ${player.position} 벤치 ${slotId}${staLabel}${suspended ? ' 출장정지' : ''}`}
        aria-pressed={selected}
        aria-disabled={suspended || undefined}
        disabled={suspended}
        onClick={onClick}
      >
        <span className="lu-card__slotid num">{slotId}</span>
        <span className="lu-card__num num">{player.number}</span>
        <span className="lu-card__name">{player.name.ko}</span>
        <span className="lu-card__pos">{player.position}</span>
        {stamina != null && <MiniStamina value={stamina} showValue />}
        {status && <StatusChips className="lu-card__sx" input={status} />}
      </button>
      <button
        type="button"
        className="lu-detail btn btn--ghost btn--sm"
        aria-expanded={expanded}
        aria-label={`${player.name.ko} 능력치 ${expanded ? '접기' : '펼치기'}`}
        onClick={onToggleDetail}
      >
        상세
      </button>
    </div>
  )
}
