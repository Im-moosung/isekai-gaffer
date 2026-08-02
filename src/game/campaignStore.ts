// src/game/campaignStore.ts
// 캠페인 상태 머신: 조별 3경기(cze→mex→rsa)→순위 산정→토너먼트 경로 분기→엔딩.
// 순수 상태 로직. TeamId는 데이터 로더에서 가져온다.
// 엔진에서 값을 가져오는 것은 사기 관련 둘(MORALE_BASELINE·normalizeMorale)뿐이다 —
// 사기 기준선과 정수화 규약은 엔진과 캠페인이 **같은 정의**를 써야 한다. 여기서 복제하면
// 이월값만 소수로 새거나 기준선이 어긋나도 아무도 모른다(실제로 그렇게 샜다).
import { create } from 'zustand'
import type { TeamId } from '../data/loader'
import type { DecisionEntry } from '../engine/types'
import { MORALE_BASELINE, normalizeMorale } from '../engine/simulate'
import type { TeamTalkTone } from './matchStore'

export type CampaignStage =
  | 'group1' | 'group2' | 'group3'
  | 'r32' | 'r16' | 'qf' | 'sf' | 'final'
  | 'ended'

export interface MatchRecord {
  stage: CampaignStage
  opponentId: TeamId
  score: [number, number] // [kor, 상대]
  shootout?: [number, number] // [kor, 상대] 승부차기
  decisions: DecisionEntry[] // 이 경기의 감독 개입 로그(기자회견 근거)
}

// ── 징계(경고 누적·출장정지) ────────────────────────────────────────
// 규정 근거는 docs/research/2026-discipline-rules.md의 대응표를 보라.
// 요지: 대회 중 경고 2장 누적 → 다음 경기 출장정지, 퇴장 → 최소 1경기 정지,
// 미소멸 경고는 지정 스테이지를 마치면 소멸(정지는 소멸하지 않는다).

/** 경고 누적 임계 — 이 장수에 도달하면 다음 경기 출장정지. */
export const CAUTION_THRESHOLD = 2
/** 퇴장의 기본 정지 경기 수. 가중(폭력행위 등)은 사안별이라 모델링하지 않고 최소치만 적용한다. */
export const RED_SUSPENSION = 1
/** 미소멸 누적 경고가 소멸하는 시점 — **이 스테이지 경기를 마친 뒤** 전부 지운다.
 *
 *  ★ 2026은 소멸이 **두 번**이다. 2022까지는 8강 종료 후 한 번뿐이었는데, FIFA 평의회가
 *  2026-04-28 밴쿠버 회의에서 규정을 개정해 **조별리그 종료 후에도** 한 번 지우기로 했다
 *  ("single yellow cards ... will be cancelled after the group stage and then again after
 *  the quarter-finals"). 2025년 5월판 규정 PDF 원문(Art. 10.3)만 보면 8강 1회로 잘못 읽는다.
 *  출처·대응표는 docs/research/2026-discipline-rules.md. */
export const CAUTION_WIPE_AFTER: readonly CampaignStage[] = ['group3', 'qf']
/** 사기 기준선. 정의는 엔진(simulate.MORALE_BASELINE) 한 곳뿐이고 여기선 재수출만 한다 —
 *  기존 import 경로(테스트 포함)를 깨지 않으면서 정의를 하나로 유지하기 위해서다. */
export { MORALE_BASELINE }

/**
 * 경기 사이에 **남는** 피로의 비율. 다음 경기 시작 체력 = 100 − (100 − 종료체력) × RESIDUAL_LOAD.
 *
 * ★ 이전 값은 "부족분의 70% 회복"(= 잔여 0.30)이었고, 그것이 8경기에 걸쳐 복리로 누적돼
 *   3경기째부터 팀이 **상시 탈진 상태**로 뛰었다(감사 결함 ①). 실측(seed 7·42, 캠페인 8경기,
 *   교체 없음):
 *     HT 최저/중앙  1경기 62/67 → 2경기 39/47 → 3경기 33/41 → 4~8경기 32/38~39
 *     FT 중앙       34 → 14 → 8 → 6 → 5 (즉 후반 내내 걸어 다닌다)
 *   회복 곡선의 고정점이 "거의 0"이라 로테이션으로도 되돌릴 수 없는 상태였다.
 *
 * ★ 실제 월드컵은 경기 간격이 3~5일이다. 그 정도면 글리코겐·급성 근피로는 대부분 회복되고,
 *   남는 것은 누적 부하다. 그렇다고 0으로 두면 **로테이션의 이유가 사라진다** —
 *   체력은 감독의 결정 축으로 남아야 한다. 0은 "이월 없음"이고 0.30은 "붕괴"였다.
 *
 * ★ 0.15의 의미: 90분을 끝까지 소진(종료 0)한 선수는 다음 경기를 **85**로 시작하고,
 *   벤치에서 쉰 선수는 100으로 시작한다. 15점 차는 effectiveStats에서 체감되는 폭이고,
 *   고정점도 붕괴하지 않는다(실측: 2경기 이후 HT 중앙 55~58에서 평평해진다).
 */
export const RESIDUAL_LOAD = 0.15

const clamp01to100 = (v: number) => Math.max(0, Math.min(100, v))

/** 한 경기에서 한 선수가 받은 카드 집계(MatchState.events에서 파생). */
export interface MatchCardTally {
  yellows: number
  reds: number
}

/** recordResult의 선택 부가 입력. 위치 인자를 더 늘리지 않기 위해 객체로 받는다. */
export interface RecordExtra {
  /** 이 경기 우리 팀 선수별 카드 집계. 미지정이면 징계 상태가 변하지 않는다(데모·테스트 호환). */
  cards?: Record<string, MatchCardTally>
  /** 경기 종료 시점 사기 — 다음 경기 시작 사기 이월용. */
  moraleByPlayer?: Record<string, number>
}

export interface CampaignState {
  seed: number
  stage: CampaignStage
  records: MatchRecord[]
  groupRank: 1 | 2 | 3 | null // 조별 종료 후 산정
  path: 'first' | 'second' | null
  fatigueCarry: Record<string, number> // 경기 종료 시 스태미나 이월
  /** 경기 종료 시 사기 이월. 체력과 달리 기준선(70)으로 되돌아가므로 회복이자 냉각이다. */
  moraleCarry: Record<string, number>
  /** 미소멸 누적 경고(장). 임계 도달 시 정지로 전환되며 0으로 초기화된다. */
  cautions: Record<string, number>
  /** 잔여 출장정지 경기 수. >0이면 다음 경기에 뛸 수 없다. */
  bans: Record<string, number>
  ending: { reached: CampaignStage; champion: boolean } | null
  /** 지난 경기 하프타임 팀토크 톤(캠페인 저장 — MatchRecord 흐름과 별개 필드).
   *  같은 톤을 연이어 쓰면 팀토크 효과가 반감된다(반복 감쇠). 미사용/첫 경기는 null. */
  lastTeamTalkTone: TeamTalkTone | null
  startCampaign(seed: number): void
  currentOpponent(): TeamId
  matchSeed(): number // seed*31 + matchIndex(진행 순 0부터)
  recordResult(
    score: [number, number],
    staminaByPlayer: Record<string, number>,
    shootout?: [number, number],
    decisions?: DecisionEntry[],
    extra?: RecordExtra,
  ): void
  /** 다음 경기 시작 체력. 남는 피로는 RESIDUAL_LOAD 비율만큼 — 상세는 그 상수 주석. */
  startingStamina(playerId: number | string): number
  /** 다음 경기 시작 사기. 기준선 70으로 70% 회귀 — 고양도 침체도 한 경기 뒤엔 옅어진다. */
  startingMorale(playerId: number | string): number
  /** 이 선수가 다음 경기에 출장정지인가. */
  isSuspended(playerId: number | string): boolean
  /** 이 선수의 미소멸 누적 경고 수(0~). */
  cautionCount(playerId: number | string): number
  /** 다음 경기 출장정지 선수 id 전부(결정론 정렬). */
  suspendedIds(): string[]
  /** 팀토크 톤 기록(경기 종료와 무관하게 하프타임에 즉시 저장). 반복 감쇠 판정 근거. */
  setLastTeamTalkTone(tone: TeamTalkTone): void
  reset(): void
}

// 조별 상대 순서 (역사 재현: 체코→멕시코→남아공)
const GROUP_OPPONENTS: Record<'group1' | 'group2' | 'group3', TeamId> = {
  group1: 'cze',
  group2: 'mex',
  group3: 'rsa',
}

// 토너먼트 경로별 상대 (진출 규칙: 조 1·2위만)
const FIRST_PATH: Record<'r32' | 'r16' | 'qf' | 'sf' | 'final', TeamId> = {
  r32: 'ecu', r16: 'eng', qf: 'nor', sf: 'arg', final: 'esp',
}
const SECOND_PATH: Record<'r32' | 'r16' | 'qf' | 'sf' | 'final', TeamId> = {
  r32: 'can', r16: 'mar', qf: 'fra', sf: 'esp', final: 'arg',
}

// 토너먼트 스테이지 전진 순서
const NEXT_TOURNAMENT: Record<'r32' | 'r16' | 'qf' | 'sf', 'r16' | 'qf' | 'sf' | 'final'> = {
  r32: 'r16', r16: 'qf', qf: 'sf', sf: 'final',
}

const TOURNAMENT_STAGES = ['r32', 'r16', 'qf', 'sf', 'final'] as const
type TournamentStage = (typeof TOURNAMENT_STAGES)[number]
function isTournament(s: CampaignStage): s is TournamentStage {
  return (TOURNAMENT_STAGES as readonly string[]).includes(s)
}

interface Row { pts: number; gf: number; ga: number }

// 조별 순위 산정: 타 팀 상호전적을 고정 테이블로 두고 유저 3경기 결과만 대입해
// 표준 규칙(승점→득실→다득점)으로 4팀 순위를 계산한다.
function computeKorRank(groupRecords: MatchRecord[]): 1 | 2 | 3 {
  const rows: Record<string, Row> = {}
  const ensure = (id: string): Row => (rows[id] ??= { pts: 0, gf: 0, ga: 0 })
  const play = (a: string, b: string, sa: number, sb: number) => {
    const ra = ensure(a), rb = ensure(b)
    ra.gf += sa; ra.ga += sb; rb.gf += sb; rb.ga += sa
    if (sa > sb) ra.pts += 3
    else if (sa < sb) rb.pts += 3
    else { ra.pts += 1; rb.pts += 1 }
  }

  // --- 타 팀 상호전적 고정 테이블 ---
  play('mex', 'cze', 3, 0) // 실측
  play('mex', 'rsa', 1, 0) // 실측
  play('cze', 'rsa', 1, 1) // 가상(리서치 미확정) — 무승부로 가정

  // --- 유저(kor) 3경기 결과 대입 ---
  for (const r of groupRecords) play('kor', r.opponentId, r.score[0], r.score[1])

  // 표준 정렬: 승점 → 득실차 → 다득점 → id(결정론 안정 정렬)
  const order = Object.keys(rows).sort((x, y) => {
    const rx = rows[x], ry = rows[y]
    if (ry.pts !== rx.pts) return ry.pts - rx.pts
    const gdx = rx.gf - rx.ga, gdy = ry.gf - ry.ga
    if (gdy !== gdx) return gdy - gdx
    if (ry.gf !== rx.gf) return ry.gf - rx.gf
    return x.localeCompare(y)
  })
  const rank = order.indexOf('kor') + 1
  return rank <= 1 ? 1 : rank === 2 ? 2 : 3
}

/**
 * 한 경기가 끝난 시점의 징계 상태 전이(순수·결정론).
 *
 * 순서가 중요하다.
 *  (1) **먼저 정지를 소화 처리한다.** 정지 중이던 선수는 방금 끝난 이 경기를 결장했으므로
 *      잔여 경기 수를 1 줄인다. 나중에 줄이면 이번 경기에서 새로 받은 카드와 뒤섞인다.
 *  (2) 이번 경기 카드를 반영한다. 퇴장자는 정지 +1이고, **2옐로 퇴장을 구성한 경고 2장은
 *      누적에 합산하지 않는다**(FIFA 규정). 직접 레드는 그 전에 받아 둔 경고를 그대로 누적한다.
 *  (3) 임계 도달분을 정지로 전환하고 누적을 0으로 되돌린다.
 *  (4) 소멸 스테이지를 마쳤으면 **미소멸 경고만** 전부 지운다 — 이미 확정된 정지는 남는다.
 *
 * @param cards 미지정(데모·기존 테스트)이면 (1)의 소화 처리만 하고 새 징계는 없다.
 */
export function applyDiscipline(
  prevCautions: Record<string, number>,
  prevBans: Record<string, number>,
  cards: Record<string, MatchCardTally> | undefined,
  stage: CampaignStage,
): { cautions: Record<string, number>; bans: Record<string, number> } {
  const cautions: Record<string, number> = { ...prevCautions }
  const bans: Record<string, number> = {}

  // (1) 이번 경기로 소화된 정지 차감.
  for (const [id, n] of Object.entries(prevBans)) {
    const left = n - 1
    if (left > 0) bans[id] = left
  }

  // (2)(3) 이번 경기 카드 반영.
  for (const [id, tally] of Object.entries(cards ?? {})) {
    if (tally.reds > 0) {
      bans[id] = (bans[id] ?? 0) + RED_SUSPENSION
      // 2옐로 퇴장이면 그 두 장은 누적에서 뺀다. 직접 레드(경고 0~1장)면 뺄 것이 없다.
      const pair = tally.yellows >= CAUTION_THRESHOLD ? CAUTION_THRESHOLD : 0
      cautions[id] = (cautions[id] ?? 0) + (tally.yellows - pair)
    } else {
      cautions[id] = (cautions[id] ?? 0) + tally.yellows
    }
    if (cautions[id] >= CAUTION_THRESHOLD) {
      bans[id] = (bans[id] ?? 0) + 1
      cautions[id] = 0
    }
  }

  // (4) 소멸 시점.
  if (CAUTION_WIPE_AFTER.includes(stage)) {
    for (const id of Object.keys(cautions)) delete cautions[id]
  }
  for (const id of Object.keys(cautions)) if (cautions[id] <= 0) delete cautions[id]
  return { cautions, bans }
}

const initial = {
  seed: 0,
  stage: 'group1' as CampaignStage,
  records: [] as MatchRecord[],
  groupRank: null as 1 | 2 | 3 | null,
  path: null as 'first' | 'second' | null,
  fatigueCarry: {} as Record<string, number>,
  moraleCarry: {} as Record<string, number>,
  cautions: {} as Record<string, number>,
  bans: {} as Record<string, number>,
  ending: null as { reached: CampaignStage; champion: boolean } | null,
  lastTeamTalkTone: null as TeamTalkTone | null,
}

export const useCampaignStore = create<CampaignState>((set, get) => ({
  ...initial,

  startCampaign: (seed) => set({ ...initial, seed }),

  currentOpponent: () => {
    const { stage, path } = get()
    if (stage === 'group1' || stage === 'group2' || stage === 'group3') {
      return GROUP_OPPONENTS[stage]
    }
    if (isTournament(stage)) {
      const table = path === 'second' ? SECOND_PATH : FIRST_PATH
      return table[stage]
    }
    throw new Error('캠페인 종료: 다음 상대 없음')
  },

  matchSeed: () => {
    const { seed, records } = get()
    return seed * 31 + records.length
  },

  recordResult: (score, staminaByPlayer, shootout, decisions = [], extra) => {
    const state = get()
    const { stage } = state
    if (stage === 'ended') throw new Error('이미 종료된 캠페인')

    const opponentId = state.currentOpponent()
    const record: MatchRecord = { stage, opponentId, score, ...(shootout ? { shootout } : {}), decisions }
    const records = [...state.records, record]
    // 체력 이월: 이번 경기 종료 스태미나를 저장(다음 경기 시작값은 startingStamina가 계산)
    const fatigueCarry = { ...state.fatigueCarry, ...staminaByPlayer }
    // 사기 이월: 종료 사기를 저장(다음 경기 시작 시 기준선 70으로 70% 회귀)
    const moraleCarry = { ...state.moraleCarry, ...(extra?.moraleByPlayer ?? {}) }
    const { cautions, bans } = applyDiscipline(state.cautions, state.bans, extra?.cards, stage)
    // 반복 감쇠용: 이번 경기 하프타임 팀토크 톤을 캠페인에 저장(다음 경기에서 같은 톤이면 반감).
    // 외침도 kind:'teamtalk'이므로 detail.tone(HT 팀토크만 보유)이 있는 항목만 취한다.
    const talk = [...decisions].reverse().find(d => d.kind === 'teamtalk' && typeof d.detail?.tone === 'string')
    const lastTeamTalkTone = (talk?.detail?.tone as TeamTalkTone | undefined) ?? state.lastTeamTalkTone

    // --- 조별 스테이지: 무승부 허용, 3경기 후 순위 산정 ---
    if (stage === 'group1') {
      set({ records, fatigueCarry, moraleCarry, cautions, bans, lastTeamTalkTone, stage: 'group2' })
      return
    }
    if (stage === 'group2') {
      set({ records, fatigueCarry, moraleCarry, cautions, bans, lastTeamTalkTone, stage: 'group3' })
      return
    }
    if (stage === 'group3') {
      const groupRecords = records.filter(r => r.stage.startsWith('group'))
      const rank = computeKorRank(groupRecords)
      if (rank === 1 || rank === 2) {
        set({ records, fatigueCarry, moraleCarry, cautions, bans, lastTeamTalkTone, groupRank: rank, path: rank === 1 ? 'first' : 'second', stage: 'r32' })
      } else {
        // 3위 이하 → 즉시 탈락 엔딩
        set({ records, fatigueCarry, moraleCarry, cautions, bans, lastTeamTalkTone, groupRank: 3, stage: 'ended', ending: { reached: 'group3', champion: false } })
      }
      return
    }

    // --- 토너먼트 스테이지: 무승부면 shootout 필수, 패배 즉시 엔딩 ---
    const [korG, oppG] = score
    let won: boolean
    if (korG > oppG) won = true
    else if (korG < oppG) won = false
    else {
      if (!shootout) throw new Error('토너먼트 무승부는 승부차기(shootout) 결과가 필요합니다')
      won = shootout[0] > shootout[1]
    }

    if (!won) {
      set({ records, fatigueCarry, moraleCarry, cautions, bans, lastTeamTalkTone, stage: 'ended', ending: { reached: stage, champion: false } })
      return
    }
    if (stage === 'final') {
      set({ records, fatigueCarry, moraleCarry, cautions, bans, lastTeamTalkTone, stage: 'ended', ending: { reached: 'final', champion: true } })
      return
    }
    set({ records, fatigueCarry, moraleCarry, cautions, bans, lastTeamTalkTone, stage: NEXT_TOURNAMENT[stage as 'r32' | 'r16' | 'qf' | 'sf'] })
  },

  // 다음 경기 시작 스태미나 — RESIDUAL_LOAD 주석 참고. 미기록/첫 경기는 100.
  startingStamina: (playerId) => {
    const carry = get().fatigueCarry[String(playerId)]
    if (carry === undefined) return 100
    return clamp01to100(100 - (100 - carry) * RESIDUAL_LOAD)
  },

  // 다음 경기 시작 사기: 기준선 70으로 70% 회귀. 체력은 100(만점)으로 회복하지만 사기는
  // 만점이 목표가 아니다 — 대승 뒤의 고양도, 대패 뒤의 침체도 한 경기 지나면 대부분 옅어진다.
  //
  // ★ 정수화(감사 결함 ④의 진원지): ×0.3이 여기서 소수를 만들었고, 그 값이 그대로
  //   moraleByPlayer에 저장돼 다음 경기 내내 따라다녔다. 그래서 외침이 실제로 +5를 줬는데도
  //   화면에는 "사기가 4.999999999999 올랐습니다"가 나왔다(delta = 이후값 − 이전값이라
  //   양쪽 소수의 뺄셈 오차가 그대로 노출된다). normalizeMorale로 잘라 **저장되는 값 자체를**
  //   정수로 만든다 — 표시부에서 toFixed로 가리면 이월 때마다 오차가 다시 쌓인다.
  startingMorale: (playerId) => {
    const carry = get().moraleCarry[String(playerId)]
    if (carry === undefined) return MORALE_BASELINE
    return normalizeMorale(MORALE_BASELINE + (carry - MORALE_BASELINE) * 0.3)
  },

  isSuspended: (playerId) => (get().bans[String(playerId)] ?? 0) > 0,

  cautionCount: (playerId) => get().cautions[String(playerId)] ?? 0,

  suspendedIds: () =>
    Object.entries(get().bans)
      .filter(([, n]) => n > 0)
      .map(([id]) => id)
      .sort(),

  setLastTeamTalkTone: (tone) => set({ lastTeamTalkTone: tone }),

  reset: () => set({ ...initial }),
}))
