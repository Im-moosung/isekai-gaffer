// src/ui/pitch/cast.ts
// "이 시퀀스를 재생하는 팀은 어느 쪽인가"를 **시퀀스 자체에서** 판정한다.
//
// 왜 prop을 못 믿는가: 호출자(MatchScreen)는 `event.teamId`로 side를 정하는데,
// 엔진의 `save`만은 **막은 팀(수비)**의 사건이다(simulate.ts L649). 그래서 세이브
// 하이라이트에서 side가 뒤집히고, 무버 playerId를 반대 팀 라인업에서 찾게 되어
// 아무 도트도 움직이지 않았다(실측: save 장면에서 이름표 0개, 이동 도트 0개).
//
// choreography.attackingSideOf는 **이벤트**로 같은 판정을 하지만 이벤트가 필요하고,
// 무사건 분의 점유 흐름(flow.ts)에는 대응하는 이벤트가 없다. 무버·캐리어의 playerId가
// 어느 라인업에 있는지 보는 쪽이 두 경우 모두에서 정확하다.
import type { MatchState } from '../../engine/types'
import type { ChoreoStep } from './choreography'

/**
 * 시퀀스의 주인 팀. 첫 스텝의 무버·캐리어 id가 속한 라인업으로 판정한다.
 * 판정할 단서가 없으면(무버도 캐리어도 없는 시퀀스) fallback을 그대로 돌려준다.
 */
export function sequenceOwner(
  state: MatchState,
  sequence: ChoreoStep[] | undefined,
  fallback: 'home' | 'away',
): 'home' | 'away' {
  if (!sequence || sequence.length === 0) return fallback
  const ids: string[] = []
  for (const step of sequence) {
    for (const m of step.movers) ids.push(m.playerId)
    if (step.carrier) ids.push(step.carrier)
    if (ids.length > 0) break
  }
  if (ids.length === 0) return fallback
  const inHome = new Set(state.home.tactics.lineup.map(s => s.playerId))
  const inAway = new Set(state.away.tactics.lineup.map(s => s.playerId))
  for (const id of ids) {
    if (inHome.has(id)) return 'home'
    if (inAway.has(id)) return 'away'
  }
  return fallback
}
