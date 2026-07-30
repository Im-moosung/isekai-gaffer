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
 */
export function makeNetCanvas(size = 128, cells = 10): HTMLCanvasElement | null {
  const c = makeCanvas(size, size)
  if (!c) return null
  const { ctx, canvas } = c
  ctx.clearRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'
  ctx.lineWidth = Math.max(1, size / cells / 12)
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

// ── 광고보드(LED 페리미터) ──────────────────────────────────────
/**
 * 광고보드 기본 문구(가상 브랜드만 — 실존 상표 사용 금지).
 * 게임 제목("현실에서 축덕인 내가…")을 쓰지 않는 것은 의도다. 광고판은 3D 원경에서
 * 몇십 픽셀 높이로 흐르므로 짧은 대문자 라틴 문자열만 읽힌다. 더 중요하게는,
 * 밈 톤 제목은 바깥(탭·랜딩·공유 카드)에서만 쓰고 경기 화면 안쪽은 방송 톤을 유지한다.
 */
export const AD_TEXTS = ['KOREA 2026', 'DAKER', 'MATCHDAY LIVE']

/**
 * 페리미터 LED 보드 텍스처. 어두운 배경에 밝은 문구 + 액센트 바.
 * @param texts 순환 문구 @param w,h 타일 픽셀
 */
export function makeAdBoardCanvas(
  texts: readonly string[] = AD_TEXTS,
  w = 1024,
  h = 96,
): HTMLCanvasElement | null {
  const c = makeCanvas(w, h)
  if (!c) return null
  const { ctx, canvas } = c
  const list = texts.length > 0 ? texts : AD_TEXTS
  const panel = w / list.length
  const accents = ['#e4373f', '#2f6bd8', '#f0b429']
  for (let i = 0; i < list.length; i++) {
    const x0 = i * panel
    const g = ctx.createLinearGradient(x0, 0, x0, h)
    g.addColorStop(0, '#0d1220')
    g.addColorStop(1, '#050810')
    ctx.fillStyle = g
    ctx.fillRect(x0, 0, panel, h)
    // 액센트 바(아래쪽)
    ctx.fillStyle = accents[i % accents.length]
    ctx.fillRect(x0 + 6, h - 10, panel - 12, 6)
    // 문구
    ctx.fillStyle = '#f2f6ff'
    ctx.font = `bold ${Math.round(h * 0.44)}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(list[i], x0 + panel / 2, h * 0.44, panel - 20)
  }
  return canvas
}
