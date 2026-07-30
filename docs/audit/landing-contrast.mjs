/* 랜딩 대비 실측 — 3D 캔버스 위 텍스트는 DOM 배경색이 없어 일반 감사 스크립트가
 * 배경을 알 수 없다(effBg가 조상을 훑어도 canvas 픽셀은 못 본다).
 * 그래서 실제로 합성된 화면을 다시 읽어 글자 자리의 배경 휘도를 픽셀로 잰다.
 *
 * 방법: ① 텍스트 레이어를 숨기고 배경만 스크린샷 → ② 그 이미지를 캔버스에 그려
 * 각 텍스트 요소의 bbox 픽셀을 샘플링 → ③ 그 구역에서 **가장 밝은 쪽**(최악 조건)과
 * 텍스트 색의 WCAG 대비비를 계산한다. 평균이 아니라 최악을 보는 이유는
 * 야간 경기장 배경이 조명탑·잔디 때문에 국소적으로 매우 밝기 때문이다.
 *
 * 사용: node docs/audit/landing-contrast.mjs [width] [height]
 */
import { chromium } from 'playwright-core'

const W = +(process.argv[2] || 1440)
const H = +(process.argv[3] || 900)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'ko-KR' })
const page = await ctx.newPage()
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
// 3D 로드 + 페이드인(--dur-4 800ms)이 끝날 때까지
await page.waitForTimeout(6000)

/** 텍스트 요소들의 bbox와 실제 색 */
const targets = await page.evaluate(() => {
  const out = []
  document.querySelectorAll('.landing *').forEach(el => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim())
      .map(n => n.textContent.trim()).join(' ')
    if (!own) return
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return
    out.push({
      sel: el.tagName.toLowerCase() + '.' + String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.'),
      text: own.slice(0, 26), color: cs.color, fs: parseFloat(cs.fontSize), fw: +cs.fontWeight || 400,
      // 자기 또는 조상이 불투명 배경을 가지면 3D와 무관하다(버튼 채움 안의 화살표 등).
      ownBg: (() => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const c = getComputedStyle(n).backgroundColor
          const m = String(c).match(/[\d.]+/g)
          if (m && (m[3] === undefined ? 1 : +m[3]) >= 0.9) return c
        }
        return 'rgba(0, 0, 0, 0)'
      })(),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
    })
  })
  return out
})

// 배경만 남긴 화면을 캡처한다(텍스트 레이어 숨김). 스크림은 그대로 둔다 —
// 우리가 재고 싶은 것은 "스크림까지 합성된 뒤의 배경"이다.
await page.addStyleTag({ content: '.landing__content, .landing__actions { visibility: hidden !important; }' })
await page.waitForTimeout(300)
const bgShot = await page.screenshot({ type: 'png' })

// 캡처를 다시 브라우저에 넣어 픽셀을 읽는다(Node에 PNG 디코더를 두지 않기 위해).
const probe = await ctx.newPage()
await probe.setContent('<canvas id="c"></canvas>')
const results = await probe.evaluate(async ([b64, targets]) => {
  const img = new Image()
  await new Promise(res => { img.onload = res; img.src = 'data:image/png;base64,' + b64 })
  const c = document.getElementById('c')
  c.width = img.width; c.height = img.height
  const g = c.getContext('2d', { willReadFrequently: true })
  g.drawImage(img, 0, 0)

  const lum = (r, gg, b) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b) }
  const parse = s => { const m = String(s).match(/[\d.]+/g) || []; return [+m[0] || 0, +m[1] || 0, +m[2] || 0, m[3] === undefined ? 1 : +m[3]] }

  return targets.map(t => {
    const d = g.getImageData(t.x, t.y, Math.max(1, t.w), Math.max(1, t.h)).data
    let maxL = 0, minL = 1, sum = 0, n = 0
    for (let i = 0; i < d.length; i += 4) {
      const L = lum(d[i], d[i + 1], d[i + 2])
      if (L > maxL) maxL = L
      if (L < minL) minL = L
      sum += L; n++
    }
    const fg = parse(t.color)
    const fgL = lum(fg[0], fg[1], fg[2])
    const ratio = L2 => (Math.max(fgL, L2) + 0.05) / (Math.min(fgL, L2) + 0.05)
    const need = (t.fs >= 24 || (t.fs >= 18.66 && t.fw >= 700)) ? 3 : 4.5
    return {
      ...t,
      worst: +ratio(maxL).toFixed(2), // 배경이 가장 밝은 지점 = 흰 글자에 최악
      avg: +ratio(sum / n).toFixed(2),
      need,
      pass: ratio(maxL) >= need,
    }
  })
}, [bgShot.toString('base64'), targets])

console.log(`랜딩 대비 실측 ${W}×${H} (배경 최악 지점 기준)\n`)
console.log(['판정', '최악', '평균', '기준', 'px', '요소', '텍스트'].join('\t'))
let fails = 0
for (const r of results) {
  const opaqueOwnBg = !/rgba\(0, 0, 0, 0\)|transparent/.test(r.ownBg)
  if (opaqueOwnBg) { console.log(['skip', r.worst, r.avg, r.need, r.fs, r.sel, r.text].join('\t') + '  (자체 불투명 배경)'); continue }
  if (!r.pass) fails++
  console.log([r.pass ? 'PASS' : 'FAIL', r.worst, r.avg, r.need, r.fs, r.sel, r.text].join('\t'))
}
console.log(`\n${fails ? 'FAIL' : 'PASS'} — 미달 ${fails}건`)

await browser.close()
process.exit(fails ? 1 : 0)
