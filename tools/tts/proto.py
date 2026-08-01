#!/usr/bin/env python3
"""이음매 검증 실험의 **요청 대장**. 배치를 선언해 두고 id로 하나씩 태운다.

모델당 RPD 10이 유일한 병목이라, 어떤 요청이 무엇을 확인하려는 것인지 코드에
적어 두고 하나씩만 실행한다. `--dry-run`은 요청을 쓰지 않는다.

    python3 tools/tts/proto.py --list
    python3 tools/tts/proto.py C1 --dry-run
    python3 tools/tts/proto.py C1            # 요청 1회 소모

## 억양 두 안
- **A안(프롬프트)**: 맨이름만 읽히되 "문장 중간처럼 평평하게, 끝을 내리지 마라"고 지시.
  장점: 한 요청에 이름을 최대로 밀어 넣는다(잘라낼 캐리어가 없다).
- **B안(캐리어)**: `{이름}, 지금 좋습니다.` 를 읽히고 쉼표 앞 조각만 취한다.
  쉼표 앞은 한국어에서 본래 연속(continuation) 어조라 하강이 안 나온다는 가정.
  단점: 같은 요청에 들어가는 이름 수가 절반 이하로 준다(캐리어 조각이 자리를 먹는다).

## 템플릿의 말줄임표
꼬리 조각을 그냥 완결 문장으로 읽히면 **문두 억양**(살짝 높게 출발)이 붙는다.
실제로는 이름 뒤에 오는 문중이라 그러면 안 된다. 그래서 이름 자리에 `……`를 두고
"말줄임표에서 쉬되 어조를 내리지 마라"라고 지시해 **문맥 속 억양**을 확보한다.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))

FLAT = (
    "축구 중계 캐스터의 목소리로 읽어라. 아래 항목들은 완결된 문장이 아니라 "
    "긴 문장 한복판에 끼워 넣을 선수 이름 조각이다. 문장이 끝난 것처럼 어조를 "
    "내리지 마라. 뒤에 말이 더 이어질 것처럼 평평하게, 이름을 또렷이 불러라."
)
FLAT_AN = FLAT.replace(
    "축구 중계 캐스터의 목소리로", "축구 중계 해설위원의 차분한 목소리로"
)
CARRIER = (
    "축구 중계 캐스터의 목소리로 읽어라. 각 문장의 쉼표에서 1초 이상 완전히 쉬어라. "
    "쉼표 앞에서 어조를 내리지 마라 — 말이 이어진다."
)
CARRIER_AN = CARRIER.replace(
    "축구 중계 캐스터의", "축구 중계 해설위원의 차분한"
)
TEMPLATE = (
    "축구 중계 캐스터의 목소리로 읽어라. 말줄임표(……)는 소리 내어 읽지 말고 "
    "그 자리에서 1초 이상 완전히 쉬어라. 말줄임표 앞뒤는 한 문장이니, "
    "말줄임표 앞에서 어조를 내리지 말고 뒤도 새 문장처럼 높여 시작하지 마라."
)
TEMPLATE_AN = TEMPLATE.replace(
    "축구 중계 캐스터의", "축구 중계 해설위원의 차분한"
)
WHOLE = "축구 중계 캐스터처럼 생생하게 읽어라."
WHOLE_AN = "축구 중계 해설위원처럼 차분하게 짚어 읽어라."

# id: (화자, 목적, 스타일, 문장들)
BATCHES: dict[str, tuple[str, str, str, list[str]]] = {
    "C1": ("caster", "A안 — 맨이름 + 평평 지시. 조사 붙은 형태도 함께(연음 보존 검증)", FLAT, [
        "다비드 라야", "손흥민", "김승규", "이한범", "로드리", "이재성",
        "김승규가", "손흥민은", "이한범에게", "다비드 라야의",
    ]),
    "C2": ("caster", "B안 — 캐리어 문장에서 쉼표 앞 이름만 잘라낸다", CARRIER, [
        "다비드 라야, 지금 좋습니다.",
        "손흥민, 지금 좋습니다.",
        "김승규, 지금 좋습니다.",
        "이한범, 지금 좋습니다.",
    ]),
    # C2 실측: 쉼표에서 1초를 쉬라는 지시는 **먹히지 않았다**(실제 0.34초).
    # 반면 C3의 말줄임표 지시는 0.40초를 만들어 냈고, 이쪽이 조사 붙은 이름까지
    # 문법적인 캐리어로 감쌀 수 있다. 그래서 이후 배치는 말줄임표 캐리어로 통일한다.
    "C5": ("caster", "통문장 대조군 + 조사 붙은 이름의 말줄임표 캐리어(받침 O/X)", TEMPLATE, [
        "다비드 라야, 오늘 두 번째 선방입니다.",
        "김승규가 손끝으로 걷어냅니다!",
        "전반 29분, 주심이 이한범에게 경고를 줍니다.",
        "김승규가 …… 지금 좋습니다.",
        "손흥민은 …… 지금 좋습니다.",
        "이한범에게 …… 지금 좋습니다.",
    ]),
    "C3": ("caster", "캐스터 템플릿 — 이름 자리를 …… 로 비운 문장", TEMPLATE, [
        "…… 오늘 두 번째 선방입니다.",
        "…… 손끝으로 걷어냅니다!",
        "…… 고개를 떨굽니다.",
        "전반 29분, 주심이 …… 경고를 줍니다.",
        "…… 조금 높았죠.",
    ]),
    "C4": ("caster", "통문장 대조군 — 이음매 버전과 나란히 듣기 위한 기준", WHOLE, [
        "다비드 라야, 오늘 두 번째 선방입니다.",
        "김승규가 손끝으로 걷어냅니다!",
        "전반 29분, 주심이 이한범에게 경고를 줍니다.",
        "손흥민은 고개를 떨굽니다.",
    ]),
    "A1": ("analyst", "A안 — 해설위원 목소리의 맨이름", FLAT_AN, [
        "다비드 라야", "손흥민의", "김승규",
    ]),
    # 이름 캐리어는 **목표 문장과 다른 문장**이어야 한다. 같은 문장에서 잘라 다시
    # 붙이면 이음매가 안 들리는 게 당연해서 검증이 되지 않는다.
    "A2": ("analyst", "B안 — 해설위원 이름 클립(말줄임표 캐리어). 목표 문장과 다른 캐리어", TEMPLATE_AN, [
        "다비드 라야 …… 지금 좋습니다.",
        "손흥민의 …… 슛이 좋습니다.",
    ]),
    "A3": ("analyst", "해설위원 템플릿", TEMPLATE_AN, [
        "…… 자리 선정이 좋았습니다.",
        "네, …… 마무리가 침착했습니다.",
        "…… 각을 좁힌 게 컸어요.",
    ]),
    "A4": ("analyst", "해설위원 통문장 대조군", WHOLE_AN, [
        "다비드 라야, 자리 선정이 좋았습니다.",
        "네, 손흥민의 마무리가 침착했습니다.",
    ]),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--outdir", default="/tmp/tts-proto")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    if a.list or not a.ids:
        for k, (sp, why, _, lines) in BATCHES.items():
            print(f"{k}  [{sp:7s}] 문장 {len(lines):2d}개 · 요청 1회 — {why}")
        return

    for i in a.ids:
        if i not in BATCHES:
            sys.exit(f"모르는 배치: {i}")
    for i in a.ids:
        sp, why, style, lines = BATCHES[i]
        print(f"\n=== {i} [{sp}] {why} ===")
        cmd = [sys.executable, os.path.join(HERE, "gen.py"),
               "--speaker", sp, "--style", style,
               "--out", os.path.join(a.outdir, f"{i}.wav")]
        if a.dry_run:
            cmd.append("--dry-run")
        cmd += lines
        subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
