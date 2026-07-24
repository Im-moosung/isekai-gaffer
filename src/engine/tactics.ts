import type { AttackPattern, FormationId, GroupIntensity, Instructions, Mentality, PhaseFormations } from './types'

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

// ── 멘탈리티 5프리셋 ────────────────────────────────────────────
// instructionEffects 위에 곱해지는 배수. 'balanced'는 전 축 정확히 1.0 → 기존 동작 불변.
// 공격적일수록 찬스 빈도·퀄·점유 편향↑ + 역습 취약성↑(리스크), 수비적일수록 반대.
export const MENTALITIES: Mentality[] = ['very-defensive', 'defensive', 'balanced', 'attacking', 'very-attacking']
const MENTALITY_FX: Record<Mentality, { chanceRate: number; chanceQuality: number; counterVulnerability: number; possessionBias: number }> = {
  'very-defensive': { chanceRate: 0.84, chanceQuality: 0.94, counterVulnerability: 0.78, possessionBias: 0.90 },
  'defensive':      { chanceRate: 0.92, chanceQuality: 0.97, counterVulnerability: 0.89, possessionBias: 0.95 },
  'balanced':       { chanceRate: 1.0,  chanceQuality: 1.0,  counterVulnerability: 1.0,  possessionBias: 1.0 },
  'attacking':      { chanceRate: 1.09, chanceQuality: 1.03, counterVulnerability: 1.13, possessionBias: 1.05 },
  'very-attacking': { chanceRate: 1.18, chanceQuality: 1.06, counterVulnerability: 1.28, possessionBias: 1.10 },
}
export function mentalityEffects(m: Mentality = 'balanced') { return MENTALITY_FX[m] }

// ── 공격 패턴 4종 ───────────────────────────────────────────────
// 공격 측에만 적용. 'balanced'는 전 축 1.0 → 기존 동작 불변.
//  cross    = 코너·헤더 찬스↑(cornerBias) 컷인↓ — 퀄 소폭↑, 유효슛 확률 소폭↓
//  through  = 중앙 침투: 찬스 퀄↑ 대신 인터셉트 리스크로 찬스 빈도↓
//  longshot = 중거리: 슛 빈도↑(chanceRate) 대신 xG↓(chanceQuality)
export const ATTACK_PATTERNS: AttackPattern[] = ['balanced', 'cross', 'through', 'longshot']
const ATTACK_PATTERN_FX: Record<AttackPattern, { chanceRate: number; chanceQuality: number; cornerBias: number; onTargetBias: number }> = {
  'balanced': { chanceRate: 1.0,  chanceQuality: 1.0,  cornerBias: 1.0, onTargetBias: 1.0 },
  'cross':    { chanceRate: 1.0,  chanceQuality: 1.05, cornerBias: 1.6, onTargetBias: 0.94 },
  'through':  { chanceRate: 0.90, chanceQuality: 1.16, cornerBias: 1.0, onTargetBias: 1.0 },
  'longshot': { chanceRate: 1.14, chanceQuality: 0.80, cornerBias: 1.15, onTargetBias: 1.0 },
}
export function attackPatternEffects(p: AttackPattern = 'balanced') { return ATTACK_PATTERN_FX[p] }

// ── 그룹(라인) 적극성 ───────────────────────────────────────────
// 각 라인 -1|0|1. 존 전력 배수: +1 → 1.06, 0 → 1.0(불변), -1 → 0.95.
export function groupIntensityZoneFactor(gi: GroupIntensity | undefined, zone: 'attack' | 'midfield' | 'defense'): number {
  if (!gi) return 1.0
  const v = gi[zone]
  return v > 0 ? 1.06 : v < 0 ? 0.95 : 1.0
}
// 체력 소모 배수: 적극(+1) 라인 하나당 +4% 가중, 자제(-1)는 -2%. 전부 0 → 1.0(불변).
export function groupIntensityStaminaFactor(gi: GroupIntensity | undefined): number {
  if (!gi) return 1.0
  let f = 1.0
  for (const z of ['attack', 'midfield', 'defense'] as const) {
    const v = gi[z]
    if (v > 0) f += 0.04
    else if (v < 0) f -= 0.02
  }
  return f
}

// ── 페이즈 포메이션(공격 시/수비 시 존 가중 이동) ────────────────
// 포메이션의 공격 성향 스칼라(-1 수비적 … +1 공격적). 공격 존 수 - 수비 존 수 기반 정규화.
const FORMATION_POSTURE: Record<FormationId, number> = {
  '5-4-1': -1.0, '4-1-4-1': -0.35, '4-2-3-1': -0.1, '4-4-2': 0.15, '4-3-3': 0.45, '3-5-2': 0.55,
}
/** 페이즈 포메이션에 따른 존 가중 배수. 미지정 페이즈면 1.0(불변).
 *  공격 페이즈: 공격 포메이션일수록 attack↑ defense↓. 수비 페이즈: 수비 포메이션일수록 defense↑ attack↓. */
export function phaseTilt(pf: PhaseFormations | undefined, phase: 'attack' | 'defense', zone: 'attack' | 'midfield' | 'defense'): number {
  if (!pf) return 1.0
  const f = pf[phase]
  if (!f) return 1.0
  const posture = FORMATION_POSTURE[f] // -1..+1
  const K = 0.12
  if (phase === 'attack') {
    if (zone === 'attack') return 1 + posture * K
    if (zone === 'defense') return 1 - posture * K
    return 1.0
  }
  // defense 페이즈: 수비적 포메이션(posture<0)일수록 defense↑ attack↓
  if (zone === 'defense') return 1 - posture * K
  if (zone === 'attack') return 1 + posture * K
  return 1.0
}
