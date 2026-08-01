// src/ui/common/PlayerCompare.tsx
// 2인 나란히 비교 뷰. 워룸과 작전판이 같은 컴포넌트를 쓴다(조작 규약 공통).
//
// ── "표를 두 벌 늘어놓지 마라" ─────────────────────────────────────
// 두 선수의 스탯 표를 좌우에 놓으면 유저가 열여덟 쌍을 눈으로 빼야 한다. 여기서는
// 계산(compare.ts)이 승자와 차이를 먼저 구하고, 화면은 그 차이를 **중앙축 기준 발산
// 막대**로 그린다. 축을 공유하므로 "어느 쪽이 얼마나"가 길이 하나로 읽힌다.
//
// ── 색만으로 말하지 않는다 ────────────────────────────────────────
// 우세는 (1) 막대가 그쪽으로 뻗고 (2) 수치가 굵어지고 (3) 델타 숫자가 그쪽에 붙는
// 세 겹으로 표시된다. 색(--good)은 네 번째 단서일 뿐이다.
//
// ── 결론은 유저가 낸다 ────────────────────────────────────────────
// 지표별 우열(막대·굵기·델타)은 **계산 결과**라 남는다. 반대로 "그래서 누구를 쓸
// 것인가"는 감독의 몫이므로 화면이 대신 말하지 않는다. 맨 위 한 줄은 결론이 아니라
// 집계 수치다(compare.ts의 CompareModel.readout 주석에 판정 근거).
//
// ── 색 규칙 ───────────────────────────────────────────────────────
// 빨강/파랑은 팀 전용, 라임은 --live 전용이므로 비교 막대에 쓰지 않는다. 우세는
// --good(초록), 열세는 무채색 표면이다. 브랜드 파랑은 "감독의 행동"(실행 버튼)에만.
import type { Player, Position } from '../../engine/types'
import type { PlayerMatchStats } from '../../game/playerStats'
import { buildCompare, metricDiff, type CompareMetric, type CompareModel } from '../lineup/compare'
import { StatusChips, type StatusInput } from './StatusChips'
import { PlayerRadar } from './PlayerCard'
import './PlayerCompare.css'

export interface ComparePlayer {
  player: Player
  /** 선발이면 슬롯, 벤치면 undefined. */
  slot?: Position
  status: StatusInput
}

/** 두 선수 비교 패널. 실행 버튼은 부모가 넘긴다 — 실제 라인업 변경 권한은
 *  편집기(LineupEditor)에 있고 이 컴포넌트는 판단 재료만 그린다. */
export function PlayerCompare({
  a, b, stamina, morale, cautions, matchStats, action,
}: {
  a: ComparePlayer
  b: ComparePlayer
  stamina?: Record<string, number>
  morale?: Record<string, number>
  cautions?: Record<string, number>
  /** 이 경기 개인 기록 — 작전판(경기 중)만 넘긴다. 킥오프 전에는 전원 0이라 줄이 무의미하다. */
  matchStats?: Record<string, PlayerMatchStats>
  /** 실행 버튼 슬롯(없으면 비교만). */
  action?: React.ReactNode
}) {
  const model: CompareModel = buildCompare({
    a: a.player, b: b.player, aSlot: a.slot, bSlot: b.slot, stamina, morale, cautions, matchStats,
  })

  const rows: { title: string; metrics: CompareMetric[] }[] = []
  if (model.fitness) rows.push({ title: '포지션', metrics: [model.fitness] })
  // 경기 중이라면 **지금 무슨 일을 했는가**가 능력치보다 먼저다 — 90분 뛰고 슛 0개인
  // 공격수를 뺄지 말지는 카탈로그 수치가 아니라 이 줄이 정한다.
  if (model.match.length > 0) rows.push({ title: '이 경기', metrics: model.match })
  if (model.axes.length > 0) rows.push({ title: '능력치', metrics: model.axes })
  if (model.condition.length > 0) rows.push({ title: '컨디션·징계', metrics: model.condition })

  return (
    <section className="cmp" aria-label="선수 비교">
      {/* 집계 수치 한 줄. **결론이 아니다** — 아래 막대가 못 보여 주는 합계를 맡는다.
          (예전에는 여기서 "지금 배치가 낫습니다"라고 단정했다. compare.ts의 readout 주석) */}
      <p className="cmp__readout num" role="status">{model.readout}</p>

      <div className="cmp__heads">
        <Head side="a" order={1} entry={a} />
        <span className="cmp__ctx">
          <span className="cmp__ctx-mark" aria-hidden="true">vs</span>
          <span className="cmp__ctx-text">{slotContext(model, a, b)}</span>
        </span>
        <Head side="b" order={2} entry={b} />
      </div>

      {/* 육각 레이더 두 장은 겹쳐 읽기 어렵지만, "형태"는 막대가 못 주는 정보다
          (전방위형 vs 한 축 특화). 작게 나란히 두고 판단은 아래 막대가 맡는다. */}
      {model.axes.length > 0 && (
        <div className="cmp__radars" aria-hidden="true">
          <PlayerRadar player={a.player} className="cmp__radar" />
          <PlayerRadar player={b.player} className="cmp__radar" />
        </div>
      )}

      {rows.map(g => (
        <div key={g.title} className="cmp__group">
          <h4 className="cmp__group-title eyebrow">{g.title}</h4>
          {g.metrics.map(m => <Row key={m.key} m={m} />)}
        </div>
      ))}

      {model.note && <p className="cmp__note">{model.note}</p>}
      {action && <div className="cmp__action">{action}</div>}
    </section>
  )
}

/** 슬롯 맥락 한 줄 — 무엇을 두고 비교하는지. 결론은 verdict가 따로 말한다. */
function slotContext(model: CompareModel, a: ComparePlayer, b: ComparePlayer): string {
  if (model.kind === 'swap') return `${a.slot} ↔ ${b.slot} 자리 교환`
  if (model.kind === 'sub') return `${model.slots[0]} 자리`
  return '둘 다 벤치'
}

/**
 * 두 선수의 신원 한 칸.
 *
 * ★ 2026-08-01 — **상태 칩을 이름 줄에서 내렸다.** 예전에는 한 줄에
 * `[순서][번호·이름][상태 칩]`이 나란히 서서 세 요소가 같은 가로폭을 놓고 다퉜다.
 * 칩은 개수가 상황에 따라 늘어나는데(체력·사기·경고·정지…) 유일하게 줄어들 수 있는 것이
 * 이름이라, 칩이 두어 개만 붙어도 이름 칸이 40px 아래로 눌려 `손...`이 됐다
 * (사용자 캡처 ③). 폭이 넉넉한 화면에서는 안 보이고 좁아질수록 심해지는 종류의 결함이라
 * 미디어 쿼리로는 못 막는다 — 이 컴포넌트는 420px 팝오버 안에도 들어가기 때문이다.
 *
 * 지금은 **이름이 첫 줄을 통째로 갖는다.** 칩은 포지션·선발/벤치와 함께 둘째 줄로 내려가고,
 * 그 줄은 랩이 허용된다. 스캔 순서(누구인가 → 지금 문제가 있는가)와도 맞는다.
 */
function Head({ side, order, entry }: { side: 'a' | 'b'; order: number; entry: ComparePlayer }) {
  const { player, slot, status } = entry
  return (
    <div className={`cmp__head cmp__head--${side}`}>
      {/* 선택 순서 배지 — 목록의 칩에 붙는 배지와 같은 숫자다. 어느 쪽이 어느 선수인지
          비교 뷰와 피치를 오가며 확인할 수 있어야 한다. */}
      <span className="cmp__order num" aria-label={`선택 ${order}번`}>{order}</span>
      <span className="cmp__ident">
        <span className="cmp__nameline">
          <span className="cmp__num num">{player.number}</span>
          <span className="cmp__name">{player.name.ko}</span>
        </span>
        <span className="cmp__posline">
          <span className="cmp__pos">{slot ?? player.position}</span>
          <span className="cmp__where">{slot ? '선발' : '벤치'}</span>
          <StatusChips className="cmp__sx" input={status} />
        </span>
      </span>
    </div>
  )
}

/** 발산 막대 한 줄. 중앙 라벨을 축으로 우세한 쪽으로만 막대가 뻗는다. */
function Row({ m }: { m: CompareMetric }) {
  const d = metricDiff(m)
  const fmt = (v: number) => v.toFixed(m.digits)
  const pct = `${Math.round(d.ratio * 100)}%`
  const deltaText = d.winner === 'tie' ? '' : `+${fmt(d.delta)}`
  return (
    <div className="cmp__row">
      <span className={`cmp__val num${d.winner === 'a' ? ' cmp__val--win' : ''}`}>{fmt(m.a)}</span>
      <span className="cmp__bar cmp__bar--a">
        {/* 데이터 바인딩 폭(%)만 인라인 — 프로젝트 규약상 허용되는 세 경우 중 하나. */}
        {d.winner === 'a' && <span className="cmp__fill" style={{ width: pct }} />}
      </span>
      <span className="cmp__mid">
        <span className="cmp__d cmp__d--a">{d.winner === 'a' ? deltaText : ''}</span>
        <span className="cmp__label">{m.label}</span>
        <span className="cmp__d cmp__d--b">{d.winner === 'b' ? deltaText : ''}</span>
      </span>
      <span className="cmp__bar cmp__bar--b">
        {d.winner === 'b' && <span className="cmp__fill" style={{ width: pct }} />}
      </span>
      <span className={`cmp__val num${d.winner === 'b' ? ' cmp__val--win' : ''}`}>{fmt(m.b)}</span>
    </div>
  )
}
