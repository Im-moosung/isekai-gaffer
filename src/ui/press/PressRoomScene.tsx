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
// 좌표는 전부 고정값이다 — src/ 안에서 Math.random 금지(결정론 계약).

// 안개 속 기자 한 명. x는 가로 위치, s는 크기 배율, o는 불투명도.
// 뒤로 갈수록 작고 흐리게 겹쳐 원근을 만든다.
const CROWD = [
  { x: 96, s: 0.86, o: 0.5 },
  { x: 196, s: 0.72, o: 0.38 },
  { x: 470, s: 0.94, o: 0.55 },
  { x: 566, s: 0.78, o: 0.42 },
  { x: 634, s: 0.66, o: 0.32 },
] as const

// 마이크 숲 — x(밑동), 각도, 길이. 전부 감독 쪽(가운데)을 향해 기울어 있다.
const MICS = [
  { x: 62, a: 26, len: 190 },
  { x: 122, a: 18, len: 232 },
  { x: 176, a: 30, len: 168 },
  { x: 236, a: 12, len: 205 },
  { x: 452, a: -16, len: 224 },
  { x: 510, a: -27, len: 178 },
  { x: 566, a: -14, len: 208 },
  { x: 626, a: -32, len: 160 },
] as const

export function PressRoomScene() {
  return (
    <svg
      className="pc-scene"
      viewBox="0 0 720 760"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* 카메라 플래시 — 조명 자체가 아니라 조명이 만든 안개의 밝기다. */}
        <radialGradient id="pc-flash">
          <stop offset="0%" stopColor="#cfe2ff" stopOpacity="0.9" />
          <stop offset="35%" stopColor="#7ea8e8" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>
        {/* 홀 안쪽 공기 — 위가 밝고 아래로 가라앉는다. */}
        <linearGradient id="pc-air" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#132441" stopOpacity="0.85" />
          <stop offset="70%" stopColor="#070c15" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#070c15" stopOpacity="0" />
        </linearGradient>
        {/* 가장자리 페이드 — 그림이 잘린 사각형으로 보이지 않게 배경색으로 녹인다.
            CSS mask를 여러 겹 쓰면 mask-composite 지원 편차에 걸리므로 그림 안에서 끝낸다. */}
        <linearGradient id="pc-fade-x" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#070c15" stopOpacity="1" />
          <stop offset="16%" stopColor="#070c15" stopOpacity="0" />
          <stop offset="82%" stopColor="#070c15" stopOpacity="0" />
          <stop offset="100%" stopColor="#070c15" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="pc-fade-y" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#070c15" stopOpacity="1" />
          <stop offset="26%" stopColor="#070c15" stopOpacity="0" />
        </linearGradient>
        {/* 안개. 뒷줄일수록 강하게 흐린다 — 거리감의 8할이 여기서 나온다. */}
        <filter id="pc-haze-far" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <filter id="pc-haze-mid" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="3.4" />
        </filter>
      </defs>

      <rect x="0" y="0" width="720" height="760" fill="url(#pc-air)" />

      {/* 광고보드 — 회견장 백드롭. 로고는 그리지 않는다(실존 상표 회피).
          색 조각만 안개 뒤에 두면 눈이 알아서 "스폰서 보드"로 읽는다. */}
      <g filter="url(#pc-haze-far)" opacity="0.5">
        <rect x="0" y="286" width="720" height="96" fill="#16233c" />
        <rect x="24" y="304" width="86" height="26" fill="#2c4470" />
        <rect x="132" y="304" width="54" height="26" fill="#8fb4e8" opacity="0.7" />
        <rect x="208" y="304" width="72" height="26" fill="#3a5a8f" />
        <rect x="470" y="304" width="64" height="26" fill="#7fa6de" opacity="0.6" />
        <rect x="556" y="304" width="96" height="26" fill="#2c4470" />
        <rect x="24" y="344" width="120" height="18" fill="#1d2f4e" />
        <rect x="500" y="344" width="150" height="18" fill="#1d2f4e" />
      </g>

      {/* 플래시 조명 — 시안의 좌우 두 광원. */}
      <g className="pc-scene__flash">
        <circle cx="52" cy="256" r="120" fill="url(#pc-flash)" />
        <rect x="18" y="228" width="58" height="46" rx="4" fill="#dce9ff" opacity="0.72" />
      </g>
      <g className="pc-scene__flash pc-scene__flash--b">
        <circle cx="614" cy="286" r="104" fill="url(#pc-flash)" />
        <rect x="588" y="264" width="50" height="40" rx="4" fill="#cfe0fa" opacity="0.6" />
      </g>

      {/* 기자단 — 머리 + 어깨 두 조각이면 사람으로 읽힌다. */}
      <g filter="url(#pc-haze-mid)">
        {CROWD.map(p => (
          <g key={p.x} transform={`translate(${p.x} 380) scale(${p.s})`} opacity={p.o}>
            <circle cx="0" cy="0" r="30" fill="#0d1729" />
            <path d="M-58 132 L-44 54 L-16 32 L16 32 L44 54 L58 132 Z" fill="#0b1424" />
            {/* 어깨 위 카메라 한 대 — 실루엣에 회견장 소품을 하나만 얹는다. */}
            <rect x="18" y="-26" width="46" height="30" rx="3" fill="#0a1220" />
            <circle cx="62" cy="-11" r="11" fill="#0a1220" />
          </g>
        ))}
      </g>

      {/* 마이크 숲 — 손잡이(가는 사각) + 헤드(둥근 캡슐). 앞줄이라 안개를 덜 먹인다. */}
      <g filter="url(#pc-haze-mid)" opacity="0.92">
        {MICS.map(m => (
          <g key={m.x} transform={`translate(${m.x} 760) rotate(${m.a})`}>
            <rect x="-6" y={-m.len} width="12" height={m.len} rx="5" fill="#0a1120" />
            <rect x="-13" y={-m.len - 40} width="26" height="52" rx="13" fill="#0c1626" />
            <rect x="-13" y={-m.len - 40} width="9" height="52" rx="5" fill="#16233c" />
          </g>
        ))}
      </g>

      {/* ───── 감독 뒷모습(로우폴리) ─────────────────────────────────────────
          면을 15개로 쪼개고 명도만 조금씩 다르게 준다. 각진 면이 보이는 것이
          목적이므로 그라데이션을 쓰지 않는다 — 시안의 "각진 로우폴리"가 곧
          "빛을 면 단위로 받는다"는 뜻이다. */}
      <g className="pc-scene__coach">
        {/* 양복 — 아래로 화면 밖까지 뻗어 인물이 화면에 서 있게 만든다. */}
        <polygon points="30,760 150,540 236,570 186,760" fill="#0a111e" />
        <polygon points="186,760 236,570 312,556 328,760" fill="#0d1524" />
        <polygon points="328,760 312,556 392,574 442,760" fill="#0b1320" />
        <polygon points="442,760 392,574 470,538 594,760" fill="#080e19" />
        <polygon points="150,540 202,474 268,446 312,556 236,570" fill="#101a2c" />
        <polygon points="312,556 348,446 414,478 470,538 392,574" fill="#0c1423" />
        {/* 셔츠 깃 — 유일하게 밝은 면. 뒷목 바로 아래가 이 그림의 초점이다. */}
        <polygon points="268,446 312,556 348,446 308,432" fill="#1a2942" />
        {/* 오른쪽 어깨 림라이트 */}
        <polygon points="414,478 470,538 452,556 400,492" fill="var(--gold, #e6b450)" opacity="0.34" />
        <polygon points="348,446 414,478 400,492 342,462" fill="var(--gold, #e6b450)" opacity="0.2" />

        {/* 목 */}
        <polygon points="268,396 348,398 356,452 262,450" fill="#0a1120" />

        {/* 머리 — 팔각 실루엣을 15면으로 분할.
            정점: A(310,150) B(372,168) C(410,220) D(416,292) E(396,352)
                 F(340,398) G(278,398) H(226,352) I(210,288) J(216,218) K(258,170)
            내부점: N1(286,232) N2(348,254) N3(310,336) */}
        <polygon points="310,150 372,168 286,232" fill="#111c30" />
        <polygon points="372,168 410,220 348,254" fill="#15223a" />
        <polygon points="372,168 348,254 286,232" fill="#0f1a2c" />
        <polygon points="410,220 416,292 348,254" fill="#182741" />
        <polygon points="416,292 396,352 310,336" fill="#131f34" />
        <polygon points="416,292 310,336 348,254" fill="#101a2d" />
        <polygon points="396,352 340,398 310,336" fill="#0d1626" />
        <polygon points="340,398 278,398 310,336" fill="#0a111e" />
        <polygon points="278,398 226,352 310,336" fill="#0b1322" />
        <polygon points="226,352 210,288 286,232" fill="#0c1425" />
        <polygon points="226,352 286,232 310,336" fill="#0e1728" />
        <polygon points="286,232 348,254 310,336" fill="#121d31" />
        <polygon points="210,288 216,218 286,232" fill="#0a1120" />
        <polygon points="216,218 258,170 286,232" fill="#0d1728" />
        <polygon points="258,170 310,150 286,232" fill="#101a2e" />

        {/* 귀 */}
        <polygon points="212,278 200,300 210,332 224,326" fill="#0b1322" />
        <polygon points="414,282 428,304 416,336 404,328" fill="#101a2e" />

        {/* 머리 오른쪽 위 림라이트 — 광원이 오른쪽 뒤에 있다는 단 하나의 단서. */}
        <polygon points="372,168 410,220 400,228 364,178" fill="var(--gold, #e6b450)" opacity="0.42" />
        <polygon points="410,220 416,292 406,290 400,228" fill="var(--gold, #e6b450)" opacity="0.28" />
        <polygon points="310,150 372,168 364,178 312,162" fill="var(--gold, #e6b450)" opacity="0.22" />
      </g>

      {/* 가장자리 페이드는 항상 맨 위에 온다. */}
      <rect x="0" y="0" width="720" height="760" fill="url(#pc-fade-x)" />
      <rect x="0" y="0" width="720" height="220" fill="url(#pc-fade-y)" />
    </svg>
  )
}
