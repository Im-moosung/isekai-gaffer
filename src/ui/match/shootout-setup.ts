// 승부차기 키커/파라미터 조립 순수 로직 (컴포넌트와 분리 — lineup/swap.ts 패턴).
import type { Team, Player } from '../../engine/types'
import type { ShootoutKicker } from '../../engine/shootout'

export type Dir = 'left' | 'center' | 'right'
export const DIRS: readonly Dir[] = ['left', 'center', 'right']
export const N_KICKERS = 5

/** 필드(비GK) 선수. */
export function fieldPlayers(team: Team): Player[] {
  return team.squad.filter(p => p.position !== 'GK')
}

/** penalty 스탯 상위 n인 id(동점은 id로 안정 정렬). 승부차기 키커 기본값. */
export function topPenaltyIds(team: Team, n = N_KICKERS): string[] {
  return [...fieldPlayers(team)]
    .sort((a, b) => b.penalty - a.penalty || a.id.localeCompare(b.id))
    .slice(0, n)
    .map(p => p.id)
}

/** saving 상위 GK. 어웨이/홈 공통. */
export function bestGk(team: Team): Player {
  const gks = team.squad.filter(p => p.position === 'GK')
  return [...gks].sort((a, b) => (b.gkStats?.saving ?? 0) - (a.gkStats?.saving ?? 0))[0]
}

/** 어웨이 키커: penalty 상위 5인, 방향은 결정론적으로 배분(좌·중·우 순환). */
export function autoAwayKickers(team: Team): ShootoutKicker[] {
  return topPenaltyIds(team).map((id, i) => ({
    player: team.squad.find(p => p.id === id)!,
    direction: DIRS[i % 3],
  }))
}

/** UI 선택(키커 순서 id + 각자 방향)을 simulateShootout 파라미터로 조립한다. */
export function buildShootoutParams(opts: {
  home: Team; away: Team; seed: number; kickerIds: string[]; dirs: Dir[]
}) {
  const homeKickers: ShootoutKicker[] = opts.kickerIds.map((id, i) => ({
    player: opts.home.squad.find(p => p.id === id)!,
    direction: opts.dirs[i] ?? 'center',
  }))
  return {
    seed: opts.seed,
    homeKickers,
    awayKickers: autoAwayKickers(opts.away),
    homeGk: bestGk(opts.home),
    awayGk: bestGk(opts.away),
  }
}
