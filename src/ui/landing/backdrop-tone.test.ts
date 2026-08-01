// src/ui/landing/backdrop-tone.test.ts
// 랜딩 전용 톤 보정 회귀.
//
// 이 모듈은 **남의 씬(scene.ts)의 내부 구조에 손을 넣는다**. name이 붙어 있지 않은
// 오브젝트를 회전각·스프라이트 크기 같은 서명으로 찾으므로, scene.ts/exterior.ts가
// 바뀌면 조용히 아무것도 안 하고 끝날 수 있다 — 화면은 그냥 예전 밝기로 돌아가고
// 아무도 눈치채지 못한다. 그래서 "몇 개를 실제로 맞혔는가"까지 센다.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { buildScene } from '../pitch/three/scene'
import {
  AMBIENT_DIM,
  CROWD_DIM,
  DIRECTIONAL_DIM,
  FOG_FAR,
  FOG_NEAR,
  GRASS_DIM,
  HALO_DIM,
  HEMI_GROUND_DIM,
  tuneLandingBackdrop,
} from './backdrop-tone'
import type { SceneBundle } from '../pitch/three/scene'

/** 색 성분 비(r 기준). 톤 매핑·색공간 변환이 끼어도 배율은 비로 남는다. */
function ratio(after: THREE.Color, before: THREE.Color): number {
  return before.r > 1e-6 ? after.r / before.r : after.g / before.g
}

describe('랜딩 배경 톤 보정 — 실제 씬', () => {
  const bundle = buildScene(THREE as never, { crowdCount: 800, pxPerMeter: 2 }) as unknown as SceneBundle

  const lights = bundle.scene.children.filter((o) => (o as THREE.Light).isLight) as THREE.Light[]
  const dirBefore = lights.filter((l) => l.type === 'DirectionalLight').map((l) => l.intensity)
  const ambBefore = lights.filter((l) => l.type === 'AmbientLight').map((l) => l.intensity)
  const hemi = lights.find((l) => l.type === 'HemisphereLight') as THREE.HemisphereLight
  const hemiSkyBefore = hemi.color.clone()
  const hemiGroundBefore = hemi.groundColor.clone()
  const crowdMat = bundle.crowd?.material as THREE.MeshBasicMaterial
  const crowdBefore = crowdMat.color.clone()
  const pitchMat = bundle.pitchMesh.material as THREE.MeshLambertMaterial
  const pitchBefore = pitchMat.color.clone()

  tuneLandingBackdrop(bundle)

  it('포그를 앞으로 당긴다 — 원경 스탠드가 거리순으로 밤에 잠긴다', () => {
    const fog = bundle.scene.fog as THREE.Fog
    expect(fog.near).toBe(FOG_NEAR)
    expect(fog.far).toBe(FOG_FAR)
    // 균일 디밍이 아니라는 것의 정의: 시작점이 카메라~피치 거리(약 126m) 안쪽에 있어야
    // 가까운 것과 먼 것이 갈린다.
    expect(fog.near).toBeLessThan(126)
  })

  it('잔디를 때리는 조명만 내린다 — 반구광 윗색(하늘빛)은 건드리지 않는다', () => {
    for (const [i, l] of lights.filter((x) => x.type === 'DirectionalLight').entries()) {
      expect(l.intensity).toBeCloseTo(dirBefore[i] * DIRECTIONAL_DIM, 10)
    }
    for (const [i, l] of lights.filter((x) => x.type === 'AmbientLight').entries()) {
      expect(l.intensity).toBeCloseTo(ambBefore[i] * AMBIENT_DIM, 10)
    }
    expect(ratio(hemi.groundColor, hemiGroundBefore)).toBeCloseTo(HEMI_GROUND_DIM, 10)
    // 윗색은 그대로 — 여기를 같이 내리면 밤하늘 반사까지 죽어 전면 디밍이 된다.
    expect(hemi.color.getHex()).toBe(hemiSkyBefore.getHex())
  })

  it('관중과 잔디는 각자 자기 머티리얼로 내려간다', () => {
    expect(ratio(crowdMat.color, crowdBefore)).toBeCloseTo(CROWD_DIM, 10)
    expect(ratio(pitchMat.color, pitchBefore)).toBeCloseTo(GRASS_DIM, 10)
  })

  it('전면 디밍이 아니다 — 잔디·관중을 각각 다른 배율로 내린다', () => {
    // 하나의 값으로 전부 곱하면(=스크림) 이 화면이 잃는 것은 깊이다. 세 배율이 서로 달라야
    // "무엇을 뒤로 보내고 무엇을 남길지"를 고른 것이다.
    expect(new Set([CROWD_DIM, GRASS_DIM, DIRECTIONAL_DIM, HEMI_GROUND_DIM, AMBIENT_DIM]).size).toBe(5)
    // 어느 것도 0.3 밑으로 내리지 않는다 — 그 아래는 "지운 것"이지 "멀리 보낸 것"이 아니다.
    for (const k of [CROWD_DIM, GRASS_DIM, DIRECTIONAL_DIM, HEMI_GROUND_DIM, AMBIENT_DIM, HALO_DIM]) {
      expect(k).toBeGreaterThan(0.3)
      expect(k).toBeLessThan(1)
    }
  })
})

describe('랜딩 배경 톤 보정 — 서명으로 찾는 대상', () => {
  /**
   * scene.ts는 좌석 스킨에도 exterior.ts는 halo 스프라이트에도 name을 주지 않는다.
   * 캔버스 없는 테스트 환경에서는 둘 다 아예 생성되지 않으므로(텍스처가 null),
   * 실제 씬 대신 **같은 서명을 가진 대역**을 세워 탐지 로직만 따로 검증한다.
   * 서명이 바뀌면 여기가 먼저 깨진다.
   */
  function stand(): SceneBundle {
    const stadium = new THREE.Group()
    // 좌석 스킨: 씬에서 유일하게 뒤로 눕혀 세운 평면(-π/2 - RAKE, RAKE=0.5).
    const skin = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    skin.rotation.x = -Math.PI / 2 - 0.5
    // 직립 광고보드 — 같은 Basic이지만 회전이 다르므로 건드리면 안 된다.
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }))
    const wide = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff }))
    wide.scale.set(78, 78, 1)
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff }))
    core.scale.set(26, 26, 1)
    stadium.add(skin, board, wide, core)
    return {
      scene: new THREE.Scene(),
      stadiumGroup: stadium,
      pitchGroup: new THREE.Group(),
      crowd: null,
      pitchMesh: new THREE.Mesh(),
    } as unknown as SceneBundle
  }

  it('좌석 스킨은 관중과 같은 배율로, 직립 광고보드는 그대로', () => {
    const b = stand()
    tuneLandingBackdrop(b)
    const [skin, board] = b.stadiumGroup.children as THREE.Mesh[]
    expect((skin.material as THREE.MeshBasicMaterial).color.r).toBeCloseTo(CROWD_DIM, 10)
    expect((board.material as THREE.MeshBasicMaterial).color.r).toBeCloseTo(1, 10)
  })

  it('조명탑은 확산 halo만 줄이고 코어는 남긴다 — 켜져 있다는 정보를 지우지 않는다', () => {
    const b = stand()
    tuneLandingBackdrop(b)
    const [, , wide, core] = b.stadiumGroup.children as THREE.Sprite[]
    expect(wide.material.color.r).toBeCloseTo(HALO_DIM, 10)
    expect(core.material.color.r).toBeCloseTo(1, 10)
  })
})
