// tone.ts는 three도 DOM도 쓰지 않는 순수 계측 모듈이라 node 환경에서 그대로 검증한다.
// 이 테스트의 목적은 "포스트 프로세싱 튜닝 판단의 근거가 되는 숫자"가 흔들리지 않게 못 박는 것.
import { describe, it, expect } from 'vitest'
import {
  BLACK_CLIP_AT,
  TONE_TABLE_HEADER,
  WHITE_CLIP_AT,
  buildHistogram,
  formatToneRow,
  toneStats,
} from '../tone'

/** 같은 픽셀 n개로 채운 RGBA8 버퍼. */
function solid(n: number, r: number, g: number, b: number, a = 255): Uint8Array {
  const buf = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    buf[i * 4] = r
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = b
    buf[i * 4 + 3] = a
  }
  return buf
}

/** 픽셀 배열([r,g,b,a])로 버퍼를 만든다. */
function fromPixels(px: readonly (readonly [number, number, number, number])[]): Uint8Array {
  const buf = new Uint8Array(px.length * 4)
  for (let i = 0; i < px.length; i++) {
    buf[i * 4] = px[i][0]
    buf[i * 4 + 1] = px[i][1]
    buf[i * 4 + 2] = px[i][2]
    buf[i * 4 + 3] = px[i][3]
  }
  return buf
}

/** 0..255 균등 램프(무채색) 256픽셀. */
function ramp(): Uint8Array {
  const px: [number, number, number, number][] = []
  for (let v = 0; v < 256; v++) px.push([v, v, v, 255])
  return fromPixels(px)
}

describe('buildHistogram', () => {
  it('휘도 히스토그램의 합이 표본 픽셀 수와 같다', () => {
    const h = buildHistogram(ramp())
    let sum = 0
    for (let i = 0; i < 256; i++) sum += h.luma[i]
    expect(sum).toBe(256)
  })

  it('램프에서는 모든 bin이 정확히 1개씩이다(무채색이라 채널 히스토그램도 동일)', () => {
    const h = buildHistogram(ramp())
    for (let v = 0; v < 256; v++) {
      expect(h.luma[v]).toBe(1)
      expect(h.r[v]).toBe(1)
      expect(h.g[v]).toBe(1)
      expect(h.b[v]).toBe(1)
    }
  })

  it('알파 0 픽셀은 히스토그램에 들어가지 않는다', () => {
    const h = buildHistogram(fromPixels([[10, 10, 10, 0], [200, 200, 200, 255]]))
    expect(h.luma[10]).toBe(0)
    expect(h.luma[200]).toBe(1)
  })
})

describe('단색 버퍼 통계', () => {
  it('전부 검정: 평균·표준편차 0, 흑클립 100%, 채도 0', () => {
    const s = toneStats(solid(64, 0, 0, 0))
    expect(s.samples).toBe(64)
    expect(s.meanLuma).toBe(0)
    expect(s.stdLuma).toBe(0)
    expect(s.minLuma).toBe(0)
    expect(s.maxLuma).toBe(0)
    expect(s.blackClip).toBe(1)
    expect(s.whiteClip).toBe(0)
    expect(s.meanSaturation).toBe(0)
    expect(s.dynamicRange).toBe(0)
  })

  it('전부 흰색: 평균 255, 백클립 100%, 흑클립 0%, 채널 클립 전부 100%', () => {
    const s = toneStats(solid(64, 255, 255, 255))
    expect(s.meanLuma).toBe(255)
    expect(s.stdLuma).toBe(0)
    expect(s.p01).toBe(255)
    expect(s.p99).toBe(255)
    expect(s.whiteClip).toBe(1)
    expect(s.blackClip).toBe(0)
    expect(s.rClip).toBe(1)
    expect(s.gClip).toBe(1)
    expect(s.bClip).toBe(1)
    expect(s.meanSaturation).toBe(0)
  })

  it('중간 회색 128: 휘도 계수 합이 1이라 평균이 정확히 128이고 클립이 없다', () => {
    const s = toneStats(solid(100, 128, 128, 128))
    expect(s.meanLuma).toBe(128)
    expect(s.stdLuma).toBe(0)
    expect(s.p01).toBe(128)
    expect(s.p50).toBe(128)
    expect(s.p99).toBe(128)
    expect(s.dynamicRange).toBe(0)
    expect(s.blackClip).toBe(0)
    expect(s.whiteClip).toBe(0)
  })
})

describe('퍼센타일(히스토그램 누적합)', () => {
  it('램프 0..255에서 p01·p50·p99가 기대 bin과 일치한다', () => {
    const s = toneStats(ramp())
    expect(s.samples).toBe(256)
    // p_k = 누적 비율이 k/100 이상이 되는 첫 bin. 256픽셀이면 bin b의 누적은 (b+1)/256.
    expect(s.p01).toBe(2) // (2+1)/256 = 0.0117 >= 0.01
    expect(s.p05).toBe(12) // (12+1)/256 = 0.0508 >= 0.05
    expect(s.p50).toBe(127) // (127+1)/256 = 0.5 >= 0.5
    expect(s.p95).toBe(243)
    expect(s.p99).toBe(253)
    expect(s.minLuma).toBe(0)
    expect(s.maxLuma).toBe(255)
    expect(s.meanLuma).toBeCloseTo(127.5, 6)
    expect(s.dynamicRange).toBe(251)
  })

  it('단일 bin 버퍼에서는 모든 퍼센타일이 그 bin이다(한 bin이 여러 경계를 동시에 넘김)', () => {
    const s = toneStats(solid(10, 77, 77, 77))
    expect([s.p01, s.p05, s.p50, s.p95, s.p99]).toEqual([77, 77, 77, 77, 77])
  })
})

describe('알파 0 제외', () => {
  it('투명 검정 픽셀은 흑클립으로 잡히지 않는다', () => {
    const px: [number, number, number, number][] = []
    for (let i = 0; i < 50; i++) px.push([0, 0, 0, 0])
    for (let i = 0; i < 50; i++) px.push([200, 200, 200, 255])
    const s = toneStats(fromPixels(px))
    expect(s.samples).toBe(50)
    expect(s.meanLuma).toBe(200)
    expect(s.blackClip).toBe(0)
  })

  it('전부 알파 0이면 samples=0이고 어떤 필드도 NaN이 아니다', () => {
    const s = toneStats(solid(32, 0, 0, 0, 0))
    expect(s.samples).toBe(0)
    for (const [key, v] of Object.entries(s)) {
      expect(Number.isNaN(v), `${key}가 NaN이면 안 된다`).toBe(false)
      expect(v).toBe(0)
    }
  })
})

describe('클리핑 경계값', () => {
  it('휘도 2는 흑클립에 포함되고 3은 제외된다', () => {
    expect(BLACK_CLIP_AT).toBe(2)
    const s = toneStats(
      fromPixels([
        [0, 0, 0, 255],
        [2, 2, 2, 255],
        [3, 3, 3, 255],
        [4, 4, 4, 255],
      ]),
    )
    expect(s.blackClip).toBeCloseTo(2 / 4, 12)
  })

  it('채널 254는 백클립에 포함되고 253은 제외된다', () => {
    expect(WHITE_CLIP_AT).toBe(254)
    const s = toneStats(
      fromPixels([
        [254, 254, 254, 255],
        [255, 255, 255, 255],
        [253, 255, 255, 255], // 한 채널이 253이라 백클립 아님
        [10, 10, 10, 255],
      ]),
    )
    expect(s.whiteClip).toBeCloseTo(2 / 4, 12)
  })

  it('흑클립 비율이 정확하다(4분의 1)', () => {
    const px: [number, number, number, number][] = []
    for (let i = 0; i < 25; i++) px.push([0, 0, 0, 255])
    for (let i = 0; i < 75; i++) px.push([128, 128, 128, 255])
    const s = toneStats(fromPixels(px))
    expect(s.blackClip).toBeCloseTo(0.25, 12)
    expect(s.whiteClip).toBe(0)
  })
})

describe('채널별 포화 구분', () => {
  it('빨강만 포화한 버퍼에서 rClip만 올라간다', () => {
    // 잔디 위 붉은 유니폼이 먼저 타는 상황 — 백클립 0%인데 색이 뭉개지는 케이스를 잡아야 한다.
    const px: [number, number, number, number][] = []
    for (let i = 0; i < 20; i++) px.push([255, 100, 100, 255])
    for (let i = 0; i < 80; i++) px.push([60, 90, 70, 255])
    const s = toneStats(fromPixels(px))
    expect(s.rClip).toBeCloseTo(0.2, 12)
    expect(s.gClip).toBe(0)
    expect(s.bClip).toBe(0)
    expect(s.whiteClip).toBe(0)
  })
})

describe('채도', () => {
  it('무채색은 0', () => {
    expect(toneStats(solid(16, 90, 90, 90)).meanSaturation).toBe(0)
  })

  it('순색(빨강)은 1', () => {
    expect(toneStats(solid(16, 255, 0, 0)).meanSaturation).toBe(1)
    expect(toneStats(solid(16, 0, 200, 0)).meanSaturation).toBe(1)
  })

  it('중간 채도는 (max-min)/max', () => {
    const s = toneStats(solid(16, 200, 100, 150))
    expect(s.meanSaturation).toBeCloseTo((200 - 100) / 200, 12)
  })

  it('순수 검정(max=0)에서 0으로 나누지 않는다', () => {
    expect(toneStats(solid(4, 0, 0, 0)).meanSaturation).toBe(0)
  })
})

describe('잘못된 버퍼', () => {
  it('길이가 4의 배수가 아니면 throw', () => {
    expect(() => toneStats(new Uint8Array(5))).toThrow(/4의 배수/)
    expect(() => buildHistogram(new Uint8Array(7))).toThrow(/4의 배수/)
  })

  it('빈 버퍼는 throw하지 않고 samples=0', () => {
    expect(toneStats(new Uint8Array(0)).samples).toBe(0)
  })
})

describe('평평한 렌더 vs 대비 있는 렌더 (이 도구의 존재 이유)', () => {
  // 톤매핑이 과하면 전체가 중간 톤에 몰려 "평평"해진다. 눈으로는 애매해도 숫자는 명확히 갈린다.
  function band(lo: number, hi: number, n: number): Uint8Array {
    const px: [number, number, number, number][] = []
    for (let i = 0; i < n; i++) {
      const v = lo + Math.round(((hi - lo) * i) / (n - 1))
      px.push([v, v, v, 255])
    }
    return fromPixels(px)
  }

  it('좁은 범위(100~130)는 넓은 범위(0~255)보다 동적범위·표준편차가 확연히 작다', () => {
    const flat = toneStats(band(100, 130, 512))
    const punchy = toneStats(band(0, 255, 512))

    expect(flat.dynamicRange).toBeLessThan(32)
    expect(punchy.dynamicRange).toBeGreaterThan(240)
    expect(flat.stdLuma).toBeLessThan(12)
    expect(punchy.stdLuma).toBeGreaterThan(60)
    expect(flat.stdLuma).toBeLessThan(punchy.stdLuma)
    // 평평한 쪽은 클리핑이 전혀 없다 — "안전하지만 심심한" 렌더의 서명.
    expect(flat.blackClip).toBe(0)
    expect(flat.whiteClip).toBe(0)
  })

  it('Uint8ClampedArray(캔버스 ImageData)도 동일하게 처리한다', () => {
    const src = band(100, 130, 512)
    const clamped = new Uint8ClampedArray(src)
    expect(toneStats(clamped)).toEqual(toneStats(src))
  })
})

describe('마크다운 표 출력', () => {
  it('formatToneRow의 열 개수가 TONE_TABLE_HEADER와 일치한다', () => {
    const [head, sep] = TONE_TABLE_HEADER.split('\n')
    const row = formatToneRow('after', toneStats(ramp()))
    const cols = (line: string) => line.split('|').length
    expect(cols(row)).toBe(cols(head))
    expect(cols(sep)).toBe(cols(head))
    // 라벨 + 9개 지표 = 10열 (양 끝 파이프로 split하면 12조각).
    expect(cols(head)).toBe(12)
  })

  it('라벨과 소수 자릿수 규칙(지표 2자리, 클립은 % 환산 3자리)을 지킨다', () => {
    const row = formatToneRow('before', toneStats(ramp()))
    expect(row.startsWith('| before |')).toBe(true)
    const cells = row.split('|').slice(1, -1).map((c) => c.trim())
    expect(cells[0]).toBe('before')
    expect(cells[1]).toBe('127.50') // 평균
    expect(cells[6]).toBe('251.00') // 동적범위
    // 램프에서 휘도 <= 2인 bin은 0·1·2 → 3/256 = 1.171875%
    expect(cells[7]).toBe('1.172')
    // 세 채널 모두 >= 254인 픽셀은 254·255 → 2/256 = 0.78125%
    expect(cells[8]).toBe('0.781')
    expect(cells[9]).toBe('0.00') // 무채색 램프의 채도
  })
})
