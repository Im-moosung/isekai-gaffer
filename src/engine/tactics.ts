import type { FormationId, Instructions } from './types'

// 상삼각만 정의, 반대칭으로 자동 완성. 근거: docs/research/tactics-modern-football.md §3
const EDGES: Partial<Record<FormationId, Partial<Record<FormationId, number>>>> = {
  '4-3-3':   { '4-2-3-1': 0.03, '4-4-2': 0.06, '3-5-2': -0.04, '4-1-4-1': 0.02, '5-4-1': 0.05 },
  '4-2-3-1': { '4-4-2': 0.04, '3-5-2': -0.03, '4-1-4-1': 0.02, '5-4-1': 0.04 },
  '4-4-2':   { '3-5-2': -0.08, '4-1-4-1': -0.03, '5-4-1': 0.03 },
  '3-5-2':   { '4-1-4-1': 0.04, '5-4-1': 0.02 },
  '4-1-4-1': { '5-4-1': 0.03 },
}

export function formationEdge(a: FormationId, b: FormationId): number {
  if (a === b) return 0
  const direct = EDGES[a]?.[b]
  if (direct !== undefined) return direct
  return -(EDGES[b]?.[a] ?? 0)
}

const lerp = (t: number, lo: number, hi: number) => lo + ((hi - lo) * t) / 100

export function instructionEffects(ins: Instructions) {
  const line = ins.lineHeight, press = ins.pressing, tempo = ins.tempo
  // 결합 증폭: 하이라인×하이프레스가 함께 갈 때 역습 취약성 초과 증가 (레스트 디펜스 부재 모델링)
  const comboBoost = line > 70 && press > 70 ? ((line - 70) / 30) * ((press - 70) / 30) * 0.5 : 0
  // 각 lerp 구간은 기준 지시(50)에서 정확히 1.0이 되도록 중심을 맞춤 (lo+hi=2.0).
  // 방향·기울기·결합 증폭 구조는 브리프 원안을 그대로 유지.
  return {
    chanceRate: lerp(tempo, 0.78, 1.22) * lerp(press, 0.9, 1.1),
    chanceQuality: lerp(tempo, 1.11, 0.89) * lerp(line, 0.945, 1.055),
    counterVulnerability: lerp(line, 0.75, 1.25) * lerp(press, 0.925, 1.075) * (1 + comboBoost),
    possessionBias: lerp(tempo, 1.08, 0.92) * lerp(press, 0.935, 1.065),
    foulRate: lerp(press, 0.775, 1.225),
    // pressing 폭 0.74~1.26 (±0.52): 압박 90에서 staminaDrain > 1.2 계약(테스트)을 만족시키기 위한 값 — 재계산 시 경계 주의
    staminaDrain: lerp(press, 0.74, 1.26) * lerp(tempo, 0.915, 1.085),
  }
}
