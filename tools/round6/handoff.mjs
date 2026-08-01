#!/usr/bin/env node
// 입장 연출 **종료 → 킥오프** 인계 구간만 조밀하게 찍는다(회귀 의심 B-2).
//
// 묻는 것: 연출이 끝나고 첫 경기 프레임이 그려지는 순간, 22명이 순간이동하는가.
// 연출은 kickoffPoint()에서 전반 회전(FIRST_HALF_ENDS=-1)을 흡수하고 Match3D는
// rotateFrame(frame, FIRST_HALF_ENDS)로 같은 회전을 건다 — 두 값이 어긋나면
// 인계 프레임에서 선수들이 반대편으로 튄다.
//
// 방법: 오버레이가 사라지는 순간을 폴링으로 잡고 그 전후를 120 ms 간격으로 캡처한 뒤,
// 연속 프레임 사이의 픽셀 변화량을 재서 **인계 프레임만 유별나게 큰지** 본다.
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const W = 1600
const H = 900

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

/** 두 PNG 버퍼의 대략적 차이(같은 크기일 때 바이트 불일치 비율). */
function diffRatio(a, b) {
  if (!a || !b || a.length !== b.length) return 1
  let n = 0
  for (let i = 0; i < a.length; i += 97) if (a[i] !== b[i]) n++
  return n / Math.ceil(a.length / 97)
}

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
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
const out = []
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()
  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 30000 })
  const a0 = await canvas.screenshot()
  await page.waitForTimeout(240)
  if (a0.equals(await canvas.screenshot())) throw new Error('캔버스 정지')
  out.push('프레임 진행 OK')

  const overlay = page.locator('[data-testid="entrance-overlay"]')
  // 마지막 단계(disperse)까지 기다린다 — 연출 전체 62.7 s.
  await page
    .waitForFunction(() => document.querySelector('[data-testid="entrance-overlay"]')?.dataset.phase === 'disperse', null, {
      timeout: 90000,
    })
    .catch(() => out.push('주의: disperse 단계를 관측하지 못했다(먼저 끝났을 수 있다)'))

  // 인계 전후를 조밀하게: 오버레이가 사라질 때까지 찍고, 사라진 뒤로도 8장 더.
  const frames = []
  let gone = 0
  for (let i = 0; i < 40; i++) {
    const present = (await overlay.count()) > 0
    const buf = await canvas.screenshot()
    frames.push({ i, present, buf })
    if (!present) gone++
    if (gone >= 8) break
    await page.waitForTimeout(120)
  }
  // 인계 인덱스 = present가 처음 false가 되는 지점
  const cut = frames.findIndex(f => !f.present)
  out.push(`총 ${frames.length}프레임 · 인계 인덱스 ${cut}`)
  for (let i = 1; i < frames.length; i++) {
    const d = diffRatio(frames[i - 1].buf, frames[i].buf)
    out.push(`  f${i - 1}→f${i} 변화 ${(d * 100).toFixed(1)}%${i === cut ? '   ← 인계 프레임' : ''}`)
  }
  // 인계 전후 6장을 파일로 남긴다.
  const from = Math.max(0, cut - 3)
  for (let i = from; i < Math.min(frames.length, cut + 5); i++) {
    await writeFile(join(SHOTS, `r6-handoff-${String(i - from).padStart(2, '0')}-${frames[i].present ? 'ent' : 'play'}.png`), frames[i].buf)
  }
} catch (e) {
  out.push(`실패: ${e.message}`)
  process.exitCode = 1
} finally {
  await writeFile(join(SHOTS, 'r6-handoff.txt'), out.join('\n'))
  console.log(out.join('\n'))
  await browser.close()
  await server.close()
}
