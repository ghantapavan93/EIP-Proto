"""The one real AI workflow under test: post-call QA & handoff record.

  transcript ─► EXTRACT (model)  ─► CHECK (deterministic contracts, outside this
                                    module) ─► COMPOSE (model) ─► ROUTE (deterministic)

The model is asked for a structured extraction and a short composition. Every
compliance-relevant decision downstream is deterministic; the model's own
judgments are *inputs* that the contracts test against ground truth under the
rule version in force on the run's rule date.

Two prompt versions exist on purpose. v1 was written under the CY2024 rules
(60-second disclaimer timer, 48-hour SOA wait). v2 was rewritten for the
CY2027 rules that took effect 2026-10-01. Running v1 after Oct 1 is the
"rule changed, prompt didn't" failure the harness is built to catch.
"""

from __future__ import annotations

import hashlib
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError

# ------------------------------------------------------------------ output schema


class Superlative(BaseModel):
    text: str
    substantiated: bool
    flagged: bool


class NumericClaim(BaseModel):
    value: str
    context: str = ""


class Extraction(BaseModel):
    product_line: Literal["MA", "PDP", "MEDIGAP", "LIFE"]
    carrier: str | None = None
    disclaimer_delivered: bool
    disclaimer_seconds: int | None = None
    disclaimer_span: str | None = None
    benefits_started_seconds: int | None = None
    benefits_span: str | None = None
    disclaimer_compliant: bool
    disclaimer_basis: str | None = ""  # the model's stated reasoning basis; null when it does not apply
    soa_collected: bool
    soa_span: str | None = None
    appointment_scheduled: bool
    appointment_hours_after_soa: float | None = None
    soa_exception: str | None = None
    soa_wait_compliant: bool
    superlatives: list[Superlative] = Field(default_factory=list)
    numeric_claims: list[NumericClaim] = Field(default_factory=list)
    pii_detected: list[str] = Field(default_factory=list)  # types only, never values


class Composition(BaseModel):
    summary: str
    coaching_note: str
    crm_record: dict[str, Any] = Field(default_factory=dict)


class WorkflowOutput(BaseModel):
    extraction: Extraction
    composition: Composition
    route: Literal["PASS", "FLAG", "BLOCK"] = "PASS"


def validate_output(raw: dict[str, Any]) -> tuple[WorkflowOutput | None, str | None]:
    try:
        return WorkflowOutput.model_validate(raw), None
    except ValidationError as exc:
        return None, str(exc)


def route(extraction: Extraction) -> Literal["PASS", "FLAG", "BLOCK"]:
    """Deterministic routing. The model never decides where a record goes."""
    if not extraction.disclaimer_compliant or not extraction.soa_wait_compliant:
        return "BLOCK"
    if extraction.pii_detected:
        return "FLAG"
    if any(s.flagged for s in extraction.superlatives):
        return "FLAG"
    return "PASS"


# ------------------------------------------------------------------ prompts

PROMPT_V1 = """You are the post-call QA assistant for a Medicare sales floor. Read the call transcript and produce a structured QA record.

Rules you must apply (CMS contract year 2024 marketing rules):
1. The TPMO disclaimer ("We do not offer every plan available in your area...") must be read WITHIN THE FIRST 60 SECONDS of the call. Mark disclaimer_compliant = true only if it was delivered at or before 00:01:00. State the basis as "timer:60s".
2. A personal marketing appointment may not be scheduled sooner than 48 HOURS after the Scope of Appointment is documented, unless the customer walked in or is within the last four days of an election period. Mark soa_wait_compliant accordingly.
3. Superlatives ("best", "highest-rated", "number one") are prohibited unless substantiated by data cited on the call. Flag any unsubstantiated superlative.
4. For Medicare Supplement (Medigap) calls, rules 1-3 do not apply; mark them compliant.

Extraction rules: every *_span field must be an EXACT verbatim quote from the transcript. Report timestamps in seconds from call start. Never include Medicare numbers, dates of birth or SSNs in any output field — report pii_detected types only.

Then write a 3-sentence summary for the CRM, a coaching note that quotes the agent's own words and names one concrete improvement, and a crm_record with fields: disposition, product_line, carrier, next_step.
"""

PROMPT_V2 = """You are the post-call QA assistant for a Medicare sales floor. Read the call transcript and produce a structured QA record.

Rules you must apply (CMS contract year 2027 marketing rules, effective 2026-10-01):
1. The TPMO disclaimer ("We do not offer every plan available in your area...") must be read PRIOR TO THE DISCUSSION OF ANY BENEFITS. There is no clock. Mark disclaimer_compliant = true only if the disclaimer timestamp is earlier than the first benefits discussion (or no benefits were discussed). State the basis as "ordering:before-benefits".
2. The Scope of Appointment must be documented before plan discussion, but there is NO waiting period between the SOA and the appointment. Mark soa_wait_compliant = true whenever an SOA was collected.
3. Superlatives are permitted. Flag a superlative only if it is materially misleading.
4. For Medicare Supplement (Medigap) calls, rules 1-3 do not apply; mark them compliant.

Extraction rules: every *_span field must be an EXACT verbatim quote from the transcript. Report timestamps in seconds from call start. Never include Medicare numbers, dates of birth or SSNs in any output field — report pii_detected types only.

Then write a 3-sentence summary for the CRM, a coaching note that quotes the agent's own words and names one concrete improvement, and a crm_record with fields: disposition, product_line, carrier, next_step.
"""

# v3 changes one sentence of v2: the ordering rule is spelled out as the comparison the
# model must make. Same rule versions, same everything else — a PROMPT trigger, recorded on
# a real model. Under v2, Qwen2.5 7B extracted the right timestamps and then contradicted
# them in 18 of 60 calls.
PROMPT_V3 = PROMPT_V2.replace(
    """1. The TPMO disclaimer ("We do not offer every plan available in your area...") must be read PRIOR TO THE DISCUSSION OF ANY BENEFITS. There is no clock. Mark disclaimer_compliant = true only if the disclaimer timestamp is earlier than the first benefits discussion (or no benefits were discussed). State the basis as "ordering:before-benefits".""",
    """1. The TPMO disclaimer ("We do not offer every plan available in your area...") must be read PRIOR TO THE DISCUSSION OF ANY BENEFITS. There is no clock. First record disclaimer_seconds (when the disclaimer was read) and benefits_started_seconds (when plan benefits — premiums, deductibles, copays, coverage — were first discussed). Then decide: disclaimer_compliant = true when benefits_started_seconds is null OR disclaimer_seconds < benefits_started_seconds (the disclaimer came first, which is compliant); false only when benefits were discussed BEFORE the disclaimer or no disclaimer was read. Write the comparison into disclaimer_basis, e.g. "ordering:before-benefits (25s < 131s -> compliant)".""",
)
assert PROMPT_V3 != PROMPT_V2

PROMPTS: dict[int, dict[str, Any]] = {
    1: {
        "label": "v1 — CY2024 rules (60s timer, 48h SOA wait)",
        "text": PROMPT_V1,
        "author": "ai-enablement",
        "notes": "Written for contract year 2024 rules. Encodes the disclaimer timer and the 48-hour SOA wait.",
        "encodes_rule_versions": [
            {"rule": "tpmo-disclaimer-timing", "version": 1},
            {"rule": "soa-48h-wait", "version": 1},
            {"rule": "superlatives", "version": 1},
        ],
    },
    2: {
        "label": "v2 — CY2027 rules (ordering, no SOA wait)",
        "text": PROMPT_V2,
        "author": "ai-enablement",
        "notes": "Rewritten for the CY2027 marketing rules effective 2026-10-01.",
        "encodes_rule_versions": [
            {"rule": "tpmo-disclaimer-timing", "version": 2},
            {"rule": "soa-48h-wait", "version": 2},
            {"rule": "superlatives", "version": 2},
        ],
    },
    3: {
        "label": "v3 — CY2027 rules, ordering spelled out",
        "text": PROMPT_V3,
        "author": "engineer",
        "notes": (
            "Same rules as v2. One sentence changed: the disclaimer-ordering test is written as the "
            "comparison to make (disclaimer_seconds < benefits_started_seconds), after Qwen2.5 7B "
            "extracted the right timestamps and contradicted them under v2. A PROMPT trigger on a real model."
        ),
        "encodes_rule_versions": [
            {"rule": "tpmo-disclaimer-timing", "version": 2},
            {"rule": "soa-48h-wait", "version": 2},
            {"rule": "superlatives", "version": 2},
        ],
    },
}


def prompt_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


# ------------------------------------------------------------------ rule logic


def rule_logic_from_params(params_by_rule: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Collapse rule-version params into the knobs the workflow/contracts need.

    params_by_rule maps rule code -> params of the relevant rule version.
    """
    disclaimer = params_by_rule.get("tpmo-disclaimer-timing", {})
    soa = params_by_rule.get("soa-48h-wait", {})
    sup = params_by_rule.get("superlatives", {})
    return {
        "disclaimer_basis": disclaimer.get("basis", "ordering"),
        "disclaimer_window_seconds": int(disclaimer.get("window_seconds", 0) or 0),
        "soa_min_hours": float(soa.get("min_hours_between_soa_and_appointment", 0) or 0),
        # Only the exceptions the rule version itself lists (CY2024: walk-ins and the
        # last four days of an election period). "The customer called us" is not one.
        "soa_exceptions": sorted(soa.get("exceptions", []) or []),
        "superlatives_substantiation_required": bool(sup.get("substantiation_required", False)),
    }


def truth_disclaimer_compliant(labels: dict[str, Any], logic: dict[str, Any]) -> tuple[bool, str]:
    """Ground truth for the disclaimer judgment under a given rule logic."""
    if labels.get("product_line") == "MEDIGAP":
        return True, "not applicable: Medigap (state DOI)"
    if not labels.get("disclaimer_delivered"):
        return False, "disclaimer not delivered"
    secs = labels.get("disclaimer_seconds")
    if logic["disclaimer_basis"] == "timer":
        window = logic["disclaimer_window_seconds"]
        ok = secs is not None and secs <= window
        return ok, f"timer: delivered at {secs}s, window {window}s"
    benefits = labels.get("benefits_started_seconds")
    ok = benefits is None or (secs is not None and secs < benefits)
    return ok, f"ordering: delivered at {secs}s, benefits at {benefits}s"


def truth_soa_wait_compliant(labels: dict[str, Any], logic: dict[str, Any]) -> tuple[bool, str]:
    if labels.get("product_line") == "MEDIGAP":
        return True, "not applicable: Medigap"
    if not labels.get("appointment_scheduled"):
        return True, "no appointment scheduled"
    if not labels.get("soa_collected"):
        return False, "appointment without an SOA"
    min_hours = logic["soa_min_hours"]
    hours = labels.get("appointment_hours_after_soa") or 0
    exception = labels.get("soa_exception")
    if exception and exception in logic.get("soa_exceptions", []):
        return True, f"exception applies: {exception}"
    ok = hours >= min_hours
    return ok, f"appointment {hours}h after SOA; minimum {min_hours}h"


def truth_superlative_flags(labels: dict[str, Any], logic: dict[str, Any]) -> list[str]:
    if not logic["superlatives_substantiation_required"]:
        # CY2027: not a documentation question any more, but a misleading or
        # unsupportable claim is still a finding.
        return [s["text"] for s in labels.get("superlatives", []) if s.get("misleading") or s.get("unsupportable")]
    return [s["text"] for s in labels.get("superlatives", []) if not s.get("substantiated")]
