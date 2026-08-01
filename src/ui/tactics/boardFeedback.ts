import { useEffect, useRef, useState } from 'react'
import type { GroupIntensity, Instructions, TacticState } from '../../engine/types'
import type { AnalysisAxis, AnalysisHighlight } from '../pitch/AnalysisLayer'

// 작전판 보드가 "무엇이 바뀌었는지"를 말하는 두 경로가 여기 모여 있다. 작전판(경기 중)과
// 전술 센터(킥오프 전)가 **같은 훅**을 쓴다 — 두 화면이 다른 규율로 움직이면 유저는
// 같은 조작에서 다른 피드백을 받는다.
//
//  ① useAxisHighlight — 보드에 **도형이 있는** 축(라인·압박·템포·공격방향·공격패턴).
//     `13adeb8`이 세운 규율 그대로: 정착 후 1회, 드래그 중 펄스 0, 굵기·불투명도만.
//  ② useChangeCaption — 보드에 **도형이 없는** 축(아래 주석).

// 보드가 **도형으로 말할 수 없는 축**의 변경 캡션.
//
// AnalysisLayer가 그리는 네 도형(수비 라인·압박 존·패스 레인·공격 집중 밴드)은 곧 지시
// 네 축이고, 포메이션은 도트의 이동 그 자체다. 그 다섯은 `13adeb8`의 규율 그대로 보드가
// 직접 보여준다 — 여기서 중복해 말하지 않는다.
//
// 그러나 멘탈리티·그룹 적극성·세트피스·페이즈 포메이션·GK 파워플레이는 **보드에 대응하는
// 도형이 없다**(shape.tacticalCoords의 입력은 formation과 instructions뿐이다). 이 축들을
// 도형으로 그리려면 pitch 레이어의 좌표 변환 자체를 바꿔야 하고, 그건 이 갈래의 소유가
// 아니다. 그렇다고 아무 변화도 없으면 "눌렀는데 아무 일도 안 일어났다"가 된다.
//
// 그래서 **없는 도형을 지어내는 대신 문장으로 말한다.** 의미 없는 반짝임을 넣지 않는다는
// `13adeb8`의 규율이 지키려던 것이 바로 그것이다 — 강조는 값을 거짓말하지 않아야 한다.
// 규율의 나머지도 그대로 가져온다: 정착(260ms) 후 한 번, 잠시 뒤 스스로 사라진다.

/** 축이 멈춘 것으로 보는 시간. TacticsBoard.SETTLE_MS와 같은 값이다(같은 손동작을 잰다). */
const SETTLE_MS = 260
/** 캡션이 머무는 시간. 읽고 지나갈 만큼만 — 상주하면 보드를 가린다. */
const HOLD_MS = 2200
/** 도형 강조를 걷어내는 시각(펄스 700ms보다 조금 길게). */
const HIGHLIGHT_MS = 900

const MENTALITY_KO: Record<string, string> = {
  'very-defensive': '매우 수비적', defensive: '수비적', balanced: '균형',
  attacking: '공격적', 'very-attacking': '매우 공격적',
}
const INTENSITY_KO: Record<string, string> = { '-1': '자제', '0': '기본', '1': '적극' }
const LINE_KO: Record<keyof GroupIntensity, string> = {
  attack: '공격', midfield: '미드필드', defense: '수비',
}
const ROUTE_KO: Record<string, string> = { near: '니어', far: '파', short: '짧게' }
const LOAD_KO: Record<string, string> = { light: '적게', normal: '표준', heavy: '많이' }
const MARKING_KO: Record<string, string> = { zonal: '존', man: '맨투맨' }
const DEFAULT_GI: GroupIntensity = { attack: 0, midfield: 0, defense: 0 }

/** 두 전술 상태의 차이를 사람이 읽는 문장으로. 도형이 있는 축은 일부러 뺀다. */
export function captionOf(prev: TacticState, next: TacticState): string | null {
  const rows: string[] = []

  const pm = prev.mentality ?? 'balanced', nm = next.mentality ?? 'balanced'
  if (pm !== nm) rows.push(`멘탈리티 ${MENTALITY_KO[pm]} → ${MENTALITY_KO[nm]}`)

  const pg = { ...DEFAULT_GI, ...(prev.groupIntensity ?? {}) }
  const ng = { ...DEFAULT_GI, ...(next.groupIntensity ?? {}) }
  for (const k of ['attack', 'midfield', 'defense'] as const) {
    if (pg[k] !== ng[k]) rows.push(`${LINE_KO[k]} 적극성 ${INTENSITY_KO[String(pg[k])]} → ${INTENSITY_KO[String(ng[k])]}`)
  }

  const ps = prev.setPiece ?? {}, ns = next.setPiece ?? {}
  if ((ps.route ?? 'far') !== (ns.route ?? 'far')) {
    rows.push(`코너 루트 ${ROUTE_KO[ps.route ?? 'far']} → ${ROUTE_KO[ns.route ?? 'far']}`)
  }
  if ((ps.boxLoad ?? 'normal') !== (ns.boxLoad ?? 'normal')) {
    rows.push(`박스 인원 ${LOAD_KO[ps.boxLoad ?? 'normal']} → ${LOAD_KO[ns.boxLoad ?? 'normal']}`)
  }
  if ((ps.marking ?? 'zonal') !== (ns.marking ?? 'zonal')) {
    rows.push(`수비 마킹 ${MARKING_KO[ps.marking ?? 'zonal']} → ${MARKING_KO[ns.marking ?? 'zonal']}`)
  }

  const pf = prev.phaseFormations ?? {}, nf = next.phaseFormations ?? {}
  for (const k of ['attack', 'defense'] as const) {
    if (pf[k] !== nf[k]) {
      rows.push(`${k === 'attack' ? '공격 시' : '수비 시'} 대형 ${pf[k] ?? '기본 유지'} → ${nf[k] ?? '기본 유지'}`)
    }
  }

  if ((prev.gkPowerplay ?? false) !== (next.gkPowerplay ?? false)) {
    rows.push(next.gkPowerplay ? 'GK 전진 켬' : 'GK 전진 끔')
  }

  // 대형은 도트가 새 자리로 움직이는 것으로 이미 보인다(tactics.css의 0.5s transition).
  // 다만 **무엇에서 무엇으로** 갔는지는 도트가 말하지 못하므로 이름만 붙인다.
  if (prev.formation !== next.formation) rows.push(`대형 ${prev.formation} → ${next.formation}`)

  if (rows.length === 0) return null
  // 한 번의 조작이 여러 축을 움직이는 경우(코치 조언 [채택])는 묶어서 한 줄로 말한다.
  return rows.join(' · ')
}

/** 전술이 바뀌면 캡션을 한 번 띄운다. 정착 후 1회 · HOLD_MS 뒤 자동 소멸.
 *  @returns `{ text, tick }` — tick은 같은 문장이 연속으로 떠도 CSS 애니메이션을
 *  다시 시작시키기 위한 카운터다(AnalysisHighlight.tick과 같은 수법). */
export function useChangeCaption(tactics: TacticState | undefined): { text: string; tick: number } | null {
  const [cap, setCap] = useState<{ text: string; tick: number } | null>(null)
  const prev = useRef(tactics)
  const pending = useRef<string[]>([])
  const tick = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const before = prev.current
    prev.current = tactics
    if (!before || !tactics || before === tactics) return
    const line = captionOf(before, tactics)
    if (!line) return
    pending.current.push(line)
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      const text = pending.current.join(' · ')
      pending.current = []
      if (!text) return
      tick.current += 1
      setCap({ text, tick: tick.current })
      if (clear.current) clearTimeout(clear.current)
      clear.current = setTimeout(() => setCap(null), HOLD_MS)
    }, SETTLE_MS)
  }, [tactics])

  useEffect(() => () => {
    if (settle.current) clearTimeout(settle.current)
    if (clear.current) clearTimeout(clear.current)
  }, [])

  return cap
}

// ── ① 도형이 있는 축의 강조 ─────────────────────────────────────────
// (TacticsBoard에서 옮겨 왔다 — 전술 센터도 같은 규율로 움직여야 하기 때문이다.)

/** 전술 축 스냅샷 — 강조 판정의 입력. 값이 아니라 "무엇이 바뀌었나"만 뽑는다. */
export interface AxisSnapshot {
  lineHeight: number
  pressing: number
  tempo: number
  attackFocus: Instructions['attackFocus']
  attackPattern: string
}

/** 축 변경 → 보드 강조. **정착(settle) 후 한 번만** 올린다.
 *
 *  ★ 왜 즉시 올리지 않는가(사용자 지시: "드래그 중 화면이 요동치면 조작이 어렵다"):
 *  슬라이더 드래그는 1px마다 change를 쏜다. 변경마다 펄스를 걸면 700ms 애니메이션이
 *  프레임마다 재시작해 선이 계속 굵기를 바꾸며 깜박인다 — 값을 읽는 것 자체가 어려워진다.
 *  SETTLE_MS 동안 아무 변화가 없을 때만 "이번 조작은 끝났다"로 보고 한 번 강조한다.
 *  버튼 클릭(공격 패턴·공격방향)은 애초에 단발이라 SETTLE_MS 뒤 즉시 뜬다.
 *
 *  ★ 도형의 **이동 자체는 지연 없이** 매 프레임 반영된다(강조만 지연된다). 즉 "값이
 *  즉시 보인다"와 "무엇이 바뀌었는지 강조된다"를 분리했다. */
export function useAxisHighlight(snap: AxisSnapshot): AnalysisHighlight | undefined {
  const [hl, setHl] = useState<AnalysisHighlight | undefined>(undefined)
  const prev = useRef(snap)
  const pending = useRef(new Set<AnalysisAxis>())
  const tick = useRef(0)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const keys: AnalysisAxis[] = ['lineHeight', 'pressing', 'tempo', 'attackFocus', 'attackPattern']
    let any = false
    for (const k of keys) {
      if (prev.current[k] !== snap[k]) { pending.current.add(k); any = true }
    }
    prev.current = snap
    if (!any) return
    if (settleTimer.current) clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => {
      if (pending.current.size === 0) return
      tick.current += 1
      setHl({ axes: [...pending.current], tick: tick.current })
      pending.current.clear()
      if (clearTimer.current) clearTimeout(clearTimer.current)
      clearTimer.current = setTimeout(() => setHl(undefined), HIGHLIGHT_MS)
    }, SETTLE_MS)
    // snap 객체는 매 렌더 새로 만들어진다 — 의존성은 **값**이어야 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.lineHeight, snap.pressing, snap.tempo, snap.attackFocus, snap.attackPattern])

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current)
    if (clearTimer.current) clearTimeout(clearTimer.current)
  }, [])

  return hl
}
