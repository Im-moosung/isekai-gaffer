// src/data/loader.ts
// 12개국 실데이터(JSON)를 엔진 Team 타입으로 로드한다.
// 원칙: JSON을 변형하지 않는다(기본 정보 무결성). 로더는 검증만 하고, 실패 시 팀id·사유를 포함한 명시적 에러를 던진다.
// JSON의 능력치 필드명(shooting/passing/dribbling/defending/physical/pace, saving/aerial/buildup)은
// 엔진 FieldStats/GkStats와 완전히 일치하므로 별도 매핑이 필요 없다(무변형 로드).
import type { Team, FormationId } from '../engine/types'

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

// ── 포메이션 매핑 ─────────────────────────────────────────────
const SUPPORTED: readonly FormationId[] = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '5-4-1']

// 미지원 포메이션 → 가장 가까운 지원 6종
const FORMATION_MAP: Record<string, FormationId> = {
  '4-2-2-2': '4-4-2',
  '3-4-2-1': '3-5-2',
  '4-1-3-2': '4-4-2',
  '3-1-4-2': '3-5-2',
}

/** 실제 대회 포메이션 문자열을 엔진의 FormationId(6종)로 매핑한다. */
export function mapFormation(pref: string): FormationId {
  if ((SUPPORTED as readonly string[]).includes(pref)) return pref as FormationId
  if (pref in FORMATION_MAP) return FORMATION_MAP[pref]
  return '4-4-2'
}

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
