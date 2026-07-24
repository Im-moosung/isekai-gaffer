// src/ui/pitch/formations.ts
// 포메이션별 0~100 피치 좌표 테이블. XI 슬롯 순서(XI_SLOTS)는 엔진 정본
// (src/engine/formations.ts)에서 import·재수출한다 — 기존 UI 사용처는 무변경.
// HOME_COORDS 인덱스는 XI_SLOTS 슬롯 순서와 반드시 일치해야 한다.
import type { FormationId } from '../../engine/types'
import { XI_SLOTS } from '../../engine/formations'

export { XI_SLOTS }

export type Coord = { x: number; y: number }

/** 홈(좌→우 공격) 기준 0~100 좌표. x = 골라인(좌, 낮음) → 상대 골(우, 높음), y = 위(0)→아래(100). */
const HOME_COORDS: Record<FormationId, Coord[]> = {
  '4-3-3': [
    { x: 6, y: 50 },                    // GK
    { x: 22, y: 38 }, { x: 22, y: 62 }, // CB CB
    { x: 24, y: 15 }, { x: 24, y: 85 }, // LB RB
    { x: 40, y: 50 },                   // DM
    { x: 52, y: 32 }, { x: 52, y: 68 }, // CM CM
    { x: 75, y: 18 }, { x: 75, y: 82 }, // LW RW
    { x: 80, y: 50 },                   // ST
  ],
  '4-2-3-1': [
    { x: 6, y: 50 },
    { x: 22, y: 38 }, { x: 22, y: 62 },
    { x: 24, y: 15 }, { x: 24, y: 85 },
    { x: 40, y: 38 }, { x: 40, y: 62 }, // DM DM
    { x: 66, y: 18 },                   // LW
    { x: 62, y: 50 },                   // AM
    { x: 66, y: 82 },                   // RW
    { x: 82, y: 50 },                   // ST
  ],
  '4-4-2': [
    { x: 6, y: 50 },
    { x: 22, y: 38 }, { x: 22, y: 62 },
    { x: 24, y: 15 }, { x: 24, y: 85 },
    { x: 50, y: 15 },                   // LW (LM)
    { x: 48, y: 40 }, { x: 48, y: 60 }, // CM CM
    { x: 50, y: 85 },                   // RW (RM)
    { x: 76, y: 38 }, { x: 76, y: 62 }, // ST ST
  ],
  '3-5-2': [
    { x: 6, y: 50 },
    { x: 22, y: 30 }, { x: 22, y: 50 }, { x: 22, y: 70 }, // CB CB CB
    { x: 45, y: 12 },                   // LW (LWB)
    { x: 40, y: 50 },                   // DM
    { x: 52, y: 35 }, { x: 52, y: 65 }, // CM CM
    { x: 45, y: 88 },                   // RW (RWB)
    { x: 76, y: 38 }, { x: 76, y: 62 }, // ST ST
  ],
  '4-1-4-1': [
    { x: 6, y: 50 },
    { x: 22, y: 38 }, { x: 22, y: 62 },
    { x: 24, y: 15 }, { x: 24, y: 85 },
    { x: 38, y: 50 },                   // DM
    { x: 58, y: 15 },                   // LW (LM)
    { x: 55, y: 40 }, { x: 55, y: 60 }, // CM CM
    { x: 58, y: 85 },                   // RW (RM)
    { x: 80, y: 50 },                   // ST
  ],
  '5-4-1': [
    { x: 6, y: 50 },
    { x: 22, y: 30 }, { x: 22, y: 50 }, { x: 22, y: 70 }, // CB CB CB
    { x: 26, y: 12 }, { x: 26, y: 88 }, // LB RB (wingbacks)
    { x: 52, y: 18 },                   // LW (LM)
    { x: 50, y: 40 }, { x: 50, y: 60 }, // CM CM
    { x: 52, y: 82 },                   // RW (RM)
    { x: 78, y: 50 },                   // ST
  ],
}

/**
 * 포메이션 슬롯의 피치 좌표를 반환한다.
 * @param formation FormationId
 * @param slotIndex 0~10 (XI_SLOTS 순서와 동일)
 * @param side 'home'(좌→우 공격) | 'away'(우→좌 공격, x 미러)
 * @returns 0~100 좌표 { x, y }
 */
export function slotCoords(formation: FormationId, slotIndex: number, side: 'home' | 'away'): Coord {
  const base = HOME_COORDS[formation][slotIndex]
  if (!base) throw new Error(`잘못된 슬롯 인덱스: ${formation}[${slotIndex}]`)
  return side === 'home' ? { x: base.x, y: base.y } : { x: 100 - base.x, y: base.y }
}
