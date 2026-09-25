"""Sandbox: one pasted transcript through the real workflow, on a local model, stored nowhere.

    paste ─► redact PII ─► ONE generation (prompt v2, current rules) on a local Ollama
          ─► validate ─► contracts that need no ground truth (schema, spans, figures, PII)
          ─► label-dependent contracts (TPMO, SOA, SUP) reported as NEEDS_LABEL with the model's answer

Local models only, on purpose: whatever is pasted never leaves this server. The
model's output is validated and checked, never executed; the transcript reaches
it wrapped as data (see openai_compat.generate). A hard deadline keeps the call
under the tunnel's ~100 s cut-off, and a small concurrency cap stops one
laptop GPU from being queued into the ground.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from backstop.core.impact import in_force_version
from backstop.harness import contracts as ct
from backstop.harness import workflow as wf
from backstop.harness.ingest import redact
from backstop.harness.providers import MODELS, PROVIDERS
from backstop.models import Contract, Rule

PROMPT_VERSION = 2
DEFAULT_MODELS = ("ollama/qwen2.5:3b-instruct", "ollama/qwen2.5:7b-instruct")  # smallest first
LOCAL_MODELS = tuple(m.model_id for m in MODELS if m.provider == "ollama")
TIMEOUT_SECONDS = 75.0
MAX_CONCURRENT = 2

NO_MODEL = ("No live model is reachable from this server; the recorded runs still replay. "
            "Start Ollama to try a transcript.")
TIMEOUT_MESSAGE = (f"The local model did not finish within {int(TIMEOUT_SECONDS)} s, so the check was abandoned "
                   "and nothing was saved. Try a shorter transcript or the smaller model.")

GROUNDING_CHECKS = ("schema_valid", "spans_verbatim", "numbers_grounded", "pii_redacted")
LABEL_CHECKS = ("disclaimer_judgment", "soa_judgment", "superlative_flags")

_NEEDS_LABEL_WHY = {
    "disclaimer_judgment": ("Needs a labelled call: this contract compares the model's disclaimer_compliant with a "
                            "reviewer's reading of when the disclaimer and the first benefits discussion happened. "
                            "The model's own answer is shown, not graded."),
    "soa_judgment": ("Needs a labelled call: this contract compares the model's soa_wait_compliant with a "
                     "reviewer's reading of the SOA and appointment timing. The model's own answer is shown, "
                     "not graded."),
    "superlative_flags": ("Needs a labelled call: this contract compares the superlatives the model flagged with "
                          "the ones a reviewer labels misleading or unsupportable. The model's own flags are "
                          "shown, not graded."),
}
_MODEL_SAYS = {
    "disclaimer_judgment": ("disclaimer_delivered", "disclaimer_seconds", "benefits_started_seconds",
                            "disclaimer_compliant", "disclaimer_basis"),
    "soa_judgment": ("soa_collected", "appointment_scheduled", "appointment_hours_after_soa", "soa_exception",
                     "soa_wait_compliant"),
    "superlative_flags": ("superlatives",),
}


class SandboxError(Exception):
    """Refusal with the HTTP status the API should report."""

    status = 500

    def __init__(self, message: str, model_id: str | None = None):
        super().__init__(message)
        self.message = message
        self.model_id = model_id  # the model the attempt reached, when it got that far


class BadModel(SandboxError):
    status = 422


class NoModel(SandboxError):
    status = 409


class Busy(SandboxError):
    status = 429


class ModelFailed(SandboxError):
    status = 502


class Timeout(SandboxError):
    status = 504


# ------------------------------------------------------------------ seams (tests replace these)


def probe() -> dict[str, Any]:
    from backstop.harness.openai_compat import probe_ollama_cached

    return probe_ollama_cached(PROVIDERS["ollama"].base_url)


def make_adapter(model_id: str):
    from backstop.harness.openai_compat import OpenAICompatibleAdapter

    # One attempt per request and a per-request timeout inside the deadline: a stuck
    # Ollama fails this call instead of retrying past the tunnel's cut-off.
    return OpenAICompatibleAdapter(model_id, timeout=TIMEOUT_SECONDS, max_attempts=1)


# ------------------------------------------------------------------ model choice


def _pulled(name: str, available: set[str]) -> bool:
    return name in available or f"{name}:latest" in available


def pick_model(requested: str | None, probe_result: dict[str, Any]) -> str:
    if requested is not None and requested not in LOCAL_MODELS:
        raise BadModel(f"the sandbox runs local models only, so pasted text never leaves this server; "
                       f"use one of {list(LOCAL_MODELS)}")
    if not probe_result.get("reachable"):
        raise NoModel(NO_MODEL)
    available = set(probe_result.get("models") or [])
    candidates = (requested,) if requested else DEFAULT_MODELS
    for model_id in candidates:
        if _pulled(model_id.split("/", 1)[1], available):
            return model_id
    if requested:
        raise NoModel(f"{requested} is not pulled on this server's Ollama. {NO_MODEL}")
    raise NoModel(NO_MODEL)


# ------------------------------------------------------------------ bounded generation

_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_pool = ThreadPoolExecutor(max_workers=MAX_CONCURRENT, thread_name_prefix="sandbox-model")


def _generate_with_deadline(factory: Callable[[str], Any], model_id: str, prompt_text: str, transcript: str,
                            logic: dict[str, Any], deadline: float):
    if not _slots.acquire(blocking=False):
        raise Busy("the local model is already checking other transcripts; try again in a minute")
    try:
        adapter = factory(model_id)  # after the slot: a refused request opens no HTTP client
    except Exception as exc:  # noqa: BLE001 - reported, never a 500
        _slots.release()
        raise ModelFailed(f"could not reach {model_id}: {type(exc).__name__}", model_id) from exc

    def work():
        try:
            return adapter.generate(prompt_text, transcript, "SANDBOX", {}, logic)
        finally:
            client = getattr(adapter, "client", None)
            if client is not None:
                client.close()
            _slots.release()  # released when the model call ends, not when the request gives up

    future = _pool.submit(work)
    try:
        return future.result(timeout=deadline)
    except FutureTimeout as exc:
        raise Timeout(TIMEOUT_MESSAGE) from exc


# ------------------------------------------------------------------ the check


def _logic_in_force(session: Session, as_of: date) -> dict[str, Any]:
    params: dict[str, dict[str, Any]] = {}
    for rule in session.scalars(select(Rule)).all():
        v = in_force_version(rule, as_of)
        if v is not None:
            params[rule.code] = v.params
    return wf.rule_logic_from_params(params)


def _contract_rows(session: Session) -> dict[str, Contract]:
    return {c.check: c for c in session.scalars(select(Contract)).all()}


def check_transcript(
    session: Session,
    text: str,
    *,
    product_line: str,
    model_id: str | None,
    probe_fn: Callable[[], dict[str, Any]] | None = None,
    adapter_factory: Callable[[str], Any] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Run one pasted transcript. Raises SandboxError subclasses; writes nothing."""
    chosen = pick_model(model_id, (probe_fn or probe)())
    redacted_text, counts = redact(text)
    logic = _logic_in_force(session, date.today())
    try:
        result = _generate_with_deadline(adapter_factory or make_adapter, chosen, wf.PROMPTS[PROMPT_VERSION]["text"],
                                         redacted_text, logic, TIMEOUT_SECONDS if timeout is None else timeout)
    except SandboxError as exc:
        exc.model_id = chosen
        raise
    if result.error and not result.raw:
        raise ModelFailed(f"the local model did not answer ({result.error[:200]}); nothing was saved", chosen)

    output, validation_error = (None, result.error) if result.error else wf.validate_output(result.raw)
    if output is not None:
        output.route = wf.route(output.extraction)
    labels = {"product_line": product_line, "ingested": True, "ground_truth": None}
    ctx = ct.CheckContext(raw=result.raw, output=output, validation_error=validation_error,
                          transcript=redacted_text, transcript_code="SANDBOX", labels=labels, logic=logic,
                          spec={}, adapter=None)
    rows = _contract_rows(session)
    contracts: list[dict[str, Any]] = []
    for check in GROUNDING_CHECKS:
        contract = rows.get(check)
        if contract is None:
            continue
        try:
            verdict = ct.REGISTRY[check](ctx)
        except Exception as exc:  # noqa: BLE001 - a broken check is a result, not a crash
            verdict = ct.Verdict("ERROR", {"error": f"{type(exc).__name__}: {exc}"})
        contracts.append({"code": contract.code, "title": contract.title, "severity": contract.severity,
                          "outcome": verdict.outcome, "evidence": verdict.evidence or None, "why": None})
    for check in LABEL_CHECKS:
        contract = rows.get(check)
        if contract is None:
            continue
        why = _NEEDS_LABEL_WHY[check]
        if product_line == "MEDIGAP" and check != "superlative_flags":
            why += " (For a Medigap call this rule does not apply at all.)"
        evidence = None
        if output is not None:
            extraction = output.extraction.model_dump()
            evidence = {"model_says": {k: extraction.get(k) for k in _MODEL_SAYS[check]}}
        contracts.append({"code": contract.code, "title": contract.title, "severity": contract.severity,
                          "outcome": "NEEDS_LABEL", "evidence": evidence, "why": why})

    note = (f"Nothing you pasted was stored: only a SHA-256 of the text, the model and the outcomes went to the "
            f"audit log. One generation with workflow prompt v{PROMPT_VERSION} (CY2027 rules) on {chosen}, "
            f"which runs on this server. Medicare numbers, SSNs, dates of birth, phone numbers, emails and street "
            f"addresses were redacted before the model "
            f"saw the text. The grounding contracts ran; the rule-judgment contracts need a labelled call, so they "
            f"show the model's own answer as NEEDS_LABEL. The advisory coaching judge (J-COACH-01) is not run here.")
    if output is not None and output.extraction.product_line != product_line:
        note += (f" The model read this as a {output.extraction.product_line} call; you said {product_line}.")
    return {
        "model_id": chosen,
        "latency_ms": result.latency_ms,
        "redacted": counts,
        "output": output.model_dump() if output is not None else result.raw,
        "contracts": contracts,
        "persisted": False,
        "note": note,
    }
