// Phase A Task 5: 상대별 플랜 추천 + 리스크 카드.
// 추천은 "정답"이 아니라 근거를 붙인 출발점이므로, 테스트는 수치가 아니라
// (1) 상대 성향에 대한 방향성 (2) 결정론 (3) 근거 문구 존재를 고정한다.
import { describe, it, expect } from 'vitest'
import { recommendPlan, planRisks } from '../scouting'
import { loadTeam } from '../../data/loader'
import { pickBestXI } from '../../engine/lineup'

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
