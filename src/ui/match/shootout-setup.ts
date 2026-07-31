// 승부차기 키커/파라미터 조립 순수 로직 (컴포넌트와 분리 — lineup/swap.ts 패턴).
import type { Team, Player, LineupSlot } from '../../engine/types'
import type { ShootoutKicker } from '../../engine/shootout'

export type Dir = 'left' | 'center' | 'right'
export const DIRS: readonly Dir[] = ['left', 'center', 'right']
export const N_KICKERS = 5

/** 필드(비GK) 선수. */
export function fieldPlayers(team: Team): Player[] {
  return team.squad.filter(p => p.position !== 'GK')
}

/**
 * 종료 휘슬 시점에 그라운드에 있던 선수 id.
 *
 * 규정 근거: 승부차기는 **경기 종료 시점에 필드에 있던 선수만** 찰 수 있다(IFAB 경기규칙 10.3).
 * 교체로 나간 선수·벤치에 앉아 있던 선수·퇴장당한 선수는 자격이 없다.
 * 엔진의 `tactics.lineup`은 교체가 반영된 현재 XI이므로 여기서 퇴장자만 덜어내면 된다.
 */
export function onPitchIds(lineup: readonly LineupSlot[], sentOff: readonly string[] = []): string[] {
  return lineup.map(l => l.playerId).filter(id => !sentOff.includes(id))
}

/**
 * 키커 후보. 기본은 자격 있는 필드 선수이며, 퇴장이 겹쳐 5인이 안 되면 GK까지 후보에 넣는다
 * (규정상 GK도 킥을 찰 수 있다 — 평소엔 제외하지만 인원이 모자라면 자격이 우선이다).
 * `eligibleIds` 미지정은 자격 정보를 모르는 호출부(데모·테스트)이므로 전 필드 선수를 후보로 둔다.
 */
export function kickerCandidates(team: Team, eligibleIds?: readonly string[]): Player[] {
  if (!eligibleIds) return fieldPlayers(team)
  const on = new Set(eligibleIds)
  const outfield = team.squad.filter(p => p.position !== 'GK' && on.has(p.id))
  if (outfield.length >= N_KICKERS) return outfield
  const gks = team.squad.filter(p => p.position === 'GK' && on.has(p.id))
  return [...outfield, ...gks]
}

/** penalty 상위 n인 id(동점은 id로 안정 정렬). 승부차기 키커 기본값. */
export function topPenaltyIds(team: Team, n = N_KICKERS, eligibleIds?: readonly string[]): string[] {
  return [...kickerCandidates(team, eligibleIds)]
    .sort((a, b) => b.penalty - a.penalty || a.id.localeCompare(b.id))
    .slice(0, n)
    .map(p => p.id)
}

/** saving 상위 GK. 어웨이/홈 공통. */
export function bestGk(team: Team): Player {
  const gks = team.squad.filter(p => p.position === 'GK')
  return [...gks].sort((a, b) => (b.gkStats?.saving ?? 0) - (a.gkStats?.saving ?? 0))[0]
}

/** 어웨이 키커: 자격 있는 penalty 상위 5인, 방향은 결정론적으로 배분(좌·중·우 순환). */
export function autoAwayKickers(team: Team, eligibleIds?: readonly string[]): ShootoutKicker[] {
  return topPenaltyIds(team, N_KICKERS, eligibleIds).map((id, i) => ({
    player: team.squad.find(p => p.id === id)!,
    direction: DIRS[i % 3],
  }))
}

/** UI 선택(키커 순서 id + 각자 방향)을 simulateShootout 파라미터로 조립한다. */
export function buildShootoutParams(opts: {
  home: Team; away: Team; seed: number; kickerIds: string[]; dirs: Dir[]
  awayEligibleIds?: readonly string[]
}) {
  const homeKickers: ShootoutKicker[] = opts.kickerIds.map((id, i) => ({
    player: opts.home.squad.find(p => p.id === id)!,
    direction: opts.dirs[i] ?? 'center',
  }))
  return {
    seed: opts.seed,
    homeKickers,
    awayKickers: autoAwayKickers(opts.away, opts.awayEligibleIds),
    homeGk: bestGk(opts.home),
    awayGk: bestGk(opts.away),
  }
}
