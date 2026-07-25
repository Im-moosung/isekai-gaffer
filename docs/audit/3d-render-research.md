# 3D 렌더 품질 리서치 (잔디·데칼·방송 카메라·리플레이)

> 조사일 2026-07-25 · three.js r185 소스 직접 검증 기반. 미검증 항목은 🚩로 표기.

## 결론 요약 (임팩트 대비 비용)

| # | 항목 | 절 | 비용 | 임팩트 |
|---|---|---|---|---|
| 1 | 메인 카메라 fov 22° @ 55m + 거리 연동 fov | B1 | S(1h) | ★★★★★ |
| 2 | 잔디 mow 스트라이프 + 마모 텍스처(단일 플레인) | A3 | S(½d) | ★★★★★ |
| 3 | **시점 의존 스트라이프 대비** | A3.5 | S(2h) | ★★★★☆ |
| 4 | Simplex 핸드헬드 지터(fov 비례) | B2 | S(2h) | ★★★★☆ |
| 5 | 트라우마 셰이크(골·태클) | B3 | S(2h) | ★★★★☆ |
| 6 | 라인 마킹 해석적 렌더(셰이더) | A3.7 | M(½d) | ★★★★☆ |
| 7 | 리플레이 링버퍼 + 슬로모 | B5 | M(1d) | ★★★★★ |
| 8 | 샷 디렉터 + 180도 규칙 + 컷 편집 | B4 | M(1~2d) | ★★★★★ |
| 9 | 이방성 반사 + sheen + 디테일 노멀 | A3.4/A3.6 | S~M | ★★★☆☆ |
| 10 | 렌더타깃 마모 스플랫(경기 중 잔디 파임) | A4.3 | M(1d) | ★★★☆☆ |
| ✗ | 전면 블레이드 잔디 | A1 | L | 물리적으로 불가 |

---

## A. 잔디

### A0. 전면 블레이드 잔디는 하지 마라 (수치 근거)
피치 7,140m². 축구장은 20~30mm로 깎여 있어 **300 blades/m² 이상**이어야 잔디로 읽히는데(그 이하는 잡초처럼 보임 — 기존 three 데모들이 0.75~1.5m 긴 풀을 쓰는 이유), 그러면 214만 blade = **860만 verts**. 노트북 iGPU 여유는 60fps에서 25~60만 verts. **15~30배 초과**. 게다가 방송 카메라 거리에서 blade는 서브픽셀이라 비용만 내고 shimmer만 얻는다.

### A1. 참고 구현 (구조만 훔칠 것)
**SimonDev `Quick_Grass`** (MIT, three 0.156, 2023-11): https://github.com/simondevyoutube/Quick_Grass
- 실제 상수: 패치당 3072 blade / 패치 10m(=30.7/m²) / LOD 1~6 세그먼트 / LOD 전환 15m / 컬 100m
- **핵심**: `InstancedMesh`가 아니라 `InstancedBufferGeometry` + per-instance half-float 오프셋(6바이트/blade). blade 형태 전체를 `uint8` vertIndex 하나로 버텍스 셰이더에서 재구성. InstancedMesh 대비 메모리 ~10배 절약
- 거리 페이드는 컬링이 아니라 **높이를 0으로 붕괴**시켜 래스터라이저가 공짜로 버리게 함
- 바람 3층: 방향 noise(주파수 0.05·시간 0.05) / 세기(0.25·1.0) / blade 지터(137·0.35)
- **훔칠 만한 AA 트릭 2개**: ① 시야각 기반 두께 보정(edge-on shimmer 제거) ② 원거리 노멀을 UP으로 블렌드(far field boiling 제거)

기타: `FluffyGrass`(MIT, 빌보드 클럼프 방식, 16×16 청크, 1M 인스턴스 주장) https://github.com/thebenezer/FluffyGrass · Ghost of Tsushima GDC 2021이 원조 기법
🚩 검색해도 없던 것: "grass by spite", "Eddie Bourgeois grass", Outerra 잔디 글 — 존재하지 않는 것으로 보임

### A2. 권장안 — 단일 플레인 절차 잔디 (1 draw call)

**A3.1 지오메트리**: `PlaneGeometry(105, 68, 32, 32)` X축 -90°. 32×32는 캠버(2~5cm 볼록) 표현용, 비용 0.

**A3.2 mow 스트라이프 (canvas 2048×1326 ≈ 19.5px/m)**
```js
g.fillStyle = '#3f7a34'; g.fillRect(0,0,W,H);           // 베이스(약간 채도 낮춘 녹색)
const BANDS = 8, bandPx = H/BANDS;                       // 실제 경기장 5~9m 밴드
for (let i=0;i<BANDS;i++){ g.fillStyle = i%2 ? 'rgba(255,255,255,.055)' : 'rgba(0,0,0,.055)';
  g.fillRect(0, i*bandPx, W, bandPx); }
// 밴드 경계 ±3px 페더(실제 모어 라인은 ~10cm 부드러움) — ctx.filter='blur(2px)' 한 번
// 대형 색 변주: 소프트 radial blob 40개, r120~400px, alpha .02~.05
map.colorSpace = THREE.SRGBColorSpace;
map.anisotropy = renderer.capabilities.getMaxAnisotropy();
```

**A3.3 마모(골문 앞·센터서클)**: 6야드 박스 중심 18×8m 타원, radial gradient `rgba(150,130,95,.35)`→0. **깔끔한 타원은 즉시 가짜로 보이므로** 지터된 작은 원 60개를 겹쳐 그릴 것. 256×256 노이즈 타일을 `createPattern`+multiply로 그레인 부여.
같은 마스크로 **roughness도 구동** — three는 `aoMap`=R채널, `roughnessMap`=G채널을 읽으므로 `[AO, roughness, wear]`를 RGB 한 장에 패킹하면 텍스처 1장으로 2슬롯(검증: `aomap_fragment.glsl.js`, `roughnessmap_fragment.glsl.js` 주석). r185에서 `aoMap`은 `Texture.channel` 기본 0(=uv)이라 uv1 불필요.

**A3.4 이방성 반사 — r185 검증 완료**
`MeshPhysicalMaterial.anisotropy`는 **r153에서 추가**(PR #25580, glTF KHR_materials_anisotropy), WebGL 완전 지원(`WebGLProgram.js:504-505,703-704`).
- `.anisotropy` (`MeshPhysicalMaterial.js:370-384`) 0~1. **setter가 0을 넘나들 때 셰이더 재컴파일 → 0을 통과하며 애니메이션 금지**
- `.anisotropyRotation` 기본 **0** (🚩 threejs.org 문서는 `1`이라고 적혀 있음 — **문서 버그**, 소스가 정답)
- `computeTangents()` **불필요** — `normal_fragment_begin.glsl.js:22-40`이 vUv로 화면공간 미분 TBN을 유도. 단 `normalMap`을 추가하면 탄젠트 프레임이 `vNormalMapUv`로 바뀌므로 노멀맵을 UV0에 스트라이프와 같은 방향으로 둘 것
```js
new THREE.MeshPhysicalMaterial({ map, roughnessMap: orm, aoMap: orm,
  roughness:.85, metalness:0, anisotropy:.55, anisotropyRotation:0,
  sheen:.25, sheenRoughness:.9, sheenColor:new THREE.Color(0x9fd06a) })
```
⚠️ Physical+anisotropy+sheen은 Standard 대비 **픽셀당 1.5~2.5배**. 이 플레인이 화면 60~100%를 덮으므로 iGPU 1080p에서 0.5~1.5ms. **품질 티어 토글로** (저사양은 MeshStandard).

**A3.5 ★ 시점 의존 스트라이프 대비 (가장 값싼 고임팩트)**
실제 mow 스트라이프는 페인트가 아니라 **blade가 눕는 방향** — 나를 향해 누운 밴드는 밝고 반대는 어둡다. 그래서 **카메라가 반대편으로 가면 명암이 뒤집히고, 스트라이프와 나란히 보면 사라진다.** 구운 텍스처는 이걸 못 해서 움직이는 카메라에서 "게임 티"가 난다. `onBeforeCompile`(r185 `Material.js:532` 정상 API, `customProgramCacheKey`는 `:543`)로 픽셀당 dot 하나면 끝:
```glsl
float band = floor((vWorldPos.z + 34.0) / (68.0/uStripeCount));
float sgn  = mod(band,2.0)*2.0-1.0;
float align= dot(normalize(vec2(vdir.x, vdir.z)), uStripeDir);
diffuseColor.rgb *= 1.0 + uStripeGain * sgn * align;   // uStripeGain ≈ 0.16
```

**A3.7 라인 마킹은 텍스처에 굽지 말고 해석적으로**
2048px/105m = 19.5px/m → 12cm 라인이 **2.3픽셀**(회색 뭉개짐). 월드 XZ에서 `fwidth()` AA로 계산하면 어떤 줌에서도 선명하고 텍스처 메모리 0. 초망원 클로즈업에서 구운 2K 텍스처는 무너지지만 이건 버틴다.
```glsl
float lineAA(float d, float hw){ float w=fwidth(d); return 1.0-smoothstep(hw-w, hw+w, abs(d)); }
```
터치라인/골라인 4 + 박스 8 + 원·호는 `abs(length(p-c)-r)`. 총 ~50줄.

**A3.6 디테일 노멀**: three는 **머티리얼당 normalMap 1개뿐**. ① 4096²에 미리 합성(39텍셀/m, 매크로만) ② `onBeforeCompile`로 두 번째 노멀맵을 자체 repeat로 whiteout 블렌드(~20줄, **권장** — 이미 스트라이프용 훅을 열었으므로) ③ 타일 디테일 노멀만 고repeat. **원거리에선 노멀보다 roughness 변주가 더 중요** — 잔디 섬유는 서브픽셀이라 노멀이 평균화되지만, roughness 패치가 없으면 조명 아래 플라스틱 시트로 보인다.

### A3. 데칼 (발자국·슬라이딩 자국)
- **`DecalGeometry`는 쓰지 마라**: r185에 존재하지만(`three/addons/geometries/DecalGeometry.js`), 타깃 지오메트리 전 인덱스를 순회해 6평면 CPU 클립 + 3개 typed array 할당 + draw call 1개. **평면 피치에서는 `PlaneGeometry`+트랜스폼과 결과가 동일**하면서 비용만 더 든다
- **배치 쿼드**: 단일 `InstancedMesh`(256) 링버퍼, per-instance 아틀라스 UV. 평면에서는 `polygonOffset`보다 **y 오프셋 0.005~0.02m 스태거**가 GPU 간 안정적. 1 draw call
- **★ A4.3 렌더타깃 마모 스플랫 (최선)**: 피치 UV 공간의 저해상 RT(1024×664 `RedFormat` = **0.7MB**)에 발자국을 가산 블렌딩으로 누적, 피치 셰이더가 읽어 albedo/roughness 변조. **핑퐁 불필요**(누적이지 피드백이 아님 — `autoClear=false` + AdditiveBlending). **비용은 신규 마크 수에 비례, 마크 없는 프레임은 0**. 메인 씬 draw call 증가 0. 90분에 걸쳐 피치가 실제로 파여가는 디테일
  ⚠️ `renderer.getRenderTarget()`/`autoClear` 저장·복원 필수, `wearRT.texture.colorSpace = NoColorSpace`

---

## B. 방송 카메라

### B1. 초점거리 압축 — 최고 ROI
**r185 검증**: `.fov`(수직, 기본 50) · `.filmGauge`(기본 **35**, `filmOffset`이 0이 아닐 때만 투영행렬에 영향) · `.setFocalLength(f)`는 `.fov`를 쓰는 편의 래퍼 · `.zoom`은 fov보다 저렴
🚩 **실제 렌즈 수치와 맞추려면 `filmGauge = 36`** (35mm 필름 폭은 36mm — 기본 35는 모든 초점거리를 2.8% 좁게 만듦)

**실제 방송 렌즈**: 2/3" 센서 9.6×5.4mm, **크롭 3.75배**. Fujinon XA72x9.3(EPL/UCL 메인) 9.3~670mm → **35mm 환산 34.9~2513mm**. 카메라를 움직이지 않고 광각~초망원을 오간다.

**초점거리 → fov (16:9, filmGauge 35)**
| 35mm환산 | fov | | 35mm환산 | fov |
|---|---|---|---|---|
| 24mm | 44.60° | | 135mm | 8.34° |
| 35mm | 31.42° | | 200mm | 5.64° |
| **50mm** | **22.28°** | | 300mm | 3.76° |
| 85mm | 13.21° | | 600mm | 1.88° |

**카메라 위치 — UEFA 규정 근거**: 메인 카메라 플랫폼은 **하프웨이 라인 정면**, 센터스팟을 볼 때 **수평 대비 12~15°**(UEFA Stadium Infrastructure Regulations Art.36). 수평거리 55m → 높이 11.7~14.7m.
→ **`(0, 13, 55)`에서 원점을 보는 것이 물리적으로 정확한 프리미어리그 1번 카메라.**

**4가지 프레이밍**
| 샷 | 위치 | 거리 | fov | 35mm환산 |
|---|---|---|---|---|
| 전술(피치 전체) | (0,45,82) | 95m | 37.6° | 29mm |
| **메인(중앙 플레이, 폭 35m)** | **(0,13,55)** | 50m | **22.3°** | 50mm |
| 메인(먼 터치라인, 폭 32m) | 동일 | 115m | **8.95°** | 126mm |
| 타이트 팔로우(폭 12m) | 동일 | 60m | 6.44° | 175mm |
| 골 세리머니 초망원(폭 4.5m) | 스탠드, 80m | 80m | 1.81° | 622mm |

**가장 중요한 발견**: 실제 메인 카메라는 **줌 조작 없이도** 플레이가 가까운/먼 터치라인을 오가는 것만으로 50mm↔130mm를 오간다. **볼까지 거리로 fov를 구동하면 진짜 방송 렌즈 호흡이 공짜로** 나온다:
```js
const TARGET_W = 34;                                  // 프레임에 담을 피치 폭(m)
const d = camera.position.distanceTo(ballPos);
const target = THREE.MathUtils.radToDeg(2*Math.atan((TARGET_W/(2*d))/camera.aspect));
camera.fov = THREE.MathUtils.damp(camera.fov, target, 3.0, dt);
camera.updateProjectionMatrix();
```
초망원의 부작용 2가지: ① **깊이 압축이 극단적** — 40m 뒤 관중이 3m 앞처럼 프레임을 채움(세리머니 샷에서 관중 품질이 갑자기 중요해짐) ② **각도 지터를 fov에 비례**시켜야 함(1.81° fov에서 0.2° 흔들림 = 화면 높이의 11%)
`camera.near = 0.5, far = 500` (0.1 방치 금지 — 깊이 정밀도 낭비)

### B2. 핸드헬드 지터
r185 addons에 **`SimplexNoise`·`ImprovedNoise` 둘 다 존재**(`three/addons/math/`). SimplexNoise는 `new SimplexNoise(rng)`로 시드 주입 가능 → **리플레이 재현성** 확보. `THREE.MathUtils.damp(x,y,lambda,dt)`도 코어에 있음.

Cinemachine 문서 기준 주파수 대역: 저 0.1~0.5Hz, 중 0.8~1.5Hz, 고 3~4Hz (60fps에서 15Hz 초과 금지).
**삼각대 방송 오퍼레이터** 특성 = 느린 드리프트 + 가끔 보정, 고주파 거의 없음:

| 레이어 | 주파수 | 진폭(**fov 대비 비율**) |
|---|---|---|
| 드리프트 | 0.12Hz | 1.0% |
| 보정 | 0.9Hz | 0.4% |
| 마이크로 | 3.5Hz | 0.12% |
| 롤 | 0.08Hz | 0.15% (삼각대는 롤이 거의 없음) |

**진폭은 절대 각도가 아니라 fov 비율로.** 메인샷(22.3°)에서 1% = 0.223°, 초망원(1.9°)에서는 0.019°.
⚠️ 지터는 look-at **이후 별도 쿼터니언으로 post-multiply** — 아니면 담핑에 피드백돼 드리프트가 적분된다.
🚩 미검증: Cinemachine 프리셋(`Handheld_normal_mild` 등)의 실제 진폭 테이블은 문서에 미공개. 대역만 인용, 진폭은 fov 비율 논리로 유도.

### B3. 임팩트 셰이크 — 트라우마 모델
Squirrel Eiserloh, GDC 2016 "Juicing Your Cameras With Math" **원문 검증**:
> trauma를 [0,1]로 유지 · 이벤트가 trauma 추가(+0.2~0.5) · **선형 감쇠** · **셰이크 = trauma² 또는 trauma³**
> trauma .30/.60/.90 → 셰이크 3%/22%/73%
> 3D에서: **평행이동 = 매우 나쁨. 회전 = 좋음**
> **부드러운 노이즈(Perlin)가 랜덤보다 훨씬 낫다** — 일시정지·슬로모와 자동으로 맞고, 리플레이에서 재현 가능

구현 원칙: **지터와 같은 노이즈 필드를 쓰되 시드·진폭만 다르게**(독립 셰이크 시스템 2개 금지). 셰이크는 ~10~12Hz로 지터 대역보다 위에. 회전만. 만점 트라우마에서 fov의 7.5%.
`trauma²`의 효과: 0.7에서 +0.2를 더하면 49%→81%(매우 가독적), 0.1에서는 거의 무감 — 이게 의도.

### B4. 샷 디렉터
three.js에 카메라 셰이크·샷 디렉터·컷 매니저는 **없다**(직접 작성, ~200줄). `CatmullRomCurve3`(코어)의 `.getPointAt(u)`(호길이 파라미터화 — 등속 달리용) 사용. `CameraUtils.frameCorners()`는 포털용 오프액시스 투영이라 방송에 부적합(fov와 충돌).

**컷하되 블렌드하지 마라.** 잘 구성된 두 샷 사이의 하드 컷은 TV처럼 읽히고, 보간 플라이스루는 레벨 에디터처럼 읽히며 멀미를 유발.

**★ 180도 규칙 — 반드시 지킬 것**: 실제 축구 중계는 모든 메인 카메라를 **한쪽 사이드**에 두고, 반대쪽 앵글을 쓸 때는 화면에 **"REVERSE ANGLE" 자막**을 넣는다. 각 샷에 `side: +1|-1`를 두고 **라이브 플레이 중 반대 side 간 컷 금지**. 리플레이·데드볼·관중 컷어웨이에서만 허용. 규칙을 모르는 시청자도 즉시 위화감을 느낀다(팀이 갑자기 진영을 바꾼 것처럼 보임).

🚩 미검증(실무 관행, 출처 없음): 최소 샷 길이 ~2.0s / 메인 카메라 8~30s 유지, 라이브의 70~80% / **슛 상황에서 절대 컷 금지**(축구 중계 최대 금기) / 2초 내 두 번 컷 금지 / 데드볼에서 컷.
멀미 방지: 카메라 이동과 컷을 같은 0.5s에 겹치지 말 것 · 팬 속도를 **화면공간 기준**으로 제한(`max °/s ≈ 1.2 × fov`) · 롤 금지 · "카메라 모션 줄이기" 토글 제공.

### B5. 리플레이 / 슬로모
**포즈 스냅샷 링버퍼**(트랜스폼이 아니라 상태를 기록):
- 23 엔티티 × 6 float(pos3 + facing + animPhase + animState) = 138 float/frame
- 30Hz × 20초 = 600 프레임 → **331KB**. 할당 0, GC 0
- **행렬을 기록하지 말 것**(16 float/엔티티 = 2.6배 + 재애니메이션 불가)
- ⚠️ **렌더와 분리된 고정 레이트로 기록**(프레임레이트 의존 슬로모 방지)
- 재생: `animPhase`를 보간해 기존 관절 함수에 그대로 투입 → **엔티티당 float 1개로 슬로모에서도 정확한 다리 움직임**
- `THREE.Clock`에 `timeScale` **없음**. 직접 소유: `dt = Math.min(dtRaw, 1/20) * timeScale`(원시 델타를 먼저 클램프 — 탭 전환 가드). 노이즈 시간도 같은 dt로 진행시키면 지터·셰이크가 슬로모와 자동으로 맞음
- 담핑은 `MathUtils.damp(x, target, lambda, dt)`로 — 이미 스케일된 dt를 먹이면 일시정지·슬로모가 특수처리 없이 맞음. lambda 0.6=느림, 6=적당, 40=즉각
- **하지 말 것**: 결정론적 입력 리플레이(재시뮬). 우아하지만 디버깅이 일주일을 먹는다. 스냅샷 보간은 100줄이고 desync가 불가능

**일정**: 링버퍼+레코더 0.5d / timeScale 배선 0.5d / 리플레이 디렉터(리버스앵글·골대뒤·오빗 3샷 + 와이프 UI) 1d / 트리거(골·유효슛·태클 시 직전 6초를 0.35배속 다른 side에서) 0.5d

---

## 주요 출처
- three.js r185 소스: [PerspectiveCamera](https://raw.githubusercontent.com/mrdoob/three.js/r185/src/cameras/PerspectiveCamera.js) · [MeshPhysicalMaterial](https://raw.githubusercontent.com/mrdoob/three.js/r185/src/materials/MeshPhysicalMaterial.js) · [DecalGeometry](https://raw.githubusercontent.com/mrdoob/three.js/r185/examples/jsm/geometries/DecalGeometry.js) · [examples/jsm/math](https://github.com/mrdoob/three.js/tree/r185/examples/jsm/math)
- [PR #25580 KHR_materials_anisotropy (r153)](https://github.com/mrdoob/three.js/pull/25580)
- [SimonDev Quick_Grass](https://github.com/simondevyoutube/Quick_Grass) · [FluffyGrass](https://github.com/thebenezer/FluffyGrass) · [Codrops 기사](https://tympanus.net/codrops/2025/02/04/how-to-make-the-fluffiest-grass-with-three-js/)
- [Ghost of Tsushima 절차 잔디 GDC 2021](https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural)
- [Eiserloh, Juicing Your Cameras With Math (PDF)](http://www.mathforgameprogrammers.com/gdc2016/GDC2016_Eiserloh_Squirrel_JuicingYourCameras.pdf)
- [Cinemachine 노이즈 프로파일](https://docs.unity3d.com/Packages/com.unity.cinemachine@2.3/manual/CinemachineNoiseProfiles.html)
- [UEFA Stadium Infrastructure Regulations Art.36](https://documents.uefa.com/r/PxVtjcYr9Ntgwd0wYgq2xw/PHTPDdalQIIISrmHzV_tZQ)
- [180도 규칙](https://en.wikipedia.org/wiki/180-degree_rule)
