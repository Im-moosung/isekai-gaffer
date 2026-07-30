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
 * **승격할 가치가 있다. 단 하드 실패는 세 지표로 제한한다** —
 * 비-sticky 겹침 / 하드클립 / 가로 오버플로. 이 셋은 오탐이 없고 결정론적이며,
 * 실제로 게임을 못 하게 만들었던 지표다(390px 작전판 79% 하드클립 = 교체 불가).
 *
 * 이번 작업에서 오탐 두 종류를 제거해 게이트를 쓸 수 있게 만들었다:
 *  ① **클립 인식** — 조상이 overflow를 자르면 요소는 그 교집합만큼만 보인다.
 *     예전엔 잘린 원래 사각형으로 계산해 보이지도 않는 요소를 겹침으로 잡았다.
 *  ② **sticky 구분** — sticky 바 아래로 콘텐츠가 지나가는 것은 sticky의 정의다.
 *     바가 불투명하고 문서 끝에서 아무것도 묻히지 않으면 결함이 아니다(실측 확인).
 *     이 둘을 넣자 "실결함 겹침"이 54건 → 0건으로 분리됐다.
 *
 * 여전히 하드 실패로 쓰면 안 되는 것:
 *  · **대비비** — effBg가 반투명 배경을 겹칠 때 alpha를 1로 강제해 실제보다 밝은
 *    배경으로 계산한다(4% 반투명 위 텍스트가 1.14:1로 잡혔으나 육안 정상).
 *    3D 캔버스 위 텍스트는 아예 배경을 모른다 → landing-contrast.mjs가 픽셀로 따로 잰다.
 *  · **터치 타깃/글리프 잘림** — 추세 지표로 충분하다.
 *
 * 운영 권장:
 *  · PR 게이트: 1440·390 두 뷰포트만(약 2분). 하드 3종.
 *  · 나이틀리: 4뷰포트 + drive2(후반~신문) + play390 + landing-contrast.
 *  · 주행은 setTimeout 워프에 의존해 머신 부하에 민감하므로 clickAny 폴백을 유지하고,
 *    MISS-ALL이 나오면 실패가 아니라 **주행 불가**로 따로 보고해야 한다.
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
  // sticky 바 아래로 콘텐츠가 지나가는 것은 sticky의 정의다. 바가 불투명하고
  // 문서 끝에서 아무것도 묻히지 않으면 결함이 아니므로 경고로 내린다.
  const hard = s.overlaps.filter(o => !o.sticky)
  const transient = s.overlaps.filter(o => o.sticky)
  if (hard.length > HARD.overlaps) {
    fails.push(`${where}: 겹침 ${hard.length}건 — ${hard.slice(0, 3).map(o => `${o.a}↔${o.b} ${o.ov}`).join(', ')}`)
  }
  if (transient.length) warns.push(`${where}: sticky 통과 겹침 ${transient.length}건(스크롤 중 일시적)`)
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
