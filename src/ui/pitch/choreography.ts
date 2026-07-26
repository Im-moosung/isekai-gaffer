// src/ui/pitch/choreography.ts
// 하이라이트 안무(순수) — 이벤트 한 건을 "공·선수가 어떻게 움직였나"의 키프레임
// 시퀀스로 번역한다. PitchView가 이 좌표를 CSS transition으로 재생한다.
//
// 설계 원칙(FM 교훈: 데드타임 금지):
//  - 첫 스텝(t=0)부터 공이 이미 공격 지역에 있다(긴 빌드업 없음).
//  - 마지막 스텝 t ≤ 0.8 → dwell의 80% 안에 결과가 나오고, 남은 20%는 여운.
//  - 좌표는 home-프레임(좌→우 공격)으로 설계 후 away면 x를 미러(100-x)한다.
//  - 랜덤·시간 의존 없음. 변형은 event.minute 해시로만(결정론).
import type { MatchEvent, SideState } from '../../engine/types'

/** 안무 키프레임 한 스텝. 좌표는 slotCoords와 동일한 0~100 피치 좌표. */
export interface ChoreoStep {
  /** dwell 내 상대 시각(0=시작, 1=dwell 끝). 첫 스텝 0, 마지막 ≤ 0.8. */
  t: number
  /** 공 위치(0~100). */
  ball: { x: number; y: number }
  /** 이 스텝에서 함께 달리는 선수 도트(공격 팀 2~3명). */
  movers: { playerId: string; x: number; y: number }[]
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v))

/** home-프레임 레인 y — 변형별 중앙/좌/우 침투. */
const LANE_Y = [50, 30, 70]

/** 공격 팀 라인업에서 가장 공격적인 3명(있으면 득점자/슈터 우선)의 playerId. */
function pickMovers(side: SideState, primary?: string): string[] {
  const ids = side.tactics.lineup.map(s => s.playerId)
  const chosen: string[] = []
  if (primary && ids.includes(primary)) chosen.push(primary)
  for (let i = ids.length - 1; i >= 0 && chosen.length < 3; i--) {
    if (!chosen.includes(ids[i])) chosen.push(ids[i])
  }
  return chosen
}

/** home-프레임 공 위치를 기준으로 무버 도트를 배치(공 뒤·양옆으로 퍼짐). */
function moversAt(ids: string[], bx: number, by: number): ChoreoStep['movers'] {
  const yoff = [0, -18, 18]
  return ids.map((playerId, i) => ({
    playerId,
    x: clamp(bx - (3 + i * 7)),
    y: clamp(by + (yoff[i] ?? 0)),
  }))
}

/** home-프레임 볼 경로 → 스텝 배열(무버는 각 스텝 공 위치 기준으로 채움). */
function stepsFromBall(
  path: { t: number; x: number; y: number }[],
  ids: string[],
): ChoreoStep[] {
  return path.map(p => ({ t: p.t, ball: { x: p.x, y: p.y }, movers: moversAt(ids, p.x, p.y) }))
}

/**
 * 이벤트 → 안무 키프레임 시퀀스(2~4스텝). 안무가 없는 타입은 빈 배열.
 *
 * 안무가 있는 타입은 playback.DRAMA_PRIORITY(주인공 선택자의 후보 집합)와 정확히
 * 일치해야 한다 — 화면이 그릴 수 없는 이벤트를 음성이 주인공으로 고르면 안 된다.
 * 이 일치는 choreography.test.ts가 양방향으로 고정한다.
 *
 * @param event      연출할 이벤트(goal/shot/chance/save/miss/corner/foul 등).
 * @param homeState  홈 팀 상태(공격 방향·라인업 판정).
 * @param awayState  어웨이 팀 상태.
 */
export function buildSequence(event: MatchEvent, homeState: SideState, awayState: SideState): ChoreoStep[] {
  const isHome = event.teamId === homeState.team.id
  const attacking = isHome ? homeState : awayState
  const ids = pickMovers(attacking, event.playerId)
  const variant = ((event.minute % 3) + 3) % 3
  const laneY = LANE_Y[variant]

  // home-프레임(좌→우 공격) 볼 경로.
  let path: { t: number; x: number; y: number }[]
  switch (event.type) {
    case 'goal': {
      const netY = [46, 54, 50][variant]
      path = [
        { t: 0, x: 55, y: laneY },
        { t: 0.3, x: 74, y: laneY },
        { t: 0.55, x: 88, y: (laneY + 50) / 2 },
        { t: 0.78, x: 99, y: netY },
      ]
      break
    }
    case 'miss': {
      const wideY = variant === 1 ? 80 : 20 // 골문 밖(위/아래)
      path = [
        { t: 0, x: 60, y: laneY },
        { t: 0.4, x: 83, y: laneY },
        { t: 0.75, x: 99, y: wideY },
      ]
      break
    }
    case 'save': {
      const gkY = [50, 44, 56][variant]
      path = [
        { t: 0, x: 58, y: laneY },
        { t: 0.4, x: 82, y: laneY },
        { t: 0.72, x: 93, y: gkY }, // GK 위치에서 멈춤
      ]
      break
    }
    case 'corner': {
      const cornerY = event.minute % 2 === 0 ? 6 : 94
      path = [
        { t: 0, x: 99, y: cornerY }, // 코너 깃발
        { t: 0.42, x: 86, y: 50 }, // 박스로 크로스
        { t: 0.75, x: 91, y: cornerY > 50 ? 58 : 42 }, // 문전 경합
      ]
      break
    }
    case 'foul':
    case 'yellow':
    case 'red': {
      path = [
        { t: 0, x: 50, y: laneY }, // 충돌 지점 근사
        { t: 0.5, x: 52, y: laneY },
      ]
      break
    }
    case 'shot': {
      // 슛 — 골문 정면으로 때렸으나 결과(골/세이브/미스)가 따로 없는 장면.
      // 블록·굴절로 골문 앞에서 멈추는 궤적(save보다 얕고, miss처럼 벗어나지 않는다).
      const blockY = [50, 46, 54][variant]
      path = [
        { t: 0, x: 58, y: laneY },
        { t: 0.4, x: 82, y: laneY },
        { t: 0.72, x: 95, y: blockY },
      ]
      break
    }
    case 'chance': {
      // 찬스 — 마무리 없이 박스 안까지 들어간 침투. 슛 계열보다 짧게 끊어
      // "기회를 만들었다"까지만 보여준다(골문에 닿지 않는다).
      path = [
        { t: 0, x: 55, y: laneY },
        { t: 0.38, x: 72, y: laneY },
        { t: 0.7, x: 84, y: (laneY + 50) / 2 },
      ]
      break
    }
    default: {
      // 안무가 없는 타입(kickoff·sub·halftime·fulltime) — 빈 시퀀스.
      // ★ 예전엔 default가 슛 궤적을 돌려줬다. 그 탓에 교체·하프타임이 주인공으로
      //   뽑히면 "말은 교체인데 화면은 슛"이 됐다. 빈 배열이면 렌더러가 안무를
      //   재생하지 않는다(PitchView·stage·movement 모두 length===0을 처리한다).
      path = []
    }
  }

  const stepsHome = stepsFromBall(path, ids)
  // away면 x 미러(100-x). y는 불변.
  const fx = (x: number) => (isHome ? x : 100 - x)
  return stepsHome.map(s => ({
    t: s.t,
    ball: { x: clamp(fx(s.ball.x)), y: clamp(s.ball.y) },
    movers: s.movers.map(m => ({ playerId: m.playerId, x: clamp(fx(m.x)), y: clamp(m.y) })),
  }))
}
