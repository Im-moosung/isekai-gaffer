// src/engine/formations.ts
// 포메이션 정본(엔진 계층): XI 슬롯 순서 테이블 + 실데이터 포메이션 문자열 매핑.
// 계층 원칙: engine은 data/ui를 import하지 않는다. XI_SLOTS(ui/pitch/formations.ts)와
// mapFormation(data/loader.ts)이 원래 각 계층에 있었으나, 엔진 lineup(pickBestXI)이
// 이를 필요로 하므로 여기(engine)로 이동한다. ui·data는 여기서 import·재수출한다.
import type { FormationId, Position } from './types'

/** 각 포메이션의 XI 슬롯 순서 (홈 기준 = 좌→우 공격, 인덱스 0 = GK).
 *  이 순서는 ui/pitch/formations.ts의 좌표 테이블(HOME_COORDS) 인덱스와 반드시 일치해야 한다. */
export const XI_SLOTS: Record<FormationId, Position[]> = {
  '4-3-3':   ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'CM', 'CM', 'LW', 'RW', 'ST'],
  '4-2-3-1': ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'DM', 'LW', 'AM', 'RW', 'ST'],
  '4-4-2':   ['GK', 'CB', 'CB', 'LB', 'RB', 'LW', 'CM', 'CM', 'RW', 'ST', 'ST'],
  '3-5-2':   ['GK', 'CB', 'CB', 'CB', 'LW', 'DM', 'CM', 'CM', 'RW', 'ST', 'ST'],
  '4-1-4-1': ['GK', 'CB', 'CB', 'LB', 'RB', 'DM', 'LW', 'CM', 'CM', 'RW', 'ST'],
  '5-4-1':   ['GK', 'CB', 'CB', 'CB', 'LB', 'RB', 'LW', 'CM', 'CM', 'RW', 'ST'],
}

// ── 포메이션 매핑 ─────────────────────────────────────────────
const SUPPORTED: readonly FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

// 미지원 포메이션 → 가장 가까운 지원 6종
const FORMATION_MAP: Record<string, FormationId> = {
  '4-2-2-2': '4-4-2',
  '3-4-2-1': '3-5-2',
  '4-1-3-2': '4-4-2',
  '3-1-4-2': '3-5-2',
}

/** 실제 대회 포메이션 문자열을 엔진의 FormationId(6종)로 매핑한다. */
export function mapFormation(pref: string): FormationId {
  if ((SUPPORTED as readonly string[]).includes(pref)) return pref as FormationId
  if (pref in FORMATION_MAP) return FORMATION_MAP[pref]
  return '4-4-2'
}
