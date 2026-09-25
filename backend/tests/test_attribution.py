"""Attribution: a comparison says whether its differences can be pinned on one change.

The question a reviewer asks of any A/B result: "same prompt, same calls, same
contracts, same rule date, different model?" If more than one of those moved, the
comparison is confounded, and the product must say so and point at clean pairs.
"""

from __future__ import annotations

import base64
from datetime import date

import pytest
from fastapi.testclient import TestClient

from backstop.core import attribution as at
from backstop.harness.runner import execute_run
from backstop.main import app

BASE = {"prompt": "p1", "model": "sim-large|simulated", "rule_date": "2026-09-30", "corpus": "c1",
        "contract_set": "k1", "judge": "same model as the run", "overrides": "0"}


def run(run_id: str, **changes: str) -> at.RunFactors:
    key = {**BASE, **changes}
    return at.RunFactors(run_id=run_id, key=key, display=dict(key))


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


# ---------------------------------------------------------------- pure logic


def test_one_change_is_isolated_and_everything_else_is_listed_as_held():
    out = at.attribute(run("a"), run("b", model="sim-small|simulated"))
    assert out["verdict"] == "isolated"
    assert [c["factor"] for c in out["changed"]] == ["model"]
    assert out["held_constant"] == ["prompt", "rule date", "calls scored", "contract set", "judge",
                                    "approved overrides"]
    assert out["summary"].startswith("Only the model changed (sim-large|simulated → sim-small|simulated)")
    assert out["isolating_pairs"] == [] and out["scope_note"] is None


def test_identical_inputs_are_a_repeat():
    out = at.attribute(run("a"), run("b"))
    assert out["verdict"] == "repeat" and out["changed"] == []
    assert "run-to-run variation" in out["summary"] and "does not yet fingerprint" in out["summary"]


def test_a_confounded_jump_decomposes_into_a_chain_of_clean_steps():
    """A → B moves rule date, prompt and model at once; the runs in between move one each."""
    a = run("a")
    step1 = run("s1", rule_date="2026-10-01")
    step2 = run("s2", rule_date="2026-10-01", prompt="p2")
    b = run("b", rule_date="2026-10-01", prompt="p2", model="sim-small|simulated")
    out = at.attribute(a, b, [step2, step1])
    assert out["verdict"] == "confounded"
    assert out["summary"].startswith("The prompt, model and rule date changed together.")
    assert "isolate each change on its own" in out["summary"]
    pairs = {p["factor"]: (p["a_run_id"], p["b_run_id"]) for p in out["isolating_pairs"]}
    assert pairs == {"rule_date": ("a", "s1"), "prompt": ("s1", "s2"), "model": ("s2", "b")}


def test_every_suggested_pair_moves_its_factor_the_same_way_as_the_comparison():
    a, b = run("a"), run("b", prompt="p2", model="sim-small|simulated")
    # Only reverse moves exist for the model (small -> large), so none may be offered for it.
    reverse_from = run("r1", model="sim-small|simulated", rule_date="2027-01-01")
    reverse_to = run("r2", rule_date="2027-01-01")
    prompt_only = run("p", prompt="p2")
    pool = (a, b, reverse_from, reverse_to, prompt_only)
    out = at.attribute(a, b, [reverse_from, reverse_to, prompt_only])
    assert [p["factor"] for p in out["isolating_pairs"]] == ["prompt", "model"]
    for p in out["isolating_pairs"]:
        c = next(r for r in pool if r.run_id == p["a_run_id"])
        d = next(r for r in pool if r.run_id == p["b_run_id"])
        assert at.changed_factors(c, d) == [p["factor"]]
        assert (c.key[p["factor"]], d.key[p["factor"]]) == (a.key[p["factor"]], b.key[p["factor"]])


def test_a_partial_decomposition_names_what_is_still_unisolated():
    a, b = run("a"), run("b", prompt="p2", model="sim-small|simulated")
    # n -> m swaps the model under another rule date; nothing moves the prompt alone.
    out = at.attribute(a, b, [run("m", model="sim-small|simulated", rule_date="2027-01-01"),
                              run("n", rule_date="2027-01-01")])
    assert [p["factor"] for p in out["isolating_pairs"]] == ["model"]
    assert "isolate the model change; no pair isolates the prompt change yet" in out["summary"]


def test_nothing_to_suggest_says_how_to_get_a_clean_comparison():
    out = at.attribute(run("a"), run("b", prompt="p2", corpus="c2"))
    assert out["isolating_pairs"] == []
    assert "start runs that change one thing at a time" in out["summary"]


def test_overrides_that_follow_from_a_different_set_of_calls_are_not_a_second_change():
    out = at.attribute(run("a"), run("b", corpus="c2", overrides="1"))
    assert out["verdict"] == "isolated" and [c["factor"] for c in out["changed"]] == ["corpus"]
    same_calls = at.attribute(run("a"), run("b", overrides="1"))
    assert same_calls["verdict"] == "isolated" and same_calls["changed"][0]["factor"] == "overrides"


def test_a_judge_change_confounds_only_the_advisory_contracts():
    out = at.attribute(run("a"), run("b", model="sim-small|simulated", judge="ollama/qwen2.5:7b-instruct"))
    assert out["verdict"] == "confounded"
    assert out["scope_note"].startswith("Deterministic, release-blocking contracts are still attributable to the "
                                        "model change")


# ---------------------------------------------------------------- over HTTP, on simulated runs


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def chain(seeded, settings):
    """rule flip → prompt fix → model swap, each one change from the last."""
    from backstop.db import SessionLocal

    steps = [(1, "sim-large", date(2026, 9, 30)), (1, "sim-large", date(2026, 10, 1)),
             (2, "sim-large", date(2026, 10, 1)), (2, "sim-small", date(2026, 10, 1))]
    with SessionLocal() as session:
        ids = [execute_run(session, settings, workflow_code="qa-handoff", prompt_version=v, model_id=m,
                           adapter_kind="simulated", rule_date=d, actor="tests").run.id for v, m, d in steps]
        session.commit()
    return ids


def _compare(client, a: str, b: str) -> dict:
    r = client.get(f"/api/runs/compare?a={a}&b={b}", headers=auth("analyst"))
    assert r.status_code == 200, r.text
    return r.json()


def test_compare_marks_a_single_change_as_isolated(client, chain):
    body = _compare(client, chain[1], chain[2])
    att = body["attribution"]
    assert att["verdict"] == "isolated"
    assert [c["factor"] for c in att["changed"]] == ["prompt"]
    assert (att["changed"][0]["a"], att["changed"][0]["b"]) == ("v1", "v2")
    assert not any(c.startswith("Confounded") for c in body["statistics"]["cautions"])


def test_compare_flags_a_confounded_jump_and_every_suggestion_is_itself_isolated(client, chain):
    body = _compare(client, chain[0], chain[3])
    att = body["attribution"]
    assert att["verdict"] == "confounded"
    assert {c["factor"] for c in att["changed"]} == {"prompt", "model", "rule_date"}
    assert body["statistics"]["cautions"][0].startswith("Confounded: prompt, model, rule date changed together")
    assert {p["factor"] for p in att["isolating_pairs"]} == {"prompt", "model", "rule_date"}
    for pair in att["isolating_pairs"]:
        sub = _compare(client, pair["a_run_id"], pair["b_run_id"])["attribution"]
        assert sub["verdict"] == "isolated", pair
        assert [c["factor"] for c in sub["changed"]] == [pair["factor"]]
