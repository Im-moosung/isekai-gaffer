/* 랜딩 타이틀 캡처 — 헤드리스가 아니라 **실제 Chrome 창**으로 띄운다.
 * 이 프로젝트는 두 번 당했다: 백그라운드 탭에서는 rAF가 정지해 3D가 첫 프레임에 멈춘
 * 상태로 캡처된다. 그래서 캡처 전에 두 장을 찍어 픽셀 diff로 "프레임이 진행 중"임을
 * 먼저 증명하고, 진행하지 않으면 실패로 끝낸다.
 *
 * 사용: node tools/title/shots.mjs [tag]
 */
import fs from 'node:fs'
import { chromium } from 'playwright-core'

const tag = process.argv[2] || 'title'
const OUT = 'docs/audit/shots'
fs.mkdirSync(OUT, { recursive: true })

const VPS = process.env.VPS ? JSON.parse(process.env.VPS) : [
  [1600, 900],
  [1920, 1080],
  [390, 844],
]

const browser = await chromium.launch({ channel: 'chrome', headless: false })

/** 두 PNG 버퍼의 다른 바이트 비율(대략) — 0이면 프레임이 멈춘 것이다. */
function diffRatio(a, b) {
  if (a.length !== b.length) return 1
  let d = 0
  for (let i = 0; i < a.length; i += 97) if (a[i] !== b[i]) d++
  return d / Math.ceil(a.length / 97)
}

for (const [w, h] of VPS) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, locale: 'ko-KR' })
  const page = await ctx.newPage()
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
  await page.bringToFront()
  await page.waitForTimeout(7000)

  if (w > 720) {
    // 프레임 진행 증명 — 1.2초 간격 두 장이 달라야 한다.
    const s1 = await page.screenshot({ type: 'png' })
    await page.waitForTimeout(1200)
    const s2 = await page.screenshot({ type: 'png' })
    const r = diffRatio(s1, s2)
    console.log(`${w}×${h} 프레임 진행 diff=${(r * 100).toFixed(2)}%`)
    if (r < 0.005) {
      console.error(`  ✗ 프레임이 멈춰 있다(rAF 정지). 캡처 무효.`)
      process.exitCode = 1
    }
  }

  const file = `${OUT}/${tag}-${w}x${h}.png`
  await page.screenshot({ path: file, type: 'png' })
  console.log(`  → ${file}`)
  await ctx.close()
}

await browser.close()
