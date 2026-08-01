#!/usr/bin/env node
// tools/touchline-balance/run.mjs
//
// 터치라인 확장 개방(2026-08-01)의 밸런스 실측. 묻는 것은 하나다:
//   **"항상 전부 최대"가 지배 전략이 되었는가?**
// 축을 여덟 개로 늘리고 자유 개입을 자원화했으니, 개입 폭이 그대로 승률로 환산되면
// 게임이 "다이얼을 끝까지 돌리는 문제"가 된다. 그러면 안 된다.
//
// 방법(3f4af06이 쓴 방식이 정본이다):
//   kor 홈 · 상대 5팀 · n=SEEDS 페어드 · **개입 없는 경기 대비** 승률 차(pp)
//   페어드 설계이므로 SE는 시드별 차이 d_i = win(전략) - win(기준)의 표준오차다.
//   판정 규칙: |차이| < 2·SE 이면 **판정 불가**(노이즈와 구분되지 않는다)라고 쓴다.
//
// ★ 중요 — 규칙을 우회하지 않는다.
//   값을 엔진에 직접 꽂으면 측정이 거짓말이 된다(현실의 유저는 창·쿨다운·폭 제한을
//   통과해야 한다). 그래서 이 스크립트는 **실제 matchStore를 그대로 몬다** —
//   pauseByUser / submitCommand / confirmTactics를 유저와 같은 경로로 호출하고,
//   목표 전술은 store가 허용하는 만큼만 클램프해서 넣는다.
//
// 결정론: 시드는 --base(기본 20260801)부터 1씩 증가하는 정수뿐이다.
//   Math.random·Date 미사용. 같은 인자면 같은 표가 나온다.
//
// 사용:
//   node tools/touchline-balance/run.mjs
//   node tools/touchline-balance/run.mjs --seeds 400 --base 20260801
import { createServer } from 'vite'

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d }
const SEEDS = arg('seeds', 400)
const BASE_SEED = arg('base', 20260801)
const OPPONENTS = ['rsa', 'mex', 'esp', 'fra', 'arg']

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const { loadTeam } = await server.ssrLoadModule('/src/data/loader.ts')
const store = await server.ssrLoadModule('/src/game/matchStore.ts')
const { MENTALITIES } = await server.ssrLoadModule('/src/engine/tactics.ts')
const {
  useMatchStore, freeInterventionState, TOUCHLINE_STEP, TOUCHLINE_RANK_STEP,
} = store

const s = () => useMatchStore.getState()
const kor = loadTeam('kor')

// ── 전략별 목표 전술 ────────────────────────────────────────────────
// "전부 최대 공격" / "전부 최대 수비"는 여덟 축을 **동시에** 한쪽 끝으로 민다.
// 지배 전략이 있다면 여기서 드러난다.
const UP = {
  instructions: { lineHeight: 90, pressing: 90, tempo: 90, attackFocus: 'center' },
  mentality: 'very-attacking',
  groupIntensity: { attack: 1, midfield: 1, defense: 1 },
  attackPattern: 'through',
}
const DOWN = {
  instructions: { lineHeight: 10, pressing: 10, tempo: 10, attackFocus: 'balanced' },
  mentality: 'very-defensive',
  groupIntensity: { attack: -1, midfield: -1, defense: -1 },
  attackPattern: 'balanced',
}
const NEUTRAL = {
  instructions: { lineHeight: 50, pressing: 50, tempo: 50, attackFocus: 'balanced' },
  mentality: 'balanced',
  groupIntensity: { attack: 0, midfield: 0, defense: 0 },
  attackPattern: 'balanced',
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** 목표 전술을 **규칙이 허용하는 만큼만** 반영한 tactics를 만든다.
 *  base는 폭 제한의 기준점(터치라인이면 창 스냅샷, 전원 소집이면 무제한이라 무의미). */
function clampedTactics(cur, base, target, limited) {
  const ins = { ...cur.instructions }
  for (const k of ['lineHeight', 'pressing', 'tempo']) {
    const want = target.instructions[k]
    ins[k] = limited
      ? clamp(want, Math.max(0, base.instructions[k] - TOUCHLINE_STEP), Math.min(100, base.instructions[k] + TOUCHLINE_STEP))
      : want
  }
  ins.attackFocus = target.instructions.attackFocus
  const baseRank = MENTALITIES.indexOf(base.mentality ?? 'balanced')
  const wantRank = MENTALITIES.indexOf(target.mentality)
  const mentality = MENTALITIES[limited
    ? clamp(wantRank, baseRank - TOUCHLINE_RANK_STEP, baseRank + TOUCHLINE_RANK_STEP)
    : wantRank]
  const bgi = { attack: 0, midfield: 0, defense: 0, ...(base.groupIntensity ?? {}) }
  const groupIntensity = {}
  for (const line of ['attack', 'midfield', 'defense']) {
    const want = target.groupIntensity[line]
    groupIntensity[line] = limited
      ? clamp(want, bgi[line] - TOUCHLINE_RANK_STEP, bgi[line] + TOUCHLINE_RANK_STEP)
      : want
  }
  return { ...cur, instructions: ins, mentality, groupIntensity, attackPattern: target.attackPattern }
}

/** 이 순간의 목표 전술(전략별). null이면 "아무것도 바꾸지 않는다". */
function targetOf(strategy, engine) {
  if (strategy === 'none' || strategy === 'spend-only') return null
  if (strategy === 'always-up') return UP
  if (strategy === 'always-down') return DOWN
  // reactive — 상황 대응. 지면 밀고, 이기면 잠그고, 비기면 중립.
  const [own, opp] = [engine.score[0], engine.score[1]]
  if (own < opp) return UP
  if (own > opp) return DOWN
  return NEUTRAL
}

/** 지금 개입 창에서 전략의 목표를 store 규칙대로 밀어 넣는다. */
function intervene(strategy, limited) {
  const engine = s().engine
  const target = targetOf(strategy, engine)
  if (!target) return
  const win = s().touchlineWindow
  const cur = engine.home.tactics
  const base = limited && win && win.minute === engine.minute && win.side === 'home' ? win.tactics : cur
  const next = clampedTactics(cur, base, target, limited)
  try {
    s().submitCommand('home', { type: 'formation', tactics: next })
  } catch {
    // 규칙에 걸리면 그대로 포기한다 — 유저도 거부당하면 그 개입을 못 쓴다.
  }
}

/** 한 경기. 전략을 실제 store 경로로 몰고 홈 승/무/패를 돌려준다. */
function playMatch(oppId, seed, strategy) {
  const away = loadTeam(oppId)
  s().reset()
  s().startMatch(kor, away, seed)
  s().kickoff()
  let guard = 0
  while (s().phase !== 'fulltime' && guard++ < 400) {
    const phase = s().phase
    if (phase === 'playing') {
      // 순간 제안은 전 전략이 동일하게 흘려보낸다 — 개입 자원의 소비 경로를
      // pauseByUser 하나로 고정해야 전략 간 비교가 성립한다.
      if (s().momentPrompt) s().dismissMoment()
      // 자유 개입: 'none'만 쓰지 않는다. 나머지는 가능해지는 즉시 쓴다(= 5회 소진).
      if (strategy !== 'none' && freeInterventionState(s().freeInterventionsUsed, s().lastShoutMinute, s().engine.minute).canPause) {
        s().pauseByUser()
        continue
      }
      s().advanceMinute()
      continue
    }
    // 정지 — 브레이크·하프타임은 전원 소집(무제한), 감독 타임은 터치라인(폭 제한).
    const limited = s().pauseReason?.kind === 'user' || s().pauseReason?.kind === 'moment'
    intervene(strategy, limited)
    s().confirmTactics()
  }
  const [h, a] = s().engine.score
  return h > a ? 1 : h === a ? 0.5 : 0
}

const STRATEGIES = ['none', 'spend-only', 'reactive', 'always-up', 'always-down']

/** 표본 표준편차. */
function sd(xs) {
  const m = xs.reduce((t, v) => t + v, 0) / xs.length
  const v = xs.reduce((t, x) => t + (x - m) * (x - m), 0) / (xs.length - 1)
  return Math.sqrt(v)
}

const rows = []
for (const opp of OPPONENTS) {
  const results = {}
  for (const st of STRATEGIES) results[st] = []
  for (let i = 0; i < SEEDS; i++) {
    const seed = BASE_SEED + i
    for (const st of STRATEGIES) results[st].push(playMatch(opp, seed, st))
  }
  const winPct = xs => (100 * xs.filter(v => v === 1).length) / xs.length
  const baseWins = results.none.map(v => (v === 1 ? 1 : 0))
  const line = { opp, base: winPct(results.none), cells: {} }
  for (const st of STRATEGIES) {
    if (st === 'none') continue
    const w = results[st].map(v => (v === 1 ? 1 : 0))
    const d = w.map((v, i) => v - baseWins[i])
    const mean = d.reduce((t, v) => t + v, 0) / d.length
    const se = sd(d) / Math.sqrt(d.length)
    // 차이가 SE의 2배 미만이면 판정 불가. 차이가 정확히 0이면(모든 시드에서 결과가
    // 같아 SE도 0) "차이 없음"이지 "유의한 차이"가 아니다 — 0 >= 0으로 새지 않게 막는다.
    line.cells[st] = { pp: 100 * mean, se: 100 * se, decisive: mean !== 0 && Math.abs(mean) >= 2 * se }
  }
  rows.push(line)
  const fmt = st => {
    const c = line.cells[st]
    return `${c.pp >= 0 ? '+' : ''}${c.pp.toFixed(1)}pp (SE ${c.se.toFixed(1)}${c.decisive ? '' : ', 판정 불가'})`
  }
  console.log(
    `${opp}  기준 승률 ${line.base.toFixed(1)}%  |  개입만 ${fmt('spend-only')} · 상황대응 ${fmt('reactive')} · 항상↑ ${fmt('always-up')} · 항상↓ ${fmt('always-down')}`,
  )
}

// 지배 전략 판정 — 상대 5팀 **전부에서 같은 부호로 유의**하면 지배다.
console.log('')
for (const st of STRATEGIES) {
  if (st === 'none') continue
  const cells = rows.map(r => r.cells[st])
  const allPos = cells.every(c => c.decisive && c.pp > 0)
  const allNeg = cells.every(c => c.decisive && c.pp < 0)
  const decisiveN = cells.filter(c => c.decisive).length
  console.log(`${st}: 지배 ${allPos ? 'YES(전 상대 유의 양수)' : allNeg ? 'YES(전 상대 유의 음수)' : 'NO'} · 유의 셀 ${decisiveN}/${cells.length}`)
}
console.log(`\nn=${SEEDS} 페어드 · 시드 ${BASE_SEED}~${BASE_SEED + SEEDS - 1} · 홈 kor`)

await server.close()
process.exit(0)
