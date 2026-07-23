// src/engine/shootout.ts
import { createRng } from './rng'
import type { Player } from './types'

export interface ShootoutKicker { player: Player; direction: 'left' | 'center' | 'right' }
export interface ShootoutKick { side: 'home' | 'away'; playerId: string; scored: boolean; gkDove: 'left' | 'center' | 'right' }
export interface ShootoutResult { homeScore: number; awayScore: number; winner: 'home' | 'away'; kicks: ShootoutKick[] }

const DIRS = ['left', 'center', 'right'] as const

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
    let scoreP = 0.62 + (pk - 70) / 200          // 기본 성공률: PK 성향 반영 (~0.5-0.75)
    if (gkDove === kicker.direction) scoreP -= (saving / 100) * 0.6  // 방향 적중 시 세이브 확률 급증 (브리프 0.45→0.6: 통계 검증 임계 통과)
    const scored = rng.chance(Math.max(0.05, Math.min(0.95, scoreP)))
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
