// 발화가 굽힌 클립으로 **덮이는가**. 입장 소개(대본)와 경기 중 중계(조각) 둘 다.
//
// 왜 이 테스트가 있는가(2026-08-01 실사고): 클립 목록을 뽑은 시점이 `9992bca`(팀 squad
// 배열을 등번호순 → signatureXI 순서로 재정렬) **이전**이었다. 그 커밋이 선발 XI를 바꿨고,
// 조별리그 3팀에서 이름 14개가 누락됐다. `beginScript`는 **전부 아니면 전무**라
// 한 줄만 빠져도 대본 전체가 브라우저 음성으로 폴백한다 — 화면은 멀쩡해 보이고
// 소리만 조용히 나빠지므로 사람 눈으로는 잡히지 않는다.
//
// 경기 중 중계는 계약이 다르다. 문장이 서로 독립이라 **한 문장만** 폴백한다. 그래도
// 그 문장에서 목소리가 갈리는 건 똑같이 들리므로 커버리지 100%가 목표다.
//
// 팀 데이터·XI 선정·소개 문안·중계 템플릿 중 무엇이 바뀌든 여기서 걸린다.
//
// ★ 판정은 런타임 함수(`commentary-mp3.hasClips`)를 **그대로 부른다**. 조회 규칙을
//   테스트에 다시 적어 두면 둘이 어긋나는 날 이 파일이 거짓말을 한다(예전엔
//   `, ` 한 번 자르기를 여기 복사해 뒀다).
import { describe, it, expect } from 'vitest'
import { createMatch, simulateSegment } from '../../engine/simulate'
import { loadTeam, TEAM_IDS } from '../../data/loader'
import { buildEntranceCast, entranceScript } from '../../ui/pitch/three/entrance'
import { commentateTimeline } from '../../game/commentary'
import { __setClipIndex, hasClips } from '../commentary-mp3'

// node는 **동적 import**로 가져온다. 앱 tsconfig의 `types`는 `vite/client`뿐이라 정적
// `import ... from 'node:fs'`는 TS2591로 빌드를 깬다(실측: `npm run build` 실패).
// src의 다른 파일 읽기 테스트 셋이 이미 이 방식을 쓴다 — 같은 규칙으로 맞춘다.
// @ts-expect-error node 타입은 앱 tsconfig(types: vite/client)에 없다. 런타임에는 존재한다.
const { readFileSync, existsSync } = await import('node:fs')

interface Index { gapMs: number; clips: Record<string, string>; warm?: string[] }
const INDEX = 'public/tts/index.json'
const present = existsSync(INDEX)
const index: Index = present
  ? (JSON.parse(readFileSync(INDEX, 'utf8')) as Index)
  : { gapMs: 90, clips: {} }
const clips = index.clips
if (present) __setClipIndex({ v: 1, gapMs: index.gapMs, clips })

const covered = (s: string): boolean => hasClips(s)

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

// ── 경기 중 중계 ────────────────────────────────────────────
// 조각 목록은 `tools/tts/live-corpus.mjs`가 캠페인 200시드(발화 9만 건)로 뽑았다.
// 여기서는 그 설계가 **지금 코드에서도** 성립하는지만 지킨다 — 템플릿 한 줄이
// 바뀌거나 팀 데이터가 흔들리면 그 문장이 조용히 브라우저 음성으로 떨어진다.
// 전량 확인은 도구가 한다(느리다). 이건 회귀 감시다.
//
// ★ `warm`이 비어 있으면(= 경기 중 조각을 아직 안 구웠다) 통째로 건너뛴다.
//   구우려는 대상이 없는데 실패하는 테스트는 신호가 아니라 소음이다.
const liveBaked = present && (index.warm?.length ?? 0) > 0

describe.skipIf(!liveBaked)('경기 중 중계 클립 커버리지', () => {
  /** 한 경기의 중계 발화 전량(캐스터 + 해설 + 소강 라인). */
  function speechesOf(oppId: (typeof TEAM_IDS)[number], seed: number): string[] {
    const home = loadTeam('kor')
    const away = loadTeam(oppId)
    const st = simulateSegment(createMatch(home, away, { seed }), 90)
    const out: string[] = []
    for (const l of commentateTimeline(st.events, home, away, seed, {}, 95)) {
      out.push(l.speech)
      if (l.follow) out.push(l.follow.speech)
    }
    return out
  }

  // 조별리그 3팀 × 시드 3개. 누구나 치르는 경기라 여기가 비면 킥오프 직후부터 갈린다.
  for (const opp of ['cze', 'mex', 'rsa'] as const) {
    it(`조별리그 ${opp} — 중계 발화가 전부 덮인다`, () => {
      const miss = new Set<string>()
      for (const s of [1, 2, 3]) {
        for (const sp of speechesOf(opp, SEED + s)) if (!covered(sp)) miss.add(sp)
      }
      expect([...miss]).toEqual([])
    })
  }

  it('토너먼트 팀도 덮인다', () => {
    const miss = new Set<string>()
    for (const opp of TEAM_IDS.filter(t => t !== 'kor' && !['cze', 'mex', 'rsa'].includes(t))) {
      for (const sp of speechesOf(opp, SEED)) if (!covered(sp)) miss.add(sp)
    }
    expect([...miss]).toEqual([])
  })

  it('미리 받기 목록의 클립이 전부 실재한다', () => {
    expect((index.warm ?? []).filter(k => !existsSync(`public/tts/${k}.mp3`))).toEqual([])
  })
})
