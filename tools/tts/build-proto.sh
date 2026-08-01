#!/usr/bin/env bash
# 이음매 프로토타입을 docs/audio/tts-proto/ 에 굽는다.
#
# 조각 출처(요청 배치)를 파일명이 아니라 여기 기록해 둔다 — 어떤 조각이 어떤 요청에서
# 나왔는지가 판정의 전제다. **이름 조각과 문장 조각은 반드시 서로 다른 배치**에서 온다.
# 같은 발화를 잘랐다 붙이면 이음매가 안 들리는 게 당연해서 검증이 되지 않는다.
#
#   C1 캐스터 A안(맨이름+평평 지시)   C2 캐스터 B안(쉼표 캐리어)
#   C3 캐스터 템플릿(…… 자리 비움)     C5 캐스터 통문장 대조군 + 조사 이름(…… 캐리어)
#   A1 해설 A안   A2 해설 B안   A3 해설 템플릿   A4 해설 통문장 대조군
#
#   사용: SRC=<배치 wav를 자른 디렉터리> bash tools/tts/build-proto.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
O="${SRC:?SRC=<조각 디렉터리> 를 지정하라}"
D=docs/audio/tts-proto
mkdir -p "$D"
j() { python3 tools/tts/join.py "$@"; }

# ── 캐스터 (Puck / gemini-2.5-flash-preview-tts) ───────────────────────────
# 01 이름이 문장 **앞**, 조사 없음(쉼표 동격), 받침 X — B안 vs A안 vs 통문장 3종 비교
j --out "$D/01-caster-seam-B-라야-선방.mp3"              "$O/C2/B_다비드_라야.wav" "$O/C3/T_선방입니다.wav"
j --out "$D/01x-caster-seam-A-라야-선방.mp3"             "$O/C1/00_다비드_라야.wav" "$O/C3/T_선방입니다.wav"
j --out "$D/01w-caster-whole-라야-선방.mp3" --raw         "$O/C5/W_라야_선방.wav"
# 02 이름 앞 + 조사 이/가, 받침 X ("김승규" → "김승규가")
j --out "$D/02-caster-seam-김승규가-걷어냅니다.mp3" --gap 0.06 "$O/C5/J_김승규가.wav" "$O/C3/T_걷어냅니다.wav"
j --out "$D/02w-caster-whole-김승규가-걷어냅니다.mp3" --raw   "$O/C5/W_김승규가_걷어냄.wav"
# 03 이름 앞 + 조사 은/는, 받침 O ("손흥민" → "손흥민은")
j --out "$D/03-caster-seam-손흥민은-고개를떨굽니다.mp3" --gap 0.06 "$O/C5/J_손흥민은.wav" "$O/C3/T_고개를_떨굽니다.wav"
# 04 이름이 문장 **중간** + 조사 에게, 받침 O — 3조각(분+주어 / 이름 / 서술부)
j --out "$D/04-caster-seam-중간-29분-이한범에게-경고.mp3" --gap 0.06 \
     "$O/C3/T_전반29분_주심이.wav" "$O/C5/J_이한범에게.wav" "$O/C3/T_경고를_줍니다.wav"
j --out "$D/04w-caster-whole-29분-이한범에게-경고.mp3" --raw "$O/C5/W_29분_이한범_경고.wav"

# ── 해설위원 (Iapetus / gemini-3.1-flash-tts-preview) ──────────────────────
# 05 이름 앞, 조사 없음 — B안 vs A안 vs 통문장
j --out "$D/05-analyst-seam-B-라야-자리선정.mp3"          "$O/A2/B_다비드_라야.wav" "$O/A3/T_자리선정이_좋았습니다.wav"
j --out "$D/05x-analyst-seam-A-라야-자리선정.mp3"         "$O/A1/A_다비드_라야.wav" "$O/A3/T_자리선정이_좋았습니다.wav"
j --out "$D/05w-analyst-whole-라야-자리선정.mp3" --raw     "$O/A4/W_라야_자리선정.wav"
# 06 이름 중간 + 조사 의, 받침 O — 3조각
j --out "$D/06-analyst-seam-중간-손흥민의-마무리.mp3" --gap 0.06 \
     "$O/A3/T_네.wav" "$O/A2/B_손흥민의.wav" "$O/A3/T_마무리가_침착했습니다.wav"
j --out "$D/06w-analyst-whole-손흥민의-마무리.mp3" --raw    "$O/A4/W_손흥민의_마무리.wav"

echo "---"; ls "$D"
