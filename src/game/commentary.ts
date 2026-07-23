// src/game/commentary.ts
// 이벤트 → 한국어 해설. 결정론 템플릿 (Math.random 금지, 해시로 변형 선택).
// 순수 함수 — React/스토어 import 금지. 모든 문장은 사실 서술형 (스펙 §7.1 세이프가드).
import type { MatchEvent, MatchEventType, Team } from '../engine/types'

/** 이벤트 주체 팀명(name.ko)과 선수명(name.ko, 미발견 시 팀명 대체)을 구한다. */
function resolve(e: MatchEvent, home: Team, away: Team): { team: string; player: string } {
  const acting = e.teamId === home.id ? home : away
  const team = acting.name.ko
  const player = e.playerId
    ? (acting.squad.find(p => p.id === e.playerId)?.name.ko ?? team)
    : team
  return { team, player }
}

type Vars = { m: number; team: string; player: string }
type Tpl = (v: Vars) => string

// 타입별 변형 2~3개. 아쉬운 장면도 중립 서술, 방송 긴장감은 허용.
const TEMPLATES: Record<MatchEventType, Tpl[]> = {
  kickoff: [
    ({ m }) => `${m}' 경기가 시작됩니다.`,
    ({ m, team }) => `${m}' ${team}의 킥오프로 경기가 열립니다.`,
  ],
  chance: [
    ({ m, player }) => `${m}' ${player}, 좋은 기회를 만들어냅니다.`,
    ({ m, team }) => `${m}' ${team}가 위험한 순간을 연출합니다!`,
    ({ m, player }) => `${m}' ${player}에게 찬스가 열립니다.`,
  ],
  shot: [
    ({ m, player }) => `${m}' ${player}, 슛을 시도합니다.`,
    ({ m, player }) => `${m}' ${player}의 슈팅이 골문을 향합니다!`,
    ({ m, team }) => `${m}' ${team}, 슛으로 연결합니다.`,
  ],
  goal: [
    ({ m, player }) => `${m}' ${player}, 골망을 흔듭니다!`,
    ({ m, player }) => `${m}' ${player}의 골! 스코어가 움직입니다!`,
    ({ m, team, player }) => `${m}' ${team}의 ${player}, 골을 성공시킵니다!`,
  ],
  save: [
    ({ m, player }) => `${m}' ${player}, 선방으로 막아냅니다!`,
    ({ m, player }) => `${m}' ${player}의 세이브가 나옵니다.`,
    ({ m, team }) => `${m}' ${team} 골키퍼가 슛을 걷어냅니다.`,
  ],
  miss: [
    ({ m, player }) => `${m}' ${player}의 슛, 골문을 빗나갑니다.`,
    ({ m, player }) => `${m}' ${player}, 마무리로 이어지지 못합니다.`,
    ({ m, team }) => `${m}' ${team}, 이번 기회를 살리지 못합니다.`,
  ],
  foul: [
    ({ m, player }) => `${m}' ${player}의 파울로 흐름이 끊깁니다.`,
    ({ m, player }) => `${m}' ${player}, 파울이 선언됩니다.`,
    ({ m, team }) => `${m}' ${team} 진영에서 반칙이 나옵니다.`,
  ],
  yellow: [
    ({ m, player }) => `${m}' ${player}, 옐로카드를 받습니다.`,
    ({ m, player }) => `${m}' 주심이 ${player}에게 경고를 줍니다.`,
  ],
  red: [
    ({ m, player }) => `${m}' ${player}, 레드카드로 퇴장입니다.`,
    ({ m, player }) => `${m}' 주심이 ${player}에게 퇴장을 명합니다.`,
  ],
  corner: [
    ({ m, team }) => `${m}' ${team}의 코너킥 기회입니다.`,
    ({ m, player }) => `${m}' ${player}, 코너킥을 준비합니다.`,
    ({ m, team }) => `${m}' ${team}, 코너킥을 얻어냅니다.`,
  ],
  sub: [
    ({ m, player }) => `${m}' ${player}, 교체로 그라운드에 들어섭니다.`,
    ({ m, team }) => `${m}' ${team}가 선수 교체를 단행합니다.`,
  ],
  halftime: [
    ({ m }) => `${m}' 전반전이 종료됩니다.`,
    ({ m }) => `${m}' 하프타임을 알리는 휘슬입니다.`,
  ],
  fulltime: [
    ({ m }) => `${m}' 경기가 종료됩니다.`,
    ({ m }) => `${m}' 종료 휘슬이 울립니다.`,
  ],
}

/**
 * 이벤트당 한 줄 해설. 같은 이벤트 = 같은 문장.
 * 변형 선택 시드: (minute * 31 + type.length) 해시.
 */
export function commentate(e: MatchEvent, home: Team, away: Team): string {
  const variants = TEMPLATES[e.type]
  const idx = (e.minute * 31 + e.type.length) % variants.length
  const { team, player } = resolve(e, home, away)
  return variants[idx]({ m: e.minute, team, player })
}
