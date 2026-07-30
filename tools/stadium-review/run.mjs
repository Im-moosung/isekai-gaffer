#!/usr/bin/env node
// tools/stadium-review/run.mjs
// 스타디움 클로즈업 리뷰 러너 — `docs/refs/stadium/*.png` 레퍼런스와 같은 프레이밍으로
// 프로덕션 씬을 렌더해 사이드바이사이드 비교용 PNG를 남긴다.
//
// 사용:
//   node tools/stadium-review/run.mjs                       # 6개 뷰 전부, post 켜고
//   node tools/stadium-review/run.mjs --only goal-front      # 특정 뷰만
//   node tools/stadium-review/run.mjs --only adboard,crowd-far
//   node tools/stadium-review/run.mjs --tag after            # 파일명 접두사
//   node tools/stadium-review/run.mjs --no-post              # 포스트FX 없는 기준선
//
// 출력: docs/audit/shots/review-<tag>-<view>.png (.gitignore 대상 — 저장소에 남기지 않는다)
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { SHOTS, runInBrowser } from '../tone-stats/driver.mjs'

/** harness.ts의 VIEW_NAMES와 같아야 한다(여기는 .mjs라 타입을 import할 수 없다). */
const VIEWS = ['goal-front', 'goal-3q', 'corner-flag', 'adboard', 'crowd-far', 'stadium-wide']

function parseArgs(argv) {
  const out = { only: null, tag: 'shot', post: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') out.only = argv[++i]
    else if (argv[i] === '--tag') out.tag = argv[++i]
    else if (argv[i] === '--no-post') out.post = false
    else throw new Error(`알 수 없는 인자: ${argv[i]}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const views = args.only ? args.only.split(',').map((v) => v.trim()).filter(Boolean) : VIEWS
for (const v of views) {
  if (!VIEWS.includes(v)) throw new Error(`알 수 없는 뷰: ${v}\n가능한 값: ${VIEWS.join(', ')}`)
}

const results = await runInBrowser(
  views.map((view) => ({ label: view, opts: { view, post: args.post } })),
  { harness: 'tools/stadium-review/harness.html', globalName: '__stadiumReview' },
)

// driver는 스크린샷을 `tone-<label>.png`로 남긴다(톤 통계 도구의 규약). 리뷰 산출물은
// `review-<tag>-<view>.png`라는 별도 이름 공간을 쓰므로 저장 직후 옮긴다 — driver를
// 리뷰 전용으로 특수화하지 않으려는 의도적 선택이다.
const saved = []
for (const r of results) {
  const dest = join(SHOTS, `review-${args.tag}-${r.label}.png`)
  await rename(r.shot, dest)
  saved.push({ view: r.label, path: dest, postActive: r.postActive, crowdCount: r.crowdCount })
}

const lines = ['']
lines.push(`### 스타디움 리뷰 샷 (${args.post ? 'post' : 'raw'}, ${saved.length}장)`)
lines.push('')
for (const s of saved) {
  lines.push(`- ${s.view} (post=${s.postActive}, crowd=${s.crowdCount})\n  ${s.path}`)
}
lines.push('')
process.stdout.write(lines.join('\n'))
