// src/ui/pitch/three/tone.ts
// 렌더 프레임 톤 계측 — RGBA8 픽셀 버퍼 → 히스토그램·클리핑·동적범위 통계.
//
// 설계 원칙:
//  - **왜 있는가**: 포스트 프로세싱(블룸·톤매핑·비네트·그레인) 튜닝은 "평평해 보인다" 같은
//    감상으로는 수렴하지 않는다. "p99=165, 동적범위 118, 백클립 0.000%"처럼 숫자로 바꿔야
//    파라미터를 되돌릴지 밀어붙일지 판단할 수 있다. 이 모듈이 그 숫자를 만든다.
//  - **순수 함수 · 무의존**: three도 DOM도 쓰지 않는다. 헤드리스 렌더 도구(별도)가
//    브라우저 안에서 readPixels 결과를 그대로 넘긴다. 그래서 node 환경 테스트가 가능하다.
//  - **비선형(sRGB) 휘도**: Rec.709 계수를 8bit 값에 *그대로* 적용한다. 선형화하지 않는다.
//    우리가 재려는 건 물리 휘도가 아니라 **화면에 보이는 톤 분포**다. 선형화하면 야간 경기
//    장면의 픽셀이 전부 하위 몇 개 bin으로 뭉쳐서 히스토그램이 아무것도 구분하지 못한다.
//  - **단일 패스**: 1920×1080×4 = 8.3MB 버퍼를 한 번만 훑는다. 배열 할당은 루프 밖에서.
//    퍼센타일도 정렬 없이 히스토그램 누적합으로 구한다(수백만 픽셀 정렬은 논외).
//  - **NaN 금지**: 표본이 0(전부 알파 0)이어도 모든 필드가 0인 통계를 돌려준다. 계측 도구가
//    NaN을 표에 찍으면 그 표는 통째로 못 믿는다.

/** 8bit 채널 히스토그램(256 bin). */
export interface ToneHistogram {
  /** 휘도 히스토그램. 합 = 표본 픽셀 수. */
  luma: Uint32Array
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
}

export interface ToneStats {
  /** 표본 픽셀 수(알파 0 픽셀 제외 후). */
  samples: number
  /** 평균 휘도(0~255). */
  meanLuma: number
  /** 휘도 표준편차(0~255). 낮으면 "평평하다". */
  stdLuma: number
  /** 휘도 퍼센타일(0~255). */
  p01: number
  p05: number
  p50: number
  p95: number
  p99: number
  /** 최소·최대 휘도. */
  minLuma: number
  maxLuma: number
  /** 검정 클리핑 비율(0~1) — 휘도 <= BLACK_CLIP_AT(=2)인 픽셀 비율. */
  blackClip: number
  /** 흰색 클리핑 비율(0~1) — 세 채널이 모두 >= WHITE_CLIP_AT(=254)인 픽셀 비율. */
  whiteClip: number
  /** 채널별 포화 비율(0~1) — 해당 채널이 >= WHITE_CLIP_AT. 특정 채널이 먼저 타는지 본다. */
  rClip: number
  gClip: number
  bClip: number
  /** 평균 채도(0~1) — HSV S의 평균. 톤매퍼가 색을 얼마나 빨아먹는지. */
  meanSaturation: number
  /** 동적 범위 지표 = p99 - p01. 클수록 대비가 살아 있다. */
  dynamicRange: number
}

/** 이 값 이하의 휘도는 "검정으로 뭉갰다"로 센다. 0만 세면 디더·그레인에 가려 놓친다. */
export const BLACK_CLIP_AT = 2
/** 이 값 이상의 채널은 "탔다"로 센다. 255만 세면 톤매퍼 반올림 직전 상태를 놓친다. */
export const WHITE_CLIP_AT = 254

// Rec.709 휘도 계수(sRGB 8bit 값에 직접 적용 — 위 설계 원칙 참조).
const LUMA_R = 0.2126
const LUMA_G = 0.7152
const LUMA_B = 0.0722

/** 알파 0 픽셀만 제외한 스캔 결과. 히스토그램과 스칼라 누적을 한 패스로 함께 모은다. */
interface ScanResult {
  hist: ToneHistogram
  samples: number
  /** 채도 합(0~1 스케일). 평균은 samples로 나눠서 얻는다. */
  satSum: number
  blackCount: number
  whiteCount: number
  rCount: number
  gCount: number
  bCount: number
}

function emptyHistogram(): ToneHistogram {
  return {
    luma: new Uint32Array(256),
    r: new Uint32Array(256),
    g: new Uint32Array(256),
    b: new Uint32Array(256),
  }
}

/**
 * RGBA8 버퍼를 한 번만 훑어 히스토그램과 클리핑·채도 누적을 모은다.
 * 알파 0 픽셀은 표본에서 제외한다 — 캔버스의 투명 영역이 검정 클리핑으로 잡히면
 * "그림자가 뭉갰다"는 잘못된 진단이 나온다.
 */
function scan(rgba: Uint8Array | Uint8ClampedArray): ScanResult {
  if (rgba.length % 4 !== 0) {
    throw new Error(`RGBA8 버퍼 길이는 4의 배수여야 한다(받은 길이: ${rgba.length}).`)
  }
  // 할당은 전부 루프 밖에서 — 8.3MB 버퍼에서 루프 내 할당은 GC 압력으로 바로 드러난다.
  const hist = emptyHistogram()
  const hl = hist.luma
  const hr = hist.r
  const hg = hist.g
  const hb = hist.b
  let samples = 0
  let satSum = 0
  let blackCount = 0
  let whiteCount = 0
  let rCount = 0
  let gCount = 0
  let bCount = 0

  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const r = rgba[i]
    const g = rgba[i + 1]
    const b = rgba[i + 2]
    samples++
    hr[r]++
    hg[g]++
    hb[b]++

    // 휘도는 반올림해서 bin에 넣는다(0~255 범위를 벗어날 수 없다).
    const y = (LUMA_R * r + LUMA_G * g + LUMA_B * b + 0.5) | 0
    hl[y]++

    if (y <= BLACK_CLIP_AT) blackCount++
    const rHot = r >= WHITE_CLIP_AT
    const gHot = g >= WHITE_CLIP_AT
    const bHot = b >= WHITE_CLIP_AT
    if (rHot) rCount++
    if (gHot) gCount++
    if (bHot) bCount++
    if (rHot && gHot && bHot) whiteCount++

    // HSV 채도 = (max-min)/max. max=0(순수 검정)이면 채도는 정의상 0.
    const max = r > g ? (r > b ? r : b) : g > b ? g : b
    if (max !== 0) {
      const min = r < g ? (r < b ? r : b) : g < b ? g : b
      satSum += (max - min) / max
    }
  }

  return { hist, samples, satSum, blackCount, whiteCount, rCount, gCount, bCount }
}

/** RGBA8 버퍼(길이 = w*h*4)에서 히스토그램을 만든다. */
export function buildHistogram(rgba: Uint8Array | Uint8ClampedArray): ToneHistogram {
  return scan(rgba).hist
}

/**
 * 히스토그램 누적합에서 퍼센타일을 구한다(정렬 금지).
 * 경계 정의: p_k = 누적 비율이 k/100 **이상이 되는 첫 bin**.
 * 예) 표본 100개가 0..99에 하나씩이면 p01 = 0(누적 1/100 = 0.01 >= 0.01인 첫 bin).
 * ks는 오름차순이어야 하며, 결과는 같은 순서로 돌려준다.
 */
function percentiles(hist: Uint32Array, samples: number, ks: readonly number[]): number[] {
  const out = new Array<number>(ks.length).fill(0)
  if (samples <= 0) return out
  let k = 0
  let cum = 0
  for (let bin = 0; bin < 256 && k < ks.length; bin++) {
    cum += hist[bin]
    const ratio = cum / samples
    // 한 bin이 여러 퍼센타일을 동시에 넘길 수 있다(단색 버퍼에서는 한 bin이 전부).
    while (k < ks.length && ratio >= ks[k] / 100) {
      out[k] = bin
      k++
    }
  }
  return out
}

/** 히스토그램 + 원본 버퍼에서 통계를 낸다. */
export function toneStats(rgba: Uint8Array | Uint8ClampedArray): ToneStats {
  const s = scan(rgba)
  const n = s.samples
  if (n === 0) {
    // 표본 0 — NaN 대신 전부 0. 계측 표에 NaN이 한 칸이라도 뜨면 표 전체를 못 믿는다.
    return {
      samples: 0,
      meanLuma: 0,
      stdLuma: 0,
      p01: 0,
      p05: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      minLuma: 0,
      maxLuma: 0,
      blackClip: 0,
      whiteClip: 0,
      rClip: 0,
      gClip: 0,
      bClip: 0,
      meanSaturation: 0,
      dynamicRange: 0,
    }
  }

  // 평균·분산은 히스토그램에서 구한다(버퍼 재순회 불필요).
  const hl = s.hist.luma
  let sum = 0
  let sumSq = 0
  let minLuma = 0
  let maxLuma = 0
  let seen = false
  for (let bin = 0; bin < 256; bin++) {
    const c = hl[bin]
    if (c === 0) continue
    if (!seen) {
      minLuma = bin
      seen = true
    }
    maxLuma = bin
    sum += bin * c
    sumSq += bin * bin * c
  }
  const meanLuma = sum / n
  // 모분산(표본분산 아님) — 프레임 전체 픽셀이 곧 모집단이다.
  const variance = Math.max(0, sumSq / n - meanLuma * meanLuma)
  const stdLuma = Math.sqrt(variance)

  const [p01, p05, p50, p95, p99] = percentiles(hl, n, [1, 5, 50, 95, 99])

  return {
    samples: n,
    meanLuma,
    stdLuma,
    p01,
    p05,
    p50,
    p95,
    p99,
    minLuma,
    maxLuma,
    blackClip: s.blackCount / n,
    whiteClip: s.whiteCount / n,
    rClip: s.rCount / n,
    gClip: s.gCount / n,
    bClip: s.bCount / n,
    meanSaturation: s.satSum / n,
    dynamicRange: p99 - p01,
  }
}

const f2 = (v: number) => v.toFixed(2)
// 클립은 % 환산 후 소수 3자리 — 0.001%(1920×1080에서 약 20픽셀) 차이가 튜닝 판단을 가른다.
const pct3 = (v: number) => (v * 100).toFixed(3)

/** 마크다운 표 헤더(formatToneRow와 열이 정확히 맞아야 한다). */
export const TONE_TABLE_HEADER =
  '| 라벨 | 평균 | 표준편차 | p01 | p50 | p99 | 동적범위 | 흑클립% | 백클립% | 채도 |\n' +
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'

/** 두 통계의 차이를 사람이 읽는 마크다운 표 행으로. (도구가 전후 비교표를 찍는다) */
export function formatToneRow(label: string, s: ToneStats): string {
  return (
    `| ${label} | ${f2(s.meanLuma)} | ${f2(s.stdLuma)} | ${f2(s.p01)} | ${f2(s.p50)} | ` +
    `${f2(s.p99)} | ${f2(s.dynamicRange)} | ${pct3(s.blackClip)} | ${pct3(s.whiteClip)} | ` +
    `${f2(s.meanSaturation)} |`
  )
}
