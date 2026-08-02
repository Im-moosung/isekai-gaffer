// src/data/loader.ts
// 12개국 실데이터(JSON)를 엔진 Team 타입으로 로드한다.
// 원칙: JSON을 변형하지 않는다(기본 정보 무결성). 로더는 검증만 하고, 실패 시 팀id·사유를 포함한 명시적 에러를 던진다.
// JSON의 능력치 필드명(shooting/passing/dribbling/defending/physical/pace, saving/aerial/buildup)은
// 엔진 FieldStats/GkStats와 완전히 일치하므로 별도 매핑이 필요 없다(무변형 로드).
import type { Team, FormationId } from '../engine/types'
import { mapFormation } from '../engine/formations'

// mapFormation은 엔진 정본(src/engine/formations.ts)으로 이동했다. 기존 로더 사용처·테스트
// 호환을 위해 여기서 재수출한다.
export { mapFormation }

// 정적 import 12개
import arg from '../../data/teams/arg.json'
import can from '../../data/teams/can.json'
import cze from '../../data/teams/cze.json'
import ecu from '../../data/teams/ecu.json'
import eng from '../../data/teams/eng.json'
import esp from '../../data/teams/esp.json'
import fra from '../../data/teams/fra.json'
import kor from '../../data/teams/kor.json'
import mar from '../../data/teams/mar.json'
import mex from '../../data/teams/mex.json'
import nor from '../../data/teams/nor.json'
import rsa from '../../data/teams/rsa.json'

export type TeamId =
  | 'kor' | 'cze' | 'mex' | 'rsa'
  | 'ecu' | 'eng' | 'nor' | 'arg'
  | 'esp' | 'can' | 'mar' | 'fra'

export const TEAM_IDS: readonly TeamId[] = [
  'kor', 'cze', 'mex', 'rsa', 'ecu', 'eng', 'nor', 'arg', 'esp', 'can', 'mar', 'fra',
]

// JSON은 Team보다 넓은(확장 필드 포함) 구조라 unknown으로 받아 검증 후 캐스팅한다.
const RAW: Record<TeamId, unknown> = {
  kor, cze, mex, rsa, ecu, eng, nor, arg, esp, can, mar, fra,
}

// ── 팀 한국어 표기 ────────────────────────────────────────────
// 왜 여기에 두는가(2026-08-02):
//   기자회견(src/game/pressconf.ts)·회견 화면·신문 카드가 각자 `OPPONENT_KO` 표를 복사해
//   들고 있었다. 세 표는 `?? id` 폴백까지 똑같아서, 표에 없는 id는 **코드값('rsa')이 그대로**
//   화면·신문·AI 헤드라인 프롬프트로 새어 나가도 아무도 모르는 구조였다.
//   ("계층 격리"를 이유로 사본을 뒀지만, 격리한 것은 의존성이 아니라 진실이었다.)
//   팀 JSON의 `name.ko`가 유일한 정본이다. 표기는 여기서만 읽는다.
//
// 안전망은 타입이다: 인자가 TeamId이므로 팀이 늘면 TEAM_IDS·RAW가 함께 늘고,
// 이름이 빠진 JSON은 아래 throw가 즉시 잡는다(조용히 코드값을 뱉지 않는다).

/**
 * 팀의 한국어 정본 표기. TTS 클립도 이 표기로 구워져 있으므로
 * (예: '남아프리카공화국의 코너킥입니다.') 중계와 화면이 같은 이름을 부르려면 이쪽을 쓴다.
 */
export function teamNameKo(id: TeamId): string {
  const raw = RAW[id] as { name?: { ko?: string } } | undefined
  const ko = raw?.name?.ko
  if (typeof ko !== 'string' || ko.length === 0) {
    throw new Error(`[teamNameKo] 팀 한국어 표기 없음: ${id} (data/teams/${id}.json의 name.ko 확인)`)
  }
  return ko
}

/**
 * **폭이 고정된 자리 전용** 짧은 표기.
 *
 * 왜 두 표기가 공존하는가: 신문 PNG(1080px)의 스코어박스는 팀명을 줄바꿈 없이
 * 고정 좌표에 그린다(NewspaperCard.renderNewspaperPng, 46px). 그 칸에 쓸 수 있는 폭은
 * 약 350px인데 '남아프리카공화국'은 8글자라 스코어 숫자를 침범한다.
 * 본문·헤드라인·중계·AI 프롬프트는 전부 정본(teamNameKo)을 쓰고, 이 함수는
 * **잘릴 자리에서만** 쓴다. 실제 스포츠 지면의 관행(본문 정식명·스코어보드 약칭)과도 같다.
 *
 * 표에 없는 팀은 정본을 그대로 돌려준다 — 축약이 필요한 팀만 여기 적는다.
 */
const SHORT_KO: Partial<Record<TeamId, string>> = {
  rsa: '남아공', // 8글자 → 3글자. 다른 11개국은 4글자 이하라 축약이 필요 없다.
}
export function teamNameShortKo(id: TeamId): string {
  return SHORT_KO[id] ?? teamNameKo(id)
}

// ── 포메이션 매핑 ─────────────────────────────────────────────
/**
 * Team.profile.preferredFormations(원본 유지)에서 파생한 플레이 가능 포메이션 목록.
 * Team 타입을 오염시키지 않기 위해 별도 함수로 제공한다(중복 제거).
 */
export function playableFormations(team: Team): FormationId[] {
  const out: FormationId[] = []
  for (const pref of team.profile.preferredFormations) {
    const f = mapFormation(pref)
    if (!out.includes(f)) out.push(f)
  }
  return out
}

// ── 검증 ─────────────────────────────────────────────────────
interface RawPlayer {
  number: number
  position: string
  stats?: Record<string, number>
  gkStats?: Record<string, number>
}

function validate(id: TeamId, raw: unknown): Team {
  const t = raw as { id?: string; squad?: RawPlayer[] }
  const squad = t.squad
  if (!Array.isArray(squad)) throw new Error(`[loadTeam:${id}] squad가 배열이 아니다`)
  if (squad.length < 18) throw new Error(`[loadTeam:${id}] 스쿼드 부족: ${squad.length}명 (최소 18)`)

  const numbers = squad.map(p => p.number)
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`[loadTeam:${id}] 등번호 중복: [${numbers.join(',')}]`)
  }

  const gkCount = squad.filter(p => p.position === 'GK').length
  if (gkCount < 1) throw new Error(`[loadTeam:${id}] GK가 없다`)

  for (const p of squad) {
    const abilities = { ...(p.stats ?? {}), ...(p.gkStats ?? {}) }
    for (const [k, v] of Object.entries(abilities)) {
      if (typeof v !== 'number' || v < 1 || v > 99) {
        throw new Error(`[loadTeam:${id}] #${p.number} 스탯 범위 위반: ${k}=${v} (허용 1~99)`)
      }
    }
  }

  return raw as unknown as Team
}

/** 단일 팀을 검증 로드한다(JSON 무변형). */
export function loadTeam(id: TeamId): Team {
  const raw = RAW[id]
  if (raw === undefined) throw new Error(`[loadTeam] 알 수 없는 팀 id: ${id}`)
  return validate(id, raw)
}

/** 12개국 전체를 로드해 id→Team 레코드로 반환한다. */
export function loadAllTeams(): Record<TeamId, Team> {
  const out = {} as Record<TeamId, Team>
  for (const id of TEAM_IDS) out[id] = loadTeam(id)
  return out
}
