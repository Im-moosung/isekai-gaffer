#!/usr/bin/env node
// BGM 실측 (2) — 화면 전환 크로스페이드 · M06 끝 맞추기 · 덕킹 · 일시정지 집중 측정.
// run.mjs가 경기 전 구간(하프타임 M07 → M04, 클러치 M09, 풀타임 M08)을 재는 반면
// 이 스크립트는 앞부분만 짧게 돌려 **곡이 겹치는 구간**을 촘촘히 본다.
//
// 함정: 백그라운드 탭은 rAF를 멈춘다 → headless:false + 측정 전 픽셀 diff로 프레임 진행 증명.
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'docs/audit/bgm')
const W = 1280
const H = 800
const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort() {
  return new Promise((res, rej) => {
    const s = netCreateServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => res(p))
    })
  })
}

await mkdir(OUT, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

async function probe() {
  await page.evaluate(async () => {
    if (window.__rec) return
    const bgm = await import('/src/audio/bgm.ts')
    const sfx = await import('/src/audio/sfx.ts')
    window.__bgm = bgm
    window.__t0 = performance.now()
    window.__rec = []
    window.__mark = l => window.__rec.push({ t: Math.round(performance.now() - window.__t0), mark: l })
    setInterval(() => {
      const s = bgm.bgmState()
      const bus = sfx.audioBus()
      window.__rec.push({
        t: Math.round(performance.now() - window.__t0),
        loop: s.loop, lg: +s.loopGain.toFixed(4),
        sting: s.sting, sg: +s.stingGain.toFixed(4),
        s0: s.stingStartsInMs, s1: s.stingEndsInMs,
        fade: s.fading.map(([k, g]) => `${k}=${g.toFixed(3)}`).join(','),
        duck: +s.duck.toFixed(4), paused: s.paused,
        master: bus ? +bus.master.gain.value.toFixed(3) : null,
      })
    }, 20)
  })
}
const marks = []
async function mark(l) {
  const t = await page.evaluate(x => { window.__mark(x); return Math.round(performance.now() - window.__t0) }, l)
  marks.push({ t, label: l })
  console.log(`  · ${String(t).padStart(6)}ms  ${l}`)
  return t
}
async function frameDiff(ms = 400) {
  const a = await page.screenshot({ type: 'png' })
  await sleep(ms)
  const b = await page.screenshot({ type: 'png' })
  if (a.length !== b.length) return 1
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d / a.length
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await probe()
  await sleep(1200)
  const pre = await page.evaluate(() => window.__bgm.bgmState())
  console.log(`\n[1] 첫 클릭 전: ready=${pre.ready} loop=${pre.loop} (자동재생 금지 계약)`)

  await page.getByRole('button', { name: /캠페인 시작/ }).click()
  await mark('첫 제스처 = 캠페인 시작')
  await page.getByRole('button', { name: /준비하기/ }).waitFor({ timeout: 15000 })
  await sleep(2000)
  await page.getByRole('button', { name: /준비하기/ }).click()
  await mark('허브 → 워룸')
  await sleep(2000)
  console.log(`\n[프레임 진행 · 3D 워룸 배경] 픽셀 diff = ${(await frameDiff()).toFixed(4)}`)

  await page.getByRole('button', { name: '킥오프' }).click()
  const tk = await mark('킥오프')
  await page.locator('[data-testid="entrance-overlay"]').waitFor({ timeout: 20000 })
  console.log(`[프레임 진행 · 입장 연출] 픽셀 diff = ${(await frameDiff()).toFixed(4)}`)
  await sleep(500)
  const sch = await page.evaluate(() => window.__bgm.bgmState())
  console.log(`\n[2] M06 예약: 시작까지 ${sch.stingStartsInMs}ms · 끝까지 ${sch.stingEndsInMs}ms`)
  await page.evaluate(() => window.__mark('M06 예약 확인'))

  // 입장을 끝까지 보고(full) 팡파르가 실제로 언제 울리기 시작하는지 관측.
  await page.locator('[data-testid="entrance-overlay"]').waitFor({ state: 'detached', timeout: 150000 })
  const tw = await mark('입장 종료 = 킥오프 휘슬')
  console.log(`\n[3] 입장 실측 길이 ${tw - tk}ms`)

  await sleep(2000)
  console.log(`[프레임 진행 · 인플레이] 픽셀 diff = ${(await frameDiff()).toFixed(4)}`)
  // 인플레이 무음 확인 후 감독 타임(작전판 M04) → 복귀.
  const inplay = await page.evaluate(() => window.__bgm.bgmState())
  console.log(`[4] 인플레이 음악: loop=${inplay.loop} sting=${inplay.sting} (경기 중 무음 계약)`)

  await page.getByRole('button', { name: '일시정지' }).click()
  await mark('일시정지')
  await sleep(1000)
  await page.getByRole('button', { name: '재생' }).click()
  await mark('재생 재개')

  await page.getByRole('button', { name: '감독 타임' }).click()
  await mark('감독 타임(작전판)')
  await sleep(3000)
  await page.evaluate(() => window.__bgm.duck())
  await mark('duck() — 골 경로와 같은 함수')
  await sleep(4000)

  const rec = await page.evaluate(() => window.__rec)
  await writeFile(join(OUT, 'scenes.json'), JSON.stringify({ marks, rec }, null, 2))

  console.log('\n### 트랙 구간(실측)')
  console.log('| 채널 | 트랙 | 시작(ms) | 종료(ms) | 최대 게인 |')
  console.log('|---|---|---:|---:|---:|')
  for (const [ch, key] of [['loop', 'lg'], ['sting', 'sg']]) {
    let cur = null
    for (const r of rec) {
      if (r.mark) continue
      if (r[ch] !== cur?.track) {
        if (cur) console.log(`| ${ch} | ${cur.track} | ${cur.from} | ${cur.to} | ${cur.peak.toFixed(3)} |`)
        cur = r[ch] ? { track: r[ch], from: r.t, to: r.t, peak: r[key] } : null
      }
      if (cur) { cur.to = r.t; cur.peak = Math.max(cur.peak, r[key]) }
    }
    if (cur) console.log(`| ${ch} | ${cur.track} | ${cur.from} | ${cur.to} | ${cur.peak.toFixed(3)} |`)
  }

  console.log('\n### 크로스페이드 — 두 곡이 실제로 겹치는가')
  const ov = rec.filter(r => !r.mark && r.fade && (r.loop || r.sting))
  for (const r of ov.slice(0, 3).concat(ov.slice(-3))) {
    console.log(`  ${r.t}ms  in=${r.loop ?? r.sting}:${(r.loop ? r.lg : r.sg).toFixed(3)}  out=${r.fade}`)
  }
  const groups = []
  let g = null
  for (const r of ov) {
    if (!g || r.t - g.to > 200) {
      if (g) groups.push(g)
      g = { from: r.t, to: r.t }
    }
    g.to = r.t
  }
  if (g) groups.push(g)
  for (const q of groups) console.log(`  중첩 구간 ${q.from}~${q.to}ms (${q.to - q.from}ms)`)

  const d = rec.filter(r => !r.mark && r.duck < 0.99)
  if (d.length) console.log(`\n### 덕킹: 최저 ${Math.min(...d.map(r => r.duck)).toFixed(3)}배 · ${d[0].t}~${d[d.length - 1].t}ms (${d[d.length - 1].t - d[0].t}ms)`)
  const p = rec.filter(r => !r.mark && r.paused)
  if (p.length) console.log(`### 일시정지 ${p[0].t}~${p[p.length - 1].t}ms · 그 구간 loop 게인 최대 ${Math.max(...p.map(r => r.lg)).toFixed(3)}`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-25).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'scenes.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
