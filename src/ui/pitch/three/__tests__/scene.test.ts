// buildScene은 three를 주입받는다. 테스트에서는 실제 three(WebGL 없이 동작하는 씬 그래프
// 부분만)를 주입해 구조·결정론·해제를 검증한다. 프로덕션 모듈은 three를 정적 import하지
// 않으므로 코드 스플릿은 유지된다.
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { buildScene, makeContactShadow, MAX_CROWD_INSTANCES } from '../scene'
import { NET_BACK_H, VISUAL_POST_R } from '../props'
import { AD_PANEL_ASPECT, AD_TEXTS, GOAL_H, GOAL_W, POST_R } from '../textures'
import { PITCH_W, PITCH_H } from '../types'

function build(opts = {}) {
  return buildScene(THREE, { crowdCount: 800, pxPerMeter: 2, ...opts })
}

// ── canvas 2D 스텁 ────────────────────────────────────────────────
// vitest 기본 환경(node)에는 document가 없어 textures.makeCanvas가 항상 null을 돌려준다
// → buildScene이 단색 폴백만 타고 CanvasTexture 경로(clone·repeat·dispose)가 전혀 실행되지 않는다.
// 아래 스텁은 no-op 2D 컨텍스트를 심어 그 경로를 강제 실행시킨다(픽셀 결과는 검증 대상 아님).
function makeCtxStub(): CanvasRenderingContext2D {
  const noop = (): void => {}
  const gradient = { addColorStop: noop }
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillRect: noop,
    clearRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
    save: noop,
    restore: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    putImageData: noop,
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    createPattern: () => ({}),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  }
  return ctx as unknown as CanvasRenderingContext2D
}

/** globalThis.document를 캔버스 스텁으로 교체하고 복원 함수를 돌려준다(전역 오염 금지). */
function installCanvasStub(): () => void {
  const g = globalThis as { document?: unknown }
  const had = 'document' in g
  const prev = g.document
  g.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') return {}
      return {
        width: 1,
        height: 1,
        getContext: (kind: string) => (kind === '2d' ? makeCtxStub() : null),
      }
    },
  }
  return () => {
    if (had) g.document = prev
    else delete g.document
  }
}

/** 씬 트리의 머티리얼이 참조하는 모든 텍스처를 수집한다(disposeTree와 같은 규칙). */
function collectTextures(root: THREE.Object3D): Set<THREE.Texture> {
  const found = new Set<THREE.Texture>()
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material
    if (!mat) return
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      const rec = m as unknown as Record<string, unknown>
      for (const key of Object.keys(rec)) {
        const v = rec[key] as THREE.Texture | null
        if (v && typeof v === 'object' && v.isTexture) found.add(v)
      }
    }
  })
  return found
}

describe('buildScene 구조', () => {
  it('scene·camera·그룹을 돌려주고 카메라가 피치를 담는다', () => {
    const b = build()
    expect(b.scene.isScene).toBe(true)
    expect(b.camera.isPerspectiveCamera).toBe(true)
    expect(b.camera.far).toBeGreaterThan(300)
    expect(b.scene.children).toContain(b.pitchGroup)
    expect(b.scene.children).toContain(b.stadiumGroup)
    b.dispose()
  })

  // 회귀(F1): 카메라가 씬 밖에 있으면 WebGLRenderer.render()의 projectObject(scene, …)가
  // 카메라 서브트리를 훑지 않아 카메라 자식(fx3d.flashQuad의 골 섬광 쿼드)이 화면에 절대
  // 나타나지 않는다. MatchScreen이 DOM 풀스크린 플래시를 제거한 뒤로는 유일한 섬광 경로다.
  it('카메라가 씬의 자식이다(카메라에 붙는 FX가 렌더 대상에 포함되도록)', () => {
    const b = build()
    expect(b.camera.parent).toBe(b.scene)
    expect(b.scene.children).toContain(b.camera)
    // 씬 루트가 단위행렬이라 카메라 월드 변환은 편입 전과 동일하다.
    b.scene.updateMatrixWorld(true)
    expect(b.camera.matrixWorld.equals(b.camera.matrix)).toBe(true)
    b.dispose()
  })

  it('피치 평면이 105×68이며 XZ에 눕는다', () => {
    const b = build()
    const geo = b.pitchMesh.geometry as THREE.PlaneGeometry
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    expect(box.max.x - box.min.x).toBeCloseTo(PITCH_W, 4)
    expect(box.max.z - box.min.z).toBeCloseTo(PITCH_H, 4)
    expect(box.max.y - box.min.y).toBeCloseTo(0, 4)
    b.dispose()
  })

  it('골대 2개가 양 골라인에 서고 프레임·사다리꼴 네트 규격이 맞다', () => {
    const b = build()
    const goals = b.pitchGroup.children.filter((o) => o.name.startsWith('goal-'))
    expect(goals.length).toBe(2)
    for (const g of goals) {
      const posts = g.children.filter(
        (c) => (c as THREE.Mesh).geometry?.type === 'CylinderGeometry',
      ) as THREE.Mesh[]
      // 포스트 2 + 크로스바 1 + 뒤쪽 가로바 2 + 뒤쪽 세로기둥 2 + 사선 스테이 2 = 9
      expect(posts.length).toBe(9)
      // 앞쪽 포스트 2개는 골라인 위, 폭은 GOAL_W, 크로스바는 GOAL_H 높이.
      const front = posts.filter((p) => Math.abs(Math.abs(p.position.x) - PITCH_W / 2) < 1e-6)
      expect(front.length).toBe(3) // 포스트 2 + 크로스바 1
      const uprights = front.filter((p) => p.position.y < GOAL_H - 1e-6)
      expect(uprights.length).toBe(2)
      const zs = uprights.map((p) => p.position.z).sort((a, z) => a - z)
      expect(zs[1] - zs[0]).toBeCloseTo(GOAL_W, 4)
      const bar = front.find((p) => Math.abs(p.position.y - GOAL_H) < 1e-6)!
      expect(bar.position.y).toBeCloseTo(GOAL_H, 4)
      // 시각용 반지름은 규격 상한(12cm) 아래이고 물리 정본 POST_R보다는 굵다.
      const cyl = uprights[0].geometry as THREE.CylinderGeometry
      expect(cyl.parameters.radiusTop).toBe(VISUAL_POST_R)
      expect(VISUAL_POST_R).toBeGreaterThan(POST_R)
      expect(VISUAL_POST_R).toBeLessThanOrEqual(0.12)
      // 네트 패널 4장(측면 2 + 천장 + 뒷면). 사다리꼴이라 PlaneGeometry가 아니다.
      const nets = g.children.filter((c) => {
        const geo = (c as THREE.Mesh).geometry
        return geo?.type === 'BufferGeometry'
      })
      expect(nets.length).toBe(4)
      // 뒤쪽 상단 바가 크로스바보다 낮아야 측면 네트가 사다리꼴이 된다.
      expect(NET_BACK_H).toBeLessThan(GOAL_H)
    }
    b.dispose()
  })

  it('코너 플래그 4개가 피치 네 모서리에 선다', () => {
    const b = build()
    const flags = b.pitchGroup.children.find((o) => o.name === 'corner-flags')
    expect(flags).toBeDefined()
    expect(flags!.children.length).toBe(4)
    const seen = new Set<string>()
    for (const f of flags!.children) {
      expect(Math.abs(f.position.x)).toBeCloseTo(PITCH_W / 2, 4)
      expect(Math.abs(f.position.z)).toBeCloseTo(PITCH_H / 2, 4)
      seen.add(`${Math.sign(f.position.x)},${Math.sign(f.position.z)}`)
    }
    expect(seen.size).toBe(4)
    b.dispose()
  })

  it('조명은 존재하되 실시간 그림자는 전부 꺼져 있다', () => {
    const b = build()
    const lights: THREE.Light[] = []
    b.scene.traverse((o) => {
      if ((o as THREE.Light).isLight) lights.push(o as THREE.Light)
    })
    expect(lights.length).toBeGreaterThanOrEqual(3)
    expect(lights.some((l) => (l as THREE.HemisphereLight).isHemisphereLight)).toBe(true)
    expect(lights.some((l) => (l as THREE.DirectionalLight).isDirectionalLight)).toBe(true)
    for (const l of lights) expect(l.castShadow).toBe(false)
    b.scene.traverse((o) => {
      expect(o.castShadow).toBe(false)
      expect(o.receiveShadow).toBe(false)
    })
    b.dispose()
  })
})

describe('관중 InstancedMesh', () => {
  // 좌석 격자는 현실 피치(0.62m × 0.9m)로 **고정**이라 crowdCount는 더 이상 인원이
  // 아니다(scene.BuildSceneOptions·crowd.ts 헤더 참조). 0 이하면 없음, 그 외는 정원.
  it('정원까지 채우고 관중석 위에 앉는다', () => {
    const b = build({ crowdCount: 4000 })
    expect(b.crowd).not.toBeNull()
    expect(b.crowdCount).toBe(MAX_CROWD_INSTANCES)
    expect(b.crowd!.count).toBe(b.crowdCount)

    const m = new THREE.Matrix4()
    const p = new THREE.Vector3()
    let insidePitch = 0
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < b.crowdCount; i++) {
      b.crowd!.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)
      // 관중은 피치 위(플레이 영역)에 있으면 안 된다.
      if (Math.abs(p.x) < PITCH_W / 2 && Math.abs(p.z) < PITCH_H / 2) insidePitch++
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    expect(insidePitch).toBe(0)
    expect(minY).toBeGreaterThan(2) // 첫 열도 피치보다 높다
    expect(maxY).toBeGreaterThan(12) // 경사가 실제로 올라간다
    b.dispose()
  })

  it('crowdDetail로 인스턴스 수를 줄일 수 있다', () => {
    const lo = build({ crowdDetail: 0.5 })
    expect(lo.crowdCount).toBeLessThan(MAX_CROWD_INSTANCES / 2)
    expect(lo.crowdCount).toBeGreaterThan(1000)
    lo.dispose()
    // 하한(0.35) 아래 요청은 클램프된다.
    const clamped = build({ crowdDetail: 0.01 })
    const atFloor = build({ crowdDetail: 0.35 })
    expect(clamped.crowdCount).toBe(atFloor.crowdCount)
    clamped.dispose()
    atFloor.dispose()
  })

  it('레퍼런스 팔레트대로 어두운 질량이 지배한다', () => {
    const b = build({ homeColor: 0xff0000, awayColor: 0x0000ff })
    const ic = b.crowd!.instanceColor
    expect(ic).not.toBeNull()
    const arr = ic!.array
    const seen = new Set<string>()
    let dark = 0
    for (let i = 0; i < b.crowdCount; i++) {
      const r = arr[i * 3]
      const g = arr[i * 3 + 1]
      const bl = arr[i * 3 + 2]
      for (const v of [r, g, bl]) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
      // 어두운 질량 판정: 세 채널 모두 선형 0.25 미만. CROWD_DARK에서 가장 밝은
      // #45527a도 명도 지터 상한(1.24)까지 곱해 선형 0.24에 머물고, 팀색·액센트는
      // 가장 어두운 조합에서도 0.25를 넘는다.
      if (r < 0.25 && g < 0.25 && bl < 0.25) dark++
      seen.add(`${r.toFixed(2)},${g.toFixed(2)},${bl.toFixed(2)}`)
    }
    // docs/refs/README: "약 70%의 어두운 질량". 60% 아래로 떨어지면 예전처럼
    // 화면이 원색 블록으로 뒤덮인다 — 그 회귀를 막는 가드다.
    expect(dark / b.crowdCount).toBeGreaterThan(0.6)
    // 단색이 아니라 충분히 변주된다.
    expect(seen.size).toBeGreaterThan(50)
    b.dispose()
  })

  it('crowdCount 0이면 관중을 만들지 않는다', () => {
    const b = build({ crowdCount: 0 })
    expect(b.crowd).toBeNull()
    expect(b.crowdCount).toBe(0)
    expect(() => b.crowdWave(1.2, 1)).not.toThrow()
    b.dispose()
  })

  it('두 번 빌드하면 완전히 동일하다(Math.random·Date 미사용)', () => {
    const a = build()
    const c = build()
    expect(a.crowdCount).toBe(c.crowdCount)
    expect(Array.from(a.crowd!.instanceMatrix.array)).toEqual(
      Array.from(c.crowd!.instanceMatrix.array),
    )
    expect(Array.from(a.crowd!.instanceColor!.array)).toEqual(
      Array.from(c.crowd!.instanceColor!.array),
    )
    a.dispose()
    c.dispose()
  })

  it('파도타기용 인스턴스 속성 aWave가 붙어 있다', () => {
    const b = build()
    const attr = b.crowd!.geometry.getAttribute('aWave')
    expect(attr).toBeDefined()
    expect(attr.itemSize).toBe(2)
    expect(attr.count).toBe(b.crowdCount)
    // 위상은 0~2π, 방위각은 0~2π 범위여야 한다.
    for (let i = 0; i < b.crowdCount; i += 97) {
      expect(attr.getX(i)).toBeGreaterThanOrEqual(0)
      expect(attr.getX(i)).toBeLessThanOrEqual(Math.PI * 2)
      expect(attr.getY(i)).toBeGreaterThanOrEqual(0)
      expect(attr.getY(i)).toBeLessThanOrEqual(Math.PI * 2 + 1e-6)
    }
    b.dispose()
  })
})

describe('crowdWave', () => {
  // 변위는 이제 **정점 셰이더**가 만든다(crowd.ts WAVE_PROJECT). node 테스트에는 WebGL이
  // 없어 셰이더가 컴파일되지 않으므로, 검증 대상은 셰이더에 물린 유니폼 값이다.
  const uniformsOf = (b: ReturnType<typeof build>) =>
    (b.crowd as unknown as { material: { userData?: unknown } }) &&
    (b.crowd!.userData as { waveUniforms?: { uCrowdTime: { value: number }; uCrowdIntensity: { value: number } } })
      .waveUniforms!

  it('t와 intensity를 유니폼에 그대로 싣고 intensity를 0~1로 클램프한다', () => {
    const b = build()
    const u = uniformsOf(b)
    b.crowdWave(3.7, 1)
    expect(u.uCrowdTime.value).toBe(3.7)
    expect(u.uCrowdIntensity.value).toBe(1)
    b.crowdWave(9.1, 0)
    expect(u.uCrowdTime.value).toBe(9.1)
    expect(u.uCrowdIntensity.value).toBe(0)
    b.crowdWave(0, 5)
    expect(u.uCrowdIntensity.value).toBe(1)
    b.crowdWave(0, -3)
    expect(u.uCrowdIntensity.value).toBe(0)
    b.dispose()
  })

  it('인스턴스 행렬을 건드리지 않는다(프레임마다 GPU 재업로드 없음)', () => {
    const b = build()
    const arr = b.crowd!.instanceMatrix.array
    const before = Array.from(arr)
    const v0 = b.crowd!.instanceMatrix.version
    b.crowdWave(3.7, 1)
    expect(Array.from(arr)).toEqual(before)
    // 예전 구현은 여기서 version이 올랐다(수백 KB/프레임 업로드). 이제 오르면 안 된다.
    expect(b.crowd!.instanceMatrix.version).toBe(v0)
    b.dispose()
  })
})

describe('dispose', () => {
  it('모든 geometry·material·texture를 해제한다', () => {
    const b = build({ crowdCount: 500 })
    const geos = new Set<THREE.BufferGeometry>()
    const mats = new Set<THREE.Material>()
    b.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) geos.add(m.geometry)
      if (m.material) {
        for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mats.add(mm)
      }
    })
    expect(geos.size).toBeGreaterThan(5)
    expect(mats.size).toBeGreaterThan(5)

    let disposed = 0
    const expected = geos.size + mats.size
    for (const g of geos) g.addEventListener('dispose', () => disposed++)
    for (const m of mats) m.addEventListener('dispose', () => disposed++)

    b.dispose()
    expect(disposed).toBe(expected)
    expect(b.scene.children.length).toBe(0)
  })

  it('dispose 후 crowdWave 호출이 안전하다', () => {
    const b = build({ crowdCount: 500 })
    b.dispose()
    expect(() => b.crowdWave(2, 1)).not.toThrow()
  })

  it('InstancedMesh.dispose를 호출해 instanceMatrix/instanceColor GPU 버퍼를 해제한다', () => {
    const b = build({ crowdCount: 500 })
    const crowd = b.crowd
    expect(crowd).not.toBeNull()
    // WebGLObjects.onInstancedMeshDispose는 이 'dispose' 이벤트로만 버퍼를 remove하고 VAO를 release한다.
    // (attributes가 WeakMap이라 GC로는 gl.deleteBuffer가 절대 호출되지 않는다)
    let fired = 0
    crowd!.addEventListener('dispose', () => fired++)
    const spy = vi.spyOn(crowd!, 'dispose')

    b.dispose()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(fired).toBe(1)
    spy.mockRestore()
  })

  it('dispose 후 bundle.crowd가 null이라 해제된 메시를 붙들지 않는다', () => {
    const b = build({ crowdCount: 400 })
    expect(b.crowd).not.toBeNull()
    b.dispose()
    expect(b.crowd).toBeNull()
  })

  it('canvas 2D가 있으면 텍스처 경로를 타고 dispose가 전부 해제한다', () => {
    const restore = installCanvasStub()
    try {
      const b = build({ crowdCount: 300 })
      const texes = collectTextures(b.scene)
      // 피치 · 네트 4패널×2골 · 깃발 · 콘크리트 · 펜스 · 광고보드 2 · 관중 스킨 4 ·
      // 하늘 · 스카이라인 · 지붕 · 파사드 4 · halo · 빛기둥. 정확한 개수를 박아 두면
      // 외부 요소를 하나 추가할 때마다 무의미하게 깨지므로 하한만 건다.
      expect(texes.size).toBeGreaterThan(15)

      const byRepeat = [...texes].map((t) => `${t.repeat.x.toFixed(3)}x${t.repeat.y.toFixed(3)}`)
      // 네트: 뒷면 패널은 GOAL_W × NET_BACK_H를 NET_CELL(0.16m) 칸으로 나눈다.
      expect(byRepeat).toContain(`${(GOAL_W / 0.16).toFixed(3)}x${(NET_BACK_H / 0.16).toFixed(3)}`)
      // 광고보드: 롱사이드(100m)와 엔드(62m)가 **같은 패널 실폭**을 갖도록 repeat이 다르다.
      const adRepeat = (len: number) => (len / (1.05 * AD_PANEL_ASPECT * AD_TEXTS.length)).toFixed(3)
      expect(byRepeat).toContain(`${adRepeat(100)}x1.000`)
      expect(byRepeat).toContain(`${adRepeat(62)}x1.000`)

      // 텍스처 하나가 여러 머티리얼에 물릴 수 있으므로(halo 스프라이트 8장이 같은
      // glow 텍스처를 공유) dispose 호출 횟수가 아니라 **해제된 텍스처 집합**을 센다.
      // three의 dispose()는 이벤트 디스패치일 뿐이라 중복 호출은 무해하다.
      const disposed = new Set<THREE.Texture>()
      for (const t of texes) t.addEventListener('dispose', () => disposed.add(t))
      b.dispose()
      expect(disposed.size).toBe(texes.size)
      // 폴백이 아니라 실제 map이 붙었는지(= 텍스처 경로였는지) 재확인
      expect(texes.size).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })

  it('캔버스 스텁은 테스트 밖으로 새지 않는다', () => {
    const b = build({ crowdCount: 100 })
    expect(collectTextures(b.scene).size).toBe(0)
    b.dispose()
  })
})

describe('좌석 정원', () => {
  it('MAX_CROWD_INSTANCES가 현실 좌석 피치에서 나온 값이다', () => {
    // 4면 × (길이 / 0.62m) × floor(26m / 0.9m = 28열). 예전 값 7,440은 좌석 간격을
    // 인원에서 역산하던 시절의 산물이고, 그때 인스턴스 하나가 2m 색 큐브였다.
    expect(MAX_CROWD_INSTANCES).toBe(25200)
    const b = build({ crowdCount: 12000 })
    expect(b.crowdCount).toBe(MAX_CROWD_INSTANCES)
    expect(b.crowd!.count).toBe(MAX_CROWD_INSTANCES)
    b.dispose()
  })
})

describe('makeContactShadow', () => {
  it('XZ 평면에 눕는 반투명 원판', () => {
    const mesh = makeContactShadow(THREE, 0.6)
    const geo = mesh.geometry
    geo.computeBoundingBox()
    const box = geo.boundingBox!
    expect(box.max.y - box.min.y).toBeCloseTo(0, 5)
    expect(box.max.x - box.min.x).toBeCloseTo(1.2, 3)
    expect(box.max.z - box.min.z).toBeCloseTo(1.2, 3)
    const mat = mesh.material as THREE.MeshBasicMaterial
    expect(mat.transparent).toBe(true)
    expect(mat.depthWrite).toBe(false)
    expect(mat.opacity).toBeGreaterThan(0)
    expect(mat.opacity).toBeLessThan(1)
    mesh.geometry.dispose()
    mat.dispose()
  })

  // 감쇠가 **정점 알파**로 구워져 있다는 것이 이 그림자의 핵심 계약이다. 텍스처 알파
  // 경로(map·alphaMap)는 실제 렌더에서 화면에 아무것도 남기지 않아 그림자가 통째로
  // 사라졌었다 — 그 회귀를 여기서 막는다.
  it('정점 색은 검정이고 알파는 중심에서 가장자리로 단조 감소해 0에서 끝난다', () => {
    const mesh = makeContactShadow(THREE, 0.6)
    const mat = mesh.material as THREE.MeshBasicMaterial
    expect(mat.vertexColors).toBe(true)
    const col = mesh.geometry.getAttribute('color')
    expect(col.itemSize).toBe(4) // RGBA — 알파가 없으면 감쇠가 사라진다
    const pos = mesh.geometry.getAttribute('position')
    let centreAlpha = 0
    let rimAlpha = 1
    for (let i = 0; i < col.count; i++) {
      expect(col.getX(i)).toBe(0)
      expect(col.getY(i)).toBe(0)
      expect(col.getZ(i)).toBe(0)
      const r = Math.hypot(pos.getX(i), pos.getZ(i))
      if (r < 1e-6) centreAlpha = col.getW(i)
      if (r > 0.6 - 1e-6) rimAlpha = Math.max(rimAlpha === 1 ? 0 : rimAlpha, col.getW(i))
    }
    expect(centreAlpha).toBeGreaterThan(0.8)
    expect(rimAlpha).toBeCloseTo(0, 6)
    mesh.geometry.dispose()
    mat.dispose()
  })
})
