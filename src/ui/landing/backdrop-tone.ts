// src/ui/landing/backdrop-tone.ts
// 랜딩 배경 **전용** 톤 보정 — buildScene이 만든 씬을 랜딩 인스턴스에서만 다시 만진다.
//
// 왜 scene.ts를 고치지 않는가: 같은 씬 자산을 경기 화면이 함께 쓴다. 경기 화면에서 잔디는
// 주인공이고 관중은 응원의 증거라 밝아야 한다. 랜딩에서는 정반대다 — 주인공이 타이틀이고
// 경기장은 **무대 배경**이다. 같은 씬을 두 목적에 쓰려면 소유자가 각자 톤을 잡아야 한다.
//
// 근거는 사용자가 만든 시안(docs/refs/title/game-intro-title-v2.png)이다. 시안과 직전
// 구현(docs/audit/shots/title-1600x900.png)을 나란히 놓으면 차이는 배치가 아니라 **명암
// 배분**이었다:
//   · 시안의 피치는 작고 어둡게 깔려 있고 중앙에만 빛 웅덩이가 있다.
//     구현은 밝은 초록이 하단 절반을 채워 제목의 무게를 뺏었다.
//   · 시안의 좌우 관중석은 거의 검게 죽어 있다. 구현은 빨강·파랑 점이 강한 V자를 만들어
//     시선을 화면 가장자리로 끌었다.
//
// **전면 디밍으로 풀지 않는다.** App.css가 이미 반려한 방식이고(스크림의 목적은 화면을
// 어둡게 하기가 아니라 글자 자리의 대비 확보), 화면을 통째로 누르면 3D가 죽는다.
// 여기서 쓰는 수단은 전부 **국소적**이다 — 어느 광원이 어느 면을 밝히는지를 이용한다:
//
//   · 잔디는 위를 보는 큰 평면이라 반구광의 **아랫색**과 디렉셔널 키의 y성분을 거의 다
//     받는다. 관중은 **MeshBasicMaterial(무광)**이라 이 둘의 영향을 하나도 받지 않는다.
//     → 반구광 아랫색과 디렉셔널을 내리면 잔디만 내려간다.
//   · 관중은 자기 머티리얼 color(정점색과 곱해진다) 하나로 채도·명도가 같이 내려간다.
//   · 포그를 앞으로 당기면 **거리순으로** 어두워진다 — 원경 스탠드가 밤에 잠기고 근경은
//     남는다. 균일 디밍이 절대 만들지 못하는 깊이감이다.
import type * as THREE_NS from 'three'
import type { SceneBundle } from '../pitch/three/scene'

/**
 * 포그 시작/끝(m). 원본은 150~470으로 "원경 관중석만 살짝 잠기는" 값이다.
 * 랜딩은 카메라가 골대 뒤 132m에 서므로 반대편 스탠드가 200m 밖에 있다 —
 * 84~300이면 그 스탠드가 밤에 잠기고, 60~90m의 좌우 근경 스탠드는 실루엣으로 남는다.
 * 시안에서 좌우가 검게 죽어 있는 것이 이 효과다(지우는 것이 아니라 멀어지는 것이다).
 */
export const FOG_NEAR = 84
export const FOG_FAR = 300

/**
 * 관중 머티리얼 color 배율. 관중 인스턴스는 정점색 × 머티리얼 color로 그려지므로
 * 이 한 값이 25,000석 전체의 명도·채도를 같이 내린다.
 * 0.5 — 좌우 V자가 시선을 뺏지 않으면서 좌석 색이 남아 "사람이 앉아 있다"는 정보는 유지된다.
 * 0.3까지 내려 보면 관중석이 그냥 검은 벽이 되어 3D의 증거가 사라진다.
 */
export const CROWD_DIM = 0.44

/**
 * 피치·러너프 머티리얼 color 배율(맵과 곱해진다). 조도만으로 내리면 mowing 줄무늬의
 * 명암 차까지 같이 눌려 잔디가 단색 판이 된다 — 재질에서 한 번 더 내려 줄무늬는 남긴다.
 */
export const GRASS_DIM = 0.66

/**
 * 조명탑 **확산 halo**(78m 스프라이트) 배율. 코어(26m)는 건드리지 않는다.
 *
 * 왜 이것만 따로: 위 네 배율은 전부 조명·재질에 걸리는데 발광체는 toneMapped:false라
 * 하나도 영향을 받지 않는다 → 잔디·관중을 내린 만큼 halo가 **상대적으로** 세졌다.
 * 실측이 그대로 잡았다: 제목 1행 대비가 6.18 → 3.34로 떨어졌다(기준 3, 통과이긴 하다).
 * 카메라를 위로 틀면서 먼 조명탑 2기가 제목 높이로 내려온 탓이다.
 * 코어를 남기고 확산만 줄이면 "조명탑이 켜져 있다"는 정보는 그대로고 제목 뒤의
 * 넓고 흐린 밝은 면만 사라진다 — 시안의 조명탑도 코어는 희고 halo는 짧다.
 */
export const HALO_DIM = 0.42
/** 확산/코어 스프라이트를 가르는 크기(m). exterior.ts는 78과 26 둘만 만든다. */
const HALO_WIDE_MIN = 40

/** 디렉셔널(키·필) 배율. 잔디처럼 위를 보는 면에 집중적으로 걸린다. */
export const DIRECTIONAL_DIM = 0.6
/** 반구광 **아랫색**(잔디 반사색) 배율. 윗색(하늘빛)은 건드리지 않는다. */
export const HEMI_GROUND_DIM = 0.38
/** 앰비언트 배율 — 전면 균일 성분이라 살짝만 내린다(여기를 세게 내리면 곧 전면 디밍이다). */
export const AMBIENT_DIM = 0.82

/** 머티리얼(또는 배열)의 color를 배율만큼 내린다. */
function dimMaterial(mat: THREE_NS.Material | THREE_NS.Material[] | null, k: number): void {
  if (!mat) return
  for (const m of Array.isArray(mat) ? mat : [mat]) {
    const c = (m as { color?: THREE_NS.Color }).color
    if (c) c.multiplyScalar(k)
  }
}

/**
 * 랜딩 배경의 명암 배분을 시안에 맞춘다. **buildScene 직후·첫 렌더 전에 한 번만** 부른다
 * (머티리얼 color를 제자리에서 곱하므로 두 번 부르면 두 번 어두워진다).
 */
export function tuneLandingBackdrop(bundle: SceneBundle): void {
  // ── ① 대기: 포그를 앞으로 당겨 거리순으로 밤에 잠기게 한다 ──
  const fog = bundle.scene.fog as THREE_NS.Fog | null
  if (fog && typeof fog.near === 'number') {
    fog.near = FOG_NEAR
    fog.far = FOG_FAR
  }

  // ── ② 조도: 잔디를 때리는 성분만 골라 내린다 ──────────────
  // 관중은 무광 머티리얼이라 이 루프의 영향을 받지 않는다(그래서 ③이 따로 있다).
  for (const o of bundle.scene.children) {
    const l = o as THREE_NS.Light & { groundColor?: THREE_NS.Color }
    if (l.type === 'DirectionalLight') l.intensity *= DIRECTIONAL_DIM
    else if (l.type === 'AmbientLight') l.intensity *= AMBIENT_DIM
    else if (l.type === 'HemisphereLight' && l.groundColor) l.groundColor.multiplyScalar(HEMI_GROUND_DIM)
  }

  // ── ③ 관중: 머티리얼 color 한 값으로 전체 명도·채도를 내린다 ──
  dimMaterial(bundle.crowd?.material ?? null, CROWD_DIM)
  // 관중 뒤에 깔린 좌석 스킨(색 텍스처 평면)도 같은 배율로 — 이걸 빼면 인스턴스만 어두워져
  // 텍스처 속 좌석 색만 밝게 둥둥 뜬다.
  // 식별: scene.ts의 좌석 스킨은 씬에서 **유일하게** 뒤로 눕혀 세운 평면이다
  // (`skin.rotation.x = -Math.PI/2 - RAKE`, RAKE=0.5). 광고보드·리본은 전부 직립이다.
  // scene.ts가 name을 주지 않으므로 이 서명으로 찾는다 — 값이 바뀌면 여기가 조용히
  // 빗나가므로 tuneLandingBackdrop의 회귀 테스트가 스킨 적중 수를 함께 센다.
  const SKIN_ROT_X = -Math.PI / 2 - 0.5
  bundle.stadiumGroup.traverse((o) => {
    const m = o as THREE_NS.Mesh
    if (m.isMesh && Math.abs(m.rotation.x - SKIN_ROT_X) < 1e-6) dimMaterial(m.material, CROWD_DIM)
    // ── ③′ 조명탑 확산 halo만 줄인다(코어는 그대로) ──
    const sp = o as THREE_NS.Sprite
    if (sp.isSprite && sp.scale.x >= HALO_WIDE_MIN) dimMaterial(sp.material, HALO_DIM)
  })

  // ── ④ 잔디 재질: 줄무늬를 남긴 채 한 단계 더 내린다 ─────────
  bundle.pitchGroup.traverse((o) => {
    const m = o as THREE_NS.Mesh
    if (!m.isMesh) return
    const mats = Array.isArray(m.material) ? m.material : [m.material]
    // Lambert만 고른다 — 광고보드·골네트의 Basic 머티리얼은 발광 배율이 걸려 있어
    // 여기서 같이 곱하면 setEmissiveBoost가 되돌릴 때 어긋난다.
    if (mats.some((x) => x?.type === 'MeshLambertMaterial')) dimMaterial(m.material, GRASS_DIM)
  })
}
