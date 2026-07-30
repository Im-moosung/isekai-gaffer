/* 레이아웃 회귀 게이트 — drive.mjs / drive2.mjs가 남긴 측정 JSON을 임계값에 대고 판정한다.
 *
 * 왜 별도 스크립트인가: 주행(drive)과 판정(gate)을 분리해야 주행 한 번으로 여러 기준을
 * 시험할 수 있고, 기준을 조일 때 주행 코드를 건드리지 않아도 된다.
 *
 * 사용:
 *   VPS='[[1440,900],[390,844]]' SCHEME=light node docs/audit/drive.mjs
 *   node docs/audit/gate.mjs docs/audit/audit-light-1440_390.json
 *
 * 종료 코드 1이면 회귀다.
 *
 * ── CI 승격에 대한 판단 ────────────────────────────────────────────────
 * 이 하니스는 유용하지만 **현 상태 그대로 CI 게이트로 올리면 안 된다.** 이유 셋:
 *  ① 대비비 측정에 오탐이 있다. effBg가 반투명 배경을 겹칠 때 alpha를 1로 강제해
 *     실제보다 밝은 배경으로 계산한다(반투명 4% 배경 위 텍스트가 1.14:1로 잡혔으나
 *     육안으로는 정상). 이 오탐을 고치기 전에는 lowContrast를 하드 실패로 쓸 수 없다.
 *  ② overlaps/lowContrast가 상위 12·15건으로 잘려 있어 "0건" 외의 수치는 추세로만 쓸 수 있다.
 *  ③ 주행이 setTimeout 워프에 의존해 머신 부하에 따라 도달 상태가 달라진다
 *     (2D 토글 버튼을 못 찾는 MISS가 실제로 관측됐다). 플레이키하다.
 * → 권장: **경고 전용(non-blocking) 나이틀리 잡**으로 먼저 올리고,
 *   overlaps와 hidScroll(하드클립)만 하드 실패로 승격한다. 이 둘은 오탐이 없고
 *   결정론적이며, 실제로 게임을 못 하게 만든 두 지표다.
 */
import fs from 'node:fs'

/** 하드 실패 기준. 오탐이 없고 결정론적인 두 지표만 여기 둔다. */
const HARD = {
  overlaps: 0, // 면적 20% 초과 텍스트 박스 교차
  hardclip: 0, // overflow:hidden으로 잘려 접근 불가능한 콘텐츠
  overflowX: 0, // 가로 스크롤
}
/** 경고 기준. 측정에 오탐 여지가 있어 추세로만 본다. */
const WARN = {
  hidScrollPct: 40, // 스크롤 은닉률 상한(어포던스가 있어도 40% 넘으면 설계 문제)
  minContrast: 4.5,
  tinyTap: 0,
  clippedLH: 0,
}

const file = process.argv[2]
if (!file) {
  console.error('usage: node docs/audit/gate.mjs <audit-*.json>')
  process.exit(2)
}
const data = JSON.parse(fs.readFileSync(file, 'utf8'))

const fails = []
const warns = []

/** 측정 JSON은 뷰포트 → steps → 상태 2단이거나 steps 1단이다. 둘 다 받는다. */
const visit = (node, path) => {
  if (node && typeof node === 'object' && 'vw' in node && 'overlaps' in node) {
    check(path, node)
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'console') continue
      visit(v, path ? `${path}/${k}` : k)
    }
  }
}

function check(where, s) {
  if (s.overlaps.length > HARD.overlaps) {
    fails.push(`${where}: 겹침 ${s.overlaps.length}건 — ${s.overlaps.slice(0, 3).map(o => `${o.a}↔${o.b} ${o.ov}`).join(', ')}`)
  }
  const clips = s.hidScroll.filter(h => h.HARDCLIP)
  if (clips.length > HARD.hardclip) {
    fails.push(`${where}: 하드클립 ${clips.length}건 — ${clips.slice(0, 3).map(c => `${c.sel} ${c.hiddenPct}%`).join(', ')}`)
  }
  if (s.overflowX > HARD.overflowX) fails.push(`${where}: 가로 오버플로 ${s.overflowX}px`)

  const deep = s.hidScroll.filter(h => !h.HARDCLIP && h.hiddenPct > WARN.hidScrollPct)
  if (deep.length) warns.push(`${where}: 스크롤 은닉 ${deep.map(d => `${d.sel} ${d.hiddenPct}%`).join(', ')}`)
  const lc = s.lowContrast.filter(c => c.ratio < WARN.minContrast)
  if (lc.length) warns.push(`${where}: 저대비 ${lc.length}건(최저 ${Math.min(...lc.map(c => c.ratio))}:1)`)
  if (s.tinyTap.length) warns.push(`${where}: 터치타깃 미달 ${s.tinyTap.length}건`)
  if (s.clippedLH.length) warns.push(`${where}: 한글 글리프 잘림 ${s.clippedLH.length}건`)
}

visit(data, '')

for (const w of warns) console.log('WARN  ' + w)
for (const f of fails) console.log('FAIL  ' + f)
console.log(`\n${fails.length ? 'FAIL' : 'PASS'} — 하드 ${fails.length}건 / 경고 ${warns.length}건`)
process.exit(fails.length ? 1 : 0)
