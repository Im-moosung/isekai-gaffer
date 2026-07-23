# 2026 FIFA 월드컵 — 팀/선수 스탯 소스 총람

> **용도**: 해커톤 게임 "리매치: 코리아 2026"의 팀 스탯 데이터 원천 조사. 팀별 상세는 `docs/research/teams/{can,mar,fra}.md`.
> **조사일**: 2026-07-24
>
> **신뢰도 규칙**: 🟢 교차확인 / 🟡 단일소스·세부미확인 / 🔴 소스충돌·미확인.

---

## 1. 스탯 제공 소스 목록 (지표·접근성·신뢰도)

| 소스 | URL | 제공 지표 | 접근성 | 신뢰도 |
|---|---|---|---|---|
| **FBref (StatsBomb 데이터)** | https://fbref.com/en/comps/1/World-Cup-Stats | 팀·선수 슈팅/패스/수비/점유/GK, **xG·xAG·프로그레시브·SCA/GCA**, 경기별 매치로그. 무료·다운로드 가능. 분석용 최적 | 무료, 표 복사·CSV | 🟢 (StatsBomb 계열, 공개 스탯 표준) |
| **FIFA 공식 통계** | https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/statistics | 공식 팀/선수 스탯: 득점·유효슈팅·xG·점유·패스·수비 액션. Match Centre 경기별 리포트 | 무료 | 🟢 (공식 1차) |
| **FIFA Training Centre (기술 리포트)** | https://www.fifatrainingcentre.com | 대회 **공식 기술 분석 리포트**(전술 트렌드·포메이션·피지컬 데이터). 전문가 관점 | 무료(대회 후 발간) | 🟢 (공식 분석) |
| **Opta / StatsPerform (The Analyst)** | https://theanalyst.com/competition/fifa-world-cup | 경기별 심층 스탯 기사(xG·빅찬스·패스맵), "64 Best Opta Facts" 등 팩트. Opta Player Stats 포털 | 기사 무료, 원데이터 유료 | 🟢 (업계 표준 데이터) |
| **Opta Player Stats 포털** | https://optaplayerstats.statsperform.com/en_GB/soccer/fifa-world-cup-2026-canada-mexico-usa/... | 선수·팀 상세 Opta 지표 대시보드 | 무료 뷰어 | 🟢 |
| **ESPN** | https://www.espn.com/soccer/ (report/match/player-stats by gameId) | 경기별 팀 스탯(점유·슈팅·유효·파울·코너·오프사이드), xG, 경기 분석·라인업 | 무료 | 🟢 |
| **FOX Sports** | https://www.foxsports.com/soccer/fifa-world-cup/team-stats | 팀 스탯 정렬(xG·점유시간·규율/파울 등 카테고리별 리더보드) | 무료 | 🟡 (Opta피드, 뷰어) |
| **FotMob** | https://www.fotmob.com/leagues/77/stats/... | 팀·선수 스탯 리더보드(평균 점유율·경기당 파울 등), 경기별 히트맵·평점 | 무료 앱/웹 | 🟡 (Opta피드 기반) |
| **Squawka** | https://www.squawka.com/en/news/world-cup/... | 스탯 리더 기사(파울 최다/피파울 등), Opta 정의 인용 | 무료 | 🟡 |
| **SofaScore / AiScore** | https://m.aiscore.com/tournament-fifa-world-cup/... | 경기당 파울·팀 스탯, 선수 평점 | 무료 | 🟡 (집계 뷰어) |
| **xGscore** | https://xgscore.io/xg-statistics/world-cup/2026 | xG 특화 통계 | 무료 | 🟡 |
| **worldcupranking / worldcupwiki / fwctimes 등** | (검색 다수) | 스쿼드·일정·요약 | 무료 | 🔴 (자동생성·미검증, 교차확인 전 사용금지) |

**권장 우선순위**: 스쿼드/공식수치 = **위키피디아 스쿼드 페이지 + FIFA 공식** → 분석용 상세 = **FBref + Opta(The Analyst)** → 경기별 빠른 확인 = **ESPN + FIFA Match Centre**. 🔴급 자동생성 사이트는 수치 소스로 쓰지 말 것.

---

## 2. 대회 전체 통계 요약 (교차확인)

### 스코어링·규율 🟢 (livescore "Through the Numbers" + beIN + 위키 교차)
- **총 득점 308골 / 104경기**, **경기당 평균 2.96골** — 1994(2.71)·2022(2.69) 상회, **1970년 이후 최고**(48개국 확대 첫 대회).
- 3골 이상 경기 58경기(55.8%), 양팀 득점 57경기(54.8%).
- **총 카드 281장, 경기당 2.70장**. **최다 카드: 아르헨티나 14장** / **최소: 튀니지·체코 각 1장**.
- 1골차 승부 35경기(43.8%), 선제팀 승리 81.3%. 클린시트 55회. 무승부 24회.
- 녹아웃 32경기 중 17경기가 1골차, 그러나 **승부차기는 조기 라운드 일부에만**(모로코-네덜란드, 독일-파라과이 등).

### 점유율/패스 경향 🟡 (Opta/FBref 기반 기사)
- **점유율 최상위: 스페인**(우승) — 패스 성공률 **93%**, 낮은 피xG. "볼이 전술적 목적에 봉사"(Opta).
- **잉글랜드**: 약 **58% 점유 + 대회 최다 빅찬스**로 후반라운드 최강 도전자.
- 전반적으로 **점유·압박형 상위팀(스페인·잉글랜드)과 효율·전환형(프랑스·모로코)** 의 대비가 뚜렷.
- 팀별 세부 점유율 순위는 FotMob "Average possession" / FBref Possession Stats 원문에서 확인: https://www.fotmob.com/leagues/77/stats/season/24254/teams/possession_percentage_team/world-cup-teams · https://fbref.com/en/comps/1/possession/World-Cup-Stats

### 파울 데이터 🟡
- 경기당 파울·피파울 리더는 Squawka(https://www.squawka.com/en/news/world-cup/stat-leaders-world-cup-2026-fouls/) 및 FotMob "Fouls per match"(https://www.fotmob.com/leagues/77/stats/season/24254/teams/fk_foul_lost_team/world-cup-teams)에서 집계. **구체 팀 순위는 이번 조사에서 수치 미추출 🔴** — 필요 시 원문 확인.

---

## 3. 전문가 분석·전술경향 기사 목록 (제목 + URL + 핵심 주장 1줄)

- **"The 64 Best Opta Facts of the 2026 FIFA World Cup" (Opta Analyst)** — https://theanalyst.com/articles/world-cup-2026-best-stats-facts-opta — 스페인 8경기 1실점(월드컵 우승팀 최소), 음바페 단일대회 10골(1970 뮐러 이후 최초), 모로코 아프리카 최초 8강 2회, 캐나다 카타르전 6골(유럽/남미 외 최초). 🟢
- **"World Cup 2026 Through the Numbers" (LiveScore)** — https://www.livescore.com/en/news/football/world-cup/world-cup-2026-through-the-numbers/ — 308골/104경기, 2.96골/경기, 카드 281장, 아르헨티나 최다 14카드 등 대회 총괄 수치. 🟢
- **"FIFA World Cup 2026 Posts Highest Goals-Per-Game Average in Nearly 60 Years" (beIN Sports)** — https://www.beinsports.com/en-us/soccer/fifa-world-cup-2026/articles/... — 경기당 2.96골로 1970 이후 최고, 48개국 포맷이 공격적 대회를 만듦. 🟢
- **"8 numbers that tell the World Cup's story over the first week" (Northeastern)** — https://news.northeastern.edu/2026/06/19/world-cup-first-week-analysis/ — 초반 득점 폭증·이변 데이터 분석. 🟡
- **"The 2026 World Cup So Far, By the Numbers: Just Under 3 Goals a Game" (SoccerAnalytics)** — https://socceranalytics.net/articles/world-cup-2026-so-far-by-the-numbers.html — 경기당 3골 근접, xG 대비 실득점 경향 분석. 🟡
- **"Highest Possession Statistics at World Cup 2026" (About the Championships)** — https://aboutchampionships.com/football-championship-2026/highest-possession-statistics-at-world-cup-2026-... — 스페인 점유율 최상위, 볼 소유의 전술적 목적 분석. 🟡
- **"2026 World Cup Stats Guide: The Football Stats That Coaches Should Actually Pay Attention To" (Zone14)** — https://zone14.ai/en/blog/football-data/world-cup-2026-football-statistics/ — 코치 관점 유효 지표(xG·PPDA·전환) 가이드. 🟡
- **경기별 Opta 심층 리포트(전술 근거용)**:
  - 네덜란드 1-1 모로코: https://theanalyst.com/articles/netherlands-vs-morocco-stats-world-cup-2026 — 네덜란드 5백 첫 도입 실패, 모로코 압박 우세. 🟢
  - 프랑스 3-0 스웨덴: https://theanalyst.com/articles/france-vs-sweden-stats-world-cup-round-of-32 — 프랑스 5경기 연속 3골+ 최장 기록. 🟢
  - 파라과이 0-1 프랑스: https://theanalyst.com/articles/paraguay-vs-france-stats-world-cup-2026-last-16 — 파라과이 패스성공 54%, 1966 이후 녹아웃 최저. 🟢

---

## 4. 게임 적용 메모

- **팀 스탯 시드값**: 스쿼드(이름·포지션·클럽·등번호)는 위키+FIFA 교차본(팀 파일 §1)을 사실 소스로. 등번호는 위키 단일이라 🟡 — 그대로 써도 무방.
- **경기 난이도/전술 파라미터**: 팀 파일 §2 경기별 점유율·xG·슈팅을 4축(점유/압박/템포/폭) 세팅 근거로 사용. 프랑스=고xG 전환형, 모로코=효율/저블록 가변형, 캐나다=점유열세 역습형.
- **선수 능력치**: EA FC 수치 복사 금지. 팀 파일 §4 정성 근거 + FBref/Opta 선수 페이지 원문으로 상대 서열만 도출.
- **파울/코너 등 미확보 지표**: FBref 매치로그 또는 FIFA Match Centre 경기 페이지에서 gameId별로 추가 확보 가능(팀 파일 §5 URL 참조).
