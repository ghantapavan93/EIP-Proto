"""GET /api/me: who am I and what may my role do — checked against what the code enforces."""

from __future__ import annotations

import base64

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from backstop.config import VALID_ROLES
from backstop.core import permissions
from backstop.core import state_machine as sm
from backstop.main import app


def auth(user: str) -> dict[str, str]:
    token = base64.b64encode(f"{user}:{user}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


@pytest.fixture(scope="module")
def client(seeded):
    with TestClient(app) as c:
        yield c


def _perms(body) -> dict[str, dict]:
    return {p["action"]: p for p in body["permissions"]}


def test_me_needs_auth(client):
    assert client.get("/api/me").status_code == 401


def test_analyst_sees_what_it_may_and_may_not_do(client):
    body = client.get("/api/me", headers=auth("analyst")).json()
    assert (body["name"], body["role"], body["role_label"]) == ("analyst", "analyst", "QA Compliance Analyst")
    assert body["role_description"]
    p = _perms(body)
    for allowed in ("view", "pick_up_tasks", "decide_tasks", "export_evidence", "use_sandbox"):
        assert p[allowed]["allowed"] is True, allowed
    for denied in ("republish", "approve_test_cases", "start_runs", "start_scans", "propose_rule_versions",
                   "ingest_transcripts", "check_rule_sources", "open_stale_tasks"):
        assert p[denied]["allowed"] is False, denied
        assert p[denied]["why"].startswith("Not allowed: only engineer or admin")
    for admin_only in ADMIN_ONLY:
        assert p[admin_only]["why"].startswith("Not allowed: only admin")
    assert "two-person rule" in p["approve_test_cases"]["why"]


ADMIN_ONLY = ("reload_rules", "review_access", "checkpoint_audit")


def test_engineer_operates_but_does_not_govern(client):
    p = _perms(client.get("/api/me", headers=auth("engineer")).json())
    for action, perm in p.items():
        assert perm["allowed"] is (action not in ADMIN_ONLY), action
    assert "an admin adopts" in p["reload_rules"]["why"]


def test_admin_may_do_everything_listed_and_says_what_it_adds(client):
    body = client.get("/api/me", headers=auth("admin")).json()
    assert all(p["allowed"] for p in body["permissions"])
    roles = {r["role"]: r for r in body["roles"]}
    assert set(roles["admin"]["can"]) - set(roles["engineer"]["can"]) == set(ADMIN_ONLY)
    assert "access review" in roles["admin"]["description"]


def test_roles_overview_lists_every_role_with_its_actions(client):
    body = client.get("/api/me", headers=auth("analyst")).json()
    roles = {r["role"]: r for r in body["roles"]}
    assert set(roles) == VALID_ROLES
    assert "decide_tasks" in roles["analyst"]["can"] and "start_runs" not in roles["analyst"]["can"]
    assert set(roles["admin"]["can"]) == {p["action"] for p in body["permissions"]}
    assert all(r["label"] and r["description"] for r in roles.values())


def test_review_permissions_come_from_the_state_machine():
    by_action = {a.action: a for a in permissions.ACTIONS}
    assert by_action["decide_tasks"].roles == frozenset(sm.DECIDER_ROLES)
    assert by_action["republish"].roles == frozenset(sm.REPUBLISH_ROLES)
    for role in VALID_ROLES:
        assert (role in by_action["pick_up_tasks"].roles) == (
            sm.IN_REVIEW in sm.allowed_for_role("FLAGGED_RESULT", sm.OPEN, role))


def _required_roles(dependant) -> set[frozenset[str]]:
    found: set[frozenset[str]] = set()
    for dep in dependant.dependencies:
        roles = getattr(dep.call, "required_roles", None)
        if roles is not None:
            found.add(roles)
        found |= _required_roles(dep)
    return found


def _guarded_routes() -> dict[tuple[str, str], frozenset[str]]:
    routes: dict[tuple[str, str], frozenset[str]] = {}
    routers = [r.original_router for r in app.routes if hasattr(r, "original_router")]
    for router in routers:
        for route in router.routes:
            if not isinstance(route, APIRoute):
                continue
            required = _required_roles(route.dependant)
            if not required:
                continue
            assert len(required) == 1, route.path
            for method in route.methods:
                routes[(method, "/api" + route.path)] = next(iter(required))
    return routes


def test_permission_table_matches_every_require_role_in_the_api():
    guarded = _guarded_routes()
    assert guarded, "found no require_role routes; the introspection is broken"
    declared = {ep: a for a in permissions.ACTIONS for ep in a.endpoints}
    assert set(declared) == set(guarded), (
        f"undeclared: {sorted(set(guarded) - set(declared))}; stale: {sorted(set(declared) - set(guarded))}")
    for endpoint, action in declared.items():
        assert action.roles == guarded[endpoint], endpoint


def test_every_other_route_is_open_to_any_signed_in_role():
    """Anything not in the table is readable (or usable, like the sandbox) by every role."""
    guarded = _guarded_routes()
    routers = [r.original_router for r in app.routes if hasattr(r, "original_router")]
    sandbox_paths = set()
    for router in routers:
        for route in router.routes:
            if isinstance(route, APIRoute) and route.path.startswith("/sandbox"):
                sandbox_paths |= {(m, "/api" + route.path) for m in route.methods}
    assert sandbox_paths and not (sandbox_paths & set(guarded))


def test_impact_read_uses_the_same_roles_as_the_table():
    by_action = {a.action: a for a in permissions.ACTIONS}
    assert by_action["open_stale_tasks"].roles == permissions.OPEN_STALE_TASK_ROLES
