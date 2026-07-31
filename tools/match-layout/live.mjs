#!/usr/bin/env node
// 경기 화면 레이아웃 **실주행 계측** — 캔버스 실측 크기 · 오버레이 대비비 · 스크린샷.
//
// 왜 headless가 아닌가: 헤드리스/백그라운드 탭에서는 rAF가 스로틀되어 캔버스가 얼어붙는다.
// "3D가 멈췄다"는 오진의 원인이다. 실제 창(channel:'chrome', headless:false)을 띄우고
// **연속 프레임 픽셀 diff**로 진행을 먼저 증명한 뒤 계측한다.
//
// 대비비는 DOM 배경으로 잴 수 없다 — 3D 캔버스 위 텍스트의 배경은 픽셀에만 있다.
// landing-contrast.mjs와 같은 방식으로: ① 오버레이 텍스트를 숨기고 배경만 캡처 →
// ② 그 이미지를 다시 브라우저 캔버스에 그려 각 텍스트 bbox의 **가장 밝은 지점**을
// 샘플링 → ③ WCAG 대비비. 평균이 아니라 최악을 본다(잔디·조명탑이 국소적으로 밝다).
//
// 사용: node tools/match-layout/live.mjs --tag before [--vps 3456x2234,1920x1080,1440x900,390x844]
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const TAG = arg('tag', 'live')
const URL_BASE = arg('url', 'http://localhost:5173')
const VPS = arg('vps', '3456x2234,1920x1080,1440x900,390x844')
  .split(',')
  .map(s => s.split('x').map(Number))

await mkdir(SHOTS, { recursive: true })

/** 캔버스/피치 실측 + 레이아웃 지표. 페이지 안에서 실행된다. */
const MEASURE = () => {
  const box = sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const canvas =
    box('canvas.m3d-canvas') || box('canvas.pixi-canvas') || box('.ms-pitch-wrap canvas') || box('svg.pv-root')
  const vw = innerWidth
  const vh = innerHeight
  return {
    vw,
    vh,
    canvas,
    canvasPct: canvas ? +((canvas.w * canvas.h) / (vw * vh) * 100).toFixed(1) : 0,
    /** 캔버스 위쪽 빈 띠(px) — 사용자 지적 "위쪽 여유 공간" 그 자체. */
    deadTop: canvas ? canvas.y : null,
    deadBottom: canvas ? Math.max(0, vh - (canvas.y + canvas.h)) : null,
    topbar: box('.ms-topbar'),
    bottombar: box('.ms-bottombar'),
    docH: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }
}

/** 캔버스 위에 떠 있는 텍스트 요소 수집(자체 불투명 배경이 있으면 제외 대상 표시). */
const OVERLAY_TEXTS = () => {
  const cv =
    document.querySelector('canvas.m3d-canvas') ||
    document.querySelector('.ms-pitch-wrap canvas') ||
    document.querySelector('svg.pv-root')
  if (!cv) return []
  const cr = cv.getBoundingClientRect()
  const out = []
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return
    const own = [...el.childNodes]
      .filter(n => n.nodeType === 3 && n.textContent.trim())
      .map(n => n.textContent.trim())
      .join(' ')
    if (!own) return
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return
    // 캔버스 영역과 겹치는 텍스트만 — 그것만 배경을 픽셀로 재야 한다.
    const ix = Math.min(r.right, cr.right) - Math.max(r.left, cr.left)
    const iy = Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top)
    if (ix <= 0 || iy <= 0) return
    out.push({
      sel:
        el.tagName.toLowerCase() +
        '.' +
        String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.'),
      text: own.slice(0, 24),
      color: cs.color,
      fs: parseFloat(cs.fontSize),
      fw: +cs.fontWeight || 400,
      // 자기 또는 조상이 불투명(α≥0.9) 배경을 가지면 캔버스 픽셀과 무관하다.
      // ★ 단, **캔버스를 품은 조상**에서 멈춘다. 그 위쪽 배경(.ms-root의 --s-0 등)은
      //   캔버스보다 아래에 깔리므로 텍스트 배경이 아니다 — 여기서 멈추지 않으면
      //   모든 텍스트가 "불투명 배경 있음"으로 잡혀 측정이 통째로 무의미해진다.
      opaque: (() => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          if (n.contains(cv)) return false
          const m = String(getComputedStyle(n).backgroundColor).match(/[\d.]+/g)
          if (m && (m[3] === undefined ? 1 : +m[3]) >= 0.9) return true
        }
        return false
      })(),
      x: Math.max(0, Math.round(r.left)),
      y: Math.max(0, Math.round(r.top)),
      w: Math.round(r.width),
      h: Math.round(r.height),
    })
  })
  return out
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--window-size=1440,900', '--mute-audio', '--disable-background-timer-throttling'],
})

const report = {}

for (const [W, H] of VPS) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'ko-KR',
  })
  const page = await ctx.newPage()
  const logs = []
  page.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 200)))
  const R = (report[`${W}x${H}`] = { console: logs })
  const shot = async name => {
    const p = join(SHOTS, `mlayout-${TAG}-${W}x${H}-${name}.png`)
    await page.screenshot({ path: p })
    return p
  }

  try {
    await page.goto(`${URL_BASE}/`, { waitUntil: 'load' })
    await page.getByRole('button', { name: '바로 지휘하기' }).click()
    await page.getByRole('button', { name: '킥오프' }).click()

    // ── ① 캔버스가 실제로 갱신되는지부터 증명한다(rAF 스로틀 함정) ──
    const cv = page.locator('canvas.m3d-canvas')
    await cv.waitFor({ state: 'visible', timeout: 30000 })
    const a = await cv.screenshot()
    await page.waitForTimeout(240)
    const b = await cv.screenshot()
    R.rafMoving = a.length !== b.length || !a.equals(b)
    if (!R.rafMoving) throw new Error('캔버스 정지 — 계측 무의미')

    // 입장 연출을 건너뛰고 실제 경기 재생으로 들어간다.
    // ★ 건너뛰기 버튼이 뜨기 전에 클릭하면 조용히 실패하고 입장 화면을 계측하게 된다
    //   (실제로 한 번 당했다). 스코어버그가 뜰 때까지 기다려 재생 진입을 확증한다.
    const skip = page.getByRole('button', { name: '건너뛰기' })
    await skip.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {})
    await skip.first().click({ timeout: 5000 }).catch(() => {})
    await page.locator('.bc-scorebug').waitFor({ state: 'visible', timeout: 30000 })
    // 재생이 몇 분 진행되어 티커·HUD가 실제 문장을 물고 있는 상태에서 잰다.
    await page.waitForTimeout(9000)

    R.playing = await shot('play')
    R.metrics = await page.evaluate(MEASURE)

    // ── ② 오버레이 대비 — 텍스트를 숨기고 배경만 캡처해 픽셀로 잰다 ──
    const targets = (await page.evaluate(OVERLAY_TEXTS)).filter(t => !t.opaque)
    R.overlayTextCount = targets.length
    if (targets.length) {
      // 텍스트 레이어만 투명화(스크림·블러는 남긴다 — 재고 싶은 것은 합성된 배경이다).
      const sels = [...new Set(targets.map(t => t.sel.split('.').slice(1).map(c => '.' + c).join('')))].filter(Boolean)
      await page.addStyleTag({
        content: `${sels.join(',')} { color: transparent !important; }`,
      })
      await page.waitForTimeout(120)
      const bg = await page.screenshot({ type: 'png' })
      const probe = await ctx.newPage()
      await probe.setContent('<canvas id="c"></canvas>')
      R.contrast = await probe.evaluate(async ([b64, ts]) => {
        const img = new Image()
        await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64 })
        const c = document.getElementById('c')
        c.width = img.width
        c.height = img.height
        const g = c.getContext('2d', { willReadFrequently: true })
        g.drawImage(img, 0, 0)
        const lum = (r, gg, b) => {
          const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
          return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b)
        }
        const parse = s => { const m = String(s).match(/[\d.]+/g) || []; return [+m[0] || 0, +m[1] || 0, +m[2] || 0] }
        return ts.map(t => {
          const w = Math.max(1, Math.min(t.w, c.width - t.x))
          const h = Math.max(1, Math.min(t.h, c.height - t.y))
          const d = g.getImageData(t.x, t.y, w, h).data
          let maxL = 0, sum = 0, n = 0
          for (let i = 0; i < d.length; i += 4) {
            const L = lum(d[i], d[i + 1], d[i + 2])
            if (L > maxL) maxL = L
            sum += L; n++
          }
          const fg = parse(t.color)
          const fgL = lum(fg[0], fg[1], fg[2])
          const ratio = L2 => (Math.max(fgL, L2) + 0.05) / (Math.min(fgL, L2) + 0.05)
          const need = t.fs >= 24 || (t.fs >= 18.66 && t.fw >= 700) ? 3 : 4.5
          return {
            sel: t.sel, text: t.text, fs: t.fs,
            worst: +ratio(maxL).toFixed(2), avg: +ratio(sum / n).toFixed(2),
            need, pass: ratio(maxL) >= need,
          }
        })
      }, [bg.toString('base64'), targets])
      await probe.close()
    } else {
      R.contrast = []
    }
  } catch (e) {
    R.error = e.message
  } finally {
    await ctx.close()
  }

  const m = report[`${W}x${H}`].metrics
  console.log(`\n── ${W}×${H} ──`)
  if (m) {
    console.log(
      `캔버스 ${m.canvas?.w}×${m.canvas?.h} (뷰포트의 ${m.canvasPct}%) · 상단 빈 띠 ${m.deadTop}px · 하단 ${m.deadBottom}px · overflowX ${m.overflowX}`,
    )
  }
  for (const c of report[`${W}x${H}`].contrast ?? []) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'} ${c.worst}:1 (평균 ${c.avg}, 기준 ${c.need}) ${c.sel} "${c.text}"`)
  }
  if (report[`${W}x${H}`].error) console.log('  ERROR ' + report[`${W}x${H}`].error)
}

await writeFile(join(SHOTS, `mlayout-${TAG}.json`), JSON.stringify(report, null, 1))
await browser.close()
console.log(`\n결과 → docs/audit/shots/mlayout-${TAG}.json`)
