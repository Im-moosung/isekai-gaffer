#!/usr/bin/env node
// 외침 분리(①)·외침 결과 배너(②) **실제 브라우저 확인**.
//
// 무엇을 증명해야 하는가:
//  1. 외침을 여러 번 질러도 `개입 N/5`가 줄지 않는다 — 두 자원이 실제로 갈렸는가.
//  2. 외칠 때마다 배너가 뜨고 **스스로 사라진다**.
//  3. 배너에 적히는 대상 선수가 **매번 같지 않다**.
//
// 왜 브라우저인가: 배너의 수명은 setTimeout + React 재렌더의 합이라 jsdom 단위 테스트가
// 재는 것(타이머 호출)과 사람이 보는 것(실제로 사라지는가)이 다르다. 자원 배지도 마찬가지로
// 두 컴포넌트(제어 pod · 하단 바)가 각자 store를 구독하는 구조라 함께 띄워 봐야 한다.
//
// 함정: 백그라운드 탭은 rAF를 멈춘다 → headless:false + 캡처 전 픽셀 diff로 프레임 진행 증명.
import { mkdir, writeFile } from 'node:fs/promises'
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
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
})
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
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

/** 화면에서 읽는 상태 — store가 아니라 **DOM**을 본다(유저가 보는 것이 계약이다). */
const readUi = () => page.evaluate(() => {
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null)
  const banner = document.querySelector('.sb-banner')
  return {
    interventions: txt([...document.querySelectorAll('.ms-controls .badge')].find(b => b.textContent.includes('개입'))),
    banner: txt(banner),
    names: banner ? [...banner.querySelectorAll('.tt-reactions__name')].map(n => n.textContent) : [],
    shoutDisabled: [...document.querySelectorAll('.sb-root button')].map(b => b.disabled),
    cooldown: txt(document.querySelector('.sb-root .sb-cool')),
  }
})

const results = []
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: /캠페인 시작/ }).click()
  await page.getByRole('button', { name: /준비하기/ }).click({ timeout: 20000 })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '킥오프' }).click()
  // 입장 연출은 이 검증의 대상이 아니다 — 건너뛴다.
  await page.getByRole('button', { name: /건너뛰/ }).click({ timeout: 30000 })
  await page.waitForTimeout(1500)
  // 최고 배속으로 — 외침 쿨다운 5분을 실시간으로 기다릴 이유가 없다.
  await page.getByRole('button', { name: '2x' }).click()

  const diff = await frameDiff()
  console.log(`[프레임 진행 증명] 픽셀 diff = ${diff.toFixed(4)} ${diff > 0.0001 ? 'OK' : 'FAIL — 캡처 무의미'}`)
  if (!(diff > 0.0001)) throw new Error('rAF 정지 — 캡처 무의미')

  const SHOUTS = ['독려', '더 뛰어', '침착', '칭찬']
  for (let i = 0; i < 4; i++) {
    const label = SHOUTS[i]
    // 쿨다운이 풀릴 때까지 기다린다 — 버튼 자신이 그 사실을 말한다.
    await page.waitForFunction(
      () => [...document.querySelectorAll('.sb-root button')].some(b => !b.disabled),
      null, { timeout: 60000 },
    )
    const before = await readUi()
    await page.getByRole('button', { name: label }).click()
    await page.waitForSelector('.sb-banner', { timeout: 3000 })
    const shown = await readUi()
    await page.screenshot({ path: join(OUT, `r9-shout-${i + 1}-${label}.png`) })
    // 자동 소멸(3.8초) — 4.5초 뒤에는 없어야 한다.
    await page.waitForTimeout(4500)
    const after = await readUi()
    results.push({ label, before, shown, after })
    console.log(`\n[${i + 1}] ${label}`)
    console.log(`   개입 배지: 외치기 전 ${before.interventions} → 외친 뒤 ${shown.interventions}`)
    console.log(`   배너: ${shown.banner}`)
    console.log(`   대상: ${shown.names.join(', ')}`)
    console.log(`   3.8초 뒤 배너: ${after.banner === null ? '사라짐 OK' : `남아 있음 FAIL(${after.banner})`}`)
    console.log(`   쿨다운 문구: ${shown.cooldown}`)
  }

  console.log('\n── 판정 ──')
  const badges = results.map(r => r.shown.interventions)
  const pass = [
    ['외침이 개입 5회를 쓰지 않는다', badges.every(b => b === badges[0] && /5\s*\/\s*5|5\/5/.test(b ?? ''))],
    ['외칠 때마다 배너가 뜬다', results.every(r => !!r.shown.banner)],
    ['배너는 스스로 사라진다', results.every(r => r.after.banner === null)],
    ['대상이 매번 같지는 않다', new Set(results.map(r => r.names_ ?? r.shown.names.slice().sort().join('|'))).size > 1],
    ['외친 직후에는 4버튼 전부 잠긴다', results.every(r => r.shown.shoutDisabled.every(Boolean))],
  ]
  for (const [k, v] of pass) console.log(`  ${v ? 'PASS' : 'FAIL'} — ${k}`)
  await writeFile(join(OUT, 'r9-shout.json'), JSON.stringify(results, null, 2))
  console.log(`\n캡처 → docs/audit/shots/r9-shout-*.png · 표본 → r9-shout.json`)
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-20).join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  await server.close()
}
