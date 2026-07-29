// perf.ts는 three를 전혀 import하지 않는 순수 로직 모듈이다(코드 스플릿 보장).
// 따라서 이 테스트도 three·DOM 없이 node 환경에서 돈다 — 저장 헬퍼만 구조적 스텁으로 검증한다.
import { describe, it, expect } from 'vitest'
import {
  COOLDOWN_FRAMES,
  DOWN_FRAMES,
  DOWN_MS,
  EMA_ALPHA,
  MAX_SCALE,
  MIN_PIXEL_RATIO,
  MIN_SCALE,
  SCALE_STEP_DOWN,
  SCALE_STEP_UP,
  SCALE_STORAGE_KEY,
  UP_FRAMES,
  UP_MS,
  WARMUP_FRAMES,
  createRenderScaler,
  readStoredScale,
  writeStoredScale,
  type RenderScaler,
  type ScalerStep,
} from '../perf'

/** 워밍업 구간을 소진한다(이 구간의 dtMs는 EMA에도 들어가지 않아야 한다). */
function warmup(s: RenderScaler, dtMs = 16.7): ScalerStep[] {
  const out: ScalerStep[] = []
  for (let i = 0; i < WARMUP_FRAMES; i++) out.push(s.update(dtMs))
  return out
}

/** n프레임 동안 같은 dtMs를 먹이고 각 프레임의 결과를 모은다. */
function feed(s: RenderScaler, n: number, dtMs: number): ScalerStep[] {
  const out: ScalerStep[] = []
  for (let i = 0; i < n; i++) out.push(s.update(dtMs))
  return out
}

const changedCount = (steps: ScalerStep[]) => steps.filter((s) => s.changed).length

describe('상수 — 수치 계약', () => {
  it('데드밴드·비대칭 계단이 명세대로다', () => {
    expect(MIN_SCALE).toBe(0.62)
    expect(MAX_SCALE).toBe(1)
    expect(SCALE_STEP_DOWN).toBe(0.12)
    expect(SCALE_STEP_UP).toBe(0.06)
    expect(MIN_PIXEL_RATIO).toBe(0.6)
    expect(EMA_ALPHA).toBe(0.1)
    expect(DOWN_MS).toBe(18.5)
    expect(UP_MS).toBe(13.0)
    expect(DOWN_FRAMES).toBe(30)
    expect(UP_FRAMES).toBe(150)
    expect(COOLDOWN_FRAMES).toBe(45)
    expect(WARMUP_FRAMES).toBe(90)
    // 히스테리시스의 본체: 승격 임계가 강등 임계보다 확실히 빠르다
    expect(UP_MS).toBeLessThan(DOWN_MS)
    // 빨리 떨어지고 천천히 올라간다
    expect(DOWN_FRAMES).toBeLessThan(UP_FRAMES)
    expect(SCALE_STEP_UP).toBeLessThan(SCALE_STEP_DOWN)
  })
})

describe('명세 1 — 워밍업', () => {
  it('첫 90프레임은 어떤 dtMs가 와도 스케일이 움직이지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    const steps = warmup(s, 500) // 2fps짜리 최악의 셰이더 컴파일 구간
    expect(changedCount(steps)).toBe(0)
    expect(steps.every((x) => x.starving === false)).toBe(true)
    expect(s.scale).toBe(1)
  })

  it('워밍업 구간의 프레임타임은 EMA에도 들어가지 않는다(측정 제외)', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s, 500)
    expect(s.avgFrameMs).toBe(0)
    // 워밍업 직후 첫 유효 표본이 EMA를 시드한다 — 500ms의 잔향이 남지 않는다
    s.update(16)
    expect(s.avgFrameMs).toBe(16)
  })
})

describe('명세 2 — 강등', () => {
  it('EMA > DOWN_MS가 DOWN_FRAMES 연속이면 정확히 그 프레임에 강등한다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    const steps = feed(s, DOWN_FRAMES, 30) // ≈33fps
    expect(changedCount(steps)).toBe(1)
    for (let i = 0; i < DOWN_FRAMES - 1; i++) expect(steps[i]!.changed).toBe(false)
    const last = steps[DOWN_FRAMES - 1]!
    expect(last.changed).toBe(true)
    expect(last.starving).toBe(false)
    expect(last.scale).toBeCloseTo(1 - SCALE_STEP_DOWN, 10)
    expect(s.scale).toBeCloseTo(0.88, 10)
    expect(last.pixelRatio).toBeCloseTo(2 * 0.88, 10)
  })

  it('계속 느리면 계단식으로 MIN_SCALE까지 내려가고 거기서 멈춘다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    feed(s, 4000, 45)
    expect(s.scale).toBe(MIN_SCALE)
    // 하한을 뚫지 않는다
    expect(s.pixelRatio).toBeGreaterThanOrEqual(MIN_PIXEL_RATIO)
    expect(s.pixelRatio).toBeCloseTo(2 * MIN_SCALE, 10)
  })
})

describe('명세 3 — 승격', () => {
  it('EMA < UP_MS가 UP_FRAMES 연속이면 승격한다', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: 0.7 })
    warmup(s)
    const steps = feed(s, UP_FRAMES, 8) // 125fps — 픽셀을 더 그릴 여유
    expect(changedCount(steps)).toBe(1)
    const last = steps[UP_FRAMES - 1]!
    expect(last.changed).toBe(true)
    expect(last.scale).toBeCloseTo(0.7 + SCALE_STEP_UP, 10)
  })

  it('UP_FRAMES 직전까지는 절대 올리지 않는다(성급한 승격 금지)', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: 0.7 })
    warmup(s)
    expect(changedCount(feed(s, UP_FRAMES - 1, 8))).toBe(0)
    expect(s.scale).toBe(0.7)
  })

  it('충분히 빠르면 결국 MAX_SCALE까지 회복한다', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: MIN_SCALE })
    warmup(s)
    feed(s, 4000, 8)
    expect(s.scale).toBe(MAX_SCALE)
  })
})

describe('명세 4 — 데드밴드는 두 카운터를 모두 리셋한다', () => {
  it('강등 직전까지 갔어도 데드밴드를 한 번 지나면 처음부터 다시 센다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    // EMA=19ms(>DOWN_MS)로 강등 카운터를 20까지 쌓는다
    expect(changedCount(feed(s, 20, 19))).toBe(0)
    // 한 프레임만 빨라도 EMA가 18.45로 데드밴드에 들어온다 → 카운터 리셋
    const mid = s.update(13.5)
    expect(mid.changed).toBe(false)
    expect(s.avgFrameMs).toBeCloseTo(18.45, 10)
    expect(s.avgFrameMs).toBeLessThanOrEqual(DOWN_MS)
    expect(s.avgFrameMs).toBeGreaterThanOrEqual(UP_MS)
    // 리셋이 없었다면 10프레임 안에 강등됐을 것이다. 실제로는 30프레임이 다시 필요하다.
    const again = feed(s, DOWN_FRAMES, 19)
    expect(s.avgFrameMs).toBeGreaterThan(DOWN_MS)
    for (let i = 0; i < DOWN_FRAMES - 1; i++) expect(again[i]!.changed).toBe(false)
    expect(again[DOWN_FRAMES - 1]!.changed).toBe(true)
  })

  it('데드밴드 한가운데(16ms≈62fps)에 오래 머물면 아무 일도 일어나지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: 0.82 })
    warmup(s)
    expect(changedCount(feed(s, 3000, 16))).toBe(0)
    expect(s.scale).toBe(0.82)
  })
})

describe('명세 5 — 쿨다운', () => {
  it('강등 직후 COOLDOWN_FRAMES 동안은 카운터조차 올리지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    feed(s, DOWN_FRAMES, 30) // 첫 강등
    expect(s.scale).toBeCloseTo(0.88, 10)

    // 쿨다운(45) + 재판정(30) = 75프레임째에야 두 번째 강등이 온다.
    const after = feed(s, COOLDOWN_FRAMES + DOWN_FRAMES, 30)
    for (let i = 0; i < COOLDOWN_FRAMES + DOWN_FRAMES - 1; i++) {
      expect(after[i]!.changed).toBe(false)
    }
    expect(after[COOLDOWN_FRAMES + DOWN_FRAMES - 1]!.changed).toBe(true)
    expect(s.scale).toBeCloseTo(0.76, 10)
  })

  it('쿨다운은 승격 직후에도 걸린다', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: 0.7 })
    warmup(s)
    feed(s, UP_FRAMES, 8)
    expect(s.scale).toBeCloseTo(0.76, 10)
    const after = feed(s, COOLDOWN_FRAMES + UP_FRAMES, 8)
    for (let i = 0; i < COOLDOWN_FRAMES + UP_FRAMES - 1; i++) {
      expect(after[i]!.changed).toBe(false)
    }
    expect(after[COOLDOWN_FRAMES + UP_FRAMES - 1]!.changed).toBe(true)
  })
})

describe('명세 6·7 — starving과 경계에서의 changed', () => {
  it('MIN_SCALE에서도 느리면 starving이 뜨고 changed는 false다', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: MIN_SCALE })
    warmup(s)
    const steps = feed(s, DOWN_FRAMES, 40)
    const last = steps[DOWN_FRAMES - 1]!
    expect(last.starving).toBe(true)
    expect(last.changed).toBe(false) // 불필요한 setSize 금지
    expect(last.scale).toBe(MIN_SCALE)
    for (let i = 0; i < DOWN_FRAMES - 1; i++) expect(steps[i]!.starving).toBe(false)

    // 쿨다운을 걸지 않으므로 계속 느리면 DOWN_FRAMES마다 다시 신호를 준다
    const next = feed(s, DOWN_FRAMES, 40)
    expect(next[DOWN_FRAMES - 1]!.starving).toBe(true)
    expect(changedCount(next)).toBe(0)
  })

  it('MAX_SCALE에서 아무리 빨라도 changed·starving 모두 false다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    const steps = feed(s, UP_FRAMES * 3, 6)
    expect(changedCount(steps)).toBe(0)
    expect(steps.some((x) => x.starving)).toBe(false)
    expect(s.scale).toBe(MAX_SCALE)
  })

  it('스케일이 여유 있으면 starving은 뜨지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    expect(feed(s, 2000, 40).some((x) => x.starving && x.scale > MIN_SCALE)).toBe(false)
  })
})

describe('명세 8 — initialScale 정규화', () => {
  it('범위 밖·NaN·undefined를 안전값으로 접는다', () => {
    expect(createRenderScaler({ basePixelRatio: 2, initialScale: 0.1 }).scale).toBe(MIN_SCALE)
    expect(createRenderScaler({ basePixelRatio: 2, initialScale: -5 }).scale).toBe(MIN_SCALE)
    expect(createRenderScaler({ basePixelRatio: 2, initialScale: 5 }).scale).toBe(MAX_SCALE)
    expect(createRenderScaler({ basePixelRatio: 2, initialScale: NaN }).scale).toBe(MAX_SCALE)
    expect(createRenderScaler({ basePixelRatio: 2, initialScale: Infinity }).scale).toBe(MAX_SCALE)
    expect(createRenderScaler({ basePixelRatio: 2 }).scale).toBe(MAX_SCALE)
    expect(createRenderScaler({ basePixelRatio: 2, initialScale: 0.8 }).scale).toBe(0.8)
  })
})

describe('명세 9 — pixelRatio 계산', () => {
  it('basePixelRatio * scale을 [MIN_PIXEL_RATIO, basePixelRatio]로 클램프한다', () => {
    expect(createRenderScaler({ basePixelRatio: 2 }).pixelRatio).toBe(2)
    expect(createRenderScaler({ basePixelRatio: 2, initialScale: 0.7 }).pixelRatio).toBeCloseTo(
      1.4,
      10,
    )
    // DPR 1 장치가 MIN_SCALE까지 내려가도 하한 위에 있다
    expect(createRenderScaler({ basePixelRatio: 1, initialScale: MIN_SCALE }).pixelRatio).toBeCloseTo(
      0.62,
      10,
    )
    // 0.9 * 0.62 = 0.558 → 하한 0.6에서 멈춘다
    expect(
      createRenderScaler({ basePixelRatio: 0.9, initialScale: MIN_SCALE }).pixelRatio,
    ).toBeCloseTo(MIN_PIXEL_RATIO, 10)
  })

  it('병리적 basePixelRatio(0·음수·NaN·하한 미만)에서도 유한한 양수를 준다', () => {
    for (const base of [0, -3, NaN, Infinity, 0.3, 1e-9]) {
      for (const initialScale of [MAX_SCALE, MIN_SCALE]) {
        const s = createRenderScaler({ basePixelRatio: base, initialScale })
        expect(Number.isFinite(s.pixelRatio)).toBe(true)
        expect(s.pixelRatio).toBeGreaterThan(0)
        // 장치가 줄 수 있는 것보다 큰 픽셀비를 렌더러에 넘기지 않는다
        if (Number.isFinite(base) && base > 0) expect(s.pixelRatio).toBeLessThanOrEqual(base)
      }
    }
  })

  it('강등해도 update가 돌려주는 pixelRatio는 항상 유한·양수다', () => {
    const s = createRenderScaler({ basePixelRatio: 0.3 })
    warmup(s)
    for (const step of feed(s, 500, 60)) {
      expect(Number.isFinite(step.pixelRatio)).toBe(true)
      expect(step.pixelRatio).toBeGreaterThan(0)
    }
  })
})

describe('명세 10 — 비정상 dtMs 방어', () => {
  it('NaN·Infinity·음수는 EMA를 오염시키지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    s.update(16)
    expect(s.avgFrameMs).toBe(16)
    for (const bad of [NaN, Infinity, -Infinity, -5, -0.001]) {
      s.update(bad)
      expect(s.avgFrameMs).toBe(16)
    }
    expect(s.scale).toBe(1)
  })

  it('유효 표본이 하나도 없으면 판정 자체를 하지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    const steps = feed(s, 500, NaN)
    expect(changedCount(steps)).toBe(0)
    expect(steps.some((x) => x.starving)).toBe(false)
    expect(s.avgFrameMs).toBe(0)
  })

  it('탭 복귀 같은 거대 dtMs는 100ms로 포화해 한 방에 폭주시키지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2 })
    warmup(s)
    s.update(16)
    s.update(5_000_000)
    expect(s.avgFrameMs).toBeCloseTo(16 + 0.1 * (100 - 16), 10)
    expect(s.avgFrameMs).toBeLessThanOrEqual(100)
    // 한 프레임 히치로는 스케일이 절대 안 바뀐다(연속 30프레임이 필요하다)
    expect(s.scale).toBe(1)
  })
})

describe('진동 방지 회귀', () => {
  it('임계 사이를 왕복하는 2000프레임에도 스케일 변경이 0회다', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: 0.88 })
    warmup(s)
    let changes = 0
    for (let i = 0; i < 2000; i++) {
      // UP_MS 아래(12ms)와 DOWN_MS 위(20ms)를 한 프레임씩 번갈아 — EMA는 데드밴드 중앙에 앉는다
      if (s.update(i % 2 === 0 ? 12 : 20).changed) changes++
    }
    expect(changes).toBe(0)
    expect(s.scale).toBe(0.88)
  })

  it('불규칙한 히치가 섞인 60fps 구간에서도 스케일이 흔들리지 않는다', () => {
    const s = createRenderScaler({ basePixelRatio: 2, initialScale: 0.94 })
    warmup(s)
    let changes = 0
    for (let i = 0; i < 2000; i++) {
      // 40프레임마다 한 번씩 큰 히치(80ms)가 끼는 안정적인 60fps.
      // 히치 직후 EMA가 21.95ms로 튀지만 7프레임이면 데드밴드로 돌아와 카운터가 리셋된다.
      if (s.update(i % 40 === 20 ? 80 : 15.5).changed) changes++
    }
    expect(changes).toBe(0)
    expect(s.scale).toBe(0.94)
  })

  it('결정론적이다 — 같은 dtMs 수열이면 같은 궤적', () => {
    const run = () => {
      const s = createRenderScaler({ basePixelRatio: 2 })
      const trace: number[] = []
      for (let i = 0; i < 1200; i++) trace.push(s.update(i % 7 === 0 ? 34 : 21).scale)
      return trace
    }
    expect(run()).toEqual(run())
  })
})

describe('저장 헬퍼', () => {
  /** localStorage의 최소 계약만 흉내 낸 스텁(node 환경이라 실제 Storage가 없다). */
  function stubStorage(initial?: string) {
    const box: { value: string | null } = { value: initial ?? null }
    return {
      box,
      getItem(key: string) {
        return key === SCALE_STORAGE_KEY ? box.value : null
      },
      setItem(key: string, value: string) {
        if (key === SCALE_STORAGE_KEY) box.value = value
      },
    }
  }

  it('키가 고정되어 있다', () => {
    expect(SCALE_STORAGE_KEY).toBe('rematch-3d-scale')
  })

  it('정상 값을 읽고, 소수 둘째 자리로 기록한다', () => {
    const st = stubStorage()
    writeStoredScale(st, 0.76)
    expect(st.box.value).toBe('0.76')
    expect(readStoredScale(st)).toBe(0.76)

    writeStoredScale(st, 0.888888)
    expect(st.box.value).toBe('0.89')
    expect(readStoredScale(st)).toBe(0.89)
  })

  it('기록 값도 [MIN_SCALE, MAX_SCALE]로 접는다', () => {
    const st = stubStorage()
    writeStoredScale(st, 12)
    expect(st.box.value).toBe('1.00')
    expect(readStoredScale(st)).toBe(1)
    writeStoredScale(st, 0.01)
    expect(st.box.value).toBe('0.62')
    expect(readStoredScale(st)).toBe(MIN_SCALE)
    writeStoredScale(st, NaN)
    expect(st.box.value).toBe('1.00')
  })

  it('없거나·비었거나·파싱 실패·범위 밖이면 1로 폴백한다', () => {
    expect(readStoredScale(stubStorage())).toBe(1)
    expect(readStoredScale(stubStorage(''))).toBe(1)
    expect(readStoredScale(stubStorage('  '))).toBe(1)
    expect(readStoredScale(stubStorage('nope'))).toBe(1)
    expect(readStoredScale(stubStorage('0.1'))).toBe(1)
    expect(readStoredScale(stubStorage('3'))).toBe(1)
    expect(readStoredScale(stubStorage('-0.8'))).toBe(1)
    expect(readStoredScale(stubStorage('NaN'))).toBe(1)
    expect(readStoredScale(stubStorage('Infinity'))).toBe(1)
  })

  it('storage가 null·undefined거나 throw해도 안전하다', () => {
    expect(readStoredScale(null)).toBe(1)
    expect(readStoredScale(undefined)).toBe(1)
    expect(() => writeStoredScale(null, 0.7)).not.toThrow()
    expect(() => writeStoredScale(undefined, 0.7)).not.toThrow()

    // 사파리 프라이빗 모드처럼 접근 자체가 throw하는 환경
    const hostile = {
      getItem(): string {
        throw new Error('SecurityError')
      },
      setItem(): void {
        throw new Error('QuotaExceededError')
      },
    }
    expect(readStoredScale(hostile)).toBe(1)
    expect(() => writeStoredScale(hostile, 0.7)).not.toThrow()
  })

  it('기록한 값을 그대로 initialScale로 되먹일 수 있다(세션 간 왕복)', () => {
    const st = stubStorage()
    const first = createRenderScaler({ basePixelRatio: 2 })
    warmup(first)
    feed(first, 4000, 45)
    writeStoredScale(st, first.scale)

    const second = createRenderScaler({ basePixelRatio: 2, initialScale: readStoredScale(st) })
    expect(second.scale).toBe(first.scale)
    // 두 번째 세션은 워밍업 없이 이미 맞는 해상도에서 출발한다
    expect(second.pixelRatio).toBeCloseTo(first.pixelRatio, 10)
  })
})
