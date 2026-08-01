#!/usr/bin/env node
// 교체 차단 고지 캡처 — 실제 Chrome 창(headless:false)으로 작전판 교체 탭을 찍는다.
// 백그라운드/헤드리스 탭은 rAF가 스로틀되어 보드가 얼어붙는다(round6/playthrough.mjs 주석).
//
// 사용: node tools/subblock/shot.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const W = 1600, H = 1000

function freePort() {
  return new Promise((res, rej) => {
    const s = netCreateServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
// HMR을 끈다 — 다른 에이전트가 같은 트리를 동시에 고치는 중이다.
const server = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  logLevel: 'error',
})
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

const notes = []
async function capture(kase, name) {
  await page.goto(`http://127.0.0.1:${port}/tools/subblock/index.html?case=${kase}`, { waitUntil: 'load' })
  await page.getByRole('tab', { name: '교체' }).click()
  await page.waitForSelector('.cs-sub__locked')
  // 막힌 카드를 실제로 눌러 본다 — "눌러도 아무 반응이 없다"가 고쳐졌는지가 요점이다.
  // force: Playwright는 aria-disabled를 "not enabled"로 보고 클릭을 거부한다. 브라우저는
  // 그렇지 않다 — aria-disabled는 의미만 바꾸고 클릭 이벤트는 그대로 온다. 실사용자와
  // 같은 실제 마우스 클릭을 보내려면 액셔너빌리티 검사만 건너뛰면 된다.
  await page.locator('.cs-sub__lineup .cs-card').first().click({ force: true })
  await page.waitForSelector(String.raw`.cs-sub__locked[data-nudge]`)
  const read = await page.evaluate(() => ({
    count: document.querySelector('.cs-sub__count')?.textContent?.trim(),
    countHot: !!document.querySelector('.cs-sub__count--hot'),
    banner: [...document.querySelectorAll('.cs-sub__reasons li')].map(li => li.textContent.trim()),
    error: document.querySelector(".cs-error")?.textContent?.trim() ?? null,
    nudge: document.querySelector(".cs-sub__locked")?.getAttribute("data-nudge"),
    confirmAria: document.querySelector('.cs-panel__foot .btn')?.getAttribute('aria-disabled'),
    cardsVisible: document.querySelectorAll('.cs-sub__lineup .cs-card').length,
  }))
  const path = join(SHOTS, `${name}.png`)
  await page.screenshot({ path })
  notes.push({ kase, path, ...read })
  console.log(JSON.stringify({ kase, path, ...read }, null, 2))
}

await capture('quota', 'r7-sub-blocked')
await capture('window', 'r7-sub-nowindow')
await capture('both', 'r7-sub-blocked-both')

await writeFile(join(SHOTS, 'r7-sub-blocked.json'), JSON.stringify({ notes, logs }, null, 2))
await browser.close()
await server.close()
