// ② 재현 — 작전판에서 선수 도트 선택 시 렌더 상태를 찍는다.
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = process.env.APP_ROOT || resolve(import.meta.dirname, '../..')
const OUT_ROOT = process.env.OUT_ROOT || ROOT
const OUT = join(OUT_ROOT, 'docs/audit/shots')
const TAG = process.env.TAG || 'r7-sel'

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
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--window-size=1440,1000', '--mute-audio'] })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 })
const logs = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

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
  await sleep(800)
  await page.getByRole('button', { name: /바로 지휘하기/ }).click()
  await sleep(1500)
  console.log('데모 화면:', (await page.locator('body').innerText()).slice(0, 400).replace(/\n+/g, ' | '))

  // 킥오프 버튼이 있으면 누른다
  const kick = page.getByRole('button', { name: '킥오프' })
  if (await kick.count()) {
    await kick.first().click()
    console.log('킥오프 클릭')
    // 입장 연출 건너뛰기
    await sleep(2500)
    const skip = page.locator('text=건너뛰기')
    if (await skip.count()) { await skip.first().click({ force: true }); console.log('입장 건너뛰기') }
  }
  await sleep(3000)
  for (let i = 0; i < 40 && !(await page.getByRole('button', { name: '일시정지' }).count()); i++) {
    const s2 = page.locator('text=건너뛰기')
    if (await s2.count()) await s2.first().click({ force: true }).catch(() => {})
    await sleep(1000)
  }
  console.log('경기 화면:', (await page.locator('body').innerText()).slice(0, 500).replace(/\n+/g, ' | '))

  // 일시정지 → 작전판
  const coachBtn = page.getByRole('button', { name: '감독 타임' })
  if (await coachBtn.count()) { await coachBtn.first().click(); console.log('감독 타임 클릭') }
  await page.getByRole('dialog', { name: '작전판' }).waitFor({ timeout: 15000 })
  await sleep(1200)
  console.log('작전판 프레임 diff =', (await frameDiff()).toFixed(4))

  const board = page.locator('.tb-board__pitch')
  await board.screenshot({ path: join(OUT, `${TAG}-board-idle.png`) })

  // 첫 클릭 가능 도트 선택
  const dots = page.locator('.tb-board__pitch .pv-dotg--click')
  console.log('클릭 가능 도트 수:', await dots.count())
  const target = dots.nth(6)
  await target.click({ force: true })
  await sleep(700)
  await board.screenshot({ path: join(OUT, `${TAG}-board-selected.png`) })

  // 선택된 도트 주변 확대 캡처
  const info = await page.evaluate(() => {
    const ring = document.querySelector('.tb-board__pitch .pv-ring')
    if (!ring) return null
    const r = ring.getBoundingClientRect()
    const cs = getComputedStyle(ring)
    const g = ring.closest('g')
    return {
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      stroke: cs.stroke, fill: cs.fill, sw: cs.strokeWidth, filter: cs.filter, opacity: cs.opacity,
      anim: cs.animationName + ' ' + cs.animationDuration,
      siblings: [...g.children].map(c => c.tagName + '.' + (c.getAttribute('class') || '')),
      ringR: ring.getAttribute('r'),
      dotCount: document.querySelectorAll('.tb-board__pitch .pv-dot').length,
      ringCount: document.querySelectorAll('.tb-board__pitch .pv-ring').length,
      accent: getComputedStyle(document.querySelector('.tb-board__pitch .pv-root')).getPropertyValue('--bc-accent'),
    }
  })
  console.log('링 정보:', JSON.stringify(info, null, 2))
  const act = await page.evaluate(() => {
    const a = document.activeElement
    const cs = getComputedStyle(a)
    const bb = a.getBoundingClientRect?.()
    return { tag: a.tagName, cls: a.getAttribute?.('class'), outline: cs.outline, outlineOffset: cs.outlineOffset,
      matches: a.matches(':focus-visible'), bbox: bb && { w: bb.width, h: bb.height } }
  })
  console.log('활성 요소:', JSON.stringify(act))
  /* 진단용 실험(before 전용) — SKIP_EXP=1이면 건너뛴다.
  // 실험 A: outline 제거
  await page.addStyleTag({ content: '.pv-dotg:focus-visible { outline: none !important; }' })
  await sleep(400)
  await page.screenshot({ path: join(OUT, `${TAG}-exp-nooutline.png`), clip: { x: Math.max(0, info.rect.x - 60), y: Math.max(0, info.rect.y - 60), width: info.rect.w + 120, height: info.rect.h + 120 } })
  // 실험 B: 링까지 제거
  await page.addStyleTag({ content: '.pv-ring { display: none !important; }' })
  await sleep(400)
  await page.screenshot({ path: join(OUT, `${TAG}-exp-noring.png`), clip: { x: Math.max(0, info.rect.x - 60), y: Math.max(0, info.rect.y - 60), width: info.rect.w + 120, height: info.rect.h + 120 } })
  */
  if (info) {
    const pad = 60
    await page.screenshot({
      path: join(OUT, `${TAG}-zoom-selected.png`),
      clip: { x: Math.max(0, info.rect.x - pad), y: Math.max(0, info.rect.y - pad), width: info.rect.w + pad * 2, height: info.rect.h + pad * 2 },
    })
  }
  // 키보드 포커스만 걸린 도트(선택 아님) — **진짜 Tab**으로 옮긴다.
  // 스크립트의 el.focus()는 크롬에서 :focus-visible을 켜지 않으므로 측정이 거짓이 된다.
  let fbox = null
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab')
    const st = await page.evaluate(() => {
      const a = document.activeElement
      if (!a || !a.classList?.contains('pv-dotg--click')) return null
      const r = a.getBoundingClientRect()
      return { fv: a.matches(':focus-visible'), stroke: getComputedStyle(a.querySelector('.pv-dot')).stroke,
        outline: getComputedStyle(a).outline, x: r.x, y: r.y, w: r.width, h: r.height }
    })
    if (st) { fbox = st; break }
  }
  console.log('Tab 포커스 도트:', JSON.stringify(fbox))
  // ── 게이트: 브라우저 기본 포커스 링이 되살아나면 여기서 실패한다 ──
  // (SVG 안에서 CSS px = 사용자 단위라, outline이 살아 있으면 viewBox 배율만큼 부푼
  //  검은 덩어리가 되어 도트를 덮는다 — 사용자 지적 2026-08-01 ②의 정체.)
  if (!fbox) throw new Error('Tab으로 도트에 포커스가 가지 않는다 — 키보드 조작 자체가 깨졌다')
  if (!/ none /.test(fbox.outline)) throw new Error(`포커스 아웃라인이 살아 있다: ${fbox.outline}`)
  if (fbox.stroke !== 'rgb(255, 255, 255)') throw new Error(`포커스 표시(흰 테두리)가 없다: ${fbox.stroke}`)
  const selStroke = await page.evaluate(() => getComputedStyle(document.querySelector('.pv-dot--hl')).stroke)
  console.log('선택 도트 테두리:', selStroke)
  if (fbox) {
    await sleep(300)
    await page.screenshot({
      path: join(OUT, `${TAG}-zoom-focus.png`),
      clip: { x: Math.max(0, fbox.x - 50), y: Math.max(0, fbox.y - 50), width: fbox.w + 100, height: fbox.h + 100 },
    })
  }
  console.log('완료')
} catch (e) {
  console.error('실패:', e.message)
  console.error(logs.slice(-25).join('\n'))
  await page.screenshot({ path: join(OUT, `${TAG}-fail.png`) }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, `${TAG}.log`), logs.join('\n'))
  await sleep(500)
  await browser.close()
  await server.close()
}
