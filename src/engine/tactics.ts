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
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 상대 성향 컨텍스트. 지정 시 라인·압박의 "상대 억제" 항과 상대 의존 비용이 활성화된다.
 *  미지정이면 전 항이 중립이라 기존 수치와 완전히 동일하다(시드 회귀 불변). */
export interface MatchupContext {
  /** 상대 최전방(ST/LW/RW) pace 평균 0~100 */
  oppFrontPace: number
  /** 상대 GK buildup 0~100 */
  oppGkBuildup: number
  /** 상대 프로필 점유 성향 0~100 */
  oppPossession: number
}

// ── 지시 축 밸런스 계수 (Task 2) ────────────────────────────────
// 문제: 기존엔 라인·압박의 이득이 '자기 공격'에만, 비용이 '자기 수비'에만 붙어
// 상대와 무관하게 "안 하면 이득"인 단조 지배 전략이었다(실측: 라인/압박 모두 10이 최적).
// 실제 축구에서 하이라인·하이프레스의 본질적 보상은 **상대를 방해하는 것**이므로
// 그 항(suppression·chanceRate 압축 이득)을 추가하고, 효율을 상대의 후방 전개 능력에
// 반비례시켜 최적값이 상대별로 갈리게 한다.

/** 중립대(40~60) 밖 편차를 -1~+1로. 중립대는 정확히 0이라 기본 지시는 무영향. */
const dev = (v: number) => (v > 60 ? (v - 60) / 40 : v < 40 ? (v - 40) / 40 : 0)

/** 압박·하이라인의 '가두기' 효율. 상대의 후방 전개 능력(GK 빌드업·점유 성향 평균)이
 *  기준(72) 이하일수록 크고, 그 위(스페인급 78)면 음수 = 벗겨져 역효과.
 *  근거: 실팀 전개 지표 rsa 53 / cze 59 / mex 64 / kor 64 / esp 78.
 *  폭 13은 이 12팀 분포에서 rsa 1.1(상한) · mex 0.62 · esp −0.46이 되도록 잡은 값이다. */
const trapFactor = (ctx: MatchupContext) =>
  clamp((72 - (ctx.oppGkBuildup + ctx.oppPossession) / 2) / 13, -0.5, 1.1)

// 압축 이득의 축 가중. 압박이 라인보다 직접적으로 상대 전개를 끊는다.
const W_LINE = 0.4, W_PRESS = 0.6
// 압축 → 자기 찬스 빈도(상대 진영 회수). 라인·압박 최대치 동시 사용 시 ±(0.75×1.1×0.34) ≈ ±28%
const K_RATE = 0.34
// 압축 → 상대 찬스 억제. 같은 스케일에 조금 더 큰 계수(방해가 회수보다 확실하다)
const K_SUP = 0.50
// 압박 → 점유 탈취(표시·모멘텀용). 승패 자체엔 참여 빈도 정규화로 중립이다.
const K_POSS = 0.20
// 물러선 라인 + 빠른 템포 = 전환 공격. 상대가 나와 있을수록 배후 공간이 커진다.
const K_COUNTER = 1.0

export function instructionEffects(ins: Instructions, ctx?: MatchupContext) {
  const line = ins.lineHeight, press = ins.pressing, tempo = ins.tempo
  // 결합 증폭: 하이라인×하이프레스가 함께 갈 때 역습 취약성 초과 증가 (레스트 디펜스 부재 모델링)
  const comboBoost = line > 70 && press > 70 ? ((line - 70) / 30) * ((press - 70) / 30) * 0.5 : 0
  // 각 lerp 구간은 기준 지시(50)에서 정확히 1.0이 되도록 중심을 맞춤 (lo+hi=2.0).

  // ── B1·B3 압축(하이라인 + 하이프레스) → 상대 빌드업 방해 ──
  // 양방향이다: 올리면 상대를 가두고(compress>0), 내리면 상대에게 전개를 허용한다(compress<0).
  // 저지시를 '공짜 수비 보너스'로 두면 단조 지배가 되살아나기 때문에 하방에도 대가를 둔다.
  const trap = ctx ? trapFactor(ctx) : 0
  const compress = (dev(line) * W_LINE + dev(press) * W_PRESS) * trap
  const suppression = ctx ? 1 - compress * K_SUP : 1.0
  // B3 점유 탈취: 압박이 높고 상대 전개가 약할수록 크다.
  const pressGain = ctx ? dev(press) * K_POSS * trap : 0

  // ── B2b 역습 보상 ──
  // 라인을 내리는 선택에 '안전' 말고 보상도 준다: 물러선 블록(라인<40) + 빠른 템포(>60)는
  // 전환 공격이다. 보상은 상대가 얼마나 나와 있느냐(점유 성향)에 비례한다 —
  // 스페인급(78)에겐 배후가 넓고, 이미 물러서 있는 남아공(40)에겐 노릴 배후가 없다.
  // 두 축 모두 중립대 안이면 0이라 기본 지시·축 스윕(다른 축 50 고정)에는 나타나지 않는다.
  const counterGain = ctx && line < 40 && tempo > 60
    ? -dev(line) * ((tempo - 60) / 40) * clamp((ctx.oppPossession - 55) / 45, 0, 1) * K_COUNTER
    : 0

  // ── B2 하이라인 역습 비용을 상대 최전방 속도에 비례 ──
  // pace 75에서 1.0(기존과 동일), 빠르면 최대 1.35, 느리면 0.65까지 완화.
  // 하방(라인 ≤ 50)은 스케일 미적용 — 물러선 라인의 안전은 상대 속도와 무관하다.
  const paceScale = ctx ? clamp(0.65 + ((ctx.oppFrontPace - 55) / 40) * 0.7, 0.65, 1.35) : 1.0
  const lineRaw = lerp(line, 0.75, 1.25)
  const lineVul = line <= 50 ? lineRaw : 1 + (lineRaw - 1) * paceScale

  return {
    chanceRate: lerp(tempo, 0.78, 1.22) * lerp(press, 0.9, 1.1) * (1 + compress * K_RATE),
    chanceQuality: lerp(tempo, 1.11, 0.89) * lerp(line, 0.945, 1.055) * (1 + counterGain),
    // ── B4 압박 항 제거 ──
    // 역습 취약성은 '라인 뒤 공간'의 함수다. 압박 비용은 foulRate·staminaDrain·지속압박이 담당한다
    // (기존엔 4중 과금이라 압박이 상대와 무관하게 손해였다).
    counterVulnerability: lineVul * (1 + comboBoost),
    possessionBias: lerp(tempo, 1.08, 0.92) * lerp(press, 0.935, 1.065) * (1 + pressGain),
    foulRate: lerp(press, 0.775, 1.225),
    // pressing 폭 0.74~1.26 (±0.52): 압박 90에서 staminaDrain > 1.2 계약(테스트)을 만족시키기 위한 값 — 재계산 시 경계 주의
    staminaDrain: lerp(press, 0.74, 1.26) * lerp(tempo, 0.915, 1.085),
    /** 이 팀의 수비 태세가 상대 찬스 빈도를 억제하는 배수. ctx 없으면 1.0 */
    suppression,
  }
}

/** 공격 방향 집중의 효과. 상대의 해당 측면 수비 강도가 낮을수록 보상이 크다.
 *  balanced는 정확히 1.0(기존 동작). 집중은 성공 시 +8%, 실패 시 −8% 수준의 도박. */
export function attackFocusEffects(
  focus: Instructions['attackFocus'],
  oppFlank: { left: number; right: number; center: number },
): { chanceQuality: number } {
  if (focus === 'balanced') return { chanceQuality: 1.0 }
  const avg = (oppFlank.left + oppFlank.right + oppFlank.center) / 3
  const target = oppFlank[focus]
  // 평균 대비 상대적 약점 비율. −1(매우 강함)~+1(매우 약함) 범위로 정규화.
  const edge = clamp((avg - target) / Math.max(15, avg * 0.35), -1, 1)
  return { chanceQuality: 1 + edge * 0.08 }
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
