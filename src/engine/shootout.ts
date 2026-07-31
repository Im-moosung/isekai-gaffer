// src/engine/shootout.ts
import { createRng } from './rng'
import type { Player } from './types'

export interface ShootoutKicker { player: Player; direction: 'left' | 'center' | 'right' }
export interface ShootoutKick { side: 'home' | 'away'; playerId: string; scored: boolean; gkDove: 'left' | 'center' | 'right' }
export interface ShootoutResult { homeScore: number; awayScore: number; winner: 'home' | 'away'; kicks: ShootoutKick[] }

const DIRS = ['left', 'center', 'right'] as const

// ── 성공률 모델 (2026-07-31 재보정) ────────────────────────────────
// 이전 모델(base 0.62 + (pk-70)/200, 방향 적중 시 −saving×0.6)은 실측 성공률이 **40.3%**였다
// (킥 20,488발 · 5개 상대 · 400시드). 실제 월드컵 승부차기는 **70~72%**다 — 통산 집계에서
// 성공 200/279발(≈72%) 수준이고, 인플레이 PK(약 78%)보다 낮은 것이 승부차기의 특징이다.
// 40%는 "월드컵 승부차기"가 아니라 "동네 축구"의 숫자이고, 관측 로그에서 손흥민(PK 85)·
// 이강인(80)·황인범(70)이 연달아 실패하는 화면을 만들었다.
//
// 세 상수의 역할을 분리했다.
//  BASE      — PK 70(평범한 키커)의 성공률. 실축의 대부분은 GK와 무관한 자책(골대·허공)이다.
//  PK_SLOPE  — 키커 성향 1점당 성공률. ±15점(55~85) 구간에서 ±5%p — 관측 가능하되
//              "손흥민이면 무조건 넣는다"가 되지 않는 폭이다.
//  DIVE_COST — GK가 방향을 맞혔을 때의 감점. GK는 1/3 확률로 맞히고, **맞혀도 잘 찬 공은
//              막지 못한다.** saving 85인 GK면 −0.213이라 방향이 맞아도 3분의 2 이상 들어간다
//              (실제로도 방향을 맞힌 GK의 세이브율은 30% 안팎이다).
// 기대 성공률 = BASE − (1/3)·DIVE_COST·saving/100. 대회 GK 평균 saving≈85에서 0.81−0.071≈0.74,
// 서든데스의 하위 키커까지 섞인 **실측 전체 성공률은 71.4%**(킥 20,844발 · 5개 상대 · 400시드).
const BASE = 0.81
const PK_SLOPE = 1 / 300
const DIVE_COST = 0.25

export function simulateShootout(opts: {
  seed: number; homeKickers: ShootoutKicker[]; awayKickers: ShootoutKicker[]; homeGk: Player; awayGk: Player
}): ShootoutResult {
  // XOR 상수: 매치 세그먼트의 분 파생 RNG(seed*10007+minute) 스트림과 승부차기 스트림 분리용
  const rng = createRng(opts.seed ^ 0x50c1a1)
  const kicks: ShootoutKick[] = []
  let hs = 0, as = 0
  const take = (side: 'home' | 'away', kicker: ShootoutKicker, gk: Player) => {
    const gkDove = rng.pick([...DIRS])
    const pk = kicker.player.penalty
    const saving = gk.gkStats?.saving ?? 20
    let scoreP = BASE + (pk - 70) * PK_SLOPE
    if (gkDove === kicker.direction) scoreP -= (saving / 100) * DIVE_COST
    const scored = rng.chance(Math.max(0.20, Math.min(0.95, scoreP)))
    kicks.push({ side, playerId: kicker.player.id, scored, gkDove })
    if (scored) side === 'home' ? hs++ : as++
  }
  // 정규 5라운드 + 조기 확정
  for (let round = 0; round < 5; round++) {
    take('home', opts.homeKickers[round % opts.homeKickers.length], opts.awayGk)
    if (decided(hs, as, round, 'afterHome')) break
    take('away', opts.awayKickers[round % opts.awayKickers.length], opts.homeGk)
    if (decided(hs, as, round, 'afterAway')) break
  }
  // 서든데스
  let i = 5
  while (hs === as) {
    take('home', opts.homeKickers[i % opts.homeKickers.length], opts.awayGk)
    take('away', opts.awayKickers[i % opts.awayKickers.length], opts.homeGk)
    i++
  }
  return { homeScore: hs, awayScore: as, winner: hs > as ? 'home' : 'away', kicks }
}

function decided(hs: number, as: number, round: number, phase: 'afterHome' | 'afterAway'): boolean {
  const remHome = 4 - round, remAway = phase === 'afterHome' ? 5 - round : 4 - round
  return hs > as + remAway || as > hs + remHome
}
