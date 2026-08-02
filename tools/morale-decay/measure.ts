// 사기 감쇠(단조 감소 + 체력 연동) 실측 도구.
//  ① 대표 궤적 3개(체력 넉넉 / 90분 풀타임 주전 / 체력 바닥)
//  ② 사기 80 도달 가능성 — 감독이 낼 수 있는 최선의 궤적
//  ③ 평균 득점(runBatch n=300) — 감쇠 전후 비교용
// 실행: npx tsx tools/morale-decay/measure.ts
import { createMatch, simulateSegment, normalizeMorale, moraleFloor, moraleDecayAmount, moraleDecaySteps } from '../../src/engine/simulate'
import { runBatch } from '../../src/engine/calibrate'
import { loadTeam, TEAM_IDS, type TeamId } from '../../src/data/loader'

const MARKS = [15, 30, 45, 60, 75, 90]

// ── ① 대표 궤적: 감쇠 규칙만 순수 적용(엔진 밖에서 같은 식을 돌린다) ──
function trace(staminaAt: (m: number) => number): number[] {
  let morale = 70
  const out: number[] = []
  for (let m = 1; m <= 90; m++) {
    if (moraleDecaySteps(m) !== moraleDecaySteps(m - 1)) {
      const s = staminaAt(m)
      const f = moraleFloor(s)
      if (morale > f) morale = normalizeMorale(Math.max(f, morale - moraleDecayAmount(s)))
    }
    if (MARKS.includes(m)) out.push(morale)
  }
  return out
}

console.log('## ① 대표 궤적 (분: ' + MARKS.join(' / ') + ')')
console.log('체력 넉넉(항상 100)        :', trace(() => 100).join(' / '))
// 90분 풀타임 주전의 실제 체력 곡선은 아래 ①-b에서 엔진 실측으로 대체한다(여기선 선형 근사).
console.log('풀타임 근사(100→40 선형)   :', trace(m => 100 - 60 * m / 90).join(' / '))
console.log('체력 바닥(30분에 0)        :', trace(m => Math.max(0, 100 - 100 * m / 30)).join(' / '))

// ①-b 엔진 실측: 개입 없이 90분. 선발 XI의 분별 사기·체력을 실제 시뮬에서 뽑는다.
{
  const kor = loadTeam('kor'), rsa = loadTeam('rsa')
  let st = createMatch(kor, rsa, { seed: 4242 })
  const lineup = st.home.tactics.lineup.map(l => l.playerId)
  const rows: string[] = []
  for (const mark of MARKS) {
    st = simulateSegment(st, mark)
    const mor = lineup.map(id => st.home.moraleByPlayer[id])
    const sta = lineup.map(id => st.home.staminaByPlayer[id])
    const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)
    rows.push(`${mark}': 사기 평균 ${avg(mor)} (최저 ${Math.min(...mor)}) · 체력 평균 ${avg(sta)}`)
  }
  console.log('\n## ①-b 엔진 실측(kor-rsa seed 4242, 개입 없음)')
  for (const r of rows) console.log('  ' + r)
}

// ── ② 사기 80 도달 가능성 ──
// 감독의 최선: 하프타임 팀토크(격노/격려 최대치 +8~+11 상당)와 외침(쿨다운 5분 → 최대 17회)을
// 엔진 밖에서 같은 크기로 흉내 낸다. matchStore가 실제로 하는 일과 같은 연산이다
// (normalizeMorale(m + delta)).
{
  console.log('\n## ② 사기 80 도달 (선발 XI 평균 사기 최고점)')
  const scenario = (label: string, shoutMinutes: number[], talk: number, shout: number) => {
    const st0 = createMatch(loadTeam('kor'), loadTeam('rsa'), { seed: 4242 })
    let st = st0
    const lineup = st.home.tactics.lineup.map(l => l.playerId)
    const avgMorale = () => lineup.reduce((a, id) => a + st.home.moraleByPlayer[id], 0) / lineup.length
    let peak = avgMorale()
    const bump = (delta: number) => {
      for (const id of Object.keys(st.home.moraleByPlayer)) {
        st.home.moraleByPlayer[id] = normalizeMorale(st.home.moraleByPlayer[id] + delta)
      }
    }
    const stops = [...new Set([...shoutMinutes, 45])].sort((a, b) => a - b)
    for (const m of stops) {
      st = simulateSegment(st, m)
      if (m === 45 && talk) bump(talk)
      if (shoutMinutes.includes(m)) bump(shout)
      peak = Math.max(peak, avgMorale())
    }
    console.log(`  ${label}: ${peak.toFixed(1)} ${peak >= 80 ? '→ 80 도달 ✅' : '→ 80 미달 ❌'}`)
  }
  scenario('개입 없음                          ', [], 0, 0)
  scenario('HT 팀토크(+8)만                    ', [], 8, 0)
  scenario('HT 팀토크(+8) + 외침 3회(+4)       ', [20, 50, 70], 8, 4)
  scenario('HT 팀토크(+11) + 외침 5회(+6, 지는중)', [10, 25, 40, 55, 70], 11, 6)
  const every5 = Array.from({ length: 18 }, (_, i) => (i + 1) * 5)
  scenario('외침 쿨다운 최대 활용(5분마다 +4)  ', every5, 8, 4)
}

// ── ③ 평균 득점 ──
{
  console.log('\n## ③ 평균 득점(runBatch n=300)')
  const pairs: [TeamId, TeamId][] = [['kor', 'rsa'], ['kor', 'cze'], ['esp', 'arg'], ['kor', 'esp']]
  let total = 0
  for (const [h, a] of pairs) {
    const r = runBatch(loadTeam(h), loadTeam(a), 300)
    const g = r.avg.home.goals + r.avg.away.goals
    total += g
    console.log(`  ${h}-${a}: 홈 ${r.avg.home.goals.toFixed(3)} · 원정 ${r.avg.away.goals.toFixed(3)} · 합계 ${g.toFixed(3)} · 홈 슛 ${r.avg.home.shots.toFixed(2)}`)
  }
  console.log('  4매치업 합계 평균:', (total / pairs.length).toFixed(4))
  void TEAM_IDS
}
