// src/ui/pitch/shape.ts
// 전술 수치 → 팀 블록 형태. "슬라이더를 만지면 도트가 실제로 움직인다"의 정본.
//
// 왜 필요한가: formations.ts의 HOME_COORDS는 포메이션의 **원형**(4-3-3이 어떻게 생겼나)일
// 뿐이라, 라인 높이를 90으로 올려도 수비수가 자기 박스 앞에 서 있었다. 작전판은 수비 라인을
// 선으로 그리면서 도트는 그 선과 8% 어긋난 자리에 두었다 — 그림이 거짓말을 했다.
// 여기서 base 좌표에 전술 변환을 걸어 **마커와 도트를 같은 숫자에서 파생**시킨다.
//
// 계약(테스트로 고정): 백라인 그룹의 평균 x == lineDepth(lineHeight). 정확히 같다.
// 그래서 압박(pressing)은 백라인 x를 건드리지 않는다 — 라인 슬라이더가 백라인의 유일한 정본이고,
// 압박은 그 앞 두 라인이 얼마나 바짝 붙느냐(블록 기울기)와 좌우 폭을 정한다.
import type { FormationId, Instructions } from '../../engine/types'
import { slotCoords, XI_SLOTS, type Coord } from './formations'

/** 라인 높이 0~100 → home-프레임 x(0~100). 최저 8(자기 박스 앞) ~ 최고 42(하프라인 앞). */
export function lineDepth(lineHeight: number): number {
  return 8 + Math.max(0, Math.min(100, lineHeight)) * 0.34
}

/** 압박 강도 0~100 → 라인 앞으로 뻗는 압박 존 깊이(0~100 좌표). */
export function pressReach(pressing: number): number {
  return 10 + Math.max(0, Math.min(100, pressing)) * 0.35
}

/** 라인 그룹 경계(home-프레임 base x). GK는 슬롯 0으로 따로 판정한다. */
const DEF_MAX_X = 32
const MID_MAX_X = 66

/**
 * 라인별 추종 계수 — 라인을 올리면 **수비진이 가장 크게** 올라가고 앞선은 덜 올라간다.
 * 근거: 실제 축구에서 하이 라인은 오프사이드 트랩으로 백라인을 통째로 밀어올리지만,
 * 최전방은 상대 백라인(과 피치 길이)에 막혀 그만큼 못 올라간다 → 블록이 압축된다.
 * 반대로 라인을 내리면 공격수는 역습 기점으로 남아 블록이 길어진다.
 * 4-3-3 기준 base 블록 길이 54(23.5→77.5)가 라인 90에서 40, 라인 10에서 60이 된다.
 */
const FOLLOW = { gk: 0.18, def: 1, mid: 0.62, att: 0.3 } as const

/**
 * 압박 → 블록 기울기(x)와 폭(y).
 * ·기울기: 압박이 높으면 중원이 백라인이 아니라 최전방 쪽으로 붙어 컴팩트한 하이 블록이
 *   되고, 낮으면 중원이 처져 두 줄 수비가 길어진다. 백라인은 0 — 라인 슬라이더의 영역이다.
 * ·폭: 압박 팀은 중앙 패스 레인을 지우려고 좁히고, 물러선 팀은 폭을 지키려 벌린다.
 *   ±18%는 실측 트래킹의 팀 폭 변동(약 30~40m 범위) 안쪽 값이다.
 */
const PRESS_TILT = { def: 0, mid: 3.5, att: 1.5 } as const
const PRESS_NARROW = 0.18

/** 피치 밖으로 나가지 않게(도트 반지름 2.4 + 여백). */
const clampX = (x: number) => Math.max(2, Math.min(97, x))
const clampY = (y: number) => Math.max(4, Math.min(96, y))

type Group = 'gk' | 'def' | 'mid' | 'att'

function groupOf(slotIndex: number, baseX: number): Group {
  if (slotIndex === 0) return 'gk'
  if (baseX < DEF_MAX_X) return 'def'
  if (baseX < MID_MAX_X) return 'mid'
  return 'att'
}

/** 포메이션의 백라인 슬롯 인덱스(GK 제외, base x < DEF_MAX_X). 4백은 4명, 3백은 3명, 5백은 5명. */
export function backlineIndices(formation: FormationId): number[] {
  const out: number[] = []
  for (let i = 1; i < XI_SLOTS[formation].length; i++) {
    if (groupOf(i, slotCoords(formation, i, 'home').x) === 'def') out.push(i)
  }
  return out
}

/** 포메이션별 base 백라인 평균 x(변환의 기준점). 테이블은 상수라 한 번만 계산한다. */
const baseDefMeanCache = new Map<FormationId, number>()
function baseDefMean(formation: FormationId): number {
  const hit = baseDefMeanCache.get(formation)
  if (hit != null) return hit
  const idx = backlineIndices(formation)
  const mean = idx.reduce((s, i) => s + slotCoords(formation, i, 'home').x, 0) / idx.length
  baseDefMeanCache.set(formation, mean)
  return mean
}

/**
 * 전술이 반영된 슬롯 좌표. slotCoords와 같은 계약(0~100, away는 x 미러)이지만
 * 라인 높이·압박이 블록을 움직인다.
 *
 * @param formation 포메이션
 * @param slotIndex 0~10 (XI_SLOTS 순서)
 * @param side      'home'(좌→우 공격) | 'away'(x 미러)
 * @param ins       전술 지시(lineHeight·pressing만 형태에 관여한다)
 */
export function tacticalCoords(
  formation: FormationId,
  slotIndex: number,
  side: 'home' | 'away',
  ins: Instructions,
): Coord {
  const base = slotCoords(formation, slotIndex, 'home')
  const g = groupOf(slotIndex, base.x)
  // 백라인이 목표 x(lineDepth)로 통째로 이동하는 양. 나머지 라인은 이 양의 비율만큼 따라간다.
  const shift = lineDepth(ins.lineHeight) - baseDefMean(formation)
  const p = (Math.max(0, Math.min(100, ins.pressing)) - 50) / 50
  const x = base.x + FOLLOW[g] * shift + (g === 'gk' ? 0 : PRESS_TILT[g] * p)
  // 폭 조절은 필드 플레이어만 — GK는 골문 정면(y 50)을 지킨다.
  const y = g === 'gk' ? base.y : 50 + (base.y - 50) * (1 - PRESS_NARROW * p)
  const hx = clampX(x)
  return { x: side === 'home' ? hx : 100 - hx, y: clampY(y) }
}
