import type { AttackPattern, BoxLoad, FormationId, Foot, GroupIntensity, Instructions, Mentality, PhaseFormations, Position, SetPiecePlan, SetPieceRoute, TacticState } from './types'

// 상삼각만 정의, 반대칭으로 자동 완성. 근거: docs/research/tactics-modern-football.md §3.1a
//
// ── 상성표는 서열이 아니라 순환이어야 한다 (2026-08-01) ─────────────────────
// 구판(리서치 §3.1 초안을 그대로 이식한 표)은 가위바위보가 아니라 **전력 서열**이었다.
// 행 합(= 그 형태가 나머지 5종에 대해 갖는 이점의 총합)을 계산하면:
//   3-5-2 +0.21(5승 0패) · 4-3-3 +0.12(4-1) · 4-2-3-1 +0.04(3-2) ·
//   4-1-4-1 −0.02(2-3) · 5-4-1 −0.17(0-5) · 4-4-2 −0.18(1-4)
// 순환이 하나도 없다. 3-5-2를 고르면 상대가 누구든 이득, 5-4-1을 고르면 항상 손해다.
// "객관적으로 좋은 포메이션"이 존재하면 상성 축의 선택 자체가 의미를 잃는다.
//
// 원인은 표가 사실상 **축 하나(중앙 인원수)의 정렬**이었다는 것이다. 중원 5명(3-5-2)이
// 정점, 중원 2명(4-4-2·5-4-1)이 바닥 — 한 축으로 줄을 세우면 결과는 반드시 서열이다.
// 재설계는 **서로 순서가 다른 세 축**의 합으로 만든다. 정렬이 어긋나면 순환이 생긴다.
//   ① 중앙 인원수      3-5-2·4-1-4-1(5) > 4-3-3·4-2-3-1(3) > 4-4-2·5-4-1(2)
//   ② 라인 사이 스태거  4-3-3(지연 침투 8번 둘)·4-2-3-1(10번) > 평평한 4열(4-4-2·4-1-4-1)
//      단 단일 홀딩은 **고정된 기준점 하나**(10번)는 지워도 **뒤늦게 도착하는 둘**은 못 지운다
//      → 4-1-4-1은 4-2-3-1에 강하고 4-3-3에 약하다. 첫 순환이 여기서 나온다.
//   ③ 측면 겹침        두 겹(5-4-1·4-1-4-1·4-4-2) > 한 겹(3-5-2 — 폭이 윙백에서만 나온다)
// 순환 예: 3-5-2 →① 4-3-3 →② 4-1-4-1 →①③ 3-5-2 · 4-4-2 →③ 5-4-1 →③ 4-3-3 →① 4-4-2
//
// 결과 불변식 두 개(tactics.test.ts가 고정한다 — 값을 손대면 함께 확인하라):
//   행 합 전부 |·| ≤ 0.03  ·  여섯 형태 모두 최소 2승 2패
//   4-3-3 +0.02(3-2) · 4-2-3-1 −0.02(2-3) · 4-4-2 −0.02(2-3)
//   3-5-2 +0.03(3-2) · 4-1-4-1 +0.02(3-2) · 5-4-1 −0.03(2-3)
// 쌍별 축구 근거는 리서치 문서 §3.1a에 한 줄씩 적혀 있다.
//
// ── 4-3-3 ↔ 4-2-3-1 쌍 정정 (2026-08-01, 같은 날 후속) ──────────────
// 위 재설계의 첫 판은 이 쌍을 **4-2-3-1 > 4-3-3 (+0.04)**로 뒀다(근거: "더블 피벗이 8번 둘을
// 2v2로 묶는 동안 10번은 단일 피벗 혼자 감당"). 두 가지가 이 값을 무너뜨렸다.
//  (a) **축 ②와 모순**이다. 축 ②는 스스로 "고정된 기준점 하나(10번)는 지울 수 있어도 뒤늦게
//      도착하는 둘은 지우지 못한다"고 적어 놓고, 정작 그 원리를 4-1-4-1 쌍에만 적용했다.
//      같은 원리를 이 쌍에 그대로 쓰면 부호가 반대다 — 4-3-3의 단일 6번이 감당할 것은
//      **위치가 고정된 10번 하나**이고, 4-2-3-1의 더블 피벗이 감당할 것은 **뒤늦게 도착하는
//      8번 둘**이다. ①(중앙 3 대 3)과 ③(양쪽 다 풀백+와이드 한 겹씩)은 이 쌍에서 정확히
//      비긴다. 즉 이 쌍을 가르는 것은 ②뿐이고, ②는 4-3-3 쪽이다. 크기는 규약 하한 0.02 —
//      세 축 중 둘이 비겼다는 사실이 곧 "거의 대등"이라는 뜻이다.
//  (b) **캠페인이 뒤집혔다.** 한국 기본은 4-2-3-1, 최종 보스 프랑스는 4-3-3이다. +0.04는
//      "가장 어려운 경기에서 기본값이 보스를 이긴다"는 뜻이고, 실측으로 그 대가가 나왔다 —
//      vs fra 공격 패턴 기울기가 −0.135/−0.133 → **−0.066/−0.056**으로 반토막 나 P3 게이트
//      (|기울기| > 0.06)를 깼다. 형태 우위가 상대 진영에서의 여유를 늘려 크로스·침투의
//      **차이**를 눌렀기 때문이다. 정정 후 재측정값은 아래 ③ 실측표에 적었다.
// 이 쌍 하나만 뒤집으면 4-3-3 행이 +0.05, 4-2-3-1 행이 −0.08로 둘 다 규약을 벗어난다.
// 두 행을 같이 맞추느라 두 값을 더 손댔고, 둘 다 같은 원리(**피벗 지대를 누가 지키는가**)의
// 귀결이다. 숫자를 맞추려고 고른 게 아니라 원리가 먼저 가리킨 값이다.
//   · 4-3-3 > 4-4-2  +0.05 → **+0.02** · 4-2-3-1 > 4-4-2 +0.03 → **+0.05**
//     중원 3v2(①)는 두 형태가 똑같이 누린다. 갈리는 것은 4-4-2의 **둘째 스트라이커**가
//     내려앉는 지대다. 4-3-3은 그 자리를 6번 혼자 지키므로 8번 둘이 올라가는 순간(=②의
//     이점을 쓰는 순간) 비고, 4-2-3-1은 피벗 둘 중 하나가 늘 남는다. 4-4-2 > 4-1-4-1
//     (+0.05)의 근거로 이미 쓴 "피벗이 비운 공간을 둘째 스트라이커가 노린다"와 같은 항이다.
//   · 5-4-1 > 4-2-3-1 +0.02 → **4-2-3-1 > 5-4-1 +0.02** (부호 반전)
//     구판 근거는 "백5가 10번의 포켓을 사람으로 채운다"였는데, 자기 박스를 지키는 백5는
//     포켓까지 나오지 않는다. 포켓으로 나오는 것은 홀딩 미드필더이고 5-4-1엔 없다
//     (있는 형태가 4-1-4-1이고, 그래서 4-1-4-1만 4-2-3-1을 잡는다). 축으로 따져도
//     ③은 비기고(4-2-3-1도 풀백+와이드 두 겹) ①(중앙 3 대 2)·②가 모두 4-2-3-1 쪽이다.
//     구판은 ②를 5-4-1에만 유리하게 두 번 읽고 있었다.
//
// ── 다시 죽은 레버가 되지 않았는지 실측했다 (DiD) ─────────────────
// 아래 F1 주석이 기록하듯 이 표는 한때 **경기 결과에 닿지 않는 장식**이었다. 순환 구조를
// 만들어도 효과가 SE 안이면 아무것도 한 게 아니므로, 표 **하나만**의 순효과를 분리해 쟀다.
// 방법은 DiD다 — 우리 형태 A·B를 고정하고 **상대 형태만** 바꾼다:
//   DiD = [pts(A|상대 O1) − pts(B|상대 O1)] − [pts(A|상대 O2) − pts(B|상대 O2)]
// 우리 posture(무게중심)는 안쪽 두 차이에서 그대로 상쇄되고 formationEdge만 남는다.
// (n=4000 페어드 · 상대 mex·cze × 시드 대역 2개 = 조합당 4회 · DiD 1회의 SE ≈ 0.017,
//  4회 평균 SE ≈ 0.0085. 하네스: tools/tactics-balance/run.mjs did)
//   우리 {4-3-3, 4-1-4-1} · 상대 {3-5-2, 4-4-2}   edge DiD 구판 −0.03 → 신판 −0.20
//     구판 −0.004 −0.007 −0.010 −0.010 (평균 **−0.008 = 0.9σ, 판정 불가**)
//     신판 −0.110 −0.083 −0.066 −0.087 (평균 **−0.086 = 10σ**)
//   우리 {4-2-3-1, 4-4-2} · 상대 {4-1-4-1, 3-5-2}  edge DiD 구판 0.00(정확히) → 신판 −0.11
//     구판 +0.000 −0.018 +0.020 +0.019 (평균 **+0.005 = 0.6σ**)
//     신판 −0.021 −0.050 −0.036 −0.042 (평균 **−0.037 = 4.4σ**)
// 구판이 실제로 0을 재고 있었다는 것(둘째 조합은 설계상 정확히 0)이 하네스의 영점 확인도 된다.
//
// 위 4-3-3↔4-2-3-1 정정 뒤 같은 측정을 다시 돌렸다(n=4000 페어드, 같은 하네스).
//   첫 조합 표값 −0.20 → **−0.17**(4-3-3>4-4-2를 0.05에서 0.02로 내린 몫)
//     −0.095 −0.068 −0.054 −0.071 (평균 **−0.072 = 8.5σ**) — 10σ에서 8.5σ로 내려앉았을 뿐
//     여전히 SE의 8배다. 표값 대비 실측비 0.42로 정정 전(0.086/0.20 = 0.43)과 같다:
//     크기만 줄었고 **전달 경로는 그대로**라는 뜻이다.
//   둘째 조합 표값 −0.11 → **−0.11**(네 성분 전부 이번 정정 밖이라 설계상 불변)
//     −0.021 −0.050 −0.036 −0.042 (평균 **−0.037 = 4.4σ**) — 정정 전과 소수 셋째 자리까지 동일.
//     건드리지 않은 조합이 같은 값을 돌려주는 것이 이번 재측정의 대조군이다.
const EDGES: Partial<Record<FormationId, Partial<Record<FormationId, number>>>> = {
  //           상대 →      4-2-3-1        4-4-2        3-5-2        4-1-4-1       5-4-1
  '4-3-3':   { '4-2-3-1': 0.02, '4-4-2': 0.02, '3-5-2': -0.05, '4-1-4-1': 0.05, '5-4-1': -0.02 },
  '4-2-3-1': {                  '4-4-2': 0.05, '3-5-2': -0.03, '4-1-4-1': -0.04, '5-4-1': 0.02 },
  '4-4-2':   {                                  '3-5-2': -0.05, '4-1-4-1': 0.05, '5-4-1': 0.05 },
  '3-5-2':   {                                                  '4-1-4-1': -0.05, '5-4-1': -0.05 },
  '4-1-4-1': {                                                                    '5-4-1': 0.03 },
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
 *  근거: 실팀 전개 지표 rsa 48 / can 56 / cze·ecu 59 / mex 64 / kor 64 / esp 77.
 *  폭 13은 이 12팀 분포에서 mex 0.62 · esp −0.38이 되도록 잡은 값이다.
 *
 *  ⚠ 상한 1.1 → 1.5 (2026-08-01). 구판 상한은 **당시 최댓값(rsa 1.46)을 잘라 내도록**
 *  잡혀 있었고, 그래서 후방 전개가 가장 나쁜 팀들이 전부 같은 값(1.1)에 뭉쳤다 —
 *  can 1.23도 함께 잘렸다. 즉 "전개 능력이 나쁠수록 압박이 잘 통한다"는 이 함수의 본문이
 *  분포의 아래쪽 끝에서는 **작동하지 않는 죽은 구간**이었다(실측: 압박 50→80의 페어드 승점
 *  차가 rsa +0.056 · can +0.067 · cze −0.020 — 가장 못 빠져나가는 팀이 캐나다와 구분되지 않았다).
 *  상한 자체는 남긴다. 발산 방지이자 "완전히 가둘 수는 없다"는 상한이며, 1.5에서
 *  라인·압박 동시 최대의 compress는 1.125 = 상대 찬스 억제 하한 0.44다.
 *  수리 후 같은 실측(n=4000 페어드 · SE 0.010 · tools/tactics-balance/run.mjs press):
 *    rsa **+0.125**(+5.0pp) · can +0.088 · ecu +0.045 · cze −0.020 · mex −0.064
 *  압박 축의 부호·크기가 상대의 전개 능력 순서를 그대로 따른다. rsa가 선두로 분리된 것은
 *  이 상한 변경과 rsa 스쿼드 재보정(data/teams/rsa.json statBaseline.source 참고)의 합이다. */
/*  전개 능력에만 의존하므로 인자는 그 두 필드로 좁힌다 — 추천 계층(game/scouting)이
 *  같은 판별자를 재사용할 때 쓰지도 않는 oppFrontPace를 지어내지 않아도 되게 하기 위함이다. */
export const trapFactor = (ctx: Pick<MatchupContext, 'oppGkBuildup' | 'oppPossession'>) =>
  clamp((72 - (ctx.oppGkBuildup + ctx.oppPossession) / 2) / 13, -0.5, 1.5)

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
    /** 이 팀이 **내주는 찬스의 질**(상대 xG) 배수. 지시 축은 여기서 항상 1.0이다 —
     *  라인의 뒷공간 비용은 이미 counterVulnerability(찬스 빈도)에 한 번 과금돼 있고,
     *  같은 축에 이중 과금하면 Task 2가 세운 라인 게이트의 균형이 무너진다.
     *  멘탈리티(E1)가 이 항을 쓴다 — 이유는 MENTALITY_FX 주석 참고. */
    concedeQuality: 1.0,
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
//
// ── E1 수정(멘탈리티 지배 제거) ─────────────────────────────────
// 문제: 착수 전 실측(n=400, 지시 중립)에서 승점 기울기(매우공격 − 매우수비)가
// rsa +0.210 / mex +0.107 / **esp +0.035** 로 전 상대에서 양수였다. 세계 2위 상대로도
// 총공세가 손해가 아니었다는 뜻이고, 그러면 멘탈리티 5단은 정답이 하나뿐인 장식이 된다.
//
// 원인: 공격적 태세의 유일한 비용인 counterVulnerability가 **찬스 빈도**에만 붙는데,
// chanceP는 clamp(…, 0.02, 0.45) 상한에 걸린다. 강팀을 상대할수록 전력비 항
// (ratio^STRENGTH_SENSITIVITY)이 이미 상한을 밀어붙이고 있어서, 정작 처벌이 가장 커야 할
// 매치업에서 +28%가 상한에 먹혀 사라졌다. 반대로 이득(chanceRate·chanceQuality)은
// 우리 쪽 chanceP에 그대로 붙는다 — 비용만 희석되는 비대칭이었다.
//
// 처방 둘. 둘 다 상한에 먹히지 않는 경로다.
//  (1) concedeQuality — 내주는 찬스의 **질**(상대 xG)에 과금한다. 라인을 밀어올린 팀이
//      역습에 걸리면 상대는 슛을 '더 많이'가 아니라 '더 좋은 자리에서' 잡는다.
//      xG clamp(0.02~0.65)는 빈도 상한보다 훨씬 여유가 있어 강팀 상대에서도 실제로 물린다.
//      이 항이 상대 전력에 비례해 아프기 때문에(강팀 슈터 × 높은 strengthRatio) 기울기의
//      부호가 상대별로 갈린다 — 게이트가 요구하는 바로 그 성질이다.
//  (2) staminaDrain — 총공세는 체력을 태운다. 90분에 걸쳐 누적되는 비용이라 어떤 clamp도
//      우회할 수 없고, 후반 실효 능력치 하락으로 공수 양쪽에 되돌아온다.
//
// 그리고 두 위험 항(counterVulnerability·concedeQuality)은 **상대 공격진이 우리 수비보다
// 얼마나 강한가**에 비례해 물린다(simulate.ts counterRiskScale). 균일 배수로 두면
// 부호를 상대별로 가를 수 없다는 것이 1차 조정의 실측 결론이었다 —
// 균일하게 세게 매기면 esp 기울기가 −0.30으로 내려가는 동시에 rsa도 −0.035로 함께 뒤집혔다.
// 뒷공간을 내주는 대가는 그 공간을 쓸 상대가 있을 때만 발생한다.
const MENTALITY_FX: Record<Mentality, { chanceRate: number; chanceQuality: number; counterVulnerability: number; possessionBias: number; concedeQuality: number; staminaDrain: number }> = {
  'very-defensive': { chanceRate: 0.84, chanceQuality: 0.94, counterVulnerability: 0.78, possessionBias: 0.90, concedeQuality: 0.90, staminaDrain: 0.96 },
  'defensive':      { chanceRate: 0.92, chanceQuality: 0.97, counterVulnerability: 0.89, possessionBias: 0.95, concedeQuality: 0.95, staminaDrain: 0.98 },
  'balanced':       { chanceRate: 1.0,  chanceQuality: 1.0,  counterVulnerability: 1.0,  possessionBias: 1.0,  concedeQuality: 1.0,  staminaDrain: 1.0 },
  'attacking':      { chanceRate: 1.09, chanceQuality: 1.03, counterVulnerability: 1.13, possessionBias: 1.05, concedeQuality: 1.06, staminaDrain: 1.03 },
  'very-attacking': { chanceRate: 1.18, chanceQuality: 1.06, counterVulnerability: 1.28, possessionBias: 1.10, concedeQuality: 1.13, staminaDrain: 1.06 },
}
export const MENTALITIES: Mentality[] = ['very-defensive', 'defensive', 'balanced', 'attacking', 'very-attacking']
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

// ── P3 공격 패턴 상대 의존성 (2026-07-30) ─────────────────────────
// 문제(실측 n=2400 페어드 · SE 0.012, balanced 대비 승점 차): **cross가 상대와 무관하게 최적**
// 이었다 — rsa +0.111 · mex +0.103 · nor +0.130 · esp +0.093 · fra +0.093. through는 +0.03~0.00,
// longshot은 다섯 상대 전부 음수(−0.02)라 사실상 정답이 하나인 축이었다.
// 원인: cornerBias 1.6이 코너를 왕창 만들고 코너가 세트피스 슛으로 이어지는데,
// 유일한 대가인 onTargetBias 0.94가 그보다 작다. 어느 상대에게도 조건이 붙지 않았다.
//
// 처방 — 위 표의 배수를 **상대에 대한 조건부**로 바꾼다. 판별자는 축구가 이미 쓰는 것 둘이다.
//  (1) 상대 라인 높이 — 교과서 그대로다. 높게 서면 뒷공간이 있으니 침투(through)가 값을 하고,
//      낮게 서서 박스를 채우면 측면에서 열어야 한다(cross) — 그때 블록·굴절로 코너도 많이 나온다.
//      중거리(longshot)도 낮은 블록 쪽이다: 박스 밖은 비어 있고 박스 안엔 자리가 없다.
//      경기 중 코치 조언(game/coach.ts 공격 코치)이 이미 이 규칙을 말하고 있었는데
//      **엔진이 그 말을 지키지 않고 있었다** — 이제 배선이 조언과 일치한다.
//  (2) 매치업 우위(risk) — cross의 대가. 크로스를 올리려면 풀백·윙어가 라인을 넘어가야 하고,
//      걷어낸 크로스는 실제 축구에서 가장 흔한 역습 개시점이다. E1·F1과 같은 판별자로만
//      스케일한다: 뒷공간을 내주는 대가는 그 공간을 쓸 상대가 있을 때만 발생한다.
//
// 계수 근거(실측 기반 선형 예측, 승점): 상대 찬스 빈도 1%p ≈ 승점 0.007(rsa)~0.014(fra)이고
// cross 이득의 대부분이 cornerBias에서 나온다. K_CROSS_RISK 0.08이면 rsa(risk 0.39)에서
// 대가가 3.1%로 이득을 남기고, fra(2.5)에서 20%로 이득을 확실히 뒤집는다.
/** 상대 라인 높이 → '뒷공간이 열려 있는가' 0.5~1.5. 기준 50에서 정확히 1.0이라
 *  중립 라인 상대에는 위 표의 값이 그대로 나온다. 실팀 분포는 40(rsa)~62(esp). */
const spaceBehind = (line: number) => clamp(1 + (line - 50) / 20, 0.5, 1.5)
const K_CROSS_RISK = 0.08

/** 공격 패턴 판정 컨텍스트. 미지정이면 위 표 그대로다(회귀 불변). */
export interface PatternContext {
  /** 상대 프로필 라인 높이 0~100 */
  oppLineHeight: number
  /** 매치업 우위 기반 역습 위험 스케일(simulate.counterRiskScale) */
  risk: number
}

/** 공격 패턴 배수. `ctx`를 주면 상대 라인 높이·역습 위험에 따라 이득과 대가가 갈린다.
 *  `counterVulnerability`는 **이 팀이 내주는 찬스 빈도** 배수다(cross만 1.0이 아니다). */
export function attackPatternEffects(
  p: AttackPattern = 'balanced', ctx?: PatternContext,
): { chanceRate: number; chanceQuality: number; cornerBias: number; onTargetBias: number; counterVulnerability: number } {
  const base = ATTACK_PATTERN_FX[p]
  if (!ctx || p === 'balanced') return { ...base, counterVulnerability: 1.0 }
  const hi = spaceBehind(ctx.oppLineHeight)  // 뒷공간(하이라인 상대일수록 크다)
  const lo = 2 - hi                          // 낮은 블록(물러선 상대일수록 크다)
  if (p === 'through') return { ...base, chanceQuality: 1 + (base.chanceQuality - 1) * hi, counterVulnerability: 1.0 }
  if (p === 'longshot') return { ...base, chanceRate: 1 + (base.chanceRate - 1) * lo, counterVulnerability: 1.0 }
  return {
    chanceRate: base.chanceRate,
    chanceQuality: 1 + (base.chanceQuality - 1) * lo,
    cornerBias: 1 + (base.cornerBias - 1) * lo,
    onTargetBias: base.onTargetBias,
    counterVulnerability: 1 + K_CROSS_RISK * ctx.risk,
  }
}

// ── 주발(foot) — 인버티드 윙어 ───────────────────────────────────
// `Player.foot`은 선언·픽스처·PlayerCard 표시에만 있고 엔진 로직이 0건이었다(감사 §12).
// 개인 역할(playerRoles)은 아직 없으므로 **역할 없이 성립하는 사실 하나만** 배선한다:
//   왼발잡이가 오른쪽 윙에(또는 오른발잡이가 왼쪽 윙에) 서면 = 역측(인버티드).
//   안쪽으로 접어 들어가는 컷인 각이 열려 슛의 질이 오르는 대신, 라인을 타고 넘기는
//   크로스가 죽어 코너 획득이 줄어든다. 정측(내추럴)은 정확히 그 반대다.
// cross 패턴에서는 **찬스 퀄의 부호만** 뒤집힌다 — 크로스로 득점하려는 팀에겐 정측 윙어가 옳다.
// 코너 획득은 물리적 사실(라인 돌파 → 수비 굴절)이라 패턴과 무관하게 정측이 유리하다.
//
// 효과 크기 근거: 선수 개인 스탯이 주도권을 유지해야 한다는 원칙(§3.8 "역할 배수는 작게").
// 윙어가 슈터로 뽑히는 비율이 4-3-3에서 약 48%이므로, 퀄 ±5%는 팀 xG 기준 ±2.4%다.
// 실측(11개 상대 × n=400): 역측 배치 vs 정측 배치 승률 차 아래 보고 참조.
const FOOT_QUALITY_K = 0.05
const FOOT_CORNER_K = 0.10
const FOOT_NEUTRAL = { chanceQuality: 1.0, cornerBias: 1.0 }

/** 윙어 주발 적합도. 윙(LW/RW)이 아니거나 양발('B')·미상(null)이면 정확히 1.0(회귀 불변). */
export function footEffects(
  slot: Position, foot: Foot | null, pattern: AttackPattern = 'balanced',
): { chanceQuality: number; cornerBias: number } {
  if (slot !== 'LW' && slot !== 'RW') return FOOT_NEUTRAL
  if (foot === null || foot === 'B') return FOOT_NEUTRAL
  const inverted = (slot === 'RW' && foot === 'L') || (slot === 'LW' && foot === 'R')
  // s = +1 역측(컷인), −1 정측(크로스)
  const s = inverted ? 1 : -1
  // cross 패턴은 컷인 이점을 무효화하고 정측을 보상한다.
  const k = pattern === 'cross' ? -1 : 1
  return { chanceQuality: 1 + FOOT_QUALITY_K * s * k, cornerBias: 1 - FOOT_CORNER_K * s }
}

// ── 세트피스(코너) 지시 ─────────────────────────────────────────
// 전 축의 표준값이 정확히 1.0이라, TacticState.setPiece 미지정 시 세트피스 계산은
// 순수하게 선수 능력치(setPiece·physical·shooting·GK aerial)만으로 결정된다.
export const SET_PIECE_ROUTES: readonly SetPieceRoute[] = ['near', 'far', 'short']
export const BOX_LOADS: readonly BoxLoad[] = ['light', 'normal', 'heavy']

// 루트 배수 근거: game-design-plan §5 표 그대로.
//  니어 = 골문 앞 혼전(전환↑) + 클리어가 짧게 떨어져 역습 노출↑
//  숏   = 점유를 유지하는 안전한 선택(전환↓·역습 노출↓)
const ROUTE_FX: Record<SetPieceRoute, { conversion: number; counterRisk: number }> = {
  near:  { conversion: 1.15, counterRisk: 1.10 },
  far:   { conversion: 1.00, counterRisk: 1.00 },
  short: { conversion: 0.75, counterRisk: 0.80 },
}

// ── P4 세트피스 지시의 대가·상대 의존성 (2026-07-30) ────────────────
// 문제(실측 n=2400 페어드 · SE 0.012, far/normal 대비 승점 차): near/heavy가 다섯 상대 전부
// 최적이었다(rsa +0.062 · mex +0.065 · nor +0.065 · esp +0.062 · fra +0.047).
// 분해하면 루트 near가 +0.025, 인원 heavy가 +0.031, light가 −0.025다 — 즉 "니어에 사람을
// 많이 넣는다"는 조건 없는 정답이었다.
//
// 원인은 두 가지다.
//  (a) 루트 near의 전환 +15%가 **상대 골키퍼를 보지 않는다**. 실제 축구에서 니어포스트
//      혼전은 골키퍼의 영역이다 — 나와서 쳐내는 키퍼(제공권 82)에게 니어는 자살이고,
//      파포스트는 그의 손이 닿지 않는 곳이다. 지금은 두 상황이 같은 배수를 받았다.
//  (b) 인원 heavy의 대가(counterRisk 1.25)가 SP_COUNTER_BASE(0.05)에 **선형으로** 곱해져
//      경기당 추가 역습이 0.05회 수준이었다. 전환 이득(+0.20 × 세트피스 슛 1.75회)을
//      막을 크기가 아니다. 그리고 상대와 무관했다.

/** 루트 near의 전환 보정 — 상대 GK 제공권이 판별자다. 기준 77.5에서 정확히 0(=far와 동률),
 *  ±4.5에서 포화. ⚠ 기준은 **실제 출전하는 GK**(pickBestXI)의 제공권이지 스쿼드 최댓값이
 *  아니다 — 프랑스는 스쿼드 최대가 82인데 선발 GK는 76이다. 11개 상대의 선발 GK 분포는
 *  74(ecu) · 76(cze·rsa·can·fra) · 78(mex·nor·arg) · 80(eng·esp·mar)이라 다섯 팀은 니어가
 *  옳고 세 팀(80)은 니어가 손해이며 78인 세 팀이 경계다 — 루트가 상대를 읽는 축이 된다.
 *  폭 0.30은 실측 스케일에서 정한 값이다: 세트피스 슛 약 1.75회/경기 × 기준 xG 0.115라
 *  전환 ±30%가 경기당 득점 ±0.06 = 승점 ±0.04(페어드 SE 0.012의 3배)다. */
const K_NEAR_AERIAL = 0.30
const nearAerialRoom = (gkAerial: number) => clamp((77.5 - gkAerial) / 4.5, -1, 1)

/** 역습 노출 배수의 상대 의존 지수. 편차를 risk에 대해 **지수로** 키운다 —
 *  선형으로 곱하면 heavy의 대가가 경기당 역습 0.05회라 이득을 못 막고(위 (b)),
 *  뺄셈 형태는 risk가 크면 배수가 음수가 된다. 지수 형태는 항상 양수이고 로그 스케일에서
 *  대칭이라 light(0.80)의 이득과 heavy(1.35)의 대가가 같은 규칙으로 커진다.
 *  3.4의 근거(두 번의 실측 상향). 2.0에서는 fra(risk 2.5) far/heavy가 +0.012로 여전히 양수였고,
 *  2.8에서도 heavy−light 기울기가 fra −0.019(n=8000, SE 0.0066)에 그쳐 손익분기가 risk 2.1
 *  부근이었다 — 11개 상대 중 9개에서 heavy가 옳다는 뜻이라 "상대를 읽는 축"이라 부르기 어렵다.
 *  3.4면 heavy(1.35)의 지수가 fra에서 8.5(역습 확률 0.05 → 상한 0.55)·esp(1.563)에서 5.3,
 *  rsa(0.402)에서 1.37(0.057)이라 **저위험 상대에는 거의 걸리지 않는다**. 이 비대칭이
 *  인원 선택의 부호를 가른다.
 *
 *  ⚠ 태세에서 파생된 박스 인원(boxLoad 미지정 경로)에는 이 지수를 걸지 않는다.
 *  공격적 태세의 위험은 멘탈리티 축(E1)이 이미 risk로 스케일해 과금하고 있어, 여기서 또
 *  지수로 물리면 같은 선택에 이중 과금이 된다(B4에서 압박이 4중 과금이던 것과 같은 실수). */
const K_SP_RISK = 3.4

/** 세트피스 판정 컨텍스트. 미지정이면 전 축이 기존 값 그대로다(회귀 불변). */
export interface SetPieceContext {
  /** 상대 GK 제공권 0~100 */
  oppGkAerial: number
  /** 매치업 우위 기반 역습 위험 스케일(simulate.counterRiskScale) */
  risk: number
}
// 박스 인원: heavy는 GK 파워플레이의 축소판(이미 검증된 트레이드오프 패턴 재사용).
const BOX_FX: Record<BoxLoad, { conversion: number; counterRisk: number }> = {
  light:  { conversion: 0.85, counterRisk: 0.80 },
  normal: { conversion: 1.00, counterRisk: 1.00 },
  // P4: heavy의 역습 노출을 1.25 → 1.35로 올렸다. 1.25에서는 매치업 지수를 지수로 걸어도
  // 경기당 추가 역습이 0.10회에 그쳐(세트피스 슛이 경기당 1.75회뿐이다) 전환 +20%를 막지
  // 못했다 — 실측에서 far/heavy가 다섯 상대 전부 +0.024~+0.036이었다.
  heavy:  { conversion: 1.20, counterRisk: 1.35 },
}

// 태세 → 박스 투입 성향(-1 최소 … +1 최대). boxLoad 지시가 없을 때 여기서 파생한다.
// ★ 이 커플링이 필요한 이유(실측): 세트피스 골은 선수 능력치만으로 결정되면 **감독의 플랜과
//   무관한 득점**이 되어 추천 플랜의 승률 이득(runAbBatch Δ)을 통째로 희석한다.
//   실측에서 kor의 중립 지시 승률이 vs mex 42.7% → 45.7%로 올라 Δ가 3.7pp → 2.1pp로 눌렸다.
//   실제 축구에서도 코너에 몇 명을 올려보낼지는 태세의 문제다 — 그 사실을 배선해 되돌린다.
const MENTALITY_BOX: Record<Mentality, number> = {
  'very-defensive': -1, 'defensive': -0.5, 'balanced': 0, 'attacking': 0.5, 'very-attacking': 1,
}
// 폭 근거: heavy/light 지시(±0.20 전환 / ±0.25 역습)와 같은 스케일로 맞춘다 —
// 태세로 파생된 투입 성향이 명시 지시보다 세면 UI가 붙었을 때 지시가 무의미해진다.
const K_BOX_CONV = 0.22, K_BOX_RISK = 0.25

/** 공격 측 세트피스의 전환·역습노출 배수.
 *  boxLoad를 명시하면 그 값이 태세 파생을 덮어쓴다(감독의 직접 지시가 우선).
 *  둘 다 기본(balanced 태세·지시 없음)이고 ctx가 없으면 전 축 정확히 1.0.
 *  `ctx`를 주면 (a) 니어 전환이 상대 GK 제공권을 읽고 (b) 역습 노출이 매치업 우위로
 *  지수 스케일된다 — 근거는 위 P4 주석. */
export function setPieceEffects(
  t: Pick<TacticState, 'setPiece' | 'mentality' | 'groupIntensity'>, ctx?: SetPieceContext,
): { conversion: number; counterRisk: number } {
  const route = t.setPiece?.route ?? 'far'
  const r = ROUTE_FX[route]
  // 니어만 GK 제공권에 좌우된다. 파는 키퍼의 손이 닿지 않는 곳이고, 숏은 애초에 공중볼이 아니다.
  const rConv = ctx && route === 'near' ? 1 + K_NEAR_AERIAL * nearAerialRoom(ctx.oppGkAerial) : r.conversion
  const load = t.setPiece?.boxLoad
  let b: { conversion: number; counterRisk: number }
  if (load) b = BOX_FX[load]
  else {
    // 공격 라인 적극성은 태세의 절반 무게. 두 축이 같은 방향이면 heavy 지시와 같은 크기에 닿는다.
    const s = clamp(MENTALITY_BOX[t.mentality ?? 'balanced'] + (t.groupIntensity?.attack ?? 0) * 0.5, -1, 1)
    b = { conversion: 1 + K_BOX_CONV * s, counterRisk: 1 + K_BOX_RISK * s }
  }
  // 명시 지시(루트·박스 인원)만 매치업 지수로 스케일한다. 태세 파생분은 선형 그대로다
  // (E1이 이미 같은 선택을 risk로 과금한다 — 위 K_SP_RISK 주석의 이중 과금 경고).
  const declared = r.counterRisk * (load ? b.counterRisk : 1)
  const scaled = ctx ? Math.pow(declared, ctx.risk * K_SP_RISK) : declared
  return {
    conversion: rConv * b.conversion,
    counterRisk: scaled * (load ? 1 : b.counterRisk),
  }
}

/** 수비 측 마킹의 전환 억제 배수. 상대 박스 공중 위협이 높을수록 맨마킹이 유리하고,
 *  낮으면 존이 유리하다 — 맨마킹은 볼을 보지 못해 세컨볼을 내주기 때문이다.
 *  `threatNorm`은 0(무위협)~1(최대 위협). 존은 항상 1.0이라 미지정 시 회귀 불변. */
export function markingFactor(marking: SetPiecePlan['marking'], threatNorm: number): number {
  if (marking !== 'man') return 1.0
  return 1 - 0.08 * (2 * clamp(threatNorm, 0, 1) - 1)
}

// ── 그룹(라인) 적극성 ───────────────────────────────────────────
// 각 라인 -1|0|1. **무게중심 이동**이지 공짜 부스트가 아니다.
//
// E3 수정: 이전엔 존 무관하게 +1 → 1.06, −1 → 0.95였고 비용은 체력 −4%뿐이었다.
// 실측에서 attack:+1은 상대와 무관하게 +3~5pp — 사실상 정답이 하나인 축이었다
// (반면 midfield:+1은 음수였다. 미드필드 존이 점유 판정에만 쓰이고 점유는 참여 빈도
//  정규화로 승패에 거의 중립이기 때문이다. 같은 배수인데 부호가 갈리는 건 설계가 아니다).
//
// 이제 한 라인을 끌어올리면 **그 뒤 라인이 얇아진다** — 실제 축구의 무게중심 이동이다.
// 전방을 밀어올리면 뒤가 비고(공격+1 → 수비 존 0.97), 뒤를 두껍게 하면 앞이 고립된다.
// 미드필드는 앞뒤 양쪽에서 조금씩 가져오므로 절반씩(0.985) 나눠 문다.
// 전부 0이면 모든 존이 정확히 1.0 → 기존 동작 불변(시드 회귀 유지).
const GI_ZONE_FX: Record<'attack' | 'midfield' | 'defense', Record<'attack' | 'midfield' | 'defense', number>> = {
  //   적극 라인 ↓        영향 대상 존 →  attack        midfield      defense
  attack:   { attack: 1.06,  midfield: 1.0,  defense: 0.97 },
  midfield: { attack: 0.985, midfield: 1.06, defense: 0.985 },
  defense:  { attack: 0.97,  midfield: 1.0,  defense: 1.06 },
}
export function groupIntensityZoneFactor(gi: GroupIntensity | undefined, zone: 'attack' | 'midfield' | 'defense'): number {
  if (!gi) return 1.0
  let f = 1.0
  for (const line of ['attack', 'midfield', 'defense'] as const) {
    const v = gi[line]
    if (v === 0) continue
    const up = GI_ZONE_FX[line][zone]
    // 자제(−1)는 적극(+1)의 거울상이되 크기를 5/6로 둔다 — 물러서는 선택이 나가는 선택보다
    // 효과가 작아야 "전부 자제"가 새로운 지배 전략이 되지 않는다(체력은 오히려 아낀다).
    f *= v > 0 ? up : 1 + (1 - up) * (5 / 6)
  }
  return f
}
// ── P2 그룹 적극성의 대가 (2026-07-30) ─────────────────────────────
// 문제(실측 n=2400 페어드 · SE 0.012, 전부 0 대비 승점 차): 공격+1/중원−1이 다섯 상대 전부
// 양수였다(rsa +0.083 · mex +0.091 · nor +0.042 · esp +0.018 · fra +0.033). E3가 존 무게중심
// 이동을 넣어 크기는 줄었지만 **부호가 갈리지 않아** 여전히 "올리는 쪽이 정답"인 축이었다.
// 반대쪽 끝(공격−1/수비+1)도 rsa −0.094 … fra −0.003으로 부호가 하나다.
//
// 원인: E3의 무게중심 이동은 존 전력을 **재분배**할 뿐 어느 것도 위험으로 바꾸지 않는다.
// 그래서 "앞으로 미는 재분배가 우리 전력 구성에서 이득인가"만 남고, 상대는 등장하지 않는다.
// 실제 축구의 대가는 두 가지이고 서로 다른 것에 의존한다.
//  (1) 무게중심을 앞으로 옮기면 잃었을 때 처벌이 커진다 — 그 처벌은 **처벌할 상대가 있을 때만**
//      발생한다. E1(멘탈리티)·F1(형태)과 같은 판별자(risk)로만 스케일한다.
//  (2) 라인끼리 반대로 움직이면 **블록이 늘어난다**. 공격을 올리고 중원을 내리면 그 사이가
//      비고, 우리 공격은 지원 없이 고립된다. 이 대가는 상대가 아니라 우리 기하학의 문제라
//      risk로 스케일하지 않는다 — 이 비대칭이 "올려도 붙여서 올려라"를 강제한다.
//
// 계수 근거(실측 기울기 → 선형 예측). 무게중심 1단위당 승점 실측은 rsa +0.113 · mex +0.092 ·
// esp +0.026 · fra +0.022이고, 우리 찬스 질 1% ≈ 승점 0.0129 · 내주는 질은 0.75배 무게다(F1).
//  · K_GI_POSTURE 0.062 = 승점 0.06/단위/risk. rsa(0.39)에서 0.113−0.023 = +0.090으로 남고
//    esp(1.55) −0.067 · fra(2.5) −0.128로 뒤집힌다. 더 낮추면 esp가 페어드 SE와 구분되지 않는다.
//  · K_GI_ISO 0.02 = 늘어남 1단위당 우리 찬스 질 −2%(승점 −0.026). 공격+1/중원−1(늘어남 2)이
//    공격+1/중원+1(0)보다 0.05 불리해져, "붙여서 올리는" 편성이 argmax가 된다.
/** 무게중심(앞으로 −1…+1). 공격 라인과 수비 라인의 적극성 차. */
const giPosture = (gi: GroupIntensity) => (gi.attack - gi.defense) / 2
/** 블록 늘어남(0~2). 앞 라인이 뒷 라인보다 적극적인 만큼만 센다 — 뒤가 더 적극적인 편성
 *  (예: 수비+1/중원0)은 오히려 압축이라 벌하지 않는다. */
const giStretch = (gi: GroupIntensity) =>
  Math.max(0, gi.attack - gi.midfield) + Math.max(0, gi.midfield - gi.defense)
const K_GI_POSTURE = 0.062
const K_GI_ISO = 0.02
const GI_NEUTRAL = { chanceQuality: 1.0, concedeQuality: 1.0 }

/** 그룹 적극성의 찬스 질 대가. 전부 0이면 정확히 전 축 1.0(회귀 불변).
 *  `risk`는 simulate.counterRiskScale(대등하면 1.0). */
export function groupIntensityEffects(gi: GroupIntensity | undefined, risk: number): { chanceQuality: number; concedeQuality: number } {
  if (!gi || (gi.attack === 0 && gi.midfield === 0 && gi.defense === 0)) return GI_NEUTRAL
  return {
    chanceQuality: 1 - giStretch(gi) * K_GI_ISO,
    concedeQuality: 1 + giPosture(gi) * K_GI_POSTURE * risk,
  }
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
/** 포메이션의 공격 성향 스칼라(-1 수비적 … +1 공격적). 공격 존 수 - 수비 존 수 기반 정규화.
 *  formationEffects(F1)와 추천 계층(game/scouting)이 같은 표를 읽어야 조언과 엔진이 어긋나지 않는다. */
export const FORMATION_POSTURE: Record<FormationId, number> = {
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

// ── P1 페이즈 포메이션의 대가 (2026-07-30) ──────────────────────────
// 이 저장소에 남아 있던 **가장 큰 공짜 점심**이었다. 실측(n=2400 페어드 · SE 0.012, 중립 지시,
// 미선언 대비 승점 차): 공격 3-5-2 / 수비 5-4-1이 rsa +0.198 · mex +0.259 · nor +0.220 ·
// esp +0.275 · fra +0.308. 다른 축의 지배 방지 임계(0.30)에 육박하고, 상대가 강할수록 더 컸다.
//
// 원인은 phaseTilt가 **읽히지 않는 존만 깎는다**는 것이다.
//   공격 페이즈의 존 전력은 effectiveAttack(attack·midfield)만 소비되는데 틸트는 defense를 깎고,
//   수비 페이즈는 effectiveDefense(defense·midfield)만 소비되는데 틸트는 attack을 깎는다.
// 즉 보상은 언제나 읽히는 쪽에, 대가는 언제나 버려지는 쪽에 붙어 있었다. 두 페이즈를 각각
// 극단으로 선언하면 두 보상을 동시에 받고 대가는 하나도 치르지 않는다.
//
// 위 실측을 네 조합(3-5-2·5-4-1의 2×2)에서 선형 분리하면 두 항이 깨끗하게 나온다
// (무게중심 1단위당 승점, 양수는 그 방향이 이득):
//   공격 페이즈 전진  rsa +0.192 · mex +0.204 · esp +0.172 · fra +0.178  → **상대 무관**
//   수비 페이즈 후진  rsa +0.102 · mex +0.158 · esp +0.190 · fra +0.200  → 이미 상대 의존
// 4-4-2/4-4-2(무게중심 0.15)가 실측 −0.001~+0.017로 0에 붙는 것이 이 선형 모형의 검증이다.
//
// 처방 — 두 항에 각각 다른 것에 의존하는 대가를 붙인다.
//  (1) 공격 페이즈에 앞에 사람을 두면 **레스트 디펜스가 얇아진다**. 그 대가는 그 공간을 쓸
//      상대가 있을 때만 발생한다 — E1(멘탈리티)·F1(형태)이 검증한 원리라 같은 판별자
//      (simulate.counterRiskScale)로만 스케일한다. 이 항이 공격 페이즈에 부호 반전을 만든다.
//  (2) 수비 페이즈에 뒤에 사람을 두면 **회수 지점이 자기 골문 앞**이다. 골문까지 70m를 가야
//      하는 전환은 질이 낮다. 이 대가는 상대의 강함이 아니라 기하학이라 **risk로 스케일하지
//      않는다**. 실측 이득이 0.102(rsa)~0.200(fra)로 이미 갈려 있으므로, 그 사이에 고정
//      대가를 두면 수비 페이즈도 부호가 갈린다.
//  (3) 두 페이즈 형태가 다를수록 전환마다 이동 거리가 길다. 3-5-2↔5-4-1이면 윙백이 매 전환
//      풀 플랭크를 왕복한다 — 체력으로 문다. 어떤 clamp도 우회할 수 없는 누적 비용이다.
//
// 계수 근거(F1 주석 (a)의 실측 환산: 우리 찬스 질 1% ≈ 승점 0.0129, 내주는 질은 그 0.75배):
//  · K_PF_REST 0.20 → 승점 0.194/단위/risk. rsa(0.39) 0.192−0.076 = +0.116이 남고
//    esp(1.55) −0.129 · fra(2.5) −0.293으로 뒤집힌다. 0.15로 낮추면 esp가 −0.05로 얕아져
//    페어드 SE(0.012)의 4배 마진을 확보하지 못한다.
//  · K_PF_DEEP 0.10 → 승점 0.129/단위. 실측 이득 0.102(rsa)와 0.200(fra) **사이**에 놓이는
//    유일한 구간이 0.11~0.19이고, 그 가운데를 잡았다.
//  · K_PF_SHUTTLE 0.05 → 무게중심 차 1.55(3-5-2↔5-4-1)에서 체력 소모 +7.8%. 그룹 적극성의
//    라인당 ±4%와 같은 스케일이다.
//
// ★ 세 항 모두 xG·체력 경로다 — 슛 '수'를 건드리지 않으므로 캘리브레이션 계약(팀별 슛/90분
//   ±15%, 실팀 ±25%)은 **정의상 불변**이다. 게다가 캘리브레이션 배치는 phaseFormations를
//   선언하지 않아 전 항이 1.0이다.
/** 페이즈 미지정은 무게중심 0으로 읽는다 — phaseTilt가 미지정 페이즈에 1.0(=posture 0)을
 *  돌려주므로 보상과 대가가 정확히 같은 기준을 쓴다. */
const phasePosture = (f: FormationId | undefined) => (f ? FORMATION_POSTURE[f] : 0)
const K_PF_REST = 0.20
/** 뒤에 남겨두는 쪽(pa<0)의 **되돌아오는 이득은 절반**이다. 앞에 사람을 두면 역습에 걸리지만,
 *  뒤에 남긴다고 상대의 정돈된 공격까지 사라지지는 않는다 — 얻는 것은 '전환에 당하지 않는 것'
 *  하나뿐이다. E3(그룹 적극성)가 자제를 적극의 5/6로 둔 것과 같은 이유이며, 이 비대칭이 없으면
 *  risk 상한(2.5)에서 대가가 통째로 이득으로 뒤집혀 **후진 선언이 새로운 지배 전략**이 된다
 *  (실측: 대칭 판에서 vs fra 5-4-1/5-4-1이 미선언 대비 +0.391로 다른 축을 전부 압도했다). */
const K_PF_REST_BACK = 0.5
const K_PF_DEEP = 0.10
const K_PF_SHUTTLE = 0.05
const PF_NEUTRAL = { chanceQuality: 1.0, concedeQuality: 1.0, staminaDrain: 1.0 }

/** 페이즈 포메이션 선언의 대가. 미선언(또는 양 페이즈 모두 미지정)이면 전 축 정확히 1.0
 *  → 시드 회귀 불변. `risk`는 simulate.counterRiskScale(대등하면 1.0). */
export function phaseFormationEffects(
  pf: PhaseFormations | undefined, risk: number,
): { chanceQuality: number; concedeQuality: number; staminaDrain: number } {
  if (!pf || (!pf.attack && !pf.defense)) return PF_NEUTRAL
  const pa = phasePosture(pf.attack), pd = phasePosture(pf.defense)
  return {
    chanceQuality: 1 + pd * K_PF_DEEP,
    concedeQuality: 1 + pa * K_PF_REST * risk * (pa < 0 ? K_PF_REST_BACK : 1),
    staminaDrain: 1 + Math.abs(pa - pd) * K_PF_SHUTTLE,
  }
}

// ── F1 포메이션 축 비단조성 ──────────────────────────────────────
// 문제(2026-07-30 실측): 유저가 워룸에서 **가장 먼저 고르는 축**인 포메이션에만 상대 의존이
// 하나도 없었다. kor 6포메이션 × 8상대(n=3200, 중립 지시)에서 순위가 **여덟 상대 전부 동일**
// 했다: 3-5-2 > 4-4-2 > … > 5-4-1. 승점 폭 0.061~0.123, 페어드 SE 0.012~0.018이므로
// 노이즈가 아니라 4~8σ의 고정 정답이었다. 상대가 스페인이든 남아공이든 같은 형태가 옳다면
// 기획서 원칙 3("상대가 다르면 정답이 다르다")이 이 축에서 거짓이 된다.
//
// 원인은 formationEdge가 **경기 결과에 닿지 않는 곳**에만 배선돼 있었다는 것이다.
// 유일한 소비처가 simulateMinute의 점유 가중(possW)인데, 찬스·파울 롤은 참여 빈도로
// 정규화된다(chanceP ∝ 1/participation) — 기댓값이 정확히 상쇄돼 점유는 승패에 중립이다.
// 실측으로 확인했다(EDGES에 배수 AMP를 걸고 n=3200):
//   arg vs 3-5-2 (edge +0.08): AMP1 1.298 → AMP2 1.303 → AMP3 1.325 → AMP5 1.354
//   cze vs 4-4-2 (edge −0.08): AMP1 1.915 → AMP5 1.918   mex vs 3-5-2 (+0.04): 1.712 → 1.704
// 즉 실제 사용 구간(|edge| ≤ 0.08)에서 formationEdge의 승점 기여는 **0.01 미만, SE(0.033)
// 안**이다. AMP 3~5(=|edge| 0.24~0.40)부터 움직이는 것은 participation 하한(0.15)과
// chanceP 상한(0.45)에 걸리는 포화 효과이지 선형 응답이 아니다. 상성표는 장식이었다.
//
// ── 배선 원칙: 전부 **찬스의 질(xG)** 경로로만 보낸다 ──────────────
// 슛 '수'(chanceRate·counterVulnerability)를 건드리면 캘리브레이션 계약(팀별 슛/90분
// ±15%, 실팀 ±25%)이 형태마다 흔들린다. 형태의 효과를 xG 축에만 실으면 그 계약은
// 정의상 불변이고, 승패에는 그대로 반영된다(goalP ∝ chanceQuality).
//
// 두 항을 배선한다. 각각 다른 것에 의존하므로 최적 형태가 두 방향으로 갈린다.
//  (1) 상성(shape) — 상대 **형태**에 의존. 형태 우위는 상대 라인 사이에서 자유로운 몸을
//      만든다는 뜻이다 → 찬스의 질. 상대 쪽은 정확히 반대 부호를 받으므로(edge 반대칭)
//      실점 질에 따로 과금할 필요가 없다.
//  (2) 태세(posture) — 상대 **전력**에 의존. 앞에 사람을 많이 두는 형태(3-5-2·4-3-3)는
//      좋은 자리를 더 자주 잡는 대신 뒤가 얇아 내주는 찬스의 질이 오른다. 뒤에 사람을
//      많이 두는 형태(5-4-1·4-1-4-1)는 그 반대다. **뒷공간을 내주는 대가는 그 공간을 쓸
//      상대가 있을 때만 발생한다** — 멘탈리티(E1)가 이미 검증한 원리라, 같은 판별자
//      (simulate.counterRiskScale = 매치업 우위^-10)로 실점 항만 스케일한다.
//      이득(찬스 질)은 스케일하지 않는다. 이 비대칭이 부호 반전을 만든다:
//        risk(rsa) 0.40 → 전진 배치가 거의 공짜   risk(fra) 2.5(상한) → 대가가 3배 아프다
//
// ⚠ **F1만으로는 고칠 수 없다.** 위 고정 정답의 진짜 뿌리는 상성표가 아니라 두 개의
//   공짜 점심이었고, 그건 strength.ts(F0 존 인원수)와 simulate.ts(F2 미드필드)에서 고쳤다.
//   F1은 그 위에 **상대 전력 의존성**을 얹는 층이다. 셋을 따로 켜 보면 역할이 분명하다
//   (n=1600, 중립 지시, 3-5-2 − 5-4-1 페어드 승점 차 / 6종 argmax):
//     원본        rsa +0.117(3-5-2) · mex +0.187(3-5-2) · esp −0.101(5-4-1은 최하) · fra −0.465
//                 → 실제 순위는 8상대 전부 3-5-2 > 4-4-2 > … > 5-4-1로 동일
//     F0만        rsa −0.018(4-4-2) · mex −0.104(4-4-2) · esp −0.099(4-4-2) · fra −0.056(4-4-2)
//                 → **고정 정답이 3-5-2에서 4-4-2로 옮겨갔을 뿐**이다. 미드필드가 승패에
//                   중립이라 "미드 2명"의 대가가 여전히 0이기 때문 → F2가 필요한 이유.
//     F0+F2       rsa +0.131(4-3-3) · mex +0.091(4-1-4-1) · esp +0.089(4-3-3) · fra +0.077(4-3-3)
//                 → 공짜 점심은 사라졌다(4-4-2·3-5-2 모두 하위권). 그러나 여전히 **상대 무관**이다.
//     F0+F2+F1    rsa +0.185(4-3-3) · mex +0.069(4-3-3) · esp −0.124(4-1-4-1) · fra −0.264(5-4-1)
//
// ── 계수 3개의 실측 근거 ─────────────────────────────────────────
// 격자 탐색이 아니라 응답 계수를 먼저 재고 선형 모형으로 풀었다.
// (a) 승점은 "우리 찬스 질 %"와 "내주는 찬스 질 %"의 선형 결합에 잘 맞는다. 계수 실측
//     (n=1600, 3-5-2 vs 5-4-1 페어드): 순변화 1%당 승점 0.0129, 그리고 **내주는 질은
//     우리 질의 약 0.75배 무게**다(rsa 0.76 · esp 0.79 · fra 0.72 · mex 0.49로 추정).
//     비대칭인 이유는 xG clamp(0.02~0.65)·goalP clamp(0.55)가 강팀 쪽 상한에서 먼저 물려
//     실점 증가분이 일부 잘려 나가기 때문이다.
// (b) 목표는 셋이다: rsa 기울기 ≥ +0.12 · esp ≤ −0.10 · mex 6종 폭을 F0+F2 수준으로 유지.
//     rsa−esp 격차는 오직 K_POSTURE_CONCEDE × (risk 차)에서만 나오므로 그 값이 먼저 정해지고
//     (0.13), 나머지 둘은 rsa 목표에 맞춰 따라온다. 예측과 실측이 ±0.02 안에서 일치했다.
// (c) F0가 3-5-2의 수비 존을 얇게 만든 뒤로 **형태별 risk 자체가 갈린다**(kor 기준
//     3-5-2 rsa 0.86 / esp 2.50, 5-4-1 rsa 0.45 / esp 1.76). 그래서 F0 이전 판(0.17)보다
//     작은 0.13으로도 같은 부호 반전이 나오고, 프랑스전 극단 폭이 0.58 → 0.26으로 줄었다.
//
/** 상성 → 찬스 질. edge 폭 ±0.08이므로 질 ±2.4%, 두 형태 간 최대 차 약 5%.
 *  attackFocus 도박(±8%)보다 작게 둔다 — 형태 상성이 공격 방향 선택을 압도하면 안 된다. */
const K_SHAPE_Q = 0.30
/** 태세 → 자기 찬스 질. posture 폭 −1.0~+0.55이므로 −6.0%~+3.3%. */
const K_POSTURE_Q = 0.06
/** 태세 → 내주는 찬스 질(risk 배). 손익분기 risk는 K_POSTURE_Q/K_POSTURE_CONCEDE = 0.46,
 *  즉 **매치업 우위가 약 1.08배는 돼야 전진 배치가 값을 한다**. 남아공(형태별 risk
 *  0.45~0.86)은 그 위, 멕시코(0.72~1.38)는 경계, 스페인(1.76~2.50)은 한참 아래다.
 *  0.13은 rsa·esp 두 목표를 동시에 만족시키는 최솟값 근처다 — 더 낮추면 esp 기울기가
 *  −0.065까지 얕아져 게이트 마진(0.06)과 구분되지 않는다(실측 KC=0.10에서 확인). */
const K_POSTURE_CONCEDE = 0.13

/** 포메이션이 경기에 미치는 효과. 두 항 모두 찬스 질(xG) 배수다.
 *  `risk`는 simulate.counterRiskScale(매치업 우위 기반, 대등하면 1.0).
 *  같은 형태끼리 붙고 risk=1이면 chanceQuality·concedeQuality가 posture만으로 결정된다 —
 *  형태를 안 고르는 선택지가 없으므로 "전 축 1.0인 기본값"은 존재하지 않는다(멘탈리티와 다름). */
export function formationEffects(
  ours: FormationId, theirs: FormationId, risk: number,
): { chanceQuality: number; concedeQuality: number } {
  const posture = FORMATION_POSTURE[ours]
  return {
    chanceQuality: (1 + formationEdge(ours, theirs) * K_SHAPE_Q) * (1 + posture * K_POSTURE_Q),
    concedeQuality: 1 + posture * K_POSTURE_CONCEDE * risk,
  }
}

