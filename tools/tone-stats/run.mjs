#!/usr/bin/env node
// tools/tone-stats/run.mjs
// 톤 통계 계측 러너 — 대표 장면(랜딩 배경 / 경기 중 브로드캐스트 / 골 순간)을 헤드리스로
// 렌더해 **포스트 프로세싱 전후**의 픽셀 히스토그램·클리핑 비율·퍼센타일·평균 휘도와
// 프레임타임을 뽑고, 같은 프레임의 스크린샷을 남긴다.
//
// "평평해 보인다"를 "p99 244 → 251, 흑클립 24.65% → 18.77%"로 바꾸는 것이 목적이다.
//
// 사용:
//   node tools/tone-stats/run.mjs                 # 3장면 × (raw|post) + 스크린샷
//   node tools/tone-stats/run.mjs --frames 240    # 프레임타임 표본 수(기본 180)
//   node tools/tone-stats/run.mjs --only goal     # 특정 장면만
//   node tools/tone-stats/run.mjs --tag before    # 스크린샷 파일명 접두사
//
// 출력: 마크다운 표(stdout) + docs/audit/tone-stats.json + docs/audit/shots/tone-*.png
//       (둘 다 .gitignore 대상 — 저장소에 산출물을 남기지 않는다)
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HEIGHT, ROOT, WIDTH, runInBrowser } from './driver.mjs'

const SCENES = ['landing', 'broadcast', 'goal']
const OUT_JSON = join(ROOT, 'docs/audit/tone-stats.json')

function parseArgs(argv) {
  const out = { frames: 180, only: null, tag: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--frames') out.frames = Number(argv[++i])
    else if (argv[i] === '--only') out.only = argv[++i]
    else if (argv[i] === '--tag') out.tag = `${argv[++i]}-`
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const scenes = args.only ? [args.only] : SCENES

const runs = []
for (const scene of scenes) {
  for (const post of [false, true]) {
    runs.push({
      label: `${args.tag}${scene}-${post ? 'post' : 'raw'}`,
      opts: { scene, post, frames: args.frames },
    })
  }
}

const results = await runInBrowser(runs)
await writeFile(OUT_JSON, JSON.stringify(results, null, 2))

const n = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '-')
const lines = []
lines.push('')
lines.push('### 톤 통계 (Rec.709 휘도, 0~255)')
lines.push('')
lines.push('| 장면 | 파이프라인 | 평균 | 표준편차 | p01 | p50 | p99 | 동적범위 | 흑클립% | 백클립% | 채도 |')
lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const r of results) {
  const s = r.stats
  lines.push(
    `| ${r.scene} | ${r.post ? (r.postActive ? 'post' : 'post(비활성!)') : 'raw'} | ${n(s.meanLuma)} | ${n(s.stdLuma)} | ${s.p01} | ${s.p50} | ${s.p99} | ${s.dynamicRange} | ${n(s.blackClip * 100, 3)} | ${n(s.whiteClip * 100, 3)} | ${n(s.meanSaturation, 3)} |`,
  )
}
lines.push('')
lines.push(`### 프레임타임 (${WIDTH}×${HEIGHT}, GPU 완료 동기화 포함, ${args.frames}프레임)`)
lines.push('')
lines.push('| 장면 | 파이프라인 | 평균 ms | p50 | p95 | 최대 |')
lines.push('|---|---|---:|---:|---:|---:|')
for (const r of results) {
  const f = r.frameMs
  lines.push(`| ${r.scene} | ${r.post ? 'post' : 'raw'} | ${n(f.mean)} | ${n(f.p50)} | ${n(f.p95)} | ${n(f.max)} |`)
}
lines.push('')
process.stdout.write(lines.join('\n'))
