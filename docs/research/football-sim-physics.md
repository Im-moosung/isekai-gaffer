# 축구 시뮬 3D 물리·연출 리서치 (2026-07-30)

> 조사 목적: 사용자가 3D 경기 화면을 "최악"으로 평가했다. 원문 불만 3건 —
> ① 공을 차는 느낌이 없고 공이 혼자 떠다닌다 ② 1x인데 너무 빠르다 ③ 공이 가기도
> 전에 GK가 넘어지고, 패스가 선수를 거치지 않고 휘어진다.
>
> 이 문서는 (1) 현재 코드가 실제로 무엇을 하는지 **실측**하고, (2) 실물 축구의
> 물리·타이밍 상수를 문헌에서 모으고, (3) 우리 제약(결정론·엔진 결과 고정·번들)
> 아래에서 **권고안 하나**를 고른다.
>
> 표기 규칙: 문헌·1차 출처가 있는 값은 출처 URL을 붙였다. 내가 이 저장소에서
> 직접 실행해 얻은 값은 `[실측]`, 문헌 상수로 계산해 유도한 값은 `[유도]`,
> 검증하지 못한 것은 **확인 필요**로 표시했다.

---

## 0. 결론 요약

**권고: 물리 엔진(rapier/cannon-es 등)을 도입하지 않는다. 지금의 키프레임 구조를
유지한 채 (a) 볼 구간 진행도를 항력 감속 곡선으로 바꾸고, (b) 볼 키프레임을
선수 발에 앵커링하고, (c) 킥·다이브 애니메이션을 볼 이벤트 시각에 정렬하고,
(d) 구간 소요시간을 실측 볼 속도에서 역산한다.**

번들 증가 0 KB, 프레임 예산 증가 무시 가능, 결정론 영향 없음. 사용자가 지적한
불만 3건이 전부 이 4가지에 대응한다. 근거와 기각한 대안은 §7.

가장 중요한 발견 두 가지를 먼저 적는다.

1. **"공이 혼자 떠다닌다"는 은유가 아니라 문자 그대로다.** `scenes.ts`가 저술한
   볼 키프레임은 같은 스텝의 무버 좌표에서 **6.7 ~ 17.9 m** 떨어져 있다 `[실측]`.
   공은 태생적으로 아무의 발에도 없다.
2. **"GK가 먼저 넘어진다"도 정확히 계산된다.** 세이브 장면에서 GK는 볼이
   도착하기 **473 ms 전**에 이미 옆으로 완전히 누워 있다 `[실측]`.

---

## 1. 현재 코드 실측 진단

측정 방법: `makeTestTeam('kor',82)` vs `makeTestTeam('esp',84)`, `seed=42`로
`createMatch` → `buildSequence` → `computeFrame`을 60 fps로 dwell 전체 재생하며
볼 좌표·최근접 선수 거리·액션 상태를 덤프했다(임시 프로브 테스트, 측정 후 삭제).

### 1.1 볼 키프레임과 선수의 거리 `[실측]`

`save` 이벤트(홈, `balanced` 패턴, dwell 4300 ms)의 저술 키프레임:

| t | 볼 (0~100) | 무버1 거리 | 무버2 거리 | 무버3 거리 |
|---|---|---|---|---|
| 0.00 | (34, 52) | 6.7 m | 13.6 m | 16.8 m |
| 0.16 | (48, 45) | 9.2 m | 12.6 m | 17.5 m |
| 0.32 | (64, 51) | 8.5 m | 11.5 m | 14.7 m |
| 0.52 | (81, 50) | 8.4 m | 3.9 m | 1.9 m |
| 0.74 | (94, 50) | 17.3 m | 3.1 m | 2.9 m |

`goal` 이벤트도 같다(7.2 / 14.0 / 17.9 m …). **빌드업 전 구간에서 공은 지정된
무버 누구의 발에도 없다.** 즉 `scenes.ts`의 볼 궤적과 무버 궤적은 같은 사건을
기술하는 두 개의 무관한 곡선이다.

화면에서 공 근처에 사람이 아예 없지는 않다. `movement.applyConvergence`가
안무 무버가 **아닌** 일반 선수 3명을 매 프레임 볼 쪽으로 최대 12 m 끌어당기고
`STANDOFF = 1.2 m` 링에 세우기 때문이다. 그래서 실제 킥 판정(`KICK_REACH = 3 m`)에
걸리는 것은 **엔진이 지정한 슈터도, 안무 무버도 아닌, 우연히 근처로 빨려온
일반 선수**다 `[실측: goal 장면에서 킥 액션을 받은 선수는 8번 → 10번 → 16번,
정작 이벤트의 `playerId`는 무버 슬롯 0에 배정되어 8 m 밖에 있었다]`.

이것이 "패스가 선수를 거치지도 않고 휘어진다"의 정체다. 구간 경계에서 볼은
방향을 꺾는데, 그 순간 가장 가까운 선수는 2.1 ~ 2.9 m 밖에 서 있다 `[실측]`.
공중에서 스스로 코너를 도는 것처럼 보인다.

### 1.2 볼 속도 프로파일 `[실측]`

`save` 장면(dwell 4300 ms)의 프레임 간 볼 속도(m/s):

```
구간0(패스) 22.8 → 22.6 → 22.8      (거의 일정)
구간1(지면) 25.2 (완전히 일정)
구간2(패스) 21.2 → 20.8 → 21.2
구간3(슛)   14.4 → 13.8
여운        2.1 (고정)
```

두 가지 문제가 동시에 있다.

- **구간 안에서 감속이 없다.** `sampleSequence`가 `lerp(a, b, u)`, `u`는 시간에
  선형이다. 실제 공은 항력으로 계속 느려진다(§2.1).
- **속도의 절대값이 뒤집혀 있다.** 짧은 빌드업 패스가 **22 ~ 25 m/s**로
  날아가고 정작 마무리 슛이 **14 m/s**다. 실제는 정반대다 — 짧은 패스
  8 ~ 15 m/s, 슛 22 ~ 28 m/s(§2.2). 사용자가 느낀 "너무 빠르다"의 직접 원인은
  빌드업 패스 속도이지 dwell 길이가 아니다.
- **터치가 없다.** 실제 축구의 빌드업은 `패스 비행 → 트래핑/컨트롤 정지
  0.3~0.8 s → 다음 패스`의 반복이다. 지금 공은 90분 하이라이트 내내 **한 번도
  멈추지 않는다.** 정지 구간의 부재가 "쉼 없이 빠르다"는 인상을 만든다.

### 1.3 킥 애니메이션의 임팩트 시점 `[실측]`

`pose.kickAngles`는 백스윙 0 ~ 0.32, 임팩트 스윙 0.32 ~ 0.58, 팔로스루 0.58 ~ 1로
설계돼 있다. 즉 **볼 접촉은 `actionT ≈ 0.45` 부근**이다.

그런데 `movement.computeFrame`은 `sample.u < KICK_WINDOW(0.3)`일 때
`actionT = sample.u / 0.3`을 준다. 구간 시작 = 볼 출발 = `actionT 0` = 백스윙
시작이다. `save` 장면 구간0에서 `actionT 0.45`에 도달하는 시각은 dwell 상대
t ≈ 0.021, 즉 **볼이 떠난 뒤 90 ms, 공이 이미 2 m 날아간 시점**이다 `[실측]`.

→ 발이 뒤로 젖혀지는 동안 공은 이미 출발해 있고, 발이 앞으로 나오는 순간
공은 저 멀리 있다. "차는 느낌이 없다"는 여기서 나온다.

### 1.4 GK 다이브 인과 `[실측]`

`save` 장면에서:

| dwell t | 볼 x(월드 m) | GK `actionT` | 상태 |
|---|---|---|---|
| 0.52 | 31.9 | – | 슛 임팩트(구간3 시작) |
| 0.554 | 34.6 | 0.16 | 다이브 시작 (**반응 지연 0**) |
| 0.640 | 39.7 | 0.54 | `diveAngles`가 `smoothstep(u/0.55)`로 **완전히 눕는 시점** |
| 0.74~0.77 | 45.7 | 1.00 | 볼 도착 |

`pose.diveAngles`는 `lay = smoothstep(u / 0.55)`이므로 `u = 0.55`에서 이미 롤
90°, 완전 측와 자세다. 즉 GK는 t ≈ 0.65에 잔디에 누워 있고 볼은 t ≈ 0.75에
도착한다. 차이 0.10 dwell × 4300 ms = **473 ms 먼저 넘어진다**.

추가로 `diving` 판정이 `sample.segIndex >= segCount - 1`이라 **슛 임팩트와
동시에 반응 지연 0으로** 다이브가 시작된다. 문헌값은 200 ms 안팎이다(§3.2).

### 1.5 아크 배정 오류 — 슛이 6 m를 뜬다 `[실측]`

`ScenePoint.arc`의 계약은 "이 스텝에서 **시작하는** 구간의 궤적"이다
(`scenes.ts` L30, `sampleSequence`가 `start = steps[k]`로 소비).

그런데 `finishPoints()`는 `deliverArc`(배달 = 크로스인지 지면인지)를 **슈팅
지점 키프레임 `t0`에 붙인다**. `t0` 스텝에서 시작하는 구간은 배달이 아니라
**슛(슈팅 지점 → 골문)**이다. 한 칸 밀렸다.

`cross` 공격 패턴 전수 검사 결과 `[실측]`:

```
wing.a/goal.a/L0  arcs=pass,ground,ground,cross   마지막(슛)구간 = cross, BALL_PEAK 6 m
wing.a/save.a/L0  arcs=pass,ground,ground,cross   슛 구간 = cross, 6 m
wing.a/miss.b/L1  arcs=pass,ground,ground,cross   슛 구간 = cross, 6 m
… (마무리 변형 c(컷백)만 ground)
```

즉 **크로스 전술을 고른 유저는 모든 골·세이브·미스에서 공이 6 m 위로 떠서
골문으로 들어가는 것을 본다.** 반대로 정작 박스로 배달되는 크로스 구간은
`ground`(지면)로 굴러간다. 정확히 뒤집혀 있다.

덤으로, 기본 `shot` 아크도 `ballHeight('shot', u) = 0.11 + 2.39·sin(πu/2)`라
**골라인 통과 높이가 항상 정확히 2.50 m**다 `[실측: goal 장면에서 x=51.3 m
(골라인 52.5 m)에 h=2.50 m]`. 크로스바는 2.44 m다. 모든 골이 크로스바 위
높이로 들어간다.

### 1.6 선수 관성 부재

`computeFrame`은 위치만 상태로 들고 다니며(`PlayerPose`에 속도 필드가 없다)
매 프레임 `step = min(d, cap·dt·arrive)`로 목표를 향해 직선 이동한다. 도착
감속(`ARRIVE_RADIUS = 1.5 m`)은 있지만 **가속 제한이 없다** — 정지 상태에서
한 프레임에 7.5 m/s로 튀어나갈 수 있고, 목표가 바뀌면 속도 방향이 즉시 꺾인다.
문헌상 엘리트 선수의 최대 가속은 7 ~ 8 m/s² 수준이다(§5.3).

---

## 2. A. 공 물리 — "차는 느낌"은 무엇으로 만들어지는가

### 2.1 실측 상수표

| 항목 | 값 | 출처 |
|---|---|---|
| 공 질량 (규정) | 410 ~ 450 g (경기 개시 시) | [Laws of the Game / Wikipedia Law 2](https://en.wikipedia.org/wiki/Ball_(association_football)) |
| 공 둘레 (규정) | 68 ~ 70 cm → 반지름 **0.108 ~ 0.111 m** | 위와 동일 |
| 공기압 | 0.6 ~ 1.1 kgf/cm² (59 ~ 108 kPa) | 위와 동일 |
| 단면적 A | π·0.11² = **0.0380 m²** | 유도 |
| 공기밀도 ρ (해면, 15 °C) | 1.225 kg/m³ | 표준대기 |
| 항력계수 C_d (실측, 프리킥 10회) | **0.25 ~ 0.30** (평균 0.277) | [Bray & Kerwin 2003, *J Sports Sci* 21:75–85](https://www.weizmann.ac.il/complex/falkovich/sites/complex.falkovich/files/uploads/FreeKick.pdf) Table 1 |
| 양력(마그누스)계수 C_l (실측) | **0.23 ~ 0.29** | 위와 동일 |
| C_d (NASA 기본값) | 0.25 | [NASA GRC, Soccer Ball Drag](https://www.grc.nasa.gov/www/k-12/airplane/socdrag.html) |
| C_d (관례적 인용값) | 0.2 (de Mestre 1990, Daish 1972) — Bray는 이보다 높게 실측 | Bray & Kerwin, p.81 |
| 임계 레이놀즈수 Re_crit | 2.03×10⁵ ~ 3.0×10⁵ (공에 따라) | [Aerodynamic Drag Measurements of FIFA-approved Footballs](https://www.sciencedirect.com/science/article/pii/S1877705814006353), [Fundamental aerodynamics of the soccer ball](https://link.springer.com/article/10.1007/BF02844207) |
| 후임계 조건 성립 속도 | Re > 2.1×10⁵ ≈ **v > 17.9 m/s** | Bray & Kerwin, p.81 |
| 잔디 구름저항 계수 μ_r | 0.05 ~ 0.07 (**확인 필요** — 인용처가 인조잔디 업계 페이지, 1차 문헌 미확인) | [noninfill.com 비교 자료](https://www.noninfill.com/NEWS/Non-Infill-Artificial-Turf-vs-Natural-Grass-In-Depth-Analysis-of-Ball-Roll-and-Rebound-Compatibility-1014.html) |
| 표준 볼롤 시험 거리 (UNE-EN 12234) | 5 ~ 12 m | [Sport Terrain Testing II: Ball Rolling](https://www.tiloom.com/en/tests-on-sporting-grounds-ball-rolling/) |

Bray & Kerwin의 운동방정식(권고안이 그대로 쓴다):

```
r̈ = g − k_d·v²·τ + k_l·v²·(σ × τ)
k_d = ρ·A·C_d / (2m)      k_l = ρ·A·C_l / (2m)
```
τ = 속도 방향 단위벡터, σ = 스핀축 단위벡터.

우리 수치로 `k_d = 1.225 × 0.0380 × 0.275 / (2 × 0.43) = **0.01489 m⁻¹**` `[유도]`.
25 m/s에서 항력 감속 = k_d·v² = **9.3 m/s²** — 중력과 맞먹는다. 이걸 무시하면
20 m 비행 동안 속도가 25 → 19.5 m/s로 떨어지는 현상(Bray Table 1의 v_i → v_f)이
전부 사라진다. 지금 우리 코드가 정확히 그 상태다.

### 2.2 상황별 발사 조건

| 상황 | 초기 속도 | 발사각 | 근거 |
|---|---|---|---|
| 직접 프리킥 (18.3 m) | **25 m/s** (측정 23.0 ~ 28.3) | **16.5° ~ 17.5°** (벽 넘고 크로스바 아래) | Bray & Kerwin Table 1 / Fig. 6 |
| 강한 슛 (프로 평균) | 30 ~ 36 m/s (110 ~ 130 km/h) — **확인 필요**(2차 출처 다수, 1차 논문 미확보) | 5 ~ 12° | 대중 매체 집계값 |
| 짧은 지면 패스 (10 ~ 15 m) | 10 ~ 15 m/s | 0° | **확인 필요**(문헌 미확보, Bray 모델로 역산한 타당 범위) |
| 롱패스/크로스 | 18 ~ 22 m/s | 20 ~ 30° | 아래 `[유도]` 표에서 도달 거리·체공으로 역산 |
| 페널티킥 (11 m) | 25 ~ 30 m/s | ~5° | 아래 비행시간 계산 참조 |

Bray-Kerwin 모델(C_d = 0.275, 스핀 무시)로 내가 직접 적분한 결과 `[유도]`:

**발사 25 m/s, 12°일 때 도달 시간**

| 수평거리 | 도달 시각 | 그때 높이 | 그때 속도 |
|---|---|---|---|
| 8 m | 0.35 s | 1.13 m | 21.7 m/s |
| 11 m (PK) | **0.49 s** | 1.22 m | 20.7 m/s |
| 15 m | 0.69 s | 1.03 m | 19.6 m/s |
| 18 m (프리킥) | **0.85 s** | 0.61 m | 19.0 m/s |

**발사 20 m/s일 때 각도별 궤적 (크로스·로빙 설계용)**

| 발사각 | 최고점 | 도달거리 | 체공시간 |
|---|---|---|---|
| 10° | 0.57 m | 12.3 m | 0.68 s |
| 20° | 2.11 m | 20.9 m | 1.31 s |
| 30° | **4.32 m** | 26.2 m | 1.87 s |
| 45° | 8.26 m | 28.3 m | 2.59 s |

→ 우리 `BALL_PEAK.cross = 6 m`는 발사 20 m/s 기준 약 36°에 해당하고 그때
도달거리가 27 m다. 박스 안 짧은 크로스(15 ~ 20 m)에 6 m 최고점은 과하다.
**크로스 최고점은 3 ~ 4.5 m가 적정**이다.

**지면 패스 감속** (항력 + μ_r = 0.06) `[유도]`

| 발사 15 m/s | 도달 시각 | 도착 속도 |
|---|---|---|
| 10 m | 0.73 s | 12.5 m/s |
| 20 m | 1.61 s | 10.3 m/s |
| 30 m | 2.69 s | 8.3 m/s |

μ_r 값 자체가 **확인 필요**지만, 중요한 것은 정성적 사실 — **지면 패스는 10 m
가는 동안 15 → 12.5 m/s로 눈에 보이게 느려진다.** 현재 우리 코드는 25.2 m/s로
완전히 일정하다.

### 2.3 임팩트 연출 — 게임 업계의 "타격감"

정리된 기법(출처: [Game Juice and Game Feel Explained](https://www.solana.garden/guides/game-juice-and-feel-explained/),
[Game feel on the web: squash, shake, and the art of juice](https://valdemird.com/blog/game-feel-on-the-web/);
원류는 Steve Swink *Game Feel*(2008)과 Jonasson & Purho의 "Juice it or lose it"
강연):

1. **히트스톱(hitstop/hitlag)** — 접촉 프레임에서 이동을 2 ~ 5프레임(33 ~ 83 ms
   @60 fps) 정지시킨다. 정확한 프레임 수의 **1차 출처는 확보하지 못했다
   (확인 필요)** — 격투 게임 커뮤니티 관행값이 널리 인용되지만 논문은 없다.
   우리 용도에는 축구 중계 감각상 **2 ~ 3프레임(33 ~ 50 ms)** 이 상한이다.
   그 이상은 슬로모션으로 읽힌다.
2. **스쿼시 & 스트레치** — 접촉 프레임에 공을 진행 방향으로 눌렀다(0.85×) 펴는
   비균등 스케일. 실제 축구공도 강한 슛에서 눈에 띄게 변형한다. 프레임 2~3개만.
3. **파티클** — 잔디 조각/흙먼지를 접촉점에서 발사 방향 반대로 20 ~ 30개.
   우리는 이미 `fx3d.goalBurst`(60개)가 있어 재사용 가능.
4. **사운드가 영상보다 반 프레임 빠르게** — 임팩트 SFX는 시각 접촉 프레임보다
   1프레임 먼저 트리거해야 동시로 느껴진다(오디오 지연 보정).
5. **카메라** — 임팩트에서 FOV 1 ~ 2° 순간 축소 + 2 ~ 4 px 셰이크, 150 ms 복귀.

**우리에게 가장 효과가 큰 것은 1번이 아니라 "임팩트 프레임을 볼 출발 시각과
일치시키는 것"이다**(§1.3). 히트스톱은 그 위에 얹는 화장이다.

### 2.4 드리블 구간 ↔ 비행 구간의 전환

업계 표준 처방은 **볼 소유 상태 머신**이다.

```
FREE(비행/구름) ──(선수 반경 R 안 + 속도차 조건)──> CONTROLLED(발밑)
CONTROLLED ──(킥 이벤트)──> FREE
```

`CONTROLLED` 상태에서 볼 위치 = `선수 위치 + yaw 방향 오프셋(0.35 ~ 0.5 m) +
보폭 위상에 연동된 미세 흔들림`. 즉 드리블 중 볼은 물리로 굴리지 않고 **선수에
붙여 놓는다.** 이것이 FIFA/eFootball을 포함한 사실상 모든 축구 게임의 방식이다
(공개 문서로 확인된 것은 아래 오픈소스 사례).

`football-match-viewer`(§6.1)는 서버가 준 위치 샘플만 있는데도 같은 문제를
만나고, `PoseBuilder.movePlayerToBall(finalDistance = 0.4)`로 **킥이 일어나는
스텝에서 선수를 볼 0.4 m 지점으로 강제 이동시킨다**. 우리도 이 처방이 필요하다.

---

## 3. B. 인과 순서 — 골키퍼가 먼저 넘어지는 문제

### 3.1 슛 → 세이브의 시간 구조

| 구간 | 지속 | 근거 |
|---|---|---|
| 백스윙 ~ 임팩트 | ~250 ms (스윙 다리 최대 후방 → 접촉) — **확인 필요**(킥 운동학 1차 문헌 미확보) | 관례값 |
| 발-공 접촉 | 약 9 ~ 10 ms | **확인 필요** (Levendusky 등 임팩트 연구 인용, 원문 미확보) |
| 볼 비행 (18 m, 25 m/s) | **0.85 s** | §2.2 `[유도]` |
| 볼 비행 (11 m, PK) | **0.49 s** | §2.2 `[유도]` |
| 볼 비행 (PK, 실측 문헌) | 400 ms @100 km/h | 2차 요약 — **확인 필요** |
| GK 다이브(단서 → 접촉) | **500 ~ 700 ms** | 2차 요약 다수 일치, 1차: Euro 2004 영상 분석 기반 "diving envelope" 모델 — **원문 미확보, 확인 필요** |

### 3.2 GK 반응 시간

정리 가능한 것:

- 단순 시각 반응 시간(자극 → 근육 활성)은 일반적으로 **180 ~ 250 ms** 범위로
  인용된다. 스포츠 과학의 표준 상수지만, 축구 GK 전용 1차 논문은 이번 조사에서
  확보하지 못했다 — **확인 필요**.
- 페널티킥 연구의 합의는 **"반응으로는 못 막는다"**이다. 11 m 비행이 400 ~ 500 ms인데
  반응 180 ms + 다이브 500 ~ 700 ms = 680 ~ 880 ms이므로 100 ~ 300 ms 부족하다.
  그래서 GK는 **킥 이전의 신체 단서**(디딤발 각도, 골반 방향)를 읽고 미리 움직인다.
  - Zheng, de Reus & van der Kamp (2021), *Hum Mov Sci*,
    ["Goalkeeping in the soccer penalty kick: The dive is coordinated to the
    kicker's non-kicking leg placement, irrespective of time constraints"](https://pubmed.ncbi.nlm.nih.gov/33517202/)
    — 다이브 개시가 **키커의 디딤발 착지**에 동기화된다. 즉 GK는 임팩트가 아니라
    **디딤발 착지 시점**을 트리거로 삼는다.
  - Navarro 등 (2012), *J Sport Exerc Psychol*,
    ["The effects of high pressure on the point of no return in simulated penalty kicks"](https://pubmed.ncbi.nlm.nih.gov/22356884/)
    — 다이브에는 되돌릴 수 없는 "point of no return"이 존재한다.

**우리 연출에 옮길 규칙:**

```
디딤발 착지            = 임팩트 − 200 ms   → GK 다이브 개시
임팩트                                     → 볼 출발
임팩트 + 비행시간 T                        → GK 최대 신전(완전히 뻗은 자세) = 접촉
```

즉 **다이브의 "완전히 누운 순간"이 볼 도착과 정확히 일치**해야 한다. 지금은
그 순간이 473 ms 앞서 있다.

먼 거리 슛(T > 800 ms)이라면 반대 문제가 생긴다 — 다이브를 800 ms 끌면
슬로모션이 된다. 처방: **다이브 지속을 550 ms로 고정하고 시작 시각을
`도착 − 550 ms`로 역산**한다. 그러면 먼 슛일수록 GK가 늦게 반응하는데, 이는
실제 축구와도 일치한다(먼 슛은 궤적을 보고 반응할 시간이 있다).

### 3.3 게임에서 인과를 보장하는 패턴

세 가지 표준 패턴이 있다.

1. **애니메이션 노티파이/이벤트 마커** (Unreal `AnimNotify`, Unity
   `AnimationEvent`): 클립 안의 특정 프레임에 "여기가 접촉"이라는 마커를 박고,
   게임 로직은 클립 시각이 아니라 **마커 발화 시점**에 볼을 놓아준다.
   → 애니메이션이 물리를 구동한다.
2. **역방향 스케줄링(anticipation scheduling)**: 결과 시각이 이미 정해진 경우
   (우리 경우), 각 애니메이션의 **접촉 프레임 오프셋을 빼서 시작 시각을 역산**한다.
   → 물리가 애니메이션을 구동한다. **우리에게 맞는 것은 이쪽이다.**
3. **클립 진입 오프셋(`startFrom`)**: 남은 시간이 클립보다 짧으면 클립 앞부분을
   잘라내고 중간부터 재생한다. `football-match-viewer`가 실제로 쓰는 방식 —
   패스 `startFrom = 0.3`, 슛 `startFrom = 0.5`, 헤딩 `startFrom = 1.0`
   (`src/features/match/animations/player/PoseBuilder.ts`).

---

## 4. C. 1x 속도 — "진짜 축구처럼"

### 4.1 실제 축구의 시간 구조

| 항목 | 값 | 출처 |
|---|---|---|
| 프리미어리그 실제 인플레이 시간 | **54.7분** (총 경기시간 100분 36초 중) | [The Analyst — Ball in Play](https://theanalyst.com/) 계열 집계 |
| PL 2025-26 초반 7R | 54분 21초 → 57분 05초 | 위 |
| 라리가 | 약 55분 | [AS.com](https://en.as.com/) |
| 리가 MX | 55분 54초 | 위 |
| 일반 범위 | 55 ~ 60분 | 위 |

즉 **90분 중 실제로 공이 굴러가는 것은 약 60%**이고, 나머지 40%는 세트피스 준비,
파울, 교체, 부상, VAR이다. "진짜 축구처럼"의 첫 번째 의미는 **정지 시간의 존재**다.

### 4.2 축구 게임의 압축비

Football Manager의 하이라이트 모드
([SI 커뮤니티](https://community.sports-interactive.com/forums/topic/573903-extended-highlights-or-key-highlights/),
[r/footballmanagergames](https://www.reddit.com/r/footballmanagergames/comments/md2b14/)):

| 모드 | 보여주는 것 | 대략 소요 |
|---|---|---|
| None | 결과만 | 즉시 |
| Key | 결정적 찬스·골·PK·퇴장 | 2 ~ 4분 |
| Extended | 위 + 공격/수비 국면 | 5 ~ 10분 |
| Comprehensive | 위 + 부가 하이라이트 | 10 ~ 20분 |
| Full Match | 90분 전부 | 45분+ (2배속 기준) |

우리의 3~5분은 FM의 **Key 하이라이트와 같은 급**이다. 이 압축비 자체는 정당하다.

핵심은 **FM은 하이라이트 안에서 시간을 압축하지 않는다**는 점이다. 하이라이트
클립 하나는 실시간(1x)으로 재생되고, **하이라이트 사이의 시간을 잘라낸다.**
분당 dwell을 줄여 안무를 빨리 돌리는 우리 방식과 근본적으로 다르다.

우리가 "빠르다"고 느껴지는 이유가 여기 있다: dwell 4300 ms 안에 **20 m 패스 3번 +
슛 1번 + 결과**를 밀어 넣었다. 실물 시간으로는 그 시퀀스가 5 ~ 7초다.

### 4.3 하이라이트 편집 문법

방송 편집의 관행(구체적 수치의 1차 출처는 확보하지 못했다 — **확인 필요**.
아래는 실제 중계 관찰에 기반한 정성적 정리):

- 골 하이라이트 한 건 = **빌드업 마지막 2 ~ 3터치(3 ~ 5초) + 마무리(1 ~ 2초) +
  세리머니(3 ~ 5초) + 리플레이 1 ~ 2컷(각 3 ~ 4초)**.
- 컷 하나의 길이는 3 ~ 5초. 그보다 짧으면 시청자가 공간을 파악하지 못한다.
- 빌드업은 **결과 지점에서 역산해서 자른다** — 시작을 자르지 끝을 자르지 않는다.
- 리플레이는 **다른 각도 + 슬로모션(0.35 ~ 0.5×)**. 같은 각도의 리플레이는 안 쓴다.

### 4.4 우리 압축비에서 "빠르다"를 없애는 처방

시간 예산을 다시 짜야 한다. 물리적으로 타당한 골 장면의 최소 소요:

```
패스1 비행 (12 m @ 13 m/s)  0.95 s
터치/컨트롤                 0.40 s
패스2 비행                  0.95 s
터치/컨트롤                 0.40 s
슛 백스윙                   0.25 s
슛 비행 (18 m @ 25 m/s)     0.85 s
──────────────────────────────────
합계                        3.80 s  (+ 세리머니 2.0 s = 5.8 s)
```

현재 `EVENT_DWELL_MS.goal = 6500`은 **이미 충분하다.** 문제는 그 6500 ms 안에
빌드업 3구간(t 0 → 0.32 = 2080 ms)을 밀어 넣고 마무리에 나머지를 줬다는
**배분**이다. 물리대로라면 빌드업이 2700 ms, 슛 850 ms, 세리머니 2000 ms다.

권고 배분:

| 이벤트 | dwell | 구간 배분 |
|---|---|---|
| goal | 6500 → **7500** | 빌드업 2패스+터치 2700 / 백스윙 250 / 슛 850 / 골 확정 + 세리머니 3700 |
| save·shot·miss | 4300 → **5000** | 빌드업 1~2패스 2200 / 백스윙 250 / 슛 850 / 세이브·여운 1700 |
| corner·foul | 2700 유지 | |
| 무사건 | 1800 → **1200** | 빨리감기를 더 과감하게 |

총합 검산 `[유도]`: 하이라이트 25건 × 평균 5500 + 무사건 65분 × 1200 =
137,500 + 78,000 = **215,500 ms ≈ 3.6분**. 기존 캘리브레이션 목표(180,000 ~
300,000 ms) 안에 들어온다. `MAX_DWELL_MS = 9000`도 건드릴 필요 없다.

**즉 "1x가 너무 빠르다"의 해법은 전체를 느리게 하는 것이 아니라, 빌드업 패스
수를 3 → 2로 줄이고 그 사이에 터치 정지를 넣고 무사건 분을 더 빨리 넘기는
것이다.** 이벤트 밀도를 낮추면서 총 길이는 유지한다.

---

## 5. D. 선수 애니메이션

### 5.1 보폭·케이던스

이번 조사에서 **속도별 보폭/케이던스 표를 담은 1차 문헌은 확보하지 못했다
(확인 필요)**. 접근한 것:

- [PLOS ONE — Spatiotemporal and kinetic characteristics during maximal sprint
  (축구선수 67명 vs 단거리선수 17명, 60 m)](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0322216)
  — 최대속도 국면에서 축구선수는 단거리선수 대비 **보폭이 짧고 접지시간이 길며
  체공시간이 짧다**. 절대값은 초록에 없음.
- [MDPI Sports 6(4):169 — Sprint Acceleration 결정 요인 (축구선수 37명, 50 m)](https://www.mdpi.com/2075-4663/6/4/169)

관례적으로 인용되는 값(**전부 확인 필요**):

| 이동 양식 | 속도 | 보폭(1보) | 스텝 빈도 |
|---|---|---|---|
| 걷기 | 1.4 m/s | 0.75 m | 1.9 Hz |
| 조깅 | 3.0 m/s | 1.15 m | 2.6 Hz |
| 런 | 5.5 m/s | 1.65 m | 3.3 Hz |
| 스프린트 | 8.5 ~ 9.5 m/s | 2.0 ~ 2.2 m | 4.3 ~ 4.6 Hz |

**우리 코드와의 대조:** `pose.strideLength(v) = 1.1 + 0.28·v` (스트라이드 = 2보).
- v = 3.0 → 1.94 m/스트라이드 = 0.97 m/보, 3.1 Hz. 위 표(1.15 m, 2.6 Hz)보다
  보폭이 짧고 케이던스가 높다.
- v = 8.0 → 3.34 m/스트라이드 = 1.67 m/보, 4.8 Hz. 보폭이 표(2.0 ~ 2.2 m)보다
  **20% 짧다.**

주석에 이미 근거가 적혀 있다 — 다리 길이 0.93 m·힙 높이 0.94 m라는 리그 비율에서
접지율 0.44를 넘기면 앉은 자세가 되기 때문이다. 즉 **보폭이 짧은 것은 버그가
아니라 리그 비율의 결과**다. 개선하려면 다리를 길게(THIGH+SHIN을 1.0 m 이상)
하거나 힙 높이를 낮춰야 하는데, 그건 캐릭터 비율을 바꾸는 큰 작업이다.
→ **이번 개선 범위에서 제외**를 권고한다. 사용자 불만 목록에 없다.

### 5.2 접지율(duty factor)

`pose.dutyFactor(eff) = 0.44 − 0.23·eff` — 최대속도에서 0.21. 문헌의 스프린트
접지율 ≈ 0.21과 일치한다(코드 주석이 이미 인용). **적절하다.**

### 5.3 관성 — 급정거·급회전

- 엘리트 축구선수 최대 가속: 정지 출발 첫 스텝에서 약 **7 ~ 8 m/s²**,
  이후 속도가 붙을수록 감소. 최대 감속은 **-4 ~ -6 m/s²** 수준 —
  구체 수치의 1차 문헌은 미확보, **확인 필요**.
- 급회전(cutting)은 **감속 → 방향전환 → 재가속**의 3단계이며 90° 전환에서
  최소 0.3 ~ 0.5 s가 걸린다. 속도를 유지한 채 방향만 꺾는 것은 물리적으로 불가능.

**우리 코드에 없다.** `computeFrame`은 위치만 상태로 갖고 속도를 매 프레임
`(x−x_prev)/dt`로 재계산하므로, 목표가 바뀌면 속도 벡터가 즉시 꺾인다.
얼음판 위를 미끄러지는 인상의 원인이다.

처방: `PlayerPose`에 `vx, vz`를 추가하고

```
a_desired = (v_target − v_current) / dt
|a| ≤ A_MAX (가속 7, 감속 6, 측방 5)  ← 클램프
v_new = v_current + a·dt
```

로 바꾼다. 목표 위치 → 목표 속도는 seek/arrive 스티어링으로 만든다. 기존
`ARRIVE_RADIUS` 감속 로직은 그대로 흡수된다.

### 5.4 리깅 에셋 없이 프로시저럴로 어디까지 가능한가

우리는 이미 상당히 멀리 와 있다 — 2링크 역기구학(`solveLeg`), 접지 조건에서
유도한 crouch, C1 연속 유각 궤적, 팔 교차 스윙, 킥/다이브/세리머니.
**이 수준의 프로시저럴 리그로 부족한 것은 다음 세 가지다:**

1. **체중 이동/무게감** — 상체 관성 지연. 골반이 움직인 뒤 상체가 1 ~ 2프레임
   늦게 따라오는 스프링-댐퍼 하나면 크게 개선된다.
2. **시선/머리 분리** — 머리가 몸통 yaw와 독립적으로 볼을 향하는 것.
   목 관절에 `look-at` 각도 클램프(±70°) 하나면 된다. 비용 대비 효과가 매우 크다.
3. **비대칭성** — 22명이 같은 위상 함수를 공유해 군무처럼 보인다. `movement`는
   이미 선수별 해시로 초기 위상을 흩뿌리지만, 진폭·리드미도 ±8% 흩어야 한다.

리깅 에셋(FBX/GLTF 애니메이션 클립) 없이도 이 세 가지는 전부 순수 수학이다.

---

## 6. E. 웹 축구 게임 사례

### 6.1 `immament/football-match-viewer` — **우리와 문제 구조가 같은 유일한 사례**

[github.com/immament/football-match-viewer](https://github.com/immament/football-match-viewer)
(TypeScript, three.js + react-three-fiber, MIT 계열, 데모:
[immament.github.io/football-match-viewer](https://immament.github.io/football-match-viewer/))

브라우저 게임 footstar.org의 **이미 끝난 경기 데이터**를 3D로 재생한다. 즉
"결과가 이미 정해져 있고 그럴듯한 연출만 필요하다"는 우리 제약과 동일하다.

핵심 구현(코드를 클론해 직접 확인):

| 항목 | 방식 |
|---|---|
| 물리 엔진 | **없음** |
| 볼 위치 | 서버가 준 `px/pz/pHeight` 배열을 **0.5초 간격 키프레임**으로 받고 (`MATCH_TIME_SCALE = 0.5`) three.js `VectorKeyframeTrack` + `AnimationMixer`로 보간 (`animations/ball/createBallPositionAnimation.tsx`) |
| 선수 위치 | 동일 방식 (`VectorKeyframeTrack`) |
| 포즈 결정 | 서버가 준 raw 포즈 이벤트(`l`=롱패스, `p`=패스, `o`=크로스, `r`/`v`=슛)를 스텝별로 읽어 애니메이션 클립을 고른다 (`player/PoseBuilder.ts`) |
| **발-공 앵커링** | `movePlayerToBall(minDistance=0.5, maxDistance=1.5, finalDistance=0.4)` — 킥 스텝에서 선수가 볼 0.5 ~ 1.5 m에 있으면 **볼 0.4 m 지점으로 위치를 강제 이동**하고, 이전 스텝의 포즈까지 다시 계산한다(`updatePreviousPose`) |
| **임팩트 정렬** | `pose.startFrom` — 패스 0.3, 슛 0.5, 헤딩 1.0, 스로인 1.0. 클립을 처음부터가 아니라 **중간부터** 재생해 접촉 프레임을 키프레임 시각에 맞춘다 |
| 속도-애니메이션 동기 | `runTimeScale(v) = min(1, v + 0.5/6)`, `walkTimeScale(v) = min(1, (2v+0.5)/4)` — 실측 속도로 클립 재생 배속을 조절 |
| 방향 | `PlayerDirectionBuilder`가 다음 스텝 위치로부터 yaw를 유도하고 `rotationAngle()`로 최단 회전 |
| 재생 속도 | `AnimationMixer.timeScale`로 일괄 제어 |

**시사점 3가지:**
1. 브라우저에서 실제로 돌아가는, 문제 구조가 같은 프로젝트가 **물리 엔진을 쓰지 않는다.**
2. 그들도 "공이 발에 없다"를 만났고 **선수를 볼로 스냅**해서 해결했다.
3. 그들도 "임팩트가 어긋난다"를 만났고 **클립 진입 오프셋**으로 해결했다.

### 6.2 GameplayFootball / Google Research Football

[github.com/google-research/football](https://github.com/google-research/football) —
Bastiaan Konings Schuiling의 오픈소스 3D 축구 게임 *GameplayFootball*을 기반으로 한
강화학습 환경. 완전한 연속 시뮬레이션(우리와 다르게 결과가 정해져 있지 않다).
C++ 네이티브. **웹에서 돌지 않는다.** 물리 백엔드가 Bullet인지 ODE인지는
README에 없어 **확인 필요**. 우리 상황(결과 고정 + 브라우저 + 번들 제약)에는
직접 이식할 수 없다.

### 6.3 그 밖의 브라우저 축구 프로젝트

GitHub `topic:threejs soccer` 전수 검색 결과 총 11개, 대부분 습작 수준:

| 저장소 | 성격 |
|---|---|
| [alexadam/sport-stats](https://github.com/alexadam/sport-stats) (★74) | 3D 스포츠 통계 시각화, 게임 아님 |
| [immament/football-match-viewer](https://github.com/immament/football-match-viewer) (★13) | §6.1 — **유일하게 관련성 높음** |
| [collidingScopes/keep-ups](https://github.com/collidingScopes/keep-ups) | 웹캠 리프팅 게임, three + MediaPipe |
| [rebinnaf/small-size-soccer-game](https://github.com/rebinnaf/small-size-soccer-game) | 미완성 멀티플레이 |
| 기타 | 필드 모델링 습작, 엔드리스 러너 등 |

**결론: 브라우저에서 "결과가 정해진 축구를 3D로 그럴듯하게 재생한다"는 문제를
푼 오픈소스는 사실상 `football-match-viewer` 하나이며, 물리 엔진을 쓰지 않는다.**

### 6.4 물리 라이브러리 비용과 결정론

| 라이브러리 | 배포 크기 | gzip | 결정론 |
|---|---|---|---|
| `@dimforge/rapier3d` (WASM) | wasm 1.57 MB + glue 211 KB | **584 KB + 22 KB** | 아래 참조 |
| `@dimforge/rapier3d-compat` | 8.2 MB unpacked (wasm base64 인라인, `rapier.mjs` 2.24 MB) | 더 큼 | 동일 |
| `@dimforge/rapier3d-deterministic` | 8.3 MB unpacked (별도 패키지 존재) | – | `enhanced-determinism` 빌드 |
| `cannon-es` | 347 KB (min 아님) | 약 90 KB (**확인 필요** — 실측 안 함) | 보장 없음 |
| `ammo.js` (Bullet asm/wasm) | 1 ~ 3 MB | – | 보장 없음 |

*(rapier 수치는 npm 레지스트리에서 tarball을 내려받아 직접 측정 `[실측]`.
현재 프로젝트 의존성: three 0.185, pixi 8.19, react 19 — 이미 무겁다.)*

**Rapier의 결정론 주장**
([rapier.rs JS 결정론 문서](https://rapier.rs/docs/user_guides/javascript/determinism/),
[Rust 판](https://rapier.rs/docs/user_guides/rust/determinism/)):

> "The WASM/Typescript/JavaScript version of Rapier is fully cross-platform deterministic."
>
> 단서: "transcendental functions like `Math.sin`, `Math.cos` are not cross-platform
> deterministic and may give different results on different platforms" — **초기
> 조건을 만드는 코드가 결정론적이어야 한다.**
>
> Rust 판은 `enhanced-determinism` 피처가 필요하고, 그것은 `simd-nightly`,
> `simd-stable`, `parallel`과 **동시에 켤 수 없다**(성능 손해).

즉 rapier는 **부동소수점 비결정성 문제를 IEEE 754-2008 준수 + 초월함수 회피로
해결했다고 주장**하며, `world.createSnapshot()`의 MD5 해시 비교로 검증하라고
안내한다. 별도 `-deterministic` 패키지가 존재한다는 사실 자체가 기본 빌드의
보장 범위에 유보가 있음을 시사한다 — **어느 쪽을 써야 하는지는 확인 필요**.

**그러나 이 논의 자체가 우리에게는 부차적이다.** 다음 절에서 설명한다.

---

## 7. 권고안과 기각한 대안

### 7.1 기각: 물리 엔진(rapier / cannon-es / ammo) 도입

기각 사유는 결정론이 **아니다**(rapier는 결정론을 상당히 잘 처리한다).
진짜 이유는 세 가지다.

**(1) 우리 문제는 "예측"이 아니라 "역산"이다.**
엔진은 이미 `save`라고 정했다. 물리 엔진은 초기 조건 → 결과를 계산하는
**순방향** 도구다. 우리가 필요한 것은 결과 → 초기 조건의 **역방향**이다.
물리 엔진을 넣어도 "GK 손에 정확히 닿는 초기 속도"를 우리가 풀어서 넣어줘야
하고, 그 순간 물리 엔진은 우리가 이미 계산한 궤적을 재현하는 값비싼 적분기로
전락한다. 그 적분은 §2.1의 닫힌 형태로 **20줄이면 된다**.

**(2) 접촉이 없다.**
우리는 선수를 kinematic으로 조종하고 결과도 고정이다. 물리 엔진의 본체인
충돌 해결·마찰·관절은 쓸 데가 없다. 볼 하나의 탄도 적분을 위해 584 KB(gzip)를
싣는 셈이다.

**(3) 유일한 선례가 안 쓴다.**
문제 구조가 같은 `football-match-viewer`(§6.1)는 물리 엔진 없이 키프레임 트랙만
쓴다. 우리보다 조건이 좋은데도(0.5초 간격의 실제 위치 샘플을 서버에서 받는다)
그렇다.

**부수적으로**, 우리 `movement.ts`는 `Math.random`·`Date` 금지, FNV-1a 해시만
사용, "표시 전용 — 여기서 나온 좌표는 렌더러만 소비한다"는 계약을 헤더에 명시하고
있다. 리더보드·리플레이는 **엔진 시드에서 이벤트 배열을 재생**하는 것이지 3D
좌표를 저장하지 않는다. 따라서 표시 계층에서 `Math.exp`/`Math.log`를 쓰는 것은
결정론 계약과 무관하다. (엔진 `simulate.ts`·`rng.ts`는 계속 초월함수 금지.)

### 7.2 기각: 두 번째 연속 시뮬레이션 엔진

"공간을 아는" 미니 축구 시뮬을 하나 더 만들어 엔진 결과에 맞게 유도하는 방안.
`scenes.ts` 헤더가 이미 이 선택지를 검토하고 기각했고, 나도 동의한다 —
마감(2026-08-03) 대비 규모가 맞지 않고, 결과를 강제로 맞추려 하면 결국
지금과 같은 스크립트 연출로 수렴한다.

### 7.3 기각: dwell만 늘려서 느리게 만들기

가장 싼 방안이지만 틀렸다. §1.2에서 보듯 **문제는 구간의 절대 속도가 아니라
속도 프로파일이 평평하고 정지가 없다는 것**이다. dwell을 2배로 하면 25 m/s
패스가 12.5 m/s가 되어 슛보다 느려지고, 여전히 감속 없이 등속으로 미끄러진다.
"슬로모션인데 여전히 이상하다"가 된다.

### 7.4 **권고: 키프레임 위에 얹는 궤적 함수 + 앵커링 + 인과 스케줄러**

여섯 개의 변경. 우선순위 순.

---

#### R1. 볼 진행도를 항력 감속 곡선으로 (사용자 불만 ②)

**파일: `src/ui/pitch/three/movement.ts` — `sampleSequence()`**

현재:
```ts
const u = clamp((tc - a.t) / span, 0, 1)
ball: { x: lerp(a.ball.x, b.ball.x, u), y: lerp(a.ball.y, b.ball.y, u) }
```

수평 방향만 항력을 받는 1D 운동은 **닫힌 해가 있다**:
```
v(t) = v0 / (1 + k_d·v0·t)
s(t) = ln(1 + k_d·v0·t) / k_d
```
구간 거리 `S`와 소요 시간 `T`가 주어지면
```
v0 = (e^(k_d·S) − 1) / (k_d·T)
u(t) = ln(1 + (e^(k_d·S) − 1)·(t/T)) / (k_d·S)
```
`u(0)=0`, `u(T)=1`이 정확히 성립한다. **`lerp`의 `u`만 이 함수로 갈아끼우면
구조를 하나도 바꾸지 않고 물리적 감속을 얻는다.**

지면 구름 구간은 등감속(`a = μ_r·g ≈ 0.59 m/s²`)이 지배적이므로
`u(t) = (v0·t − a·t²/2) / S`, `v0 = S/T + a·T/2`를 쓴다.

높이는 `ballHeight()`의 사인 근사 대신 포물선으로:
```
y(t) = y0 + vz0·t − g·t²/2,  vz0 = (y1 − y0)/T + g·T/2
```
최고점이 `BALL_PEAK`를 넘지 않도록 `T`를 조정하거나 `vz0`를 클램프한다.
슛 아크의 "끝에서 정점" 형태(`sin(πu/2)`)는 물리적으로 틀렸다 — 제거하고,
슛은 낮은 각도의 포물선으로 그린다. **이것이 §1.5의 "골이 2.50 m로 들어간다"도
동시에 고친다.**

곡선(마그누스)이 필요하면 수평면 안에서 `k_l·v²·(σ×τ)`를 상수 횡가속으로
근사해 `lerp` 결과에 수직 오프셋 `0.5·a_lat·t²`를 더한다. 다만 **곡선은
지금 우선순위가 아니다** — 사용자는 "휘어진다"를 *불만*으로 적었다(발에서
출발하지 않는데 휘니까 이상한 것이다).

추가 상수(`movement.ts` 상단):
```ts
export const BALL_MASS = 0.43        // kg (규정 410~450 g의 중앙값)
export const AIR_DENSITY = 1.225     // kg/m³
export const DRAG_CD = 0.275         // Bray & Kerwin 2003 실측 평균
export const K_DRAG = 0.01489        // = ρ·A·Cd / 2m, m⁻¹
export const ROLL_DECEL = 0.59       // m/s², μ_r=0.06 (확인 필요)
```

**규모: `movement.ts` +약 80줄, 기존 `ballHeight`/`BALL_PEAK` 테스트 갱신.**

---

#### R2. 볼을 발에 앵커링 (사용자 불만 ①③) — **가장 중요**

두 갈래를 **둘 다** 한다.

**(a) `src/ui/pitch/scenes.ts` — 저술 좌표 수정**

`ScenePoint`에 캐리어 인덱스를 추가한다:
```ts
export interface ScenePoint {
  t: number
  ball: [number, number]
  movers: [number, number][]
  /** 이 스텝에서 공을 소유한 무버 슬롯(0~2). 지정하면 ball 좌표는 무시하고
   *  movers[carrier]에서 0.4 m 앞으로 자동 배치한다. */
  carrier?: 0 | 1 | 2
  arc?: BallArc
}
```
그리고 8개 빌드업 변형 × 3스텝의 `ball` 좌표를 무버 좌표에 맞춘다.
지금 6.7 ~ 17.9 m 떨어져 있는 것을 **0.4 ~ 0.6 m**로.
`finishPoints()`의 `boxMovers` / `netMovers`도 같은 규칙을 따라야 한다 —
슈팅 지점 `[dx, my]`에 대해 `boxMovers[0]`이 `[dx − 8, ly]`인데, 이러면
슈터가 슛 지점에서 8.4 m 뒤에 있다. `[dx − 0.5, my]`로 고쳐야 한다.

**(b) `src/ui/pitch/three/movement.ts` — 캐리어 스냅**

`football-match-viewer`의 `movePlayerToBall`과 같은 처방. 구간 시작 시점에서
**안무 무버 중 캐리어**를 볼 0.4 m 지점으로 강제 배치한다. 속도 클램프의
예외로 둘 수밖에 없다(안 그러면 뒤처진다) — 대신 **구간 시작 300 ms 전부터
목표를 볼 예정 위치로 옮겨 미리 달려가게** 하면 텔레포트 없이 도달한다.
즉 `planSide`가 무버 목표를 계산할 때 `t`가 아니라 `t + lookahead`로 샘플링한다.

동시에 `applyConvergence`의 `STANDOFF`를 1.2 → 1.8 m로 올려 **엉뚱한 일반
선수가 킥 판정 반경(3 m)에 들어오지 못하게** 한다. 그리고 `computeFrame`의
킥 판정을 "가장 가까운 아무나"에서 **"그 구간의 캐리어"** 로 바꾼다.

**규모: `scenes.ts` 데이터 재저술(8변형 × 3스텝 + 마무리 3변형) — 이게 작업량의
절반이다. `movement.ts` +약 50줄.**

---

#### R3. 킥 임팩트 정렬 + 히트스톱 (사용자 불만 ①)

**파일: `src/ui/pitch/three/movement.ts` — `computeFrame()` §4 액션 컨텍스트**

현재는 `actionT = sample.u / KICK_WINDOW`라 임팩트(`actionT ≈ 0.45`)가 볼 출발
**뒤**에 온다. **역방향 스케줄링**으로 바꾼다.

```ts
const KICK_IMPACT_T = 0.45      // pose.kickAngles의 접촉 프레임
const KICK_BACKSWING_MS = 250   // 백스윙 소요
const KICK_FOLLOW_MS = 300      // 팔로스루 소요
// 구간 시작 시각 tSeg(dwell 상대)에서 볼이 출발한다면
// 킥 액션 창 = [tSeg − backswing, tSeg + follow]
// actionT는 tSeg에서 정확히 KICK_IMPACT_T가 되도록 두 구간을 따로 매핑한다.
```

`t < tSeg`: `actionT = KICK_IMPACT_T · (t − tStart) / (tSeg − tStart)`
`t ≥ tSeg`: `actionT = KICK_IMPACT_T + (1 − KICK_IMPACT_T) · (t − tSeg) / (tEnd − tSeg)`

→ 첫 구간(t=0에서 시작하는 패스)은 백스윙을 넣을 시간이 없으므로 클립을
중간부터 시작한다(`football-match-viewer`의 `startFrom`). `t=0`에서
`actionT = KICK_IMPACT_T − ε`로 진입시킨다.

**히트스톱**: `FrameState`에 `impact?: { x,z, kind, age }` 필드를 추가하고
`Match3D`가 임팩트 프레임에서 **2프레임 동안 볼 위치를 고정 + FOV −1.5° +
파티클**을 트리거한다. `fx3d.goalBurst`를 12 ~ 20개 규모로 축소한 `kickBurst`
추가. 볼 스쿼시는 `fx3d.createBall`이 반환하는 메시에 2프레임 동안
`scale.set(0.88, 1.08, 1.0)`(진행 방향 기준)을 적용.

**규모: `movement.ts` +약 60줄, `types.ts` +5줄, `fx3d.ts` +약 60줄, `Match3D.tsx` +약 30줄.**

---

#### R4. GK 다이브 인과 (사용자 불만 ③)

**파일: `src/ui/pitch/three/movement.ts` (판정) + `src/ui/pitch/three/pose.ts` (커브)**

```ts
export const GK_REACTION_MS = 200   // 문헌 관례값(확인 필요)
export const GK_DIVE_MS = 550       // 도약→최대신전, 문헌 500~700의 하한
```

1. 슛 임팩트 시각 `tImpact`, 볼 도착 시각 `tArrive`를 시퀀스에서 구한다.
2. 다이브 시작 = `max(tImpact + GK_REACTION_MS, tArrive − GK_DIVE_MS)`.
   (짧은 슛이면 반응 지연이 우선 = 늦게 반응해도 도달, 긴 슛이면 역산 우선.)
3. `diveT`를 **"최대 신전 = 볼 도착"** 이 되도록 매핑한다.
   `diveAngles`의 `lay = smoothstep(u/0.55)`가 문제이므로 `u = 0.55·p`
   (p = 다이브 진행도 0~1)로 압축한 뒤, 도착 이후에는 `u`를 0.55 → 1로
   마저 진행시켜 착지·정착을 그린다. 또는 `diveAngles`를 고쳐
   `lay = smoothstep(u)`, `armReach = −2.2·smoothstep(u/0.9)`로 바꾼다
   (후자가 깔끔하지만 `pose.test.ts` 회귀가 있다 — 확인 필요).
4. `divingSide` GK가 **다이브 방향을 볼의 착지 y로 결정**해야 한다. 현재
   `diveAngles(t, dir)`의 `dir`가 어디서 오는지 `player3d.ts`를 봐야 한다
   (미확인 — 구현 시 확인).

같은 원리를 `celebrate`(골 확정 후)와 `down`(파울)에도 적용한다. 세리머니는
현재 `t >= goalT`에서 시작하는데 이건 옳다.

**규모: `movement.ts` +약 40줄, `pose.ts` 수정 약 10줄.**

---

#### R5. 구간 시간을 볼 속도에서 역산 + 터치 정지 (사용자 불만 ②)

**파일: `src/ui/pitch/scenes.ts`(t 계산) + `src/ui/match/playback.ts`(dwell)**

현재 `scenes.ts`는 `t`를 0, 0.16, 0.32, 0.52, 0.74로 **손으로 고정**한다.
거리와 무관하다. 12 m 패스와 25 m 크로스가 같은 시간을 받는다.

바꿀 것: 각 구간에 **의도 속도**를 붙이고 `t`를 유도한다.
```ts
const SEGMENT_SPEED: Record<BallArc, number> = {
  ground: 13,   // 짧은 지면 패스 m/s
  pass:   15,   // 살짝 뜬 패스
  cross:  20,   // 크로스
  shot:   25,   // 슛 (Bray & Kerwin 프리킥 실측값)
}
const TOUCH_MS = 400   // 패스 도착 → 다음 패스까지의 컨트롤 정지
```
1. 각 구간의 실거리 `S`(월드 m)를 계산 → `T = S / SEGMENT_SPEED[arc]`.
2. 구간 사이에 `TOUCH_MS`를 삽입한다 — **`ScenePoint`를 하나 더 넣어
   같은 좌표를 두 번(도착 t, 출발 t + touch) 쓴다.** 이러면 `sampleSequence`가
   그 사이에서 볼을 정지시킨다. 코드 변경 없이 데이터만으로 정지 구간이 생긴다.
3. 총합이 dwell을 넘으면 **빌드업 스텝을 3 → 2로 줄인다**(마무리는 못 줄인다).
4. `playback.ts`의 `EVENT_DWELL_MS`를 §4.4 표대로 조정하고
   `NO_EVENT_DWELL_MS`를 1800 → 1200으로.

**주의**: 안무 계약(빌드업 3 + 마무리 2, 마지막 t ≤ 0.8)을 렌더러와 테스트가
고정하고 있다(`scenes.ts` L208 주석). 계약 변경 = 테스트 갱신이 따라온다.

**규모: `scenes.ts` +약 70줄(t 자동 계산 함수) + 좌표 재저술,
`playback.ts` 상수 4개, `playback.test.ts`/`scenes.test.ts` 갱신. 이 항목이
가장 테스트 파급이 크다.**

---

#### R6. 선수 관성 (부수 효과: 전반적 무게감)

**파일: `src/ui/pitch/three/types.ts`(PlayerPose) + `movement.ts`**

`PlayerPose`에 `vx, vz`를 추가하고 `computeFrame` §3에서
```ts
const A_ACCEL = 7.0   // m/s² (확인 필요)
const A_BRAKE = 6.0
// 목표 속도 = seek/arrive 스티어링
// Δv를 |Δv| ≤ A·dt로 클램프
```
기존 `separatePoses`의 이동 예산 재투영은 그대로 유지하되, 재투영 후
`v`를 실제 이동량에서 다시 유도한다(현재 `speed`가 그렇게 계산되므로 동일 패턴).

추가로 상체 지연 스프링(§5.4-1)과 머리 look-at(§5.4-2)은 `player3d.ts`에서
값싸게 얻을 수 있다 — 우선순위는 R1~R5 뒤.

**규모: `types.ts` +4줄, `movement.ts` +약 40줄, `movement.test.ts` 갱신.**

---

### 7.5 부록: 즉시 고칠 수 있는 버그 2건

R1~R6과 별개로, 지금 당장 5분이면 고치는 것:

1. **아크 오프바이원**(§1.5). `scenes.ts` `finishPoints()`에서 `deliverArc`는
   `t0` 스텝이 아니라 **빌드업 마지막 스텝**에 붙어야 한다. 지금 구조에서는
   `buildScene()`이 `[...bv.points, ...finishPoints(...)]`로 이어 붙이므로
   `bv.points`의 마지막 원소를 복사해 `arc`를 덮어써야 한다. `t0` 스텝에는
   `'shot'`을 준다.
2. **골 진입 높이 2.50 m**(§1.5). `ballHeight('shot', u) = sin(πu/2)`를 포물선으로
   바꾸는 R1에 포함되지만, 임시로는 `BALL_PEAK.shot`을 2.5 → 1.6으로 내리기만
   해도 크로스바 아래로 들어간다.

---

## 8. 예상 비용

| 항목 | 번들 | 프레임 예산 | 작업 규모 | 테스트 파급 |
|---|---|---|---|---|
| R1 궤적 함수 | 0 | 볼 1개당 `exp`/`log` 각 1회 = 무시 | 0.5일 | `movement.test.ts` (`ballHeight`, `BALL_PEAK`) |
| R2 앵커링 | 0 | 0 | **1.5일** (좌표 재저술이 대부분) | `scenes.test.ts`, `choreography.test.ts`, 미러 계약 테스트 |
| R3 킥 정렬 + 히트스톱 | 0 (기존 fx3d 재사용) | 파티클 20개 추가 = 무시 | 0.5일 | `movement.test.ts`, `fx3d.test.ts` |
| R4 GK 인과 | 0 | 0 | 0.3일 | `movement.test.ts`, `player3d.test.ts` |
| R5 시간 역산 + 터치 | 0 | 0 | **1일** | `playback.test.ts`, `scenes.test.ts`, `highlight-mix.test.ts` |
| R5-b dwell 재캘리브 | 0 | – | 0.2일 | `playback.test.ts` 총합 가드 |
| R6 관성 | 0 | 22명 × 상수 = 무시 | 0.3일 | `movement.test.ts` 속도 클램프 불변식 |
| 버그 2건 | 0 | 0 | 0.1일 | `scenes.test.ts` |
| **합계** | **0 KB** | **무시 가능** | **약 4.4일** | 6개 테스트 파일 |

*(비교: rapier 도입은 gzip +606 KB, 위 작업의 대부분은 그래도 해야 하고,
결과 일치를 위한 역산 코드가 추가로 필요하다.)*

프레임 예산 관점에서 현재 병목은 물리가 아니라 렌더(three + 22 휴머노이드 리그 +
postfx)다. `perf.test.ts`가 이미 있으니 R1~R6 후에도 그것으로 회귀를 잡으면 된다.

### 권고 착수 순서

```
0일차: 버그 2건 (아크 오프바이원, 골 진입 높이) — 즉시 눈에 보이는 개선
1일차: R2(a) scenes.ts 좌표 재저술 ← 사용자 불만 ①③의 근원
2일차: R2(b) 캐리어 스냅 + R3 킥 정렬 ← "차는 느낌"
3일차: R1 궤적 함수 + R4 GK 인과
4일차: R5 시간 역산 + dwell 재캘리브
여유:  R6 관성, §5.4 상체 지연·머리 look-at
```

R2 → R3 → R1 순서가 중요하다. **앵커링 없이 궤적 함수만 넣으면 "물리적으로
정확하게 혼자 떠다니는 공"이 된다.**

---

## 9. 출처

**물리 상수**
- Bray, K. & Kerwin, D. G. (2003). *Modelling the flight of a soccer ball in a direct free kick*. Journal of Sports Sciences 21:75–85. — https://www.weizmann.ac.il/complex/falkovich/sites/complex.falkovich/files/uploads/FreeKick.pdf (C_d 0.25–0.30, C_l 0.23–0.29 실측 10회, 운동방정식 (1)–(6), Table 1)
- NASA Glenn Research Center — *Soccer Ball Drag*. https://www.grc.nasa.gov/www/k-12/airplane/socdrag.html (C_d = 0.25 기본값, 항력식)
- *Fundamental aerodynamics of the soccer ball* (Springer). https://link.springer.com/article/10.1007/BF02844207 (임계 Re 2.2–3.0×10⁵)
- *Aerodynamic Drag Measurements of FIFA-approved Footballs* (Procedia Engineering). https://www.sciencedirect.com/science/article/pii/S1877705814006353 (Nike Maxim 임계 Re 2.03×10⁵)
- Laws of the Game — Law 2 (질량·둘레·공기압). https://en.wikipedia.org/wiki/Ball_(association_football)
- 잔디 구름저항 (μ_r 0.05–0.07, **1차 문헌 아님**). https://www.noninfill.com/NEWS/Non-Infill-Artificial-Turf-vs-Natural-Grass-In-Depth-Analysis-of-Ball-Roll-and-Rebound-Compatibility-1014.html
- 볼롤 시험 표준 UNE-EN 12234. https://www.tiloom.com/en/tests-on-sporting-grounds-ball-rolling/

**골키퍼 / 인과**
- Zheng, R., de Reus, C., van der Kamp, J. (2021). *Goalkeeping in the soccer penalty kick: The dive is coordinated to the kicker's non-kicking leg placement*. Hum Mov Sci. https://pubmed.ncbi.nlm.nih.gov/33517202/
- Navarro, M. et al. (2012). *The effects of high pressure on the point of no return in simulated penalty kicks*. J Sport Exerc Psychol. https://pubmed.ncbi.nlm.nih.gov/22356884/

**경기 시간 / 하이라이트**
- Opta Analyst — Ball in Play / *How Long is a Football Match: The 90-Minute Myth*. https://theanalyst.com/
- The Guardian — *Long games, less action: how much is the ball in play in the Premier League*. https://www.theguardian.com/
- FM 하이라이트 모드 논의. https://community.sports-interactive.com/forums/topic/573903-extended-highlights-or-key-highlights/ , https://www.reddit.com/r/footballmanagergames/comments/md2b14/

**게임 필 / 연출**
- *Game Juice and Game Feel Explained: Hit Stop, Screen Shake and Feedback*. https://www.solana.garden/guides/game-juice-and-feel-explained/
- *Game feel on the web: squash, shake, and the art of juice*. https://valdemird.com/blog/game-feel-on-the-web/

**선수 운동학**
- PLOS ONE — *Spatiotemporal and kinetic characteristics during maximal sprint* (축구선수 67 vs 단거리 17). https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0322216
- MDPI Sports 6(4):169 — *Spatiotemporal and Kinetic Determinants of Sprint Acceleration*. https://www.mdpi.com/2075-4663/6/4/169

**웹 사례 / 라이브러리**
- immament/football-match-viewer. https://github.com/immament/football-match-viewer (데모 https://immament.github.io/football-match-viewer/)
- google-research/football (GameplayFootball 기반). https://github.com/google-research/football
- Rapier 결정론 문서 (JS). https://rapier.rs/docs/user_guides/javascript/determinism/
- Rapier 결정론 문서 (Rust, `enhanced-determinism` 제약). https://rapier.rs/docs/user_guides/rust/determinism/
- three.js `AnimationClip` / 보간 모드. https://threejs.org/docs/#api/en/animation/AnimationClip

---

## 10. 확인 필요 목록 (이 문서가 확정하지 못한 것)

1. 잔디 구름저항 계수 μ_r의 1차 문헌 값.
2. 프로 슛 속도(30–36 m/s)의 1차 논문. 현재는 대중 매체 집계값뿐.
3. 짧은 패스의 실측 초기 속도 분포.
4. GK 단순 반응 시간·다이브 지속(500–700 ms)의 1차 논문. Zheng 2021은 트리거가
   디딤발 착지라는 것만 확인해 준다.
5. 히트스톱 프레임 수의 근거 있는 출처(격투 게임 관행값 외).
6. 속도별 보폭·케이던스 실측표(PLOS/MDPI 논문 본문 접근 필요).
7. 축구선수 최대 가속/감속(7–8 / −4~−6 m/s²)의 1차 문헌.
8. Rapier JS에서 `rapier3d` vs `rapier3d-deterministic` 중 무엇이 실제로
   크로스플랫폼 결정론을 보장하는가(권고안이 rapier를 기각하므로 불필요).
9. GameplayFootball의 물리 백엔드(Bullet? ODE?).
10. `player3d.ts`에서 `diveAngles(t, dir)`의 `dir`가 어떻게 결정되는지 —
    R4 구현 전 확인.
