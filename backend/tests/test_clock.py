"""The date rules are evaluated on is the compliance calendar's, not the server's."""

from __future__ import annotations

import base64
from datetime import UTC, date, datetime

import pytest
from fastapi.testclient import TestClient

from backstop.config import Settings, get_settings
from backstop.core import clock
from backstop.main import app

# 9 p.m. on September 30 in New York: a UTC server already reads October 1, the day the
# 48-hour SOA wait is eliminated.
INSTANT = datetime(2026, 10, 1, 1, 0, tzinfo=UTC)


def auth(user: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{user}".encode()).decode()}


@pytest.fixture
def pinned(monkeypatch):
    monkeypatch.setattr(clock, "_now", lambda: INSTANT)


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


def test_today_is_the_new_york_date(pinned):
    assert clock.compliance_today() == date(2026, 9, 30)


def test_the_time_zone_is_configurable(pinned, monkeypatch):
    monkeypatch.setattr(get_settings(), "compliance_tz", "UTC")
    assert clock.compliance_today() == date(2026, 10, 1)


def test_an_unknown_time_zone_fails_at_startup():
    with pytest.raises(ValueError, match="not an IANA time zone"):
        Settings(compliance_tz="America/Atlantis")


def test_endpoints_default_to_the_compliance_date(pinned, client):
    assert client.get("/api/meta", headers=auth("analyst")).json()["today"] == "2026-09-30"
    impact = client.get("/api/rules/soa-48h-wait/impact", headers=auth("analyst")).json()
    assert impact["as_of"] == "2026-09-30" and impact["in_force_version"] == 1
    rule = client.get("/api/rules/soa-48h-wait", headers=auth("analyst")).json()
    assert rule["in_force_version"] == 1
    readiness = client.get("/api/readiness", headers=auth("analyst")).json()
    assert readiness["as_of"] == "2026-09-30" and readiness["burn_down"]["days_left"] == 1
