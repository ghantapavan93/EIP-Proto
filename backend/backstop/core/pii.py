"""PII detection and redaction for real (non-synthetic) text.

One registry used by transcript ingest and the "Try your data" sandbox. Regular
expressions only, no ML NER, so the behaviour is inspectable and the scores in
``fixtures/pii_golden.yaml`` are reproducible.

Design: recall-first on shapes that are PII by construction (MBI, dashed SSN,
email, phone numbers that are not toll-free), and context-gated on shapes that
collide with ordinary call content:

* A bare 9-digit number is an SSN only near "social"/"SSN".
* A date is a date of birth when its year is 19xx (nobody on a call in this
  product has a 19xx *call* or *plan* date), or when a DOB word precedes it.
  A 20xx date without a DOB word is a call date, an effective date or a
  timestamp, and is kept.
* Toll-free numbers (800, 888, 877, 866, 855, 844, 833) are business lines
  (1-800-MEDICARE is 1-800-633-4227), not personal data, and are kept.
* Street addresses need a house number, one to three words and a street
  suffix; a PO box needs "P.O. Box" / "PO Box".

Known limitations (published, not hidden): personal names in free text are not
detected (only the CSV ``agent_name`` column is handled, by ingest); card
numbers, account numbers and street addresses without a suffix ("123 Oak")
pass through.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

# ------------------------------------------------------------------ patterns

# MBI shape: digit 1-9, letter, letter/digit, digit, letter, letter/digit, digit, letter, letter, digit, digit.
# Case-insensitive; the two separators may be "-", a space, or absent.
_MBI = re.compile(r"\b[1-9][A-Z][A-Z0-9]\d[\s-]?[A-Z][A-Z0-9]\d[\s-]?[A-Z]{2}\d{2}\b", re.I)

_SSN_DASHED = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_SSN_SPACED = re.compile(r"\b\d{3} \d{2} \d{4}\b")
_SSN_BARE = re.compile(r"(?<![\d$.,-])\d{9}(?![\d,.-]*\d)")
_SSN_CONTEXT = re.compile(r"\b(social(\s+security)?|SSN|SS#|SS\s*number)\b", re.I)

_MONTHS = (r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|"
           r"Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)")
_DATE_NUMERIC = re.compile(r"\b(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-]((?:19|20)\d{2}|\d{2})\b")
_DATE_ISO = re.compile(r"\b((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?!T|\d)")
_DATE_MONTH_NAME = re.compile(
    rf"\b{_MONTHS}\.?\s+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?\s+((?:19|20)\d{{2}})\b"
    rf"|\b(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+(?:of\s+)?{_MONTHS}\.?,?\s+((?:19|20)\d{{2}})\b",
    re.I,
)
_DOB_CONTEXT = re.compile(r"\b(born|birth(day|date)?|DOB|D\.O\.B\.?|date of birth)\b", re.I)

_TOLL_FREE = {"800", "888", "877", "866", "855", "844", "833"}
_PHONE = re.compile(
    r"(?<![\w$.-])(?:\+?1[\s.-]?)?(?:\((?P<a1>[2-9]\d{2})\)\s?|(?P<a2>[2-9]\d{2})[\s.-])"
    r"(?P<ex>[2-9]\d{2})[\s.-](?P<ln>\d{4})(?![\w-])"
)
_PHONE_BARE = re.compile(r"(?<![\w$.,-])(?:1)?(?P<a>[2-9]\d{2})(?P<ex>[2-9]\d{2})(?P<ln>\d{4})(?![\w,.-]*\d)")
_PHONE_CONTEXT = re.compile(r"\b(phone|cell|call(\s+me)?\s+(back\s+)?at|number is|reach me|text me)\b", re.I)

_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
# Also the way people read an address aloud: "margaret dot ellison at gmail dot com".
_EMAIL_SPOKEN = re.compile(r"\b[a-z0-9._-]+(?:\s+dot\s+[a-z0-9_-]+)*\s+at\s+[a-z0-9-]+\s+dot\s+(?:com|net|org|edu|gov|us)\b", re.I)

_STREET_SUFFIX = (r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|"
                  r"Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Trail|Trl|Loop|Square|Sq)")
_ADDRESS = re.compile(
    rf"\b\d{{1,6}}(?:\s+[NSEW]\.?)?(?:\s+(?!(?:on|at|in|the|and|or|to|of|a)\b)[A-Za-z][A-Za-z'-]*){{1,3}}\s+{_STREET_SUFFIX}\b\.?"
    r"(?:,?\s+(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[A-Za-z0-9-]+)?",
    re.I,
)
_PO_BOX = re.compile(r"\bP\.?\s?O\.?\s+Box\s+\d{1,6}\b", re.I)


# ------------------------------------------------------------------ detection


@dataclass(frozen=True)
class Hit:
    kind: str
    start: int
    end: int


def _preceded_by(text: str, start: int, context: re.Pattern, window: int = 48) -> bool:
    return bool(context.search(text[max(0, start - window):start]))


def _mbi(text: str) -> list[Hit]:
    return [Hit("medicare_number", m.start(), m.end()) for m in _MBI.finditer(text)]


def _ssn(text: str) -> list[Hit]:
    hits = [Hit("ssn", m.start(), m.end()) for p in (_SSN_DASHED, _SSN_SPACED) for m in p.finditer(text)]
    hits += [Hit("ssn", m.start(), m.end()) for m in _SSN_BARE.finditer(text)
             if _preceded_by(text, m.start(), _SSN_CONTEXT)]
    return hits


def _dob(text: str) -> list[Hit]:
    hits = []
    for m in _DATE_NUMERIC.finditer(text):
        year = m.group(3)
        if (len(year) == 4 and year.startswith("19")) or _preceded_by(text, m.start(), _DOB_CONTEXT):
            hits.append(Hit("dob", m.start(), m.end()))
    for m in _DATE_ISO.finditer(text):
        if m.group(1).startswith("19") or _preceded_by(text, m.start(), _DOB_CONTEXT):
            hits.append(Hit("dob", m.start(), m.end()))
    for m in _DATE_MONTH_NAME.finditer(text):
        year = m.group(2) or m.group(4)
        if year.startswith("19") or _preceded_by(text, m.start(), _DOB_CONTEXT):
            hits.append(Hit("dob", m.start(), m.end()))
    return hits


def _phone(text: str) -> list[Hit]:
    hits = []
    for m in _PHONE.finditer(text):
        if (m.group("a1") or m.group("a2")) not in _TOLL_FREE:
            hits.append(Hit("phone", m.start(), m.end()))
    for m in _PHONE_BARE.finditer(text):
        if m.group("a") not in _TOLL_FREE and _preceded_by(text, m.start(), _PHONE_CONTEXT):
            hits.append(Hit("phone", m.start(), m.end()))
    return hits


def _email(text: str) -> list[Hit]:
    return [Hit("email", m.start(), m.end()) for p in (_EMAIL, _EMAIL_SPOKEN) for m in p.finditer(text)]


def _address(text: str) -> list[Hit]:
    return [Hit("address", m.start(), m.end()) for p in (_ADDRESS, _PO_BOX) for m in p.finditer(text)]


# Order matters only for overlaps: earlier detectors win a tie on the same span.
DETECTORS: dict[str, Callable[[str], list[Hit]]] = {
    "medicare_number": _mbi,
    "ssn": _ssn,
    "dob": _dob,
    "phone": _phone,
    "email": _email,
    "address": _address,
}
KINDS: tuple[str, ...] = tuple(DETECTORS)


def detect(text: str) -> list[Hit]:
    """Non-overlapping hits, left to right. On overlap the longer hit wins, then registry order."""
    rank = {k: i for i, k in enumerate(KINDS)}
    candidates = [h for fn in DETECTORS.values() for h in fn(text)]
    candidates.sort(key=lambda h: (h.start, -(h.end - h.start), rank[h.kind]))
    out: list[Hit] = []
    for h in candidates:
        if out and h.start < out[-1].end:
            continue
        out.append(h)
    return out


def redact(text: str) -> tuple[str, dict[str, int]]:
    """Replace every hit with ``[REDACTED-<KIND>]``. Returns (text, counts for every kind)."""
    counts = dict.fromkeys(KINDS, 0)
    parts: list[str] = []
    cursor = 0
    for h in detect(text):
        parts.append(text[cursor:h.start])
        parts.append(f"[REDACTED-{h.kind.upper()}]")
        counts[h.kind] += 1
        cursor = h.end
    parts.append(text[cursor:])
    return "".join(parts), counts


def initials(name: str | None) -> str | None:
    """"Dana Whitfield" -> "D.W."; None/blank stays None."""
    if name is None or not name.strip():
        return None
    return "".join(f"{tok[0].upper()}." for tok in re.split(r"[\s._-]+", name.strip()) if tok)


# ------------------------------------------------------------------ scoring


def score_golden(cases: list[dict]) -> dict:
    """Precision/recall of ``detect`` on labeled cases (see fixtures/pii_golden.yaml).

    Per case and kind: TP = min(expected, detected), FP = detected - TP, FN = expected - TP.
    """
    from collections import Counter

    per_kind: dict[str, dict[str, int]] = {}
    failures = []
    for case in cases:
        expected = Counter(case.get("expect") or [])
        detected = Counter(h.kind for h in detect(case["text"]))
        for kind in set(expected) | set(detected):
            tp = min(expected[kind], detected[kind])
            b = per_kind.setdefault(kind, {"tp": 0, "fp": 0, "fn": 0})
            b["tp"] += tp
            b["fp"] += detected[kind] - tp
            b["fn"] += expected[kind] - tp
        if expected != detected:
            failures.append({"id": case["id"], "expected": dict(expected), "detected": dict(detected),
                             "limitation": bool(case.get("limitation"))})
    tp = sum(b["tp"] for b in per_kind.values())
    fp = sum(b["fp"] for b in per_kind.values())
    fn = sum(b["fn"] for b in per_kind.values())
    return {
        "cases": len(cases),
        "negatives": sum(1 for c in cases if not c.get("expect")),
        "tp": tp, "fp": fp, "fn": fn,
        "precision": tp / (tp + fp) if tp + fp else 1.0,
        "recall": tp / (tp + fn) if tp + fn else 1.0,
        "per_kind": per_kind,
        "failures": failures,
    }
