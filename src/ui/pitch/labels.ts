// src/ui/pitch/labels.ts
// 피치 위 텍스트의 **단일 배치 패스**.
//
// 왜 필요한가: 선수 이름·라인 태그·존 캡션이 각자 절대 좌표로 그려지면서 서로 겹쳤다
// (감사 A-2/A-3: "김문환" ↔ "수비 라인 20"). y 좌표를 하나씩 손보는 건 다음 포메이션에서
// 다시 깨진다. 그래서 **겹칠 수 있는 텍스트 전부를 한 배열로 모아** 여기서 자리를 정한다.
//
// 계약: 반환된 박스는 서로 절대 겹치지 않는다. 자리를 못 찾은 라벨은 **그리지 않는다**
// (`dropped`). 겹쳐 읽히느니 안 보이는 게 낫다 — FM도 라이브 피치에 이름을 안 쓴다.
//
// 좌표계는 viewBox 단위(105×68)다. 호출자가 변환해서 넘긴다.

export interface Box { x: number; y: number; w: number; h: number }

/** 라벨 박스 높이 = fontSize × 이 비율. 한글 글리프 + 후광(paint-order stroke)까지 덮는다. */
export const LABEL_H_RATIO = 1.5
/** 도트를 장애물로 등록할 때의 반지름(viewBox). 도트 r 2.4 + 스트로크 0.3 + 여유. */
export const DOT_BLOCK_R = 2.95

/** 앵커 기준 후보 자리(우선순위 순). */
export interface LabelSlot { dx: number; dy: number }

export interface LabelReq {
  id: string
  text: string
  /** 앵커(라벨이 가리키는 대상의 중심, viewBox 좌표). */
  ax: number
  ay: number
  fontSize: number
  /** 후보 자리 — 앞쪽일수록 선호. */
  slots: LabelSlot[]
  /** 낮을수록 먼저 자리를 잡는다(중요한 라벨이 밀리지 않는다). */
  rank: number
  /** 좌우 여백(플레이트가 있는 라벨은 크게). 기본 0.5. */
  padX?: number
}

export interface PlacedLabel {
  id: string
  text: string
  /** 텍스트 중심(text-anchor: middle, dominant-baseline: central 기준). */
  x: number
  y: number
  box: Box
  /** 채택된 후보 인덱스 — 히스테리시스에 쓴다. */
  slot: number
}

/** 한글은 전각(≈1.0em), 라틴·숫자·공백은 반각(≈0.56em)으로 근사한다. */
export function textWidth(text: string, fontSize: number): number {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    // 한글 음절·자모·전각 기호 범위.
    w += (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7a3)
      ? 1.0
      : 0.56
  }
  return w * fontSize
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function boxAt(req: LabelReq, slot: LabelSlot, bounds: Box): Box {
  const padX = req.padX ?? 0.5
  const w = textWidth(req.text, req.fontSize) + padX * 2
  const h = req.fontSize * LABEL_H_RATIO
  let x = req.ax + slot.dx - w / 2
  let y = req.ay + slot.dy - h / 2
  // 뷰박스 밖으로 나가면 안쪽으로 민다(측면 선수 이름이 잘리던 문제).
  x = Math.max(bounds.x, Math.min(bounds.x + bounds.w - w, x))
  y = Math.max(bounds.y, Math.min(bounds.y + bounds.h - h, y))
  return { x, y, w, h }
}

/**
 * 배치 패스. rank → id 순으로 결정론 정렬한 뒤, 각 라벨의 후보 자리를 차례로 시도해
 * **하나도 겹치지 않는** 첫 자리를 잡는다. 전부 막히면 그 라벨은 버린다.
 *
 * @param reqs     배치 요청
 * @param bounds   그릴 수 있는 영역(보통 0,0,105,68)
 * @param blockers 텍스트가 아니지만 피해야 하는 영역(범례 패널 등)
 * @param sticky   직전 프레임에서 채택된 후보 인덱스(id→slot). 있으면 그 자리를 먼저 시도해
 *                 미세 진동 때문에 라벨이 매 틱 위아래로 튀는 걸 막는다.
 */
export function layoutLabels(
  reqs: LabelReq[],
  bounds: Box,
  blockers: Box[] = [],
  sticky?: Map<string, number>,
): { placed: PlacedLabel[]; dropped: string[] } {
  const sorted = [...reqs].sort((a, b) => (a.rank - b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const taken: Box[] = [...blockers]
  const placed: PlacedLabel[] = []
  const dropped: string[] = []
  for (const req of sorted) {
    const order: number[] = []
    const s = sticky?.get(req.id)
    if (s != null && s >= 0 && s < req.slots.length) order.push(s)
    for (let i = 0; i < req.slots.length; i++) if (i !== s) order.push(i)

    let hit: { box: Box; slot: number } | null = null
    for (const i of order) {
      const box = boxAt(req, req.slots[i], bounds)
      if (!taken.some(t => overlaps(box, t))) { hit = { box, slot: i }; break }
    }
    if (!hit) { dropped.push(req.id); continue }
    taken.push(hit.box)
    placed.push({
      id: req.id,
      text: req.text,
      x: hit.box.x + hit.box.w / 2,
      y: hit.box.y + hit.box.h / 2,
      box: hit.box,
      slot: hit.slot,
    })
  }
  return { placed, dropped }
}
