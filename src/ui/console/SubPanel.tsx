import { useState } from 'react'
import { useMatchStore } from '../../game/matchStore'
import { MAX_SUBS, MAX_SUB_WINDOWS } from '../../engine/simulate'
import type { MatchEvent, Player, SideState } from '../../engine/types'
import { playerMatchStats, hasPlayerMatchStats, subbedOffIds, type PlayerMatchStats } from '../../game/playerStats'
import { StatusChips } from '../common/StatusChips'
import '../shell/shell.css'
import './console.css'

/** 퇴장 선수 교체 불가 — 엔진(simulate.applyCommand)이 던지는 규칙을 고르기 전에 말한다.
 *  왜 막히는지에 더해 "그래서 어떻게 되는가"까지 붙인다(문구 컨벤션). */
const SENT_OFF_REASON = '퇴장당한 선수는 교체로 뺄 수 없습니다 — 그 자리는 메울 수 없고 남은 시간을 수적 열세로 치릅니다.'

interface SubPanelProps {
  side: 'home' | 'away'
  /** 제어 모드(작전판 보드 연동): 지정 시 선택 상태를 상위(TacticsBoard)가 소유한다. */
  outId?: string | null
  inId?: string | null
  onSelectOut?: (id: string) => void
  onSelectIn?: (id: string) => void
  /** 교체 확정 성공 후 콜백(상위 상태 리셋). */
  onConfirmed?: () => void
}

/** 교체 패널 — 라인업 11인 카드(이름·번호·포지션·체력바) + 벤치.
 *  아웃(라인업)/인(벤치) 선택 → "교체 확정" → submitCommand({type:'sub'}).
 *  제어 모드(onSelectOut/onSelectIn 제공)면 선택 상태를 상위가 소유해 보드 하이라이트·
 *  고스트 미리보기와 동기화한다. 미제공 시 내부 state로 독립 동작(기존 호환). */
export function SubPanel({ side, outId, inId, onSelectOut, onSelectIn, onConfirmed }: SubPanelProps) {
  const phase = useMatchStore(s => s.phase)
  const engine = useMatchStore(s => s.engine)
  const submitCommand = useMatchStore(s => s.submitCommand)
  // 캠페인 징계 — 정지 선수는 벤치에 있어도 투입할 수 없고, 누적 경고는 칩으로 보인다.
  const discipline = useMatchStore(s => s.discipline)

  const controlled = !!(onSelectOut && onSelectIn)
  const [outLocal, setOutLocal] = useState<string | null>(null)
  const [inLocal, setInLocal] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 배너가 이미 띄우고 있는 문장을 에러 슬롯에 한 번 더 적으면 같은 문장이 두 줄로 겹친다
  // (실캡처에서 확인). 대신 배너를 한 번 흔들어 "네 클릭은 도착했고, 답은 저 위에 있다"를
  // 말한다. 카운터가 증가할 때마다 key가 바뀌어 애니메이션이 다시 재생된다.
  const [nudge, setNudge] = useState(0)

  const out = controlled ? outId ?? null : outLocal
  const inSel = controlled ? inId ?? null : inLocal
  const pickOut = (id: string) => (controlled ? onSelectOut!(id) : setOutLocal(id))
  const pickIn = (id: string) => (controlled ? onSelectIn!(id) : setInLocal(id))

  const open = phase === 'halftime' || phase === 'paused-break' || phase === 'paused-user' || phase === 'paused-moment'
  const state: SideState | undefined = engine?.[side]
  // 개인 기록은 "누구를 뺄까"의 근거다 — 카드를 열어야만 보이면 늦다. 진행 전엔 데이터가 없다.
  const events: MatchEvent[] | null = engine && engine.minute > 0 ? engine.events : null
  if (!state) return <section className="cs-panel" aria-label="교체" />

  const squad = state.team.squad
  const byId = (id: string) => squad.find(p => p.id === id)
  const lineupIds = state.tactics.lineup.map(l => l.playerId)
  const lineup = state.tactics.lineup
    .map(l => ({ slot: l.slot, player: byId(l.playerId) }))
    .filter((x): x is { slot: Player['position']; player: Player } => !!x.player)
  const bench = squad.filter(p => !lineupIds.includes(p.id))

  // IFAB 제3조 — 교체로 나간 선수는 그 경기에 다시 못 들어온다. 벤치는 "선발이 아닌
  // 전원"이라 나간 선수도 그대로 벤치에 다시 나타났다(감사 재현: 손흥민 OUT 후 재선택 가능).
  // ★ 목록에서 지우지 않고 잠그는 이유: 이 카드에는 방금 뺀 선수의 이 경기 기록
  //   (골·도움·슛)이 붙어 있고, 그게 "그 교체가 옳았나"를 되짚는 유일한 자리다.
  //   행이 통째로 사라지면 기록도 함께 사라지고, 사라진 행은 규칙이 아니라 버그로 읽힌다.
  const subbedOff = new Set(engine ? subbedOffIds(engine.events, state.team.id) : [])
  // 상대 벤치에는 우리 징계가 적용되지 않는다(캠페인이 추적하는 것은 우리 팀뿐).
  const suspended = side === 'home' ? new Set(discipline.suspendedIds) : new Set<string>()
  const cautionOf = (id: string) => (side === 'home' ? discipline.cautions[id] ?? 0 : 0)

  // 퇴장 선수는 라인업 배열에 그대로 남는다(엔진은 sentOff로만 걸러 계산한다).
  // 그래서 UI가 이 집합을 모르면 퇴장 선수를 OUT으로 고를 수 있고, [교체 확정]에서야
  // 엔진이 throw한다 — 규칙을 고르기 전에 말해야 규칙이다.
  const sentOff = new Set(state.sentOff)

  // 교체 기회(IFAB Law 3: 경기당 3회, UI 표기는 "교체 기회") — 하프타임 교체는 기회를
  // 소모하지 않고, 같은 분의 복수 교체는 이미 연 기회에 묶인다.
  // ★ 패널을 여는 것 자체는 어떤 상황에서도 막지 않는다. 선수 체력·개인 기록 확인은
  //   감독이 벤치에서 늘 하는 일이고, 차감되는 것은 실제 교체를 확정했을 때뿐이다.
  const windowsUsed = state.subWindowsUsed ?? 0
  const halftime = phase === 'halftime'
  const minute = engine?.minute ?? 0
  // 하프타임이 아직 오지 않았다면 "하프타임에는 기회 소모 없이" 안내가 참이다.
  // 이미 지났다면 그 문장은 거짓이 되므로 문구를 분기한다.
  const beforeHalftime = minute < 45
  const sameWindow = state.lastSubMinute !== undefined && state.lastSubMinute === minute
  const noWindow = windowsUsed >= MAX_SUB_WINDOWS && !halftime && !sameWindow
  const noQuota = state.subsUsed >= MAX_SUBS
  // 벤치가 비었거나 남은 전원이 정지·교체아웃이면 "고를 대상"이 없다. 카드마다 사유가
  // 붙어 있어도 목록 전체가 잠긴 상태는 따로 말해야 한다 — 하나씩 눌러 보게 두지 않는다.
  const eligibleBench = bench.filter(p => !suspended.has(p.id) && !subbedOff.has(p.id))

  // 패널 전체를 막는 사유 전부. 하나만 보여주면 하나를 풀어도 여전히 막히는 이유를
  // 알 수 없다(인원과 기회는 동시에 소진될 수 있다) — 그래서 열거한다.
  const blocks: string[] = []
  if (!open) blocks.push('지금은 개입할 수 없는 시점입니다. 하프타임이나 하이드레이션 브레이크에서 교체할 수 있습니다.')
  if (noQuota) blocks.push(`교체 인원 ${MAX_SUBS}명을 모두 사용했습니다. 이번 경기에서는 더 이상 선수를 바꿀 수 없습니다.`)
  if (noWindow) {
    blocks.push(beforeHalftime
      ? `교체 기회 ${MAX_SUB_WINDOWS}회를 모두 사용했습니다. 하프타임에는 기회 소모 없이 교체할 수 있습니다.`
      : `교체 기회 ${MAX_SUB_WINDOWS}회를 모두 사용했습니다. 이번 경기에서는 더 이상 교체할 수 없습니다.`)
  }
  if (eligibleBench.length === 0) {
    blocks.push(bench.length === 0
      ? '벤치에 남은 선수가 없습니다. 투입할 수 있는 선수가 없어 교체할 수 없습니다.'
      : '투입할 수 있는 벤치 선수가 없습니다 — 남은 벤치 전원이 출장정지이거나 이미 교체로 나갔습니다.')
  }
  const blocked = blocks.length > 0
  const blockText = blocks.join(' ')

  /** 막힌 컨트롤을 눌렀을 때의 응답. 패널 전체 사유면 배너를 흔들고(문장 중복 방지),
   *  카드 개인 사유면 에러 슬롯에 적는다. */
  const reportBlocked = (reason: string) => {
    if (reason === blockText) { setError(null); setNudge(n => n + 1) }
    else setError(reason)
  }

  const swap = () => {
    setError(null)
    if (blocked) { reportBlocked(blockText); return }
    if (!out || !inSel) { setError('아웃/인 선수를 선택하세요'); return }
    if (sentOff.has(out)) { setError(SENT_OFF_REASON); return }
    if (subbedOff.has(inSel)) { setError('교체로 나간 선수는 다시 투입할 수 없습니다 (IFAB 제3조)'); return }
    if (suspended.has(inSel)) { setError('출장정지 선수는 투입할 수 없습니다'); return }
    try {
      submitCommand(side, { type: 'sub', out, in: inSel })
      if (controlled) onConfirmed?.()
      else { setOutLocal(null); setInLocal(null) }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // [교체 확정]도 죽이지 않는다 — 눌렀을 때 이유가 나오는 것이 목적이다(swap 참조).
  const ready = !blocked && !!out && !!inSel && !sentOff.has(out)

  return (
    <section className="cs-panel cs-sub" aria-label="교체">
      <div className="cs-panel__head">
        <h3 className="cs-panel__title">교체</h3>
        {/* 남은 인원과 남은 기회를 함께 — 인원이 남아도 기회가 없으면 못 바꾼다.
            둘 중 하나만 보여주면 [교체 확정]이 거부되는 이유를 알 수 없다. */}
        {/* 소진된 축은 카운터 자신이 경고 상태가 된다 — "5/5"라는 숫자는 이미 답이지만
            평상시와 같은 회색으로 적혀 있으면 아무도 읽지 않는다. */}
        <span className={`cs-sub__count${noQuota || noWindow ? ' cs-sub__count--hot' : ''}`}>
          교체 {state.subsUsed}/{MAX_SUBS}명 · 교체 기회 {windowsUsed}/{MAX_SUB_WINDOWS}회
        </span>
      </div>

      {/* 차단 배너 — 모달을 띄우지 않는 이유: 작전판은 이미 전체 화면 오버레이라 그 위에
          모달을 얹으면 레이어가 3층이 되고 닫기 조작이 강요된다. 대신 사유가 카운터 바로
          아래, 목록보다 위에 상주하고 role="alert"로 즉시 읽힌다. */}
      {blocked && (
        <div
          key={nudge}
          className={`cs-sub__locked${nudge > 0 ? ' cs-sub__locked--nudge' : ''}`}
          data-nudge={nudge || undefined}
          role="alert"
        >
          <strong className="cs-sub__locked-t">지금 교체할 수 없습니다</strong>
          <ul className="cs-sub__reasons">
            {blocks.map(b => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}
      {/* 안내 슬롯은 카운터 바로 아래 한 자리에 모은다 — 카드 목록이 26장이라 하단
          슬롯은 스크롤 밖으로 나가고, "눌러도 아무 말이 없다"가 그대로 재현된다. */}
      {error && <p className="cs-error" role="alert">{error}</p>}
      {halftime && (
        <p className="cs-sub__hint">하프타임 교체는 교체 기회를 소모하지 않습니다.</p>
      )}
      {!halftime && sameWindow && (
        <p className="cs-sub__hint">
          {state.lastSubMinute}분 교체와 같은 기회로 묶입니다 — 지금 더 바꿔도 기회를 쓰지 않습니다.
        </p>
      )}

      {/* 막혀 있을 때 "1단계 · 나갈 선수를 고르세요"를 함께 띄우면 배너와 정면으로
          모순된다 — 화면이 두 말을 하면 사용자는 자기가 뭘 잘못했다고 읽는다. */}
      {!blocked && (
        <p className="cs-sub__hint">
          {/* 원문자(①②③)는 폰트에 따라 빠지거나 크기가 튄다 — 평문 단계 표기로 쓴다. */}
          {!out ? '1단계 · 나갈 선수를 고르세요(보드 발광)' : !inSel ? '2단계 · 들어올 벤치 선수를 고르세요' : '3단계 · [교체 확정]'}
        </p>
      )}

      <div className="cs-sub__lineup" role="group" aria-label="라인업">
        {lineup.map(({ slot, player }) => (
          <SubCard
            key={player.id}
            player={player}
            slot={slot}
            stamina={state.staminaByPlayer[player.id] ?? 0}
            morale={state.moraleByPlayer[player.id]}
            cautions={cautionOf(player.id)}
            stats={events ? playerMatchStats(events, player.id) : null}
            sentOff={sentOff.has(player.id)}
            selected={out === player.id}
            blockReason={blocked ? blockText : sentOff.has(player.id) ? SENT_OFF_REASON : null}
            onSelect={() => pickOut(player.id)}
            onBlocked={reportBlocked}
          />
        ))}
      </div>

      <h4 className="cs-sub__subtitle">벤치</h4>
      <div className="cs-sub__bench" role="group" aria-label="벤치">
        {bench.map(player => (
          <SubCard
            key={player.id}
            player={player}
            slot={player.position}
            stamina={state.staminaByPlayer[player.id] ?? 0}
            morale={state.moraleByPlayer[player.id]}
            cautions={cautionOf(player.id)}
            suspended={suspended.has(player.id)}
            subbedOff={subbedOff.has(player.id)}
            stats={events ? playerMatchStats(events, player.id) : null}
            selected={inSel === player.id}
            blockReason={
              blocked ? blockText
                : subbedOff.has(player.id) ? '교체로 나간 선수는 다시 투입할 수 없습니다 (IFAB 제3조)'
                : suspended.has(player.id) ? '출장정지 선수는 이번 경기에 투입할 수 없습니다. 다음 경기부터 다시 쓸 수 있습니다.'
                : !out ? '먼저 나갈 선수를 고르세요 — 라인업에서 한 명을 고르면 벤치를 선택할 수 있습니다.'
                : null
            }
            onSelect={() => pickIn(player.id)}
            onBlocked={reportBlocked}
          />
        ))}
      </div>

      <div className="cs-panel__foot">
        {/* disabled가 아니라 aria-disabled다 — disabled 버튼은 클릭 이벤트가 오지 않아
            "눌러도 아무 반응이 없다"가 그대로 남는다. 이유 없는 disabled는 고장으로 읽힌다
            (ShoutBar의 원칙). 여기서는 눌리되 swap()이 사유를 에러 슬롯에 띄운다. */}
        <button
          type="button"
          className="btn btn--primary"
          onClick={swap}
          aria-disabled={!ready}
          data-blocked={!ready || undefined}
        >
          교체 확정
        </button>
        {!open && <span className="cs-lock">다음 브레이크까지 잠김</span>}
      </div>
    </section>
  )
}

function SubCard({ player, slot, stamina, morale, cautions, suspended, subbedOff, sentOff, stats, selected, blockReason, onSelect, onBlocked }: {
  player: Player; slot: Player['position']; stamina: number
  /** 사기 0~100. 상태 칩이 밴드를 벗어날 때만 표시한다. */
  morale?: number
  /** 대회 미소멸 누적 경고(이번 경기 이전). */
  cautions?: number
  /** 이번 경기 출장정지 — 벤치에 남아 있어도 투입 불가. */
  suspended?: boolean
  /** 이 경기에서 이미 교체로 나갔다 — 벤치에 남아 있어도 재투입 불가(IFAB 제3조). */
  subbedOff?: boolean
  /** 이 경기 퇴장 — 교체로 뺄 수 없다(퇴장 자리는 메우지 못한다). */
  sentOff?: boolean
  /** 이 경기 개인 기록. null이면 아직 경기가 진행되지 않은 것(표시 안 함). */
  stats: PlayerMatchStats | null
  selected: boolean
  /** 선택이 막힌 사유. null이면 정상 선택 가능. 카드를 disabled로 죽이지 않고
   *  이 문구를 눌렀을 때 띄운다 — 침묵하는 컨트롤이 사용자가 지적한 결함이다. */
  blockReason: string | null
  onSelect: () => void
  /** 막힌 카드를 눌렀을 때 사유를 패널 에러 슬롯으로 올린다. */
  onBlocked: (reason: string) => void
}) {
  const pct = Math.max(0, Math.min(100, Math.round(stamina)))
  const low = pct < 30
  const locked = blockReason !== null
  return (
    <button
      type="button"
      className={`cs-card${selected ? ' cs-card--sel' : ''}${suspended ? ' cs-card--susp' : ''}${subbedOff || sentOff ? ' cs-card--out' : ''}`}
      aria-pressed={selected}
      aria-disabled={locked}
      title={blockReason ?? undefined}
      onClick={() => (locked ? onBlocked(blockReason) : onSelect())}
    >
      <span className="cs-card__num">{player.number}</span>
      <span className="cs-card__name">{player.name.ko}</span>
      <span className="cs-card__slot">{slot}</span>
      {/* 상태 칩은 체력바 앞에 온다 — 스캔은 왼쪽에서 시작하고, "지금 문제가 있는가"가
          "체력이 몇 %인가"보다 먼저 읽혀야 한다. */}
      <StatusChips
        className="cs-card__sx"
        input={{
          subbedOff, suspended, cautions, morale,
          matchYellows: stats?.yellows ?? 0,
          // 엔진 상태(sentOff)를 우선한다 — 기록 집계는 이벤트 파생이라 한 겹 늦다.
          sentOff: sentOff || (stats?.reds ?? 0) > 0,
          stamina,
        }}
      />
      <span className="cs-card__stamina" aria-label={`체력 ${pct}%`}>
        {/* 데이터 바인딩 폭(%)만 인라인 — pitch 기하 예외와 동일 취급. 색은 토큰. */}
        <span className={`cs-card__bar${low ? ' cs-card__bar--low' : ''}`} style={{ width: `${pct}%` }} />
      </span>
      {stats && hasPlayerMatchStats(stats) && <SubCardStats stats={stats} />}
    </button>
  )
}

/** 교체 카드 한 줄 기록 — 0인 항목은 생략해 카드가 길어지지 않게 한다.
 *  유효슛은 일부러 넣지 않는다: 선방당한 슛은 슈터를 알 수 없어 정직하게 셀 수 없다
 *  (playerStats.ts 주석 참조). 확실한 '슛/골'만 내건다.
 *  이모지(⚽🅰🧤🟥🟨)를 쓰지 않는다 — 10px 자리에서 OS마다 크기가 달라 줄 높이가
 *  흔들렸고, 색 이모지가 카드의 유일한 채도가 되어 톤이 무너졌다. 평문 한글로 적는다. */
function SubCardStats({ stats }: { stats: PlayerMatchStats }) {
  const parts: string[] = []
  if (stats.goals > 0) parts.push(`골 ${stats.goals}`)
  if (stats.assists > 0) parts.push(`도움 ${stats.assists}`)
  if (stats.saves > 0) parts.push(`선방 ${stats.saves}`)
  if (stats.shots > 0) parts.push(`슛 ${stats.shots}`)
  if (stats.fouls > 0) parts.push(`파울 ${stats.fouls}`)
  const carded = stats.reds > 0 ? '퇴장' : stats.yellows > 0 ? '경고' : ''
  return (
    <span className="cs-card__rec num">
      {carded && <span className={`cs-card__card cs-card__card--${stats.reds > 0 ? 'red' : 'yellow'}`}>{carded}</span>}
      {parts.join(' · ')}
    </span>
  )
}
