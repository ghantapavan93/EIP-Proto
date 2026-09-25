"""Compare statistics and contract metrics over HTTP, on the recorded 7B cassettes.

The headline lesson, computed by the product rather than asserted by the README:
the v2 -> v3 prompt fix is a significant improvement on the development calls it was
written against (McNemar p = 0.00073) and a significant regression on the held-out
calls (p = 3.8e-06).
"""

from __future__ import annotations

import base64
from datetime import date

import pytest
from fastapi.testclient import TestClient

from backstop.harness import adapters
from backstop.harness import corpus as cp
from backstop.harness.runner import execute_run, seed_corpus
from backstop.main import app

MODEL = "ollama/qwen2.5:7b-instruct"


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def runs_7b(seeded, settings):
    """The four recorded 7B runs: {(corpus, prompt version): run id}. Replayed, never live."""
    from backstop.db import SessionLocal

    mp = pytest.MonkeyPatch()
    mp.setattr(adapters, "_live_adapter", lambda *a, **k: None)
    ids = {}
    try:
        with SessionLocal() as session:
            seed_corpus(session, seed=cp.HOLDOUT_SEED, prefix=cp.HOLDOUT_PREFIX)
            session.commit()
            for corpus in ("synthetic", "holdout"):
                for version in (2, 3):
                    run = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=version,
                                      model_id=MODEL, adapter_kind="cassette", rule_date=date(2026, 10, 1),
                                      actor="tests", corpus=corpus).run
                    if run.status != "COMPLETE" or run.stats.get("adapter_errors"):
                        pytest.skip(f"7B cassettes for v{version} on {corpus} are needed")
                    ids[(corpus, version)] = run.id
            session.commit()
    finally:
        mp.undo()
    return ids


def _compare(client, a: str, b: str) -> dict:
    r = client.get(f"/api/runs/compare?a={a}&b={b}", headers=auth("analyst"))
    assert r.status_code == 200, r.text
    return r.json()


def _tpmo(body: dict) -> dict:
    return next(p for p in body["statistics"]["per_contract"] if p["contract_code"] == "C-TPMO-01")


def test_dev_compare_finds_a_significant_improvement(client, runs_7b):
    body = _compare(client, runs_7b[("synthetic", 2)], runs_7b[("synthetic", 3)])
    st = body["statistics"]
    assert st["mode"] == "paired" and st["alpha"] == 0.05
    row = _tpmo(body)
    assert row["paired"] == {"both_pass": 38, "a_only_fail": 17, "b_only_fail": 2, "both_fail": 3}
    assert (row["a"]["k"], row["b"]["k"], row["n_shared"]) == (20, 5, 60)
    assert row["a"]["ci_low"] == pytest.approx(0.2273, abs=1e-4) and row["a"]["ci_high"] == pytest.approx(0.4594, abs=1e-4)
    assert row["p_value"] == pytest.approx(7.286e-4, rel=1e-3)
    assert row["significant"] and row["direction"] == "better"
    assert row["verdict"] == "B is significantly better on this contract (p=0.00073)"
    assert row["p_holm"] < 0.05, "survives correction across the eight contracts"
    # The product says out loud why this number is not the end of the story.
    assert any("held-out" in c for c in st["cautions"])
    # Legacy fields unchanged; ERROR now broken out and the definition stated.
    legacy = next(p for p in body["per_contract"] if p["contract_code"] == "C-TPMO-01")
    assert legacy["a_fail"] == 20 and legacy["b_fail"] == 5 and legacy["a_error"] == legacy["b_error"] == 0
    assert "ERROR" in body["failure_definition"]


def test_held_out_compare_finds_a_significant_regression(client, runs_7b):
    body = _compare(client, runs_7b[("holdout", 2)], runs_7b[("holdout", 3)])
    row = _tpmo(body)
    assert row["paired"] == {"both_pass": 36, "a_only_fail": 0, "b_only_fail": 19, "both_fail": 5}
    assert (row["a"]["k"], row["b"]["k"]) == (5, 24), "22 FAIL + 2 ERROR: ERROR counts as failure"
    assert row["p_value"] == pytest.approx(3.815e-6, rel=1e-3)
    assert row["direction"] == "worse" and row["verdict"] == "B is significantly worse on this contract (p=3.8e-06)"
    legacy = next(p for p in body["per_contract"] if p["contract_code"] == "C-TPMO-01")
    assert legacy["b_fail"] == 24 and legacy["b_error"] == 2
    overall = body["statistics"]["overall"]
    assert overall["contract_code"] == "ALL-BLOCK" and overall["direction"] == "worse"
    # Small contracts do not get a verdict they cannot support.
    soa = next(p for p in body["statistics"]["per_contract"] if p["contract_code"] == "C-SOA-01")
    assert soa["direction"] == "none" and any("too few changed calls" in c for c in soa["cautions"])


def test_dev_versus_held_out_is_unpaired(client, runs_7b):
    body = _compare(client, runs_7b[("synthetic", 2)], runs_7b[("holdout", 2)])
    st = body["statistics"]
    assert st["mode"] == "unpaired" and "paired test is invalid" in st["cautions"][0]
    row = _tpmo(body)
    assert row["paired"] is None and row["test"] == "Fisher exact (two-sided)"
    assert row["p_value"] == pytest.approx(0.0013085, rel=1e-4)  # the two draws are not exchangeable


def test_contract_metrics_for_one_run_show_where_the_model_fails(client, runs_7b):
    run_id = runs_7b[("holdout", 3)]
    r = client.get(f"/api/contracts/C-TPMO-01/metrics?run_id={run_id}", headers=auth("analyst"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["metric_family"] == "judgment" and "violation" in body["positive_definition"]
    [m] = body["runs"]
    c = m["confusion"]
    assert (c["tp"], c["fn"], c["fp"], c["tn"], c["no_output"]) == (0, 8, 14, 36, 2)
    assert c["recall"]["k"] == 0 and c["recall"]["n"] == 8 and c["f1"] == 0.0
    assert m["failure"]["k"] == 24 and m["failure"]["n"] == 60
    scenario_c = next(s for s in m["slices"] if s["dimension"] == "scenario" and s["value"] == "C")
    assert scenario_c["fn"] == 4 and scenario_c["notable"]
    assert any(f.startswith("scenario C: 4/4 violations missed") for f in m["findings"])


def test_contract_metrics_default_to_latest_dev_run_per_model_and_prompt(client, runs_7b):
    body = client.get("/api/contracts/C-TPMO-01/metrics", headers=auth("analyst")).json()
    assert "corpus=synthetic" in body["selection"]
    keys = [(m["model_id"], m["prompt_version"]) for m in body["runs"]]
    assert len(keys) == len(set(keys)) and all(m["corpus"] == "synthetic" for m in body["runs"])
    v2 = next(m for m in body["runs"] if m["model_id"] == MODEL and m["prompt_version"] == 2)
    assert v2["run_id"] == runs_7b[("synthetic", 2)]
    assert (v2["confusion"]["fp"], v2["confusion"]["fn"]) == (18, 2), "v2 over-flags compliant calls in-sample"
    # The trend covers every corpus, oldest first, with a CI on each point.
    trend = {p["run_id"]: p for p in body["trend"]}
    assert trend[runs_7b[("holdout", 3)]]["failure"]["k"] == 24
    started = [p["started_at"] for p in body["trend"]]
    assert started == sorted(started)


def test_grounding_and_flag_contract_metrics(client, runs_7b):
    run_id = runs_7b[("synthetic", 3)]
    span = client.get(f"/api/contracts/C-SPAN-01/metrics?run_id={run_id}", headers=auth("analyst")).json()
    assert span["metric_family"] == "grounding" and span["runs"][0]["confusion"] is None
    assert span["runs"][0]["failure"]["n"] == 60
    sup = client.get(f"/api/contracts/C-SUP-01/metrics?run_id={run_id}", headers=auth("analyst")).json()
    assert sup["metric_family"] == "flags" and sup["runs"][0]["confusion"]["tn"] is None
    assert sup["runs"][0]["confusion"]["unit"] == "flagged phrase"


def test_contract_metrics_404s(client):
    assert client.get("/api/contracts/NOPE/metrics", headers=auth("analyst")).status_code == 404
    assert client.get("/api/contracts/C-TPMO-01/metrics?run_id=nope", headers=auth("analyst")).status_code == 404
    assert client.get("/api/contracts/C-TPMO-01/metrics").status_code == 401
