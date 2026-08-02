## 시연영상 보이스 82개 재합성 및 끝부분 검수 완료
- 상태: done
- 산출물: docs/video/vo/ 82개 WAV 교체, docs/video/vo/report.json 갱신
- 확인 필요: 합성 중 `…… 잠시만요.` 캐리어를 붙여 끝 감쇠를 만든 뒤 캐리어 음성은 제외하고 경계 무음 끝까지 잘랐습니다. 활성 82개 기준 마지막 50ms mean 중앙값 -40.45dB, -30dB 초과 0개, 꼬리 무음 0.4초 이상, 음절 속도 10/초 초과 0개, 무음 0개입니다.
- 막힌 것: 없음. 지시대로 C1-04·C2-04·C2-05·C2-06 4개는 재생성하지 않고 기존 파일을 유지했으며, 이 4개는 끝 무음 기준 검수 대상에서 제외했습니다.

## 시연영상 보이스 잘림 30개 재생성 및 86개 음절 속도 QC 완료
- 상태: done
- 산출물: docs/video/vo/ redo.tsv 대상 30개 WAV 교체 및 report.json 갱신
- 확인 필요: 30개 모두 음절당 초 10.0 이하·끝 무음 0.3초 이상; 전체 86개 재검사 통과(C6-04는 기존 음성 뒤 0.32초 무음만 추가)
- 막힌 것: 없음 (volumedetect max_volume 기준 무음 0)

## 시연영상 가이드 보이스 86개 큐별 생성 완료
- 상태: done
- 산출물: docs/video/vo/ C1-01.wav~C10-02.wav 86개 및 docs/video/vo/report.json
- 확인 필요: 화면 동작 타이밍에 맞춘 큐별 청취; 숫자 큐는 한글 발음으로 생성(C7-12 조건부 큐 포함)
- 막힌 것: 없음 (volumedetect max_volume 기준 무음 0, 누락 0, 포맷 오류 0)

## 극장골 직전·직후 누락 캐스터 3개 처리 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/l/ 3개 처리(기존 키 1개 교체·신규 2개 추가), report.json·metadata.json 갱신
- 확인 필요: 절정 문구 3개의 감정 고조와 기존 `골! 극장골입니다!` 연결 청취
- 막힌 것: 없음

## 교체·개입 반응 누락 캐스터 18개 생성 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/l/ 18개 추가, report.json·metadata.json 갱신
- 확인 필요: plain 5개·head 3개·tail 10개의 실제 문맥 연결과 교체 중계 억양 청취
- 막힌 것: 없음

## 전술 변경 후 누락된 고정 중계 41개 생성 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/l/ 41개 추가, report.json·metadata.json 갱신
- 확인 필요: 해설 40개·캐스터 1개가 실제 전술 변경 문맥에서 자연스럽게 이어지는지 청취
- 막힌 것: 없음

## 무음 25개 재생성 및 파형 검증 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/l/ 25개 교체, report.json·metadata.json 갱신
- 확인 필요: 직접 생성 2개와 carrier-tail 폴백 23개 청취
- 막힌 것: 없음

## 경기 중계 744개 생성 및 QC 보정 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/l/ 744개 WAV, report.json·metadata.json 갱신
- 확인 필요: 재시도 8개(전부 캐리어 교체)와 QC 16개(전부 직접 생성) 청취; 하한 0.058 미만은 `l/01bfff116d` 1건(0.057875)만 남음
- 막힌 것: 없음

## 경기 중계 파일럿 100개 생성 완료 · 갱신된 744개 목록 확인
- 상태: needs-decision
- 산출물: docs/audio/tts/qwen-out/l/ 99개 WAV (파일럿 작업목록 앞 100개 중 99개 성공)
- 확인 필요: 기존 219개와 섞은 캐스터 head 조각의 화자·이어 붙임, 외국 이름 발음
- 막힌 것: l/43651b51e8 `외르얀 뉠란,`은 캐리어 내부 무음이 없어 절단 실패; 본 생성 전 재생성 필요

## 잘못 분류된 팀 도입 문장 2개를 직접 생성으로 교체
- 상태: done
- 산출물: docs/audio/tts/qwen-out/n/02bf69b0cc.wav, n/46dce79383.wav 및 report.json 갱신
- 확인 필요: 두 팀 도입 문장이 기존 직접 생성 문장과 자연스럽게 이어지는지
- 막힌 것: 없음

## 토너먼트용 추가 이름 90개 생성 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/ 90개 WAV 추가 및 report.json 219개 항목
- 확인 필요: 음절 대비 길이 이상치로 표시한 2개(아르헨티나·에콰도르 입장 대본)를 청취 확인
- 막힌 것: 없음

## 추가 이름 14개 ICL 캐리어 생성 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/ 14개 WAV 추가 및 report.json 129개 항목
- 확인 필요: 추가 14개가 해당 선발 호명 문장에 자연스럽게 붙는지
- 막힌 것: 없음

## 115개 전체 ICL(ref_text) 텍스트 배열 생성 완료
- 상태: done
- 산출물: docs/audio/tts/qwen-out/ 115개 WAV 및 docs/audio/tts/qwen-out/report.json
- 확인 필요: 82개 이름 캐리어 통일 샘플과 전체 화자 일치 여부
- 막힌 것: 없음

## ICL(ref_text) 복제 + 텍스트 배열 방식으로 8개 3차 샘플 생성
- 상태: done
- 산출물: docs/audio/tts/qwen-out/ 및 docs/audio/tts/qwen-out/report.json
- 확인 필요: 8개 음성, 특히 이름 4개의 단독/캐리어 억양과 화자 일치 여부
- 막힌 것: 없음

## C3/A3 x-vector 고정 방식으로 8개 2차 샘플 생성
- 상태: done
- 산출물: docs/audio/tts/qwen-out/ 및 docs/audio/tts/qwen-out/report.json
- 확인 필요: 8개 음성을 듣고 화자 일치 여부 판정
- 막힌 것: 없음
