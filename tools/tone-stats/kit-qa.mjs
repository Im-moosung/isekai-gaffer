#!/usr/bin/env node
// tools/tone-stats/kit-qa.mjs
// 킷 축소 판정 — 브로드캐스트 프레임을 실제로 렌더한 뒤 선수만 잘라내
// **44px·52px로 축소한 대비 시트**를 만들고, 팀 색 분리도를 CIELAB ΔE로 잰다.
//
// "빨강/파랑이 구분된다"를 "ΔE 41.2, 팀내 산포 8.9, 비율 4.6"으로 바꾸는 것이 목적이다.
// docs/refs/qa/players-{44,52}px-night-pitch-grid.png와 같은 조건(야간 피치색 #254F2F,
// 선수 높이 44/52px)이라 참조 판정본과 나란히 놓고 볼 수 있다.
//
// 사용:
//   node tools/tone-stats/kit-qa.mjs               # 포스트FX 켠 상태(=프로덕션)
//   node tools/tone-stats/kit-qa.mjs --raw         # 포스트FX 없이
//   node tools/tone-stats/kit-qa.mjs --tag before  # 파일명 접두사
//
// 출력: docs/audit/shots/kit-qa-<tag>.png + 표(stdout). 둘 다 .gitignore 대상이다.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HEIGHT, SHOTS, WIDTH, runInBrowser } from './driver.mjs'

const argv = process.argv.slice(2)
const raw = argv.includes('--raw')
const tag = argv.includes('--tag') ? argv[argv.indexOf('--tag') + 1] : raw ? 'raw' : 'post'

const [res] = await runInBrowser(
  [
    {
      label: `kit-${tag}`,
      opts: { post: !raw, frames: 0, width: WIDTH, height: HEIGHT },
      // driver는 run()만 호출하므로 kitSheet 전용 훅을 쓴다.
      call: 'kitSheet',
    },
  ],
  { shots: false },
)

await mkdir(SHOTS, { recursive: true })
const out = join(SHOTS, `kit-qa-${tag}.png`)
await writeFile(out, Buffer.from(res.dataUrl.split(',')[1], 'base64'))

const n = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '-')
const s = res.separation
const px = res.screenPx
process.stdout.write(
  [
    '',
    `### 킷 축소 판정 (${tag}, ${WIDTH}×${HEIGHT} 브로드캐스트)`,
    '',
    '| 항목 | 값 |',
    '|---|---:|',
    `| 화면상 선수 높이(px) | ${n(px.min, 1)} ~ ${n(px.max, 1)} (평균 ${n(px.mean, 1)}, n=${px.count}) |`,
    `| 홈 평균 CIELAB | L ${n(s.home[0])} a ${n(s.home[1])} b ${n(s.home[2])} |`,
    `| 어웨이 평균 CIELAB | L ${n(s.away[0])} a ${n(s.away[1])} b ${n(s.away[2])} |`,
    `| 팀 간 ΔE(CIE76) | **${n(s.deltaE)}** |`,
    `| 팀 내 산포 ΔE | ${n(s.spread)} |`,
    `| 분리도(ΔE / 산포) | **${n(s.ratio)}** |`,
    '',
    `시트: ${out}`,
    '',
  ].join('\n'),
)
