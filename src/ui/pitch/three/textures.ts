// src/ui/pitch/three/textures.ts
// 3D 매치 뷰의 절차 텍스처 생성기 — 외부 에셋 0. 전부 canvas 2D로 그린다.
//
// 원칙(Phase 4E Global Constraints):
//  - Math.random / Date 금지. 모든 변주는 인덱스·좌표 시드 해시(FNV-1a)로만.
//  - canvas 미지원 환경(node: document 없음 / jsdom: getContext('2d') null·throw)에서
//    **절대 throw하지 않고 null을 반환**한다. 호출부(scene.ts)가 단색 머티리얼로 폴백한다.
//  - three를 import하지 않는다(순수 canvas 계층 — node 테스트 가능, 코드 스플릿 무해).
//
// 좌표: 피치 텍스처는 월드 XZ를 그대로 픽셀에 매핑한다.
//   px = (x + PITCH_W/2) / PITCH_W * W    (월드 +X → 캔버스 오른쪽)
//   py = (z + PITCH_H/2) / PITCH_H * H    (월드 +Z → 캔버스 아래)
// PlaneGeometry(105,68).rotateX(-PI/2) + CanvasTexture(flipY=true) 조합에서
// 캔버스 위쪽 행이 v=1 = 월드 z=-34에 대응하므로 위 매핑이 그대로 맞다.
import { PITCH_W, PITCH_H } from './types'
import {
  CENTER_CIRCLE_R, PENALTY_BOX_D, PENALTY_BOX_W, GOAL_AREA_D, GOAL_AREA_W,
} from '../geometry'

// ── 축구 규격(m) — 라인 마킹·골대 치수 ───────────────────────────
// 피치·박스 치수의 정본은 ../../pitch/geometry로 옮겼다(2D 렌더러와 공용).
// 여기서는 기존 import 경로(`from './textures'`)를 지키려 재수출한다.
export {
  CENTER_CIRCLE_R, PENALTY_BOX_D, PENALTY_BOX_W, GOAL_AREA_D, GOAL_AREA_W,
} from '../geometry'
/** 라인 폭(경기 규칙: 최대 12cm). */
export const LINE_W = 0.12
/** 페널티 스팟: 골라인에서 11m. */
export const PENALTY_SPOT_D = 11
/** 코너 아크 반지름. */
export const CORNER_R = 1
/** 스팟(센터·페널티) 표시 반지름. */
export const SPOT_R = 0.11
/** 골대: 폭 7.32m × 높이 2.44m, 포스트 반지름 6cm. */
export const GOAL_W = 7.32
export const GOAL_H = 2.44
export const POST_R = 0.06

// ── 색 팔레트(야간 조명 톤) ──────────────────────────────────────
export const GRASS_DARK = '#1f6b31'
export const GRASS_LIGHT = '#2b8c40'
export const LINE_COLOR = 'rgba(248,252,248,0.94)'

// ── 결정론 해시 (FNV-1a) ────────────────────────────────────────
/** 문자열 → 32bit 부호없는 해시. game/pressconf.ts와 동일한 FNV-1a. */
export function fnv1a(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 정수 시드 → 0~1 결정론 난수. Math.random 대체(믹싱은 xorshift 계열). */
export function hash01(seed: number): number {
  let h = (seed | 0) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  h = Math.imul(h, 2246822507) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  h = Math.imul(h, 3266489909) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967296
}

/** 2D 인덱스용 결정론 난수(관중 열·행, 노이즈 픽셀 등). */
export function hash2(a: number, b: number, salt = 0): number {
  return hash01(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(salt | 0, 83492791))
}

// ── canvas 확보(미지원 환경 안전) ───────────────────────────────
export interface Canvas2D {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

/**
 * w×h 캔버스와 2D 컨텍스트를 만든다. 미지원 환경이면 **null**(throw 금지).
 * - node: `document` 자체가 없음
 * - jsdom(canvas 패키지 미설치): getContext('2d')가 null 반환 또는 throw
 */
export function makeCanvas(w: number, h: number): Canvas2D | null {
  if (typeof document === 'undefined' || !document.createElement) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w))
    canvas.height = Math.max(1, Math.round(h))
    const ctx = canvas.getContext('2d')
    if (!ctx || typeof ctx.fillRect !== 'function') return null
    return { canvas, ctx }
  } catch {
    return null
  }
}

// ── 픽셀 매핑 헬퍼(순수 — 테스트 대상) ──────────────────────────
/** 월드 XZ → 피치 캔버스 픽셀. */
export function worldToPx(x: number, z: number, w: number, h: number): { px: number; py: number } {
  return { px: ((x + PITCH_W / 2) / PITCH_W) * w, py: ((z + PITCH_H / 2) / PITCH_H) * h }
}

/**
 * 페널티 아크(D)가 페널티 박스 밖으로 드러나는 반각(rad).
 * cos θ = (박스깊이 - 스팟거리) / 아크반지름.
 */
export function penaltyArcHalfAngle(): number {
  return Math.acos((PENALTY_BOX_D - PENALTY_SPOT_D) / CENTER_CIRCLE_R)
}

// ── 미세 노이즈 타일 ────────────────────────────────────────────
/**
 * 결정론 그레인 노이즈 타일(알파 채널 변조, 색은 흑백). 잔디·콘크리트 위에 곱해 쓴다.
 * @param size 정사각 타일 픽셀
 * @param seed 시드
 * @param alpha 최대 알파(0~1)
 */
export function makeNoiseCanvas(size = 128, seed = 7, alpha = 0.16): HTMLCanvasElement | null {
  const c = makeCanvas(size, size)
  if (!c) return null
  const { ctx, canvas } = c
  const img = ctx.createImageData(size, size)
  const d = img.data
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const n = hash2(x, y, seed)
      const v = n < 0.5 ? 0 : 255
      d[i] = d[i + 1] = d[i + 2] = v
      d[i + 3] = Math.round(Math.abs(n - 0.5) * 2 * alpha * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas
}

// ── 피치 텍스처 ─────────────────────────────────────────────────
/** 잔디 mowing 줄무늬 개수(길이 방향 밴드). */
const MOW_BANDS = 14
/** 체커 보조 밴드 개수(폭 방향). */
const MOW_CROSS = 8

/**
 * 피치 전면 텍스처: mowing 줄무늬(체커) + 그레인 + 마모 자국 + 흰 라인 마킹 전부.
 * @param pxPerMeter 해상도(기본 20 → 2100×1360)
 * @returns 캔버스 또는 null(미지원 환경)
 */
export function makePitchCanvas(pxPerMeter = 20): HTMLCanvasElement | null {
  const W = Math.round(PITCH_W * pxPerMeter)
  const H = Math.round(PITCH_H * pxPerMeter)
  const c = makeCanvas(W, H)
  if (!c) return null
  const { ctx, canvas } = c

  const mx = (x: number) => ((x + PITCH_W / 2) / PITCH_W) * W
  const mz = (z: number) => ((z + PITCH_H / 2) / PITCH_H) * H
  const ml = (m: number) => (m / PITCH_W) * W

  // 1) 베이스 잔디
  ctx.fillStyle = GRASS_DARK
  ctx.fillRect(0, 0, W, H)

  // 2) mowing 줄무늬(길이 방향 밴드) + 체커(폭 방향 약한 교차)
  const bw = W / MOW_BANDS
  const bh = H / MOW_CROSS
  for (let i = 0; i < MOW_BANDS; i++) {
    if (i % 2 === 0) {
      ctx.fillStyle = GRASS_LIGHT
      ctx.fillRect(i * bw, 0, bw + 1, H)
    }
    for (let j = 0; j < MOW_CROSS; j++) {
      // 체커 패리티에 따라 아주 약하게 밝기 반전 → 잔디 결의 입체감.
      const up = (i + j) % 2 === 0
      ctx.fillStyle = up ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.045)'
      ctx.fillRect(i * bw, j * bh, bw + 1, bh + 1)
    }
  }

  // 3-a) 미세 그레인 타일(결정론 노이즈) 오버레이 — 잔디 결의 고주파 디테일
  const noise = makeNoiseCanvas(128, 7, 0.14)
  if (noise) {
    const pat = ctx.createPattern(noise, 'repeat')
    if (pat) {
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.fillStyle = pat
      ctx.fillRect(0, 0, W, H)
      ctx.restore()
    }
  }

  // 3-b) 저주파 얼룩(잔디 색 편차)
  const flecks = 4500
  for (let i = 0; i < flecks; i++) {
    const px = hash01(i * 2 + 1) * W
    const py = hash01(i * 2 + 77771) * H
    const s = 1 + hash01(i + 991) * pxPerMeter * 0.12
    const t = hash01(i + 40503)
    ctx.fillStyle = t > 0.5 ? 'rgba(210,255,205,0.05)' : 'rgba(0,40,10,0.06)'
    ctx.fillRect(px, py, s, s)
  }

  // 4) 마모 자국(골문 앞·센터서클) — 살짝 밝고 누런 타원
  ctx.save()
  ctx.globalAlpha = 0.1
  ctx.fillStyle = '#8f9a5a'
  for (const wx of [-PITCH_W / 2 + 8, PITCH_W / 2 - 8]) {
    ctx.beginPath()
    ctx.ellipse(mx(wx), mz(0), ml(9), ml(7), 0, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.beginPath()
  ctx.ellipse(mx(0), mz(0), ml(4), ml(3.2), 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // 5) 라인 마킹
  const lw = Math.max(1.5, ml(LINE_W))
  ctx.strokeStyle = LINE_COLOR
  ctx.fillStyle = LINE_COLOR
  ctx.lineWidth = lw
  ctx.lineCap = 'butt'

  const half = LINE_W / 2
  // 터치라인·골라인(라인이 필드 안쪽에 들어오도록 반폭 인셋).
  // ml()은 축 무관 등방 스케일(W/PITCH_W === H/PITCH_H === pxPerMeter)이라 세로에도 그대로 쓴다.
  ctx.strokeRect(
    mx(-PITCH_W / 2 + half),
    mz(-PITCH_H / 2 + half),
    ml(PITCH_W - LINE_W),
    ml(PITCH_H - LINE_W),
  )
  // 하프웨이 라인
  ctx.beginPath()
  ctx.moveTo(mx(0), mz(-PITCH_H / 2))
  ctx.lineTo(mx(0), mz(PITCH_H / 2))
  ctx.stroke()
  // 센터서클 + 센터스팟
  ctx.beginPath()
  ctx.arc(mx(0), mz(0), ml(CENTER_CIRCLE_R), 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(mx(0), mz(0), ml(SPOT_R), 0, Math.PI * 2)
  ctx.fill()

  const arcHalf = penaltyArcHalfAngle()
  for (const sign of [-1, 1] as const) {
    const goalX = (sign * PITCH_W) / 2
    // 페널티 에어리어
    const pbx = goalX - sign * PENALTY_BOX_D
    ctx.beginPath()
    ctx.moveTo(mx(goalX), mz(-PENALTY_BOX_W / 2))
    ctx.lineTo(mx(pbx), mz(-PENALTY_BOX_W / 2))
    ctx.lineTo(mx(pbx), mz(PENALTY_BOX_W / 2))
    ctx.lineTo(mx(goalX), mz(PENALTY_BOX_W / 2))
    ctx.stroke()
    // 골 에어리어
    const gax = goalX - sign * GOAL_AREA_D
    ctx.beginPath()
    ctx.moveTo(mx(goalX), mz(-GOAL_AREA_W / 2))
    ctx.lineTo(mx(gax), mz(-GOAL_AREA_W / 2))
    ctx.lineTo(mx(gax), mz(GOAL_AREA_W / 2))
    ctx.lineTo(mx(goalX), mz(GOAL_AREA_W / 2))
    ctx.stroke()
    // 페널티 스팟
    const spotX = goalX - sign * PENALTY_SPOT_D
    ctx.beginPath()
    ctx.arc(mx(spotX), mz(0), ml(SPOT_R), 0, Math.PI * 2)
    ctx.fill()
    // 페널티 아크(박스 밖 구간만)
    ctx.beginPath()
    if (sign < 0) ctx.arc(mx(spotX), mz(0), ml(CENTER_CIRCLE_R), -arcHalf, arcHalf)
    else ctx.arc(mx(spotX), mz(0), ml(CENTER_CIRCLE_R), Math.PI - arcHalf, Math.PI + arcHalf)
    ctx.stroke()
  }

  // 코너 아크 4개(필드 안쪽 1/4원)
  const cr = ml(CORNER_R)
  const corners: [number, number, number, number][] = [
    [-PITCH_W / 2, -PITCH_H / 2, 0, Math.PI / 2],
    [-PITCH_W / 2, PITCH_H / 2, -Math.PI / 2, 0],
    [PITCH_W / 2, -PITCH_H / 2, Math.PI / 2, Math.PI],
    [PITCH_W / 2, PITCH_H / 2, Math.PI, Math.PI * 1.5],
  ]
  for (const [cx, cz, a0, a1] of corners) {
    ctx.beginPath()
    ctx.arc(mx(cx), mz(cz), cr, a0, a1)
    ctx.stroke()
  }

  return canvas
}

// ── 골 네트(반투명 격자, 알파 텍스처) ───────────────────────────
/**
 * 골 네트용 격자 텍스처(배경 투명 + 흰 실선). RepeatWrapping으로 타일링해 쓴다.
 * @param size 타일 픽셀 @param cells 한 타일의 격자 칸 수
 * @param weight 선 굵기 = 칸 크기 / weight. 작을수록 굵다. 기본 12는 칸 대비 8%라
 *   근경에서도 네트가 거의 보이지 않는다 — props.ts는 6을 쓴다.
 */
export function makeNetCanvas(size = 128, cells = 10, weight = 12): HTMLCanvasElement | null {
  const c = makeCanvas(size, size)
  if (!c) return null
  const { ctx, canvas } = c
  ctx.clearRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = Math.max(1, size / cells / Math.max(1, weight))
  const step = size / cells
  ctx.beginPath()
  for (let i = 0; i <= cells; i++) {
    const p = i * step
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
  }
  ctx.stroke()
  return canvas
}

// ── 킷(유니폼) 절차 텍스처 ──────────────────────────────────────
//
// 선수 몸통·소매·양말은 전부 CapsuleGeometry다. three의 캡슐 UV는
//   u = 방위각(0 = 로컬 -X, 0.5 = 로컬 +X = 선수 정면),
//   v = 아래(0)에서 위(1)로의 **호길이 비율**(반구 캡 포함)
// 이라서, 캔버스 세로축만 쓰면 칼라·소매 트림·양말 밴드·횡스트라이프를 전부 그릴 수 있다.
// (CanvasTexture는 flipY=true라 캔버스 맨 윗줄이 v=1 = 캡슐 위쪽이다.)
//
// **왜 세로 밴드만 쓰는가:** 가로(u) 위치에 의존하는 패턴(새시 등)은 u=0의 UV 이음매에서
// 끊긴다. 그리고 화면상 40~52px에서는 팀 색 **면적**이 인식 속도를 지배한다는 것이
// docs/refs 판정 결론이다. 세로 밴드만으로 칼라·트림·후프를 다 만들 수 있으므로
// 이음매 문제를 안고 갈 이유가 없다.

/** 팀 패턴. 무지 또는 횡스트라이프(후프). */
export type KitPattern = 'plain' | 'hoops'

/** v 구간을 채우는 색 밴드(칼라·소매 밑단·양말 밴드 공용). */
export interface KitBand {
  /** v 하한(0 = 캡슐 아래끝) */
  from: number
  /** v 상한(1 = 캡슐 위끝) */
  to: number
  color: string
}

export interface KitCanvasSpec {
  /** 주 팀 색. 면적의 60% 이상을 차지해야 한다(docs/refs 판정). */
  base: string
  /** 어두운 보조색 — 칼라·트림·후프. */
  deep: string
  /** 기본 'plain'. */
  pattern?: KitPattern
  /**
   * 패턴을 그릴 v 구간. 캡슐 캡(어깨·밑단)까지 후프를 흘리면 축소 시 몸통 위아래가
   * 어두운 덩어리로 뭉치므로 보통 {@link capsuleVSpan}의 원통 구간만 준다.
   */
  patternSpan?: { from: number; to: number }
  /** 후프 개수(어두운 띠 수). 기본 3. */
  hoops?: number
  /** 추가 밴드(칼라·트림). 순서대로 덧그린다. */
  bands?: readonly KitBand[]
  /** 위는 밝고 아래는 어두운 미세 명암. 램버트만으로는 축소 시 몸통이 납작해 보인다. */
  shading?: boolean
}

/**
 * `CapsuleGeometry(radius, cylLength)`에서 **원통 구간**이 차지하는 v 범위.
 * 캡슐 UV의 v는 호길이 비율이므로 반구 캡 하나가 차지하는 몫은 (πr/2) / (πr + cylLength)다.
 * (three 0.185 실측으로 확인: r=0.155·len=0.30 → 0.3094 ~ 0.6906)
 */
export function capsuleVSpan(radius: number, cylLength: number): { from: number; to: number } {
  const cap = (Math.max(0, radius) * Math.PI) / 2
  const total = 2 * cap + Math.max(0, cylLength)
  if (total <= 0) return { from: 0, to: 1 }
  const f = cap / total
  return { from: f, to: 1 - f }
}

/**
 * 킷 텍스처(캡슐 UV용 세로 밴드 아틀라스). canvas 미지원 환경에서는 null.
 * @param w 가로 픽셀 — u 방향으로는 균일하므로 작아도 된다(기본 32)
 * @param h 세로 픽셀 — 밴드 경계 선명도를 정한다(기본 256)
 */
export function makeKitCanvas(spec: KitCanvasSpec, w = 32, h = 256): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  /** v(0=아래, 1=위) → 캔버스 y. flipY=true라 v=1이 맨 윗줄이다. */
  const vy = (v: number): number => (1 - v) * h
  /** v 구간을 색으로 채운다(위아래 순서 무관). */
  const fillSpan = (from: number, to: number, color: string): void => {
    const y0 = vy(Math.max(from, to))
    const y1 = vy(Math.min(from, to))
    if (y1 - y0 <= 0) return
    ctx.fillStyle = color
    ctx.fillRect(0, y0, w, y1 - y0)
  }

  ctx.fillStyle = spec.base
  ctx.fillRect(0, 0, w, h)

  if (spec.pattern === 'hoops') {
    const span = spec.patternSpan ?? { from: 0, to: 1 }
    const n = Math.max(1, Math.round(spec.hoops ?? 3))
    // 어두운 띠 n개 + 밝은 틈 n+1개로 나눠 **주 팀 색이 항상 과반**이 되게 한다
    // (docs/refs 권고: 어두운 패턴 면적 35~40% 이하).
    const unit = (span.to - span.from) / (2 * n + 1)
    for (let i = 0; i < n; i++) {
      const from = span.from + unit * (2 * i + 1)
      fillSpan(from, from + unit, spec.deep)
    }
  }

  for (const b of spec.bands ?? []) fillSpan(b.from, b.to, b.color ?? spec.deep)

  if (spec.shading !== false) {
    // 위 10% 밝게 / 아래 12% 어둡게. 캡슐 램버트 음영은 카메라 각도에 따라 사라지는데,
    // 이 고정 그라디언트는 축소본에서도 상하 구분을 남긴다.
    const g = ctx.createLinearGradient(0, 0, 0, h)
    g.addColorStop(0, 'rgba(255,255,255,0.10)')
    g.addColorStop(0.45, 'rgba(255,255,255,0)')
    g.addColorStop(0.62, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.12)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }

  return canvas
}

// ── 관중석 콘크리트 ─────────────────────────────────────────────
/** 관중석 슬래브용 어두운 콘크리트 텍스처(단 결·얼룩). */
export function makeConcreteCanvas(size = 256): HTMLCanvasElement | null {
  const c = makeCanvas(size, size)
  if (!c) return null
  const { ctx, canvas } = c
  ctx.fillStyle = '#20242c'
  ctx.fillRect(0, 0, size, size)
  // 계단 결(가로 줄) + 얼룩
  for (let i = 0; i < size; i += 8) {
    ctx.fillStyle = (i / 8) % 2 === 0 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.14)'
    ctx.fillRect(0, i, size, 4)
  }
  for (let i = 0; i < 900; i++) {
    const x = hash01(i * 3 + 5) * size
    const y = hash01(i * 3 + 1337) * size
    const s = 1 + hash01(i + 77) * 3
    ctx.fillStyle = hash01(i + 313) > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)'
    ctx.fillRect(x, y, s, s)
  }
  return canvas
}

// ── 원경 관중 패턴 ──────────────────────────────────────────────
//
// docs/refs/stadium/crowd-distant-color-pattern.png의 조건을 코드로 옮긴 것이다:
//   "얼굴 없는 작은 블록, 약 70%의 어두운 질량, 드문 빨강·파랑·흰색·황색 점".
//
// **왜 인스턴싱만으로는 부족한가:** 인스턴스 사람은 좌석 피치(0.62m)·열 간격(0.9m)
// 격자에 놓이므로 사람과 사람 사이에 슬래브가 그대로 드러난다. 레퍼런스에는 그 틈이
// 없다 — 뒷사람 머리가 앞사람 어깨를 메워 빈틈 없는 인간 질량이 된다. 그 틈을 메우는
// 것이 이 텍스처다(슬래브에 깔고 그 위에 인스턴스를 세운다 = 2단 구성).
// 텍스처는 밀도를, 인스턴스는 실루엣과 파도타기 모션을 담당한다.

/** 관중 색 편향. 홈/어웨이 서포터 구역과 중립 구역을 나눈다. */
export type CrowdBias = 'home' | 'away' | 'mix'

/**
 * 레퍼런스에서 뽑은 어두운 질량 팔레트(약 68% 지분). 야간 관중석의 코트·그림자·머리다.
 * 이 색들이 화면을 지배해야 원색 점이 "흩뿌려진" 것으로 읽힌다 — 예전 구현은
 * 중립색에 밝은 회색(#d8dde6)을 넣고 지분을 44%나 줘서 관중석 전체가 밝게 떴다.
 */
export const CROWD_DARK: readonly string[] = [
  '#1d2740', '#242f4b', '#2b3757', '#334063', '#3b486e', '#45527a', '#232b3e',
]
/**
 * 팀색이 아닌 원색 액센트(약 32% 중 일부). 레퍼런스의 황색·흰색·살색 점.
 * 빨강·파랑은 팀 컬러가 대신하므로 여기 넣지 않는다.
 */
export const CROWD_ACCENT: readonly string[] = [
  '#dd9a1e', '#e8ebf2', '#b98a68', '#c9ced9', '#e0b45a',
]

/** rgb 문자열을 0~1 배율로 어둡게 만든다(캔버스용 — three Color를 쓰지 않는다). */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.round(((n >> 16) & 255) * k)
  const g = Math.round(((n >> 8) & 255) * k)
  const b = Math.round((n & 255) * k)
  return `rgb(${r},${g},${b})`
}

export interface CrowdCanvasSpec {
  /** 정사각 타일 픽셀. 기본 256. */
  size?: number
  /** 홈 팀 색(`#rrggbb`). */
  home?: string
  /** 어웨이 팀 색(`#rrggbb`). */
  away?: string
  /** 구역 편향. */
  bias?: CrowdBias
  /** 타일 한 변에 들어갈 인물 수. 기본 30 → 인물 하나가 타일의 1/30. */
  perSide?: number
  /** 시드. */
  seed?: number
}

/**
 * 원경 관중 타일 텍스처(RepeatWrapping 전제, **상하좌우 심리스**).
 *
 * 인물 하나는 "어깨 사각 + 머리 사각" 두 조각뿐이다 — 레퍼런스의 40px 이하 인물이
 * 정확히 그 정도 정보량이고, 그보다 더 그리면 타일링 반복이 눈에 띈다.
 * 배경은 순검정이 아니라 가장 어두운 네이비다(레퍼런스 바탕색).
 */
export function makeCrowdCanvas(spec: CrowdCanvasSpec = {}): HTMLCanvasElement | null {
  const size = Math.max(32, Math.round(spec.size ?? 256))
  const c = makeCanvas(size, size)
  if (!c) return null
  const { ctx, canvas } = c
  const home = spec.home ?? '#d7263d'
  const away = spec.away ?? '#2453b8'
  const bias = spec.bias ?? 'mix'
  const perSide = Math.max(6, Math.round(spec.perSide ?? 30))
  const seed = spec.seed ?? 0

  // 바탕 = 레퍼런스의 지배색인 짙은 네이비. 인물 사이 빈틈이 검정이 되면 관중석이
  // 구멍 뚫린 것처럼 보인다.
  ctx.fillStyle = '#0f1524'
  ctx.fillRect(0, 0, size, size)

  const cell = size / perSide
  // 홈/어웨이 지분. 서포터 구역은 한쪽 색이 확실히 우세해야 "구역"으로 읽힌다.
  const homeShare = bias === 'home' ? 0.62 : bias === 'away' ? 0.08 : 0.24
  const awayShare = bias === 'away' ? 0.62 : bias === 'home' ? 0.08 : 0.24

  /** 심리스를 위해 타일 경계를 넘는 인물은 반대편에도 한 번 더 그린다. */
  const drawAt = (x: number, y: number, w: number, hh: number, body: string, head: string): void => {
    for (const dx of [0, -size, size]) {
      for (const dy of [0, -size, size]) {
        const px = x + dx
        const py = y + dy
        if (px > size || px + w < 0 || py > size || py + hh < 0) continue
        // 어깨(사다리꼴 대신 사각 — 이 크기에서 구분되지 않는다)
        ctx.fillStyle = body
        ctx.fillRect(px, py + hh * 0.36, w, hh * 0.64)
        // 머리
        ctx.fillStyle = head
        ctx.fillRect(px + w * 0.28, py, w * 0.44, hh * 0.38)
      }
    }
  }

  // 뒷줄부터 그려 앞줄이 위에 겹치게 한다(레퍼런스의 머리-어깨 겹침).
  // 행 간격을 셀보다 좁게(0.78) 잡아 세로로도 빈틈이 없다.
  const rowStep = cell * 0.78
  const rows = Math.ceil(size / rowStep)
  for (let r = 0; r < rows; r++) {
    for (let cIdx = 0; cIdx < perSide; cIdx++) {
      const i = r * perSide + cIdx
      const h1 = hash2(cIdx, r, seed + 1)
      const h2 = hash2(cIdx, r, seed + 2)
      const h3 = hash2(cIdx, r, seed + 3)
      const h4 = hash2(cIdx, r, seed + 4)
      // 빈 좌석(레퍼런스에도 드문드문 검은 구멍이 있다) — 6%.
      if (h4 < 0.06) continue
      // 홀수 행 반 칸 어긋남 + 지터로 격자 티를 지운다.
      const jx = (h1 - 0.5) * cell * 0.5
      const x = cIdx * cell + (r % 2 ? cell / 2 : 0) + jx
      const y = r * rowStep + (h2 - 0.5) * rowStep * 0.3
      const w = cell * (0.5 + h3 * 0.16)
      const hh = rowStep * (1.25 + h1 * 0.3)

      let body: string
      if (h2 < homeShare) body = home
      else if (h2 < homeShare + awayShare) body = away
      else if (h2 < homeShare + awayShare + 0.1) body = CROWD_ACCENT[i % CROWD_ACCENT.length]
      else body = CROWD_DARK[Math.floor(h3 * CROWD_DARK.length) % CROWD_DARK.length]

      // 명도 지터. 팀 색도 60%까지 떨어뜨려야 "전부 새 유니폼"처럼 보이지 않는다.
      const k = 0.6 + h3 * 0.45
      // 머리는 몸통보다 어둡다(머리카락) — 가끔 살색.
      const head = h1 > 0.82 ? shade('#b98a68', k) : shade('#1c2231', 0.7 + h4 * 0.6)
      drawAt(x, y, w, hh, shade(body, k), head)
    }
  }
  return canvas
}

// ── 밤하늘 ──────────────────────────────────────────────────────
/**
 * 스카이돔용 그라디언트 + 별. v=1(캔버스 위)이 천정, v=0이 지평선이다.
 *
 * **왜 단색 배경으로는 안 되는가:** 예전에는 `scene.background`가 단색 `#080e18`뿐이라
 * 경기장 밖이 완전한 검정 벽이었다. 밤하늘은 위로 갈수록 어둡고 지평선 쪽은 도시
 * 광공해로 살짝 데워진다 — 그 수직 그라디언트 하나만 있어도 "경기장이 허공에 떠 있다"가
 * "밤에 도시 안에 있다"로 바뀐다.
 */
export function makeSkyCanvas(w = 512, h = 512): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, '#03050b') // 천정 — 거의 검정
  g.addColorStop(0.42, '#070d1c')
  g.addColorStop(0.72, '#0e1830')
  g.addColorStop(0.9, '#1a2440') // 지평선 직전 — 도시 광공해로 데워진 남색
  g.addColorStop(1, '#242c42')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  // 별 — 위쪽 65%에만. 지평선 근처는 광공해로 별이 보이지 않는다.
  for (let i = 0; i < 420; i++) {
    const x = hash01(i * 3 + 17) * w
    const y = hash01(i * 3 + 9173) * h * 0.65
    const a = 0.12 + hash01(i + 551) * 0.45
    // 위로 갈수록 밝게(지평선 쪽 페이드)
    const fade = 1 - y / (h * 0.65)
    ctx.fillStyle = `rgba(220,232,255,${(a * fade).toFixed(3)})`
    ctx.fillRect(x, y, 1, 1)
  }
  return canvas
}

// ── 발광 헤일로(조명탑) ─────────────────────────────────────────
/**
 * 가산합성 스프라이트용 방사형 감쇠. 중심 흰색 → 가장자리 검정(가산합성에서 검정은 무기여).
 * 조명탑 리그 자체는 작은 사각형이라 블룸만으로는 "빛나는 등"이 되지 않는다 —
 * 대기 산란(halo)이 있어야 야간 경기장으로 읽힌다.
 */
export function makeGlowCanvas(size = 256, core = 0.06): HTMLCanvasElement | null {
  const c = makeCanvas(size, size)
  if (!c) return null
  const { ctx, canvas } = c
  const r = size / 2
  const g = ctx.createRadialGradient(r, r, 0, r, r, r)
  g.addColorStop(0, 'rgba(255,250,235,1)')
  g.addColorStop(Math.min(0.5, Math.max(0.01, core)), 'rgba(255,244,214,0.62)')
  g.addColorStop(0.34, 'rgba(214,226,255,0.16)')
  g.addColorStop(0.68, 'rgba(150,180,255,0.035)')
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return canvas
}

/**
 * 조명 콘(빛기둥)용 세로 감쇠. 캔버스 위(v=1)가 광원, 아래(v=0)가 지면이다.
 * 가산합성으로 쓰므로 알파가 아니라 **밝기**로 감쇠시킨다(검정 = 무기여).
 */
export function makeLightConeCanvas(w = 8, h = 128): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, 'rgb(60,64,74)') // 광원 쪽
  g.addColorStop(0.35, 'rgb(24,27,34)')
  g.addColorStop(1, 'rgb(0,0,0)') // 지면 쪽 — 완전 소멸
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  return canvas
}

// ── 원경 도시 실루엣 ────────────────────────────────────────────
/**
 * 지평선 실루엣 링용 텍스처(**가로 심리스**, 배경 투명).
 * 어두운 건물 덩어리 + 드문 창문 불빛. 경기장 바깥이 검정 벽이 아니라 "도시"가 된다.
 * @param w 가로 픽셀(원주 방향) @param h 세로 픽셀 — 아래쪽이 지면이다
 */
export function makeSkylineCanvas(w = 2048, h = 256): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  ctx.clearRect(0, 0, w, h)

  // 뒷줄(멀고 낮고 흐림) → 앞줄(가깝고 높고 진함) 2겹으로 깊이를 만든다.
  const layers = [
    { count: 46, minH: 0.18, maxH: 0.46, color: '#0a1020', win: 0.1 },
    { count: 34, minH: 0.3, maxH: 0.78, color: '#060a15', win: 0.16 },
  ]
  let s = 0
  for (const L of layers) {
    const step = w / L.count
    for (let i = 0; i < L.count; i++) {
      const h1 = hash01(s * 7 + i * 3 + 101)
      const h2 = hash01(s * 7 + i * 3 + 8803)
      const bw = step * (0.55 + h2 * 0.7)
      const bh = h * (L.minH + h1 * (L.maxH - L.minH))
      const x = i * step + (h2 - 0.5) * step * 0.4
      ctx.fillStyle = L.color
      ctx.fillRect(x, h - bh, bw, bh)
      // 심리스: 오른쪽 끝을 넘는 건물은 왼쪽에도 그린다.
      if (x + bw > w) ctx.fillRect(x - w, h - bh, bw, bh)
      // 창문 불빛(따뜻한 소듐등) — 아주 드물게.
      const cols = Math.max(1, Math.floor(bw / 7))
      const rows = Math.max(1, Math.floor(bh / 9))
      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          if (hash2(cx, cy, i * 31 + s * 977) > L.win) continue
          const wx = x + 3 + cx * 7
          const wy = h - bh + 4 + cy * 9
          ctx.fillStyle = hash2(cx, cy, i + 5) > 0.7 ? 'rgba(255,214,140,0.85)' : 'rgba(190,206,240,0.55)'
          ctx.fillRect(wx, wy, 2, 3)
          if (wx > w) ctx.fillRect(wx - w, wy, 2, 3)
        }
      }
    }
    s++
  }
  return canvas
}

// ── 스타디움 외벽(파사드) ───────────────────────────────────────
/**
 * 경기장 외벽 패널 텍스처(세로 핀 + 안쪽에서 새어나오는 콘코스 불빛).
 * 관중석 뒷벽만 있으면 볼(bowl)이 종잇장처럼 보인다 — 바깥에 두께와 창을 준다.
 */
export function makeFacadeCanvas(w = 512, h = 256): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  ctx.fillStyle = '#0b0f18'
  ctx.fillRect(0, 0, w, h)

  // 세로 핀(구조 리브) — 밝은 면/어두운 면 한 쌍이 원통형 볼륨감을 만든다.
  // 한 타일에 **8베이**만 둔다. 첫 렌더에서 16px 간격(32베이)으로 잡았더니 실치수로
  // 베이가 1m가 되어, 외벽이 건축이 아니라 좁쌀 LED 벽으로 보였다. 실제 경기장 파사드
  // 베이는 4m 안팎이다(scene 쪽 FACADE_TILE_W 32m ÷ 8베이 = 4m).
  const bays = 8
  const fin = w / bays
  for (let i = 0; i < bays; i++) {
    const x = i * fin
    ctx.fillStyle = 'rgba(255,255,255,0.055)'
    ctx.fillRect(x, 0, 6, h)
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(x + 6, 0, 9, h)
  }
  // 콘코스 층(가로 띠) — 안쪽 조명이 새어나오는 창. 층마다 굵은 그늘 + 창 한 칸.
  const winH = h * 0.09
  for (const band of [0.26, 0.56, 0.84]) {
    const y = h * band
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, y - h * 0.03, w, winH + h * 0.06)
    for (let i = 0; i < bays; i++) {
      const lit = hash01(Math.round(i * 613 + band * 9973))
      if (lit < 0.42) continue
      ctx.fillStyle = lit > 0.84 ? 'rgba(255,226,168,0.62)' : 'rgba(110,138,190,0.24)'
      ctx.fillRect(i * fin + 17, y, fin - 26, winH)
    }
  }
  return canvas
}

/**
 * 스탠드 지붕 상면 패널 텍스처. 야간 외부 샷에서 지붕은 조명이 거의 닿지 않아
 * 단색이면 **떠 있는 검은 덩어리**로 보인다(첫 렌더에서 실제로 그랬다).
 * 이음매 선과 미세 반사만으로 "금속 패널 지붕"이라는 정보를 준다.
 */
export function makeRoofCanvas(size = 256): HTMLCanvasElement | null {
  const c = makeCanvas(size, size)
  if (!c) return null
  const { ctx, canvas } = c
  ctx.fillStyle = '#1a2130'
  ctx.fillRect(0, 0, size, size)
  // 가로 패널 이음매(지붕 물매 방향) + 세로 트러스 그림자.
  for (let y = 0; y < size; y += size / 8) {
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(0, y, size, 2)
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.fillRect(0, y + 2, size, 3)
  }
  for (let x = 0; x < size; x += size / 4) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(x, 0, 4, size)
  }
  // 조명탑 방향(캔버스 왼쪽 위)에서 오는 약한 스침광.
  const g = ctx.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, 'rgba(150,178,224,0.16)')
  g.addColorStop(0.5, 'rgba(0,0,0,0)')
  g.addColorStop(1, 'rgba(0,0,0,0.2)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return canvas
}

// ── 코너 플래그 ─────────────────────────────────────────────────
/**
 * 코너 깃발 텍스처. docs/refs/stadium/corner-flag-main-side.png 조건:
 * "노랑/코럴 큰 색면" — 사선 코럴 밴드 하나만 있는 노랑 삼각기다.
 * 삼각형 지오메트리의 UV(폴 쪽 u=0)에 맞춰 좌→우로 그린다.
 */
export function makeFlagCanvas(w = 128, h = 96): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  ctx.fillStyle = '#f5c518' // 노랑
  ctx.fillRect(0, 0, w, h)
  // 코럴 사선 밴드(좌상 → 우하). 레퍼런스의 유일한 패턴이다.
  ctx.save()
  ctx.fillStyle = '#f0553c'
  ctx.beginPath()
  ctx.moveTo(0, h * 0.16)
  ctx.lineTo(w, h * 0.66)
  ctx.lineTo(w, h * 0.9)
  ctx.lineTo(0, h * 0.44)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
  // 폴 쪽 접힘 그늘 — 평면 한 장이 천처럼 보이게 하는 최소 단서.
  const g = ctx.createLinearGradient(0, 0, w, 0)
  g.addColorStop(0, 'rgba(0,0,0,0.3)')
  g.addColorStop(0.18, 'rgba(0,0,0,0)')
  g.addColorStop(0.7, 'rgba(255,255,255,0.06)')
  g.addColorStop(1, 'rgba(0,0,0,0.14)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  return canvas
}

// ── 입장 배너(피치에 펼치는 팀 색 천) ───────────────────────────
/**
 * 입장 연출에서 피치에 펼치는 **팀 배너** 텍스처.
 *
 * ★ 실제 국기를 그리지 않는다. 프로젝트 규칙이 공식 엠블럼·로고 사용을 금지하고
 *   (docs/proposal/proposal-draft.md 고지 절), 국기는 그중에서도 가장 다투기 쉬운
 *   자산이다. 대신 원정 응원석이 펼치는 **대형 천(tifo)** 의 문법을 쓴다 —
 *   팀 색 바탕 + 사선 색면 + 팀명. "그 팀의 자리"라는 의미는 그대로 전달되면서
 *   어떤 실존 국기·엠블럼과도 닮지 않는다.
 *
 * @param base  팀 색(0xRRGGBB)
 * @param ink   글자색(팀 색 대비로 호출부가 고른다 — {@link kitInk})
 * @param label 팀 한국어 이름
 */
export function makeBannerCanvas(
  base: number, ink: number, label: string, w = 512, h = 320,
): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  const css = (v: number) => `#${(v >>> 0).toString(16).padStart(6, '0')}`
  ctx.fillStyle = css(base)
  ctx.fillRect(0, 0, w, h)
  // 사선 색면 두 줄 — 천의 방향감을 만든다(단색이면 3D에서 색종이로 보인다).
  ctx.save()
  ctx.globalAlpha = 0.16
  ctx.fillStyle = css(ink)
  for (const off of [-0.35, 0.25]) {
    ctx.beginPath()
    ctx.moveTo(w * off, h)
    ctx.lineTo(w * (off + 0.34), h)
    ctx.lineTo(w * (off + 0.78), 0)
    ctx.lineTo(w * (off + 0.44), 0)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
  // 테두리 — 실제 배너는 가장자리를 박음질한다. 3D 원경에서 형태를 잡아 준다.
  ctx.strokeStyle = css(ink)
  ctx.globalAlpha = 0.55
  ctx.lineWidth = Math.max(4, h * 0.028)
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2)
  ctx.globalAlpha = 1
  // 팀명 — 한 줄. 폭에 맞춰 자동으로 줄인다(긴 팀명도 잘리지 않게).
  ctx.fillStyle = css(ink)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  let size = Math.round(h * 0.3)
  ctx.font = `800 ${size}px system-ui, sans-serif`
  const max = w * 0.78
  while (size > 12 && ctx.measureText(label).width > max) {
    size -= 4
    ctx.font = `800 ${size}px system-ui, sans-serif`
  }
  ctx.fillText(label, w / 2, h / 2)
  return canvas
}

// ── 광고보드(LED 페리미터) ──────────────────────────────────────
/**
 * 광고보드 기본 문구(가상 브랜드만 — 실존 상표 사용 금지).
 * 게임 제목("현실에서 축덕인 내가…")을 쓰지 않는 것은 의도다. 광고판은 3D 원경에서
 * 몇십 픽셀 높이로 흐르므로 짧은 대문자 라틴 문자열만 읽힌다. 더 중요하게는,
 * 밈 톤 제목은 바깥(탭·랜딩·공유 카드)에서만 쓰고 경기 화면 안쪽은 방송 톤을 유지한다.
 */
export const AD_TEXTS = [
  'VOROQ',
  'DAKER',
  'NIMUVA',
  'KOREA 2026',
  'KELZOX',
  'MATCHDAY LIVE',
  'TARVIO',
]

/**
 * 광고판 한 장의 가로:세로 비. docs/refs/stadium/adboards-fictional-brands.png의 패널이
 * 약 5.2:1이고 실제 페리미터 LED가 6m×1m이므로 6:1로 잡는다. scene.ts가 이 값으로
 * 보드 길이 대비 텍스처 repeat을 역산한다 — 안 그러면 글자가 늘어나거나 뭉갠다.
 */
export const AD_PANEL_ASPECT = 6

/**
 * 광고판 색 조합. 레퍼런스의 네 패널(보라/네이비+황색/애저/코럴)에서 그대로 뽑았다.
 * 어두운 배경 + 작은 액센트 바였던 예전 구현과의 차이가 핵심이다: 레퍼런스는
 * **전면 채색 + 굵은 대문자 + 높은 명도 대비**다. 원경 수십 픽셀에서 읽히는 건
 * 글자가 아니라 색면이므로 배경을 채워야 보드가 존재감을 갖는다.
 */
const AD_STYLES: readonly { bg: string; fg: string; icon: number }[] = [
  { bg: '#6b21f0', fg: '#ffffff', icon: 0 }, // VOROQ — 바이올렛/흰색, V 셰브런
  { bg: '#101722', fg: '#f2f6ff', icon: 4 }, // DAKER — 차콜/흰색, 바 3개
  { bg: '#0b1a3a', fg: '#f5a614', icon: 1 }, // NIMUVA — 네이비/황색, N 사선
  { bg: '#c8102e', fg: '#ffffff', icon: 3 }, // KOREA 2026 — 레드/흰색, 태극 원호 대신 원
  { bg: '#109cf1', fg: '#ffffff', icon: 2 }, // KELZOX — 애저/흰색, 다이아
  { bg: '#f2f5ff', fg: '#101722', icon: 4 }, // MATCHDAY LIVE — 흰색/차콜(반전 대비)
  { bg: '#f0463c', fg: '#14161c', icon: 5 }, // TARVIO — 코럴/차콜, T 바
]

/** 굵은 기하 아이콘 6종. 로고처럼 보이되 실존 상표를 흉내 내지 않는 순수 도형이다. */
function drawAdIcon(ctx: CanvasRenderingContext2D, kind: number, x: number, y: number, s: number, color: string): void {
  ctx.save()
  ctx.fillStyle = color
  ctx.translate(x, y)
  switch (kind % 6) {
    case 0: // 셰브런(V)
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(s * 0.26, 0)
      ctx.lineTo(s * 0.5, s * 0.62)
      ctx.lineTo(s * 0.74, 0)
      ctx.lineTo(s, 0)
      ctx.lineTo(s * 0.62, s)
      ctx.lineTo(s * 0.38, s)
      ctx.closePath()
      ctx.fill()
      break
    case 1: // 사선 바(N)
      ctx.fillRect(0, 0, s * 0.26, s)
      ctx.fillRect(s * 0.74, 0, s * 0.26, s)
      ctx.beginPath()
      ctx.moveTo(s * 0.26, 0)
      ctx.lineTo(s * 0.74, s * 0.72)
      ctx.lineTo(s * 0.74, s)
      ctx.lineTo(s * 0.26, s * 0.28)
      ctx.closePath()
      ctx.fill()
      break
    case 2: // 다이아 링
      ctx.beginPath()
      ctx.moveTo(s * 0.5, 0)
      ctx.lineTo(s, s * 0.5)
      ctx.lineTo(s * 0.5, s)
      ctx.lineTo(0, s * 0.5)
      ctx.closePath()
      ctx.fill()
      break
    case 3: // 원
      ctx.beginPath()
      ctx.arc(s * 0.5, s * 0.5, s * 0.5, 0, Math.PI * 2)
      ctx.fill()
      break
    case 4: // 수평 바 3개
      for (let i = 0; i < 3; i++) ctx.fillRect(0, i * s * 0.38, s * (1 - i * 0.22), s * 0.22)
      break
    default: // T 바
      ctx.fillRect(0, 0, s, s * 0.3)
      ctx.fillRect(s * 0.35, 0, s * 0.3, s)
      break
  }
  ctx.restore()
}

/**
 * 페리미터 LED 보드 텍스처. 패널마다 전면 채색 + 기하 아이콘 + 굵은 대문자.
 * 캔버스 폭은 `panelH × {@link AD_PANEL_ASPECT} × 패널 수`로 **자동 계산**한다
 * (호출부가 폭을 정하면 패널 비율이 깨져 글자가 늘어난다).
 * @param texts 순환 문구(빈 배열이면 기본값) @param panelH 패널 한 장의 세로 픽셀
 */
export function makeAdBoardCanvas(
  texts: readonly string[] = AD_TEXTS,
  panelH = 72,
): HTMLCanvasElement | null {
  const list = texts.length > 0 ? texts : AD_TEXTS
  const h = Math.max(16, Math.round(panelH))
  const panel = h * AD_PANEL_ASPECT
  const w = panel * list.length
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c

  for (let i = 0; i < list.length; i++) {
    // 기본 문구는 인덱스로, 사용자 지정 문구는 문자열 해시로 스타일을 고른다(결정론).
    const st = AD_STYLES[(texts === AD_TEXTS ? i : fnv1a(list[i])) % AD_STYLES.length]
    const x0 = i * panel
    ctx.fillStyle = st.bg
    ctx.fillRect(x0, 0, panel, h)

    // 아이콘 — 왼쪽 정사각 영역. 레퍼런스처럼 텍스트와 같은 색이다.
    const pad = h * 0.16
    const iconS = h - pad * 2
    drawAdIcon(ctx, st.icon, x0 + pad * 1.4, pad, iconS, st.fg)

    // 문구 — 레퍼런스는 캡하이트가 패널 높이의 약 55%다.
    ctx.fillStyle = st.fg
    ctx.font = `900 ${Math.round(h * 0.56)}px sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const textX = x0 + pad * 1.4 + iconS + h * 0.24
    ctx.fillText(list[i], textX, h * 0.52, panel - (textX - x0) - pad)

    // 패널 경계 — 실제 LED 보드는 모듈 사이에 검은 틈이 있다.
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(x0, 0, 2, h)
  }

  // LED 주사선 — 아주 약하게. 원경에서 보드가 화면 픽셀과 모아레를 일으키지 않을 정도.
  ctx.fillStyle = 'rgba(0,0,0,0.13)'
  for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1)
  // 위아래 프레임 그늘 — 보드가 얇은 판이라는 단서.
  const edge = ctx.createLinearGradient(0, 0, 0, h)
  edge.addColorStop(0, 'rgba(0,0,0,0.4)')
  edge.addColorStop(0.16, 'rgba(0,0,0,0)')
  edge.addColorStop(0.84, 'rgba(0,0,0,0)')
  edge.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = edge
  ctx.fillRect(0, 0, w, h)
  return canvas
}
