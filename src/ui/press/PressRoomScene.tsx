// src/ui/press/PressRoomScene.tsx
// 기자회견장 실루엣 — 감독의 뒷모습(로우폴리) 너머로 안개 속 기자단·마이크 숲·플래시.
//
// [왜 인라인 SVG인가]
// 저장소에 인물 이미지 자산이 없고, docs/refs의 시안 PNG는 런타임에 넣지 않는 것이
// 원칙이다(docs/refs/README.md — "완성 UI가 아니라 레이아웃·색 대비·감정 톤 참조").
// 뒷모습 실루엣은 얼굴이 없으므로 디테일이 필요 없다. 다각형 수십 개면 충분하고,
// 정적 SVG라 리렌더·rAF 비용이 0이다.
//
// [왜 상시 애니메이션이 없는가]
// 이 저장소에는 "새 상시 모션을 만들지 않는다"는 사용자 지시가 있다(AnalysisLayer.tsx).
// 플래시는 CSS에서 아주 느리고 얕은 밝기 변화만 주고(press.css .pc-scene__flash),
// prefers-reduced-motion에서는 꺼진다. SVG 자체는 완전히 정적이다.
//
// [왜 색을 하드코딩했는가]
// 실루엣은 "표면"이 아니라 그림이다. --s-1 같은 표면 토큰을 그림 음영에 쓰면 표면
// 위계(패널/패널 위 패널)의 뜻이 흐려진다. 대신 팔레트를 --s-0(#070c15) 계열 안에
// 가두고, 림라이트만 --gold를 참조해 토큰과 화면이 같은 온도를 갖게 했다.
//
// [가장자리 처리 — 두 번 틀린 곳이니 기록해 둔다]
// 그림은 사각형이고 배경은 그라데이션이라, 아무 처리 없이 얹으면 히어로에 상자
// 모서리가 그대로 보인다(실측 1600×900).
//  1차 시도: SVG 안에 배경색(#070c15)으로 가장자리 페이드 rect를 깔았다. 실패 —
//    .pc-root 배경이 단색이 아니라 radial-gradient라 페이드가 도착하는 색과 실제
//    페이지 색이 달라 이음매가 그대로 남았다. preserveAspectRatio="slice"였을 때는
//    페이드 rect 자체가 잘려 나가 아예 무용지물이었다.
//  현재: 가장자리는 CSS mask-image(radial-gradient) 한 겹으로 **투명하게** 없앤다
//    (press.css .pc-scene). 배경이 무엇이든 이음매가 생기지 않는다.
//    마스크 레이어를 한 겹만 쓰는 것도 의도다 — 두 겹부터는 mask-composite에 걸린다.
// preserveAspectRatio는 meet(전체 표시)다. 확대가 필요하면 CSS가 컨테이너를
// 히어로보다 크게 잡고 overflow로 자른다.
//
// [3차 수정 — "어둡게"가 아니라 "대비로 형태를 만든다"]
// 두 번째 판(2026-08-02 오전)은 전체를 균일하게 어둡게 깔았다. 결과는 실패였다.
// 인물(#0a1120대)과 안개(#1a2d4c에 opacity 0.44)의 명도가 거의 같아 경계가 서지
// 않았고, 화면에는 "어두운 형체"만 남아 **뒷모습이라는 것 자체가 안 읽혔다**.
// 실루엣은 정의상 "밝은 배경 위의 어두운 형태"다. 배경을 어둡게 하면 실루엣이
// 아니라 그냥 어둠이 된다. 그래서 이번 판은 세 가지를 뒤집었다.
//  1) 인물을 거의 검정(#03060d~#0b1424)으로 내리고, 뒤 조명 밴드를 크게 올렸다
//     (pc-air 46% 지점 #2a4a7c/0.92 + pc-halo 중심 #83abe0/0.5). 인물 명도가
//     배경 밴드의 1/6 수준이라야 윤곽이 선다.
//  2) 림라이트를 **면(polygon)에서 선(stroke)으로** 바꿨다. 이전 판은 머리 면
//     위에 금색 다각형을 얹어 얼굴을 가로지르는 띠 두 개로 보였다. 실루엣의
//     윤곽선을 그대로 따라가는 stroke여야 "빛이 가장자리를 스친다"가 된다.
//  3) 마이크는 인물보다 **앞**이므로 화면에서 가장 어둡고(#01040b) 가장 또렷해야
//     한다(전경 마이크는 블러를 아예 걸지 않는다). 앞이 흐리면 원근이 뒤집힌다.
//
// 좌표는 전부 고정값이다 — src/ 안에서 Math.random 금지(결정론 계약).

// 안개 속 기자 한 명. x는 가로 위치, s는 크기 배율, o는 불투명도.
// 뒤로 갈수록 작고 흐리게 겹쳐 원근을 만든다.
// x는 감독(288~490)을 피해 좌우로 갈라 둔다 — 겹치면 감독 뒤에 가려 형태만 뭉갠다.
// o가 0.3~0.5였을 때는 밝아진 밴드에 그대로 씻겨 나갔다. 배경이 밝아진 만큼
// 앞의 검정도 진해져야 한다.
const CROWD = [
  { x: 92, s: 0.82, o: 0.88 },
  { x: 194, s: 0.66, o: 0.6 },
  { x: 516, s: 0.84, o: 0.9 },
  { x: 596, s: 0.7, o: 0.68 },
  { x: 664, s: 0.58, o: 0.48 },
] as const

// 마이크 숲 — x(밑동), 각도, 길이. 전부 감독 쪽(가운데)을 향해 기울어 있다.
// 길이는 헤드가 밝은 밴드(y 300~520)에 닿도록 잡았다. 첫 판은 190~230이라
// 헤드가 y 520 아래 암부에 머물러 검정 위의 검정이 됐다 — 아예 안 보였다.
const MICS = [
  { x: 62, a: 26, len: 250 },
  { x: 122, a: 18, len: 292 },
  { x: 176, a: 30, len: 215 },
  { x: 236, a: 12, len: 262 },
  { x: 452, a: -16, len: 215 },
  { x: 510, a: -27, len: 232 },
  { x: 566, a: -14, len: 278 },
  { x: 626, a: -32, len: 205 },
] as const

// 감독보다 앞에 서는 마이크. 화면 양 끝에서 가운데를 향해 들어온다.
const FRONT_MICS = [
  { x: 24, a: 34, len: 268 },
  { x: 190, a: 22, len: 278 },
  { x: 618, a: -24, len: 300 },
  { x: 700, a: -36, len: 262 },
] as const

export function PressRoomScene() {
  return (
    <svg
      className="pc-scene"
      viewBox="0 0 720 760"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* 카메라 플래시 — 램프 자체가 아니라 램프가 만든 안개의 밝기다.
            중심을 순백(1.0)으로 두는 게 핵심이다. 첫 판은 중심이 #cfe2ff/0.9라
            "빛나는 것"이 아니라 "밝은 회색 덩어리"로 보였다. */}
        <radialGradient id="pc-flash">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="16%" stopColor="#e3eeff" stopOpacity="0.5" />
          <stop offset="42%" stopColor="#89b0ea" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>
        {/* 홀 안쪽 공기. 46% 지점(y≈350)이 가장 밝다 — 감독의 머리·어깨가 지나는
            높이다. 실루엣은 그 밝은 띠를 등지고 서야 형태가 잘린다. */}
        <linearGradient id="pc-air" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0d1a30" stopOpacity="0.5" />
          <stop offset="22%" stopColor="#1b3157" stopOpacity="0.82" />
          <stop offset="46%" stopColor="#2a4a7c" stopOpacity="0.92" />
          <stop offset="70%" stopColor="#1a2e4f" stopOpacity="0.7" />
          <stop offset="88%" stopColor="#0b1526" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#060b13" stopOpacity="0" />
        </linearGradient>
        {/* 인물 뒤 헤일로. 검은 실루엣은 **뒤가 밝아야** 읽힌다 — 첫 렌더에서 감독이
            안개와 같은 명도라 형체가 안 보였다. 조명이 인물 뒤에 있다는 설정이기도 하다. */}
        <radialGradient id="pc-halo">
          <stop offset="0%" stopColor="#83abe0" stopOpacity="0.5" />
          <stop offset="42%" stopColor="#4a76b4" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#24406e" stopOpacity="0" />
        </radialGradient>
        {/* 안개. 뒷줄일수록 강하게 흐린다 — 거리감의 8할이 여기서 나온다.
            mid는 3.4 → 2.6으로 줄였다. 기자단이 사람으로 읽힐 만큼은 또렷해야 한다.
            colorInterpolationFilters="sRGB"가 반드시 필요하다. SVG 필터의 기본값은
            linearRGB라, 어두운 남색(#060c17)을 블러하면 채널이 비선형으로 풀려
            **초록빛 회색**으로 번진다(실측: 기자단이 청록 얼룩으로 보였다). */}
        <filter
          id="pc-haze-far"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="8" />
        </filter>
        <filter
          id="pc-haze-mid"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        {/* 가장자리 페이드 — **SVG 안에서** 처리한다.
            이전에는 CSS mask-image로 .pc-scene 상자를 페이드했는데, 상자가 히어로보다
            크고(width 112%) 그림은 meet로 레터박스되어 상자 안쪽에 놓이므로,
            마스크의 페이드 구간이 히어로 바깥(overflow: hidden으로 잘리는 곳)에서
            끝나 버렸다. 결과는 히어로 경계에 딱 맞는 직사각형 이음매 — 배경이
            밝아지자 그대로 드러났다(실측 1600×900).
            마스크를 그림 좌표계 안에 두면 상자 크기·레터박스와 무관하게 그림 자신의
            가장자리에서 사라진다. 이건 "배경색으로 덧칠"이 아니라 진짜 투명이라
            페이지 배경이 무엇이든 이음매가 없다(파일 상단 1차 시도 실패 기록 참조).
            아래쪽은 페이드하지 않는다 — 인물은 프레임 아래로 걸어 나가야 하고,
            그 변은 어차피 히어로 밖으로 넘겨 잘라 낸다. */}
        <linearGradient id="pc-fade-l" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#000" stopOpacity="1" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pc-fade-r" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="1" />
        </linearGradient>
        {/* 상단 페이드는 이음매 지우기 겸 **제목 뒤 스크림**이다. 히어로 상단
            0~250(≈CSS 230px)이 제목 "경기 후 기자회견"과 부제가 앉는 띠다.
            중간 스톱(45%, 0.55)으로 위쪽을 오래 눌러 두면 글자 뒤가 거의 --s-0으로
            남고, 인물의 정수리(y 150)부터 서서히 그림이 드러난다.
            이 일을 CSS 스크림으로 하면 히어로 변에서 잘려 직사각형이 보인다
            (press.css .pc-scene 위 주석). 그림 안에서 해야 한다. */}
        <linearGradient id="pc-fade-t" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#000" stopOpacity="1" />
          <stop offset="45%" stopColor="#000" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <mask id="pc-edge">
          <rect x="0" y="0" width="720" height="760" fill="#fff" />
          <rect x="0" y="0" width="132" height="760" fill="url(#pc-fade-l)" />
          <rect x="588" y="0" width="132" height="760" fill="url(#pc-fade-r)" />
          <rect x="0" y="0" width="720" height="250" fill="url(#pc-fade-t)" />
        </mask>
      </defs>

      <g mask="url(#pc-edge)">

      <rect x="0" y="0" width="720" height="760" fill="url(#pc-air)" />

      {/* 광고보드 — 회견장 백드롭. 로고는 그리지 않는다(실존 상표 회피).
          색 조각만 안개 뒤에 두면 눈이 알아서 "스폰서 보드"로 읽는다.
          밴드 전체를 밝게 올려 인물 어깨가 여기에 실루엣으로 걸치게 한다. */}
      <g filter="url(#pc-haze-far)" opacity="0.66">
        <rect x="0" y="196" width="720" height="152" fill="#23395e" />
        <rect x="18" y="222" width="92" height="30" fill="#4d76b8" />
        <rect x="128" y="222" width="58" height="30" fill="#a8c6ee" />
        <rect x="204" y="222" width="76" height="30" fill="#3f6098" />
        <rect x="470" y="222" width="68" height="30" fill="#93b6e6" />
        <rect x="558" y="222" width="102" height="30" fill="#4d76b8" />
        <rect x="18" y="272" width="130" height="20" fill="#2c4670" />
        <rect x="498" y="272" width="162" height="20" fill="#2c4670" />
      </g>

      {/* 감독 뒤 헤일로 — 실루엣과 안개를 갈라 주는 유일한 장치.
          머리(y 150~400)와 어깨(y 460~630)를 함께 덮도록 중심을 내렸다. */}
      <ellipse cx="352" cy="336" rx="366" ry="336" fill="url(#pc-halo)" />

      {/* 플래시 조명 — 시안의 좌우 두 광원. 램프 몸통은 **순백**이다.
          주변으로 번지는 것은 위 radialGradient가 맡고, 여기서는 "여기가 광원"
          이라고 단정하는 흰 사각형 하나만 둔다. 흐린 회색은 조명으로 안 보인다.
          왼쪽 램프의 y는 336이다. 시안처럼 220에 두면 히어로 좌상단, 즉 제목
          "경기 후 기자회견" 바로 뒤에 흰 덩어리가 놓인다. 제목 뒤를 어둡게 까는
          스크림(press.css .pc-hero::before)이 그 램프까지 함께 눌러 조명이 회색
          덩어리로 돌아왔다 — 둘이 겹치지 않게 램프를 부제 아래로 내렸다. */}
      <g className="pc-scene__flash">
        <circle cx="66" cy="336" r="140" fill="url(#pc-flash)" />
        <rect x="28" y="304" width="76" height="62" rx="5" fill="#eaf2ff" opacity="0.55" />
        <rect x="34" y="310" width="64" height="50" rx="3" fill="#ffffff" opacity="0.94" />
      </g>
      <g className="pc-scene__flash pc-scene__flash--b">
        <circle cx="612" cy="286" r="122" fill="url(#pc-flash)" />
        <rect x="578" y="260" width="68" height="54" rx="5" fill="#e4eeff" opacity="0.45" />
        <rect x="584" y="266" width="56" height="42" rx="3" fill="#ffffff" opacity="0.88" />
      </g>

      {/* 기자단 — 머리 + 어깨 두 조각이면 사람으로 읽힌다. */}
      <g filter="url(#pc-haze-mid)">
        {CROWD.map(p => (
          <g key={p.x} transform={`translate(${p.x} 380) scale(${p.s})`} opacity={p.o}>
            <circle cx="0" cy="0" r="30" fill="#060c17" />
            <path d="M-58 132 L-44 54 L-16 32 L16 32 L44 54 L58 132 Z" fill="#050a13" />
            {/* 어깨 위 카메라 한 대 — 실루엣에 회견장 소품을 하나만 얹는다. */}
            <rect x="18" y="-26" width="46" height="30" rx="3" fill="#04080f" />
            <circle cx="62" cy="-11" r="11" fill="#04080f" />
          </g>
        ))}
      </g>

      {/* 마이크 숲 — 손잡이(가는 사각) + 헤드(둥근 캡슐). 앞줄이라 안개를 덜 먹인다. */}
      <g filter="url(#pc-haze-mid)" opacity="0.96">
        {MICS.map(m => (
          <g key={m.x} transform={`translate(${m.x} 760) rotate(${m.a})`}>
            <rect x="-8" y={-m.len} width="16" height={m.len} rx="7" fill="#03070f" />
            <rect x="-17" y={-m.len - 52} width="34" height="68" rx="17" fill="#050a14" />
            <rect x="-17" y={-m.len - 52} width="11" height="68" rx="5" fill="#16233c" />
          </g>
        ))}
      </g>

      {/* ───── 감독 뒷모습(로우폴리) ─────────────────────────────────────────
          면을 15개로 쪼개고 명도만 조금씩 다르게 준다. 각진 면이 보이는 것이
          목적이므로 그라데이션을 쓰지 않는다 — 시안의 "각진 로우폴리"가 곧
          "빛을 면 단위로 받는다"는 뜻이다.
          면들의 명도차는 아주 좁다(#03060d~#0b1424). 배경 밴드가 #2a4a7c대라
          이 정도만 되어도 면은 보이고 전체는 검정으로 읽힌다. */}
      {/* 세로 이동은 0이다. 이전 판은 -66으로 인물을 띄웠는데, 그러면 하단 1/4이
          비어 인물이 프레임에 서 있지 않고 떠 있는 그림이 됐다. 어깨가 밝은 띠
          (y 200~560)에 걸리는지는 헤일로를 내려서 해결했다.
          가로 +72는 제목("경기 후 기자회견")과 머리가 겹치지 않게 하는 값이다. */}
      <g className="pc-scene__coach" transform="translate(72 0)">
        {/* 양복 — 어깨 폭은 머리의 2배 이상이어야 한다. 처음엔 320px(머리 206px의
            1.55배)이라 어깨가 아니라 치마처럼 좁게 흘러내렸다. 444px로 넓혔다.
            아래로는 화면 밖(y 900 > viewBox 760)까지 뻗어 인물이 화면에 서 있게 만든다. */}
        <polygon points="46,900 96,596 200,620 170,900" fill="#04070e" />
        <polygon points="170,900 200,620 310,606 322,900" fill="#060a14" />
        <polygon points="322,900 310,606 430,624 460,900" fill="#050810" />
        <polygon points="460,900 430,624 540,592 596,900" fill="#03060c" />
        {/* 어깨 면. 광원이 오른쪽 뒤라 오른쪽 면이 밝다. */}
        <polygon points="96,596 170,540 262,466 310,606 200,620" fill="#060b16" />
        <polygon points="310,606 356,468 452,542 540,592 430,624" fill="#070c17" />
        {/* 셔츠 깃 — 뒷목 바로 아래. 처음엔 어깨를 가로지르는 큰 삼각형이라
            넥타이나 어깨띠처럼 읽혔다. 목덜미 폭으로 줄이고 명도도 낮춘다.
            #101b30까지 올렸더니 이번엔 가슴 한가운데 밝은 삼각형이 떠서 넥타이가
            됐다. 실루엣 안에서 눈에 띄는 밝은 면은 하나도 있으면 안 된다. */}
        <polygon points="272,470 310,528 348,470 310,454" fill="#0a1120" />

        {/* 목 */}
        <polygon points="272,392 348,394 356,472 264,470" fill="#03060c" />

        {/* 머리 — 팔각 실루엣을 15면으로 분할.
            정점: A(310,150) B(372,168) C(410,220) D(416,292) E(396,352)
                 F(340,398) G(278,398) H(226,352) I(210,288) J(216,218) K(258,170)
            내부점: N1(286,232) N2(348,254) N3(310,336) */}
        <polygon points="310,150 372,168 286,232" fill="#070c18" />
        <polygon points="372,168 410,220 348,254" fill="#0b1424" />
        <polygon points="372,168 348,254 286,232" fill="#060a14" />
        <polygon points="410,220 416,292 348,254" fill="#0b1223" />
        <polygon points="416,292 396,352 310,336" fill="#080e1c" />
        <polygon points="416,292 310,336 348,254" fill="#070c18" />
        <polygon points="396,352 340,398 310,336" fill="#05080f" />
        <polygon points="340,398 278,398 310,336" fill="#03060c" />
        <polygon points="278,398 226,352 310,336" fill="#04070e" />
        <polygon points="226,352 210,288 286,232" fill="#04080f" />
        <polygon points="226,352 286,232 310,336" fill="#050911" />
        <polygon points="286,232 348,254 310,336" fill="#080d1a" />
        <polygon points="210,288 216,218 286,232" fill="#03060c" />
        <polygon points="216,218 258,170 286,232" fill="#050810" />
        <polygon points="258,170 310,150 286,232" fill="#070c17" />

        {/* 귀 */}
        <polygon points="212,278 200,300 210,332 224,326" fill="#03060c" />
        <polygon points="414,282 428,304 416,336 404,328" fill="#080d1a" />

        {/* ── 림라이트 ─────────────────────────────────────────────────────
            **윤곽선을 따라 흐르는 선**이다. 면이 아니다. 이전 판은 머리 면 위에
            금색 다각형을 얹어 얼굴을 가로지르는 대각선 띠 두 개로 보였다.
            stroke를 윤곽 위에 얹으면 절반은 인물 안, 절반은 밝은 배경 쪽으로
            걸쳐 "가장자리를 스친 빛"이 된다.
            광원이 오른쪽 뒤이므로 오른쪽이 굵고 밝다. 왼쪽은 존재만 알리는
            수준(0.16)이다 — 양쪽이 같으면 광원이 없는 그림이 된다. */}
        <g fill="none" stroke="var(--gold, #e6b450)" strokeLinecap="round" strokeLinejoin="round">
          {/* 머리 오른쪽 — 정수리(B)에서 관자놀이(C)를 돌아 턱선(E)까지 */}
          <path d="M372,168 L410,220 L416,292" strokeWidth="5" opacity="0.82" />
          <path d="M310,150 L372,168" strokeWidth="4" opacity="0.42" />
          <path d="M416,292 L396,352" strokeWidth="4" opacity="0.48" />
          <path d="M396,352 L340,398" strokeWidth="3" opacity="0.16" />
          {/* 귀 가장자리 한 획 — 광원이 뒤에 있으면 귀 윤곽이 먼저 탄다 */}
          <path d="M414,282 L428,304 L416,336" strokeWidth="3" opacity="0.4" />
          {/* 머리 왼쪽 — 반사광 수준 */}
          <path d="M258,170 L216,218 L210,288" strokeWidth="3" opacity="0.14" />
          {/* 오른쪽 어깨 — 목덜미에서 어깨끝을 지나 팔로 흘러내린다 */}
          <path d="M356,468 L452,542 L540,592" strokeWidth="5" opacity="0.6" />
          <path d="M540,592 L570,748" strokeWidth="4" opacity="0.22" />
          {/* 왼쪽 어깨 — 반대편 약한 빛 */}
          <path d="M262,466 L170,540 L96,596" strokeWidth="3" opacity="0.18" />
          {/* 깃 — 어깨선과 목 사이를 갈라 주는 한 획 */}
          <path d="M272,470 L310,454 L348,470" strokeWidth="2.5" opacity="0.3" />
        </g>
      </g>

      {/* 전경 마이크 — 감독보다 **앞**에 선다. 손에 들린 마이크가 어깨를 살짝 가려야
          "그가 마이크 숲을 마주하고 있다"가 되지, 전부 뒤에 있으면 배경 무늬가 된다.
          블러를 걸지 않는다. 앞에 있는 것이 뒤보다 흐리면 원근이 뒤집힌다 —
          이전 판은 여기에 haze-mid를 먹여 마이크 숲이 통째로 사라졌다. */}
      <g opacity="0.97">
        {FRONT_MICS.map(m => (
          <g key={m.x} transform={`translate(${m.x} 760) rotate(${m.a})`}>
            <rect x="-9" y={-m.len} width="18" height={m.len} rx="8" fill="#01040b" />
            <rect x="-21" y={-m.len - 62} width="42" height="80" rx="21" fill="#02050d" />
            <rect x="-21" y={-m.len - 62} width="12" height="80" rx="6" fill="#1b2c48" />
          </g>
        ))}
      </g>

      </g>
    </svg>
  )
}
