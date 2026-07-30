// 3D 하이라이트 ↔ 2D 작전판 배분과 **반복 측정**.
//
// 장면 라이브러리는 유한하다. 모든 이벤트를 3D로 돌리면 같은 그림이 금방 눈에 띈다.
// 이 테스트는 실엔진 90분에서 (1) 3D 비중이 과하지 않고 (2) 한 경기 안에서 같은 장면이
// 몇 번 나오는지를 **수치로** 고정한다. 회귀하면 여기서 잡힌다.
import { describe, it, expect } from 'vitest'
import type { AttackPattern } from '../../../engine/types'
import { makeTestTeam } from '../../../engine/fixtures/testTeams'
import { createMatch, simulateSegment } from '../../../engine/simulate'
import { sceneKeyFor, buildSequence } from '../../pitch/choreography'
import { DRAMA_PRIORITY, HIGHLIGHT_TYPES, isHighlightEvent, pickDramaEvent } from '../playback'

const home = makeTestTeam('kor', 76)
const away = makeTestTeam('esp', 88)
const SEEDS = [1000, 1003, 1005, 1009, 1011]
/** 반복 측정 전용 — 5시드는 과적합이었다(아래 주석). 4패턴 × 30시드 = 120회로 잰다. */
const REPEAT_SEEDS = Array.from({ length: 30 }, (_, i) => 1000 + i)
const PATTERNS: AttackPattern[] = ['balanced', 'cross', 'through', 'longshot']

function play(seed: number, pattern: AttackPattern) {
  let st = createMatch(home, away, { seed })
  st.home.tactics.attackPattern = pattern
  for (let m = 1; m <= 90; m++) st = simulateSegment(st, m)
  return st
}

describe('하이라이트 선택자 — Phase C 중계와 같은 규칙 위에 있다', () => {
  it('HIGHLIGHT_TYPES는 DRAMA_PRIORITY의 부분집합이다(안무 없는 타입 금지)', () => {
    for (const t of HIGHLIGHT_TYPES) expect(DRAMA_PRIORITY).toContain(t)
  })
  it('하이라이트로 뽑힌 이벤트는 반드시 안무가 있다', () => {
    const st = play(1003, 'cross')
    for (let m = 1; m <= 90; m++) {
      const d = pickDramaEvent(st.events.filter(e => e.minute === m))
      if (!d || !isHighlightEvent(d)) continue
      expect(buildSequence(d, st.home, st.away).length).toBeGreaterThan(0)
    }
  })
})

describe('3D/2D 배분', () => {
  it('3D는 전체 분의 15~40%만 차지한다 — 나머지는 2D 작전판', () => {
    for (const pattern of PATTERNS) {
      let live3d = 0
      let total = 0
      for (const seed of SEEDS) {
        const st = play(seed, pattern)
        for (let m = 1; m <= 90; m++) {
          total++
          const d = pickDramaEvent(st.events.filter(e => e.minute === m))
          if (d && isHighlightEvent(d)) live3d++
        }
      }
      const share = live3d / total
      expect(share, `${pattern} 3D 비중 ${(share * 100).toFixed(0)}%`).toBeGreaterThan(0.15)
      expect(share, `${pattern} 3D 비중 ${(share * 100).toFixed(0)}%`).toBeLessThan(0.4)
    }
  })
})

describe('★ 반복 측정 — 한 경기에서 같은 장면이 몇 번 나오는가', () => {
  // ── 왜 이 임계인가 (2026-07-30 재측정·개선) ────────────────────────────────
  // 게이트가 두 번 흔들렸다. 처음엔 "≤3"이었는데 5시드 과적합이었고, 그다음 실측대로
  // "≤6 / 평균 4.5"로 넓혔다. 이번에는 **원인을 재서** 다시 조인다.
  //
  // 진단(4패턴 × 30시드 = 120회):
  //  · 반복되는 조합은 특정 레인이 아니었다. 실제로 등장한 이벤트 키 542종의 레인 분포는
  //    χ² = 2.4(자유도 5) — 완전 균일이다. 해시 편향이 아니다.
  //  · 원인은 **칸 수**였다. 라이브러리는 124조합이지만 경기 안에서 도달 가능한 칸은
  //    124가 아니다: attackPattern이 빌드업을 팀당 1종으로 고정하고, 하이라이트로 뽑히는
  //    결과는 사실상 3종뿐이다(실측 2802건: miss 1156 · save 1033 · goal 597 · red 16,
  //    shot·chance는 그 분의 주인공으로 뽑히지 않는다). 즉 팀당 3 × 6레인 = 18칸,
  //    양 팀 36칸에 하이라이트 24개를 던지고 있었다 — 반복은 생일 문제로 강제된 것이다.
  //  · 검증: 레인을 "완벽 균일 난수"로 갈아끼운 대조군도 최다 반복 평균 3.00(2회 29 /
  //    3회 65 / 4회 23 / 5회 3)으로 당시 실측(2.95)과 통계적으로 같았다. 선택자는
  //    이미 최선이었고 고칠 것은 칸 수뿐이었다.
  //
  // 처방(scenes.ts): 빌드업 실행 변형 ×2, 마무리 변형 ×3을 축으로 추가해 팀당 108칸,
  // 양 팀 216칸으로 늘렸다. 변형은 전부 결정론 해시(축마다 다른 salt)로 고른다.
  //
  // 전후 히스토그램(같은 120회):
  //   전  최다반복 2회 26 / 3회 74 / 4회 20        → 평균 2.95, 고유 min 10 · 평균 16.6
  //   후  최다반복 1회 38 / 2회 74 / 3회  8        → 평균 1.75, 고유 min 14 · 평균 22.8
  //   (하이라이트 24.1개 중 고유 22.8개 = 사실상 매번 다른 그림)
  //
  // 임계는 실측 최대(3)에 한 칸 여유를 둔 4, 평균은 실측 1.75에 여유를 둔 2.5로 건다.
  // 여유를 두는 이유: 엔진 밸런스가 바뀌면 이벤트 구성이 흔들려 꼬리가 한 칸 움직인다.
  // 여유 없이 실측값에 딱 맞추는 것이 지난 두 번의 과적합이었다.
  it('장면 반복 — 개별 실행 ≤ 4, 평균 ≤ 2.5, 고유 장면 ≥ 12', () => {
    const repeats: number[] = []
    const shares: number[] = []
    for (const pattern of PATTERNS) {
      for (const seed of REPEAT_SEEDS) {
        const st = play(seed, pattern)
        const counts = new Map<string, number>()
        for (let m = 1; m <= 90; m++) {
          const d = pickDramaEvent(st.events.filter(e => e.minute === m))
          if (!d || !isHighlightEvent(d)) continue
          const k = sceneKeyFor(d, st.home, st.away)!
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        const played = [...counts.values()].reduce((a, b) => a + b, 0)
        const maxRepeat = Math.max(...counts.values())
        expect(played, `${pattern}/${seed} 3D 장면 수`).toBeGreaterThan(10)
        expect(counts.size, `${pattern}/${seed} 고유 장면 ${counts.size}`).toBeGreaterThanOrEqual(12)
        expect(maxRepeat, `${pattern}/${seed} 최다 반복 ${maxRepeat}`).toBeLessThanOrEqual(4)
        repeats.push(maxRepeat)
        shares.push(counts.size / played)
      }
    }
    // 평균으로 꼬리를 막는다 — 개별 상한만 두면 전 실행이 4회여도 통과한다.
    const mean = repeats.reduce((a, b) => a + b, 0) / repeats.length
    expect(mean, `최다 반복 평균 ${mean.toFixed(2)}`).toBeLessThanOrEqual(2.5)
    // 고유 비율 — "장면 24개 중 몇 개가 서로 다른가". 실측 0.95, 임계는 여유를 둔 0.85.
    const share = shares.reduce((a, b) => a + b, 0) / shares.length
    expect(share, `고유 장면 비율 ${(share * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(0.85)
  })
})
