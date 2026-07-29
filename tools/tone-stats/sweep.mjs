#!/usr/bin/env node
// tools/tone-stats/sweep.mjs
// 계수 스윕 — run.mjs와 같은 하네스를 쓰되 톤매퍼·블룸·발광 배율 조합을 여러 개 돌려
// 표 하나로 비교한다. "감으로 정했다"를 "이 표를 보고 정했다"로 바꾸기 위한 도구다.
//
// 사용: node tools/tone-stats/sweep.mjs [--scene landing] [--frames 40]
import { runInBrowser } from './driver.mjs'

const args = process.argv.slice(2)
const arg = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : d
}
const scene = arg('--scene', 'landing')
const frames = Number(arg('--frames', 40))

/** 후보 조합. 이름은 스크린샷 파일명에 그대로 쓰인다. */
const CASES = [
  { name: 'raw', post: false },
  { name: 'x105-v34', post: true, exposure: 1.05, vignette: 0.34 },
  { name: 'x105-v26', post: true, exposure: 1.05, vignette: 0.26 },
  { name: 'x115-v26', post: true, exposure: 1.15, vignette: 0.26 },
  { name: 'x125-v26', post: true, exposure: 1.25, vignette: 0.26 },
  { name: 'x115-v26-b22', post: true, exposure: 1.15, vignette: 0.26, bloomStrength: 0.22 },
]

const runs = CASES.map((c) => ({
  label: `${scene}-${c.name}`,
  opts: { scene, frames, post: c.post, ...c, name: undefined },
}))

const results = await runInBrowser(runs)

const n = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : '-')
const out = []
out.push('')
out.push(`### 스윕: ${scene}`)
out.push('')
out.push('| 조합 | 평균 | 표준편차 | p01 | p50 | p99 | 동적범위 | 흑클립% | 백클립% | 채도 | ms(p50) |')
out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const r of results) {
  const s = r.stats
  out.push(
    `| ${r.label} | ${n(s.meanLuma)} | ${n(s.stdLuma)} | ${s.p01} | ${s.p50} | ${s.p99} | ${s.dynamicRange} | ${n(s.blackClip * 100, 3)} | ${n(s.whiteClip * 100, 3)} | ${n(s.meanSaturation, 3)} | ${n(r.frameMs.p50)} |`,
  )
}
out.push('')
process.stdout.write(out.join('\n'))
