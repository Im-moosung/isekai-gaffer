/* 제목 두 절이 **어떤 폭에서도 각각 한 줄**인지 확인한다.
 * "내가," 뒤에서 끊기거나 "국대 / 감독?"으로 갈라지면 밈 문장의 리듬이 죽는다는
 * 계약(App.css 주석)을 폭 스윕으로 못 박는 용도. getClientRects().length가 곧 줄 수다.
 * 사용: node tools/title/wrap.mjs
 */
import { chromium } from 'playwright-core'

const WIDTHS = [320, 360, 390, 414, 480, 600, 720, 834, 1024, 1280, 1440, 1600, 1920, 2560, 3456]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ko-KR' })
const page = await ctx.newPage()
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })

let bad = 0
for (const w of WIDTHS) {
  await page.setViewportSize({ width: w, height: 844 })
  await page.waitForTimeout(120)
  const r = await page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const rows = ['.landing__title-line--sub', '.landing__title-line--main'].map((s) => {
      const el = q(s)
      return { sel: s, lines: el.getClientRects().length, w: Math.round(el.getBoundingClientRect().width) }
    })
    return { rows, docW: document.documentElement.scrollWidth, winW: window.innerWidth }
  })
  const over = r.docW > r.winW
  const wrapped = r.rows.some((x) => x.lines !== 1)
  if (over || wrapped) bad++
  console.log(
    `${String(w).padStart(4)}  ${r.rows.map((x) => `${x.lines}줄/${x.w}px`).join('  ')}` +
      `  가로오버플로=${over ? 'YES' : 'no'}${wrapped ? '  ← 줄바꿈!' : ''}`,
  )
}
console.log(bad ? `\nFAIL — ${bad}개 폭에서 문제` : '\nPASS — 모든 폭에서 두 절이 각각 한 줄, 가로 오버플로 없음')
await browser.close()
process.exit(bad ? 1 : 0)
