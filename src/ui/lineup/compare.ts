// src/ui/lineup/compare.ts
// 2인 비교 뷰의 순수 계산 — React·DOM 비의존. 전량 TDD 대상.
//
// ── 왜 별도 모듈인가 ────────────────────────────────────────────────
// "잘 보이게 디자인" 지시의 실질은 **차이를 계산해서 강조**하는 것이다. 표를 두 벌
// 늘어놓는 것과의 차이는 전부 여기 있는 계산(승자·델타·정규화 막대·결론 문장)에서
// 나온다. 렌더는 그 결과를 그리기만 한다.
//
// ── 왜 포지션 적합도가 중심인가 ────────────────────────────────────
// 교체 판단의 질문은 "누가 더 좋은 선수인가"가 아니라 **"지금 이 자리에 누가 더
// 맞는가"**다. 능력치 총합이 높아도 CB를 ST에 세우면 적합도 0.4가 모든 수치를
// 깎는다(engine/fitness.ts의 effectiveStats가 실제로 stats × fit로 계산한다).
// 그래서 비교 뷰는 슬롯을 먼저 말하고, 적합도를 첫 지표로 놓는다.
import type { Player, Position } from '../../engine/types'
import { positionFitness } from '../../engine/fitness'
import type { PlayerMatchStats } from '../../game/playerStats'
import { FIELD_AXES, GK_AXES } from '../common/PlayerCard'

/** 선택 조합이 정하는 동작. 규약 문서(2026-07-31-squad-interaction.md) 표와 1:1. */
export type CompareKind = 'swap' | 'sub' | 'none'

/** 비교 한 줄. a/b는 표시값이고 승패 판정은 higherBetter가 뒤집는다. */
export interface CompareMetric {
  key: string
  label: string
  a: number
  b: number
  /** 소수 자리(0 = 정수). */
  digits: number
  /** 값이 클수록 좋은가. 경고 장수는 false. */
  higherBetter: boolean
  /** 이 값 미만의 차이는 "동일"로 본다 — 1 차이를 막대로 그리면 잡음이 이긴다. */
  epsilon: number
  /** 막대 정규화 기준(이 차이면 막대가 꽉 찬다). */
  span: number
}

export interface MetricDiff {
  winner: 'a' | 'b' | 'tie'
  /** 절대 차이(표시용). */
  delta: number
  /** 0~1 정규화 막대 길이. tie면 0. */
  ratio: number
}

/** 한 줄의 승자·차이·막대 길이(순수).
 *  ★ 색만으로 말하지 않기 위해 delta를 항상 함께 돌려준다 — 렌더가 숫자를 찍는다. */
export function metricDiff(m: CompareMetric): MetricDiff {
  const raw = m.a - m.b
  const delta = Math.abs(raw)
  if (delta < m.epsilon) return { winner: 'tie', delta: 0, ratio: 0 }
  const aWins = m.higherBetter ? raw > 0 : raw < 0
  return { winner: aWins ? 'a' : 'b', delta, ratio: Math.min(1, delta / m.span) }
}

/** 두 선발의 자리를 바꿨을 때 **합계 적합도 변화**.
 *  양수면 바꾸는 쪽이 낫다. autoFill의 2-opt 수리가 쓰는 이득 식과 같은 형태다
 *  — 같은 판단을 사람과 기계가 다른 식으로 하면 추천과 화면이 어긋난다. */
export function swapFitDelta(a: Player, aSlot: Position, b: Player, bSlot: Position): number {
  return (positionFitness(a, bSlot) + positionFitness(b, aSlot))
    - (positionFitness(a, aSlot) + positionFitness(b, bSlot))
}

/** 벤치(inP)를 선발(outP)의 자리(slot)에 넣었을 때 적합도 변화. 양수면 투입이 낫다. */
export function subFitDelta(inP: Player, outP: Player, slot: Position): number {
  return positionFitness(inP, slot) - positionFitness(outP, slot)
}

/** 두 선수가 같은 레이더 축을 쓰는가(GK 3축 vs 필드 6축).
 *  섞이면 비교할 축이 없다 — 표를 억지로 맞추지 않고 "축이 다르다"고 말한다. */
export function sharesAxes(a: Player, b: Player): boolean {
  return !!a.gkStats === !!b.gkStats
}

export interface CompareInput {
  a: Player
  b: Player
  /** a가 선발이면 그 슬롯, 벤치면 undefined. */
  aSlot?: Position
  bSlot?: Position
  stamina?: Record<string, number>
  morale?: Record<string, number>
  cautions?: Record<string, number>
  /** 이 경기 개인 기록. **작전판(경기 중)에서만** 넘긴다 — 킥오프 전에는 전원 0이라
   *  "정보량 0"인 줄만 늘어나 상태 칩 규칙에 어긋난다(규약 문서 §작전판이 추가해야 할 것).
   *  경기 중에는 반대로 가장 중요한 판단 재료다. */
  matchStats?: Record<string, PlayerMatchStats>
}

export interface CompareModel {
  kind: CompareKind
  /** 실행 버튼 라벨. 규약 표 그대로. */
  actionLabel: string
  /** 판단의 기준이 되는 자리. sub면 빠지는 선발의 슬롯, swap이면 두 슬롯. */
  slots: Position[]
  /** 적합도 줄(있으면 첫 줄). 축이 달라도 항상 계산된다 — 적합도는 stats가 아니라
   *  포지션에서 나오므로 GK↔필드 비교에서도 유효하다. */
  fitness: CompareMetric | null
  /** 능력치 6축(또는 GK 3축). 축이 다르면 빈 배열. */
  axes: CompareMetric[]
  /** 컨디션·징계. */
  condition: CompareMetric[]
  /** 이 경기 기록. matchStats 미지정이거나 두 선수 다 0인 지표는 줄이 아예 생기지 않는다. */
  match: CompareMetric[]
  /**
   * 맨 위 한 줄 — **집계 수치**다. 결론이 아니다.
   *
   * ★ 2026-08-01 재판정(사용자 지시): 예전에는 여기에 *"지금 배치가 낫습니다"*,
   *   *"손흥민이(가) 낫습니다"*가 들어갔다. 사용자 판정은 **과도한 개입**이었다 —
   *   *"사용자가 판단해서 즐길 수 있게 해."*
   *
   *   경계는 **화자**다. 코치 회의(coach.ts)·스카우팅 브리핑은 게임 안의 인물이 말하고
   *   감독이 `[감독 판단대로 간다]`로 무시할 수 있게 설계돼 있다(기획서 원칙 2).
   *   이 줄에는 화자가 없다. 무기명 UI가 단정하면 그건 조언이 아니라 판정이고,
   *   유저에게 남는 선택은 "따르거나 틀리거나"뿐이다.
   *
   *   그래서 **사실은 전부 남기고 단정만 뺐다.** `합계 적합도 -1.20`은 계산 결과이므로
   *   남고, `지금 배치가 낫습니다`는 결론이므로 빠진다. 아래 발산 막대가 근거이고
   *   이 줄은 막대가 못 보여 주는 **합계**를 맡는다(교환 이득은 어느 행에도 없다).
   */
  readout: string
  /** 축이 달라 능력치를 못 겹친 경우의 안내(없으면 null). */
  note: string | null
}

const FIT_EPS = 0.03
const FIT_SPAN = 0.6

/** 능력치 축 값 뽑기 — GK/필드 공통. */
function axisMetrics(a: Player, b: Player): CompareMetric[] {
  if (!sharesAxes(a, b)) return []
  if (a.gkStats && b.gkStats) {
    return GK_AXES.map(ax => ({
      key: ax.key, label: ax.label, a: a.gkStats![ax.key], b: b.gkStats![ax.key],
      digits: 0, higherBetter: true, epsilon: 3, span: 30,
    }))
  }
  if (a.stats && b.stats) {
    return FIELD_AXES.map(ax => ({
      key: ax.key, label: ax.label, a: a.stats![ax.key], b: b.stats![ax.key],
      digits: 0, higherBetter: true, epsilon: 3, span: 30,
    }))
  }
  return []
}

/**
 * 이 경기 기록 비교 줄.
 *
 * ★ 막대 정규화(span)를 능력치와 같이 쓰면 안 된다. 능력치는 0~100에 span 30이지만
 *   슛·골은 90분 전체에서 한 자릿수다 — span 30을 그대로 쓰면 "2골 대 0골"의 막대가
 *   화면 폭의 7%라 차이가 안 보인다. 지표별 실제 분포로 다시 정한다:
 *    · 골·도움 1점이 곧 결정적이다 → span 2, epsilon 1(0.5골 같은 건 없다).
 *    · 슛·선방은 3개 차이면 확연하다 → span 3.
 *    · 파울은 3개면 경고권이다 → span 3, **적을수록 좋다**.
 *    · 경고는 1장이 곧 퇴장 위험이다 → span 1, 적을수록 좋다.
 * ★ 두 선수 다 0인 지표는 줄을 만들지 않는다 — "0 대 0"은 정보량이 0인데 자리만 먹는다.
 */
function matchMetrics(
  stats: Record<string, PlayerMatchStats> | undefined, aId: string, bId: string,
): CompareMetric[] {
  if (!stats) return []
  const rows: { key: keyof PlayerMatchStats; label: string; span: number; higherBetter: boolean }[] = [
    { key: 'goals', label: '골', span: 2, higherBetter: true },
    { key: 'assists', label: '도움', span: 2, higherBetter: true },
    { key: 'shots', label: '슛', span: 3, higherBetter: true },
    { key: 'saves', label: '선방', span: 3, higherBetter: true },
    { key: 'fouls', label: '파울', span: 3, higherBetter: false },
    { key: 'yellows', label: '이 경기 경고', span: 1, higherBetter: false },
  ]
  const out: CompareMetric[] = []
  for (const r of rows) {
    const a = stats[aId]?.[r.key] ?? 0
    const b = stats[bId]?.[r.key] ?? 0
    if (a === 0 && b === 0) continue
    out.push({ key: `m-${r.key}`, label: r.label, a, b, digits: 0, higherBetter: r.higherBetter, epsilon: 1, span: r.span })
  }
  return out
}

/** 판단 기준 슬롯을 정한다.
 *  · 교체(sub): 빠지는 **선발의 자리**가 기준이다. 벤치 선수가 그 자리로 들어오므로.
 *  · 자리 바꾸기(swap): 두 자리 모두가 기준이다(교차 적합도로 따로 계산한다).
 *  · 둘 다 벤치(none): 기준 자리가 없다 — 적합도는 각자의 주 포지션으로 잡는다. */
function pickSlots(aSlot?: Position, bSlot?: Position): { kind: CompareKind; slots: Position[] } {
  if (aSlot && bSlot) return { kind: 'swap', slots: [aSlot, bSlot] }
  if (aSlot) return { kind: 'sub', slots: [aSlot] }
  if (bSlot) return { kind: 'sub', slots: [bSlot] }
  return { kind: 'none', slots: [] }
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** 비교 모델(순수). 렌더는 이 결과만 그린다. */
export function buildCompare(input: CompareInput): CompareModel {
  const { a, b, aSlot, bSlot, stamina, morale, cautions } = input
  const { kind, slots } = pickSlots(aSlot, bSlot)

  // ── 적합도 ─────────────────────────────────────────────────────
  // sub: 같은 한 자리에 두 사람을 세워 본다(직접 비교).
  // swap: 자리가 둘이므로 "지금 자리 적합도"를 각자 적고, 교차 이득은 verdict가 말한다.
  // none: 기준 자리가 없으므로 각자의 주 포지션 적합도(=1.0)를 적어도 의미가 없다 → null.
  let fitness: CompareMetric | null = null
  if (kind === 'sub') {
    const slot = slots[0]
    fitness = {
      key: 'fit', label: `${slot} 적합도`,
      a: positionFitness(a, slot), b: positionFitness(b, slot),
      digits: 2, higherBetter: true, epsilon: FIT_EPS, span: FIT_SPAN,
    }
  } else if (kind === 'swap') {
    // 교환 후 적합도를 나란히 둔다 — "바꾸면 각자 몇이 되는가"가 결정에 필요한 값이다.
    fitness = {
      key: 'fit', label: '바꾼 뒤 적합도',
      a: positionFitness(a, bSlot!), b: positionFitness(b, aSlot!),
      digits: 2, higherBetter: true, epsilon: FIT_EPS, span: FIT_SPAN,
    }
  }

  const axes = axisMetrics(a, b)

  const condition: CompareMetric[] = []
  if (stamina && (stamina[a.id] != null || stamina[b.id] != null)) {
    condition.push({
      key: 'stamina', label: '체력', a: stamina[a.id] ?? 100, b: stamina[b.id] ?? 100,
      digits: 0, higherBetter: true, epsilon: 3, span: 40,
    })
  }
  if (morale && (morale[a.id] != null || morale[b.id] != null)) {
    condition.push({
      key: 'morale', label: '사기', a: morale[a.id] ?? 70, b: morale[b.id] ?? 70,
      digits: 0, higherBetter: true, epsilon: 3, span: 40,
    })
  }
  const ca = cautions?.[a.id] ?? 0
  const cb = cautions?.[b.id] ?? 0
  if (ca > 0 || cb > 0) {
    // 경고는 적을수록 좋다. 1장 차이도 유의미하다(2장이면 다음 경기 결장).
    condition.push({
      key: 'caution', label: '누적 경고', a: ca, b: cb,
      digits: 0, higherBetter: false, epsilon: 1, span: 2,
    })
  }

  const v = buildReadout(input, kind, axes.length > 0)
  return {
    kind,
    match: matchMetrics(input.matchStats, a.id, b.id),
    actionLabel: kind === 'swap' ? '자리 바꾸기' : '교체하기',
    slots,
    fitness: fitness ? { ...fitness, a: round2(fitness.a), b: round2(fitness.b) } : null,
    axes,
    condition,
    readout: v.readout,
    note: v.note,
  }
}

/** 부호를 붙인 델타(+0.30 / -1.20). 0.00에 `-`가 붙지 않게 round2를 먼저 통과시킨다. */
function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`
}

/**
 * 맨 위 한 줄 — **집계 수치만**. 결론은 유저가 낸다(CompareModel.readout 주석 참조).
 *
 * 무엇을 적는가는 "아래 막대가 못 보여 주는 것"이 정한다:
 *  1. 자리 바꾸기 — **합계** 적합도 변화(swapFitDelta). 행에는 교환 후 각자의 적합도가
 *     따로 적히지만 그 둘을 더한 값은 어느 행에도 없다. 부호가 곧 정보다.
 *  2. 교체 — 그 자리 적합도 두 값과 차이. 행과 겹치지만 **이름이 붙는다**(행에는 없다).
 *  3. 적합도가 오차 안이면 체력을 함께 적는다 — 같은 자리를 같은 수준으로 소화하면
 *     다음으로 볼 수치가 그것이라는 사실만 말하고, 어느 쪽인지는 말하지 않는다.
 *  4. 둘 다 벤치면 잴 자리가 없다 — 그 사실을 적는다.
 */
function buildReadout(
  input: CompareInput, kind: CompareKind, hasAxes: boolean,
): { readout: string; note: string | null } {
  const { a, b, aSlot, bSlot, stamina } = input
  const note = hasAxes ? null : 'GK와 필드 선수는 능력치 축이 달라 겹쳐 비교하지 않습니다.'

  if (kind === 'none') {
    return { readout: '둘 다 벤치입니다 — 기준이 될 자리가 없어 적합도를 재지 않습니다.', note }
  }

  if (kind === 'swap') {
    const d = round2(swapFitDelta(a, aSlot!, b, bSlot!))
    if (Math.abs(d) > FIT_EPS) {
      return { readout: `자리를 바꾸면 합계 적합도 ${signed(d)}`, note }
    }
    return { readout: `자리를 바꿔도 합계 적합도 변화는 ±${FIT_EPS.toFixed(2)} 안입니다`, note }
  }

  // sub — 어느 쪽이 선발인지와 무관하게 "그 자리"의 수치를 나란히 적는다.
  const slot = (aSlot ?? bSlot)!
  const fa = round2(positionFitness(a, slot))
  const fb = round2(positionFitness(b, slot))
  const head = `${slot} 적합도 — ${a.name.ko} ${fa.toFixed(2)} · ${b.name.ko} ${fb.toFixed(2)}`
  if (Math.abs(round2(fa - fb)) >= FIT_EPS) {
    return { readout: `${head} (차 ${Math.abs(round2(fa - fb)).toFixed(2)})`, note }
  }
  const sa = stamina?.[a.id]
  const sb = stamina?.[b.id]
  if (sa != null && sb != null && Math.abs(sa - sb) >= 5) {
    return { readout: `${head} · 체력 ${Math.round(sa)}% · ${Math.round(sb)}%`, note }
  }
  return { readout: head, note }
}
