// src/game/oppAi.ts
// 상대 감독 AI — 완전 결정론(RNG 미사용). 시드 회귀 안전성을 위해 대상 선정은
// 체력 최하위 + 포지션 적합도로만 정하고, 동률은 playerId 사전순으로 끊는다.
import type { MatchCommand } from '../engine/simulate'
import type { Instructions, MatchState, Position, SideState, TeamProfile, TeamStyle } from '../engine/types'
import { positionFitness } from '../engine/fitness'
import { subbedOffIds } from './playerStats'

export interface OppAction {
  cmd: MatchCommand
  /** 방송 배너에 그대로 노출되는 한국어 통보 문구. 유형당 1회 제한의 키로도 쓴다.
   *  교체 통보에는 선수 이름이 들어가 매번 키가 달라지므로 한도(3장)까지 나갈 수 있고,
   *  전술 스위칭 통보는 고정 문구라 유형당 1회로 자연히 제한된다. */
  notice: string
}

/** 상대가 결정을 내리는 창. 매 분 개입하면 방송이 소란스럽고 계산도 낭비다. */
const WINDOWS = [46, 60, 70, 80]
/** 유저(5장)보다 적게 — 감독의 카드 우위를 유지한다. */
const MAX_AI_SUBS = 3
/** 프로필 스타일에서 벗어날 수 있는 최대 폭. 스페인은 끝까지 점유를 고집하고
 *  체코는 리드하면 더 내려앉는다 — 상황 대응을 하되 팀 정체성은 지킨다. */
const STYLE_CLAMP = 20

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 프로필 스타일 ±STYLE_CLAMP 범위로 지시를 가둔다. 지시 축의 유효 범위(0~100)도 함께 지킨다. */
function clampToStyle(style: TeamStyle, ins: Instructions): Instructions {
  const axis = (v: number, base: number) => clamp(v, Math.max(0, base - STYLE_CLAMP), Math.min(100, base + STYLE_CLAMP))
  return {
    lineHeight: axis(ins.lineHeight, style.lineHeight),
    pressing: axis(ins.pressing, style.pressing),
    tempo: axis(ins.tempo, style.tempo),
    attackFocus: ins.attackFocus,
  }
}

/** 라인업에서 지정 포지션군 중 체력 최하위 선수. 없으면 null. */
function tiredIn(side: SideState, slots: Position[]): { slot: Position; playerId: string } | null {
  const cands = side.tactics.lineup
    .filter(l => !side.sentOff.includes(l.playerId) && slots.includes(l.slot))
    .sort((a, b) => {
      const d = (side.staminaByPlayer[a.playerId] ?? 100) - (side.staminaByPlayer[b.playerId] ?? 100)
      // 체력 동률이면 playerId 사전순으로 안정 정렬(결정론).
      return d !== 0 ? d : a.playerId.localeCompare(b.playerId)
    })
  return cands[0] ?? null
}

/** 벤치(라인업 밖)에서 지정 슬롯 적합도 최상위. 없으면 null.
 *
 *  ★ `unavailable`은 이미 교체로 나간 선수다. 라인업 밖이라는 조건만으로는 걸러지지
 *  않는다 — 교체로 빠진 순간 그 선수도 "라인업 밖"이 되므로, 다음 창(60'→70')에서
 *  적합도 1위로 다시 뽑혀 재투입됐다(감사 재현: 선발 CB 다비트 지마가 70'에 IN). */
function bestBench(side: SideState, slot: Position, unavailable: ReadonlySet<string>): string | null {
  const inXI = new Set(side.tactics.lineup.map(l => l.playerId))
  const cands = side.team.squad
    .filter(p => !inXI.has(p.id) && !side.sentOff.includes(p.id) && !unavailable.has(p.id))
    .sort((a, b) => {
      const d = positionFitness(b, slot) - positionFitness(a, slot)
      return d !== 0 ? d : a.id.localeCompare(b.id)
    })
  return cands[0]?.id ?? null
}

/** 전술 스위칭 후보 — 상황(리드/추격/균형)과 벤치 패턴으로 정해지는 지시 변화와 통보 문구.
 *  변화 폭은 프로필 성향과 일치할 때 더 크다(protect-lead는 더 깊이, chase-attack은 더 세게).
 *  없으면 null. */
function tacticSwitch(
  cur: Instructions, pattern: TeamProfile['benchPattern'], teamKo: string,
  leading: boolean, trailing: boolean, minute: number,
): { next: Instructions; notice: string } | null {
  if (leading && pattern !== 'chase-attack') {
    const deep = pattern === 'protect-lead'
    return {
      next: { ...cur, lineHeight: cur.lineHeight - (deep ? 18 : 12), pressing: cur.pressing - (deep ? 12 : 8) },
      notice: `📢 ${teamKo}, 리드를 지키러 내려섭니다`,
    }
  }
  // 마지막 창까지 뒤져 있으면 총공세. 이미 추격 전환을 한 뒤라 누적 폭이 커지고,
  // 여기서 STYLE_CLAMP가 실제로 물려 "팀 정체성 이상으로는 못 나간다"가 성립한다.
  if (trailing && minute >= 80) {
    return {
      next: { ...cur, lineHeight: cur.lineHeight + 20, pressing: cur.pressing + 12, tempo: cur.tempo + 12 },
      notice: `📢 ${teamKo}, 마지막 총공세에 나섭니다`,
    }
  }
  if (trailing) {
    const hard = pattern === 'chase-attack'
    return {
      next: { ...cur, lineHeight: cur.lineHeight + (hard ? 15 : 10), tempo: cur.tempo + (hard ? 15 : 10) },
      notice: `📢 ${teamKo}, 라인을 올리고 추격에 나섭니다`,
    }
  }
  // 균형 상황에서 시간이 얼마 없으면 승부를 보러 템포만 올린다.
  if (minute >= 75) {
    return { next: { ...cur, tempo: cur.tempo + 8 }, notice: `📢 ${teamKo}, 템포를 끌어올립니다` }
  }
  return null
}

/** 교체 대상 포지션군과 투입 슬롯. 리드 지키기면 공격수를 빼고 수비형 미드필더를,
 *  추격이면 수비수를 빼고 공격수를 넣는다. 그 외에는 체력이 가장 떨어진 선수를 같은 자리로 교체. */
function subPlan(pattern: TeamProfile['benchPattern'], leading: boolean, trailing: boolean):
  { outSlots: Position[]; inSlot: Position | null } {
  if (leading && pattern === 'protect-lead') return { outSlots: ['ST', 'LW', 'RW'], inSlot: 'DM' }
  if (trailing && pattern === 'chase-attack') return { outSlots: ['CB', 'LB', 'RB'], inSlot: 'ST' }
  // GK는 어떤 경우에도 교체하지 않는다(엔진에 교체 GK 처리 개념이 없다).
  return { outSlots: ['ST', 'LW', 'RW', 'AM', 'CM', 'DM', 'LB', 'RB', 'CB'], inSlot: null }
}

/** 상대(어웨이) 감독의 이번 분 결정 목록. `done`은 이미 발동한 통보 키(유형당 1회 제한). */
export function decideAwayActions(st: MatchState, minute: number, done: string[]): OppAction[] {
  if (!WINDOWS.includes(minute)) return []
  const away = st.away
  const style = away.team.profile.style
  const pattern = away.team.profile.benchPattern
  const out: OppAction[] = []

  // 어웨이 관점 스코어. score는 [home, away].
  const diff = st.score[1] - st.score[0]
  const leading = diff > 0
  const trailing = diff < 0

  // ── 1) 전술 스위칭 (유형당 1회) ──
  const cur = away.tactics.instructions
  const sw = tacticSwitch(cur, pattern, away.team.name.ko, leading, trailing, minute)
  if (sw && !done.includes(sw.notice)) {
    const clamped = clampToStyle(style, sw.next)
    // 클램프 후 실제 변화가 없으면 통보하지 않는다(빈 배너 방지).
    const changed = clamped.lineHeight !== cur.lineHeight || clamped.pressing !== cur.pressing || clamped.tempo !== cur.tempo
    if (changed) out.push({ cmd: { type: 'instructions', instructions: clamped }, notice: sw.notice })
  }

  // ── 2) 교체 ──
  if (away.subsUsed < MAX_AI_SUBS) {
    // IFAB 제3조 — 이미 교체로 나간 선수는 후보에서 뺀다(events가 진실의 원천).
    const subbedOff = new Set(subbedOffIds(st.events, away.team.id))
    const { outSlots, inSlot } = subPlan(pattern, leading, trailing)
    const target = tiredIn(away, outSlots)
    if (target) {
      const inId = bestBench(away, inSlot ?? target.slot, subbedOff)
      if (inId) {
        const nameOf = (id: string) => away.team.squad.find(p => p.id === id)?.name.ko ?? id
        const notice = `📢 ${away.team.name.ko} 교체 — ${nameOf(target.playerId)} OUT, ${nameOf(inId)} IN`
        if (!done.includes(notice)) {
          out.push({ cmd: { type: 'sub', out: target.playerId, in: inId }, notice })
        }
      }
    }
  }

  return out
}
