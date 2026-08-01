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

// ── 라이브 무브먼트 ────────────────────────────────────────────────
// 왜: 2D 작전판에서 공만 움직이고 선수는 못 박힌 듯 서 있었다. 실제 축구에서 선수는
// 포지션을 "유지"하는 동안에도 끊임없이 1~2m씩 몸을 옮기고, 팀 블록 전체가 공을 따라
// 좌우·전후로 미끄러진다. 그 두 가지만 얹는다 — 2D는 전술 시각화지 중계가 아니다.
//
// 결정론: Math.random·Date 금지. 위상은 (side, 슬롯)의 FNV 해시에서만 나오고,
// 시간 t는 호출자가 주는 틱 카운터 파생값이다(같은 t면 언제나 같은 좌표).

/** 라이브 무브먼트 입력. */
export interface LiveInput {
  /** 진행 위상(초). 결정론적 틱 카운터에서 파생한다. */
  t: number
  /** 공 위치(절대 프레임 0~100, home이 +x로 공격). 없으면 블록 이동 없음. */
  ball?: Coord
  /** 점유 정도 −1(어웨이 완전 점유) ~ +1(홈 완전 점유). 0이 중립.
   *  **불연속 열거형이 아니라 연속값**인 이유: 점유가 뒤집힐 때 계단식으로 바뀌면
   *  블록 전체가 한 프레임에 2.8유닛 순간이동한다(실측으로 잡은 글리치). */
  possess?: number
}

/**
 * 라인별 미세 진폭(0~100 프레임). 105×68m 피치에서 x 1.0 ≈ 1.05m, y 1.0 ≈ 0.68m.
 * 최전방 ±1.5x/±1.7y ≈ ±1.6m/±1.2m — 실제 선수가 상대 움직임에 맞춰 재정렬하는 폭.
 * 수비진은 라인을 지켜야 하므로 절반, GK는 골문 각도만 다듬으므로 그보다 더 작다.
 */
const LIVE_AMP: Record<Group, { x: number; y: number }> = {
  gk: { x: 0.5, y: 0.7 },
  def: { x: 0.9, y: 1.0 },
  mid: { x: 1.2, y: 1.4 },
  att: { x: 1.5, y: 1.7 },
}
/** 두 정현파의 주기(초) — 9.0초와 5.3초. 서로 나누어떨어지지 않아 패턴이 눈에 띄게 반복되지 않는다.
 *  주기로 **속도**를 정한다: 진폭 1.5에서 최대 1.3유닛/초(≈1.3m/s) — 걸으며 자리를 다듬는
 *  속도다. 주기를 5.5/3.4초로 짧게 잡았더니 22명이 계속 조깅하는 것처럼 보였다(실측 평균
 *  2.4m/s). 진폭이 아니라 주기를 늘려 "보이되 부산스럽지 않게" 맞췄다. */
const W1 = (Math.PI * 2) / 9.0
const W2 = (Math.PI * 2) / 5.3

/** 공 위치 → 블록 이동 계수. 좌우 0.20(터치라인 근처 공이면 약 5.4m 슬라이드),
 *  전후 0.09(공이 한쪽 박스 앞이면 약 3.3m). 실측 트래킹의 블록 슬라이드보다 보수적이다. */
const BALL_PULL_X = 0.09
const BALL_PULL_Y = 0.2
/** 점유 팀은 공격 방향으로 전진(+1.6), 비점유 팀은 자기 골문 쪽으로 후퇴(−1.2). 그 사이는 선형. */
const PUSH_ON = 1.6
const PUSH_OFF = 1.2
/** GK는 블록 슬라이드를 그대로 따라가지 않는다(골문을 비울 수 없다). */
const GK_DAMP = 0.35

/** 결정론 위상 — (side, 슬롯, 채널) → 0~2π. */
function livePhase(side: 'home' | 'away', slotIndex: number, ch: number): number {
  let h = 2166136261
  const s = `${side}:${slotIndex}:${ch}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000 * Math.PI * 2
}

/**
 * 라이브 좌표 11개(절대 프레임). tacticalCoords(전술 기반 정적 위치) 위에
 * ① 선수별 미세 진동 ② 공·점유 기반 블록 이동을 얹는다.
 *
 * ★ 마커-도트 일치 계약은 여기서도 유지된다 — 수비 라인 마커는 이 배열의
 *   백라인 평균에서 뽑는다(liveBacklineX). 별도 수식을 쓰지 않는다.
 */
export function liveTeamCoords(
  formation: FormationId,
  side: 'home' | 'away',
  ins: Instructions,
  live?: LiveInput,
): Coord[] {
  const n = XI_SLOTS[formation].length
  const dir = side === 'home' ? 1 : -1
  let bx = 0
  let by = 0
  if (live?.ball) {
    // own ∈ [−1,1] — 이 팀이 공을 얼마나 갖고 있나.
    const own = Math.max(-1, Math.min(1, live.possess ?? 0)) * dir
    bx = (live.ball.x - 50) * BALL_PULL_X + dir * (PUSH_ON * (own + 1) / 2 - PUSH_OFF * (1 - own) / 2)
    by = (live.ball.y - 50) * BALL_PULL_Y
  }
  const t = live?.t ?? 0
  const out: Coord[] = []
  for (let i = 0; i < n; i++) {
    const base = tacticalCoords(formation, i, side, ins)
    const g = groupOf(i, slotCoords(formation, i, 'home').x)
    const amp = LIVE_AMP[g]
    const p1 = livePhase(side, i, 1)
    const p2 = livePhase(side, i, 2)
    // 두 정현파 합성 — 진폭은 [-1,1]을 넘지 않는다(0.62+0.38=1).
    const u = 0.62 * Math.sin(W1 * t + p1) + 0.38 * Math.sin(W2 * t + p2)
    const v = 0.62 * Math.sin(W1 * 0.87 * t + p2) + 0.38 * Math.cos(W2 * 1.13 * t + p1)
    const damp = g === 'gk' ? GK_DAMP : 1
    out.push({
      x: clampX(base.x + amp.x * u * damp + bx * damp),
      y: clampY(base.y + amp.y * v * damp + by * damp),
    })
  }
  return out
}

/** 수비 라인 마커 x(절대 프레임) — liveTeamCoords의 백라인 평균. 정의상 도트와 일치한다. */
export function liveBacklineX(
  formation: FormationId,
  side: 'home' | 'away',
  ins: Instructions,
  live?: LiveInput,
): number {
  const cs = liveTeamCoords(formation, side, ins, live)
  const idx = backlineIndices(formation)
  return idx.reduce((s, i) => s + cs[i].x, 0) / idx.length
}

// ── 도트 가독성 분리 ──────────────────────────────────────────────
// 실제 축구에서 선수는 겹친다 — 대인 마크·경합은 정상이고, 억지로 떼면 거짓이 된다.
// 그래서 **겹침을 없애는 게 아니라 읽히게** 만든다: 두 도트가 완전히 포개져 한 명이
// 사라지는 것만 막고, 겹친 상태 자체는 남긴다(테두리·z순서가 두 원을 갈라 보여준다).
//
// 계약: 이동은 **쌍 대칭**이고 상한이 있다. 마커는 이 함수를 거친 좌표의 평균에서
// 뽑으므로(PitchView.meanBackline) 마커-도트 일치는 정의상 유지된다.

/** 도트 반지름(viewBox = m). PitchView의 `r={2.4}`와 같은 값이어야 한다. */
export const DOT_R_VB = 2.4
/**
 * "둘로 읽히는" 최소 중심 거리(viewBox ≈ m). 3.6이면 겹침 면적이 원 하나의 약 24%로
 * 남아 경합처럼 보이되, 뒤 도트의 등번호 중심(반지름 2.4 바깥)이 드러난다.
 * 실제 축구의 마크 간격(2~4m)과도 같은 범위다.
 */
export const MIN_DOT_SEP = 3.6
/** 한 선수를 전술 위치에서 밀 수 있는 최대치(viewBox = m). 미세 진동 진폭과 같은 급이다. */
const MAX_SEP_PUSH = 1.8
/** 완화 반복. 3회면 세 명이 뭉친 경우도 풀린다(수렴 실측). */
const SEP_ITER = 2
/** 0~100 프레임 → viewBox 환산(x 105m, y 68m). 겹침은 **화면 좌표**에서 판정해야 한다. */
const VB_X = 1.05
const VB_Y = 0.68

/**
 * 도트가 서로를 완전히 가리지 않도록 최소 간격까지만 벌린다(결정론).
 *
 * @param coords 절대 프레임 좌표 배열(홈 11 + 어웨이 11을 이어붙여 넘긴다)
 * @param active 그려지는 도트만 true. **퇴장 선수 자리**처럼 화면에 없는 슬롯은 false로
 *   넘긴다 — 안 그러면 보이지 않는 유령이 진짜 도트를 밀어낸다("도트가 이유 없이 밀린다").
 *   인덱스 정렬은 유지해야 하므로(라인업 슬롯 = 무버·캐리어 인덱스의 정본) 배열에서
 *   빼는 대신 마스크로 끈다. 생략하면 전부 활성.
 * @returns 새 배열. 입력은 건드리지 않는다. 비활성 항목은 입력 좌표 그대로 돌아온다.
 */
export function separateDots(coords: Coord[], active?: readonly boolean[]): Coord[] {
  const n = coords.length
  const on = (i: number): boolean => active?.[i] ?? true
  const out = coords.map(c => ({ x: c.x, y: c.y }))
  // ★ 야코비(동시 갱신)다. 가우스-자이델(제자리 갱신)로 짰더니 **인덱스 순서**가 결과를
  //   갈라, 도트가 서로를 스쳐 지나갈 때 한 프레임에 2유닛(≈2m) 튀었다(실측). 같은 입력에서
  //   모든 쌍의 밀어냄을 모아 한 번에 적용하면 결과가 입력의 연속 함수가 되어 튐이 없다.
  const px = new Array<number>(n)
  const py = new Array<number>(n)
  for (let it = 0; it < SEP_ITER; it++) {
    px.fill(0)
    py.fill(0)
    for (let i = 0; i < n; i++) {
      if (!on(i)) continue
      for (let j = i + 1; j < n; j++) {
        if (!on(j)) continue
        const dx = (out[j].x - out[i].x) * VB_X
        const dy = (out[j].y - out[i].y) * VB_Y
        const d = Math.hypot(dx, dy)
        if (d >= MIN_DOT_SEP) continue
        let ux: number
        let uy: number
        if (d < 1e-6) {
          // 완전히 같은 점 — 인덱스에서 방향을 뽑는다(Math.random 금지).
          const a = ((i * 7 + j * 13) % 360) * (Math.PI / 180)
          ux = Math.cos(a)
          uy = Math.sin(a)
        } else {
          ux = dx / d
          uy = dy / d
        }
        // 쌍 대칭 — 두 도트를 같은 양만큼 반대로 민다(집단 평균 보존).
        const push = (MIN_DOT_SEP - d) / 2
        px[i] -= (ux * push) / VB_X
        py[i] -= (uy * push) / VB_Y
        px[j] += (ux * push) / VB_X
        py[j] += (uy * push) / VB_Y
      }
    }
    for (let i = 0; i < n; i++) {
      out[i].x += px[i]
      out[i].y += py[i]
    }
  }
  // 상한 적용 + 피치 안으로. 상한을 매 반복이 아니라 마지막에 한 번 거는 이유:
  // 중간 단계를 자르면 반복이 수렴하지 않고 진동한다.
  for (let i = 0; i < n; i++) {
    if (!on(i)) { out[i].x = coords[i].x; out[i].y = coords[i].y; continue }
    const dx = (out[i].x - coords[i].x) * VB_X
    const dy = (out[i].y - coords[i].y) * VB_Y
    const d = Math.hypot(dx, dy)
    if (d > MAX_SEP_PUSH) {
      const k = MAX_SEP_PUSH / d
      out[i].x = coords[i].x + ((out[i].x - coords[i].x) * k)
      out[i].y = coords[i].y + ((out[i].y - coords[i].y) * k)
    }
    out[i].x = clampX(out[i].x)
    out[i].y = clampY(out[i].y)
  }
  return out
}

/** 두 도트의 겹침 면적 비율(0~1) — 원-원 교차 넓이 / 원 하나의 넓이. */
export function dotOverlapRatio(a: Coord, b: Coord, r = DOT_R_VB): number {
  const d = Math.hypot((a.x - b.x) * VB_X, (a.y - b.y) * VB_Y)
  if (d >= 2 * r) return 0
  if (d <= 0) return 1
  const t = d / (2 * r)
  const area = 2 * r * r * Math.acos(t) - (d / 2) * Math.sqrt(4 * r * r - d * d)
  return area / (Math.PI * r * r)
}

/** 블록 길이·폭(m). GK를 뺀 10명의 x·y 스팬 — "우리가 얼마나 컴팩트한가"의 실측 지표.
 *  `active`를 주면 false인 슬롯(퇴장)은 빼고 잰다. GK가 퇴장해도 슬롯 0은 언제나 GK이므로
 *  **마스크로 걸러야 한다** — 배열에서 미리 빼면 slice(1)이 필드 플레이어를 잘라 낸다. */
export function blockMetrics(coords: Coord[], active?: readonly boolean[]): { lengthM: number; widthM: number } {
  const f = coords.slice(1).filter((_, i) => active?.[i + 1] ?? true)
  if (f.length === 0) return { lengthM: 0, widthM: 0 }
  const xs = f.map(c => c.x)
  const ys = f.map(c => c.y)
  return {
    lengthM: ((Math.max(...xs) - Math.min(...xs)) / 100) * 105,
    widthM: ((Math.max(...ys) - Math.min(...ys)) / 100) * 68,
  }
}
