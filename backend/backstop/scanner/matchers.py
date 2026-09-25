"""Deterministic rule-encoding matchers.

Each matcher looks for a phrasing that encodes a specific *rule version* and
returns an evidence span (the enclosing sentence) with its offset in the
normalized artifact text. Matchers are conservative on purpose:

* A verbatim or near-verbatim encoding is `confirmed`.
* A phrasing that needs judgment (e.g. "ten years" near "call" could be SOA
  retention, not recording retention) is `proposed` and goes to a human.

Polarity is inferred from the enclosing sentence: enforcement language
("must", "required", "at least", "score 0", "do not") → ENFORCES; otherwise
INFORMS. PERMITS is reserved for sentences that explicitly allow something.

These matchers cannot be prompt-injected: they are regular expressions over
text and never execute anything they read.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace

ENFORCE_WORDS = re.compile(
    r"\b(must|required|require|shall|need to|at least|score 0|do not|does not|may not|"
    r"cannot|prohibit|prohibited|no later than|within the first|minimum of|as required|"
    r"retain|retained|flag|are prohibited|is documented|scheduled at least)\b",
    re.I,
)
PERMIT_WORDS = re.compile(r"\b(permitted|allowed|may|can be completed|is permitted)\b", re.I)

SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True)
class Match:
    rule_code: str
    version: int
    polarity: str
    span: str
    offset: int
    matcher: str
    status: str  # confirmed | proposed
    confidence: float
    note: str = ""


@dataclass
class Matcher:
    name: str
    rule_code: str
    version: int
    pattern: re.Pattern
    # All of these must appear within `window` chars of the hit (any order).
    context_all: list[re.Pattern] = field(default_factory=list)
    # None of these may appear within the window.
    context_none: list[re.Pattern] = field(default_factory=list)
    window: int = 220
    # Tighter checks for phrases whose meaning flips on the words right next to the hit
    # ("best plan" vs "best time to call"): all/none of these within `near_window` chars.
    near_all: list[re.Pattern] = field(default_factory=list)
    near_none: list[re.Pattern] = field(default_factory=list)
    near_window: int = 60
    # None of these may match the `prefix_window` chars immediately before the hit
    # ("available in all 50 states" describes a carrier, not EIP's licensing).
    prefix_none: list[re.Pattern] = field(default_factory=list)
    prefix_window: int = 30
    # Cap on hits per text. A "Best Part D plans" listicle has dozens of superlatives; one
    # review task each would bury the queue. The last kept hit says how many were left out.
    max_hits: int | None = None
    # None of these may appear in the evidence sentence itself.
    span_none: list[re.Pattern] = field(default_factory=list)
    # All of these must appear in the evidence sentence itself (not just nearby).
    span_all: list[re.Pattern] = field(default_factory=list)
    # Two hits in one sentence can produce two differently trimmed spans of it. With this on,
    # a hit whose span overlaps one already kept is dropped: one edge per passage.
    merge_overlapping: bool = False
    status: str = "confirmed"
    confidence: float = 1.0
    note: str = ""
    force_polarity: str | None = None

    def run(self, text: str) -> list[Match]:
        out: list[Match] = []
        for hit in self.pattern.finditer(text):
            lo, hi = max(0, hit.start() - self.window), min(len(text), hit.end() + self.window)
            ctx = text[lo:hi]
            if any(not p.search(ctx) for p in self.context_all):
                continue
            if any(p.search(ctx) for p in self.context_none):
                continue
            near = text[max(0, hit.start() - self.near_window):min(len(text), hit.end() + self.near_window)]
            if any(not p.search(near) for p in self.near_all) or any(p.search(near) for p in self.near_none):
                continue
            prefix = text[max(0, hit.start() - self.prefix_window):hit.start()]
            if any(p.search(prefix) for p in self.prefix_none):
                continue
            span, offset = enclosing_sentence(text, hit.start(), hit.end())
            if any(p.search(span) for p in self.span_none) or any(not p.search(span) for p in self.span_all):
                continue
            if self.merge_overlapping and any(
                offset < m.offset + len(m.span) and m.offset < offset + len(span) for m in out
            ):
                continue
            polarity = self.force_polarity or infer_polarity(span)
            out.append(
                Match(
                    rule_code=self.rule_code,
                    version=self.version,
                    polarity=polarity,
                    span=span,
                    offset=offset,
                    matcher=self.name,
                    status=self.status,
                    confidence=self.confidence,
                    note=self.note,
                )
            )
        out = dedupe(out)
        if self.max_hits is not None and len(out) > self.max_hits:
            dropped = len(out) - self.max_hits
            out = out[: self.max_hits]
            out[-1] = replace(out[-1], note=f"{out[-1].note} (+{dropped} more on this page, not listed separately)")
        return out


def enclosing_sentence(text: str, start: int, end: int, max_len: int = 360, max_side: int = 110) -> tuple[str, int]:
    """Expand [start, end) to sentence boundaries, capped at max_len around the hit.

    Navigation text and headings have no sentence punctuation; in that case the
    context is trimmed to `max_side` characters per side at word boundaries so
    the evidence stays readable. The span is always a verbatim substring.
    """
    lo = max(0, start - max_len // 2)
    hi = min(len(text), end + max_len // 2)
    left = text[lo:start]
    right = text[end:hi]
    # Find the last sentence end on the left and the first on the right.
    left_parts = SENTENCE_END.split(left)
    left_tail = left_parts[-1] if left_parts else left
    right_match = re.search(r"[.!?](\s|$)", right)
    right_head = right[: right_match.end()] if right_match else right
    if len(left_tail) > max_side:
        cut = left_tail[-max_side:]
        left_tail = cut[cut.find(" ") + 1 :] if " " in cut else cut
    if len(right_head) > max_side:
        cut = right_head[:max_side]
        right_head = cut[: cut.rfind(" ")] if " " in cut else cut
    span = (left_tail + text[start:end] + right_head).strip()
    offset = text.find(span, max(0, start - len(left_tail) - 1))
    if offset < 0:
        offset = text.find(span)
    if offset < 0:
        span, offset = text[start:end], start
    return span, offset


def infer_polarity(sentence: str) -> str:
    if ENFORCE_WORDS.search(sentence):
        return "ENFORCES"
    if PERMIT_WORDS.search(sentence):
        return "PERMITS"
    return "INFORMS"


def dedupe(matches: list[Match]) -> list[Match]:
    seen: set[tuple[str, int, str]] = set()
    out = []
    for m in matches:
        key = (m.rule_code, m.version, m.span)
        if key in seen:
            continue
        seen.add(key)
        out.append(m)
    return out


def _p(pat: str) -> re.Pattern:
    return re.compile(pat, re.I)


SOA_CTX = _p(r"scope of appointment|\bSOA\b|appointment")
RECORD_CTX = _p(r"\brecord(ed|ing|ings)?\b|\bcalls?\b")
DISCLAIMER_CTX = _p(r"disclaimer|we do not offer every plan")
# The sentence both v1 and v2 require and the 2022-era short form lacks.
REPRESENT_CTX = _p(r"\bcurrently,? we represent\b|\bwe (currently )?represent\s+\S+(\s+\S+)?\s+organi[sz]ations?\b")
LICENSING_CTX = _p(r"\blicen[sc](ed|e|es|ing)\b")
# "Available in all 50 states" is a carrier's footprint, not EIP's.
AVAILABILITY_PREFIX = _p(r"\b(available|availability|offered|sold|operates?|operating)\b[^.]*$")
# A superlative is a *claim* only when it is about a plan, carrier or benefit.
PLAN_WORDS = _p(
    r"\b(plans?|carriers?|insurers?|insurance compan(y|ies)|coverage|benefits?|premiums?|formular(y|ies)|"
    r"Part D|Medicare Advantage|Medigap|Supplement|copays?|co-pays?|deductibles?|networks?|polic(y|ies)|"
    r"rates?|prices?|drugs?|pharmac(y|ies)|Rx|MAPD|PDP)\b"
)
BEST_OBJECT = (r"(?:plans?|carriers?|insurers?|coverage|benefits?|premiums?|formular(?:y|ies)|Part D|"
               r"Medigap|Advantage|copays?|deductibles?|networks?|polic(?:y|ies)|rates?|prices?|drugs?|"
               r"pharmac(?:y|ies)|value|costs?|out-of-pocket|PDP|MAPD)\b")
SUPERLATIVE_NOT_A_CLAIM = [
    _p(r"superlatives?"),  # a sentence ABOUT superlatives is the rule's encoding, not a use
    _p(r"\bbest (time|times|way|ways|number|regards|wishes|day|days|practices?|interests?|places to work)\b"),
    _p(r"\b(at|do|doing|did|try|tried|trying) (my|our|your|their) best\b|\bas best (we|i|you|they) can\b"),
    _p(r"\b(find|finding|choose|choosing|pick|picking|select|selecting|get|getting)( you)? the (best|lowest|right)\b"),
    _p(r"\bbest (fit|option|choice|plan|coverage|polic(y|ies))s? for (you|your|their|my|his|her)\b"),
    _p(r"\bfor (your|their|my) (needs|situation|budget)\b"),
    # Suitability, not superiority: "Best for beneficiaries who ...", "the plan that fits best".
    _p(r"\bbest (fit|fits|next step|first step|step)\b|\bfits? best\b"),
    _p(r"\bbest for (people|beneficiaries|residents|those|anyone|someone|seniors|members|individuals|"
       r"budget-conscious|you)\b"),
    # Negated, wished-for or neutral uses: "not the absolute cheapest", "want the lowest possible
    # copays", "the lowest and highest MOOP", "the lowest tier", "the best plan depends on ...".
    _p(r"\bnot\b[^.]{0,30}\b(best|cheapest|lowest)\b"),
    _p(r"\b(want|wants|wanting|looking for|need|needs|prefer|prefers)( the| a)? (best|lowest|cheapest)\b|\blowest possible\b"),
    _p(r"\blowest and highest\b|\bhighest and lowest\b|\blowest tier\b|\bdepends on\b|\bwhat is the best\b"),
]

# ---- rules added 2026-09-25 (agent/broker compensation, data-sharing consent, TCPA, SOA scope, Florida)
SOA_STRICT_CTX = _p(r"scope of appointment|\bSOA\b")
COMP_CTX = _p(r"\b(commissions?|compensation|comp|FMV|fair market value|initial[- ]year|renewals?|"
              r"enrollment[- ]based|per enrollment|payouts?)\b")
PDP_CTX = _p(r"\b(PDP|Part D|prescription drug plans?)\b")
CONSENT_CTX = _p(r"\b(consent|agree|authori[sz]e|share|sharing|shared|contact(ed)?)\b")
CALL_CTX = _p(r"\b(calls?|calling|dial(s|ing|er)?|attempts?|outbound|telemarketing|solicitation)\b")
OPT_OUT_CTX = _p(r"\b(opt[- ]?outs?|revok\w*|revocation|do[- ]not[- ]call|DNC|unsubscribe|stop requests?)\b")
_KEYWORD = r"(?:stop|quit|end|revoke|opt[- ]?out|cancel|unsubscribe)"
_QUOTE = r"[\"'“”]?"
_OVER_THREE = r"(?:[4-9]|1\d|20|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)"
_PER_DAY = (r"(?:\s+(?:per|to|on|for)\s+(?:each\s+|a\s+|the\s+)?(?:lead|number|prospect|consumer|person|contact|"
            r"beneficiary))?\s+(?:per|a|each|in|within|every|in any)\s+(?:(?:rolling\s+)?(?:24|twenty-four)[- ]hours?"
            r"(?:\s+period)?|day|calendar day)\b")
_ATTEMPTS = r"\s+(?:(?:call|dial|contact|outbound)\s+)?(?:attempts?|calls?|dials?)"
# "No SOA is needed for inbound callers", "skip the Scope of Appointment when the caller calls in".
SOA_EXEMPT_WORDS = _p(
    r"\b(no|without|skip\w*|exempt\w*|waive\w*|(do|does|did)(n't| not) need|(is|are)(n't| not))\b[^.]{0,25}?"
    r"\b(SOA|scope of appointment)\b|"
    r"\b(SOA|scope of appointment)s?\b[^.]{0,40}?\b(not (required|needed|necessary)|(is|are)n't (required|needed)|"
    r"optional|waived|only (for|required for|applies to|needed for) scheduled)"
)

MATCHERS: list[Matcher] = [
    # ---- SOA 48-hour waiting period (v1 encodings)
    Matcher(
        name="soa-48h-explicit",
        rule_code="soa-48h-wait",
        version=1,
        pattern=_p(r"\b48[- ]?hours?\b|\bforty[- ]eight hours\b"),
        context_all=[SOA_CTX],
        note="explicit 48-hour phrasing near Scope of Appointment",
    ),
    Matcher(
        name="soa-two-days-semantic",
        rule_code="soa-48h-wait",
        version=1,
        pattern=_p(r"\btwo (business |working )?days\b"),
        context_all=[SOA_CTX],
        status="proposed",
        confidence=0.7,
        note="'two days' phrasing near SOA — likely the 48-hour rule, needs a human read",
    ),
    # ---- TPMO disclaimer timing
    Matcher(
        name="disclaimer-first-minute",
        rule_code="tpmo-disclaimer-timing",
        version=1,
        pattern=_p(r"(within|in|after) the (first|one)[- ](minute|60 seconds|sixty seconds)|one-minute mark|first 60 seconds"),
        context_all=[DISCLAIMER_CTX],
        note="timer-based delivery (CY2024 basis)",
    ),
    Matcher(
        name="disclaimer-before-benefits",
        rule_code="tpmo-disclaimer-timing",
        version=2,
        pattern=_p(r"(prior to|before) (the )?(you |we |they )?(discuss(ing|ion of)? )?(any )?(plan )?benefits?"),
        context_all=[DISCLAIMER_CTX],
        note="ordering-based delivery (CY2027 basis)",
    ),
    # ---- TPMO disclaimer wording
    Matcher(
        name="disclaimer-text-ship",
        rule_code="tpmo-disclaimer-text",
        version=1,
        pattern=_p(r"State Health Insurance (Assistance )?Program|\(SHIP\)"),
        context_all=[_p(r"1-800-MEDICARE|medicare\.gov")],
        context_none=[_p(r"free counseling|counsel(l)?ing")],
        note="SHIP referral inside the disclaimer sentence (CY2024 wording)",
    ),
    Matcher(
        name="disclaimer-text-current",
        rule_code="tpmo-disclaimer-text",
        version=2,
        pattern=_p(r"Please contact Medicare\.gov or 1-800-MEDICARE to get information on all of your options"),
        context_all=[REPRESENT_CTX],
        note="CY2027 wording without the SHIP referral, with the organization/plan-count sentence",
    ),
    Matcher(
        name="disclaimer-text-all-plans",
        merge_overlapping=True,
        rule_code="tpmo-disclaimer-text",
        version=2,
        pattern=_p(r"You can always contact Medicare\.gov or 1-800-MEDICARE for help with plan choices"),
        context_all=[REPRESENT_CTX],
        note="CY2027 wording for a TPMO that sells for every MA organization in the area",
    ),
    Matcher(
        name="disclaimer-text-short-form",
        rule_code="tpmo-disclaimer-text",
        version=2,
        pattern=_p(r"Please contact Medicare\.gov or 1-800-MEDICARE to get information on all of your options"),
        context_none=[REPRESENT_CTX],
        status="proposed",
        confidence=0.5,
        note=("incomplete disclaimer: missing organization/plan counts ('Currently we represent [N] "
              "organizations which offer [N] products in your area'), which v1 and v2 both require. "
              "Looks like the 2022-era short form; not a compliant v2 encoding"),
    ),
    # ---- Call recording retention
    Matcher(
        name="retention-10-years-recording",
        rule_code="call-recording-retention",
        version=1,
        pattern=_p(r"\b(10|ten)[- ]years?\b"),
        context_all=[RECORD_CTX],
        context_none=[_p(r"scope of appointment forms?|SOA forms?")],
        note="10-year retention near call/recording language",
    ),
    Matcher(
        name="retention-10-years-ambiguous",
        rule_code="call-recording-retention",
        version=1,
        pattern=_p(r"\b(10|ten)[- ]years?\b"),
        context_all=[_p(r"scope of appointment forms?|SOA forms?|retain")],
        status="proposed",
        confidence=0.4,
        note="'10 years' near SOA-form retention — probably the SOA retention rule, not call recording; human must decide",
    ),
    Matcher(
        name="retention-6-years-recording",
        rule_code="call-recording-retention",
        version=2,
        pattern=_p(r"\b(6|six)[- ]years?\b"),
        context_all=[RECORD_CTX],
        note="6-year retention (CY2027)",
    ),
    # ---- Superlatives
    Matcher(
        name="superlatives-substantiation",
        rule_code="superlatives",
        version=1,
        pattern=_p(r"superlatives?"),
        context_all=[_p(r"substantiat|data|prohibit|unless|not use")],
        note="superlatives-require-substantiation encoding (CY2024)",
    ),
    Matcher(
        name="superlative-claim",
        rule_code="superlatives",
        version=2,
        pattern=_p(
            # "best" only with a plan/benefit object close after it ("best Part D plans", "best for
            # low premiums", "the best value"); "the best choice" and "Best For <audience>" are advice.
            r"\bbest\s+(?:for\s+)?(?:[\w'-]+\s+){0,3}?" + BEST_OBJECT + r"|"
            r"\b(number[- ]one|top[- ]rated|top pick|largest|lowest|cheapest|highest[- ]rated|"
            r"most popular|hard to beat)\b|(?<!\w)(#\s?1|no\.\s?1)\b|\bno other\b[^.]{0,80}?\bmatch(es|ed)?\b"
        ),
        near_all=[PLAN_WORDS],
        near_none=SUPERLATIVE_NOT_A_CLAIM,
        max_hits=3,
        # A sentence that talks ABOUT superlatives is the rule's encoding (superlatives-substantiation).
        span_none=[_p(r"superlatives?")],
        status="proposed",
        confidence=0.6,
        force_polarity="INFORMS",
        note=("superlative claim about a plan, carrier or benefit. Through 2026-09-30 (v1) it needed supporting "
              "data in the material; from 2026-10-01 (v2) it must be accurate and supportable. A human checks "
              "the claim and its support"),
    ),
    # ---- SOA at educational events
    Matcher(
        name="soa-educational-events-prohibited",
        rule_code="soa-educational-events",
        version=1,
        pattern=_p(r"educational events?"),
        context_all=[SOA_CTX, _p(r"do not|may not|not collect|prohibit")],
        note="no-SOA-at-educational-events encoding (CY2024)",
    ),
    Matcher(
        name="educational-events-12-hour-gap",
        rule_code="soa-educational-events",
        version=1,
        pattern=_p(r"\b12[- ]hours?\b|\btwelve hours\b"),
        context_all=[_p(r"educational events?")],
        note="12-hour educational→marketing gap (CY2024)",
    ),
    # ---- Agent/broker compensation
    Matcher(
        name="comp-admin-payments-counted",
        merge_overlapping=True,
        rule_code="agent-broker-compensation",
        version=2,
        pattern=_p(r"administrative (payments?|fees?|allowances?)\b[^.]{0,60}?\b(are |is |will be |must be )?"
                   r"(included|counted|count|folded|rolled)\b[^.]{0,40}?\bcompensation|\b422\.2274\(e\)\(2\)"),
        span_none=[_p(r"\b(vacat\w*|set aside|struck|no longer|not (included|counted)|excluded)\b")],
        note=("encodes the CY2025 compensation rewrite (administrative payments counted as compensation, "
              "422.2274(e)(2)), which a court vacated on 2025-08-18. eCFR still prints the text; the pre-CY2025 "
              "text governs"),
    ),
    Matcher(
        name="comp-fmv-cy2027",
        merge_overlapping=True,
        rule_code="agent-broker-compensation",
        version=3,
        pattern=_p(r"\$\s?(725|363|816|408|902|451|495|248)(\.00)?(?![\d,])"),
        near_all=[COMP_CTX],
        near_window=90,
        note="a CY2027 FMV compensation cap (CMS memo 2026-06-01): MA initial/renewal by state group",
    ),
    Matcher(
        name="comp-fmv-cy2027-pdp",
        merge_overlapping=True,
        rule_code="agent-broker-compensation",
        version=3,
        pattern=_p(r"\$\s?(130|65)(\.00)?(?![\d,])"),
        near_all=[COMP_CTX, PDP_CTX],
        near_window=90,
        note="a CY2027 PDP FMV compensation cap ($130 initial / $65 renewal, CMS memo 2026-06-01)",
    ),
    # ---- TPMO-to-TPMO data sharing (CMS, in force) and FCC one-to-one consent (vacated)
    Matcher(
        name="data-sharing-blanket-partners",
        merge_overlapping=True,
        rule_code="tpmo-data-sharing-consent",
        version=1,
        pattern=_p(r"\b(our|its|their) (marketing |insurance |affiliate |trusted |network )?partners\b|"
                   r"\bthird[- ]part(y|ies)( who| that)? (may )?(contact|call)|"
                   r"\bup to (\d+|ten|five|three) (partners|companies|agencies|insurers|carriers)\b|"
                   r"\b(partner list|list of (our )?partners)\b"),
        context_all=[CONSENT_CTX],
        near_none=[_p(r"\b(each|every) (company|partner|entity|agency|recipient|TPMO)\b[^.]{0,60}\b"
                      r"(separately|individually|checkbox|check box)")],
        status="proposed",
        confidence=0.6,
        force_polarity="PERMITS",
        note=("blanket partner consent. 42 CFR 422.2274(g)(4) lets a TPMO share beneficiary data with another "
              "TPMO only with prior express written consent that lists each recipient and lets the beneficiary "
              "accept or reject each one; 'our partners' or a link-out list is not that. A human checks where "
              "the data goes"),
    ),
    Matcher(
        name="data-sharing-per-recipient",
        merge_overlapping=True,
        rule_code="tpmo-data-sharing-consent",
        version=1,
        pattern=_p(r"\b(each|every) (company|partner|entity|agency|recipient|TPMO|organi[sz]ation)\b[^.]{0,80}?"
                   r"\b(separately|individually|check ?box|opt in)\b|\bcheck (the|a) box (for|next to) each\b"),
        context_all=[_p(r"\b(consent|share|sharing|data|information)\b")],
        note="consent per listed recipient, as 422.2274(g)(4) requires",
    ),
    Matcher(
        name="pewc-one-to-one",
        merge_overlapping=True,
        rule_code="tcpa-pewc-one-to-one",
        version=2,
        pattern=_p(r"\bone[- ]to[- ]one consent\b|\bone seller at a time\b|"
                   r"\bconsent\b[^.]{0,40}?\b(a )?single (seller|company|marketer)\b|"
                   r"\blogically and topically (associated|related)\b"),
        force_polarity="INFORMS",
        note=("references the FCC one-to-one consent rule (47 CFR 64.1200(f)(9), 2023), which the 11th Circuit "
              "vacated on 2025-01-24 before it took effect"),
    ),
    # ---- TCPA revocation of consent
    Matcher(
        name="revocation-keywords",
        merge_overlapping=True,
        rule_code="tcpa-consent-revocation",
        version=1,
        # Three or more of the keywords in a list, optionally quoted: STOP, QUIT, END / "stop", "quit" or "end".
        pattern=_p(r"(?<!\w)" + _QUOTE + _KEYWORD + r"\b" + _QUOTE
                   + r"(?:\s*(?:,|/|\bor\b|\band\b)\s*(?:(?:or|and)\s+)?" + _QUOTE + _KEYWORD + r"\b" + _QUOTE
                   + r"){2,}"),
        context_all=[_p(r"\b(opt[- ]?out|revok\w*|revocation|reply|replies|text(s|ed)?|messages?|keywords?|"
                        r"consent|do[- ]not[- ]call|DNC|requests?)\b")],
        note="revocation keywords (47 CFR 64.1200(a)(10)-(12)): any reasonable method revokes consent",
    ),
    Matcher(
        name="revocation-10-business-days",
        merge_overlapping=True,
        rule_code="tcpa-consent-revocation",
        version=1,
        pattern=_p(r"\b(10|ten) business days\b"),
        context_all=[OPT_OUT_CTX],
        note="revocations honored within ten business days (47 CFR 64.1200(a)(10), (d)(3))",
    ),
    Matcher(
        name="revocation-window-too-long",
        merge_overlapping=True,
        rule_code="tcpa-consent-revocation",
        version=1,
        pattern=_p(r"\b(within|in|up to|after)\s+(1[1-9]|[2-9]\d|fifteen|twenty|thirty|sixty|ninety)"
                   r"(\s+(calendar|business))?\s+days\b"),
        context_all=[OPT_OUT_CTX],
        status="proposed",
        confidence=0.6,
        note=("an opt-out or revocation window longer than the ten business days 47 CFR 64.1200(a)(10) and "
              "(d)(3) allow; a human checks what the window applies to"),
    ),
    Matcher(
        name="revocation-exclusive-method",
        merge_overlapping=True,
        rule_code="tcpa-consent-revocation",
        version=1,
        pattern=_p(r"\b(exclusive|only) (opt[- ]?out|revocation|unsubscribe) (method|channel|mechanism|means)\b|"
                   r"\bonly (way|method|means) to (opt[- ]?out|revoke|unsubscribe|stop)\b|"
                   r"\b(opt[- ]?outs?|revocations?) (are|is) (only )?accepted only\b"),
        status="proposed",
        confidence=0.6,
        note=("names an exclusive opt-out method. In force today (v1), any reasonable method revokes consent. The "
              "FCC draft (v2, vote 2026-09-30, not law) would allow an exclusive method if it is disclosed on "
              "every call and text"),
    ),
    # ---- SOA scope: every personal marketing appointment from 2026-10-01
    Matcher(
        name="soa-inbound-exempt",
        merge_overlapping=True,
        rule_code="soa-all-personal-marketing-appointments",
        version=1,
        pattern=_p(r"\b(inbound|unscheduled|walk[- ]?ins?|web[- ]?chats?|web[- ]forms?|call(s|ed|ing)? in|"
                   r"calls? us)\b"),
        context_all=[SOA_STRICT_CTX],
        near_all=[SOA_EXEMPT_WORDS],
        near_none=[_p(r"\b(48|forty[- ]eight)[- ]hours?\b|\bwait(ing)?\b")],
        near_window=90,
        force_polarity="PERMITS",  # it lets a contact go ahead without an SOA
        note=("treats inbound or unscheduled contacts as exempt from the Scope of Appointment. From 2026-10-01 CMS "
              "removed 'scheduled' from 422.2264(c)(3)(i): an SOA is needed before every personal marketing "
              "appointment, including inbound unscheduled calls, walk-ins, web chats and web forms"),
    ),
    Matcher(
        name="soa-48h-walk-in-exception",
        merge_overlapping=True,
        rule_code="soa-all-personal-marketing-appointments",
        version=1,
        pattern=_p(r"\b48[- ]?hours?\b|\bforty[- ]eight hours\b|\btwo (business |working )?days\b"),
        context_all=[SOA_CTX],
        span_all=[_p(r"\bwalk[- ]?(ins?|in)\b")],
        status="proposed",
        confidence=0.5,
        note=("48-hour SOA rule with a walk-in exception: the pre-2026-10-01 SOA scope, tied to scheduled "
              "appointments. From 2026-10-01 the wait is gone but walk-ins and inbound calls still need an SOA "
              "before the appointment. A human checks the artifact does not read as 'walk-ins need no SOA'"),
    ),
    Matcher(
        name="soa-all-appointments",
        merge_overlapping=True,
        rule_code="soa-all-personal-marketing-appointments",
        version=2,
        pattern=_p(r"\b(including|includes|even for|also for|applies to|covers|regardless of)\b[^.]{0,40}?"
                   r"\b(inbound|unscheduled|walk[- ]?ins?|web[- ]?chats?|web[- ]forms?|who (initiated|started))"),
        context_all=[SOA_STRICT_CTX, _p(r"\b(required|requires|must|before|prior to|every|all)\b")],
        near_none=[_p(r"\b(not required|no need|exempt|skip)\b")],
        note="SOA before every personal marketing appointment, inbound and unscheduled included (CY2027)",
    ),
    # ---- Florida calling hours and frequency (Fla. Stat. 501.616(6))
    Matcher(
        name="fl-hours-8am-8pm",
        merge_overlapping=True,
        rule_code="fl-telesolicitation-hours-frequency",
        version=1,
        pattern=_p(r"\b8(:00)?\s?a\.?m\.?\s*(to|-|\u2013|and|until|through)\s*8(:00)?\s?p\.?m\.?"),
        context_all=[CALL_CTX],
        note="8 a.m. to 8 p.m. calling window (Fla. Stat. 501.616(6)(a))",
    ),
    Matcher(
        name="fl-hours-until-9pm",
        merge_overlapping=True,
        rule_code="fl-telesolicitation-hours-frequency",
        version=1,
        pattern=_p(r"\b(until|to|-|\u2013|through|and|before)\s*9(:00)?\s?p\.?m\.?|\b9\s?pm\b|\b21:00\b"),
        context_all=[CALL_CTX],
        status="proposed",
        confidence=0.6,
        note=("calling window runs to 9 p.m. (the federal TCPA limit, 47 CFR 64.1200(c)(1)). Florida's window "
              "ends at 8 p.m. in the called person's time zone and reaches licensed insurance agents "
              "(501.604). A human checks whether Florida numbers stop at 8 p.m."),
    ),
    Matcher(
        name="fl-3-calls-per-24h",
        merge_overlapping=True,
        rule_code="fl-telesolicitation-hours-frequency",
        version=1,
        pattern=_p(r"\b(3|three)" + _ATTEMPTS + _PER_DAY),
        context_all=[CALL_CTX],
        note="at most 3 calls per 24 hours (Fla. Stat. 501.616(6)(b))",
    ),
    Matcher(
        name="fl-over-3-calls-per-24h",
        merge_overlapping=True,
        rule_code="fl-telesolicitation-hours-frequency",
        version=1,
        pattern=_p(r"\b" + _OVER_THREE + _ATTEMPTS + _PER_DAY),
        context_all=[CALL_CTX],
        status="proposed",
        confidence=0.6,
        note=("more than 3 calls per day or 24 hours. Florida allows at most three commercial telephone "
              "solicitation calls to a person in 24 hours on the same subject, from any number (501.616(6)(b)). "
              "A human checks whether the cadence applies to Florida numbers"),
    ),
    # ---- EIP internal fact: licensing footprint
    Matcher(
        name="licensing-48-states",
        rule_code="eip-licensing-footprint",
        version=1,
        pattern=_p(r"\b48 states\b"),
        near_all=[LICENSING_CTX],
        prefix_none=[AVAILABILITY_PREFIX],
        force_polarity="INFORMS",
        note="claims 48 states",
    ),
    Matcher(
        name="footprint-48-states-unqualified",
        rule_code="eip-licensing-footprint",
        version=1,
        pattern=_p(r"\b48 states\b"),
        near_none=[LICENSING_CTX],
        prefix_none=[AVAILABILITY_PREFIX],
        status="proposed",
        confidence=0.4,
        force_polarity="INFORMS",
        note="'48 states' without licensing language: maybe a footprint claim, maybe not; a human decides",
    ),
    Matcher(
        name="licensing-50-states",
        rule_code="eip-licensing-footprint",
        version=2,
        pattern=_p(r"\b(all )?50 states\b"),
        near_all=[LICENSING_CTX],
        prefix_none=[AVAILABILITY_PREFIX],
        force_polarity="INFORMS",
        note="claims all 50 states",
    ),
    Matcher(
        name="footprint-50-states-unqualified",
        rule_code="eip-licensing-footprint",
        version=2,
        pattern=_p(r"\b(all )?50 states\b"),
        near_none=[LICENSING_CTX],
        prefix_none=[AVAILABILITY_PREFIX],
        status="proposed",
        confidence=0.4,
        force_polarity="INFORMS",
        note=("'50 states' without licensing language (e.g. clients served in 50 states): maybe a footprint "
              "claim; a human decides"),
    ),
]


def run_all(text: str) -> list[Match]:
    matches: list[Match] = []
    for m in MATCHERS:
        matches.extend(m.run(text))
    # If the same span was both confirmed and proposed for the same rule, keep confirmed.
    best: dict[tuple[str, int, str], Match] = {}
    for m in matches:
        key = (m.rule_code, m.version, m.span)
        if key not in best or (best[key].status == "proposed" and m.status == "confirmed"):
            best[key] = m
    return list(best.values())
