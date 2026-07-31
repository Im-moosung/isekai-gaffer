#!/usr/bin/env node
// 일시정지 **실주행 증명** — 브라우저에서 실제로 무엇이 멈추고 무엇이 안 멈추는지 잰다.
//
// 단위 테스트는 "분이 전진하지 않는다"까지만 증명한다. 캔버스가 실제로 얼어붙었는지는
// 픽셀로만 알 수 있고, 그것도 **rAF가 살아 있는 창**에서만 의미가 있다(백그라운드 탭에서는
// 정지 여부와 무관하게 프레임이 멈춘다 — 이 함정 때문에 headless를 쓰지 않는다).
//
// 순서: ① 재생 중 프레임 diff > 0 확인(대조군) → ② 정지 → 프레임 diff == 0 + 분 고정
//       → ③ 재개 → 프레임 diff > 0 + 분이 이어서 전진(튀지 않음)
//
// 사용: node tools/match-layout/pause.mjs [--w 1440 --h 900]
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const W = Number(arg('w', 1440))
const H = Number(arg('h', 900))
const URL_BASE = arg('url', 'http://localhost:5173')

await mkdir(SHOTS, { recursive: true })
const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: [`--window-size=${W},${H + 120}`, '--mute-audio', '--disable-background-timer-throttling'],
})
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: 'ko-KR' })
const page = await ctx.newPage()
const log = []
const say = s => { log.push(s); console.log(s) }

/** 연속 두 프레임의 캔버스 픽셀이 다른가(= rAF가 그림을 갱신하고 있는가). */
async function frameMoving(canvas, gapMs = 300) {
  const a = await canvas.screenshot()
  await page.waitForTimeout(gapMs)
  const b = await canvas.screenshot()
  return a.length !== b.length || !a.equals(b)
}
const minute = () => page.locator('.bc-scorebug__clock').innerText()

let bad = 0
const check = (ok, label) => { say(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) bad++ }

try {
  await page.goto(`${URL_BASE}/`, { waitUntil: 'load' })
  await page.getByRole('button', { name: '바로 지휘하기' }).click()
  await page.getByRole('button', { name: '킥오프' }).click()
  const canvas = page.locator('canvas.m3d-canvas')
  await canvas.waitFor({ state: 'visible', timeout: 30000 })
  const skip = page.getByRole('button', { name: '건너뛰기' })
  await skip.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
  await skip.first().click({ timeout: 5000 }).catch(() => {})
  await page.locator('.bc-scorebug').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForTimeout(6000)

  // ── ① 대조군: 재생 중에는 프레임도 분도 움직인다 ──
  check(await frameMoving(canvas), '재생 중 캔버스 프레임이 갱신된다(대조군)')
  const m0 = await minute()
  await page.waitForTimeout(9000)
  const m1 = await minute()
  check(m0 !== m1, `재생 중 분이 전진한다 (${m0} → ${m1})`)
  check(await page.locator('.bc-scorebug__live').count() > 0, '재생 중 LIVE 표시가 있다')

  // ── ② 정지 ──
  await page.getByRole('button', { name: '일시정지' }).click()
  await page.waitForTimeout(700) // 진행 중이던 안무 전환이 끝날 여유
  const mPause = await minute()
  await page.screenshot({ path: join(SHOTS, `mlayout-pause-${W}x${H}-frozen.png`) })
  check(!(await frameMoving(canvas, 700)), '정지 중 캔버스가 얼어붙는다(픽셀 변화 0)')
  await page.waitForTimeout(12000)
  check((await minute()) === mPause, `정지 중 분이 멈춘다 (${mPause} 유지)`)
  check(await page.locator('.bc-scorebug__live').count() === 0, '정지 중 LIVE 표시가 사라진다')
  check(await page.locator('.bc-scorebug__paused').count() > 0, '정지 표식(스코어버그 일시정지 칩)이 뜬다')
  check(
    await page.getByRole('button', { name: '독려' }).isDisabled(),
    '정지 중 터치라인 외침이 잠긴다(개입 권한 0)',
  )
  // 정지 중에도 감독 타임은 눌러야 한다(그건 별도의 개입이다).
  check(await page.getByRole('button', { name: '감독 타임' }).isEnabled(), '정지 중에도 감독 타임은 가능하다')

  // 정지 화면 furniture의 대비 — 여기서만 뜨는 `.ms-frozen`을 픽셀로 잰다.
  const frozenContrast = await measureContrast(page, '.bc-scorebug__paused')
  say(`  정지 칩 대비 ${frozenContrast.worst}:1 (기준 ${frozenContrast.need}) — ${frozenContrast.pass ? 'PASS' : 'FAIL'}`)
  if (!frozenContrast.pass) bad++

  // ── ③ 재개 ──
  await page.getByRole('button', { name: '재생' }).click()
  await page.waitForTimeout(400)
  check(await frameMoving(canvas), '재개하면 캔버스가 다시 흐른다')
  const mResume = await minute()
  check(mResume === mPause, `재개 직후에는 아직 그 분이다 (${mResume}) — 분이 튀지 않는다`)
  await page.waitForTimeout(12000)
  const mAfter = await minute()
  check(mAfter !== mPause, `재개 후 분이 이어서 전진한다 (${mPause} → ${mAfter})`)

  // ── ④ 스페이스 단축키 ──
  await page.locator('body').click({ position: { x: W / 2, y: H / 2 } })
  await page.keyboard.press('Space')
  await page.waitForTimeout(400)
  check(await page.getByRole('button', { name: '재생' }).count() > 0, '스페이스로 정지된다')
  await page.keyboard.press('Space')
  await page.waitForTimeout(400)
  check(await page.getByRole('button', { name: '일시정지' }).count() > 0, '스페이스로 재개된다')
} catch (e) {
  say('ERROR ' + e.message)
  bad++
} finally {
  await writeFile(join(SHOTS, `mlayout-pause-${W}x${H}.log`), log.join('\n'))
  await browser.close()
}

say(`\n${bad ? 'FAIL' : 'PASS'} — 실패 ${bad}건`)
process.exit(bad ? 1 : 0)

/** 캔버스 위 요소 하나의 최악 대비비(배경을 픽셀로 읽는다). */
async function measureContrast(page, selector) {
  const t = await page.evaluate(sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return {
      color: cs.color, fs: parseFloat(cs.fontSize), fw: +cs.fontWeight || 400,
      x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)),
      w: Math.round(r.width), h: Math.round(r.height),
    }
  }, selector)
  if (!t) return { worst: 0, need: 4.5, pass: false }
  await page.addStyleTag({ content: `${selector} { color: transparent !important; }` })
  await page.waitForTimeout(120)
  const bg = await page.screenshot({ type: 'png' })
  const probe = await page.context().newPage()
  await probe.setContent('<canvas id="c"></canvas>')
  const out = await probe.evaluate(async ([b64, t]) => {
    const img = new Image()
    await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64 })
    const c = document.getElementById('c')
    c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(img, 0, 0)
    const lum = (r, gg, b) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b) }
    const d = g.getImageData(t.x, t.y, Math.max(1, t.w), Math.max(1, t.h)).data
    let maxL = 0
    for (let i = 0; i < d.length; i += 4) { const L = lum(d[i], d[i + 1], d[i + 2]); if (L > maxL) maxL = L }
    const m = String(t.color).match(/[\d.]+/g) || []
    const fgL = lum(+m[0] || 0, +m[1] || 0, +m[2] || 0)
    const need = t.fs >= 24 || (t.fs >= 18.66 && t.fw >= 700) ? 3 : 4.5
    const worst = (Math.max(fgL, maxL) + 0.05) / (Math.min(fgL, maxL) + 0.05)
    return { worst: +worst.toFixed(2), need, pass: worst >= need }
  }, [bg.toString('base64'), t])
  await probe.close()
  await page.addStyleTag({ content: `${selector} { color: revert !important; }` })
  return out
}
