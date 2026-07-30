// src/ui/pitch/flow.ts
// 점유 흐름 — 하이라이트가 **없는** 분에 공이 무엇을 하는지.
//
// 왜 필요한가: 경기당 유의미 이벤트는 20~30건인데 90분이다. 남는 50~60분 동안 예전에는
// 공이 리사주 곡선(cos/sin 합성)을 그리며 사람과 무관하게 떠다녔다 — 축구가 아니라 장식용
// 진동이었다. 여기서는 **공이 항상 실제 선수의 발밑에 있다**: 라인업 좌표를 잇는 짧은
// 패스 체인을 돌린다.
//
// 이 시퀀스는 2D 작전판에서 "점유 흐름"으로 읽힌다 — 실패한 사실주의가 아니라 정확한
// 데이터 시각화다(누가 공을 갖고 어느 쪽으로 미는가). 같은 데이터가 3D로 가면 엉성한
// 애니메이션이 되므로, 하이라이트 사이 구간은 2D가 담당한다.
//
// 결정론: Math.random·Date 금지. 변형은 (분, 시드) 해시로만.
import type { MatchState, SideState } from '../../engine/types'
import type { ChoreoStep } from './choreography'
import { slotCoords } from './formations'
import { PITCH_H, PITCH_W } from './geometry'
import { SEGMENT_SPEED, TOUCH_MS } from './scenes'
import { tacticalCoords } from './shape'

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 전개 원형 6종 — 각 원소가 "이 지점에 가장 가까운 XI"를 뜻한다.
 * 실제 축구의 순환 패턴(후방 빌드업 · 측면 전환 · 전방 순환 · 후퇴)을 본떴다.
 */
const FLOW_PATTERNS: { label: string; roles: [number, number][] }[] = [
  { label: '좌측 전개', roles: [[22, 38], [40, 50], [52, 32], [75, 18]] },
  { label: '우측 전개', roles: [[22, 62], [40, 50], [52, 68], [75, 82]] },
  { label: '후방 빌드업', roles: [[22, 50], [24, 15], [48, 40], [62, 50]] },
  { label: '전방 순환', roles: [[52, 32], [75, 18], [80, 50], [52, 68]] },
  { label: '우측 오버랩', roles: [[24, 85], [48, 60], [76, 62], [80, 50]] },
  { label: '후퇴 순환', roles: [[40, 50], [22, 38], [24, 15], [50, 15]] },
]

/**
 * 무사건 분 dwell(ms) — **playback.NO_EVENT_DWELL_MS의 정본**.
 *
 * 하이라이트가 실제 축구 속도로 길어진 만큼(장면당 6~7 s) 무사건 분은 더 과감히
 * 넘긴다. 이 구간은 2D 작전판이 받으므로 안무를 밀어 넣을 이유가 없다.
 */
export const FLOW_DWELL_MS = 1100

/** 키프레임이 차지할 수 있는 dwell 비율 — 나머지는 여운. 안무와 같은 계약. */
const FLOW_T_BUDGET = 0.8

/** 역할 원형에 가장 가까운 XI를 겹치지 않게 뽑는다(GK 포함 — 후방 빌드업 때문).
 *  ★ 선발(누가 그 역할인가)은 포메이션 원형 좌표로, 반환 좌표(공이 놓일 자리)는 전술 변환을
 *  거친 실제 도트 좌표로 한다 — 안 그러면 라인을 올렸을 때 공이 도트에서 떨어져 보인다. */
function pickChain(side: SideState, roles: [number, number][]): { id: string; x: number; y: number }[] {
  const { formation, lineup, instructions } = side.tactics
  const sentOff = new Set(side.sentOff)
  const taken = new Set<string>()
  const out: { id: string; x: number; y: number }[] = []
  for (const [rx, ry] of roles) {
    let best: { id: string; x: number; y: number } | null = null
    let bestD = Infinity
    for (let i = 0; i < lineup.length; i++) {
      const id = lineup[i].playerId
      if (taken.has(id) || sentOff.has(id)) continue
      const c = slotCoords(formation, i, 'home')
      const d = (c.x - rx) ** 2 + (c.y - ry) ** 2
      if (d <= bestD) {
        bestD = d
        const t = tacticalCoords(formation, i, 'home', instructions)
        best = { id, x: t.x, y: t.y }
      }
    }
    if (!best) break
    out.push(best)
    taken.add(best.id)
  }
  return out
}

/** 이 분에 공을 가진 팀 — 모멘텀이 기울수록 그쪽이 자주 가진다(결정론 해시 대조). */
export function possessingSide(momentum: number, minute: number, seed: number): 'home' | 'away' {
  // momentum ∈ [-1,1] → home 점유 확률 0.5 + 0.35*m. 해시 유닛과 비교한다.
  const p = 0.5 + Math.max(-1, Math.min(1, momentum)) * 0.35
  return (hash(`flow:${seed}:${minute}`) % 1000) / 1000 < p ? 'home' : 'away'
}

/**
 * 하이라이트가 없는 분의 점유 흐름 시퀀스.
 * 공은 체인 위의 실제 선수 발밑을 차례로 옮겨 다닌다(무버 도트는 내지 않는다).
 *
 * @param state  엔진 상태(읽기만).
 * @param minute 현재 분.
 * @param seed   경기 시드.
 */
export function buildFlowSequence(
  state: MatchState,
  minute: number,
  seed: number,
): { seq: ChoreoStep[]; side: 'home' | 'away'; label: string } {
  const side = possessingSide(state.momentum, minute, seed)
  const st = side === 'home' ? state.home : state.away
  const pi = hash(`flowpat:${seed}:${minute}:${side}`) % FLOW_PATTERNS.length
  const pattern = FLOW_PATTERNS[pi]
  const chain = pickChain(st, pattern.roles)
  if (chain.length === 0) return { seq: [], side, label: pattern.label }

  // away는 x 미러. ★ 모멘텀 드리프트를 공에 더하지 않는다 — 그러면 공이 도트에서
  // 떨어져 보인다. 흐름은 "누가 점유하는가"(possessingSide)와 캡션이 이미 말한다.
  const fx = (x: number) => (side === 'home' ? clamp(x) : clamp(100 - x))

  // ★ 시각도 실제 볼 속도에서 역산한다(하이라이트 장면과 같은 규칙).
  //   예전에는 [0, 0.22, 0.46, 0.7]로 고정이라, 무사건 dwell 안에 20 m 패스 4개를 밀어
  //   넣으면 공이 20 m/s가 넘게 날아갔다. 지금은 예산(dwell의 80%)이 허용하는 만큼만
  //   체인을 이어 붙이고, 남으면 그 자리에서 끝낸다.
  const seq: ChoreoStep[] = []
  let ms = 0
  for (let k = 0; k < chain.length; k++) {
    const holder = chain[k]
    // 공은 홀더의 발 앞(공격 방향으로 1.5)에 놓인다 — 도트와 겹치지 않게.
    const bx = fx(holder.x + 1.5)
    const by = clamp(holder.y)
    const next = chain[k + 1]
    // 짧은 패스는 지면, 전환 패스는 뜬다 — 거리로 가른다.
    const arc: ChoreoStep['arc'] =
      next && Math.hypot(next.x - holder.x, next.y - holder.y) > 22 ? 'pass' : 'ground'
    seq.push({
      t: ms / FLOW_DWELL_MS,
      ball: { x: bx, y: by },
      // ★ 무버를 내지 않는다. 흐름의 참여자는 이미 자기 슬롯에 서 있는 실제 도트이고,
      //   같은 좌표에 반투명 무버를 겹치면 도트가 둘로 보인다(2D). 3D에서도 무버 좌표가
      //   포메이션 좌표와 같아 아무 일도 하지 않는다.
      movers: [],
      arc,
    })
    if (!next) break
    const dist = Math.hypot(((next.x - holder.x) / 100) * PITCH_W, ((next.y - holder.y) / 100) * PITCH_H)
    const step = (dist / SEGMENT_SPEED[arc]) * 1000 + (k > 0 ? TOUCH_MS : 0)
    if ((ms + step) / FLOW_DWELL_MS > FLOW_T_BUDGET) {
      // 예산 초과. 다만 **키프레임 하나짜리 시퀀스는 만들지 않는다** — 2D 작전판이
      // 정지 화면이 되고 렌더러 계약(첫 t=0, 마지막 ≤ 0.8)도 의미를 잃는다.
      // 첫 패스만은 예산 끝(0.8)에 밀어 넣는다(그만큼 볼이 의도보다 빠르다).
      if (seq.length === 1) ms = FLOW_DWELL_MS * FLOW_T_BUDGET
      else break
    } else {
      ms += step
    }
  }
  return { seq, side, label: pattern.label }
}
