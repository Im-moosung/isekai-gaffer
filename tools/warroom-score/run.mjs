#!/usr/bin/env node
// 경기 중 작전판 헤더의 **스코어·시계** 실측(사용자 지시 ③).
// 감독 타임에 실제로 들어가 헤더가 무엇을 적는지 DOM에서 읽고 캡처한다 —
// "스코어버그를 보려고 작전판을 닫아야 했다"가 사라졌는지는 화면에서만 확인된다.
import { mkdir } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const OUT = join(ROOT, 'docs/audit/shots')
const W = 1440, H = 900

const freePort = () => new Promise((res, rej) => {
  const s = netCreateServer()
  s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})

await mkdir(OUT, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

async function frameDiff(ms = 400) {
  const a = await page.screenshot()
  await new Promise(r => setTimeout(r, ms))
  const b = await page.screenshot()
  if (a.length !== b.length) return 1
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d / a.length
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: /캠페인 시작/ }).click()
  await page.getByRole('button', { name: /준비하기/ }).click({ timeout: 20000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '킥오프' }).click()
  await page.getByRole('button', { name: /건너뛰/ }).click({ timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '2x' }).click()
  const diff = await frameDiff()
  console.log(`[프레임 진행 증명] 픽셀 diff = ${diff.toFixed(4)} ${diff > 0.0001 ? 'OK' : 'FAIL'}`)
  if (!(diff > 0.0001)) throw new Error('rAF 정지 — 캡처 무의미')

  // 감독 타임(자유 개입) — 여기서 작전판이 열린다.
  await page.getByRole('button', { name: '감독 타임' }).click()
  await page.waitForSelector('.tb-head__score', { timeout: 10000 })
  // 작전판 진입 연출(MODE_TRANSITION_MS 600)이 끝난 뒤에 찍는다 — 전환 중 프레임은 반투명이다.
  await page.waitForTimeout(1000)
  const head = await page.evaluate(() => {
    const t = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null)
    return {
      score: t(document.querySelector('.tb-head__score')),
      clock: t(document.querySelector('.tb-head__clock')),
      // 스코어버그가 같은 순간에 말하는 값 — 두 화면이 어긋나면 어느 쪽이 정본인지 알 수 없다.
      bug: t(document.querySelector('.bc-scorebug__deck')),
      bugClock: t(document.querySelector('.bc-scorebug__meta')),
    }
  })
  console.log(`\n작전판 헤더: ${head.score}`)
  console.log(`스코어버그  : ${head.bug} / ${head.bugClock}`)
  await page.screenshot({ path: join(OUT, 'r9-warroom-score.png') })
  console.log(`\n캡처 → docs/audit/shots/r9-warroom-score.png`)
} catch (e) {
  console.error('실패:', e.message, logs.slice(-10).join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await server.close()
}
