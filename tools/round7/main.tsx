// 7라운드 ① 증거 하니스 — **개발 전용**. 프로덕션 번들에 포함되지 않는다.
// 드리블 돌파 루트(goal.e)를 생산 경로(buildSequence)로 뽑아 Match3D에 그대로 먹인다.
// dwell을 늘려 프레임을 촘촘히 캡처할 수 있게 한다.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { makeTestTeam } from '../../src/engine/fixtures/testTeams'
import { createMatch } from '../../src/engine/simulate'
import { buildSequence, sceneKeyFor } from '../../src/ui/pitch/choreography'
import { Match3D } from '../../src/ui/pitch/three/Match3D'
import type { AttackPattern, MatchEvent } from '../../src/engine/types'

const params = new URLSearchParams(location.search)
// ★ 2026-08-01(9라운드) `key`는 **쉼표로 나눈 부분 문자열 전부**를 요구한다(AND).
//   계열 10종 · 존 2종으로 칸이 늘면서 `central.a/goal.a/L0/Zin`처럼 완전한 키를 그대로
//   요구하면 한 전술에서 5,000분에 한 번밖에 안 나온다. 조건을 느슨하게 나눠 건다.
const wantKey = (params.get('key') ?? 'goal.e').split(',').filter(Boolean)
// 어떤 attackPattern으로 장면을 뽑을지(존·계열 분포가 여기서 갈린다).
const wantPattern = params.get('pattern') as AttackPattern | null
const DWELL = Number(params.get('dwell') ?? 36000)

const home = makeTestTeam('kor', 82)
const away = makeTestTeam('esp', 84)
const state = createMatch(home, away, { seed: 42 })
if (wantPattern) state.home.tactics.attackPattern = wantPattern
const shooter = state.home.tactics.lineup[9].playerId

let ev: MatchEvent | null = null
let key = ''
for (let minute = 1; minute <= 20000 && !ev; minute++) {
  const cand: MatchEvent = { minute, type: 'goal', teamId: home.id, playerId: shooter }
  const k = sceneKeyFor(cand, state.home, state.away) ?? ''
  if (wantKey.every(w => k.includes(w))) { ev = cand; key = k }
}
if (!ev) throw new Error(`장면 ${wantKey.join(' + ')}를 못 찾았다`)
const seq = buildSequence(ev, state.home, state.away)

// 캡처 스크립트가 읽는 계약.
;(window as unknown as Record<string, unknown>).__probe = {
  key,
  minute: ev.minute,
  dwellMs: DWELL,
  shooter,
  steps: seq.map(s => ({ t: s.t, carrier: s.carrier ?? null, ball: s.ball })),
}

/**
 * three 초기화·씬 구축은 1초 가까이 걸린다. 그 사이에 시퀀스를 물려 두면 캡처 스크립트의
 * 벽시계와 Match3D의 내부 클럭이 그만큼 어긋나 프레임 t 라벨이 전부 틀어진다.
 * 그래서 **빈 상태로 먼저 띄워 놓고**, 캡처 스크립트가 `__start()`를 부르는 순간에만
 * 시퀀스를 꽂는다 — Match3D는 `sequence` 참조가 바뀌면 그 프레임에 클럭을 리셋한다.
 */
function Probe() {
  const [started, setStarted] = useState(false)
  ;(window as unknown as Record<string, unknown>).__start = () => setStarted(true)
  return (
    <Match3D
      state={state}
      lastEvent={ev!}
      event={started ? ev! : null}
      sequence={started ? seq : undefined}
      dwellMs={DWELL}
      sequenceSide="home"
    />
  )
}

createRoot(document.getElementById('root')!).render(<Probe />)
