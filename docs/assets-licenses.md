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
