// src/game/coach.ts
// 코치 회의 (멀티 코치) — 순수 로직.
// 브레이크·하프타임 진입 시 코치진 3~4명이 서로 다른 관점의 제안을 낸다.
// 근거는 전부 실측(스탯·이벤트·체력)이며 결정론적이다(랜덤·시각 의존 없음).
//
// ★ 존(왼쪽/오른쪽) 언급 금지: 엔진 이벤트에 좌우 존 정보가 없다. 근거는
//   상대 유효슛·코너 허용·체력 하위 선수·점유·파울 등 실측 가능한 값만 사용한다.
// ★ 세이프가드: 선수 실명은 사실 서술(이름+체력 수치)만. 비하·조롱 금지.

import type { AttackPattern, GroupIntensity, Instructions, MatchState, Mentality } from '../engine/types'

/** 코치 직함(익명 — 실명 금지). */
export type CoachRole = '수비 코치' | '공격 코치' | '피지컬 코치' | '세트피스 코치'

/** 부분 전술 변경 객체 — [채택] 시 draft(현재 tactics)에 병합된다. */
export interface TacticPatch {
  instructions?: Partial<Instructions>
  mentality?: Mentality
  groupIntensity?: Partial<GroupIntensity>
  attackPattern?: AttackPattern
}

/** 코치 1인의 제안 카드. */
export interface CoachAdvice {
  coach: CoachRole
  /** 실측 수치를 포함한 근거 1문장. */
  rationale: string
  /** 사람이 읽는 제안 1문장. */
  proposal: string
  /** [채택] 시 병합할 부분 전술. */
  apply: TacticPatch
}

const PATTERN_KO: Record<AttackPattern, string> = {
  balanced: '균형', cross: '크로스', through: '중앙 침투', longshot: '중거리',
}

/** 분+스코어 기반 결정론 해시(제안 변형용 — 랜덤 대체). FNV-1a. */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 지정 팀의 [from, 현재] 구간 유효슛(goal|save) 개수 — 최근 추이 근거. */
function recentOnTarget(engine: MatchState, teamId: string, from: number): number {
  return engine.events.filter(
    e => e.teamId === teamId && e.minute > from && (e.type === 'goal' || e.type === 'save'),
  ).length
}

/** 라인업(퇴장 제외) 중 체력 하위 3인 — 실명+정수 체력. 동점은 이름 순 안정 정렬. */
function bottom3Stamina(state: MatchState['home']): { name: string; stamina: number }[] {
  const rows = state.tactics.lineup
    .filter(l => !state.sentOff.includes(l.playerId))
    .map(l => {
      const p = state.team.squad.find(pp => pp.id === l.playerId)
      return { name: p?.name.ko ?? l.playerId, stamina: Math.round(state.staminaByPlayer[l.playerId] ?? 100) }
    })
  rows.sort((a, b) => a.stamina - b.stamina || a.name.localeCompare(b.name))
  return rows.slice(0, 3)
}

/** 코치진 제안 생성 — 항상 수비/공격/피지컬 3인(+세트피스는 코너 조건부) → 3~4개.
 *  상충 허용(수비 코치 "내려라" vs 공격 코치 "올려라" — 감독의 딜레마). */
export function buildCoachAdvice(engine: MatchState, side: 'home' | 'away'): CoachAdvice[] {
  const other = side === 'home' ? 'away' : 'home'
  const own = side === 'home' ? engine.stats[0] : engine.stats[1]
  const opp = side === 'home' ? engine.stats[1] : engine.stats[0]
  const ownState = engine[side]
  const oppState = engine[other]
  const minute = engine.minute
  const [ownScore, oppScore] = side === 'home'
    ? [engine.score[0], engine.score[1]]
    : [engine.score[1], engine.score[0]]
  const h = hash(`${minute}:${engine.score[0]}-${engine.score[1]}`)

  const advice: CoachAdvice[] = []

  // ── 수비 코치 — 상대 유효슛·코너 추이 근거 → 라인/수비 그룹 하향 ──
  const recentOppShots = recentOnTarget(engine, oppState.team.id, minute - 15)
  const heavyPressure = recentOppShots >= 2 || opp.shotsOnTarget >= own.shotsOnTarget + 2
  const curLine = ownState.tactics.instructions.lineHeight
  advice.push({
    coach: '수비 코치',
    rationale: `상대 유효슛 ${opp.shotsOnTarget}개·코너 ${opp.corners}개 허용, 최근 15분 상대 유효슛 ${recentOppShots}개입니다.`,
    proposal: heavyPressure
      ? '라인을 낮추고 수비 그룹을 자제로 돌려 뒷공간을 지웁시다.'
      : '라인을 조금 내려 안정적으로 관리합시다.',
    apply: {
      instructions: { lineHeight: Math.max(20, curLine - (heavyPressure ? 20 : 10)) },
      ...(heavyPressure ? { mentality: 'defensive' as const } : {}),
      groupIntensity: { defense: -1 },
    },
  })

  // ── 공격 코치 — 우리 슛·xG·점유 추이 → 공격 패턴/멘탈리티/공격 그룹 상향 ──
  const patterns: AttackPattern[] = ['through', 'longshot', 'cross']
  const pick = patterns[h % patterns.length]
  const behind = ownScore < oppScore
  const fewer = own.xg < opp.xg
  advice.push({
    coach: '공격 코치',
    rationale: `우리 유효슛 ${own.shotsOnTarget}개·xG ${own.xg.toFixed(2)}, 점유율 ${Math.round(own.possession)}%로 상대(xG ${opp.xg.toFixed(2)})보다 찬스가 ${fewer ? '적습니다' : '많습니다'}.`,
    proposal: `멘탈리티를 ${behind ? '매우 공격적' : '공격적'}으로 올리고 ${PATTERN_KO[pick]} 위주로 공격 그룹을 끌어올립시다.`,
    apply: {
      mentality: behind ? 'very-attacking' : 'attacking',
      groupIntensity: { attack: 1 },
      attackPattern: pick,
    },
  })

  // ── 피지컬 코치 — 체력 하위 3인 실명+수치 → 교체 준비·압박 하향 ──
  const low = bottom3Stamina(ownState)
  const names = low.map(r => `${r.name} ${r.stamina}`).join(', ')
  const curPress = ownState.tactics.instructions.pressing
  advice.push({
    coach: '피지컬 코치',
    rationale: `체력 최하위 3인: ${names}. 압박을 유지하면 후반 급락이 예상됩니다.`,
    proposal: '지친 선수 교체를 준비하고 압박·미드필드 적극성을 낮춰 체력을 아낍시다.',
    apply: {
      instructions: { pressing: Math.max(20, curPress - 15) },
      groupIntensity: { midfield: -1 },
    },
  })

  // ── 세트피스 코치 — 코너 조건부(4개 이상 획득 시에만 등장) ──
  if (own.corners >= 4) {
    advice.push({
      coach: '세트피스 코치',
      rationale: `코너 ${own.corners}개를 얻었습니다. 세트피스 기회가 쌓이고 있습니다.`,
      proposal: '크로스 패턴으로 전환해 세트피스와 측면 공격을 살립시다.',
      apply: { attackPattern: 'cross' },
    })
  }

  return advice
}
