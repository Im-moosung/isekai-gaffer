"""한국어 조사(받침) 처리 — src/game/pressconf.ts의 hasBatchim/josa를 그대로 옮긴 것.

왜 옮겼나: pressconf.ts는 `src/`에 있고 TS다. TTS 클립 생성은 `tools/`의 파이썬
파이프라인이라 런타임을 공유할 수 없다. 규칙 자체가 순수 함수(유니코드 산술)라
중복이 위험하지 않다 — 다만 **한쪽을 고치면 다른 쪽도 고쳐야 한다**.

원본: src/game/pressconf.ts:44-52
    function hasBatchim(word) {
      const c = word.charCodeAt(word.length - 1)
      if (c < 0xac00 || c > 0xd7a3) return false
      return (c - 0xac00) % 28 !== 0
    }
과거 이 처리가 없어서 "체코을"·"멕시코과" 버그가 났다(커밋 be46f54 계열).
"""

# 조사 쌍: (받침 있을 때, 받침 없을 때)
JOSA_PAIRS = {
    "이/가": ("이", "가"),
    "은/는": ("은", "는"),
    "을/를": ("을", "를"),
    "과/와": ("과", "와"),
    "으로/로": ("으로", "로"),
}

# 받침과 무관한 조사 — 이름 뒤에 붙어도 이형태가 없다.
JOSA_INVARIANT = ("의", "에게", "입니다", "")


def has_batchim(word: str) -> bool:
    """마지막 글자에 받침이 있으면 True. 한글 음절이 아니면 False(받침 없음 취급)."""
    if not word:
        return False
    c = ord(word[-1])
    if c < 0xAC00 or c > 0xD7A3:
        return False
    return (c - 0xAC00) % 28 != 0


def josa(word: str, with_b: str, without_b: str) -> str:
    return word + (with_b if has_batchim(word) else without_b)


def josa_pair(word: str, pair: str) -> str:
    """`josa_pair('손흥민', '이/가')` -> '손흥민이'"""
    with_b, without_b = JOSA_PAIRS[pair]
    return josa(word, with_b, without_b)


if __name__ == "__main__":
    import sys

    for w in sys.argv[1:]:
        forms = " ".join(josa_pair(w, p) for p in JOSA_PAIRS)
        print(f"{w}\t받침={'O' if has_batchim(w) else 'X'}\t{forms}")
