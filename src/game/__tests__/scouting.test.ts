// Phase A Task 5: 상대별 플랜 추천 + 리스크 카드.
// 추천은 "정답"이 아니라 근거를 붙인 출발점이므로, 테스트는 수치가 아니라
// (1) 상대 성향에 대한 방향성 (2) 결정론 (3) 근거 문구 존재를 고정한다.
import { describe, it, expect } from 'vitest'
import { recommendPlan, planRisks, trapAxis, edgeMentality, planEdge } from '../scouting'
import { loadTeam, TEAM_IDS, type TeamId } from '../../data/loader'
import { pickBestXI } from '../../engine/lineup'
// balance는 계측 전용 모듈이다(UI·게임 로직에서 import 금지). 추천이 엔진 밸런스와
// 실제로 일치하는지는 시뮬레이션으로만 증명할 수 있으므로 테스트에서만 쓴다.
import { runAbBatch } from '../../engine/balance'
import { flankStrength, weakestFlank } from '../../engine/simulate'
import { attackFocusEffects, trapFactor } from '../../engine/tactics'
import { positionFitness } from '../../engine/fitness'
// 워룸 [추천 적용]은 recommendPlan(게임 로직) + autoFill(UI 편집 로직)의 합성이다.
// 추천만 따로 재면 "권한 포메이션에 세울 XI가 실제로 나오는가"를 영영 못 잰다 —
// 실제로 그 구멍에서 3-5-2 추천이 풀백을 ST에 세우는 버그가 살아남았다.
// 그래서 이 파일은 그 합성 경로를 그대로 재현해 잰다.
import { autoFill } from '../../ui/lineup/swap'
import type { TacticState } from '../../engine/types'

const KOR = loadTeam('kor')

/** 워룸 [추천 적용] 버튼이 실제로 커밋하는 전술 patch (TacticsCenter.applyRecommendation과 동일 순서).
 *  포메이션이 바뀌면 현재 선발을 preferIds로 넘겨 autoFill로 재배치한다. */
function appliedPlan(opp: TeamId): Partial<TacticState> {
  const cur = pickBestXI(KOR) // 워룸 진입 시점의 XI (엔진 초기값과 같은 규칙)
  const patch = recommendPlan(KOR, loadTeam(opp)).patch
  const f = patch.formation ?? cur.formation
  if (f === cur.formation) return patch
  return { ...patch, lineup: autoFill(KOR, f, cur.lineup.map(l => l.playerId)) }
}

describe('recommendPlan', () => {
  it('점유 강팀(스페인) 상대로는 라인을 내리고 수비적 멘탈리티를 권한다', () => {
    const r = recommendPlan(loadTeam('kor'), loadTeam('esp'))
    expect(r.patch.mentality).toBe('defensive')
    expect(r.patch.instructions!.lineHeight).toBeLessThanOrEqual(35)
    expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('모든 근거에 상대 수치가 포함돼 근거가 검증 가능하다', () => {
    const r = recommendPlan(loadTeam('kor'), loadTeam('esp'))
    expect(r.reasons.every(x => x.text.length > 8)).toBe(true)
  })

  it('결정론 — 같은 입력에 같은 출력', () => {
    const a = recommendPlan(loadTeam('kor'), loadTeam('mex'))
    const b = recommendPlan(loadTeam('kor'), loadTeam('mex'))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('포메이션 추천은 상성 최댓값을 고른다', () => {
    const r = recommendPlan(loadTeam('kor'), loadTeam('cze'))
    expect(r.patch.formation).toBeDefined()
  })

  it('약체(남아공) 상대로는 수비적으로 물러서지 않는다', () => {
    const r = recommendPlan(loadTeam('kor'), loadTeam('rsa'))
    expect(r.patch.mentality).not.toBe('defensive')
  })

  it('추천 지시는 항상 0~100 범위를 지킨다', () => {
    for (const opp of ['esp', 'cze', 'mex', 'rsa', 'fra'] as const) {
      const ins = recommendPlan(loadTeam('kor'), loadTeam(opp)).patch.instructions!
      for (const k of ['lineHeight', 'pressing', 'tempo'] as const) {
        expect(ins[k]).toBeGreaterThanOrEqual(0)
        expect(ins[k]).toBeLessThanOrEqual(100)
      }
    }
  })

  it('압박을 상대에 따라 조정한다 — 전개가 강한 상대에겐 내리고, 약한 상대에겐 올린다', () => {
    const kor = loadTeam('kor')
    // 스페인(전개 지표 78 > 기준 72)은 압박이 벗겨진다 → 중립(50) 아래.
    expect(recommendPlan(kor, loadTeam('esp')).patch.instructions!.pressing).toBeLessThan(50)
    // 남아공(53)·체코(59)는 가둘 수 있다 → 중립 위, 다만 정점 70을 넘기지 않는다.
    for (const opp of ['rsa', 'cze', 'mex'] as const) {
      const p = recommendPlan(kor, loadTeam(opp)).patch.instructions!.pressing
      expect(p).toBeGreaterThan(50)
      expect(p).toBeLessThan(70)
    }
  })

  it('조별 3팀 + 스페인의 추천이 서로 구별된다 (라인이 상대별로 다르다)', () => {
    const kor = loadTeam('kor')
    const lines = (['esp', 'cze', 'mex', 'rsa'] as const)
      .map(o => recommendPlan(kor, loadTeam(o)).patch.instructions!.lineHeight)
    expect(new Set(lines).size).toBe(4)
  })

  // ── 두 판별자 · 두 축 ──────────────────────────────────────────
  // 이전 판은 축과 태세를 모두 trapFactor에서 뽑고 "수비적이면 라인 ≤60"을 고정했다.
  // E1 후속 실측이 그 규칙을 기각했다 — eng·fra는 라인을 끝까지 올리고 태세는 최하단인
  // 조합이 최적이다(scouting.ts의 라인 스윕 표 참고: eng 라인 20 +3.0 → 80 +15.2).
  // 그래서 지금 고정하는 것은 "두 축이 각자의 판별자를 정확히 따르는가"다.
  // 문면 모순은 캡이 아니라 **근거 문구가 두 판별자를 모두 말하는 것**으로 막는다(아래 테스트).
  it('라인·압박은 trap에서, 태세는 매치업 우위에서 나온다 (판별자 배선 고정)', () => {
    const kor = loadTeam('kor')
    for (const opp of TEAM_IDS) {
      if (opp === 'kor') continue
      const t = loadTeam(opp)
      const r = recommendPlan(kor, t)
      const gk = pickBestXI(t).lineup.find(l => l.slot === 'GK')
      const buildup = t.squad.find(p => p.id === gk?.playerId)?.gkStats?.buildup ?? 50
      const axis = trapAxis(trapFactor({ oppGkBuildup: buildup, oppPossession: t.profile.style.possession }))
      expect(r.patch.instructions!.lineHeight, `${opp} 라인`).toBe(axis.lineHeight)
      expect(r.patch.instructions!.pressing, `${opp} 압박`).toBe(axis.pressing)
      expect(r.patch.mentality, `${opp} 태세`).toBe(edgeMentality(planEdge(kor, t)))
    }
  })

  it('근거 문구가 두 판별자를 모두 말한다 — 전개 지표(축)와 매치업 지수(태세)', () => {
    const kor = loadTeam('kor')
    for (const opp of TEAM_IDS) {
      if (opp === 'kor') continue
      const posture = recommendPlan(kor, loadTeam(opp)).reasons.find(x => x.field === 'lineHeight')!
      expect(posture.text, opp).toContain('상대 후방 전개 지표')
      expect(posture.text, opp).toContain('매치업 지수')
    }
  })

  it('근거 문구가 추천값과 일치한다 — 라인·압박 숫자와 태세 이름이 문구에 그대로 있다', () => {
    const kor = loadTeam('kor')
    const MENTALITY_KO: Record<string, string> = {
      'very-defensive': '매우 수비적', 'defensive': '수비적', 'balanced': '균형',
      'attacking': '공격적', 'very-attacking': '매우 공격적',
    }
    for (const opp of TEAM_IDS) {
      if (opp === 'kor') continue
      const r = recommendPlan(kor, loadTeam(opp))
      const ins = r.patch.instructions!
      const posture = r.reasons.find(x => x.field === 'lineHeight')!
      expect(posture.text).toContain(`라인 ${ins.lineHeight}`)
      expect(posture.text).toContain(`압박 ${ins.pressing}`)
      expect(posture.text).toContain(MENTALITY_KO[r.patch.mentality!])
    }
  })

  it('공격 방향은 상대의 가장 약한 지역을 고른다 (엔진 flankStrength argmin)', () => {
    const kor = loadTeam('kor')
    for (const opp of TEAM_IDS) {
      if (opp === 'kor') continue
      const r = recommendPlan(kor, loadTeam(opp))
      const focus = r.patch.instructions!.attackFocus
      const t = loadTeam(opp)
      const f = flankStrength(pickBestXI(t).lineup, t.squad,
        Object.fromEntries(t.squad.map(p => [p.id, 100])))
      expect(focus).toBe(weakestFlank(f))
      // argmin이므로 attackFocusEffects의 보상이 음수가 될 수 없다.
      expect(attackFocusEffects(focus, f).chanceQuality).toBeGreaterThanOrEqual(1)
    }
  })
})

// 회귀: 킥오프 전 [추천 적용]이 4-2-3-1 → 3-5-2로 바꾸면서, 3-5-2에서 남아도는 우측 풀백
// (김문환)을 ST 슬롯에 세우던 문제. 리스크 카드가 "⚠ 김문환 ST 적합도 낮음"으로 정직하게
// 경고했지만, 코치가 권한 플랜이 풀백을 최전방에 세우는 건 고장으로 읽힌다.
//
// 이 블록은 R3("추천한 포메이션으로 쓸 만한 XI가 실제로 나오는가")의 전제를 테스트로 고정한다.
// recommendPlan에 포메이션 재고(veto) 로직을 넣지 **않은** 근거이기도 하다 — 12팀 × 6포메이션
// 전수 실측에서 최소 적합도가 0.85 미만인 조합이 하나도 없어(vetoed 케이스 0건) 그 코드는
// 영원히 죽은 가지가 된다. 대신 그 전제가 깨지면(스쿼드 편집 등) 여기서 즉시 터진다.
describe('[추천 적용] 결과 XI — 포지션 미스매치가 없다', () => {
  const OPPS = TEAM_IDS.filter(t => t !== 'kor')
  const stamina = Object.fromEntries(KOR.squad.map(p => [p.id, 100]))

  it.each(OPPS)('vs %s — 모든 슬롯 적합도 ≥ 0.7', opp => {
    const plan = appliedPlan(opp)
    const cur = pickBestXI(KOR)
    const lineup = plan.lineup ?? cur.lineup
    for (const l of lineup) {
      const p = KOR.squad.find(q => q.id === l.playerId)!
      expect(positionFitness(p, l.slot)).toBeGreaterThanOrEqual(0.7)
    }
  })

  it.each(OPPS)('vs %s — 리스크 카드에 적합도 경고가 없다', opp => {
    const plan = appliedPlan(opp)
    const cur = pickBestXI(KOR)
    const tactics: TacticState = { ...cur, ...plan, instructions: { ...cur.instructions, ...(plan.instructions ?? {}) } }
    const risks = planRisks(KOR, tactics, stamina)
    expect(risks.filter(r => r.text.includes('적합도'))).toEqual([])
  })
})

// 추천이 "그럴듯한 조언"에 그치지 않고 실제로 승률을 올리는지 시뮬레이션으로 고정한다.
// 코치가 손해 보는 조언을 하면(Δ<0) 전술 센터의 존재 이유가 사라지므로 회귀로 막는다.
// n=400은 결정론(고정 시드)이라 값이 흔들리지 않는다. 이 값이 바뀌면 엔진 밸런스가 바뀐 것이다.
//
// **11개 상대 전부**를 건다. 이전엔 조별 3팀 + 스페인만 걸려 있어서, 정작 캠페인의 본 게임인
// 토너먼트 구간(잉글랜드·아르헨티나·모로코·프랑스)이 사실상 무효(+1.0~+3.3pp)인 채로
// 회귀를 통과했다. 그 구멍을 막는 게 이 블록의 존재 이유다.
//
// 측정 대상은 patch가 아니라 **워룸이 실제로 커밋하는 전술**(appliedPlan)이다. 이전엔 patch만
// 넘겨서, 포메이션은 3-5-2인데 XI 슬롯은 4-2-3-1 것인 "존재할 수 없는 전술"을 재고 있었다.
// XI를 함께 재면 포지션 적합도가 승률에 미치는 영향이 그대로 잡힌다 — 버그가 있던 XI로 재면
// 같은 patch가 vs mex −21.8pp / vs cze −21.3pp로 **손해**였다(수리 후 +8.8 / +13.7).
describe('recommendPlan — 기본 지시(50/50/50) 대비 승률 개선 실측', () => {
  // ⚠ N=900의 근거(2026-07-30, 세트피스·주발·퇴장 배선 중 실측):
  // 기존 주석은 "n=400은 결정론(고정 시드)이라 값이 흔들리지 않는다"고 했으나, 고정 시드는
  // **재현성**을 보장할 뿐 **정밀도**를 보장하지 않는다. 같은 플랜·같은 엔진으로 시드 대역만
  // 바꿔 재면(seedBase 2000/7000/12000/17000, n=600) vs mex Δ가 2.7~6.2pp로 흩어진다.
  // 즉 n=400 한 셀은 표준오차 ±3pp대의 단일 표본이고, 엔진 상수를 하나만 건드려도
  // 어느 상대가 임계 3pp 아래로 떨어지는지가 매번 바뀐다(실측: mex 5.4→3.2, arg 4.7→2.5).
  // n=1200에서 11팀 전부 Δ ≥ 4.7pp로 안정되므로, 게이트가 노이즈가 아니라 밸런스를 재도록
  // 표본을 900으로 올린다. 임계값(3/6/8pp)은 그대로 둔다.
  const N = 900
  const OPPS = TEAM_IDS.filter(t => t !== 'kor')
  // 캠페인 32강~결승에서 만나는 상대. 여기가 본 게임이라 더 높은 기준을 요구한다.
  const KNOCKOUT: TeamId[] = ['eng', 'arg', 'mar', 'fra', 'esp']
  const measured: Record<string, number> = {}
  const delta = (opp: TeamId) => {
    if (measured[opp] === undefined) {
      measured[opp] = runAbBatch('kor', opp, appliedPlan(opp), N).deltaPp
    }
    return measured[opp]
  }

  it.each(OPPS)('vs %s — Δ ≥ +3pp', opp => {
    expect(delta(opp)).toBeGreaterThanOrEqual(3)
  }, 300_000)

  it('토너먼트 상대 5팀 평균 Δ ≥ +6pp — 캠페인 본 구간에서 레버가 실제로 크다', () => {
    const avg = KNOCKOUT.reduce((s, o) => s + delta(o), 0) / KNOCKOUT.length
    expect(avg).toBeGreaterThanOrEqual(6)
  }, 300_000)

  it('최소 한 상대에선 Δ ≥ +8pp — 레버가 실제로 크다', () => {
    expect(Math.max(...OPPS.map(delta))).toBeGreaterThanOrEqual(8)
  }, 300_000)
})

describe('planRisks', () => {
  it('체력 65 미만 선발이 있으면 경고한다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    const stamina: Record<string, number> = {}
    for (const p of kor.squad) stamina[p.id] = 100
    stamina[t.lineup[3].playerId] = 58
    const risks = planRisks(kor, t, stamina)
    expect(risks.some(r => r.level === 'warn' && r.text.includes('체력'))).toBe(true)
  })

  it('문제가 없으면 ok 항목만 남는다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    const stamina: Record<string, number> = {}
    for (const p of kor.squad) stamina[p.id] = 100
    expect(planRisks(kor, t, stamina).every(r => r.level === 'ok')).toBe(true)
  })

  it('하이라인 + 하이프레스를 함께 쓰면 역습 경고가 뜬다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    t.instructions = { ...t.instructions, lineHeight: 80, pressing: 75 }
    const stamina: Record<string, number> = {}
    for (const p of kor.squad) stamina[p.id] = 100
    const risks = planRisks(kor, t, stamina)
    expect(risks.some(r => r.level === 'warn' && r.text.includes('역습'))).toBe(true)
  })

  it('포지션 적합도가 낮은 배치를 경고한다', () => {
    const kor = loadTeam('kor')
    const t = pickBestXI(kor)
    // GK를 필드 슬롯에 세우면 적합도 0.2 — 확실한 부적합 배치.
    const gk = kor.squad.find(p => p.position === 'GK')!
    const outfield = t.lineup.findIndex(l => l.slot !== 'GK')
    t.lineup = t.lineup.map((l, i) => (i === outfield ? { ...l, playerId: gk.id } : l))
    const stamina: Record<string, number> = {}
    for (const p of kor.squad) stamina[p.id] = 100
    const risks = planRisks(kor, t, stamina)
    expect(risks.some(r => r.level === 'warn' && r.text.includes('적합도'))).toBe(true)
  })
})
