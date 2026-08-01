// 입장 소개 대본이 굽힌 클립으로 **통째로** 덮이는가.
//
// 왜 이 테스트가 있는가(2026-08-01 실사고): 클립 목록을 뽑은 시점이 `9992bca`(팀 squad
// 배열을 등번호순 → signatureXI 순서로 재정렬) **이전**이었다. 그 커밋이 선발 XI를 바꿨고,
// 조별리그 3팀에서 이름 14개가 누락됐다. `beginScript`는 **전부 아니면 전무**라
// 한 줄만 빠져도 대본 전체가 브라우저 음성으로 폴백한다 — 화면은 멀쩡해 보이고
// 소리만 조용히 나빠지므로 사람 눈으로는 잡히지 않는다.
//
// 팀 데이터·XI 선정·소개 문안 중 무엇이 바뀌든 여기서 걸린다.
import { describe, it, expect } from 'vitest'
import { createMatch } from '../../engine/simulate'
import { loadTeam, TEAM_IDS } from '../../data/loader'
import { buildEntranceCast, entranceScript } from '../../ui/pitch/three/entrance'

// node는 **동적 import**로 가져온다. 앱 tsconfig의 `types`는 `vite/client`뿐이라 정적
// `import ... from 'node:fs'`는 TS2591로 빌드를 깬다(실측: `npm run build` 실패).
// src의 다른 파일 읽기 테스트 셋이 이미 이 방식을 쓴다 — 같은 규칙으로 맞춘다.
// @ts-expect-error node 타입은 앱 tsconfig(types: vite/client)에 없다. 런타임에는 존재한다.
const { readFileSync, existsSync } = await import('node:fs')

const INDEX = 'public/tts/index.json'
const present = existsSync(INDEX)
const clips: Record<string, string> = present
  ? (JSON.parse(readFileSync(INDEX, 'utf8')) as { clips: Record<string, string> }).clips
  : {}

/** 런타임(`commentary-mp3.resolveClips`)과 **같은 규칙** — 통문장 또는 `, ` 앞뒤 두 조각. */
function covered(s: string): boolean {
  if (clips[s]) return true
  const i = s.indexOf(', ')
  return i > 0 && !!clips[s.slice(0, i + 1)] && !!clips[s.slice(i + 2)]
}

const SEED = 20260724 * 31

describe.skipIf(!present)('입장 소개 클립 커버리지', () => {
  // 조별리그 3팀은 **누구나 반드시 치른다** — 여기가 비면 첫인상이 무너진다.
  for (const opp of ['cze', 'mex', 'rsa'] as const) {
    it(`조별리그 ${opp} — 대본 전체가 덮인다`, () => {
      const st = createMatch(loadTeam('kor'), loadTeam(opp), { seed: SEED })
      const beats = entranceScript(buildEntranceCast(st), 'full').beats
      expect(beats.length).toBeGreaterThan(0)
      expect(beats.map(b => b.speech).filter(s => !covered(s))).toEqual([])
    })
  }

  // 토너먼트 팀은 대진에 따라 만난다. 빠지면 그 경기만 폴백이라 치명적이지 않지만,
  // 지금은 12개국 전부 구워 뒀으므로 그 상태를 계약으로 지킨다.
  it('12개국 전부 덮인다', () => {
    const miss: string[] = []
    for (const opp of TEAM_IDS.filter(t => t !== 'kor')) {
      const st = createMatch(loadTeam('kor'), loadTeam(opp), { seed: SEED })
      for (const b of entranceScript(buildEntranceCast(st), 'full').beats) {
        if (!covered(b.speech)) miss.push(`${opp}: ${b.speech}`)
      }
    }
    expect(miss).toEqual([])
  })

  it('조회표의 모든 클립 파일이 실재한다', () => {
    const gone = [...new Set(Object.values(clips))].filter(k => !existsSync(`public/tts/${k}.mp3`))
    expect(gone).toEqual([])
  })
})
