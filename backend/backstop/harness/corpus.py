"""Synthetic Medicare sales-call corpus.

Sixty transcripts, generated deterministically from a seed, each with ground
truth labels the contracts read. No real customer, agent, recording or
transcript is involved; names, Medicare numbers and dates are fabricated in
formats that cannot collide with real ones (Medicare numbers use the MBI
shape but with the character 'X' in positions the real MBI never allows).

Scenario mix (why each exists):

  A  clean                          disclaimer early, benefits later, SOA >= 48h
  B  late-but-ordered disclaimer    70-110s, before benefits  -> compliant under
                                    CY2027 (ordering), non-compliant under CY2024 (timer)
  C  early-but-unordered disclaimer benefits at 15-30s, disclaimer at 40-55s -> the
                                    reverse: compliant under the old timer, a
                                    violation under the new ordering rule
  D  short SOA lead time            appointment 2-24h after SOA, no exception ->
                                    compliant once the 48-hour wait is eliminated
  E  same-day SOA with exception    walk-in / customer-initiated same day
  F  superlatives                   half substantiated, half not
  G  PII spoken on the call         output must redact
  H  no disclaimer at all           non-compliant under both regimes
  I  Medigap-only call              TPMO disclaimer rules do not apply (state DOI)
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass, field

CARRIERS = ["Aetna", "Humana", "Cigna", "UnitedHealthcare", "Mutual of Omaha"]
AGENTS = ["Dana", "Marcus", "Priya", "Luis", "Tamika", "Owen", "Grace", "Jordan"]
CUSTOMERS = ["Mr. Alvarez", "Ms. Whitfield", "Mr. Okafor", "Mrs. Lindqvist", "Mr. Patel",
             "Ms. Romero", "Mr. Chen", "Mrs. Dubois", "Mr. Kowalski", "Ms. Nakamura"]
COUNTIES = ["Hillsborough", "Pinellas", "Pasco", "Polk", "Orange", "Duval", "Lee", "Volusia"]

DISCLAIMER_V2 = (
    "We do not offer every plan available in your area. Currently we represent 26 organizations "
    "which offer 3,740 products in your area. Please contact Medicare.gov or 1-800-MEDICARE to get "
    "information on all of your options."
)

SCENARIOS: list[tuple[str, int]] = [
    ("A", 16), ("B", 10), ("C", 4), ("D", 8), ("E", 4), ("F", 6), ("G", 6), ("H", 4), ("I", 2)
]


@dataclass
class Line:
    t: int
    speaker: str
    text: str

    def render(self) -> str:
        return f"[{self.t // 60:02d}:{self.t % 60:02d}] {self.speaker}: {self.text}"


@dataclass
class Labels:
    scenario: str
    product_line: str
    carrier: str
    agent: str
    customer: str
    county: str
    disclaimer_delivered: bool
    disclaimer_seconds: int | None
    disclaimer_text: str | None
    benefits_started_seconds: int | None
    benefits_text: str | None
    soa_collected: bool
    soa_seconds: int | None
    soa_text: str | None
    appointment_scheduled: bool
    appointment_hours_after_soa: float | None
    soa_exception: str | None
    superlatives: list[dict] = field(default_factory=list)
    numeric_claims: list[dict] = field(default_factory=list)
    pii: list[dict] = field(default_factory=list)
    duration_seconds: int = 0

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


def _mbi(rng: random.Random) -> str:
    # Real MBIs never contain the letters S, L, O, I, B, Z; we deliberately use X and a
    # dash pattern so no generated value can be a valid Medicare number.
    digits = "".join(rng.choice("0123456789") for _ in range(4))
    return f"1XX{digits[0]}-XX{digits[1]}-XX{digits[2:]}"


def _money(rng: random.Random, lo: int, hi: int, step: int = 5) -> int:
    return rng.randrange(lo, hi + 1, step)


def build_transcript(index: int, scenario: str, seed: int) -> tuple[str, Labels]:
    rng = random.Random(f"{seed}:{index}:{scenario}")
    agent = rng.choice(AGENTS)
    customer = rng.choice(CUSTOMERS)
    carrier = rng.choice(CARRIERS)
    county = rng.choice(COUNTIES)
    product_line = "MEDIGAP" if scenario == "I" else rng.choice(["MA", "MA", "MA", "PDP"])

    lines: list[Line] = []
    t = 0

    def say(speaker: str, text: str, dt: int) -> int:
        nonlocal t
        lines.append(Line(t, speaker, text))
        t += dt
        return lines[-1].t

    say("AGENT", f"Thanks for calling Elite Insurance Partners, this is {agent}. Am I speaking with {customer}?", 6)
    say("CUSTOMER", f"Yes, this is {customer.split()[-1]}.", 4)
    say("AGENT", "Great. Before we start, this call is being recorded for quality and compliance.", 6)
    say("CUSTOMER", "That's fine.", 3)

    labels = Labels(
        scenario=scenario, product_line=product_line, carrier=carrier, agent=agent,
        customer=customer, county=county, disclaimer_delivered=False, disclaimer_seconds=None,
        disclaimer_text=None, benefits_started_seconds=None, benefits_text=None,
        soa_collected=False, soa_seconds=None, soa_text=None, appointment_scheduled=False,
        appointment_hours_after_soa=None, soa_exception=None,
    )

    premium = _money(rng, 0, 45)
    moop = _money(rng, 2900, 6700, 100)
    deductible = _money(rng, 0, 545, 5)
    benefits_text = (
        f"The {carrier} plan available in {county} County has a ${premium} monthly premium, "
        f"a ${deductible} drug deductible and a ${moop} maximum out-of-pocket."
    )
    labels.numeric_claims = [
        {"value": f"${premium}", "context": "monthly premium"},
        {"value": f"${deductible}", "context": "drug deductible"},
        {"value": f"${moop}", "context": "maximum out-of-pocket"},
    ]

    filler_pool = [
        ("AGENT", "Let me check the network for your primary care physician.", 9),
        ("AGENT", "I'm pulling up the formulary for your county now.", 8),
        ("AGENT", "Give me a second to compare the two plans side by side.", 9),
        ("CUSTOMER", "Take your time.", 3),
        ("AGENT", "Do you take any brand-name medications I should check?", 7),
        ("CUSTOMER", rng.choice(["Just a blood pressure pill.", "Two prescriptions, both generic.", "Nothing right now."]), 5),
        ("AGENT", "Okay, that helps narrow it down.", 5),
        ("CUSTOMER", "Is there a plan that includes dental?", 5),
        ("AGENT", "Several do; I'll flag the ones with dental and vision.", 8),
    ]
    filler_order = list(range(len(filler_pool)))
    rng.shuffle(filler_order)

    def filler_until(target: int) -> None:
        """Varied small talk while the agent works, until the clock passes `target`."""
        i = 0
        while t < target:
            speaker, text, dt = filler_pool[filler_order[i % len(filler_order)]]
            say(speaker, text, dt)
            i += 1

    def deliver_disclaimer() -> None:
        ts = say("AGENT", DISCLAIMER_V2, 22)
        labels.disclaimer_delivered = True
        labels.disclaimer_seconds = ts
        labels.disclaimer_text = DISCLAIMER_V2

    def discuss_benefits() -> None:
        ts = say("AGENT", benefits_text, 14)
        labels.benefits_started_seconds = ts
        labels.benefits_text = benefits_text

    # ---- scenario-specific ordering of the disclaimer and benefits discussion
    if scenario == "I":
        say("AGENT", "You mentioned you're looking at Medicare Supplement coverage. Which plan letter are you considering?", 8)
        say("CUSTOMER", "Plan G, I think. My neighbor has it.", 5)
        say("AGENT", f"Plan G with {carrier} in {county} County runs about ${premium + 120} a month for your age band, and it covers the Part A deductible in full.", 14)
        labels.numeric_claims = [{"value": f"${premium + 120}", "context": "Plan G monthly premium"}]
        labels.benefits_started_seconds = lines[-1].t
        labels.benefits_text = lines[-1].text
    elif scenario == "H":
        say("AGENT", "So you're comparing Medicare Advantage plans for next year. Let me pull up your county.", 10)
        say("CUSTOMER", "Yes, I want to know what my costs would be.", 5)
        discuss_benefits()
    elif scenario == "C":
        say("AGENT", "You asked about costs, so let me get right to it.", 6)
        discuss_benefits()  # ~35s
        say("CUSTOMER", "That premium sounds good.", 4)
        deliver_disclaimer()  # ~45s: within the first minute, but after benefits
    elif scenario == "B":
        say("AGENT", "Let me confirm a few details first. What's your ZIP code and date of birth month?", 10)
        say("CUSTOMER", f"ZIP is 336{rng.randint(10, 99)}, and I was born in {rng.choice(['March', 'July', 'October'])}.", 8)
        say("AGENT", "Thank you. And are you currently enrolled in a Medicare Advantage plan or Original Medicare?", 9)
        say("CUSTOMER", "Original Medicare with a Part D plan.", 6)
        say("AGENT", "Understood. One more thing before we look at anything.", 6)
        # disclaimer lands between 70 and 110 seconds, benefits after
        filler_until(rng.randint(70, 105))
        deliver_disclaimer()
        say("CUSTOMER", "Okay.", 3)
        discuss_benefits()
    else:  # A, D, E, F, G
        say("AGENT", "One quick required disclosure before we discuss anything.", 6)
        deliver_disclaimer()  # ~30s
        say("CUSTOMER", "Understood.", 3)
        say("AGENT", "Now, what matters most to you — keeping your doctors, or the lowest premium?", 8)
        say("CUSTOMER", rng.choice(["Keeping my doctors.", "The premium, honestly.", "Both if I can."]), 5)
        filler_until(rng.randint(85, 140))
        discuss_benefits()

    # ---- PII (scenario G): the customer reads their Medicare number and DOB aloud
    if scenario == "G":
        mbi = _mbi(rng)
        dob = f"{rng.choice(['04', '09', '11'])}/{rng.randint(10, 28)}/19{rng.randint(48, 59)}"
        say("AGENT", "To pull your record I'll need your Medicare number and date of birth.", 7)
        say("CUSTOMER", f"It's {mbi}, and my birthday is {dob}.", 9)
        say("AGENT", "Thank you, I have it.", 4)
        labels.pii = [{"type": "medicare_number", "value": mbi}, {"type": "dob", "value": dob}]

    # ---- superlatives (scenario F)
    if scenario == "F":
        substantiated = index % 2 == 0
        if substantiated:
            text = f"Based on the CMS 2026 star ratings, this is the highest-rated plan in {county} County."
            labels.superlatives = [{"text": "highest-rated plan", "substantiated": True,
                                    "basis": "CMS 2026 star ratings"}]
        else:
            text = f"Honestly, this is the best plan in {county} County, nobody beats it."
            labels.superlatives = [{"text": "the best plan", "substantiated": False, "basis": None}]
        say("AGENT", text, 8)

    # ---- Scope of Appointment and scheduling
    if scenario != "I":
        ts = say("AGENT", "I've sent the Scope of Appointment to your email so we can go over specific plans. Can you sign it while we're on the line?", 12)
        say("CUSTOMER", "Signing it now.", 6)
        labels.soa_collected = True
        labels.soa_seconds = ts
        labels.soa_text = lines[-2].text
        if scenario == "D":
            hours = rng.choice([2, 4, 6, 20, 24])
            say("AGENT", f"Perfect. Let's do your plan review {'later today' if hours < 8 else 'tomorrow morning'} — that's about {hours} hours from now.", 10)
            labels.appointment_scheduled = True
            labels.appointment_hours_after_soa = hours
        elif scenario == "E":
            # The call is inbound, so "walk-in" cannot apply; "my window is closing" is the
            # last-four-days-of-an-election-period exception the CY2024 rule lists. The rng
            # draw is kept so every later line of every transcript stays byte-identical.
            rng.choice(["walk_in", "customer_initiated_same_day"])
            exception = "last_four_days_of_election_period"
            say("CUSTOMER", "Can we just go through it now? I called you today because my window is closing.", 8)
            say("AGENT", "Since you initiated today's call and asked to proceed, we can review plans now.", 9)
            labels.appointment_scheduled = True
            labels.appointment_hours_after_soa = 0
            labels.soa_exception = exception
        elif scenario == "H":
            say("AGENT", "We'll set the review for Thursday, so roughly 72 hours out.", 8)
            labels.appointment_scheduled = True
            labels.appointment_hours_after_soa = 72
        else:
            days = rng.choice([2, 3, 4, 5])
            say("AGENT", f"Let's set your plan review for {days} days from now — that's {days * 24} hours out, which gives you time to read it.", 10)
            labels.appointment_scheduled = True
            labels.appointment_hours_after_soa = days * 24
    else:
        say("AGENT", "Medicare Supplement plans are standardized, so we can compare carriers by price right now if you'd like.", 9)

    say("CUSTOMER", rng.choice(["Sounds good.", "Thank you, that helps.", "Okay, let's do that."]), 4)
    say("AGENT", f"Thank you, {customer}. You'll get a confirmation email from Elite Insurance Partners shortly.", 7)
    labels.duration_seconds = t

    text = "\n".join(line.render() for line in lines)
    return text, labels


HOLDOUT_SEED = 2027
HOLDOUT_PREFIX = "H"


def generate(seed: int = 2026, prefix: str = "T") -> list[dict]:
    """Return the full corpus as dicts: {code, product_line, text, labels, duration_seconds}.

    ``seed=2026, prefix="T"`` is the development corpus (T001-T060): every prompt
    was written while looking at it. ``generate(HOLDOUT_SEED, HOLDOUT_PREFIX)`` is
    the held-out draw (H001-H060): same scenario mix and templates, different
    randomization, never read while writing prompts. It measures overfitting to
    specific calls, not robustness to calls the generator cannot produce.
    """
    corpus: list[dict] = []
    index = 0
    for scenario, count in SCENARIOS:
        for _ in range(count):
            index += 1
            text, labels = build_transcript(index, scenario, seed)
            corpus.append(
                {
                    "code": f"{prefix}{index:03d}",
                    "product_line": labels.product_line,
                    "text": text,
                    "labels": labels.to_dict(),
                    "duration_seconds": labels.duration_seconds,
                }
            )
    return corpus


def corpus_hash(corpus: list[dict]) -> str:
    payload = json.dumps([(c["code"], c["text"]) for c in corpus], sort_keys=True).encode()
    return hashlib.sha256(payload).hexdigest()
