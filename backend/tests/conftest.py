"""Test fixtures: an isolated SQLite database per test session, seeded once."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

_TMP = Path(tempfile.mkdtemp(prefix="backstop-tests-"))
# BACKSTOP_TEST_DATABASE_URL runs the suite against a real Postgres (CI does);
# it must point at a disposable, empty database. Default: a fresh SQLite file.
os.environ["BACKSTOP_DATABASE_URL"] = os.environ.get(
    "BACKSTOP_TEST_DATABASE_URL", f"sqlite:///{(_TMP / 'test.db').as_posix()}"
)
os.environ.pop("ANTHROPIC_API_KEY", None)
# Tests log in as analyst/engineer/admin; a developer's .env (real demo passwords)
# must not leak into them. Environment variables outrank the .env file.
os.environ["BACKSTOP_USERS"] = "analyst:analyst:analyst,engineer:engineer:engineer,admin:admin:admin"

from backstop.config import get_settings  # noqa: E402
from backstop.core.rules_loader import load_rules  # noqa: E402
from backstop.db import SessionLocal, init_schema  # noqa: E402
from backstop.harness import runner  # noqa: E402
from backstop.scanner.service import load_inventory, run_scan  # noqa: E402


@pytest.fixture(scope="session")
def settings():
    return get_settings()


@pytest.fixture(scope="session")
def seeded(settings):
    init_schema()
    with SessionLocal() as session:
        load_rules(session, settings.rules_dir, actor="tests")
        runner.seed_models(session)
        runner.seed_workflow(session)
        runner.seed_contracts(session, settings.contracts_dir)
        runner.seed_corpus(session)
        load_inventory(session, settings.fixtures_dir)
        session.commit()
        run_scan(session, settings, idempotency_key="tests:scan", live=False, actor="tests")
    return True


@pytest.fixture
def session(seeded):
    with SessionLocal() as s:
        yield s
