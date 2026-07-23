// src/ui/pitch/formations.ts
// 포메이션별 XI 슬롯 순서 + 0~100 피치 좌표 테이블.
// 슬롯 순서는 엔진 lineup(pickBestXI)이 생성하는 lineup 배열 인덱스와 반드시 일치해야 한다.
// 현재 엔진은 4-3-3만 생성하지만(src/engine/lineup.ts XI_433),
// Phase 2B 라인업 화면이 나머지 5종도 재사용하도록 여기서 6종을 모두 정의·export 한다.
import type { FormationId, Position } from '../../engine/types'

export type Coord = { x: number; y: number }

/** 각 포메이션의 XI 슬롯 순서 (홈 기준 = 좌→우 공격, 인덱스 0 = GK).
 *  4-3-3은 엔진 lineup.ts의 XI_433와 동일 순서. */
export const XI_SLOTS: Record<FormationId, Position[]> = {
  '4-3-3':   ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST'],
  '4-2-3-1': ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'DM', 'LW', 'AM', 'RW', 'ST'],
  '4-4-2':   ['GK', 'CB', 'CB', 'LB', 'RB', 'LW', 'CM', 'CM', 'RW', 'ST', 'ST'],
  '3-5-2':   ['GK', 'CB', 'CB', 'CB', 'LW', 'DM', 'CM', 'CM', 'RW', 'ST', 'ST'],
  '4-1-4-1': ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'LW', 'CM', 'CM', 'RW', 'ST'],
  '5-4-1':   ['GK', 'CB', 'CB', 'CB', 'LB', 'RB', 'LW', 'CM', 'CM', 'RW', 'ST'],
}

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
