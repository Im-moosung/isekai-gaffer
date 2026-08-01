# 에셋 라이선스 원장 (스펙 §9.1)

프로젝트에 포함된 외부 에셋의 출처·라이선스 기록. 새 에셋 추가 시 **라이선스 페이지를 직접 확인**하고 이 표에 등록한다. 라이선스가 불명확한 파일은 사용하지 않는다.

## 사운드 (public/sfx/)

Phase 4A Task 11 — 매치데이 사운드 리얼리티. 합성 노이즈를 실제 음원으로 교체.
전부 **CC0 1.0 (퍼블릭 도메인·귀속 불필요·상업 사용 허용)**. 출처 Freesound.org (로그인 불필요·프리뷰 CDN 직접 다운로드). Openverse API로 CC0 필터 검색 후 각 Freesound 사운드 페이지에서 라이선스 직접 확인.

| 파일 | 용도 | 원제 / 작성자 | 출처 URL | 라이선스 | 확인일 |
|------|------|--------------|----------|----------|--------|
| `public/sfx/crowd.mp3` | 관중 앰비언스 루프 (경기장 웅성) | "Stadium Crowd" / stomachache | https://freesound.org/s/274516/ | CC0 1.0 | 2026-07-25 |
| `public/sfx/goal.mp3` | 골 함성 폭발 (환호) | "Crowd Cheering" / SoundsExciting | https://freesound.org/s/365132/ | CC0 1.0 | 2026-07-25 |
| `public/sfx/concede.mp3` | 실망 탄식 (실점 시 관중 "aww") | "aww.wav" / phmiller42 | https://freesound.org/s/124996/ | CC0 1.0 | 2026-07-25 |
| `public/sfx/whistle.mp3` | 심판 휘슬 (킥오프·하프·풀타임·브레이크) | "Referee whistle sound.wav" / Rosa-Orenes256 | https://freesound.org/s/538422/ | CC0 1.0 | 2026-07-25 |

### 가공 내역
- `crowd.mp3` — 원본 8.2초 루프를 128kbps mp3로 재인코딩(변형 없음).
- `goal.mp3` — 원본 13.2초 중 앞 6초로 트림, 마지막 0.6초 페이드아웃.
- `concede.mp3` — 원본 2초 그대로 128kbps 재인코딩.
- `whistle.mp3` — 원본 0.5초 단일 취주. 코드에서 킥오프 1회·하프 2회·풀타임 3회·브레이크 1회로 반복 재생.
- 총 용량: 약 265KB (< 3MB 제약 충족).

### 폴백
로드 실패·`decodeAudioData` 미지원(SSR·jsdom·구형 브라우저) 시 `src/audio/sfx.ts`의 기존 Web Audio 순수 합성으로 자동 폴백한다. CC0이므로 귀속 표기 의무는 없으나 추적을 위해 출처를 기록한다.

## 국기 (public/flags/)

입장 연출 배너(스토리보드 컷1의 "태극기 / 상대편 국기")에 쓰는 국기 SVG 12장. 캠페인 등장 팀 전부를 덮는다 — `TEAM_IDS`(`src/data/loader.ts`)가 정본이고 **정확히 12개국**이다(kor·cze·mex·rsa·ecu·eng·nor·arg·esp·can·mar·fra). 매핑은 `src/ui/flags/flags.ts`의 `FLAG_FILE`이 `Record<TeamId, string>`이라 팀이 늘면 타입 에러로 먼저 걸린다.

**왜 국기를 쓰는가:** 스펙 §9.1이 금지한 것은 **협회 엠블럼·대표팀 크레스트·FIFA/월드컵 공식 로고**이고, 같은 문장이 팀 식별 수단으로 **지정한** 것이 "국기(퍼블릭 도메인) + 국가명 텍스트"다. 2026-08-01 정정 전까지 이를 "국기 금지"로 오독해 팀 색 tifo 배너를 썼다(경위: `docs/superpowers/specs/2026-08-01-entrance-storyboard.md` 하단 정정 절).

**왜 이모지 국기가 아닌가:** `docs/research/ui-redesign.md` G-4·H-6 — OS마다 도안이 다르고 **Windows는 국가 코드 두 글자로 렌더**한다. `data/teams/*.json`의 `flag` 필드(이모지)는 현재 코드에서 소비되지 않는다(`grep -rn '\.flag' src` 결과 0건).

**출처:** [lipis/flag-icons](https://github.com/lipis/flag-icons) `flags/4x3/*.svg` (main 브랜치). **라이선스 페이지를 직접 열어 확인**했다 — `https://raw.githubusercontent.com/lipis/flag-icons/main/LICENSE`가 **MIT License (c) 2013 Panayiotis Lipiridis** 전문을 반환한다(2026-08-01 확인). README는 별도 에셋 라이선스를 명시하지 않으므로 **파일 라이선스는 리포지토리 MIT가 적용**되고, 도안 자체는 각국이 공표한 국기라 저작권 대상이 아니다(퍼블릭 도메인). MIT는 저작권 고지 유지가 조건이므로 이 표가 그 고지 역할을 한다.

| 파일 | 용도 | 원제 / 작성자 | 출처 URL | 라이선스 | 확인일 |
|------|------|--------------|----------|----------|--------|
| `public/flags/kr.svg` | 대한민국(kor) 입장 배너 | flag-icons `flags/4x3/kr.svg` / Panayiotis Lipiridis 외 기여자 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/kr.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/cz.svg` | 체코(cze) | flag-icons `flags/4x3/cz.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/cz.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/mx.svg` | 멕시코(mex) | flag-icons `flags/4x3/mx.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/mx.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/za.svg` | 남아프리카공화국(rsa) | flag-icons `flags/4x3/za.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/za.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/ec.svg` | 에콰도르(ecu) | flag-icons `flags/4x3/ec.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/ec.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/gb-eng.svg` | 잉글랜드(eng) — 주권국이 아니라 ISO 알파-2가 없어 하위 구역 코드를 쓴다 | flag-icons `flags/4x3/gb-eng.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/gb-eng.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/no.svg` | 노르웨이(nor) | flag-icons `flags/4x3/no.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/no.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/ar.svg` | 아르헨티나(arg) | flag-icons `flags/4x3/ar.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/ar.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/es.svg` | 스페인(esp) | flag-icons `flags/4x3/es.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/es.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/ca.svg` | 캐나다(can) | flag-icons `flags/4x3/ca.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/ca.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/ma.svg` | 모로코(mar) | flag-icons `flags/4x3/ma.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/ma.svg | MIT (도안은 PD) | 2026-08-01 |
| `public/flags/fr.svg` | 프랑스(fra) | flag-icons `flags/4x3/fr.svg` / 〃 | https://github.com/lipis/flag-icons/blob/main/flags/4x3/fr.svg | MIT (도안은 PD) | 2026-08-01 |

### 가공 내역
- 원본은 `raw.githubusercontent.com/lipis/flag-icons/main/flags/4x3/<code>.svg`에서 그대로 받았다. **도안은 한 픽셀도 수정하지 않았다** — 국기는 변형하면 안 되는 도안이다.
- `svgo@3 --multipass -p 2`로 최적화. 원본이 이미 최소화돼 있어 절감은 **201,765 B → 197,636 B (-2.0%)** 에 그쳤다. 대부분이 문장(紋章) 패스 데이터(mx 83.5KB · es 79.3KB · ec 28.2KB = 전체의 96%)라 압축 여지가 없다.
- `<svg>`에 `width="640" height="480"`을 주입했다. flag-icons 원본은 `viewBox`만 있는데, 그러면 일부 브라우저에서 `<img>`의 고유 크기가 정해지지 않아 `drawImage`가 0×0으로 그린다.
- **총 용량: 197,936 B (약 193KB), gzip 52,795 B (약 52KB).** 3MB 제약 대비 6.4%(gzip 1.7%).
- **JS 번들 증가 0 B.** `public/` 아래 정적 자산이라 Vite 번들에 들어가지 않고, 경기당 **두 장만** 요청한다(한국 kr 0.9KB + 상대 1장). 최악 조합(멕시코전)도 84.5KB, gzip 30KB다.

### 폴백
`makeBannerCanvas`(`src/ui/pitch/three/textures.ts`)는 국기 이미지를 **선택 인자**로 받는다. 로드 실패·오프라인·jsdom(SVG 래스터라이저 없음)에서는 `loadFlagImage`가 `null`을 돌려주고 배너는 기존 **팀 색 폴백 도안**으로 남는다 — 입장 연출은 멈추지 않는다. jsdom은 `getContext('2d')`가 없어 `makeCanvas`가 `null`을 반환하는 경로도 그대로 유지된다.
