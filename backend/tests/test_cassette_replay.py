"""The recorded real-model cassettes replay offline — no Ollama, no network, no key.

This is the path Docker and CI take: `backstop demo` replays every recorded set. If a
cassette set is incomplete the run would silently degrade into adapter errors, so the
test pins zero errors and real token counts for every recorded model.
"""

from __future__ import annotations

import re
from datetime import date

import pytest

from backstop.harness import adapters
from backstop.harness.runner import execute_run
from backstop.harness.workflow import PROMPTS, prompt_hash

RECORDED = [  # (model, prompt version, judge or None)
    ("ollama/qwen2.5:7b-instruct", 2, None),
    ("ollama/qwen2.5:3b-instruct", 2, None),
    ("ollama/llama3.1:8b", 2, None),
    ("ollama/qwen2.5:7b-instruct", 3, None),
    ("ollama/qwen2.5:3b-instruct", 2, "ollama/qwen2.5:7b-instruct"),
]


def _safe(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", value)


def _complete(settings, model_id: str, prompt: int, judge: str | None) -> bool:
    model_dir = settings.fixtures_dir / "cassettes" / prompt_hash(PROMPTS[prompt]["text"]) / _safe(model_id)
    if not model_dir.is_dir() or len(list(model_dir.glob("T*.generate.json"))) != 60:
        return False
    return judge is None or any(model_dir.glob(f"canary_*.judge@{_safe(judge)}.json"))


@pytest.mark.parametrize(("model_id", "prompt", "judge"), RECORDED)
def test_recorded_model_replays_with_no_live_adapter(session, settings, model_id, prompt, judge, monkeypatch):
    if not _complete(settings, model_id, prompt, judge):
        pytest.skip(f"no complete cassette set for {model_id} v{prompt} judge={judge}")
    # No provider is reachable in this test: a missing cassette would surface as an adapter error.
    monkeypatch.setattr(adapters, "_live_adapter", lambda *a, **k: None)

    out = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=prompt, model_id=model_id,
                      adapter_kind="cassette", rule_date=date(2026, 10, 1), trigger="MODEL", actor="tests",
                      judge_model_id=judge)
    run = out.run
    assert run.status == "COMPLETE" and run.adapter == "cassette"
    assert run.stats["adapter_errors"] == 0, "every transcript must replay from its cassette"
    assert run.stats["transcripts"] == 60
    cost = run.stats["cost"]
    assert cost["usd"] == 0.0 and "local GPU" in cost["basis"]
    assert cost["input_tokens"] > 60_000 and cost["output_tokens"] > 5_000, "token usage is measured, not guessed"
    # The judge ran on the recorded scores; the canary read its judge cassettes too.
    js = run.stats["judge_stability"]
    assert js["n_per_note"] == 5 and all("mean" in n for n in js["notes"]), "canary judge cassettes must replay"
    schema = run.stats["contracts"]["C-SCHEMA-01"]
    assert schema["ERROR"] == 0, "an adapter that produced nothing would show here"
    assert run.stats["judge_model_id"] == (judge or model_id)


def test_prompt_v3_fixes_most_of_the_7b_ordering_verdicts(session, settings, monkeypatch):
    """The PROMPT trigger on a real model: v2 → v3, same everything else, measured."""
    model = "ollama/qwen2.5:7b-instruct"
    if not (_complete(settings, model, 2, None) and _complete(settings, model, 3, None)):
        pytest.skip("7B cassettes for v2 and v3 are needed")
    monkeypatch.setattr(adapters, "_live_adapter", lambda *a, **k: None)
    runs = {}
    for version in (2, 3):
        runs[version] = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=version, model_id=model,
                                    adapter_kind="cassette", rule_date=date(2026, 10, 1), actor="tests").run
    wrong = {v: runs[v].stats["contracts"]["C-TPMO-01"]["FAIL"] for v in runs}
    assert wrong[2] == 20 and wrong[3] == 5, wrong  # recorded 2026-09-22; re-record to change
    # Not a free lunch: v3 also moved other cells, which is exactly why both runs are kept.
    assert runs[3].stats["contracts"]["C-SOA-01"]["FAIL"] == 1


def test_held_out_replay_reverses_the_prompt_fix(session, settings, monkeypatch):
    """Out of sample, recorded 2026-09-23: the v3 prompt fix does not generalize.

    v3 was written after reading the 7B's v2 failures on T001-T060. On H001-H060
    (same generator, seed 2027, never read) v2 is wrong 5 times and v3 22 times.
    Pinned so nobody can quietly re-record the embarrassing number away.
    """
    from backstop.harness import corpus as cp
    from backstop.harness.runner import seed_corpus

    model = "ollama/qwen2.5:7b-instruct"
    seed_corpus(session, seed=cp.HOLDOUT_SEED, prefix=cp.HOLDOUT_PREFIX)
    session.commit()
    monkeypatch.setattr(adapters, "_live_adapter", lambda *a, **k: None)
    runs = {}
    for version in (2, 3):
        runs[version] = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=version, model_id=model,
                                    adapter_kind="cassette", rule_date=date(2026, 10, 1), actor="tests",
                                    corpus="holdout").run
    if any(r.stats.get("adapter_errors") for r in runs.values()):
        pytest.skip("held-out cassettes for the 7B are needed")
    wrong = {v: runs[v].stats["contracts"]["C-TPMO-01"]["FAIL"] for v in runs}
    assert wrong == {2: 5, 3: 22}, wrong
    assert runs[3].stats["contracts"]["C-SCHEMA-01"]["FAIL"] == 2
    assert all(r.stats["corpus"] == "holdout" for r in runs.values())
