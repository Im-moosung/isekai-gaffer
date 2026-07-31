# 2026 월드컵 징계 규정 — 경고 누적·출장정지

조사일 2026-07-31. 구현 대응은 `src/game/campaignStore.ts`(`applyDiscipline`).

## ⚠ 가장 중요한 함정

**2026 규정은 2026년 4~5월에 개정됐다.** 2025년 5월판 규정 PDF 원문(Art. 10.3)만 읽으면
"경고는 8강 후 1회 소멸"(=2022와 동일)로 잘못 구현한다. FIFA 평의회가 2026-04-28 밴쿠버
회의에서 **조별리그 종료 후에도 한 번 더 지우도록** 개정했다. 개정판을 반영한 PDF는 공개된
것을 찾지 못했고, 개정 사실은 FIFA 공식 발표로 확정된다.

## 규정 ↔ 구현 대응표

| # | 규정 | 출처 | 등급 | 구현 |
|---|---|---|---|---|
| 1 | 서로 다른 두 경기에서 경고 1장씩 = 2장 누적 → 다음 경기 자동 출장정지 | FWC26 Regulations (MAY 2025) Art. 10.4 / FIFA Disciplinary Code 2025 Art. 67.1 | 공식 | `CAUTION_THRESHOLD = 2`. `applyDiscipline` (3)단계에서 임계 도달 시 `bans += 1`, `cautions = 0` |
| 2 | 누적 경고 소멸 = **조별리그 종료 후 + 8강 종료 후, 총 2회** | FIFA Council 2026-04-28 개정 (inside.fifa.com 2026-05-08 발표), fifa.com 기사, BBC 2026-06-12 교차확인 | 공식 | `CAUTION_WIPE_AFTER = ['group3', 'qf']`. (4)단계에서 **미소멸 경고만** 삭제 — 확정된 정지는 남는다 |
| 3 | 퇴장(직접/간접 무관) → 다음 경기 자동 정지. 사안별 가중 가능 | FWC26 Art. 10.5 / FDC 2025 Art. 66.4 | 공식 | `RED_SUSPENSION = 1`. 가중은 미구현(아래 "구현하지 않은 것") |
| 4 | 2옐로 퇴장(indirect red)의 처분은 직접 레드와 **동일한 1경기** | FWC26 Art. 10.5 ("direct **or indirect** red card (second caution)") | 공식 | 레드 종류를 구분하지 않고 `bans += 1` |
| 5 | 2옐로 퇴장을 구성한 두 경고는 누적으로 남지 않는다 | FDC 2025 Art. 67.4의 **반대해석** — "직접 레드일 때만 같은 경기의 기존 경고가 유지된다"고 명시 | **부분 확인** (명문 조항 없음) | `tally.yellows >= 2 && reds > 0`이면 2장을 빼고 누적 |
| 6 | 직접 레드일 때 같은 경기의 **기존 경고는 유지**된다 | FDC 2025 Art. 67.4 (명문) | 공식 | `yellows < 2 && reds > 0`이면 그 경고를 그대로 누적에 더한다 |
| 7 | 결승전 특칙(사면 등) **없음**. 8강 후 소멸 때문에 누적으로 결승 결장은 구조적으로 불가하나, 4강 퇴장 정지는 결승에 그대로 적용 | FWC26 Art. 10 전문 | 공식 | 별도 분기 없음 — 자연히 그렇게 동작한다 |
| 8 | 3-4위전도 대회의 한 경기. 정지 소화 대상 | FWC26 Art. 12.1 / 12.10, FDC 14.3 | 공식 | 이 게임의 캠페인에 3-4위전이 없어 해당 없음 |
| 9 | 대회 중 소화하지 못한 정지는 대표팀 **다음 공식경기로 이월** | FWC26 Art. 10.6 / FDC 69.2(a) | 공식 | 캠페인이 끝나면 상태가 폐기된다 — 게임 범위 밖 |

## 소멸 타임라인 (2026)

| 구간 | 누적 카운트 |
|---|---|
| 조별 1~3차전 | 2장 누적 → 다음 경기(조별 또는 32강) 결장 |
| **조별 종료** | **미소멸 경고 전원 소멸** |
| 32강·16강·8강 | 이 3경기 안에서 2장 누적 → 다음 경기 결장 |
| **8강 종료** | **미소멸 경고 전원 소멸** |
| 4강·결승 | 남은 경기 수가 부족해 누적 정지는 사실상 불가 |

## 구현하지 않은 것 (의도적)

- **퇴장 가중치**(FDC 14.1): 난폭한 태클 최소 2경기, 폭력행위 최소 3경기, 심판 폭행 15경기 등.
  엔진의 `red` 이벤트는 퇴장의 **사유**를 남기지 않으므로(`simulate.ts`의 `sendOff`) 가중을
  판정할 근거가 없다. 규정이 보장하는 최소치인 **1경기**만 적용한다 — 보수적 선택이다.
- **징계위원회 재량**(FDC 68: 대회당 1회 경고 취소 / 정지 유예). 2026 대회에서 실제로
  Balogun 건에 적용된 선례가 있으나, 결정론 시뮬에 재량 개입을 넣을 근거가 없다.
- **예선 → 본선 이월**(Bureau of the Council 2026-05-08 개정). 캠페인이 본선부터 시작한다.

## 확인하지 못한 것

- FWC26 Art. 10.7이 위임하는 **circular letter**의 세부 운영규칙 — 원문 미입수.
- 개정을 반영한 **갱신 규정 PDF** — 공개본을 찾지 못했다. 규정 PDF 원문은 비공식 미러에서
  취득했고, FIFA 평의회 발표가 인용한 Art. 10.2 문구와 문자 그대로 일치해 진본으로 판단했다.
- 항목 5(2옐로의 두 경고 미합산)는 **명문 조항이 아니라 FDC 67.4의 반대해석**이다.

## 출처

- FWC26 Regulations (MAY 2025): https://www.worldcup2026football.co.uk/wc-2026-regulations.pdf (비공식 미러)
- FIFA Council 개정 발표: https://inside.fifa.com/organisation/fifa-council/news/council-update-regulations-world-cup-2026
- FIFA 기사: https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/yellow-cards-reset-group-stage-quarter-final
- BBC (2026-06-12): https://www.bbc.com/sport/football/articles/cd95xz5xndlo
- FIFA Disciplinary Code 2025: https://www.fifa.com/documents/static/regulations/FIFA_disciplinary_code_en.pdf
