#!/usr/bin/env node
// 랜딩 BGM 실측 — "첫 방문 → 제스처 → M01이 울리기까지" 몇 ms인가.
//
// 자동재생 정책을 **끄지 않는다**(--autoplay-policy 플래그 금지). 정책을 켠 채로
// 재는 것만이 심사자 환경의 숫자다. headless:false + 픽셀 diff로 rAF 진행을 먼저 증명한다.
//
// 사용: APP_ROOT=<앱 루트> node tools/landing-bgm/run.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = process.env.APP_ROOT || resolve(import.meta.dirname, '../..')
const OUT_ROOT = process.env.OUT_ROOT || ROOT
const OUT = join(OUT_ROOT, 'docs/audit/shots')

function freePort() {
  return new Promise((res, rej) => {
    const s = netCreateServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

await mkdir(OUT, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--window-size=1400,980', '--mute-audio', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: 1360, height: 880 }, deviceScaleFactor: 2 })
const logs = []
const net = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))
page.on('requestfinished', r => { if (r.url().includes('/bgm/')) net.push(r.url().split('/').pop()) })

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
  await page.evaluate(async () => {
    window.__bgm = await import('/src/audio/bgm.ts')
    window.__sfx = await import('/src/audio/sfx.ts')
    window.__t0 = performance.now()
  })
  await sleep(1200)
  console.log(`[프레임 진행 증명 · 랜딩] 픽셀 diff = ${(await frameDiff()).toFixed(4)}`)

  // ── 1. 제스처 전 ─────────────────────────────────────────────
  const pre = await page.evaluate(() => ({
    bgm: window.__bgm.bgmState(), bus: !!window.__sfx.audioBus(),
    cue: document.querySelector('.landing__sound')?.innerText?.replace(/\n/g, ' / ') ?? null,
  }))
  console.log(`\n[1] 첫 제스처 전 — 컨텍스트=${pre.bus ? '열림' : '없음'} scene=${pre.bgm.scene} loop=${pre.bgm.loop} bgm요청=${net.length}건`)
  console.log(`    화면의 안내: ${pre.cue}`)
  await page.screenshot({ path: join(OUT, 'r7-landing-cue.png'), clip: { x: 0, y: 0, width: 1360, height: 880 } })

  // ── 2. 안내를 누른다(= 첫 제스처) ────────────────────────────
  await page.evaluate(() => { window.__tClick = performance.now() })
  await page.locator('.landing__sound').click()
  const timeline = []
  let firstAudible = null
  for (let i = 0; i < 400; i++) {
    const s = await page.evaluate(() => {
      const st = window.__bgm.bgmState()
      const bus = window.__sfx.audioBus()
      return { t: Math.round(performance.now() - window.__tClick), loop: st.loop, lg: +st.loopGain.toFixed(4), ctx: bus?.ctx.state ?? 'none' }
    })
    timeline.push(s)
    if (firstAudible == null && s.lg > 0.001) firstAudible = s
    if (s.lg >= 0.79) break
    await sleep(25)
  }
  const last = timeline[timeline.length - 1]
  const ctxOpen = timeline.find(s => s.ctx === 'running')
  console.log(`\n[2] 클릭 t=0 기준`)
  console.log(`    AudioContext running   : ${ctxOpen ? ctxOpen.t : '미관측'} ms`)
  console.log(`    M01 첫 소리(게인>0)     : ${firstAudible ? `${firstAudible.t} ms` : '미관측'}`)
  console.log(`    M01 페이드인 완료(0.8)  : ${last.lg >= 0.79 ? `${last.t} ms` : `미완(마지막 ${last.t}ms에 ${last.lg})`}`)
  console.log(`    네트워크: ${net.join(', ') || '없음'}`)

  // ── 3. 안내가 확인 문구로 바뀌고 사라지는가 ──────────────────
  await sleep(200)
  const on = await page.evaluate(() => document.querySelector('.landing__sound')?.innerText?.replace(/\n/g, ' / ') ?? null)
  console.log(`\n[3] 클릭 직후 안내: ${on}`)
  await page.screenshot({ path: join(OUT, 'r7-landing-cue-on.png'), clip: { x: 0, y: 0, width: 1360, height: 880 } })
  await sleep(3000)
  const after = await page.evaluate(() => ({
    cue: document.querySelector('.landing__sound')?.innerText ?? null,
    st: window.__bgm.bgmState(),
  }))
  console.log(`    3.2초 뒤 안내: ${after.cue ?? '사라짐'} · loop=${after.st.loop} gain=${after.st.loopGain.toFixed(3)}`)
  await page.screenshot({ path: join(OUT, 'r7-landing-cue-gone.png'), clip: { x: 0, y: 0, width: 1360, height: 880 } })

  // ── 4. 음소거 상태에서는 뜨지 않는다 ─────────────────────────
  await page.evaluate(() => localStorage.setItem('rematch-muted', '1'))
  await page.reload({ waitUntil: 'load' })
  await sleep(1200)
  const muted = await page.evaluate(() => document.querySelector('.landing__sound')?.innerText ?? null)
  console.log(`\n[4] 음소거(rematch-muted=1)로 재방문 — 안내: ${muted ?? '없음(의도대로)'}`)
  await page.evaluate(() => localStorage.removeItem('rematch-muted'))

  // ── 5. 안내 대신 **다른 곳**을 눌러도 열리는가 ───────────────
  await page.reload({ waitUntil: 'load' })
  await page.evaluate(async () => {
    window.__bgm = await import('/src/audio/bgm.ts')
    window.__sfx = await import('/src/audio/sfx.ts')
  })
  await sleep(1000)
  await page.mouse.click(40, 700) // 빈 배경
  await sleep(1500)
  const elsewhere = await page.evaluate(() => ({
    st: window.__bgm.bgmState(), cue: document.querySelector('.landing__sound')?.innerText?.replace(/\n/g, ' / ') ?? null,
  }))
  console.log(`\n[5] 배경 아무 곳 클릭 — loop=${elsewhere.st.loop} gain=${elsewhere.st.loopGain.toFixed(3)} · 안내: ${elsewhere.cue}`)

  await writeFile(join(OUT, 'r7-landing-bgm.json'), JSON.stringify({ pre, timeline, net }, null, 2))
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-25).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'r7-landing-bgm.log'), logs.join('\n'))
  await browser.close()
  await server.close()
}
