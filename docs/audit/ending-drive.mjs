// docs/audit/ending-drive.mjs
// 엔딩 화면 실주행 하니스 — 캠페인 8경기를 실제로 완주하지 않고 결말만 갈아끼운다.
//
// 원리: Vite dev 서버는 앱이 쓰는 것과 **같은 URL**로 모듈을 서빙하므로
// 페이지에서 `import('/src/game/campaignStore.ts')`를 하면 앱이 쓰는 그 store 인스턴스가 온다.
// 따라서 소스에 디버그 훅을 심지 않고도 상태를 주입할 수 있다(하니스는 코드를 건드리지 않는다).
//
// 실행: node docs/audit/ending-drive.mjs
//       ONLY=champion  특정 결말만
//       VPS='[[1440,900]]' 뷰포트 지정
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { AUDIT } from './auditfn.mjs'

const ROOT = '/Users/moo/Projects/daker/MH_Soccer-Manager'
const SHOTS = `${ROOT}/docs/audit/shots`
const BASE = process.env.BASE || 'http://localhost:5175'
const VPS = JSON.parse(process.env.VPS || '[[3456,2160],[1920,1080],[1440,900],[390,844]]')
const ONLY = process.env.ONLY || ''

fs.mkdirSync(SHOTS, { recursive: true })

const rec = (stage, opponentId, score, shootout) => ({
  stage, opponentId, score, ...(shootout ? { shootout } : {}), decisions: [],
})

// 조별 3경기(진출) / 조별 3경기(탈락)
const GROUP_PASS = [
  rec('group1', 'cze', [2, 1]),
  rec('group2', 'mex', [1, 1]),
  rec('group3', 'rsa', [2, 0]),
]
const GROUP_FAIL = [
  rec('group1', 'cze', [0, 2]),
  rec('group2', 'mex', [0, 3]),
  rec('group3', 'rsa', [1, 1]),
]
// 1위 경로 대진: r32 ecu / r16 eng / qf nor / sf arg / final esp
const T = { r32: 'ecu', r16: 'eng', qf: 'nor', sf: 'arg', final: 'esp' }
const WINS = {
  r32: rec('r32', T.r32, [3, 1]),
  r16: rec('r16', T.r16, [1, 0]),
  qf: rec('qf', T.qf, [2, 2], [4, 3]),
  sf: rec('sf', T.sf, [1, 0]),
}
const upTo = keys => keys.map(k => WINS[k])

const SCENARIOS = [
  {
    id: 'champion', title: '우승',
    state: {
      stage: 'ended', groupRank: 1, path: 'first',
      records: [...GROUP_PASS, ...upTo(['r32', 'r16', 'qf', 'sf']), rec('final', T.final, [2, 1])],
      ending: { reached: 'final', champion: true },
    },
  },
  {
    id: 'runnerup', title: '준우승(결승 패)',
    state: {
      stage: 'ended', groupRank: 1, path: 'first',
      records: [...GROUP_PASS, ...upTo(['r32', 'r16', 'qf', 'sf']), rec('final', T.final, [0, 2])],
      ending: { reached: 'final', champion: false },
    },
  },
  {
    id: 'sf-out', title: '4강 탈락',
    state: {
      stage: 'ended', groupRank: 1, path: 'first',
      records: [...GROUP_PASS, ...upTo(['r32', 'r16', 'qf']), rec('sf', T.sf, [1, 3])],
      ending: { reached: 'sf', champion: false },
    },
  },
  {
    id: 'qf-out-shootout', title: '8강 탈락(승부차기 패)',
    state: {
      stage: 'ended', groupRank: 1, path: 'first',
      records: [...GROUP_PASS, ...upTo(['r32', 'r16']), rec('qf', T.qf, [1, 1], [3, 4])],
      ending: { reached: 'qf', champion: false },
    },
  },
  {
    id: 'r16-out', title: '16강 탈락',
    state: {
      stage: 'ended', groupRank: 2, path: 'second',
      records: [...GROUP_PASS, rec('r32', 'can', [2, 0]), rec('r16', 'mar', [0, 1])],
      ending: { reached: 'r16', champion: false },
    },
  },
  {
    id: 'r32-out', title: '32강 탈락',
    state: {
      stage: 'ended', groupRank: 2, path: 'second',
      records: [...GROUP_PASS, rec('r32', 'can', [1, 2])],
      ending: { reached: 'r32', champion: false },
    },
  },
  {
    id: 'group-out', title: '조별리그 탈락(실제 역사와 같은 결말)',
    state: {
      stage: 'ended', groupRank: 3, path: null,
      records: GROUP_FAIL,
      ending: { reached: 'group3', champion: false },
    },
  },
]

const list = ONLY ? SCENARIOS.filter(s => s.id === ONLY) : SCENARIOS

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const out = { base: BASE, scenarios: {} }
const errsAll = []

for (const [W, H] of VPS) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 1,
    colorScheme: 'light', locale: 'ko-KR',
  })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
  page.on('console', m => { if (m.type() === 'error') errs.push('console:' + m.text().slice(0, 200)) })
  // AI 엔딩 서술의 키 없는 폴백 증거 — /api/narrate 응답 코드를 그대로 남긴다.
  page.on('response', r => { if (r.url().includes('/api/narrate')) errs.push(`narrate ${r.status()}`) })
  page.on('requestfailed', r => { if (r.url().includes('/api/narrate')) errs.push('narrate FAILED') })

  for (const s of list) {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(500)
    // 랜딩 → 캠페인 진입(정상 경로). 그 뒤 store만 결말 상태로 갈아끼운다.
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button,a')].find(e => e.textContent.includes('캠페인'))
      b?.click()
    })
    await page.waitForTimeout(400)
    const injected = await page.evaluate(async st => {
      const m = await import('/src/game/campaignStore.ts')
      m.useCampaignStore.setState(st)
      return true
    }, s.state)
    if (!injected) throw new Error('store 주입 실패')
    await page.waitForTimeout(700)

    const key = `${s.id}@${W}`
    const name = `ending-${s.id}-${W}`
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
    const audit = await page.evaluate(AUDIT)
    const text = await page.evaluate(() => document.body.innerText)
    const ladder = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.jl-row,.jl-gate,.jl-fold')]
      return rows.map(r => r.className + ' | ' + r.innerText.replace(/\n/g, ' / '))
    })
    out.scenarios[key] = {
      shot: `${name}.png`,
      overflowX: audit.overflowX, hidScroll: audit.hidScroll?.length ?? audit.hidScroll,
      overlaps: audit.overlaps?.length ?? audit.overlaps,
      lowContrast: audit.lowContrast?.length ?? audit.lowContrast,
      clippedLH: audit.clippedLH?.length ?? audit.clippedLH,
      tinyTap: audit.tinyTap?.length ?? audit.tinyTap,
      docH: audit.docH,
      raw: audit,
      ladder,
      text: text.slice(0, 2000),
    }
    console.log(`[${W}] ${s.id}: overflowX=${audit.overflowX} overlaps=${(audit.overlaps || []).length} hid=${(audit.hidScroll || []).length}`)
  }
  errsAll.push(...errs)
  await ctx.close()
}
out.console = errsAll
await browser.close()
fs.writeFileSync(`${ROOT}/docs/audit/ending-audit.json`, JSON.stringify(out, null, 2))
console.log('wrote docs/audit/ending-audit.json')
