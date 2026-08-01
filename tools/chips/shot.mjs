#!/usr/bin/env node
// 상태 칩 실루엣 캡처(정지 UI라 프레임 진행 증명은 의미가 없다 — 애니메이션이 없다).
import { mkdir } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const freePort = () => new Promise((res, rej) => {
  const s = netCreateServer(); s.once('error', rej)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
})
await mkdir(SHOTS, { recursive: true })
const port = await freePort()
const server = await createServer({ root: ROOT, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
await server.listen()
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=900,700'] })
const page = await browser.newPage({ viewport: { width: 760, height: 420 }, deviceScaleFactor: 4 })
page.on('pageerror', e => console.error('[error]', e.message))
await page.goto(`http://127.0.0.1:${port}/tools/chips/chips.html`, { waitUntil: 'load' })
await page.locator('.sx').first().waitFor({ timeout: 20000 })
await page.waitForTimeout(600)
await page.locator('#root').screenshot({ path: join(SHOTS, 'r8-chips.png') })
console.log('→ docs/audit/shots/r8-chips.png (4x)')
await browser.close(); await server.close()
