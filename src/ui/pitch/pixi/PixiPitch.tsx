import { useEffect, useRef, useState } from 'react'
import { Application, Container, Graphics, Text } from 'pixi.js'
import type { MatchState, MatchEvent } from '../../../engine/types'
import { type ChoreoStep } from '../choreography'
import { sequenceOwner } from '../cast'
import { PitchView } from '../PitchView'
import { separateDots, tacticalCoords } from '../shape'
import { layoutLabels, textWidth, type Box, type LabelReq } from '../labels'
import {
  PITCH_W, PITCH_H, ZOOM, toWorld, clamp, lerp, clampFocus,
  bezierAt, controlFor, easeFor, shakeOffset,
} from './stage'
import { CENTER_CIRCLE_R, PENALTY_BOX_D, GOAL_AREA_D } from '../geometry'
import { spawnBurst, stepParticles, particleAlpha, type Particle } from './fx'
import './pixi.css'

// PixiPitch — broadcast 모드 경기 화면의 게임 엔진급 렌더러(WebGL).
// PitchView(SVG)와 동일 props 계약을 받아 broadcast에서 자리를 대체한다. 단,
//   · WebGL 컨텍스트 생성 불가(jsdom·구형 환경) → 기존 SVG PitchView로 자동 폴백(크래시 금지)
//   · reduced-motion → 카메라·파티클·트레일 생략(도트·공 이동만)
// 순수 수학(안무 보간·카메라 클램프·셰이크)은 stage.ts, 파티클 시뮬은 fx.ts(둘 다 단위 테스트).
// 이 파일은 그 수학으로 pixi Ticker 위에서 60fps 렌더링만 수행한다.

interface PixiPitchProps {
  state: MatchState
  lastEvent?: MatchEvent
  /** 하이라이트 안무 시퀀스(있으면 공·무버·카메라·골FX 재생). */
  sequence?: ChoreoStep[]
  /** 시퀀스 재생 총 시간(ms). */
  dwellMs?: number
  /** 시퀀스 재생(공격) 팀 — 공·무버·골 파티클 색. */
  sequenceSide?: 'home' | 'away'
  /** 일시정지 — 안무 진행도를 고정하고 그리기를 건너뛴다(마지막 프레임 정지). */
  paused?: boolean
}

const HOME_FALLBACK = 0xe63946
const AWAY_FALLBACK = 0x4895ef

/** getComputedStyle에서 CSS 색 변수를 0xRRGGBB로 읽는다(테마 대응). 실패 시 fallback. */
function cssColor(el: HTMLElement, name: string, fallback: number): number {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim()
    if (v.startsWith('#')) {
      const hex = v.slice(1)
      if (hex.length === 3) {
        const r = hex[0], g = hex[1], b = hex[2]
        return parseInt(r + r + g + g + b + b, 16)
      }
      if (hex.length >= 6) return parseInt(hex.slice(0, 6), 16)
    }
  } catch { /* ignore */ }
  return fallback
}

/** WebGL 사용 가능 여부(동기). jsdom은 getContext가 null → false → SVG 폴백. */
function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    return !!(c.getContext('webgl2') || c.getContext('webgl'))
  } catch {
    return false
  }
}

// 도트 하나의 지속 라벨(등번호)·이름표·배지(사기)·보간 위치 상태.
interface DotVisual {
  label: Text
  /** 선수 이름표 — 장면에 관여한 선수에게만 켠다(④). 자리는 labels.layoutLabels가 정한다. */
  name: Text
  mood: Text
  // 현재 px 위치(포메이션 변경 시 목표로 부드럽게 lerp).
  cx: number
  cy: number
  placed: boolean
  lastNum: string
  lastName: string
  lastMood: string
}

/** 이름표 기준 폰트(px) — Text 객체를 이 크기로 만들고 scale로 화면 크기를 맞춘다. */
const NAME_BASE_FS = 26
/** 이름표 화면 폰트 크기(px). 40~52px 도트 옆에서 읽히는 최소값이 12px대다. */
const NAME_SCREEN_FS = 15
/** 도트 화면 반지름(px)의 하한·상한. 풀블리드 캔버스에서 지름 90px까지 부풀던 것을 묶는다(⑩). */
const DOT_SCREEN_R_MIN = 7
const DOT_SCREEN_R_MAX = 22
/** 화면 짧은 변 대비 도트 반지름 비율. 1080px 높이에서 반지름 17px(지름 35px), 상한 지름 44px. */
const DOT_SCREEN_R_RATIO = 0.016

/**
 * 진행도 p에서 공을 소유한 선수 id. 저술(scenes/flow)이 스텝마다 명시한다.
 * 비행 중(carrier 없음)이면 undefined — 그때는 소유 링을 그리지 않는다.
 */
function stepCarrier(seq: ChoreoStep[], p: number): string | undefined {
  let i = 0
  while (i < seq.length - 1 && p > seq[i + 1].t) i++
  return seq[i].carrier
}

/**
 * 이름표 후보 자리(px). SVG PitchView.nameSlots와 같은 순서 — 아래 → 위 → 대각 → 좌우.
 * 가로 오프셋은 그 이름의 **실제 폭**에서 낸다(3글자와 7글자가 같은 자리를 쓸 수 없다).
 */
function nameSlotsPx(name: string, fs: number, dotR: number): { dx: number; dy: number }[] {
  const half = (textWidth(name, fs) + fs * 0.4) / 2
  const side = dotR * 1.25 + half + fs * 0.15
  const down = dotR * 1.25 + fs * 0.95
  return [
    { dx: 0, dy: down }, { dx: 0, dy: -down },
    { dx: side * 0.7, dy: down * 0.85 }, { dx: -side * 0.7, dy: down * 0.85 },
    { dx: side * 0.7, dy: -down * 0.85 }, { dx: -side * 0.7, dy: -down * 0.85 },
    { dx: side, dy: 0 }, { dx: -side, dy: 0 },
    { dx: 0, dy: down * 1.6 }, { dx: 0, dy: -down * 1.6 },
  ]
}

export function PixiPitch(props: PixiPitchProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  // 최신 props를 Ticker(장수명 클로저)에서 읽기 위한 ref.
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // WebGL 불가 → 즉시 SVG 폴백(동기 — jsdom 테스트에서 자연 검증).
    if (!webglAvailable()) {
      setFailed(true)
      return
    }

    let destroyed = false
    let app: Application | null = null
    const homeColor = cssColor(host, '--bc-home', HOME_FALLBACK)
    const awayColor = cssColor(host, '--bc-away', AWAY_FALLBACK)
    const reducedMql = window.matchMedia('(prefers-reduced-motion: reduce)')

    const start = async () => {
      const application = new Application()
      try {
        await application.init({
          resizeTo: host,
          backgroundAlpha: 0,
          antialias: true,
          resolution: window.devicePixelRatio || 1,
          autoDensity: true,
          powerPreference: 'high-performance',
        })
      } catch {
        if (!destroyed) setFailed(true)
        try { application.destroy(true) } catch { /* ignore */ }
        return
      }
      if (destroyed) {
        try { application.destroy(true) } catch { /* ignore */ }
        return
      }
      app = application
      host.appendChild(application.canvas)

      // ── 씬 그래프 ──────────────────────────────────────────────
      const world = new Container() // 카메라 변환 대상(px 좌표)
      const pitchG = new Graphics() // 잔디·라인(리사이즈 시에만 재그리기)
      const dotsG = new Graphics()  // 22 도트 바디(매 프레임 재그리기)
      const labelLayer = new Container() // 등번호·배지(지속 객체)
      const fxG = new Graphics()    // 공·트레일·무버·파티클(매 프레임)
      world.addChild(pitchG, dotsG, fxG, labelLayer)
      const flashG = new Graphics() // 풀스크린 플래시(스크린 좌표 — 줌 미적용)
      application.stage.addChild(world, flashG)

      // 지속 라벨 풀(양팀 각 11). 라인업 길이에 맞춰 표시.
      const dotVisuals: Record<'home' | 'away', DotVisual[]> = { home: [], away: [] }
      const makeDot = (): DotVisual => {
        const label = new Text({
          text: '',
          style: {
            fontFamily: 'Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
            fontSize: 28, fontWeight: '800', fill: 0xffffff, align: 'center',
            stroke: { color: 0x0a0a12, width: 4 },
          },
        })
        label.anchor.set(0.5)
        const name = new Text({
          text: '',
          style: {
            fontFamily: 'Pretendard, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
            fontSize: NAME_BASE_FS, fontWeight: '700', fill: 0xffffff, align: 'center',
            // 후광 — 잔디·도트 위 어디에 놓여도 읽힌다(SVG .pv-name의 paint-order와 같은 의도).
            stroke: { color: 0x060c16, width: 7 },
          },
        })
        name.anchor.set(0.5)
        name.visible = false
        const mood = new Text({ text: '', style: { fontFamily: 'sans-serif', fontSize: 26 } })
        mood.anchor.set(0.5)
        labelLayer.addChild(label, name, mood)
        return { label, name, mood, cx: 0, cy: 0, placed: false, lastNum: '', lastName: '', lastMood: '' }
      }
      for (let i = 0; i < 11; i++) { dotVisuals.home.push(makeDot()); dotVisuals.away.push(makeDot()) }

      // ── 레이아웃 상태(리사이즈 감지) ───────────────────────────
      let scale = 1, offX = 0, offY = 0, lastW = -1, lastH = -1
      const normToPx = (x: number, y: number) => {
        const w = toWorld({ x, y })
        return { x: offX + w.x * scale, y: offY + w.y * scale }
      }
      // 잔디+줄무늬+라인(px). 크기 변할 때만 호출.
      const drawPitch = (sw: number, sh: number) => {
        pitchG.clear()
        const px = (wx: number, wy: number) => ({ x: offX + wx * scale, y: offY + wy * scale })
        const r = (wx: number, wy: number, ww: number, wh: number) => {
          const a = px(wx, wy)
          return [a.x, a.y, ww * scale, wh * scale] as const
        }
        // 배경(캔버스 전체 — 여백까지 짙은 잔디).
        pitchG.rect(0, 0, sw, sh).fill(0x14532a)
        // 잔디 세로 줄무늬(mowing) + 위→아래 미세 라이팅 그라데이션(밴드 근사).
        const stripes = 14
        const stripeW = PITCH_W / stripes
        for (let i = 0; i < stripes; i++) {
          const base = i % 2 === 0 ? 0x1f7a3a : 0x1a6d33
          pitchG.rect(...r(i * stripeW, 0, stripeW, PITCH_H)).fill(base)
        }
        // 라이팅: 위쪽을 살짝 밝게(밴드 6개, 상단 흰빛 → 하단 투명).
        const bands = 8
        for (let i = 0; i < bands; i++) {
          const a = 0.05 * (1 - i / bands)
          pitchG.rect(...r(0, (i * PITCH_H) / bands, PITCH_W, PITCH_H / bands)).fill({ color: 0xffffff, alpha: a })
        }
        // ── 라인(안티앨리어스) ──
        const lineW = Math.max(1, scale * 0.28)
        const stroke = { width: lineW, color: 0xffffff, alpha: 0.72 }
        const cy = PITCH_H / 2
        // 박스 폭만 리터럴 — 3D는 규칙값 40.32/18.32, 2D는 예전부터 40.3/18.3이다.
        // 서브픽셀 차이라 통일하지 않고 보고만 했다(geometry.PENALTY_BOX_W 주석 참조).
        const penH = 40.3, penTop = (PITCH_H - penH) / 2
        const goalH = 18.3, goalTop = (PITCH_H - goalH) / 2
        // 외곽선
        pitchG.rect(...r(0.6, 0.6, PITCH_W - 1.2, PITCH_H - 1.2)).stroke(stroke)
        // 하프라인
        const hl0 = px(PITCH_W / 2, 0.6), hl1 = px(PITCH_W / 2, PITCH_H - 0.6)
        pitchG.moveTo(hl0.x, hl0.y).lineTo(hl1.x, hl1.y).stroke(stroke)
        // 센터서클 + 킥오프 점
        const cc = px(PITCH_W / 2, cy)
        pitchG.circle(cc.x, cc.y, CENTER_CIRCLE_R * scale).stroke(stroke)
        pitchG.circle(cc.x, cc.y, Math.max(1, scale * 0.5)).fill({ color: 0xffffff, alpha: 0.8 })
        // 좌(홈) 박스
        pitchG.rect(...r(0.6, penTop, PENALTY_BOX_D, penH)).stroke(stroke)
        pitchG.rect(...r(0.6, goalTop, GOAL_AREA_D, goalH)).stroke(stroke)
        // 우(어웨이) 박스
        pitchG.rect(...r(PITCH_W - 0.6 - PENALTY_BOX_D, penTop, PENALTY_BOX_D, penH)).stroke(stroke)
        pitchG.rect(...r(PITCH_W - 0.6 - GOAL_AREA_D, goalTop, GOAL_AREA_D, goalH)).stroke(stroke)
      }

      // ── 애니메이션 상태 ────────────────────────────────────────
      let curSeq: ChoreoStep[] | undefined
      let seqStart = 0
      let camZoom = 1
      let camFocusX = 0, camFocusY = 0, camPlaced = false
      const trail: { x: number; y: number }[] = [] // px
      let particles: Particle[] = []
      let goalArmed: { color: number; conceded: boolean } | null = null
      let flashStart = -1, flashConceded = false
      let shakeStart = -1

      /**
       * 도트 반지름(월드 px = 카메라 적용 **전**).
       *
       * ★ 예전에는 `scale * 2.05`, 즉 월드 2.05 m 고정이었다. 풀블리드로 캔버스가 커지자
       *   1920×1080에서 반지름 32 px, 카메라 줌 1.6을 곱해 **지름 104 px**가 됐다 —
       *   감사 ⑩("도트가 지름 ~90px로 그려져 10~12명만 보인다")이 잡은 그림이다.
       *   방송 그래픽의 선수 마커는 화면 크기가 고정이다(줌해도 커지지 않는다).
       *   그래서 화면 반지름을 먼저 정하고 카메라 배율로 나눠 월드 반지름을 역산한다.
       */
      const dotScreenR = () =>
        clamp(Math.min(lastW, lastH) * DOT_SCREEN_R_RATIO, DOT_SCREEN_R_MIN, DOT_SCREEN_R_MAX)
      const dotR = () => Math.max(1, dotScreenR() / Math.max(0.5, camZoom))

      // 안무 표본: 진행도 p(0~1)에서 공(월드)·무버(월드)를 반환.
      const sampleSeq = (seq: ChoreoStep[], p: number) => {
        let i = 0
        while (i < seq.length - 1 && p > seq[i + 1].t) i++
        if (i >= seq.length - 1) {
          const last = seq[seq.length - 1]
          return { ball: toWorld(last.ball), movers: last.movers.map(m => ({ id: m.playerId, ...toWorld(m) })) }
        }
        const a = seq[i], b = seq[i + 1]
        const span = b.t - a.t || 1
        const lt = clamp((p - a.t) / span, 0, 1)
        const isShot = i === seq.length - 2 // 마지막 세그먼트 = 슛(직선 가속)
        const type = isShot ? 'shot' : 'pass'
        const p0 = toWorld(a.ball), p1 = toWorld(b.ball)
        const ctrl = controlFor(p0, p1, type)
        const ball = bezierAt(p0, p1, ctrl, easeFor(type)(lt))
        const et = easeFor('ease')(lt)
        const byId = new Map(b.movers.map(m => [m.playerId, m]))
        const movers = a.movers.map(m => {
          const bm = byId.get(m.playerId) ?? m
          const wa = toWorld(m), wb = toWorld(bm)
          return { id: m.playerId, x: lerp(wa.x, wb.x, et), y: lerp(wa.y, wb.y, et) }
        })
        return { ball, movers }
      }

      // ── 메인 루프(60fps) ──────────────────────────────────────
      application.ticker.add((ticker) => {
        const dt = Math.min(0.05, ticker.deltaMS / 1000) // 큰 프레임 점프 클램프
        const now = performance.now()
        const p = propsRef.current
        if (p.paused) {
          // 일시정지: 진행도(now - seqStart)의 **기준점을 프레임만큼 뒤로 민다**.
          // 시계를 멈출 수 없으니 원점을 함께 끌고 가는 것이다 — 재개하면 정지한
          // 그 지점에서 이어진다. 그리기는 건너뛰므로 마지막 프레임이 그대로 남는다.
          const shift = ticker.deltaMS
          seqStart += shift
          if (flashStart >= 0) flashStart += shift
          if (shakeStart >= 0) shakeStart += shift
          return
        }
        const reduced = reducedMql.matches
        const sw = application.screen.width
        const sh = application.screen.height
        if (sw < 2 || sh < 2) return

        // 레이아웃 갱신(리사이즈).
        if (sw !== lastW || sh !== lastH) {
          lastW = sw; lastH = sh
          scale = Math.min(sw / PITCH_W, sh / PITCH_H)
          offX = (sw - PITCH_W * scale) / 2
          offY = (sh - PITCH_H * scale) / 2
          drawPitch(sw, sh)
          camPlaced = false
        }

        // 새 시퀀스 감지 → 클럭 리셋 + 골 FX 무장.
        if (p.sequence !== curSeq) {
          curSeq = p.sequence
          seqStart = now
          trail.length = 0
          if (curSeq && curSeq.length > 0 && p.lastEvent?.type === 'goal' && !reduced) {
            const side = p.sequenceSide ?? 'home'
            const conceded = side === 'away'
            goalArmed = { color: side === 'home' ? homeColor : awayColor, conceded }
          } else {
            goalArmed = null
          }
        }

        // ── 안무 표본을 **먼저** 뽑는다 ─────────────────────────
        // 무버 좌표가 도트 좌표를 덮어쓰기 때문이다(⑤). 예전에는 도트를 먼저 그리고
        // 그 위에 번호 없는 반투명 원을 얹었다 — 사용자가 "3개의 동그란 그림자"라 부른 것.
        const seq = curSeq && curSeq.length > 0 ? curSeq : null
        const prog = seq ? clamp((now - seqStart) / (p.dwellMs ?? 3000), 0, 1) : 0
        const s = seq ? sampleSeq(seq, prog) : null
        // 공격 팀은 **시퀀스 자체**에서 판정한다 — `save`의 teamId는 막은 팀(수비)이라
        // prop을 그대로 믿으면 무버가 반대 팀에 꽂힌다(cast.sequenceOwner).
        const attSide = sequenceOwner(p.state, seq ?? undefined, p.sequenceSide ?? 'home')
        const moverById = new Map((s?.movers ?? []).map(m => [m.id, m]))
        const carrierId = seq ? stepCarrier(seq, prog) : undefined
        // 이번 장면의 주역 — 이름표는 이들에게만 붙는다(④). 22명 전원에 붙이면 글자가 피치를 덮는다.
        const cast = new Set<string>(moverById.keys())
        if (carrierId) cast.add(carrierId)

        // ── 도트 좌표 22개 ─────────────────────────────────────
        // 전술 변환 좌표(SVG·3D와 같은 정본) + 무버 덮어쓰기 + 가독성 분리.
        // ★ 예전에는 포메이션 원형(slotCoords)을 그대로 썼다 — 라인·압박 슬라이더를
        //   만져도 도트가 안 움직였고, SVG 작전판과 좌표가 어긋났다.
        const normOf = (which: 'home' | 'away') => {
          const { formation, lineup, instructions } = p.state[which].tactics
          return lineup.map((slot, i) => {
            const m = which === attSide ? moverById.get(slot.playerId) : undefined
            // 무버 좌표는 월드(m) — 정규 좌표로 되돌려 분리 솔버에 같은 단위로 넘긴다.
            if (m) return { x: (m.x / PITCH_W) * 100, y: (m.y / PITCH_H) * 100 }
            return tacticalCoords(formation, i, which, instructions)
          })
        }
        const normHome = normOf('home')
        const normAway = normOf('away')
        // 팀 **간**에도 건다 — 우리 도트가 상대 도트에 통째로 가려지던 문제(감사 ⑨).
        const sepNorm = separateDots([...normHome, ...normAway])
        const sepOf = (which: 'home' | 'away', i: number) =>
          which === 'home' ? sepNorm[i] : sepNorm[normHome.length + i]

        // ── 도트(22) 재그리기 + 라벨 갱신 ──
        dotsG.clear()
        const R = dotR()
        // 이름표 폰트도 화면 크기 고정 — 카메라 배율로 나눠 월드 크기를 역산한다(도트와 같은 규칙).
        const nameFs = NAME_SCREEN_FS / Math.max(0.5, camZoom)
        const nameReqs: LabelReq[] = []
        const dotBoxes: Box[] = []
        const dvById = new Map<string, DotVisual>()
        // z순서 — 장면의 주어를 마지막에(=위에) 그린다. 예전엔 언제나 어웨이가 마지막이라
        // 우리 도트가 상대 도트 밑에 깔렸다(감사 ⑨). 분리 솔버가 은폐를 막지만, 순서까지
        // 맞춰야 "누구를 보는 화면인가"가 흔들리지 않는다.
        const order: ('home' | 'away')[] = seq && attSide === 'away' ? ['home', 'away'] : ['away', 'home']
        for (const which of order) {
          const sideState = p.state[which]
          const color = which === 'home' ? homeColor : awayColor
          const { lineup } = sideState.tactics
          const numById = new Map(sideState.team.squad.map(s2 => [s2.id, s2.number]))
          const nameById = new Map(sideState.team.squad.map(s2 => [s2.id, s2.name.ko]))
          const pool = dotVisuals[which]
          for (let i = 0; i < pool.length; i++) {
            const dv = pool[i]
            const slot = lineup[i]
            if (!slot || i >= lineup.length) {
              dv.label.visible = false; dv.mood.visible = false; dv.name.visible = false
              continue
            }
            dvById.set(slot.playerId, dv)
            const c = sepOf(which, i)
            const t = normToPx(c.x, c.y)
            // 안무가 옮기는 선수는 **즉시** 그 자리다(평활하면 공보다 늦게 도착한다).
            // 그 외에는 포메이션 변경 시 부드럽게 이동(프레임 독립 lerp).
            const instant = reduced || (which === attSide && moverById.has(slot.playerId))
            if (!dv.placed || instant) { dv.cx = t.x; dv.cy = t.y; dv.placed = true }
            else {
              const k = 1 - Math.exp(-dt * 9)
              dv.cx = lerp(dv.cx, t.x, k)
              dv.cy = lerp(dv.cy, t.y, k)
            }
            // 그림자 → 바디 → 링(고대비).
            dotsG.circle(dv.cx, dv.cy + R * 0.45, R * 0.98).fill({ color: 0x000000, alpha: 0.3 })
            dotsG.circle(dv.cx, dv.cy, R).fill(color)
            dotsG.circle(dv.cx, dv.cy, R).stroke({ width: Math.max(1, R * 0.2), color: 0xffffff, alpha: 0.9 })
            dotBoxes.push({ x: dv.cx - R * 1.25, y: dv.cy - R * 1.25, w: R * 2.5, h: R * 2.5 })
            // 등번호.
            const num = String(numById.get(slot.playerId) ?? '')
            if (num !== dv.lastNum) { dv.label.text = num; dv.lastNum = num }
            dv.label.visible = true
            dv.label.position.set(dv.cx, dv.cy)
            dv.label.scale.set((R * 1.15) / 28)
            // 사기 배지(🔥/😰).
            const morale = sideState.moraleByPlayer[slot.playerId]
            const badge = morale == null ? '' : morale >= 75 ? '🔥' : morale <= 35 ? '😰' : ''
            if (badge !== dv.lastMood) { dv.mood.text = badge; dv.lastMood = badge }
            dv.mood.visible = !!badge
            if (badge) {
              dv.mood.position.set(dv.cx + R * 1.1, dv.cy - R * 1.1)
              dv.mood.scale.set((R * 0.95) / 26)
            }
            // 이름표 배치 요청 — 실제 자리는 SVG 작전판과 **같은 충돌 회피 패스**가 정한다.
            dv.name.visible = false
            if (cast.has(slot.playerId) && which === attSide) {
              const nm = nameById.get(slot.playerId)
              if (nm) {
                if (nm !== dv.lastName) { dv.name.text = nm; dv.lastName = nm }
                nameReqs.push({
                  id: slot.playerId,
                  text: nm,
                  ax: dv.cx,
                  ay: dv.cy,
                  fontSize: nameFs,
                  slots: nameSlotsPx(nm, nameFs, R),
                  rank: 0,
                })
              }
            }
          }
        }
        // 이름표 자리 확정(겹침 0 보장 — 자리를 못 찾으면 그리지 않는다).
        if (nameReqs.length > 0) {
          const bounds = { x: 0, y: 0, w: PITCH_W * scale + offX * 2, h: PITCH_H * scale + offY * 2 }
          for (const pl of layoutLabels(nameReqs, bounds, dotBoxes).placed) {
            const dv = dvById.get(pl.id)
            if (!dv) continue
            dv.name.visible = true
            dv.name.position.set(pl.x, pl.y)
            dv.name.scale.set(nameFs / NAME_BASE_FS)
          }
        }

        // ── 공·트레일 + 파티클 ──
        fxG.clear()
        let ballWorld: { x: number; y: number } | null = null
        if (s && seq) {
          ballWorld = s.ball
          const ballPx = { x: offX + s.ball.x * scale, y: offY + s.ball.y * scale }
          // 볼 캐리어 링 — 공이 지금 누구 발밑에 있나. 무버 고스트 원의 자리를 대신한다:
          // 선수는 진짜 도트가 이미 그리고 있으므로, 여기서 말할 것은 "소유"뿐이다.
          const cdv = carrierId ? dvById.get(carrierId) : undefined
          if (cdv) {
            fxG.circle(cdv.cx, cdv.cy, R * 1.55)
              .stroke({ width: Math.max(1, R * 0.18), color: 0xffffff, alpha: 0.75 })
          }
          // 골 FX 발동(공이 목적지 도달 시).
          if (goalArmed && prog >= seq[seq.length - 1].t) {
            particles = spawnBurst(s.ball.x, s.ball.y, goalArmed.color)
            flashStart = now; flashConceded = goalArmed.conceded
            shakeStart = now
            goalArmed = null
          }
          /**
           * 모션 트레일(잔상 페이드) — reduced-motion 시 생략.
           *
           * **3D에서는 트레일을 제거했지만(a91d378) 여기서는 남긴다.** 그 4가지 근거를
           * 이 렌더러에 그대로 적용해 보면 셋이 성립하지 않는다:
           *  1) "중계에 트레일은 없다" — 이 뷰는 중계 카메라가 아니라 **부감 작전판**이다.
           *     선수도 원근 없는 색 도트다. 도식의 어휘와 방송의 어휘가 다르다.
           *  2) "균일한 불투명 구체 10개는 번짐이 아니다" — 여기 트레일은 반경 0.3→1.0배,
           *     알파 0→0.5로 실제로 감쇠하는 꼬리다(3D 버전은 균일 크기였다).
           *  3) "높이는 컨택트 섀도우가 준다" — 2D에는 그림자도 높이도 없다. 부감에서
           *     **속도와 진행 방향**을 말하는 단서가 트레일뿐이다.
           *  4) 비용: Graphics 하나에 원 14개. 3D의 메시·머티리얼 10개와 급이 다르다.
           *
           * ★ 다만 **정지 중에는 쌓지 않는다**: 장면에 컨트롤 정지(scenes.TOUCH_MS = 380 ms)가
           *   생기면서, 무조건 push하던 예전 코드는 같은 픽셀에 14개를 겹쳐 공 옆에
           *   덩어리를 만들었다. 이동한 프레임만 기록하면 꼬리가 곧 속도가 된다.
           */
          if (!reduced) {
            const tip = trail[trail.length - 1]
            const moved = !tip || Math.hypot(ballPx.x - tip.x, ballPx.y - tip.y) > R * 0.3
            if (moved) trail.push({ x: ballPx.x, y: ballPx.y })
            else if (trail.length > 0) trail.shift() // 멈춰 있으면 꼬리가 스스로 줄어든다
            if (trail.length > 14) trail.shift()
            for (let i = 0; i < trail.length; i++) {
              const a = (i / trail.length) * 0.5
              fxG.circle(trail[i].x, trail[i].y, R * 0.55 * (0.3 + (i / trail.length) * 0.7))
                .fill({ color: 0xffffff, alpha: a })
            }
          }
          // 공(흰 원 + 그림자).
          fxG.ellipse(ballPx.x, ballPx.y + R * 0.5, R * 0.75, R * 0.35).fill({ color: 0x000000, alpha: 0.35 })
          fxG.circle(ballPx.x, ballPx.y, R * 0.62).fill(0xffffff)
          fxG.circle(ballPx.x, ballPx.y, R * 0.62).stroke({ width: Math.max(0.6, scale * 0.2), color: 0x0a0a12, alpha: 0.4 })
        }

        // 파티클 진행·드로잉(월드→px). reduced-motion 시 생성 안 되므로 비어 있음.
        if (particles.length) {
          particles = stepParticles(particles, dt, 62)
          for (const pt of particles) {
            fxG.circle(offX + pt.x * scale, offY + pt.y * scale, Math.max(0.8, pt.size * scale))
              .fill({ color: pt.color, alpha: particleAlpha(pt) * 0.9 })
          }
        }

        // ── 카메라 워크 ──
        let targetZoom = 1
        let focusX = PITCH_W / 2, focusY = PITCH_H / 2
        if (seq && ballWorld && !reduced) {
          const elapsed = now - seqStart
          const zin = easeFor('camera')(clamp(elapsed / 400, 0, 1)) // 0.4s 줌인
          const zout = clamp((prog - 0.82) / 0.18, 0, 1) // 종료부 복귀
          const env = zin * (1 - zout)
          targetZoom = 1 + (ZOOM - 1) * env
          const f = clampFocus(ballWorld.x, ballWorld.y, ZOOM)
          focusX = f.x; focusY = f.y
        }
        const zk = 1 - Math.exp(-dt * 8)
        camZoom = lerp(camZoom, targetZoom, zk)
        const fpx = { x: offX + focusX * scale, y: offY + focusY * scale }
        if (!camPlaced) { camFocusX = fpx.x; camFocusY = fpx.y; camPlaced = true }
        camFocusX = lerp(camFocusX, fpx.x, zk)
        camFocusY = lerp(camFocusY, fpx.y, zk)
        // 골 셰이크(±px, 0.3s 감쇠).
        let shx = 0, shy = 0
        if (shakeStart >= 0 && !reduced) {
          const sp = (now - shakeStart) / 300
          if (sp >= 1) { shakeStart = -1 } else {
            const so = shakeOffset(sp, Math.max(3, scale * 1.6))
            shx = so.dx; shy = so.dy
          }
        }
        world.scale.set(camZoom)
        world.pivot.set(camFocusX, camFocusY)
        world.position.set(sw / 2 + shx, sh / 2 + shy)

        // ── 풀스크린 플래시(득점 밝게 / 실점 어둡게) ──
        flashG.clear()
        if (flashStart >= 0 && !reduced) {
          const fe = (now - flashStart) / 520
          if (fe >= 1) { flashStart = -1 } else {
            const rise = fe < 0.12 ? fe / 0.12 : 1 - (fe - 0.12) / 0.88
            const a = clamp(rise, 0, 1) * (flashConceded ? 0.6 : 0.72)
            flashG.rect(0, 0, sw, sh).fill({ color: flashConceded ? 0x05070d : 0xffffff, alpha: a })
          }
        }
      })
    }

    void start()

    return () => {
      destroyed = true
      if (app) {
        try { app.destroy(true, { children: true, texture: true }) } catch { /* ignore */ }
        app = null
      }
    }
    // 마운트당 1회 초기화. props 갱신은 propsRef로 Ticker가 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // WebGL 불가·init 실패 → SVG PitchView 폴백(broadcast 계약 동일 유지).
  if (failed) {
    return (
      <PitchView
        state={props.state}
        lastEvent={props.lastEvent}
        sequence={props.sequence}
        dwellMs={props.dwellMs}
        sequenceSide={props.sequenceSide}
        paused={props.paused}
      />
    )
  }
  return <div ref={hostRef} className="pixi-pitch" aria-label="경기 피치(방송)" role="img" />
}
