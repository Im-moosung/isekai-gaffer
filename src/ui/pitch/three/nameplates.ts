// src/ui/pitch/three/nameplates.ts
// 3D 방송 화면의 **선수 이름표** — 머리 위에 뜨는 DOM 오버레이.
//
// ─────────────────────────────────────────────────────────────────────────────
// 왜 DOM 오버레이인가 (스프라이트·캔버스 텍스처와 비교)
// ─────────────────────────────────────────────────────────────────────────────
// 후보는 셋이었다.
//  1. **THREE.Sprite + 캔버스 텍스처** — 이름 22개마다 캔버스를 그려 텍스처로 올린다.
//     · 텍스트가 텍스처라 화면 크기가 변할 때마다 흐려진다. 우리 이름표는 화면상
//       9~15 px인데, 그 크기에서 리샘플링된 한글은 못 읽는다. 선명하게 하려면 DPR을
//       곱한 텍스처(22장 × 최대 3배)를 유지해야 하고, 창 크기·DPR이 바뀔 때마다 전부
//       다시 굽는다. 교체 선수까지 세면 텍스처 수가 계속 는다.
//     · 스프라이트는 깊이 테스트를 받는다 — 앞선수 몸에 이름이 가려진다. 방송 자막은
//       절대 가려지지 않는다.
//  2. **CSS3DRenderer** — DOM을 3D로 배치한다. three 예제 모듈을 추가로 번들해야 하고
//     (코드 스플릿 계약에 three 엔트리 누출 위험), 결국 하는 일은 3번과 같다.
//  3. **DOM 오버레이(채택)** — 캔버스 위에 절대배치 div를 얹고 매 프레임 transform만
//     바꾼다. 텍스트는 브라우저가 장치 DPI로 직접 래스터라이즈하므로 9 px에서도
//     선명하고, 색·후광·폰트를 CSS 변수로 방송 톤에 맞출 수 있다. 겹침은 2D 작전판이
//     쓰는 배치 패스({@link layoutLabels})를 **그대로 재사용**한다 — 같은 알고리즘을
//     두 번 쓰지 않는다.
//
// 비용(실측 근거): 한 프레임에 하는 일은 (a) 22명 × 머리·발 두 점 투영 = 벡터 44회,
// (b) 배치 패스 O(n²) with n ≤ {@link MAX_PLATES}, (c) 살아남은 라벨만 `transform`·
// `opacity` 문자열 쓰기. GPU 작업이 0이고 레이아웃을 유발하지 않는다(transform만 만진다).
//
// ─────────────────────────────────────────────────────────────────────────────
// 언제 보이는가
// ─────────────────────────────────────────────────────────────────────────────
// 22개를 항상 띄우면 잔디가 안 보인다. 그래서 **화면상 선수 키(px)**를 기준으로 건다 —
// 카메라 거리·화각·창 크기를 한 수로 요약하는 값이라 프리셋마다 상수를 다시 잡을 필요가
// 없다. 방송 타이트 샷에서 선수는 40~52 px이고, 와이드 샷에서는 20 px 아래로 떨어진다.
import { LABEL_H_RATIO, layoutLabels, textWidth, type LabelReq } from '../labels'

/** 이름표를 다는 최소 화면 키(px). 이보다 작으면 와이드 샷이라 전부 숨긴다. */
export const MIN_PLAYER_PX = 26
/**
 * 한 프레임에 배치를 시도하는 최대 개수.
 *
 * 22가 아니라 14인 이유: 배치 패스는 O(n²)이고, 무엇보다 **14개를 넘기면 화면이 글자로
 * 덮인다.** 순위(볼과의 거리)가 낮은 쪽부터 자르므로 잘리는 것은 화면 구석의 조연이다.
 */
export const MAX_PLATES = 14
/** 화면 키 대비 글자 크기 비율. 48 px 선수 → 13 px 글자(선수 키의 27%). */
const FONT_RATIO = 0.27
/** 글자 크기 하한·상한(px). 하한은 한글 가독 한계, 상한은 화면을 덮지 않는 한계. */
export const FONT_MIN_PX = 10
export const FONT_MAX_PX = 15
/** 머리 위 여유(px) — 앵커에서 라벨 중심까지. 글자 크기에 비례한다. */
const HEAD_GAP_RATIO = 0.9

/** 투영까지 끝난 이름표 한 건. 좌표는 캔버스 CSS 픽셀. */
export interface PlateItem {
  id: string
  side: 'home' | 'away'
  text: string
  /** 머리 위 앵커의 화면 좌표(px). */
  sx: number
  sy: number
  /** 이 선수의 화면상 키(px) — 발↔머리 투영 차. 표시 여부와 글자 크기의 근거. */
  playerPx: number
  /** 카메라 앞인가. 뒤면 투영이 뒤집혀 엉뚱한 자리에 뜬다. */
  inFront: boolean
  /** 낮을수록 중요 — 보통 볼까지의 거리(m). 배치와 상한 절단의 우선순위다. */
  rank: number
}

/** 자리를 잡은 이름표. 호출자가 그대로 DOM에 쓴다. */
export interface PlacedPlate {
  id: string
  side: 'home' | 'away'
  text: string
  /** 라벨 중심(px). */
  x: number
  y: number
  fontPx: number
}

/** 화면 키(px) → 글자 크기(px). 범위 밖이면 null(= 달지 않는다). */
export function plateFontPx(playerPx: number): number | null {
  if (!(playerPx >= MIN_PLAYER_PX)) return null
  return Math.round(Math.min(FONT_MAX_PX, Math.max(FONT_MIN_PX, playerPx * FONT_RATIO)))
}

/**
 * 이름표 배치 — 2D 작전판과 **같은 배치 패스**를 픽셀 좌표로 돌린다.
 *
 * 후보 자리는 머리 위가 1순위, 그 위가 2순위, 발밑이 3순위다(방송 자막 관례 — 이름은
 * 사람 위에 뜬다). 세 자리 모두 막히면 그 라벨은 **그리지 않는다**: 겹쳐 읽히느니
 * 안 보이는 게 낫다는 labels.ts의 계약을 그대로 따른다.
 *
 * @param items  투영된 후보(전 선수).
 * @param viewW  캔버스 CSS 폭(px).
 * @param viewH  캔버스 CSS 높이(px).
 * @param sticky 직전 프레임에 채택된 후보 인덱스 — 라벨이 매 프레임 위아래로 튀지 않게.
 */
export function layoutPlates(
  items: readonly PlateItem[],
  viewW: number,
  viewH: number,
  sticky?: Map<string, number>,
): { placed: PlacedPlate[]; slots: Map<string, number> } {
  const byId = new Map<string, { item: PlateItem; fontPx: number }>()
  const reqs: LabelReq[] = []
  const cand = items
    .filter(p => p.inFront && p.text.length > 0)
    // 화면 밖(여백 포함)은 투영만 하고 버린다 — 배치 패스에 넣을 이유가 없다.
    .filter(p => p.sx > -60 && p.sx < viewW + 60 && p.sy > -40 && p.sy < viewH + 40)
    .sort((a, b) => (a.rank - b.rank) || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_PLATES)

  for (let i = 0; i < cand.length; i++) {
    const p = cand[i]
    const fontPx = plateFontPx(p.playerPx)
    if (fontPx == null) continue
    byId.set(p.id, { item: p, fontPx })
    const gap = fontPx * HEAD_GAP_RATIO
    reqs.push({
      id: p.id,
      text: p.text,
      ax: p.sx,
      ay: p.sy,
      fontSize: fontPx,
      // 머리 위 → 한 칸 더 위 → 발밑(선수 키만큼 아래).
      slots: [{ dx: 0, dy: -gap }, { dx: 0, dy: -gap - fontPx * LABEL_H_RATIO }, { dx: 0, dy: p.playerPx * 0.55 }],
      rank: i,
      // 좌우 여백 — 플레이트 배경(padding 0.35em)만큼 넓게 잡아야 배경끼리 겹치지 않는다.
      padX: fontPx * 0.45,
    })
  }
  const bounds = { x: 0, y: 0, w: viewW, h: viewH }
  const { placed } = layoutLabels(reqs, bounds, [], sticky)
  const slots = new Map<string, number>()
  const out: PlacedPlate[] = []
  for (const pl of placed) {
    const src = byId.get(pl.id)
    if (!src) continue
    slots.set(pl.id, pl.slot)
    out.push({ id: pl.id, side: src.item.side, text: pl.text, x: pl.x, y: pl.y, fontPx: src.fontPx })
  }
  return { placed: out, slots }
}

/** 라벨 하나가 차지하는 화면 폭(px) — 테스트·디버그용(labels.textWidth와 같은 근사). */
export function plateWidthPx(text: string, fontPx: number): number {
  return textWidth(text, fontPx) + fontPx * 0.9
}

/** DOM 오버레이 핸들. */
export interface NameplateLayer {
  /** 이번 프레임의 이름표를 갱신한다. */
  update(items: readonly PlateItem[], viewW: number, viewH: number): void
  /** 전부 숨긴다(모션 최소화·성능 강등에서 쓴다). */
  clear(): void
  dispose(): void
  /** 지금 화면에 떠 있는 이름표 수 — 계측·테스트용. */
  readonly count: number
}

/**
 * 캔버스 위에 이름표 레이어를 만든다. div를 **풀링**해 매 프레임 생성·파괴하지 않는다
 * (22개 × 60 fps면 GC가 그것만으로 돈다).
 */
export function createNameplateLayer(host: HTMLElement): NameplateLayer {
  const root = document.createElement('div')
  root.className = 'm3d-plates'
  // 오버레이는 클릭을 먹지 않는다(캔버스가 포인터를 그대로 받아야 한다).
  root.setAttribute('aria-hidden', 'true')
  host.appendChild(root)

  const pool = new Map<string, HTMLElement>()
  const sticky = new Map<string, number>()
  let live = 0

  const acquire = (id: string, side: 'home' | 'away'): HTMLElement => {
    let el = pool.get(id)
    if (!el) {
      el = document.createElement('div')
      el.className = `m3d-plate m3d-plate--${side}`
      root.appendChild(el)
      pool.set(id, el)
    }
    return el
  }

  return {
    update(items, viewW, viewH) {
      if (viewW < 2 || viewH < 2) return
      const { placed, slots } = layoutPlates(items, viewW, viewH, sticky)
      sticky.clear()
      for (const [k, v] of slots) sticky.set(k, v)
      const shown = new Set<string>()
      for (const p of placed) {
        const el = acquire(p.id, p.side)
        el.className = `m3d-plate m3d-plate--${p.side}`
        if (el.textContent !== p.text) el.textContent = p.text
        // translate(-50%,-50%)로 중심 정렬 — 레이아웃을 유발하지 않는 합성 전용 속성만 쓴다.
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) translate(-50%, -50%)`
        el.style.fontSize = `${p.fontPx}px`
        el.style.opacity = '1'
        shown.add(p.id)
      }
      for (const [id, el] of pool) if (!shown.has(id) && el.style.opacity !== '0') el.style.opacity = '0'
      live = placed.length
    },
    clear() {
      for (const el of pool.values()) el.style.opacity = '0'
      sticky.clear()
      live = 0
    },
    dispose() {
      pool.clear()
      sticky.clear()
      live = 0
      root.remove()
    },
    get count() {
      return live
    },
  }
}
