// src/ui/pitch/three/crowd.ts
// 관중 인스턴싱 — docs/refs/stadium/crowd-distant-color-pattern.png를 목표로 한 재구현.
//
// ── 예전 구현이 레퍼런스와 달랐던 이유(진단) ──────────────────────
// 예전 scene.ts는 좌석 간격을 **목표 인원에서 역산**했다:
//     seatGap = max(0.9, 총둘레 / (목표인원 / 열수))
// 랜딩은 목표 2000명·12열이라 seatGap = 558m / 167 = **3.35m**가 나왔다. 인스턴스 폭은
// 그 66%인 2.2m, 열 간격은 26m/12 = 2.17m. 즉 화면에 선 것은 사람이 아니라
// **한 변 2m짜리 색 큐브**였고, 열 사이에 1m씩 빈 슬래브가 드러나 격자무늬가 됐다.
// 색도 반대였다 — 팀 컬러 지분 56%에 중립색으로 밝은 회색(#d8dde6)을 넣고 명도를
// 0.58~1.0으로 흔들어서, "어두운 네이비 70% + 드문 원색 점"인 레퍼런스와 정반대로
// 화면 전체가 채도 높은 밝은 블록이 됐다.
//
// ── 새 구현의 세 가지 결정 ───────────────────────────────────────
// 1) **좌석 격자를 인원 수에서 분리한다.** 사람 크기는 사람 크기다. 좌석 피치 0.62m,
//    열 간격 0.9m를 고정하고 스탠드 정원을 그것으로 정한다(≈25,000석). 목표 인원
//    파라미터는 이제 "정원까지 채우는가/비우는가"와 LOD만 정한다.
// 2) **파도타기를 정점 셰이더로 옮긴다.** 25,000명을 CPU에서 흔들면 프레임마다
//    sin 5만 번 + 1.6MB 행렬 업로드다. 인스턴스 속성 2개와 유니폼 2개로 옮기면
//    프레임 비용이 **0**이 되고, 그래서 인스턴스 수를 3.4배 늘릴 수 있었다.
// 3) **텍스처와 인스턴스의 2단 구성.** 인스턴스는 격자에 놓이므로 사이에 틈이 남는다.
//    슬래브에 같은 팔레트의 관중 타일(textures.makeCrowdCanvas)을 깔아 그 틈을 메운다.
//    텍스처가 밀도를, 인스턴스가 실루엣과 모션을 담당한다.
//
// 제약: Math.random / Date 금지(전부 인덱스 해시). three는 인자 주입(코드 스플릿).
import type * as THREE_NS from 'three'
import { CROWD_ACCENT, CROWD_DARK, hash01, type CrowdBias } from './textures'

/** 주입되는 three 네임스페이스(scene.ts의 ThreeAPI와 같은 타입). */
type ThreeAPI = typeof THREE_NS

/**
 * 좌석 피치(m) — 어깨 폭이 아니라 **좌석 폭**이다. 실제 경기장 좌석은 450~520mm이고
 * 통로·팔걸이를 더해 0.62m로 잡는다. 이 값이 화면상 인물 크기를 결정하는 유일한 상수다.
 */
export const SEAT_PITCH = 0.62
/**
 * 열 간격(m, 수평 투영). 실제 관람석 열 깊이는 0.8~0.9m다. 경사 0.5rad에서 한 열마다
 * 0.49m씩 올라가므로 앞줄 머리가 뒷줄 몸통을 반쯤 가린다 — 레퍼런스의 겹침이 그렇다.
 */
export const ROW_STEP = 0.9
/**
 * 관중 몸통 폭(m) — 좌석 피치보다 좁아야 어깨가 붙되 파고들지 않는다.
 * 첫 렌더에서 0.46이었을 때 인물이 볼링핀처럼 길쭉했다. 레퍼런스의 인물은
 * 폭:높이가 약 0.8이라 폭을 키우고 높이를 줄여 그 비율에 맞췄다.
 */
const BODY_W = 0.54
/** 몸통 두께(m). */
const BODY_D = 0.32
/** 몸통 높이(m, 앉은 사람과 선 사람 평균). 개체별로 ±15% 흔든다. */
const BODY_H = 0.66
/** 머리 한 변(m). */
const HEAD_S = 0.23

/**
 * 어두운 질량 지분. 레퍼런스 README의 "약 70%의 어두운 질량"을 그대로 쓴다.
 * 이 값이 1.0 - 원색점 지분이고, 이것 하나가 "관중석"과 "레고 블록"을 가른다.
 */
const DARK_SHARE = 0.72
/** 팀색 구역 블록 폭(좌석 수). 실제 경기장의 서포터 구역은 20~30석 단위로 뭉친다. */
const BLOCK_COLS = 14

/** 한 면의 관중석 서술자. scene.ts의 스탠드 레이아웃에서 넘어온다. */
export interface CrowdStand {
  /** rotY 각의 cos·sin 정확값(축 정렬 — 부동소수 오차 없음). */
  c: number
  s: number
  /** 로컬 z 기준 관중석 안쪽 경계(m). */
  inner: number
  /** 로컬 x 방향 길이(m). */
  length: number
  /** 이 면의 서포터 편향. */
  bias: CrowdBias
}

export interface CrowdOptions {
  stands: readonly CrowdStand[]
  homeColor: number
  awayColor: number
  /** 관중석 수평 깊이(m). */
  standDepth: number
  /** 관중석 경사각(rad). */
  rake: number
  /** 첫 열 높이(m). */
  standH0: number
  /**
   * 슬래브 윗면(좌석면)이 {@link standH0}보다 얼마나 위인가(m).
   * 관중석 경사 슬래브는 두께가 있으므로 그 절반을 수직으로 환산한 값이다.
   */
  seatLift?: number
  /**
   * LOD(0.35~1). 좌석 피치와 열 간격을 함께 1/detail배로 벌린다. 1이 정원.
   * 저사양에서 인스턴스 수를 줄일 때만 내린다 — 내리면 레퍼런스 밀도에서 멀어진다.
   */
  detail?: number
}

export interface CrowdBundle {
  mesh: THREE_NS.InstancedMesh
  count: number
  /**
   * 파도타기. 유니폼 2개만 갱신하므로 **호출 비용이 인스턴스 수와 무관**하다.
   * @param t 경과 시간(초) @param intensity 0=미세 흔들림, 1=골 세리머니 점프
   */
  wave(t: number, intensity: number): void
  /** 웨이브 유니폼(셰이더가 컴파일되기 전에도 존재 — 테스트가 이걸 본다). */
  waveUniforms: { uCrowdTime: { value: number }; uCrowdIntensity: { value: number } }
}

/** 주어진 스탠드 레이아웃과 LOD에서의 좌석 정원. */
export function crowdCapacity(
  stands: readonly CrowdStand[],
  standDepth: number,
  detail = 1,
): number {
  const d = clampDetail(detail)
  const pitch = SEAT_PITCH / d
  const rowStep = ROW_STEP / d
  const rows = Math.max(1, Math.floor(standDepth / rowStep))
  return stands.reduce((a, st) => a + Math.max(1, Math.round(st.length / pitch)) * rows, 0)
}

function clampDetail(d: number | undefined): number {
  if (typeof d !== 'number' || !Number.isFinite(d)) return 1
  return d < 0.35 ? 0.35 : d > 1 ? 1 : d
}

// ── 인물 지오메트리 ─────────────────────────────────────────────
/**
 * 면별 밝기(키라이트 (58,82,42) 방향과의 대략적인 램버트 항을 **정점 색에 굽는다**).
 *
 * 관중은 unlit(MeshBasic)이다 — 램버트로 켜면 피치를 향한 면이 조명 사각지대라
 * 새까맣게 죽고, 25,000개를 라이팅하는 비용도 든다. 대신 면 방향별 밝기를 상수로
 * 구워 두면 공짜로 방향성 음영이 생긴다. 관중이 회전하지 않는(축 정렬 스케일 + 이동만)
 * 인스턴스라서 성립하는 최적화다.
 */
const FACE_LIGHT: Record<'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz', number> = {
  py: 1.14, // 위 — 조명탑이 위에 있다
  px: 0.92,
  pz: 0.86,
  // 그늘 면의 **바닥을 0.34에서 0.62로 올렸다.** 첫 렌더에서 어두운 질량이 사실상
  // 순검정이 되어 "사람이 드문드문 서 있는 검은 벽"으로 보였다. 레퍼런스의 어두운
  // 70%는 검정이 아니라 **형태가 보이는 짙은 네이비 인물**이다.
  nx: 0.7,
  nz: 0.66,
  ny: 0.62,
}

type FaceKey = keyof typeof FACE_LIGHT

/** 축 정렬 박스 한 개를 비인덱스 삼각형으로 밀어 넣는다(정점 색에 면 밝기를 굽는다). */
function pushBox(
  pos: number[],
  col: number[],
  cx: number,
  cy: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  gain: number,
): void {
  const x0 = cx - w / 2
  const x1 = cx + w / 2
  const y0 = cy - h / 2
  const y1 = cy + h / 2
  const z0 = cz - d / 2
  const z1 = cz + d / 2
  // [face, 4 corners(반시계, 바깥 향함)]
  const quads: [FaceKey, number[][]][] = [
    ['pz', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    ['nz', [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
    ['px', [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    ['nx', [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    ['py', [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    ['ny', [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
  ]
  for (const [face, q] of quads) {
    const k = FACE_LIGHT[face] * gain
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      pos.push(q[idx][0], q[idx][1], q[idx][2])
      col.push(k, k, k)
    }
  }
}

/**
 * 관중 1명의 지오메트리(몸통 박스 + 머리 박스, 24 삼각형).
 * 원점은 **발밑 중심**이라 인스턴스 행렬이 좌석면 높이를 그대로 y로 쓰면 된다.
 * 머리를 따로 두는 이유: 근경 카메라에서 실루엣이 사람으로 읽혀야 한다. 원경에서는
 * 두 조각이 한 점으로 뭉치므로 손해가 없다.
 */
export function personGeometry(THREE: ThreeAPI): THREE_NS.BufferGeometry {
  const pos: number[] = []
  const col: number[] = []
  pushBox(pos, col, 0, BODY_H / 2, 0, BODY_W, BODY_H, BODY_D, 1)
  // 머리는 살짝 밝게(모자·얼굴이 조명을 더 받는다).
  pushBox(pos, col, 0, BODY_H + HEAD_S / 2, 0, HEAD_S, HEAD_S, HEAD_S, 1.14)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  // frustumCulled를 끄고 쓰므로 바운딩 구는 필요 없지만, 레이캐스트·헬퍼가 부르면
  // 계산 비용이 생기므로 미리 넣어 둔다.
  geo.computeBoundingSphere()
  return geo
}

// ── 웨이브 셰이더 ───────────────────────────────────────────────
/**
 * 파도타기를 정점 셰이더에 주입한다.
 *
 * `<project_vertex>`를 통째로 갈아 끼워 **인스턴스 행렬 적용 직후·뷰 변환 직전**에
 * y를 더한다. 인스턴스 행렬 이후여야 오프셋이 개체 스케일(sy)에 곱해지지 않고,
 * 뷰 변환 이전이어야 모델 공간 = 월드 공간 y가 된다. 관중 메시가 붙는 stadiumGroup은
 * 변환이 없으므로 이 등식이 성립한다(그룹에 회전·스케일을 주면 깨진다 — 주지 마라).
 */
const WAVE_COMMON = /* glsl */ `
attribute vec2 aWave;
uniform float uCrowdTime;
uniform float uCrowdIntensity;
`

const WAVE_PROJECT = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
// aWave.x = 개체 위상, aWave.y = 경기장 중심 기준 방위각(파도 진행 방향)
float idle = 0.035 * sin( uCrowdTime * 1.9 + aWave.x );
float jump = 0.85 * uCrowdIntensity
  * max( 0.0, sin( uCrowdTime * 4.6 - aWave.y * 1.15 + aWave.x * 0.12 ) );
mvPosition.y += idle + jump;
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`

// ── 빌더 ────────────────────────────────────────────────────────
/**
 * 관중 InstancedMesh를 만든다. 좌석 격자는 고정 피치이므로 인스턴스 수는
 * {@link crowdCapacity}가 그대로 결정한다(호출부가 인원을 지정하지 않는다).
 */
export function buildCrowd(THREE: ThreeAPI, opts: CrowdOptions): CrowdBundle {
  const detail = clampDetail(opts.detail)
  const pitch = SEAT_PITCH / detail
  const rowStep = ROW_STEP / detail
  const rows = Math.max(1, Math.floor(opts.standDepth / rowStep))
  const tanRake = Math.tan(opts.rake)
  const seatLift = typeof opts.seatLift === 'number' && Number.isFinite(opts.seatLift) ? opts.seatLift : 0
  const count = crowdCapacity(opts.stands, opts.standDepth, detail)

  const geo = personGeometry(THREE)
  const waveUniforms = { uCrowdTime: { value: 0 }, uCrowdIntensity: { value: 0 } }
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCrowdTime = waveUniforms.uCrowdTime
    shader.uniforms.uCrowdIntensity = waveUniforms.uCrowdIntensity
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${WAVE_COMMON}`)
      .replace('#include <project_vertex>', WAVE_PROJECT)
  }

  const mesh = new THREE.InstancedMesh(geo, mat, count)
  mesh.name = 'crowd'
  // 볼 전체가 항상 카메라 주변에 있고 바운딩 계산이 25,000개에 걸리면 낭비다.
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  // 웨이브 유니폼을 메시에 걸어 둔다. 셰이더는 WebGL이 있어야 컴파일되므로
  // node 테스트는 이 객체를 통해서만 wave() 동작을 관측할 수 있다.
  mesh.userData.waveUniforms = waveUniforms

  const m = mesh.instanceMatrix.array as Float32Array
  const wave = new Float32Array(count * 2)
  const col = new THREE.Color()
  const home = new THREE.Color(opts.homeColor)
  const away = new THREE.Color(opts.awayColor)
  const darks = CROWD_DARK.map((h) => new THREE.Color(h))
  const accents = CROWD_ACCENT.map((h) => new THREE.Color(h))

  let i = 0
  for (let sIdx = 0; sIdx < opts.stands.length; sIdx++) {
    const st = opts.stands[sIdx]
    const cols = Math.max(1, Math.round(st.length / pitch))
    const colStep = st.length / cols
    for (let r = 0; r < rows; r++) {
      const lz = st.inner + (r + 0.5) * rowStep
      // 슬래브 윗면 높이. 인물 원점이 발밑이므로 그대로 쓴다(예전처럼 sy/2 보정 불필요).
      const surfaceY = opts.standH0 + seatLift + (lz - st.inner) * tanRake
      const rowFrac = rows > 1 ? r / (rows - 1) : 0
      // 위쪽 열은 조명탑에서 멀고 지붕 그늘에 든다 — 22%까지 어둡게.
      const rowDim = 1 - rowFrac * 0.22
      // 홀수 열 반 칸 어긋남(실제 좌석 배치).
      const stagger = r % 2 === 0 ? 0 : colStep / 2
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const h1 = hash01(i * 3 + 11)
        const h2 = hash01(i * 3 + 20011)
        const h3 = hash01(i * 5 + 917)
        const lx = -st.length / 2 + (cIdx + 0.5) * colStep + stagger + (h2 - 0.5) * colStep * 0.34
        // 로컬(x,z) → 월드(x,z): rotY(yaw)
        const wx = lx * st.c + lz * st.s
        const wz = -lx * st.s + lz * st.c
        // 개체 키(±15%). 앉은 사람·선 사람·아이가 섞인 실루엣의 불규칙함.
        const sy = 0.86 + h1 * 0.3

        const o = i * 16
        m[o] = 1
        m[o + 5] = sy
        m[o + 10] = 1
        m[o + 12] = wx
        m[o + 13] = surfaceY
        m[o + 14] = wz
        m[o + 15] = 1

        wave[i * 2] = hash01(i * 7 + 3301) * Math.PI * 2
        wave[i * 2 + 1] = Math.atan2(wz, wx) + Math.PI

        seatColor(col, st, sIdx, cIdx, i, h3, home, away, darks, accents)
        col.multiplyScalar(rowDim)
        mesh.setColorAt(i, col)
        i++
      }
    }
  }

  geo.setAttribute('aWave', new THREE.InstancedBufferAttribute(wave, 2))
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true

  return {
    mesh,
    count,
    wave(t: number, intensity: number): void {
      const k = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity
      waveUniforms.uCrowdTime.value = t
      waveUniforms.uCrowdIntensity.value = k
    },
    waveUniforms,
  }
}

/**
 * 좌석 1개의 색(결정론).
 *
 * 레퍼런스 대응: 68%는 어두운 질량, 32%만 원색 점이다. 원색 점 안에서 홈/어웨이 비율은
 * **좌석 단위가 아니라 22석 블록 단위**로 정한다 — 실제 경기장의 서포터 구역이 그렇고,
 * 좌석마다 독립 난수를 굴리면 전체가 균일한 보랏빛 노이즈로 수렴해 구역이 사라진다.
 */
function seatColor(
  out: THREE_NS.Color,
  st: CrowdStand,
  sIdx: number,
  cIdx: number,
  i: number,
  pick: number,
  home: THREE_NS.Color,
  away: THREE_NS.Color,
  darks: readonly THREE_NS.Color[],
  accents: readonly THREE_NS.Color[],
): void {
  if (pick < DARK_SHARE) {
    out.copy(darks[Math.floor(hash01(i * 11 + 4441) * darks.length) % darks.length])
    // 어두운 질량은 명도만 살짝 흔든다. 하한을 0.75 → 0.88로 올려 형태가 남게 한다.
    out.multiplyScalar(0.88 + hash01(i * 13 + 6607) * 0.36)
    return
  }

  // 블록 편향: 면의 기본 편향에 블록 해시를 섞는다.
  const block = Math.floor(cIdx / BLOCK_COLS)
  const bh = hash01(sIdx * 7919 + block * 31 + 577)
  let homeP: number
  let awayP: number
  if (st.bias === 'home') {
    // 홈 골 뒤 — 대부분 홈 블록, 원정 원정석이 한두 블록 섞인다.
    homeP = bh < 0.86 ? 0.78 : 0.14
    awayP = bh < 0.86 ? 0.06 : 0.7
  } else if (st.bias === 'away') {
    homeP = bh < 0.82 ? 0.08 : 0.66
    awayP = bh < 0.82 ? 0.74 : 0.12
  } else {
    // 롱사이드 — 블록마다 한쪽이 우세하되 전체로는 균형.
    homeP = bh < 0.5 ? 0.54 : 0.2
    awayP = bh < 0.5 ? 0.2 : 0.54
  }

  const t = (pick - DARK_SHARE) / (1 - DARK_SHARE)
  if (t < homeP) out.copy(home)
  else if (t < homeP + awayP) out.copy(away)
  else out.copy(accents[Math.floor(hash01(i * 17 + 2287) * accents.length) % accents.length])
  // 팀 셔츠도 야간엔 그늘이 진다. 상한을 0.92로 눌러 원색이 형광처럼 뜨지 않게 한다
  // (첫 렌더에서 1.0까지 허용했더니 파랑이 레퍼런스보다 훨씬 밝게 튀었다).
  out.multiplyScalar(0.55 + hash01(i * 13 + 6607) * 0.37)
}
