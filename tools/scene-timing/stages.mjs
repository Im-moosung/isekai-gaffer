#!/usr/bin/env node
// tools/scene-timing/stages.mjs
// live.mjs가 남긴 연속 캡처에서 **5단계**(슈터 임팩트 → 비행 → GK 반응 → 접촉 → 결과)에
// 해당하는 프레임을 골라 `stages/` 아래에 사람이 읽을 이름으로 복사하고, 한 장짜리
// 콘택트시트를 만든다. 어느 프레임이 어느 단계인지는 dwell 비율로 지정한다
// (tools/scene-timing/run.mjs가 찍어 주는 임팩트·도착 시각을 그대로 넣으면 된다).
//
// 사용: node tools/scene-timing/stages.mjs <take디렉터리> --ms 4350,5000,5250,5450,6200
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('사용: node tools/scene-timing/stages.mjs <take디렉터리> [--ms a,b,c,d,e]')
  process.exit(1)
}
const i = process.argv.indexOf('--ms')
const targets = (i >= 0 ? process.argv[i + 1] : '').split(',').filter(Boolean).map(Number)
const LABELS = ['1-임팩트', '2-비행', '3-GK반응', '4-접촉', '5-결과']

const files = (await readdir(dir))
  .filter(f => /^f\d+-\d+ms\.png$/.test(f))
  .map(f => ({ f, ms: Number(f.match(/-(\d+)ms/)[1]) }))
  .sort((a, b) => a.ms - b.ms)
if (files.length === 0) {
  console.error('프레임이 없다:', dir)
  process.exit(1)
}

const out = join(dir, 'stages')
await mkdir(out, { recursive: true })
const picks = (targets.length ? targets : LABELS.map((_, k) => files[Math.round(((k + 1) / 6) * (files.length - 1))].ms))
  .map(ms => files.reduce((b, x) => (Math.abs(x.ms - ms) < Math.abs(b.ms - ms) ? x : b), files[0]))

const rows = []
for (let k = 0; k < picks.length; k++) {
  const label = LABELS[k] ?? `${k}`
  const name = `${label}-${picks[k].ms}ms.png`
  await copyFile(join(dir, picks[k].f), join(out, name))
  rows.push(`${label}\t${picks[k].ms}ms\t${picks[k].f}`)
}
await writeFile(join(out, 'stages.tsv'), rows.join('\n'))
console.log(`${basename(dir)} →\n${rows.join('\n')}\n${out}`)
