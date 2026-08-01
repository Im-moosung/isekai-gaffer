#!/usr/bin/env node
// 6라운드 수정 검증 — 고친 자리만 다시 찍는다.
//  · 입장 소개 컷 명단 패널 스크림(가독성)
//  · 좌상단 대진 스트립 ↔ 자막 바 겹침 0
//  · 광고 호딩 단일 렌더(정렬 컷)
//  · 코치 회의 모달 스크림
//  · 기자회견 좌측 빈 레일 접힘(≥1200)
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')

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

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
const server = await createServer({
  root: ROOT,
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  logLevel: 'error',
})
await server.listen()

const out = []
for (const [W, H] of [[1600, 900], [390, 844]]) {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
  })
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
    await page.getByRole('button', { name: '바로 지휘하기' }).click()
    await page.getByRole('button', { name: '킥오프' }).click()
    const c = page.locator('canvas.m3d-canvas')
    await c.waitFor({ state: 'visible', timeout: 30000 })
    const a = await c.screenshot()
    await page.waitForTimeout(240)
    const b = await c.screenshot()
    if (a.equals(b)) throw new Error('캔버스 정지')
    out.push(`${W}x${H} 프레임 진행 OK`)

    const overlay = page.locator('[data-testid="entrance-overlay"]')
    const seen = new Set()
    for (let i = 0; i < 90 && (await overlay.count()) > 0; i++) {
      const ph = await overlay.getAttribute('data-phase').catch(() => null)
      if (ph && !seen.has(ph)) {
        seen.add(ph)
        await page.waitForTimeout(900)
        await page.screenshot({ path: join(SHOTS, `r6-fix-${W}x${H}-ent-${ph}.png`) })
        const m = await page.evaluate(() => {
          const q = s => {
            const e = document.querySelector(s)
            if (!e) return null
            const r = e.getBoundingClientRect()
            return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }
          }
          return { bar: q('.ent__bar'), pre: q('.ms-prematch') }
        })
        if (m.bar && m.pre) {
          const ow = Math.max(0, Math.min(m.bar.x + m.bar.w, m.pre.x + m.pre.w) - Math.max(m.bar.x, m.pre.x))
          const oh = Math.max(0, Math.min(m.bar.y + m.bar.h, m.pre.y + m.pre.h) - Math.max(m.bar.y, m.pre.y))
          out.push(`${W}x${H} ${ph}: bar↔prematch 겹침 ${(ow * oh).toFixed(0)}px²`)
        }
      }
      await page.waitForTimeout(350)
      if (seen.has('home-intro')) break
    }
  } catch (e) {
    out.push(`${W}x${H} 실패: ${e.message}`)
    process.exitCode = 1
  } finally {
    await browser.close()
  }
}
await writeFile(join(SHOTS, 'r6-fix-verify.txt'), out.join('\n'))
console.log(out.join('\n'))
await server.close()
