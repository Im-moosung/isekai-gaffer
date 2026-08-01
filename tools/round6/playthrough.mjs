#!/usr/bin/env node
// 6라운드 전 구간 실플레이 감사 — 랜딩 → 캠페인 허브 → 워룸 → 입장(full/short)
// → 전반 → 하프타임(작전판·코치 회의·교체) → 후반 → 풀타임 → 엔딩.
//
// 왜 headless가 아닌가: 헤드리스/백그라운드 탭은 rAF를 스로틀해 캔버스가 얼어붙는다.
// 그 정지 화면을 보고 "3D가 죽었다"고 오진한 적이 두 번 있다. 실제 Chrome 창을 띄우고
// **캡처 직전마다 연속 프레임 픽셀 diff**로 진행을 증명한 뒤에만 찍는다.
//
// 사용: node tools/round6/playthrough.mjs [--w 1600 --h 900] [--mode full|short]
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer as netCreateServer } from 'node:net'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const ROOT = resolve(import.meta.dirname, '../..')
const SHOTS = join(ROOT, 'docs/audit/shots')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : dflt
}
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
const TAG = `r6-${W}x${H}`

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

await mkdir(SHOTS, { recursive: true })
const port = await freePort()
const server = await createServer({
  root: ROOT,
  // HMR을 끈다 — 다른 에이전트가 같은 트리를 동시에 고치는 중이라 실주행 도중
  // 모듈이 갈아끼워지면 경기 상태가 리셋돼 계측이 무의미해진다.
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
const logs = []
const notes = []
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', e => logs.push(`[error] ${e.message}`))

/** 캔버스가 실제로 갱신 중인지 증명한다. 캔버스가 없으면 null(=해당 없음). */
async function proveMotion() {
  const c = page.locator('canvas').first()
  if ((await c.count()) === 0) return null
  const a = await c.screenshot().catch(() => null)
  if (!a) return null
  await page.waitForTimeout(220)
  const b = await c.screenshot().catch(() => null)
  if (!b) return null
  return a.length !== b.length || !a.equals(b)
}

/** 프레임 전체를 찍는다. 캔버스가 있으면 진행 증명을 먼저 남긴다. */
async function shot(name) {
  const moving = await proveMotion()
  const path = join(SHOTS, `${TAG}-${name}.png`)
  await page.screenshot({ path })
  const line = `${name}: 프레임진행=${moving === null ? 'n/a' : moving ? 'OK' : 'FAIL(정지)'} → ${path}`
  notes.push(line)
  console.log('  ' + line)
  return path
}

/** 화면 안 겹침·화면밖 자동 검사. 오버레이 후보들의 사각형을 재서 보고한다. */
async function geometry(label) {
  const g = await page.evaluate(vp => {
    const sels = [
      '.ms-prematch', '.ent__bar', '.ent__actions', '.ent__line', '.ent__close',
      '.bc-scorebug', '.ms-controls', '.ms-hud', '.ms-banner', '.ms-bottombar',
      '.tb-root', '.tb-coachpop', '.ms-report', '.ab-root', '.hub-root', '.jl',
    ]
    const rects = []
    for (const s of sels) {
      for (const e of document.querySelectorAll(s)) {
        const r = e.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        rects.push({ s, el: e, x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) })
      }
    }
    // 화면 밖으로 나간 조각
    // 가로로 삐져나가면 무조건 결함이다. 세로는 스크롤 컨테이너(.tb-root 등)에선
    // 정상이므로 문서가 스크롤되지 않는데도 넘칠 때만 잡는다.
    const scrollable = document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
    const offscreen = rects.filter(
      r => r.x < -1 || r.x + r.w > vp.w + 1 || (!scrollable && (r.y < -1 || r.y + r.h > vp.h + 1)),
    )
    // 서로 겹치는 쌍(면적 400px² 초과만 — 1~2px 접촉은 잡지 않는다)
    const pairs = []
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j]
        // 조상-후손은 겹쳐서 정상이다(패널 안의 패널). 형제끼리만 본다.
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue
        const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
        const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        if (ow > 0 && oh > 0 && ow * oh > 400) pairs.push({ a: a.s, b: b.s, area: Math.round(ow * oh) })
      }
    }
    // 가로 스크롤(있으면 안 된다)
    const hscroll = document.documentElement.scrollWidth - document.documentElement.clientWidth
    return { rects: rects.map(({ el: _a, ...r }) => r), offscreen: offscreen.map(({ el: _b, ...r }) => r), pairs, hscroll }
  }, { w: W, h: H })
  const bad = []
  if (g.hscroll > 1) bad.push(`가로스크롤 ${g.hscroll}px`)
  if (g.offscreen.length) bad.push(`화면밖 ${g.offscreen.map(r => r.s).join(',')}`)
  if (g.pairs.length) bad.push(`겹침 ${g.pairs.map(p => `${p.a}×${p.b}=${p.area}px²`).join(' ')}`)
  const line = `[기하] ${label}: ${bad.length ? bad.join(' · ') : '이상 없음'}`
  notes.push(line)
  console.log('  ' + line)
  return g
}

const click = async (name, timeout = 15000) => {
  await page.getByRole('button', { name }).first().click({ timeout })
}
/** 있으면 누르고 true, 없으면 false. */
const clickIf = async (name, timeout = 3000) =>
  page.getByRole('button', { name }).first().click({ timeout }).then(() => true).catch(() => false)

try {
  // ── 1. 랜딩 ────────────────────────────────────────────────
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  await shot('01-landing')
  await geometry('랜딩')

  // ── 2. 캠페인 허브 ─────────────────────────────────────────
  await click('캠페인 시작')
  await page.waitForTimeout(1800)
  await shot('02-hub')
  await geometry('허브')

  // 허브 → 경기. 버튼 라벨을 모르므로 화면의 버튼을 훑어 진입점을 찾는다.
  const hubButtons = await page.getByRole('button').allInnerTexts()
  notes.push(`[허브 버튼] ${JSON.stringify(hubButtons)}`)
  console.log('  [허브 버튼]', hubButtons.join(' | '))
  const entry = hubButtons.find(t => /경기|시작|입장|출전|지휘|준비/.test(t))
  // 버튼 텍스트에 줄바꿈·화살표가 섞여 있어 정확 일치가 안 된다 — 첫 줄로 정규식을 만든다.
  if (entry) await page.getByRole('button', { name: new RegExp(entry.split('\n')[0].trim()) }).first().click()
  await page.waitForTimeout(2200)

  // ── 3. 워룸(킥오프 전 전술 센터) ───────────────────────────
  await shot('03-warroom')
  await geometry('워룸')
  const preButtons = await page.getByRole('button').allInnerTexts()
  notes.push(`[워룸 버튼] ${JSON.stringify(preButtons.slice(0, 40))}`)

  // ── 4. 입장 연출 ───────────────────────────────────────────
  await click('킥오프')
  await page.locator('[data-testid="entrance-overlay"]').waitFor({ state: 'visible', timeout: 20000 })
  const mode0 = await page.locator('[data-testid="entrance-overlay"]').evaluate(
    e => (e.querySelector('.ent__more') ? 'short' : 'full'),
  )
  notes.push(`[입장] 기본 모드 = ${mode0}`)
  console.log(`  [입장] 기본 모드 = ${mode0}`)

  const seen = new Set()
  let ticks = 0
  // data-phase가 바뀔 때마다 그 단계를 한 장씩 찍는다(시계가 아니라 상태를 본다).
  while (ticks < 90) {
    ticks++
    const overlay = page.locator('[data-testid="entrance-overlay"]')
    if ((await overlay.count()) === 0) break
    const phase = await overlay.getAttribute('data-phase').catch(() => null)
    if (phase && !seen.has(phase)) {
      seen.add(phase)
      await page.waitForTimeout(700)
      await shot(`04-entrance-${mode0}-${phase}`)
      if (phase === 'walkout' || phase === 'split') await geometry(`입장/${phase}`)
      // short 모드라면 여기서 full로 확장해 소개 컷까지 본다.
      if (mode0 === 'short' && phase === 'split') {
        if (await clickIf('선수 소개 보기')) {
          notes.push('[입장] short → full 확장')
          console.log('  [입장] short → full 확장')
        }
      }
    }
    await page.waitForTimeout(400)
  }
  notes.push(`[입장] 관측 단계 = ${[...seen].join(' → ')}`)
  console.log(`  [입장] 관측 단계 = ${[...seen].join(' → ')}`)

  // ── 5. 입장 종료 직후 연속 프레임(22명 튐 검사) ────────────
  for (let i = 0; i < 6; i++) {
    await shot(`05-kickoff-seq-${i}`)
    await page.waitForTimeout(280)
  }
  await geometry('킥오프 직후')

  // ── 6~8. 킥오프부터 종료 휘슬까지 **상태로 굴린다** ────────────
  // 고정 반복으로 짜면 하이드레이션 브레이크가 몇 번 끼는지에 따라 매번 다른 데서
  // 끝난다(1차 주행에서 실제로 후반 도중에 잘렸다). 화면 상태만 보고 전진한다.
  await clickIf('2x')
  /** 스코어버그의 현재 분. 파일 이름에 박아 두면 "언제 찍은 프레임인지"가 남는다. */
  const clock = async () =>
    page
      .locator('.bc-scorebug')
      .innerText()
      .then(t => (t.match(/(\d+)'/) ?? ['', '?'])[1])
      .catch(() => '?')

  let boardSeq = 0
  let liveSeq = 0
  let sawHalftime = false
  for (let step = 0; step < 140; step++) {
    if ((await page.locator('.ms-report').count()) > 0) break

    if ((await page.locator('.tb-root').count()) > 0) {
      // 작전판이 열렸다. 하프타임인지 브레이크인지는 **재개 버튼 라벨**이 정본이다.
      await page.waitForTimeout(1000)
      const isHalftime = (await page.getByRole('button', { name: '후반 시작' }).count()) > 0
      const kind = isHalftime ? 'halftime' : 'break'
      const tag = `07-${kind}-${boardSeq++}`
      await shot(`${tag}-board`)
      await geometry(`작전판/${kind}`)

      if (isHalftime && !sawHalftime) {
        sawHalftime = true
        // 하프타임에서만 코치 회의·교체·지시 탭을 전부 열어 본다.
        const btns = await page.getByRole('button').allInnerTexts()
        notes.push(`[하프타임 버튼] ${JSON.stringify(btns.slice(0, 40))}`)
        const coach = btns.find(t => /코치 회의/.test(t))
        if (coach && (await clickIf(new RegExp(coach.split('\n')[0].trim())))) {
          await page.waitForTimeout(700)
          await shot('07-halftime-coach')
          await geometry('코치 회의')
          await clickIf('코치 회의 닫기')
        }
        const tabs = await page.locator('.tb-tabs [role="tab"]').allInnerTexts().catch(() => [])
        for (let i = 0; i < tabs.length; i++) {
          await page.locator('.tb-tabs [role="tab"]').nth(i).click().catch(() => {})
          await page.waitForTimeout(500)
          await shot(`07-halftime-tab-${i}-${tabs[i].replace(/\s+/g, '')}`)
          await geometry(`하프타임 탭/${tabs[i].replace(/\s+/g, '')}`)
        }
        if (await clickIf('교체하기')) {
          await page.waitForTimeout(700)
          await shot('07-halftime-sub')
          await geometry('교체')
        }
      }

      if (!(await clickIf('후반 시작', 8000))) await clickIf('전술 확정', 8000)
      await page.waitForTimeout(800)
      if (isHalftime) {
        // 후반 킥오프 직후 연속 프레임 — 진영 교대(2D·3D 방향 일치)를 여기서 본다.
        for (let i = 0; i < 4; i++) {
          await shot(`08-secondhalf-start-${i}`)
          await page.waitForTimeout(300)
        }
        await geometry('후반 시작')
      }
      await clickIf('2x')
      continue
    }

    await page.waitForTimeout(3200)
    if ((await page.locator('.ms-report').count()) > 0) break
    if ((await page.locator('.tb-root').count()) > 0) continue
    const m = await clock()
    await shot(`06-live-${String(liveSeq).padStart(2, '0')}-${m}min`)
    if (liveSeq === 0) await geometry('전반 인플레이')
    liveSeq++
  }
  notes.push(`[진행] 인플레이 캡처 ${liveSeq}장 · 작전판 ${boardSeq}회 · 하프타임 도달 ${sawHalftime}`)

  // ── 9. 풀타임 리포트 ───────────────────────────────────────
  await page.locator('.ms-report').waitFor({ state: 'visible', timeout: 300000 })
  await page.waitForTimeout(900)
  await shot('09-fulltime')
  await geometry('풀타임')

  // ── 10. 엔딩(또는 허브 복귀) ───────────────────────────────
  if (!(await clickIf('결과 확정'))) await clickIf('승부차기로')
  await page.waitForTimeout(2200)
  await shot('10-after-fulltime')
  await geometry('풀타임 이후')
} catch (e) {
  notes.push(`실패: ${e.message}`)
  console.error('실패:', e.message)
  console.error(logs.slice(-30).join('\n'))
  process.exitCode = 1
} finally {
  await writeFile(join(SHOTS, `${TAG}-notes.txt`), notes.join('\n'))
  await writeFile(join(SHOTS, `${TAG}-console.log`), logs.join('\n'))
  await browser.close()
  await server.close()
}
