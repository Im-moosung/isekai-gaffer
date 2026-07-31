import type { MatchEvent } from '../engine/types'

/**
 * 한 선수의 이 경기 개인 기록. **엔진을 수정하지 않고** `MatchState.events`에서만 파생한다.
 *
 * ★ `save` 이벤트의 의미 주의 — playerId는 "슛한 선수"가 아니라 **막아낸 골키퍼**다.
 *   simulate.ts resolveChance: `{ type: 'save', teamId: def.team.id, playerId: gk.id }`
 *   즉 선방당한 슛의 **슈터 id는 이벤트에 남지 않는다**. 그래서 슈터 관점 집계는:
 *     - 슛      = `goal` + `miss` (+ 현재 미사용인 `shot`) — 선방당한 슛은 셀 수 없다
 *     - 유효슛  = `goal`만 확실 — 선방당한 유효슛은 슈터를 복원할 수 없다
 *   두 값 모두 **하한선**이며, UI는 이 한계를 숨기지 않는다(유효슛을 따로 내세우지 않고
 *   "슛 / 골"만 보여준다). 과거에 이 의미를 반대로 읽어 생긴 버그가 있었다.
 */
export interface PlayerMatchStats {
  /** 슛(하한) — 선방당한 슛은 슈터를 알 수 없어 빠진다. */
  shots: number
  /** 유효슛(하한) — 골만 확실하다. UI 전면 노출 금지(위 주석 참조). */
  shotsOnTarget: number
  goals: number
  /** 어시스트 — `assistId` 기준. 현재 엔진은 assistId를 발행하지 않아 사실상 0이다. */
  assists: number
  fouls: number
  yellows: number
  reds: number
  /** 선방 — 이 선수가 **GK로서 막아낸** 슛(`save`의 playerId 의미 그대로). */
  saves: number
}

const EMPTY: PlayerMatchStats = {
  shots: 0, shotsOnTarget: 0, goals: 0, assists: 0, fouls: 0, yellows: 0, reds: 0, saves: 0,
}

/** 이벤트 로그에서 한 선수의 개인 기록을 집계한다(순수·결정론). */
export function playerMatchStats(events: MatchEvent[], playerId: string): PlayerMatchStats {
  const s: PlayerMatchStats = { ...EMPTY }
  for (const e of events) {
    // 어시스트는 playerId와 무관한 별도 필드다 — 같은 이벤트에서 득점자와 동시에 잡힐 수 있으므로
    // playerId 분기보다 먼저 센다.
    if (e.assistId === playerId) s.assists++
    if (e.playerId !== playerId) continue
    switch (e.type) {
      case 'goal':
        s.goals++
        s.shots++
        s.shotsOnTarget++ // 골은 유일하게 확실한 유효슛이다.
        break
      case 'miss':
        s.shots++
        break
      case 'shot':
        // 엔진은 현재 'shot'을 발행하지 않지만, 타입상 가능하므로 슛으로만 센다
        // (유효 여부를 알 수 없으므로 shotsOnTarget에는 넣지 않는다).
        s.shots++
        break
      case 'save':
        // ★ 반전 주의: 이 선수는 슈터가 아니라 막아낸 GK다.
        s.saves++
        break
      case 'foul':
        s.fouls++
        break
      case 'yellow':
        s.yellows++
        break
      case 'red':
        s.reds++
        break
      default:
        break
    }
  }
  return s
}

/**
 * 한 팀의 선수별 카드 집계 — 캠페인 징계(경고 누적·출장정지)의 입력.
 * 카드를 한 장도 받지 않은 선수는 키 자체를 만들지 않는다(빈 항목이 이월 상태를 부풀리지 않게).
 *
 * ★ teamId로 거르는 이유: events에는 양 팀 카드가 섞여 있고, 선수 id는 팀 간 충돌할 수 있다.
 */
export function teamCardTally(
  events: MatchEvent[], teamId: string,
): Record<string, { yellows: number; reds: number }> {
  const out: Record<string, { yellows: number; reds: number }> = {}
  for (const e of events) {
    if (e.teamId !== teamId || !e.playerId) continue
    if (e.type !== 'yellow' && e.type !== 'red') continue
    const row = (out[e.playerId] ??= { yellows: 0, reds: 0 })
    if (e.type === 'yellow') row.yellows++
    else row.reds++
  }
  return out
}

/** 교체 이벤트의 `detail`에 나간 선수 id를 싣는 접두사(simulate.ts applyCommand 규약). */
const SUB_OUT_PREFIX = 'out:'

/**
 * 이 경기에서 **교체로 나간** 선수 id 목록(발생 순).
 *
 * 규정 근거: IFAB 경기규칙 제3조 — 교체되어 나간 선수는 그 경기에 다시 출전할 수 없다.
 * (2026 대회에 부상 교체·복귀 예외는 없고, 이 게임에는 부상 시스템 자체가 없다.)
 *
 * ★ 왜 상태 필드가 아니라 파생인가: 같은 사실을 엔진 상태와 UI 스토어가 나눠 들면
 *   반드시 어긋난다(교체 취소·세그먼트 분할·이월 경로마다 동기화가 필요해진다).
 *   엔진은 이미 교체마다 이벤트를 남기므로 `teamCardTally`와 같은 규약으로 events를
 *   진실의 원천으로 삼는다 — 순수·결정론이고 엔진 수정이 필요 없다.
 *
 * 엔진 규약: `{ type:'sub', teamId, playerId: 들어온 선수, detail: 'out:<나간 선수>' }`
 * — playerId가 IN이고 detail이 OUT이라 방향을 뒤집어 읽으면 정반대 결과가 나온다.
 */
export function subbedOffIds(events: readonly MatchEvent[], teamId: string): string[] {
  const out: string[] = []
  for (const e of events) {
    if (e.type !== 'sub' || e.teamId !== teamId) continue
    if (!e.detail?.startsWith(SUB_OUT_PREFIX)) continue
    const id = e.detail.slice(SUB_OUT_PREFIX.length)
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** 화면에 내보일 만한 기록이 하나라도 있는가(전부 0이면 표시를 접기 위한 판정). */
export function hasPlayerMatchStats(s: PlayerMatchStats): boolean {
  return s.shots > 0 || s.goals > 0 || s.assists > 0 || s.fouls > 0
    || s.yellows > 0 || s.reds > 0 || s.saves > 0
}
