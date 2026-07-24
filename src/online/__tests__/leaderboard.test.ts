import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadAllTeams } from '../../data/loader'
import type { MatchRecord, CampaignStage } from '../../game/campaignStore'

// @supabase/supabase-js 를 mock: createClient가 from().insert()/select() 에서
// 오류를 내도록 만들어 "supabase 실패 → local 폴백" 을 검증한다.
const insertMock = vi.fn<(...a: unknown[]) => Promise<{ error: unknown }>>()
const limitMock = vi.fn<(...a: unknown[]) => Promise<{ data: unknown; error: unknown }>>()
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      insert: (...a: unknown[]) => insertMock(...a),
      select: () => ({ order: () => ({ limit: (...a: unknown[]) => limitMock(...a) }) }),
    }),
  }),
}))

import {
  computeScore,
  submitScore,
  topScores,
  _resetClientForTest,
  type Ending,
} from '../leaderboard'

const TEAMS = loadAllTeams()

function rec(
  stage: CampaignStage,
  opponentId: string,
  score: [number, number],
  shootout?: [number, number],
): MatchRecord {
  return {
    stage,
    opponentId: opponentId as MatchRecord['opponentId'],
    score,
    decisions: [],
    ...(shootout ? { shootout } : {}),
  }
}

// ── 로컬 스토리지 mock ─────────────────────────────────────
function makeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => store.clear(),
    _store: store,
  }
}

describe('computeScore', () => {
  it('우승 풀런: 라운드·승점·득실·업셋·무실점 수치 검산', () => {
    const records: MatchRecord[] = [
      rec('group1', 'cze', [2, 0]),        // 승, 무실점
      rec('group2', 'mex', [1, 0]),        // 승, 무실점, 업셋(mex 14 → 11)
      rec('group3', 'rsa', [3, 1]),        // 승
      rec('r32', 'ecu', [2, 1]),           // 승, 업셋(ecu 23 → 4)
      rec('r16', 'eng', [1, 1], [4, 3]),   // 승부차기 승, 업셋(eng 4 → 42)
      rec('qf', 'nor', [2, 0]),            // 승, 무실점
      rec('sf', 'arg', [1, 0]),            // 승, 무실점, 업셋(arg 1 → 48)
      rec('final', 'esp', [3, 2]),         // 승, 업셋(esp 2 → 46)
    ]
    const ending: Ending = { reached: 'final', champion: true }
    const s = computeScore(records, ending, TEAMS)

    expect(s.roundPts).toBe(1200)
    expect(s.matchPts).toBe(220)      // (승7×3 + 무1×1)×10 = 22×10
    expect(s.goalDiffPts).toBe(50)    // (15-5)×5
    expect(s.upsetPts).toBe(151)      // 11 + 4 + 42 + 48 + 46
    expect(s.cleanSheetPts).toBe(120) // 무실점 4경기 × 30
    expect(s.total).toBe(1741)
    expect(s.champion).toBe(true)
    expect(s.reached).toBe('final')
  })

  it('조별 탈락: 라운드 0점, 음수 득실 허용', () => {
    const records: MatchRecord[] = [
      rec('group1', 'cze', [1, 1]), // 무
      rec('group2', 'mex', [0, 2]), // 패
      rec('group3', 'rsa', [1, 1]), // 무
    ]
    const s = computeScore(records, { reached: 'group3', champion: false }, TEAMS)
    expect(s.roundPts).toBe(0)
    expect(s.matchPts).toBe(20)       // (무2 = 2점)×10
    expect(s.goalDiffPts).toBe(-10)   // (2-4)×5
    expect(s.upsetPts).toBe(0)        // 승리 없음
    expect(s.cleanSheetPts).toBe(0)
    expect(s.total).toBe(10)
  })

  it('승부차기 승은 업셋으로 인정된다', () => {
    const records = [rec('r16', 'eng', [0, 0], [5, 4])]
    const s = computeScore(records, { reached: 'r16', champion: false }, TEAMS)
    // 라운드 200 + 무 10 + 득실0 + 업셋(eng 4 → (25-4)×2=42) + 무실점 30
    expect(s.upsetPts).toBe(42)
    expect(s.matchPts).toBe(10) // 승부차기 승은 규정상 무 = 1점
    expect(s.cleanSheetPts).toBe(30)
    expect(s.total).toBe(282)
  })

  it('승부차기 패배는 업셋으로 인정되지 않는다', () => {
    const records = [rec('r16', 'eng', [0, 0], [4, 5])]
    const s = computeScore(records, { reached: 'r16', champion: false }, TEAMS)
    expect(s.upsetPts).toBe(0)
  })

  it('무실점 경기만 카운트한다', () => {
    const records = [
      rec('group1', 'cze', [1, 0]), // 무실점
      rec('group2', 'mex', [2, 2]), // 실점
      rec('group3', 'rsa', [0, 0]), // 무실점
    ]
    const s = computeScore(records, { reached: 'group3', champion: false }, TEAMS)
    expect(s.cleanSheetPts).toBe(60)
  })

  it('도달 라운드별 라운드 점수 매핑', () => {
    const cases: [CampaignStage, boolean, number][] = [
      ['group3', false, 0],
      ['r32', false, 100],
      ['r16', false, 200],
      ['qf', false, 350],
      ['sf', false, 550],
      ['final', false, 800],
      ['final', true, 1200],
    ]
    for (const [reached, champion, pts] of cases) {
      const s = computeScore([], { reached, champion }, TEAMS)
      expect(s.roundPts).toBe(pts)
    }
  })
})

describe('submitScore / topScores', () => {
  let ls: ReturnType<typeof makeLocalStorage>

  beforeEach(() => {
    ls = makeLocalStorage()
    vi.stubGlobal('localStorage', ls)
    insertMock.mockReset()
    limitMock.mockReset()
    _resetClientForTest()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    _resetClientForTest()
  })

  const BREAKDOWN = {
    roundPts: 1200, matchPts: 220, goalDiffPts: 50, upsetPts: 151, cleanSheetPts: 120,
    total: 1741, reached: 'final' as CampaignStage, champion: true,
  }

  it('env 부재 시 local 모드로 저장/조회한다', async () => {
    // 기본 vitest 환경엔 VITE_SUPABASE_* 가 없다.
    const sub = await submitScore('감독A', BREAKDOWN)
    expect(sub).toEqual({ ok: true, mode: 'local' })

    const { rows, mode } = await topScores(10)
    expect(mode).toBe('local')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ nickname: '감독A', total: 1741, champion: true })
    // supabase 클라이언트는 생성되지 않음 → insert 미호출
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('total 내림차순 정렬 + 상위 n개', async () => {
    await submitScore('낮음', { ...BREAKDOWN, total: 100 })
    await submitScore('높음', { ...BREAKDOWN, total: 900 })
    await submitScore('중간', { ...BREAKDOWN, total: 500 })
    const { rows } = await topScores(2)
    expect(rows.map(r => r.nickname)).toEqual(['높음', '중간'])
  })

  it('supabase insert 실패 시 local 폴백', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    _resetClientForTest()
    insertMock.mockResolvedValue({ error: { message: 'boom' } })

    const sub = await submitScore('감독B', BREAKDOWN)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(sub).toEqual({ ok: true, mode: 'local' })
    // 로컬에 저장되었는지 확인
    expect(ls._store.get('rematch-leaderboard')).toContain('감독B')
  })

  it('supabase select 실패 시 local 폴백', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    _resetClientForTest()
    limitMock.mockRejectedValue(new Error('network'))
    // 로컬에 미리 하나 심어둔다
    ls._store.set('rematch-leaderboard', JSON.stringify([
      { nickname: '로컬', total: 300, reached: 'r16', champion: false },
    ]))

    const { rows, mode } = await topScores(10)
    expect(mode).toBe('local')
    expect(rows[0].nickname).toBe('로컬')
  })

  it('supabase 정상 응답 시 supabase 모드', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    _resetClientForTest()
    insertMock.mockResolvedValue({ error: null })
    limitMock.mockResolvedValue({
      data: [{ nickname: '온라인', total: 999, reached: 'final', champion: true }],
      error: null,
    })

    const sub = await submitScore('온라인', BREAKDOWN)
    expect(sub.mode).toBe('supabase')
    const { rows, mode } = await topScores(10)
    expect(mode).toBe('supabase')
    expect(rows[0].nickname).toBe('온라인')
  })

  it('로컬 저장은 상위 50개만 유지한다', async () => {
    for (let i = 0; i < 60; i++) {
      await submitScore(`감독${i}`, { ...BREAKDOWN, total: i })
    }
    const stored = JSON.parse(ls._store.get('rematch-leaderboard')!)
    expect(stored).toHaveLength(50)
    // 가장 높은 total(59)이 맨 앞
    expect(stored[0].total).toBe(59)
  })
})
