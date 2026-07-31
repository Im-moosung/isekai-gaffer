import { useCallback, useEffect, useRef, useState } from 'react'
import { DndContext, useDraggable, useDroppable, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import type { Team, TacticState, FormationId, LineupSlot, Player, Position } from '../../engine/types'
import { slotCoords } from '../pitch/formations'
import { swapPlayers, substitute, autoFill, fitLevel } from './swap'
import { PlayerCard } from '../common/PlayerCard'
import { PlayerCompare, type ComparePlayer } from '../common/PlayerCompare'
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
 *  LineupScreen(레거시 단독 화면)과 TacticsCenter(선발 탭)가 같은 UI를 공유하기 위한 추출이다.
 *
 *  ══ 조작 언어 (docs/superpowers/specs/2026-07-31-squad-interaction.md가 정본) ══
 *
 *  | 조작            | 결과                                    |
 *  |-----------------|-----------------------------------------|
 *  | 드래그앤드롭    | 즉시 실행 (교체 / 자리 바꾸기)          |
 *  | 1명 클릭        | 선수 상세                               |
 *  | 2명 클릭        | 나란히 비교 + 실행 버튼 활성화          |
 *  | 실행 버튼       | 확정                                    |
 *
 *  ★ **클릭 → 클릭은 절대 교체하지 않는다.** 이전 판이 그렇게 동작했고, 상세를 보려고
 *  두 번째 선수를 누른 순간 라인업이 바뀌는 사고가 났다. 클릭은 정보를 여는 동작이고,
 *  변경은 드래그앤드롭이거나 명시적 버튼이다. 실수로 교체되는 경로 자체를 없앤 것이 목적이다.
 *
 *  ★ **버튼은 접근성 우회로가 아니라 정규 경로다.** 드래그앤드롭만 두면 키보드·터치
 *  사용자가 교체를 할 수 없다(390px에서 드래그는 사실상 불가능하다). 마우스 사용자도
 *  비교를 읽고 누르는 쪽이 자연스럽다 — 그래서 숨긴 대체 경로를 따로 만들지 않았다.
 *
 *  ★ 키보드로도 드래그앤드롭을 한다: 포커스 → **스페이스**로 집고 → **화살표**로 대상을
 *  옮긴 뒤 → **스페이스**로 놓는다(Esc 취소). 스페이스는 preventDefault로 click을 막아
 *  "집기"에 배타적으로 쓰고, **엔터**는 click으로 흘려 보내 선택(비교)에 쓴다.
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
  // 선택은 **최대 2명, 클릭 순서 보존**이다. 순서가 비교 뷰의 좌/우와 배지 번호를 정한다.
  const [selection, setSelection] = useState<string[]>([])
  // 키보드로 "집은" 선수. 드래그의 pointerdown에 대응한다(놓기 전까지 아무것도 바뀌지 않는다).
  const [grabbed, setGrabbed] = useState<string | null>(null)
  // 벤치 상세는 선택과 별개다 — 행 클릭은 선택, [상세]는 목록 안에서 능력치를 펼친다.
  const [detail, setDetail] = useState<string | null>(null)
  // 스크린리더 안내. 키보드 조작은 시각 피드백이 없으면 무슨 일이 일어났는지 알 수 없다.
  const [say, setSay] = useState('')
  // 키보드 이동 후 포커스를 옮길 대상. 같은 id를 연속 요청할 수 있어 카운터를 함께 둔다.
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null)

  // 클릭 드래그 오인 방지: 4px 이동 후에야 드래그 시작(짧은 탭은 선택으로).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const { formation, lineup } = tactics
  const byId = (id: string): Player | undefined => team.squad.find(p => p.id === id)
  const lineupIds = new Set(lineup.map(l => l.playerId))
  const bench = team.squad.filter(p => !lineupIds.has(p.id))
  const slotOf = (id: string): Position | undefined => lineup.find(l => l.playerId === id)?.slot

  const setLineup = (next: LineupSlot[]) => onChange({ ...tactics, lineup: next })

  const banned = new Set(unavailableIds ?? [])
  const suspendedBench = bench.filter(p => banned.has(p.id))
  const chipInput = (id: string): StatusInput => ({
    suspended: banned.has(id),
    cautions: cautionByPlayer?.[id] ?? 0,
    morale: moraleByPlayer?.[id],
  })

  // ── 포커스 레지스트리 ──────────────────────────────────────────
  // 화살표 이동은 DOM 셀렉터가 아니라 등록된 노드로 옮긴다. 선수 id에 셀렉터 이스케이프가
  // 필요한 문자가 섞여도(데이터 출처가 바뀌어도) 깨지지 않는다.
  const nodes = useRef(new Map<string, HTMLElement>())
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el)
    else nodes.current.delete(id)
  }, [])
  useEffect(() => {
    if (!focusReq) return
    nodes.current.get(focusReq.id)?.focus()
  }, [focusReq])

  function changeFormation(f: FormationId) {
    // 라인업 편집기는 킥오프 전에만 열린다 — 벤치 투입이 자유로운 시점이므로 후보는
    // 스쿼드 전체다(기본 scope 'squad'). 현재 선발은 적합도가 같을 때만 유지된다.
    // 자동 배치도 정지 선수를 세우면 안 된다 — 잠근 자리로 자동으로 들어가면 잠금이 무의미하다.
    onChange({ ...tactics, formation: f, lineup: autoFill(team, f, lineup.map(l => l.playerId), 'squad', unavailableIds) })
    reset()
  }

  const reset = () => { setSelection([]); setGrabbed(null) }

  /** 두 선수 id 사이의 이동을 상황(선발/벤치)에 맞는 순수 함수로 분기 적용.
   *  드래그앤드롭·실행 버튼·키보드 놓기 **세 경로가 전부 여기로 모인다** — 규칙이
   *  갈리면 같은 조작이 경로마다 다른 결과를 낸다. 돌려주는 값은 안내 문장이다. */
  function applyMove(aId: string, bId: string): string {
    if (aId === bId) return ''
    // 정지 선수는 어느 경로로도 선발이 될 수 없다. 한 곳에서 막는다.
    if (banned.has(aId) || banned.has(bId)) return '출장정지 선수는 세울 수 없습니다.'
    const a = byId(aId)
    const b = byId(bId)
    if (!a || !b) return ''
    const aStarter = lineupIds.has(aId)
    const bStarter = lineupIds.has(bId)
    if (aStarter && bStarter) {
      setLineup(swapPlayers(lineup, aId, bId))
      return `${a.name.ko}와 ${b.name.ko}의 자리를 바꿨습니다.`
    }
    if (aStarter && !bStarter) {
      setLineup(substitute(lineup, aId, bId))
      return `${a.name.ko}를 빼고 ${b.name.ko}를 넣었습니다.`
    }
    if (!aStarter && bStarter) {
      setLineup(substitute(lineup, bId, aId))
      return `${b.name.ko}를 빼고 ${a.name.ko}를 넣었습니다.`
    }
    return '둘 다 벤치입니다 — 바꿀 자리가 없습니다.'
  }

  /** 클릭 — **정보를 여는 동작**이다. 라인업을 바꾸지 않는다.
   *  1명: 상세 / 2명: 비교 + 실행 버튼 / 3번째: 새 선택으로 초기화(누적하지 않는다). */
  function handleClick(id: string) {
    if (banned.has(id)) return
    setSelection(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id)
      if (prev.length >= 2) return [id]
      return [...prev, id]
    })
  }

  /** 키보드 드래그앤드롭 — 스페이스로 집고, 화살표로 옮기고, 스페이스로 놓는다.
   *
   *  화살표 순서는 **선발 11인(라인업 배열 순) → 벤치(목록 순)** 1차원이다. 피치는
   *  2차원이지만 라인업 배열이 이미 GK→수비→중원→공격 순이라 위아래 이동과 대체로
   *  일치하고, 무엇보다 "다음/이전"이 결정론적이어서 예측 가능하다. 정지 선수는
   *  애초에 disabled라 포커스를 받지 않으므로 순회에서도 뺀다. */
  function handleKeyDown(id: string, e: React.KeyboardEvent) {
    if (e.key === ' ' || e.key === 'Spacebar') {
      // 버튼의 기본 스페이스 동작은 click이다. 막지 않으면 집기와 선택이 동시에 일어난다.
      e.preventDefault()
      if (grabbed == null) {
        setGrabbed(id)
        setSay(`${byId(id)?.name.ko ?? ''} 집었습니다. 화살표로 대상을 고르고 스페이스로 놓으십시오. Esc 취소.`)
      } else if (grabbed === id) {
        setGrabbed(null)
        setSay('집기를 취소했습니다.')
      } else {
        const msg = applyMove(grabbed, id)
        setGrabbed(null)
        setSelection([])
        setSay(msg)
      }
      return
    }
    if (e.key === 'Escape') {
      if (grabbed != null) { e.preventDefault(); setGrabbed(null); setSay('집기를 취소했습니다.') }
      return
    }
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (dir === 0) return
    e.preventDefault()
    const order = [...lineup.map(l => l.playerId), ...bench.map(p => p.id)].filter(x => !banned.has(x))
    const i = order.indexOf(id)
    if (i < 0) return
    // 같은 대상을 연속 요청할 수 있으므로(끝에서 되돌아오기) 카운터로 effect를 깨운다.
    // 함수형 갱신이라 화살표가 렌더 사이에 두 번 들어와도 n이 겹치지 않는다.
    const next = order[(i + dir + order.length) % order.length]
    setFocusReq(prev => ({ id: next, n: (prev?.n ?? 0) + 1 }))
  }

  function handleDragEnd(e: DragEndEvent) {
    const a = e.active?.id
    const b = e.over?.id
    reset()
    if (a != null && b != null) setSay(applyMove(String(a), String(b)))
  }

  // ── 선택 결과 패널 ────────────────────────────────────────────
  const selPlayers = selection.map(byId).filter((p): p is Player => !!p)
  const pair: [ComparePlayer, ComparePlayer] | null = selPlayers.length === 2
    ? [
        { player: selPlayers[0], slot: slotOf(selPlayers[0].id), status: chipInput(selPlayers[0].id) },
        { player: selPlayers[1], slot: slotOf(selPlayers[1].id), status: chipInput(selPlayers[1].id) },
      ]
    : null
  // 실행 버튼의 라벨과 동작을 선택 조합이 정한다(규약 표).
  const bothStarters = !!pair && !!pair[0].slot && !!pair[1].slot
  const bothBench = !!pair && !pair[0].slot && !pair[1].slot
  const actionLabel = bothStarters ? '자리 바꾸기' : '교체하기'

  function runAction() {
    if (!pair || bothBench) return
    const msg = applyMove(pair[0].player.id, pair[1].player.id)
    setSelection([])
    setSay(msg)
  }

  const detailPlayer = detail ? byId(detail) : undefined

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className={`lu-root${embedded ? ' lu-root--embed' : ''}`}>
        <div className="lu-top">
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

          {/* 조작 안내는 상시 노출한다. 드래그앤드롭·클릭·키보드 세 경로가 각각 다른 일을
              하므로, 규칙을 모른 채 만지면 "왜 안 바뀌지"가 된다. */}
          <p className="lu-howto" id="lu-howto">
            드래그해서 놓으면 <b>바로 교체·자리 이동</b>, 클릭하면 <b>선수 상세</b>,
            {' '}두 명을 클릭하면 <b>비교</b>가 뜨고 실행 버튼이 켜집니다.
            {/* 390px에서는 이 문장을 접는다 — 화면 키보드로는 쓸 수 없는 경로인데
                세로 예산을 한 줄 더 먹는다. 기능은 그대로 살아 있다. */}
            <span className="lu-howto__kb">
              {' '}키보드는 <kbd>스페이스</kbd>로 집고 <kbd>←→</kbd>로 옮긴 뒤 <kbd>스페이스</kbd>로 놓습니다.
            </span>
          </p>
          <span className="sr-only" role="status" aria-live="polite">{say}</span>
        </div>

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
                  order={selection.indexOf(slot.playerId)}
                  grabbed={grabbed === slot.playerId}
                  suspended={banned.has(slot.playerId)}
                  register={register}
                  onClick={() => handleClick(slot.playerId)}
                  onKeyDown={e => handleKeyDown(slot.playerId, e)}
                />
              )
            })}
          </div>
        </div>

        {/* 선택 결과는 피치 위 팝오버가 아니라 별도 열/흐름에 둔다 — 피치가
            overflow:hidden이라 겹쳐 놓으면 카드 하단(체력·사기)이 매번 잘렸다.
            넓은 화면에서는 피치 오른쪽 열이 되어(lineup.css) 보드를 보면서 비교한다. */}
        <div className="lu-selcol">
          {pair && (
            <div className="lu-sel lu-sel--cmp">
              <PlayerCompare
                a={pair[0]}
                b={pair[1]}
                stamina={staminaByPlayer}
                morale={moraleByPlayer}
                cautions={cautionByPlayer}
                action={
                  <>
                    {/* 화면당 primary는 [킥오프] 하나다(shell.css 규칙). 이 버튼은 선발 탭
                        안의 국소 확정이므로 secondary를 쓰되, 390px에서는 전폭으로 펴서
                        주 경로임을 분명히 한다(CSS). */}
                    <button
                      type="button"
                      className="btn btn--secondary btn--lg lu-exec"
                      disabled={bothBench}
                      onClick={runAction}
                    >
                      {actionLabel}
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => setSelection([])}>
                      선택 해제
                    </button>
                    {bothBench && (
                      <span className="lu-exec__hint">둘 다 벤치입니다 — 선발 한 명을 함께 고르십시오.</span>
                    )}
                  </>
                }
              />
            </div>
          )}
          {!pair && selPlayers.length === 1 && (
            <div className="lu-sel lu-pop" role="group" aria-label="선수 카드">
              <PlayerCard
                player={selPlayers[0]}
                slot={slotOf(selPlayers[0].id) ?? selPlayers[0].position}
                stamina={staminaByPlayer?.[selPlayers[0].id]}
                morale={moraleByPlayer?.[selPlayers[0].id]}
              />
              <p className="lu-sel__next">한 명을 더 클릭하면 나란히 비교합니다.</p>
            </div>
          )}
          {selPlayers.length === 0 && (
            <FitAudit lineup={lineup} byId={byId} onPick={handleClick} />
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
                    order={selection.indexOf(player.id)}
                    grabbed={grabbed === player.id}
                    expanded={detail === player.id}
                    register={register}
                    onClick={() => handleClick(player.id)}
                    onKeyDown={e => handleKeyDown(player.id, e)}
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

/** 배치 점검 — 아무도 선택하지 않았을 때 선택 열에 놓이는 패널.
 *
 *  ★ 왜 여기에 무언가를 놓는가: 넓은 화면에서 이 열은 비교가 뜰 자리다. 비워 두면
 *  1440px에서 500px 넘는 빈 공간이 생긴다(감사 W-7이 지적한 바로 그 결함). 그렇다고
 *  장식을 채우면 잡음이다. 그래서 **이 화면의 본래 질문**을 채운다 — "지금 자리에
 *  안 맞는 선수가 누구인가". 각 줄은 그 선수를 선택하는 버튼이라 곧바로 비교로 이어진다.
 *
 *  적합도가 전부 good이면 목록 대신 한 줄로 끝낸다. 이상 없음이 그 자체로 신호다
 *  (상태 칩과 같은 규칙 — 나쁠 때만 말한다). */
function FitAudit({ lineup, byId, onPick }: {
  lineup: LineupSlot[]
  byId(id: string): Player | undefined
  onPick(id: string): void
}) {
  const rows = lineup
    .map(l => ({ slot: l.slot, player: byId(l.playerId) }))
    .filter((r): r is { slot: Position; player: Player } => !!r.player)
    .map(r => ({ ...r, level: fitLevel(r.player, r.slot) }))
    .filter(r => r.level !== 'good')

  return (
    <section className="lu-sel lu-audit section" aria-label="배치 점검">
      <header className="lu-audit__head section__head">
        <h3 className="section__title">배치 점검</h3>
        <span className="section__meta">
          {rows.length > 0 ? `주의 ${rows.length}자리` : '11자리 이상 없음'}
        </span>
      </header>
      {rows.length === 0 ? (
        <p className="lu-audit__ok">
          선발 11인이 모두 주 포지션 또는 익숙한 자리에 있습니다.
          선수를 클릭하면 상세, 두 명을 클릭하면 비교가 여기에 뜹니다.
        </p>
      ) : (
        <ul className="lu-audit__list">
          {rows.map(r => (
            <li key={r.player.id}>
              <button
                type="button"
                className={`lu-audit__row lu-audit__row--${r.level}`}
                onClick={() => onPick(r.player.id)}
              >
                <span className="lu-audit__slot">{r.slot}</span>
                <span className="lu-audit__name">{r.player.name.ko}</span>
                <span className="lu-audit__pos">주 {r.player.position}</span>
                <span className="lu-audit__level">{r.level === 'bad' ? '부적합' : '차선'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
function useDragDrop(id: string, register: (id: string, el: HTMLElement | null) => void) {
  const drag = useDraggable({ id })
  const drop = useDroppable({ id })
  const setRef = (el: HTMLElement | null) => { drag.setNodeRef(el); drop.setNodeRef(el); register(id, el) }
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

/** 선택 순서 배지(1·2). 비교 뷰 좌/우와 같은 숫자를 쓴다 — 피치와 비교표를 오갈 때
 *  "왼쪽이 누구였지"를 다시 찾지 않게 한다. order가 음수면 미선택이라 렌더하지 않는다. */
function OrderBadge({ order }: { order: number }) {
  if (order < 0) return null
  return <span className="lu-ord num" aria-hidden="true">{order + 1}</span>
}

interface PickProps {
  order: number
  grabbed: boolean
  register(id: string, el: HTMLElement | null): void
  onClick(): void
  onKeyDown(e: React.KeyboardEvent): void
}

function PitchChip({
  player, slot, left, top, stamina, status, suspended, order, grabbed, register, onClick, onKeyDown,
}: {
  player: Player; slot: Position; left: number; top: number; stamina?: number
  status?: StatusInput
  suspended?: boolean
} & PickProps) {
  const { setRef, attributes, listeners, isDragging, isOver, dragStyle } = useDragDrop(player.id, register)
  const level = fitLevel(player, slot)
  const staLabel = stamina != null ? ` 체력 ${Math.round(stamina)}` : ''
  const cls = [
    'lu-chip', `lu-chip--${level}`,
    order >= 0 ? 'lu-chip--sel' : '',
    grabbed ? 'lu-chip--grab' : '',
    isOver ? 'lu-chip--over' : '',
    isDragging ? 'lu-chip--drag' : '',
    suspended ? 'lu-chip--susp' : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      ref={setRef}
      type="button"
      className={cls}
      style={{ left: `${left}%`, top: `${top}%`, ...dragStyle }}
      {...attributes}
      {...listeners}
      aria-label={`${player.name.ko} ${slot} 적합도 ${level}${staLabel}${suspended ? ' 출장정지' : ''}${grabbed ? ' 집음' : ''}`}
      aria-pressed={order >= 0}
      aria-describedby="lu-howto"
      aria-disabled={suspended || undefined}
      disabled={suspended}
      onClick={onClick}
      onKeyDown={onKeyDown}
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
      <OrderBadge order={order} />
    </button>
  )
}

/** 벤치 행 — 슬롯 ID(S1…)·번호·이름·포지션·컨디션 한 줄.
 *  행 자체는 선택·드래그, 오른쪽 [상세]는 목록 안 능력치 카드 토글이다.
 *  버튼 안에 버튼을 넣을 수 없어 형제로 둔다. */
function BenchRow({
  player, slotId, stamina, status, suspended, order, grabbed, expanded, register, onClick, onKeyDown, onToggleDetail,
}: {
  player: Player; slotId: string; stamina?: number; expanded: boolean
  status?: StatusInput
  /** 출장정지 — 행 자체를 비활성화하고 이유를 적는다. [상세]는 계속 열린다. */
  suspended?: boolean
  onToggleDetail(): void
} & PickProps) {
  const { setRef, attributes, listeners, isDragging, isOver, dragStyle } = useDragDrop(player.id, register)
  const staLabel = stamina != null ? ` 체력 ${Math.round(stamina)}` : ''
  const cls = [
    'lu-card',
    order >= 0 ? 'lu-card--sel' : '',
    grabbed ? 'lu-card--grab' : '',
    isOver ? 'lu-card--over' : '',
    isDragging ? 'lu-card--drag' : '',
    suspended ? 'lu-card--susp' : '',
  ].filter(Boolean).join(' ')
  return (
    <div className="lu-bench__row">
      <button
        ref={setRef}
        type="button"
        className={cls}
        style={dragStyle}
        {...attributes}
        {...listeners}
        aria-label={`${player.name.ko} ${player.position} 벤치 ${slotId}${staLabel}${suspended ? ' 출장정지' : ''}${grabbed ? ' 집음' : ''}`}
        aria-pressed={order >= 0}
        aria-describedby="lu-howto"
        aria-disabled={suspended || undefined}
        disabled={suspended}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span className="lu-card__slotid num">{slotId}</span>
        <span className="lu-card__num num">{player.number}</span>
        <span className="lu-card__name">{player.name.ko}</span>
        <span className="lu-card__pos">{player.position}</span>
        {stamina != null && <MiniStamina value={stamina} showValue />}
        {status && <StatusChips className="lu-card__sx" input={status} />}
        <OrderBadge order={order} />
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
