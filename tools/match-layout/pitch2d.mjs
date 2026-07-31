#!/usr/bin/env node
// 2D 하이라이트 실주행 계측 — 감사 ④⑤⑨⑩.
//
// 왜 headless가 아닌가: 헤드리스/백그라운드 탭에서는 rAF가 스로틀되어 캔버스가 얼어붙는다.
// 실제 창(channel:'chrome', headless:false)을 띄우고 **연속 프레임 픽셀 diff**로 진행을
// 먼저 증명한 뒤 계측한다(tools/match-layout/live.mjs와 같은 규약).
//
// 재는 것
//  ⑤ 진짜 도트가 움직이나 · 고스트가 없나
//     · SVG: `.pv-mover` 개수(고스트) + 하이라이트 중 `.pv-dot` cx/cy 변화량
//     · Pixi: 캔버스 픽셀에서 팀 색 blob을 세어 **개수 22 초과 = 고스트**로 판정
//  ④ 이름표: `.pv-name` 개수·박스 겹침, Pixi는 스크린샷 육안 + blob 옆 텍스트
//  ⑩ 줌: blob 지름(px)과 화면 안에 들어온 선수 수
//
// 사용: node tools/match-layout/pitch2d.mjs --tag after [--vps 1920x1080,...]
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const TAG = arg('tag', 'p2d')
const URL_BASE = arg('url', 'http://localhost:5173')
const VPS = arg('vps', '3456x2234,1920x1080,1440x900,390x844').split(',').map(s => s.split('x').map(Number))

await mkdir(SHOTS, { recursive: true })

/** SVG 피치의 DOM 계측(고스트·도트·이름표). */
const SVG_PROBE = () => {
  const root = document.querySelector('svg.pv-root')
  if (!root) return null
  const num = s => Number(s ?? '0')
  return {
    movers: root.querySelectorAll('.pv-mover').length,
    dots: [...root.querySelectorAll('.pv-dot')].map(n => [num(n.getAttribute('cx')), num(n.getAttribute('cy'))]),
    carrier: root.querySelectorAll('.pv-carrier').length,
    ball: [...root.querySelectorAll('.pv-ball')].map(n => [num(n.getAttribute('cx')), num(n.getAttribute('cy'))])[0] ?? null,
    names: [...root.querySelectorAll('.pv-name')].map(n => ({
      t: n.textContent, x: num(n.getAttribute('x')), y: num(n.getAttribute('y')),
    })),
    box: (() => { const r = root.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })(),
  }
}

/**
 * 캔버스 픽셀에서 팀 색 blob(=선수 도트)을 센다.
 * 도트는 팀 색 채움 + 흰 링이라, "팀 색에 가까운 픽셀"의 연결 성분이 곧 도트다.
 * 반환: 개수, 지름(px) 중앙값·최대값.
 */
const BLOBS = async ([b64, home, away]) => {
  const img = new Image()
  await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64 })
  const c = document.createElement('canvas')
  c.width = img.width; c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)
  const d = g.getImageData(0, 0, c.width, c.height).data
  const near = (i, col) =>
    Math.abs(d[i] - col[0]) < 46 && Math.abs(d[i + 1] - col[1]) < 46 && Math.abs(d[i + 2] - col[2]) < 46
  const out = {}
  for (const [key, col] of [['home', home], ['away', away]]) {
    const seen = new Uint8Array(c.width * c.height)
    const sizes = []
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const p = y * c.width + x
        if (seen[p] || !near(p * 4, col)) continue
        // BFS 연결 성분.
        let n = 0, x0 = x, x1 = x, y0 = y, y1 = y
        const q = [p]
        seen[p] = 1
        while (q.length) {
          const cur = q.pop()
          const cx = cur % c.width, cy = (cur - cx) / c.width
          n++
          if (cx < x0) x0 = cx; if (cx > x1) x1 = cx
          if (cy < y0) y0 = cy; if (cy > y1) y1 = cy
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= c.width || ny >= c.height) continue
            const np = ny * c.width + nx
            if (seen[np] || !near(np * 4, col)) continue
            seen[np] = 1
            q.push(np)
          }
        }
        // 라인·글자 안티앨리어스 파편 제외.
        if (n >= 30) sizes.push({ x0, x1, y0, y1 })
      }
    }
    // 등번호 글리프가 큰 도트를 좌우 초승달 두 조각으로 가른다 → **중심 거리**로 묶는다.
    // 묶는 반경은 이 프레임에서 가장 큰 조각의 지름에서 낸다(도트 하나보다 작다).
    const big = Math.max(1, ...sizes.map(s => Math.max(s.x1 - s.x0 + 1, s.y1 - s.y0 + 1)))
    const cen = s => ({ cx: (s.x0 + s.x1) / 2, cy: (s.y0 + s.y1) / 2 })
    const merged = []
    for (const s of sizes.slice().sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))) {
      const p = cen(s)
      const hit = merged.find(m => Math.hypot(p.cx - cen(m).cx, p.cy - cen(m).cy) < big * 0.55)
      if (hit) {
        hit.x0 = Math.min(hit.x0, s.x0); hit.x1 = Math.max(hit.x1, s.x1)
        hit.y0 = Math.min(hit.y0, s.y0); hit.y1 = Math.max(hit.y1, s.y1)
      } else merged.push({ ...s })
    }
    const dia = merged.map(m => Math.max(m.x1 - m.x0 + 1, m.y1 - m.y0 + 1)).sort((a, b) => a - b)
    const med = dia.length ? dia[dia.length >> 1] : 0
    out[key] = {
      count: dia.length,
      median: med,
      max: dia.length ? dia[dia.length - 1] : 0,
      // 화면 안에 **온전히** 들어온 도트(테두리에 닿지 않는 것) = 실제로 보이는 선수.
      inside: merged.filter(m => m.x0 > 1 && m.y0 > 1 && m.x1 < c.width - 2 && m.y1 < c.height - 2).length,
      // 등번호 없는 작은 원 = 안무 고스트 무버(정상 도트의 0.66배로 그려졌다).
      small: dia.filter(v => med > 0 && v < med * 0.75).length,
    }
  }
  return out
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  args: ['--window-size=1600,1000', '--mute-audio', '--disable-background-timer-throttling'],
})
const report = {}

for (const [W, H] of VPS) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, locale: 'ko-KR' })
  const page = await ctx.newPage()
  const logs = []
  page.on('console', m => { if (m.type() === 'error') logs.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 200)))
  const R = (report[`${W}x${H}`] = { console: logs })
  const shot = async name => {
    const p = join(SHOTS, `p2d-${TAG}-${W}x${H}-${name}.png`)
    await page.screenshot({ path: p })
    return `p2d-${TAG}-${W}x${H}-${name}.png`
  }

  try {
    await page.goto(`${URL_BASE}/`, { waitUntil: 'load' })
    await page.getByRole('button', { name: '바로 지휘하기' }).click()
    await page.getByRole('button', { name: '킥오프' }).click()
    const skip = page.getByRole('button', { name: '건너뛰기' })
    await skip.first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
    await skip.first().click({ timeout: 5000 }).catch(() => {})
    await page.locator('.bc-scorebug').waitFor({ state: 'visible', timeout: 30000 })

    // [2D] 렌더러로 전환.
    await page.getByRole('button', { name: '2D', exact: true }).click()
    const cv = page.locator('.ms-pitch-wrap canvas')
    await cv.waitFor({ state: 'visible', timeout: 20000 })

    // ── rAF 진행 증명(연속 프레임 픽셀 diff) ──
    const a = await cv.screenshot()
    await page.waitForTimeout(200)
    const b = await cv.screenshot()
    R.rafMoving = !a.equals(b)
    if (!R.rafMoving) throw new Error('캔버스 정지 — 계측 무의미')

    const teamCols = await page.evaluate(() => {
      const hex = v => { const m = v.trim().replace('#', ''); return [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16)) }
      const cs = getComputedStyle(document.documentElement)
      return { home: hex(cs.getPropertyValue('--bc-home') || '#e63946'), away: hex(cs.getPropertyValue('--bc-away') || '#4895ef') }
    })

    // ── 하이라이트를 기다린다(data-mode="3d" = 안무 재생 중) ──
    const wrap = page.locator('.ms-pitch-wrap')
    const started = Date.now()
    while (Date.now() - started < 90000) {
      if ((await wrap.getAttribute('data-mode')) === '3d') break
      await page.waitForTimeout(250)
    }
    R.gotHighlight = (await wrap.getAttribute('data-mode')) === '3d'

    // 하이라이트 중 8프레임 — 도트 blob 개수·지름, 프레임 간 픽셀 변화.
    const probe = await ctx.newPage()
    await probe.setContent('<body></body>')
    const frames = []
    let prev = null
    let movingFrames = 0
    for (let i = 0; i < 8; i++) {
      const png = await cv.screenshot()
      if (prev && !prev.equals(png)) movingFrames++
      prev = png
      frames.push(await probe.evaluate(BLOBS, [png.toString('base64'), teamCols.home, teamCols.away]))
      if (i === 2) R.highlightShot = await shot('highlight')
      await page.waitForTimeout(160)
    }
    await probe.close()
    R.movingFrames = movingFrames
    R.blobs = frames
    R.dotDiameterMedian = Math.max(...frames.map(f => Math.max(f.home.median, f.away.median)))
    R.dotDiameterMax = Math.max(...frames.map(f => Math.max(f.home.max, f.away.max)))
    R.visiblePlayersMax = Math.max(...frames.map(f => f.home.inside + f.away.inside))
    R.visiblePlayersMin = Math.min(...frames.map(f => f.home.inside + f.away.inside))
    R.ghostMax = Math.max(...frames.map(f => f.home.small + f.away.small))

    // ── SVG 작전판(하이라이트 사이) 계측 ──
    const t2 = Date.now()
    while (Date.now() - t2 < 60000) {
      if ((await wrap.getAttribute('data-mode')) === '2d') break
      await page.waitForTimeout(200)
    }
    const svgSeries = []
    for (let i = 0; i < 6; i++) {
      svgSeries.push(await page.evaluate(SVG_PROBE))
      await page.waitForTimeout(120)
    }
    R.boardShot = await shot('board')
    R.svg = {
      ghostMovers: Math.max(...svgSeries.map(s => s?.movers ?? 0)),
      names: svgSeries[0]?.names.length ?? 0,
      carrier: Math.max(...svgSeries.map(s => s?.carrier ?? 0)),
      dotsMovedPct: (() => {
        const a0 = svgSeries[0]?.dots ?? [], a1 = svgSeries.at(-1)?.dots ?? []
        if (!a0.length || a0.length !== a1.length) return null
        return Math.round(100 * a0.filter((p, i) => p[0] !== a1[i][0] || p[1] !== a1[i][1]).length / a0.length)
      })(),
      nameOverlap: (() => {
        const ns = svgSeries[0]?.names ?? []
        // viewBox 좌표에서 2.5px 폰트 · 높이 3.75 기준 대략 박스로 겹침 검사.
        let bad = 0
        for (let i = 0; i < ns.length; i++) {
          for (let j = i + 1; j < ns.length; j++) {
            const w = t => t.t.length * 2.5 + 1
            const A = { x: ns[i].x - w(ns[i]) / 2, y: ns[i].y - 1.9, w: w(ns[i]), h: 3.75 }
            const B = { x: ns[j].x - w(ns[j]) / 2, y: ns[j].y - 1.9, w: w(ns[j]), h: 3.75 }
            if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) bad++
          }
        }
        return bad
      })(),
    }
  } catch (e) {
    R.error = e.message
  } finally {
    await ctx.close()
  }

  const R2 = report[`${W}x${H}`]
  console.log(`\n── ${W}×${H} ──`)
  console.log(` rAF ${R2.rafMoving ? 'OK' : 'STOPPED'} · 하이라이트 ${R2.gotHighlight ? 'OK' : 'MISS'} · 변화 프레임 ${R2.movingFrames}/7`)
  console.log(` 도트 지름 중앙 ${R2.dotDiameterMedian}px · 최대 ${R2.dotDiameterMax}px · 화면 안 온전한 선수 ${R2.visiblePlayersMin}~${R2.visiblePlayersMax}/22 · 고스트(무번호 소형원) ${R2.ghostMax}`)
  if (R2.svg) console.log(` SVG 고스트무버 ${R2.svg.ghostMovers} · 이름표 ${R2.svg.names}(겹침 ${R2.svg.nameOverlap}) · 캐리어링 ${R2.svg.carrier} · 도트이동 ${R2.svg.dotsMovedPct}%`)
  if (R2.error) console.log(' ERROR ' + R2.error)
  if (R2.console?.length) console.log(' console: ' + R2.console.slice(0, 3).join(' | '))
}

await writeFile(join(SHOTS, `p2d-${TAG}.json`), JSON.stringify(report, null, 1))
await browser.close()
console.log(`\n결과 → docs/audit/shots/p2d-${TAG}.json`)
