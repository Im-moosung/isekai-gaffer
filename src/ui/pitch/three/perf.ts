// src/ui/pitch/three/perf.ts
// Phase 4E 3D 매치 뷰 — 적응형 해상도 스케일러(순수 로직).
//
// 설계 원칙(Phase 4E Global Constraints):
//  - **기능이 아니라 해상도를 거래한다**: 프레임이 밀릴 때 관중을 지우거나 그림자를 끄면
//    "화면이 달라진다". 대신 렌더 타깃 픽셀 수만 줄이면 연출은 그대로 두고 60fps를 지킬 수 있다.
//    이 모듈은 "지금 유효 픽셀비는 얼마여야 하는가"만 계산하고, 실제 setSize/setPixelRatio는
//    호출부(Match3D)가 한다 → 렌더러 소유권을 침범하지 않는다.
//  - **three 무의존**: camera.ts와 같은 규칙으로 three를 import하지 않는다(타입조차).
//    덕분에 엔트리 번들에 three가 새지 않고, 테스트도 three 없이 node 환경에서 돈다.
//  - **Math.random·Date 금지**: 시간 개념은 전부 호출부가 넘기는 dtMs와 내부 프레임 카운터뿐이다.
//    같은 dtMs 수열을 먹이면 언제 어디서 돌려도 완전히 같은 스케일 궤적이 나온다.
//  - **진동 금지**: 데드밴드(히스테리시스) + 비대칭 연속 프레임 수 + 변경 직후 쿨다운,
//    세 겹으로 막는다. 해상도가 초당 몇 번씩 바뀌는 것은 느린 것보다 더 나쁘게 보인다.

/** 해상도 스케일 하한 — 이보다 낮추면 선수 실루엣·유니폼 번호가 뭉개져 "게임이 망가져 보인다". */
export const MIN_SCALE = 0.62
/** 스케일 상한. 1.0 = 장치 기준 픽셀비 그대로(그 이상 슈퍼샘플링은 하지 않는다). */
export const MAX_SCALE = 1
/**
 * 강등 폭. 픽셀 수는 스케일의 제곱이므로 0.12 강등 한 번이 약 22% 픽셀 감소다.
 * 한 번에 이 정도는 줄어야 30fps 근처에서 두세 스텝 만에 회복되고,
 * 이보다 크면 해상도 변화가 눈에 띄게 "툭" 떨어진다.
 */
export const SCALE_STEP_DOWN = 0.12
/** 승격 폭. 강등의 절반 — 올릴 때는 티 안 나게 조금씩 올린다(다시 떨어질 위험도 절반). */
export const SCALE_STEP_UP = 0.06
/**
 * 유효 픽셀비 하한. 스케일이 아니라 최종 픽셀비에 걸리는 안전장치다.
 * DPR 1 장치에서 MIN_SCALE까지 내려가면 0.62가 되는데, 그 아래는 3D 캔버스라도 형체가 무너진다.
 */
export const MIN_PIXEL_RATIO = 0.6
/**
 * 프레임타임 EMA 계수. 시상수 ≈ 1/α = 10프레임(60fps에서 약 0.17초).
 * 단발 히치(GC·텍스처 업로드) 한 프레임에 스케일이 흔들리면 안 되므로 평활이 필요하고,
 * 그렇다고 너무 느리면 진짜 저하에 반응이 늦는다.
 */
export const EMA_ALPHA = 0.1
/** 강등 임계 프레임타임(ms). 1000/18.5 ≈ 54fps — 60fps에서 명확히 미끄러진 상태. */
export const DOWN_MS = 18.5
/**
 * 승격 임계 프레임타임(ms). 1000/13.0 ≈ 77fps — 60fps 유지에 여유가 이만큼 남아야
 * 픽셀을 더 그려도 안전하다. DOWN_MS와의 간격 13.0~18.5ms가 히스테리시스의 본체이며,
 * 이 데드밴드 안에서는 아무 판정도 하지 않는다.
 */
export const UP_MS = 13.0
/** 강등 판정에 필요한 연속 프레임 수 — 60fps 기준 0.5초. 끊김은 빨리 걷어내야 한다. */
export const DOWN_FRAMES = 30
/**
 * 승격 판정에 필요한 연속 프레임 수 — 60fps 기준 2.5초.
 * 강등의 5배로 비대칭인 이유: 빨리 떨어지고 천천히 올라가야 왕복(펌핑)이 안 생긴다.
 */
export const UP_FRAMES = 150
/**
 * 스케일 변경 직후 판정 정지 프레임 수(0.75초). EMA가 새 해상도의 프레임타임으로
 * 갈아타는 데 시상수 10프레임의 몇 배가 필요하다. 이게 없으면 옛 측정값으로 즉시
 * 다음 강등을 트리거해 계단식으로 굴러떨어진다.
 */
export const COOLDOWN_FRAMES = 45
/**
 * 워밍업 프레임 수(약 1.5초). 셰이더 컴파일·텍스처 업로드·첫 GC가 몰리는 구간이라
 * 프레임타임이 실력과 무관하게 나쁘다. 이 구간은 EMA에도 넣지 않는다(측정 자체를 제외).
 */
export const WARMUP_FRAMES = 90

/**
 * 프레임타임 표본 상한(ms). 탭 백그라운드 복귀·브레이크포인트로 dtMs가 수 초로 튀는데,
 * 그 한 방이 EMA를 오염시켜 애먼 강등을 부르면 안 된다. 100ms(=10fps)면
 * "확실히 느리다"는 정보는 보존하면서 폭주는 막는다.
 */
const MAX_SAMPLE_MS = 100
/** 부동소수 누적으로 0.7599999가 되는 것을 막는 반올림 자리수(스케일은 소수 둘째 자리 격자). */
const SCALE_EPS_DIGITS = 4

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const roundScale = (v: number) => Number(v.toFixed(SCALE_EPS_DIGITS))

export interface RenderScalerOptions {
  /** 장치 기준 픽셀비 상한 = min(devicePixelRatio, 2). 스케일 1.0이 이 값이다. */
  basePixelRatio: number
  /** 시작 스케일(기본 1). 직전 세션 기억값을 넣는다. */
  initialScale?: number
}

export interface ScalerStep {
  /** 이번 프레임에 적용해야 할 유효 픽셀비 = clamp(basePixelRatio * scale, MIN_PIXEL_RATIO, basePixelRatio). */
  pixelRatio: number
  /** 현재 스케일(0..1). */
  scale: number
  /** 이번 프레임에 스케일이 바뀌었는가(true일 때만 호출부가 setSize/setPixelRatio를 다시 부른다). */
  changed: boolean
  /** 최저 스케일에서도 계속 느린가 — 호출부가 마지막 수단(포스트FX 끄기)을 쓰는 신호. */
  starving: boolean
}

export interface RenderScaler {
  /** 매 프레임 1회. dtMs = 직전 프레임 소요 시간(ms). */
  update(dtMs: number): ScalerStep
  readonly scale: number
  readonly pixelRatio: number
  /** 지수이동평균 프레임타임(ms). 계측·테스트용. */
  readonly avgFrameMs: number
}

/**
 * 유효 픽셀비를 계산한다. basePixelRatio가 MIN_PIXEL_RATIO보다 작은 병리적 입력
 * (jsdom의 devicePixelRatio 0, NaN 등)에서도 절대 NaN·음수·0을 돌려주지 않는다.
 */
function effectivePixelRatio(base: number, scale: number): number {
  // 하한(MIN_PIXEL_RATIO)이 상한(base)보다 큰 역전 구간에서는 상한을 우선한다 —
  // "장치가 줄 수 있는 것보다 더 큰 픽셀비"를 렌더러에 넘기는 쪽이 더 위험하다.
  const hi = Number.isFinite(base) && base > 0 ? base : 1
  const lo = Math.min(MIN_PIXEL_RATIO, hi)
  return clamp(hi * scale, lo, hi)
}

/** 초기 스케일 정규화 — NaN·undefined·범위 밖을 전부 안전한 값으로 접는다. */
function normalizeScale(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return MAX_SCALE
  return roundScale(clamp(value, MIN_SCALE, MAX_SCALE))
}

/**
 * 적응형 해상도 스케일러를 만든다. 상태는 프레임 카운터 뿐이며 시계를 읽지 않는다.
 *
 * 판정 순서(한 프레임): 워밍업 → EMA 갱신 → 쿨다운 → 데드밴드 판정 → 스케일 조정.
 */
export function createRenderScaler(opts: RenderScalerOptions): RenderScaler {
  const base = opts.basePixelRatio
  let scale = normalizeScale(opts.initialScale)
  let ema = 0
  let seeded = false
  let frames = 0
  let downCount = 0
  let upCount = 0
  let cooldown = 0

  function step(changed: boolean, starving: boolean): ScalerStep {
    return { pixelRatio: effectivePixelRatio(base, scale), scale, changed, starving }
  }

  function update(dtMs: number): ScalerStep {
    frames++
    // 워밍업 구간은 판정도 측정도 하지 않는다(셰이더 컴파일 비용을 실력으로 오해하지 않도록).
    if (frames <= WARMUP_FRAMES) return step(false, false)

    // NaN·Infinity·음수는 통째로 버리고, 정상 표본만 0~MAX_SAMPLE_MS로 클램프해 EMA에 넣는다.
    if (Number.isFinite(dtMs) && dtMs >= 0) {
      const sample = dtMs > MAX_SAMPLE_MS ? MAX_SAMPLE_MS : dtMs
      // 첫 유효 표본은 EMA를 그 값으로 시드한다(0에서 출발하면 초반 2.5초가 가짜 "빠름"이 된다).
      ema = seeded ? ema + EMA_ALPHA * (sample - ema) : sample
      seeded = true
    }
    if (!seeded) return step(false, false)

    // 쿨다운 중에는 카운터를 올리지도 않는다 — 옛 해상도의 EMA로 다음 판정을 하면 진동한다.
    if (cooldown > 0) {
      cooldown--
      return step(false, false)
    }

    if (ema > DOWN_MS) {
      downCount++
      upCount = 0
    } else if (ema < UP_MS) {
      upCount++
      downCount = 0
    } else {
      // 데드밴드 안(애매한 구간)은 누적하지 않는다. 여기서 카운터를 유지하면
      // 임계 근처를 오가는 프레임이 결국 강등을 트리거한다.
      downCount = 0
      upCount = 0
    }

    if (downCount >= DOWN_FRAMES) {
      downCount = 0
      if (scale > MIN_SCALE) {
        scale = roundScale(Math.max(MIN_SCALE, scale - SCALE_STEP_DOWN))
        cooldown = COOLDOWN_FRAMES
        return step(true, false)
      }
      // 최저 해상도인데도 느리다 → 더 줄일 픽셀이 없다. 해상도는 그대로이므로 changed=false
      // (불필요한 setSize 금지)이고 쿨다운도 걸지 않는다(적응할 새 해상도가 없다).
      // 대신 호출부가 마지막 수단을 쓰도록 starving을 올린다.
      return step(false, true)
    }

    if (upCount >= UP_FRAMES) {
      upCount = 0
      if (scale < MAX_SCALE) {
        scale = roundScale(Math.min(MAX_SCALE, scale + SCALE_STEP_UP))
        cooldown = COOLDOWN_FRAMES
        return step(true, false)
      }
      return step(false, false)
    }

    return step(false, false)
  }

  return {
    update,
    get scale() {
      return scale
    },
    get pixelRatio() {
      return effectivePixelRatio(base, scale)
    },
    get avgFrameMs() {
      return ema
    },
  }
}

/** 스케일 기억 키 — 같은 기기에서 두 번째 경기부터는 워밍업 없이 맞는 해상도로 시작한다. */
export const SCALE_STORAGE_KEY = 'rematch-3d-scale'

/**
 * 직전 세션에서 안정된 스케일을 읽는다. 없거나 이상하면 1.
 * storage 접근은 사파리 프라이빗 모드 등에서 throw할 수 있으므로 전부 삼킨다 —
 * 성능 힌트를 못 읽는 것이 경기 시작을 막을 이유는 없다.
 */
export function readStoredScale(storage: Pick<Storage, 'getItem'> | null | undefined): number {
  if (!storage) return MAX_SCALE
  let raw: string | null = null
  try {
    raw = storage.getItem(SCALE_STORAGE_KEY)
  } catch {
    return MAX_SCALE
  }
  if (typeof raw !== 'string' || raw.trim() === '') return MAX_SCALE
  const value = Number(raw)
  // 범위 밖이면 클램프가 아니라 1로 폴백한다 — 손상된 값을 "가장 가까운 진실"로
  // 취급하는 것보다, 다시 측정해서 배우는 쪽이 안전하다.
  if (!Number.isFinite(value) || value < MIN_SCALE || value > MAX_SCALE) return MAX_SCALE
  return value
}

/** 안정된 스케일을 기록한다. 실패해도 throw하지 않는다. */
export function writeStoredScale(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  scale: number,
): void {
  if (!storage) return
  const safe = normalizeScale(scale)
  try {
    // 소수 둘째 자리까지만 — 스케일 격자가 0.06/0.12 단위라 그 이상의 정밀도는 의미가 없고,
    // 문자열이 짧아야 다음 세션의 파싱도 단순하다.
    storage.setItem(SCALE_STORAGE_KEY, safe.toFixed(2))
  } catch {
    // 저장 실패는 다음 세션이 1.0에서 다시 배우면 될 뿐, 알릴 가치가 없다.
  }
}
