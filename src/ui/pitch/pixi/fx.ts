// src/ui/pitch/pixi/fx.ts
// 골 파티클 버스트의 "순수 시뮬레이션" — pixi.js를 import하지 않는다(그리기는 PixiPitch).
// Math.random 금지(Phase 4A 결정론 원칙): 스폰 각도·속도는 인덱스 기반 결정론 분포.
// 좌표·속도 단위는 월드(105×68m) 기준. PixiPitch가 이 상태를 매 프레임 step 후 그린다.

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  /** 남은 수명(초). 0 이하가 되면 소멸. */
  life: number
  /** 총 수명(초) — alpha = life/maxLife 페이드에 사용. */
  maxLife: number
  /** 반지름(월드 단위). */
  size: number
  /** 0xRRGGBB. */
  color: number
}

export interface BurstOptions {
  /** 파티클 개수(기본 44 — 브리프 "40+개"). */
  count?: number
  /** 초기 속도 크기(월드/초). */
  speed?: number
  /** 수명(초). */
  life?: number
  /** 초기 상향 편향(폭죽처럼 위로 솟구침 — 월드 y는 위가 작음 → 음수). */
  upward?: number
}

/**
 * 골 파티클 버스트 생성(결정론). 원점에서 방사형으로 퍼지며 위로 솟구친다.
 * 각도·속도·크기·수명 변형은 인덱스 해시로만 결정(랜덤 없음).
 * @param ox 원점 x(월드) @param oy 원점 y(월드) @param color 0xRRGGBB
 */
export function spawnBurst(ox: number, oy: number, color: number, opts: BurstOptions = {}): Particle[] {
  const count = opts.count ?? 44
  const speed = opts.speed ?? 46
  const life = opts.life ?? 1.1
  const upward = opts.upward ?? 24
  const out: Particle[] = []
  for (let i = 0; i < count; i++) {
    // 방사 각도(전 방향 균등 + 소량 편차로 뭉침 방지).
    const ang = (i / count) * Math.PI * 2 + ((i * 2.399963) % (Math.PI * 2)) * 0.12
    // 인덱스 해시로 속도·크기·수명 변형(결정론).
    const sv = 0.55 + ((i * 37) % 45) / 100 // 0.55~1.0
    const sp = speed * sv
    const lv = 0.7 + ((i * 53) % 60) / 100 // 0.7~1.3
    out.push({
      x: ox,
      y: oy,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp - upward, // 위로 솟구치는 초기 편향
      life: life * lv,
      maxLife: life * lv,
      size: 0.9 + ((i * 13) % 8) / 6, // 0.9~2.2 월드 단위
      color,
    })
  }
  return out
}

/**
 * 파티클 한 프레임 진행(중력·이동·수명 감소). 소멸한 파티클을 제외한 배열을 반환한다.
 * @param ps      파티클 배열(내부적으로 mutate)
 * @param dt      경과 시간(초)
 * @param gravity 중력 가속(월드/초², 아래 방향 = +y)
 */
export function stepParticles(ps: Particle[], dt: number, gravity = 62): Particle[] {
  const alive: Particle[] = []
  for (const p of ps) {
    p.vy += gravity * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.life -= dt
    if (p.life > 0) alive.push(p)
  }
  return alive
}

/** 파티클 알파(수명 비율, 0~1). */
export function particleAlpha(p: Particle): number {
  return Math.max(0, Math.min(1, p.life / p.maxLife))
}
