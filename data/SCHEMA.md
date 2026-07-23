# 게임 데이터베이스 스키마 v1

> 리서치 문서(docs/research/teams/*.md)를 JSON DB로 변환할 때 따르는 정본 스키마.
> 원칙: **기본 정보(이름·포지션·국가·등번호)는 리서치에서 🟢 교차확인된 값만 사용. 절대 창작 금지.**
> 능력치·성향값은 자체 설정(더미)이되 리서치의 정성 근거에 기반해 산정.

## 파일 구조

```
data/
├── SCHEMA.md            ← 이 문서
├── teams/
│   ├── kor.json         ← 팀 1개 = 파일 1개 (12개국)
│   ├── cze.json ...
├── matches/
│   └── group-stage.json ← 조별 3경기 역사 스크립트 (실제 스코어·득점자·시간)
├── tactics/
│   ├── formations.json  ← 포메이션 정의 + 상성 행렬
│   └── roles.json       ← 포지션별 역할 정의 + 요구 스탯 프로필
└── licenses.md          → docs/assets-licenses.md 참조
```

## Team JSON

```jsonc
{
  "id": "kor",
  "name": { "ko": "대한민국", "en": "Korea Republic" },
  "fifaCode": "KOR",
  "flag": "🇰🇷",                    // 국기 이모지/유니코드만 (엠블럼 금지 — 설계 §9.1)
  "tier": 3,                        // 게임 난이도 티어 1(우승권)~4

  "profile": {                      // 전술 아이덴티티 (설계 §6.2)
    "preferredFormations": ["4-2-3-1", "4-4-2"],   // 실제 대회 사용 포메이션 (리서치 근거)
    "style": {                      // 4축, 각 0~100
      "possession": 45,             // 0=극단 역습, 100=극단 점유
      "pressing": 60,               // 압박 강도
      "lineHeight": 50,             // 수비 라인 높이
      "tempo": 65                   // 공격 전개 속도
    },
    "signatureXI": ["p_kor_01", "..."],   // 시그니처 선발 11인 (playerId)
    "keyPlayers": [{ "playerId": "p_kor_07", "dependency": 0.8 }],
    "benchPattern": "protect-lead", // protect-lead | chase-attack | balanced
    "styleNotes": "리서치 근거 요약 1-2문장 (워룸 리포트 노출용)"
  },

  "statBaseline": {                 // ★ 실제 대회 평균 스탯 → 시뮬 캘리브레이션 타깃
    "possession": 48.3,             // 실제 대회 평균 점유율 (%)
    "passAccuracy": 84.1,           // 실제 패스 성공률 (%)
    "shotsPerGame": 11.2,
    "shotsOnTargetPerGame": 4.0,
    "foulsPerGame": 12.7,
    "cornersPerGame": 4.3,
    "xgPerGame": 1.1,               // 미확인 시 null
    "source": "🟢|🟡 + 리서치 파일 참조"
  },

  "squad": ["Player", "..."]        // 아래 Player 스키마, 26인 (교차확인 실패 선수는 제외하고 사유 기록)
}
```

## Player JSON

```jsonc
{
  "id": "p_kor_07",
  "number": 7,                      // 🟢 교차확인 필수
  "name": { "ko": "손흥민", "en": "Son Heung-min" },   // 🟢 필수
  "position": "LW",                 // 주 포지션 (GK/CB/LB/RB/DM/CM/AM/LW/RW/ST) 🟢 필수
  "altPositions": ["ST", "RW"],     // 적합도 0.85 적용 포지션
  "foot": "R",                      // L | R | B | null(미확인)
  "birth": 1992,                    // 미확인 시 null
  "club": "클럽명",                  // 참고용, 미확인 시 null

  "stats": {                        // 필드: 6축 1~99 (자체 산정 — 산정 룰 아래)
    "shooting": 88, "passing": 82, "dribbling": 86,
    "defending": 45, "physical": 74, "pace": 84
  },
  // GK인 경우 stats 대신:
  // "gkStats": { "saving": 85, "aerial": 80, "buildup": 70 },

  "setPiece": 85,                   // 세트피스 적합도 1~99
  "penalty": 82,                    // 승부차기 성향 1~99
  "stamina": 78,                    // 체력 소모 저항
  "confidence": "🟢|🟡"             // 기본 정보의 리서치 신뢰도
}
```

## 능력치 산정 룰 (자체 설정의 일관성)

| 티어 | 앵커 | 범위 |
|---|---|---|
| 월드클래스 (발롱도르권) | 메시·음바페급 | 88~93 (주무기 축) |
| 국가대표 에이스/빅클럽 주전 | 손흥민·김민재급 | 82~88 |
| 유럽 중상위 리그 주전 | | 74~81 |
| 리그 로테이션/K리그 주전급 | | 66~73 |
| 스쿼드 뎁스 | | 58~65 |

- 주무기 축(예: 손흥민 슈팅)은 티어 상단, 약점 축(공격수의 defending)은 35~55
- **EA FC 등 상용 게임 수치를 복사하지 않는다** — 리서치의 정성 근거(활약·평판·클럽 수준)로 위 앵커에 맞춰 자체 산정
- 실존 선수 조롱 수준의 극단 저평가 금지 (설계 §7.1 세이프가드와 일관)
- 같은 팀 내 상대 서열이 실제 인식과 크게 어긋나지 않게 (검수 항목)

## 시뮬 캘리브레이션 계약 (엔진 구현 요구사항)

- 두 팀의 `statBaseline` + 양측 전술 지시로 경기 시뮬 시, **AI 기본 전술 상태에서 시뮬 100회 평균이 실제 대회 평균 스탯 ±15% 이내**여야 함 (점유율·슈팅·파울·패스 성공률)
- 예: 스페인 vs 중위 팀 → 점유율 60%대, 파울 적음 / 남아공 → 낮은 점유·많은 태클 등 "그 나라답게"
- 사용자 전술 개입은 이 베이스라인에서 출발해 편차를 만드는 구조 (개입 없으면 실제와 유사, 개입하면 달라짐)
- 밸런스 배치 테스트(설계 §16)에 이 캘리브레이션 검증 포함

## Formations / Roles JSON

- `formations.json`: 포메이션별 포지션 슬롯 좌표 + 상성 행렬(전술 리서치 문서 근거) — 전술 리서치(tactics-modern-football.md) 완료 후 확정
- `roles.json`: 포지션별 역할 2~3종, 역할별 요구 스탯 가중 프로필 (예: 인버티드 윙어 = shooting↑ + 역발 요구)
