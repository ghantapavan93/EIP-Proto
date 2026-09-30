"""Reading a 1-5 score out of an LLM judge's free-text reply, shared by every live adapter."""

from __future__ import annotations

import math
import re

# A standalone 1-5 with at most one decimal: "4", "3.5", "Score: 4/5". Word boundaries keep
# "10" or "2026" from reading as 1 or 2.
_SCORE = re.compile(r"\b([1-5](?:\.\d)?)\b")


def parse_judge_score(reply: str) -> float:
    """The first score in `reply`, or NaN when there is none.

    An unparseable reply is missing data, not a low score: the coaching contract drops NaN
    and reports how many scores it kept.
    """
    match = _SCORE.search(reply)
    return float(match.group(1)) if match else math.nan
