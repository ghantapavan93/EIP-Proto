"""A severity edit re-grades future runs only: past runs keep the severity they were scored with."""

from __future__ import annotations

import shutil
from datetime import date
from types import SimpleNamespace

import pytest
import yaml
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from backstop.api.contracts_metrics import contract_metrics
from backstop.api.serializers import result_out, run_out
from backstop.core.compare import load_cells
from backstop.core.rules_loader import load_rules
from backstop.db import Base
from backstop.harness import runner
from backstop.models import Contract, RunResult, version_severity

CODE = "C-SUP-01"  # FLAG severity in contracts.yaml


@pytest.fixture
def env(tmp_path, settings):
    contracts_dir = tmp_path / "contracts"
    shutil.copytree(settings.contracts_dir, contracts_dir)
    engine = create_engine(f"sqlite:///{(tmp_path / 'severity.db').as_posix()}")
    Base.metadata.create_all(engine)
    Session = sessionmaker(engine, expire_on_commit=False)
    with Session() as session:
        load_rules(session, settings.rules_dir, actor="tests")
        runner.seed_models(session)
        runner.seed_workflow(session)
        runner.seed_contracts(session, contracts_dir)
        runner.seed_corpus(session)
        session.commit()
    yield contracts_dir, Session
    engine.dispose()


def _set_severity(contracts_dir, code: str, severity: str) -> None:
    path = contracts_dir / "contracts.yaml"
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    next(c for c in doc["contracts"] if c["code"] == code)["severity"] = severity
    path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")


def test_version_severity_falls_back_to_the_contract_row():
    assert version_severity({"_definition": {"severity": "FLAG"}}, "BLOCK") == "FLAG"
    assert version_severity({"threshold": 3}, "BLOCK") == "BLOCK"
    assert version_severity(None, "FLAG") == "FLAG"


def test_a_past_run_keeps_the_severity_it_was_scored_with(env, settings):
    contracts_dir, Session = env
    with Session() as session:
        # Prompt v1 after the October flip flags three unsubstantiated superlatives (scenario F).
        run = runner.execute_run(session, settings, workflow_code="qa-handoff", prompt_version=1,
                                 model_id="sim-large", adapter_kind="simulated", rule_date=date(2026, 10, 1),
                                 actor="tests").run
        flagged = run.stats["contracts"][CODE]["FLAG"]
        assert flagged > 0

        _set_severity(contracts_dir, CODE, "BLOCK")
        runner.seed_contracts(session, contracts_dir, actor="tests")
        session.commit()
        contract = session.scalar(select(Contract).where(Contract.code == CODE))
        assert contract.severity == "BLOCK" and len(contract.versions) == 2

        assert load_cells(session, run.id).severity[CODE] == "FLAG"
        row = next(c for c in run_out(session, run).contracts if c.code == CODE)
        assert row.severity == "FLAG"
        result = session.scalars(select(RunResult).where(RunResult.run_id == run.id)).first()
        assert result is not None
        assert result_out(result).severity == result.contract_version.severity

        # Under FLAG severity a FLAG outcome is a failure; re-graded as BLOCK it would not be.
        metrics = contract_metrics(CODE, session, SimpleNamespace(name="tests", role="analyst"), run_id=run.id,
                                   corpus="synthetic", rule_date=None, trend_limit=50)
        assert metrics.severity == "BLOCK"  # the contract as it reads today
        assert metrics.runs[0].failure.k == flagged
        assert metrics.trend[-1].failure.k == flagged


def test_a_version_seeded_before_snapshots_is_backfilled_before_the_row_moves(env):
    contracts_dir, Session = env
    with Session() as session:
        contract = session.scalar(select(Contract).where(Contract.code == CODE))
        v1 = contract.versions[0]
        v1.spec = {k: v for k, v in v1.spec.items() if k != "_definition"}  # as older databases have it
        session.commit()

        _set_severity(contracts_dir, CODE, "BLOCK")
        runner.seed_contracts(session, contracts_dir, actor="tests")
        session.commit()
        session.refresh(contract)
        v1, v2 = contract.versions
        assert v1.severity == "FLAG" and v2.severity == "BLOCK"
