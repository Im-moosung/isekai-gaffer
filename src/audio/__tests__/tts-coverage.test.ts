// 발화가 굽힌 클립으로 **덮이는가**. 입장 소개(대본)와 경기 중 중계(조각) 둘 다.
//
// 왜 이 테스트가 있는가(2026-08-01 실사고): 클립 목록을 뽑은 시점이 `9992bca`(팀 squad
// 배열을 등번호순 → signatureXI 순서로 재정렬) **이전**이었다. 그 커밋이 선발 XI를 바꿨고,
// 조별리그 3팀에서 이름 14개가 누락됐다. `beginScript`는 **전부 아니면 전무**라
// 한 줄만 빠져도 대본 전체가 소리를 잃는다 — 화면은 멀쩡해 보이고 소리만 조용히
// 나빠지므로 사람 눈으로는 잡히지 않는다.
//
// ★ 2026-08-02부터 이 테스트의 무게가 달라졌다. 예전에는 빠진 문장이 브라우저 기본
//   음성(여성)으로 폴백했다 — 티는 나도 정보는 들렸다. 이제 폴백이 없어 빠진 문장은
//   **무음**이다(근거: commentary-tts.ts 헤더). 자막은 그대로 나가므로 정보는 잃지
//   않지만, 커버리지 구멍은 곧 "그 문장이 조용하다"가 된다.
//
// 경기 중 중계는 계약이 다르다. 문장이 서로 독립이라 **한 문장만** 조용하다. 그래도
// 구멍은 구멍이므로 커버리지 100%가 목표다.
//
// 팀 데이터·XI 선정·소개 문안·중계 템플릿 중 무엇이 바뀌든 여기서 걸린다.
//
// ★ 판정은 런타임 함수(`commentary-mp3.hasClips`)를 **그대로 부른다**. 조회 규칙을
//   테스트에 다시 적어 두면 둘이 어긋나는 날 이 파일이 거짓말을 한다(예전엔
//   `, ` 한 번 자르기를 여기 복사해 뒀다).
import { describe, it, expect } from 'vitest'
import { applyCommand, createMatch, simulateSegment } from '../../engine/simulate'
import { pickBestXI } from '../../engine/lineup'
import type { DecisionEntry } from '../../engine/types'
import { loadTeam, TEAM_IDS } from '../../data/loader'
import { buildEntranceCast, entranceScript } from '../../ui/pitch/three/entrance'
import { commentateTimeline, sanitizeSpeech, TACTIC_LINES } from '../../game/commentary'
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

  // 토너먼트 팀은 대진에 따라 만난다. 빠지면 그 경기 소개만 무음이라 치명적이지 않지만,
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
// 바뀌거나 팀 데이터가 흔들리면 그 문장이 조용히 무음이 된다(폴백은 없다).
// 전량 확인은 도구가 한다(느리다). 이건 회귀 감시다.
//
// ★ `warm`이 비어 있으면(= 경기 중 조각을 아직 안 구웠다) 통째로 건너뛴다.
//   구우려는 대상이 없는데 실패하는 테스트는 신호가 아니라 소음이다.
const liveBaked = present && (index.warm?.length ?? 0) > 0

describe.skipIf(!liveBaked)('경기 중 중계 클립 커버리지', () => {
  /**
   * 한 경기의 중계 발화 전량(캐스터 + 해설 + 소강 라인).
   *
   * ★ **감독 행동을 반드시 섞는다.** 예전 판은 킥오프 전 전술만 주고 90분을 한 번에
   *   돌려서, "지시를 바꾼 뒤에만 나오는 해설"(`TACTIC_LINES` · 교체 반응)을 한 번도
   *   보지 않은 채 "전부 덮인다"고 통과했다 — 2026-08-02 실사고의 절반이 이 거짓
   *   초록불이었다. 코퍼스 도구(`tools/tts/live-corpus.mjs`)와 같은 이유로 같은 수정을
   *   한다. 실제 유저는 경기 중에 지시를 바꾸고 사람을 뺀다.
   */
  function speechesOf(oppId: (typeof TEAM_IDS)[number], seed: number): string[] {
    const home = loadTeam('kor')
    const away = loadTeam(oppId)
    let st = createMatch(home, away, { seed })
    // 개입 기록의 모양은 matchStore.submitCommand와 같아야 한다 — `readTacticalNotes`가
    // 그 모양(`changed` 축 라벨 · `before`/`after`)만 읽는다.
    const decisions: DecisionEntry[] = []
    const push = (cmd: Parameters<typeof applyCommand>[2], entry: DecisionEntry): void => {
      try {
        st = applyCommand(st, 'home', cmd)
        decisions.push(entry)
      } catch {
        /* 교체 한도 등 — 실제 게임도 여기서 막힌다 */
      }
    }
    st = simulateSegment(st, 20)
    const instr = st.home.tactics.instructions
    push(
      { type: 'instructions', instructions: { ...instr, pressing: Math.min(90, instr.pressing + 25) } },
      { minute: 20, kind: 'instructions', summary: "20' 지시 변경", detail: { changed: [`압박 ${instr.pressing}→${Math.min(90, instr.pressing + 25)}`] } },
    )
    st = simulateSegment(st, 40)
    const onPitch = new Set(st.home.tactics.lineup.map(l => l.playerId))
    const outId = st.home.tactics.lineup.find(l => l.slot !== 'GK')?.playerId
    const inId = home.squad.find(p => !onPitch.has(p.id))?.id
    if (outId && inId) {
      push({ type: 'sub', out: outId, in: inId },
        { minute: 40, kind: 'sub', summary: "40' 교체", detail: { in: inId, out: outId } })
    }
    st = simulateSegment(st, 60)
    const before = st.home.tactics.formation
    const after = before.startsWith('3') || before.startsWith('5') ? '4-4-2' : '3-5-2'
    const tactics = pickBestXI(home, after)
    tactics.instructions = { ...st.home.tactics.instructions }
    push({ type: 'formation', tactics },
      { minute: 60, kind: 'instructions', summary: `60' 포메이션: ${before}→${after}`, detail: { before, after } })
    st = simulateSegment(st, 90)
    const out: string[] = []
    for (const l of commentateTimeline(st.events, home, away, seed, { decisions, managedTeamId: home.id }, 95)) {
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

// ── 대사 리터럴 안전망 ──────────────────────────────────────
// 위 두 블록은 **시뮬레이션이 실제로 낸 발화**만 본다. 그래서 조건이 까다로운 문장은
// 시드에 안 걸리면 조용히 빠지고, 빠진 만큼이 그대로 커버리지 구멍이 된다.
// 2026-08-02 실사고가 정확히 그 모양이었다: 코퍼스 도구(`tools/tts/live-corpus.mjs`)가
// 경기 중 **감독 행동을 한 번도 시뮬하지 않아** `TACTIC_LINES` 28개와 교체 반응 해설이
// 통째로 빠졌는데, 도구는 "커버리지 100%"를 보고했다 — 분모가 틀린 값이었다.
//
// 그래서 여기서는 시뮬레이션을 거치지 않고 **대사 원본**을 직접 본다.
// 새 대사를 쓰고 클립을 안 구우면 이 블록이 실패한다.
describe.skipIf(!liveBaked)('중계 대사 리터럴 커버리지', () => {
  // ① 전술 해설은 pool이 export되어 있으므로 **직접 순회한다**(정규식보다 정확하다).
  it('TACTIC_LINES 전량이 덮인다', () => {
    const miss: string[] = []
    for (const [kind, set] of Object.entries(TACTIC_LINES)) {
      for (const side of ['mine', 'theirs'] as const) {
        for (const t of set[side]) if (!covered(sanitizeSpeech(t))) miss.push(`${kind}.${side}: ${t}`)
      }
    }
    expect(miss).toEqual([])
  })

  // ② 나머지 풀(BASE·AN_BASE·ANALYST_SHAPE…)은 export되어 있지 않다. 소스를 긁는다.
  //    거친 그물이지만 목적에는 맞다 — **가변 슬롯 없는 고정 문장**은 문자열 리터럴로만
  //    쓰이고(슬롯이 있으면 템플릿 리터럴이 된다), 그 문장은 통째로 구울 수 있어야 한다.
  //    주석을 먼저 걷어내지 않으면 이 저장소의 긴 한국어 주석이 통째로 걸린다.
  it('commentary.ts의 고정 문장이 전부 덮인다', () => {
    const src = readFileSync('src/game/commentary.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    const lits = new Set<string>()
    // 작은따옴표 안에 한글이 든 리터럴. 이스케이프·줄바꿈이 든 것은 제외한다(템플릿·코드).
    for (const m of src.matchAll(/'([^'\\\n]*[가-힣][^'\\\n]*)'/g)) {
      const s = m[1]
      // 8자 이상 + 종결부호로 끝난다 = 발화 문장. 라벨('골키퍼')·키('전반')는 걸리지 않는다.
      if (s.length >= 8 && '.!?'.includes(s[s.length - 1])) lits.add(s)
    }
    // 그물이 통째로 비면(정규식이 코드 변화에 밀려 아무것도 못 잡으면) 그 자체가 회귀다.
    expect(lits.size).toBeGreaterThan(80)
    expect([...lits].filter(s => !covered(sanitizeSpeech(s)))).toEqual([])
  })
})
