// src/ui/pitch/three/exterior.ts
// 경기장 **바깥** — 밤하늘 돔 · 조명탑 헤일로와 빛기둥 · 스탠드 지붕 · 외벽 파사드 ·
// 원경 도시 실루엣.
//
// ── 왜 이 모듈이 생겼는가 ────────────────────────────────────────
// 랜딩 스크린샷에서 경기장 밖은 **순검정**이었다. 3D 배경인데 볼(bowl)만 허공에 떠 있고,
// 하늘도 지평선도 건물도 없었다. 원인은 단순하다 — `scene.background`가 단색 `#080e18`
// 하나였고 그 바깥에 아무 지오메트리도 없었다. 야간 경기장을 밖에서 보면 실제로는
//   ① 위로 갈수록 어두워지는 하늘과 지평선의 광공해,
//   ② 조명탑에서 퍼지는 대기 산란 halo와 피치로 내리꽂는 빛기둥,
//   ③ 스탠드를 덮는 지붕과 그 아래 조명 갠트리,
//   ④ 콘코스 불빛이 새어나오는 외벽,
//   ⑤ 지평선의 도시 실루엣
// 이 보인다. 다섯 가지를 전부 절차 생성으로 넣는다.
//
// ── 비용 원칙 ───────────────────────────────────────────────────
// 랜딩은 심사자가 보는 첫 화면이므로 여기에 비용을 써도 되지만, 무제한은 아니다.
// 그래서 전부 **드로우콜 한 자릿수 + 라이팅 없는 재질**로 짰다: 하늘 돔 1, 실루엣 링 1,
// 지붕/파사드 면당 2, halo 스프라이트 8, 빛기둥 4. 라이트는 하나도 추가하지 않는다.
// 이 중 유일하게 큰 반투명 면을 겹쳐 그리는 것이 빛기둥이므로(화면 상당 면적의 오버드로우)
// 저사양에서 먼저 끌 수 있게 `lightShafts: false`를 열어 뒀다. 다만 **이 항목만 따로
// 계측하지는 않았다** — 외부 요소 전체를 켠 뒤의 프레임 증가분만 측정했다(broadcast post
// p50 3.3ms → 4.4ms, 관중 3.4배 증가분 포함).
//
// 제약: Math.random / Date 금지. three는 인자 주입(코드 스플릿). canvas 미지원 환경에서
// 텍스처가 null이면 **단색으로 폴백**하고 절대 throw하지 않는다.
import type * as THREE_NS from 'three'
import {
  makeFacadeCanvas,
  makeGlowCanvas,
  makeLightConeCanvas,
  makeRoofCanvas,
  makeSkyCanvas,
  makeSkylineCanvas,
} from './textures'

type ThreeAPI = typeof THREE_NS

/** 밤하늘 돔 반지름(m). 카메라 far(900)와 랜딩 오빗 반경(110)을 고려한 상한이다. */
export const SKY_RADIUS = 700
/** 원경 도시 실루엣 링 반지름(m). 하늘 돔 안쪽, 경기장(≈110m) 바깥. */
export const SKYLINE_RADIUS = 545
/** 도시 실루엣 링 높이(m) — 545m 거리에서 화각상 지평선 위 약 6°를 차지한다. */
const SKYLINE_H = 128

/** exterior가 받는 스탠드 한 면(scene.ts 레이아웃에서 그대로 넘어온다). */
export interface ExteriorStand {
  /** rotY 각(rad). */
  yaw: number
  /** 로컬 z 기준 관중석 안쪽 경계(m). */
  inner: number
  /** 로컬 x 방향 길이(m). */
  length: number
}

export interface ExteriorOptions {
  stands: readonly ExteriorStand[]
  /** 관중석 수평 깊이(m). */
  standDepth: number
  /** 관중석 경사각(rad). */
  rake: number
  /** 첫 열 높이(m). */
  standH0: number
  /** 조명탑 마스트 위치(월드 xz)와 리그 높이(m). */
  masts: readonly { x: number; z: number }[]
  rigY: number
  /** 밤하늘 밝기 배율(scene.skyBoost와 같은 의미). */
  skyBoost?: number
  /** 발광체 HDR 배율(scene.emissiveBoost와 같은 의미). */
  emissiveBoost?: number
  /** anisotropy 상한. */
  maxAnisotropy?: number
  /** 빛기둥(조명탑 → 피치)을 그릴지. 오버드로우가 유일하게 눈에 띄는 비용이라 열어 둔다. */
  lightShafts?: boolean
}

export interface ExteriorBundle {
  group: THREE_NS.Group
  /**
   * 발광체(halo·빛기둥·지붕 갠트리) HDR 배율을 런타임에 교체한다.
   * 포스트FX가 **비동기로** 붙으므로 scene.setEmissiveBoost가 이걸 함께 부른다.
   */
  setEmissiveBoost(boost: number): void
}

/** canvas → CanvasTexture. null이면 null(호출부가 단색 폴백). */
function tex(
  THREE: ThreeAPI,
  canvas: HTMLCanvasElement | null,
  opts: { aniso?: number; repeat?: [number, number]; wrap?: boolean } = {},
): THREE_NS.CanvasTexture | null {
  if (!canvas) return null
  const t = new THREE.CanvasTexture(canvas)
  if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = Math.max(1, opts.aniso ?? 8)
  if (opts.wrap !== false) {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
  }
  if (opts.repeat) t.repeat.set(opts.repeat[0], opts.repeat[1])
  t.needsUpdate = true
  return t
}

/**
 * 경기장 외부 일체를 조립해 하나의 Group으로 돌려준다.
 * 반환된 그룹은 호출부가 씬에 붙이고, 해제는 scene.disposeTree가 순회로 처리한다.
 */
export function buildExterior(THREE: ThreeAPI, opts: ExteriorOptions): ExteriorBundle {
  const aniso = opts.maxAnisotropy ?? 8
  const skyBoost = num(opts.skyBoost, 1)
  let boost = num(opts.emissiveBoost, 1)
  const group = new THREE.Group()
  group.name = 'exterior'

  const rise = opts.standDepth * Math.tan(opts.rake)
  /** 스탠드 꼭대기(마지막 열 좌석면) 높이 — 지붕·파사드의 기준선이다. */
  const topY = opts.standH0 + rise
  /** 지붕 밑면 높이. 꼭대기 관중 머리 위 여유 4.5m. */
  const roofY = topY + 4.5
  /** 파사드(외벽) 꼭대기 = 지붕보다 살짝 위. */
  const facadeTop = roofY + 3.2

  // ── ① 밤하늘 돔 ────────────────────────────────────────────────
  // BackSide 구체 안쪽에 그라디언트를 붙인다. fog를 끄는 것이 핵심이다 —
  // 포그(끝 470m)를 켜면 700m 밖 돔이 전부 포그 색으로 뭉개져 그라디언트가 사라진다.
  const skyTex = tex(THREE, makeSkyCanvas(512, 512), { aniso, wrap: false })
  const skyGeo = new THREE.SphereGeometry(SKY_RADIUS, 32, 20)
  const skyMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(skyTex ? 0xffffff : 0x0a1120).multiplyScalar(skyBoost),
    ...(skyTex ? { map: skyTex } : {}),
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const sky = new THREE.Mesh(skyGeo, skyMat)
  sky.name = 'sky-dome'
  // 하늘은 항상 가장 먼저 그려 뒤에 남는다(다른 무엇도 가리지 않는다).
  sky.renderOrder = -10
  group.add(sky)

  // ── ② 원경 도시 실루엣 ─────────────────────────────────────────
  // 지평선이 완전한 검정이면 경기장이 무대 세트처럼 떠 보인다. 어두운 건물 띠 하나로
  // "도시 안" 스케일이 생긴다. 포그를 끄는 이유는 하늘 돔과 같다.
  const skylineTex = tex(THREE, makeSkylineCanvas(2048, 256), { aniso, repeat: [3, 1] })
  if (skylineTex) {
    const geo = new THREE.CylinderGeometry(SKYLINE_RADIUS, SKYLINE_RADIUS, SKYLINE_H, 64, 1, true)
    const mat = new THREE.MeshBasicMaterial({
      map: skylineTex,
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      // 광공해에 잠긴 원경이라 살짝 눌러 준다.
      color: new THREE.Color(0xb9c4dc).multiplyScalar(skyBoost),
    })
    const ring = new THREE.Mesh(geo, mat)
    ring.name = 'skyline'
    // 텍스처 아래쪽이 지면이므로 원통 밑면을 지면에 맞춘다.
    ring.position.y = SKYLINE_H / 2 - 3
    ring.renderOrder = -9
    group.add(ring)
  }

  // ── ③ 스탠드 지붕 + 조명 갠트리 ────────────────────────────────
  // 지붕 상면은 밖에서 보이는 유일한 큰 면이다. 단색 0x121721이었을 때 경기장 주위에
  // 검은 판자 네 장이 떠 있는 것처럼 보였다 — 패널 이음매 텍스처를 깔고 색도 올린다.
  const roofTex = tex(THREE, makeRoofCanvas(256), { aniso, repeat: [8, 1] })
  const roofMat = new THREE.MeshLambertMaterial({
    color: roofTex ? 0x8e9bb4 : 0x1c2432,
    ...(roofTex ? { map: roofTex } : {}),
  })
  /** 지붕 앞단(캔틸레버 끝)을 긋는 밝은 테두리. 볼의 윤곽선이 된다. */
  const roofEdgeMat = new THREE.MeshBasicMaterial({ color: hdrColor(THREE, 0x5d6a83, 0.16, boost), toneMapped: false })
  // 지붕 앞단 아래에 매달린 조명 갠트리. 실제 경기장에서 피치를 비추는 주 광원이고,
  // 화면에서는 어두운 지붕 밑을 긋는 밝은 선이 되어 볼의 윤곽을 만든다.
  const gantryMat = new THREE.MeshBasicMaterial({ color: hdrColor(THREE, 0xd8e4ff, 0.42, boost), toneMapped: false })
  const facadeCanvas = makeFacadeCanvas(512, 256)
  /** 파사드 타일 한 장이 덮는 실치수(m). 세로 콘코스 3층이 들어갈 높이로 잡는다. */
  const FACADE_TILE_W = 32
  const FACADE_TILE_H = 24
  /**
   * 면마다 길이가 달라 **텍스처를 면마다 따로 만든다**. 하나를 공유하면 repeat이
   * 마지막에 설정한 면 기준으로 통일돼 롱사이드와 엔드의 창문 크기가 달라진다.
   */
  const facadeMatFor = (len: number): THREE_NS.MeshBasicMaterial => {
    const t = tex(THREE, facadeCanvas, {
      aniso,
      repeat: [Math.max(1, Math.round(len / FACADE_TILE_W)), Math.max(1, Math.round(facadeTop / FACADE_TILE_H))],
    })
    return new THREE.MeshBasicMaterial({
      color: t ? 0x59627a : 0x0d1119,
      ...(t ? { map: t } : {}),
    })
  }
  const trussMat = new THREE.MeshLambertMaterial({ color: 0x1b2230 })

  for (const st of opts.stands) {
    const g = new THREE.Group()
    g.rotation.y = st.yaw

    // 지붕 슬래브 — 앞단은 스탠드 중간(캔틸레버), 뒷단은 파사드 바깥까지.
    // 폭을 length+8 → length로 줄였다: 롱사이드(158m)가 볼 폭보다 길어서 +8을 더하면
    // 코너에서 엔드 지붕과 서로 튀어나와 허공에 쐐기가 생겼다.
    const roofFront = st.inner + opts.standDepth * 0.3
    const roofBack = st.inner + opts.standDepth + 6
    const roofDepth = roofBack - roofFront
    const roof = new THREE.Mesh(new THREE.BoxGeometry(st.length, 1.1, roofDepth), roofMat)
    roof.position.set(0, roofY + 0.55, (roofFront + roofBack) / 2)
    // 바깥쪽으로 살짝 들린 캔틸레버(빗물 배수 각). 실루엣이 판자가 아니게 된다.
    roof.rotation.x = -0.045
    g.add(roof)

    // 지붕 앞단 테두리 — 밖에서도 안에서도 보이는 밝은 선. 지붕이 "끝나는 곳"을 그린다.
    const edge = new THREE.Mesh(new THREE.BoxGeometry(st.length * 0.96, 0.34, 0.34), roofEdgeMat)
    edge.position.set(0, roofY + 0.62, roofFront)
    g.add(edge)

    // 지붕 앞단 조명 갠트리(가늘고 밝은 띠) — 안쪽(관중석)에서 보이는 주 광원.
    const gantry = new THREE.Mesh(new THREE.BoxGeometry(st.length - 4, 0.42, 0.7), gantryMat)
    gantry.position.set(0, roofY - 0.35, roofFront + 0.6)
    g.add(gantry)

    // 지붕을 받치는 트러스 기둥(파사드 앞) — 원경 실루엣에 리듬을 준다.
    const posts = Math.max(4, Math.round(st.length / 22))
    const postGeo = new THREE.BoxGeometry(0.9, roofY, 0.9)
    for (let i = 0; i <= posts; i++) {
      const p = new THREE.Mesh(postGeo, trussMat)
      p.position.set(-st.length / 2 + (i * st.length) / posts, roofY / 2, roofBack - 2)
      g.add(p)
    }

    // ── ④ 외벽 파사드 ────────────────────────────────────────────
    const wall = new THREE.Mesh(new THREE.BoxGeometry(st.length + 6, facadeTop, 1.8), facadeMatFor(st.length + 6))
    wall.position.set(0, facadeTop / 2, st.inner + opts.standDepth + 6.6)
    g.add(wall)

    group.add(g)
  }

  // ── ⑤ 조명탑 헤일로 + 빛기둥 ──────────────────────────────────
  const glowTex = tex(THREE, makeGlowCanvas(256, 0.06), { aniso: 4, wrap: false })
  const coneTex = tex(THREE, makeLightConeCanvas(8, 128), { aniso: 2, wrap: false })
  /** 배율 교체 시 다시 색을 써야 하는 발광 재질들. */
  const emissive: { mat: THREE_NS.Material & { color: THREE_NS.Color }; hex: number; share: number }[] = [
    { mat: gantryMat, hex: 0xd8e4ff, share: 0.42 },
    { mat: roofEdgeMat, hex: 0x5d6a83, share: 0.16 },
  ]

  const shafts = opts.lightShafts !== false
  for (const mast of opts.masts) {
    if (glowTex) {
      // 대기 산란 halo — 넓고 흐린 것 하나 + 작고 뜨거운 코어 하나.
      // 스프라이트라 항상 카메라를 향하므로 어느 각도에서도 "빛나는 등"으로 읽힌다.
      for (const [size, hex, share] of [
        [78, 0x9fc0ff, 0.34],
        [26, 0xfff3d4, 1],
      ] as const) {
        const mat = new THREE.SpriteMaterial({
          map: glowTex,
          color: hdrColor(THREE, hex, share, boost),
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          toneMapped: false,
          fog: false,
        })
        const sp = new THREE.Sprite(mat)
        sp.position.set(mast.x, opts.rigY, mast.z)
        sp.scale.set(size, size, 1)
        sp.renderOrder = 3
        group.add(sp)
        emissive.push({ mat, hex, share })
      }
    }

    if (shafts && coneTex) {
      // 빛기둥: 리그에서 피치 중앙 쪽 지면으로 내리꽂는 원뿔(옆면만, 가산합성).
      // 목표점을 원점이 아니라 마스트 쪽으로 당겨야 네 기둥이 가운데서 겹쳐 뭉치지 않는다.
      const tx = mast.x * 0.22
      const tz = mast.z * 0.22
      const dx = mast.x - tx
      const dz = mast.z - tz
      const len = Math.sqrt(dx * dx + dz * dz + opts.rigY * opts.rigY)
      const geo = new THREE.CylinderGeometry(2.6, 40, len, 20, 1, true)
      const mat = new THREE.MeshBasicMaterial({
        map: coneTex,
        color: hdrColor(THREE, 0x8fa8d8, 0.3, boost),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
      })
      const cone = new THREE.Mesh(geo, mat)
      cone.position.set((mast.x + tx) / 2, opts.rigY / 2, (mast.z + tz) / 2)
      // 원통 로컬 +Y를 "지면 → 리그" 방향에 맞춘다(텍스처 위쪽 = 광원).
      const dir = new THREE.Vector3(dx, opts.rigY, dz).normalize()
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
      cone.renderOrder = 2
      group.add(cone)
      emissive.push({ mat, hex: 0x8fa8d8, share: 0.3 })
    }
  }

  function setEmissiveBoost(next: number): void {
    boost = num(next, 1)
    for (const e of emissive) e.mat.color.copy(hdrColor(THREE, e.hex, e.share, boost))
  }

  return { group, setEmissiveBoost }
}

/** 1 미만·NaN은 기본값으로 되돌린다. */
function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * 발광체 색을 선형 공간에서 HDR로 민다(scene.ts의 hdr()과 같은 계약).
 * @param share 조명탑 리그 대비 초과분 비율(1 = 리그와 같은 세기)
 */
function hdrColor(THREE: ThreeAPI, hex: number, share: number, boost: number): THREE_NS.Color {
  return new THREE.Color(hex).multiplyScalar(1 + (boost - 1) * share)
}
