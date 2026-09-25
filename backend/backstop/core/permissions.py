"""Who may do what — the table behind GET /api/me.

Every row is derived from, or tested against, the code that enforces it:

* review-task decisions come from `state_machine` (DECIDER_ROLES, REPUBLISH_ROLES,
  and the fact that anyone may pick a task up);
* write endpoints list the (method, path) they guard; a test walks the app's
  routes and fails if any `require_role(...)` disagrees with this table or is
  missing from it;
* "open stale-artifact tasks from the impact view" is OPEN_STALE_TASK_ROLES,
  which `api/rules.py` reads directly.

Nothing here grants anything: it describes. Enforcement stays where it is.
"""

from __future__ import annotations

from dataclasses import dataclass

from backstop.config import VALID_ROLES
from backstop.core import state_machine as sm

ROLE_ORDER = ("analyst", "engineer", "admin")
assert set(ROLE_ORDER) == VALID_ROLES

# The roles every engineer/admin-only endpoint names in require_role(...).
OPERATOR_ROLES = frozenset({"engineer", "admin"})
EVERYONE = frozenset(VALID_ROLES)
# api/rules.py reads this to decide whether an impact read may open STALE_ASSET tasks.
OPEN_STALE_TASK_ROLES = OPERATOR_ROLES

ROLE_INFO: dict[str, tuple[str, str]] = {
    "analyst": (
        "QA Compliance Analyst",
        "Reads everything and decides review tasks (verify, dismiss, uphold, override). Does not start runs "
        "or scans, change rules, republish artifacts or approve test cases.",
    ),
    "engineer": (
        "AI Enablement Engineer",
        "Everything an analyst can do, plus starting runs and scans, proposing rule versions, ingesting "
        "transcripts, republishing artifacts and approving test cases someone else created.",
    ),
    "admin": (
        "Administrator",
        "The same permissions as an engineer in this prototype. Accounts come from BACKSTOP_USERS, a stand-in "
        "for SSO; there is no user management screen.",
    ),
}


@dataclass(frozen=True)
class Action:
    action: str
    label: str
    roles: frozenset[str]
    rule: str  # extra condition, in words a reviewer can check ("" when the role is the whole rule)
    endpoints: tuple[tuple[str, str], ...] = ()  # (METHOD, path) guarded by require_role


def _pick_up_roles() -> frozenset[str]:
    return frozenset(r for r in VALID_ROLES if sm.IN_REVIEW in sm.allowed_for_role("STALE_ASSET", sm.OPEN, r))


ACTIONS: tuple[Action, ...] = (
    Action("view", "View rules, artifacts, runs, the review queue and the audit log", EVERYONE, ""),
    Action("pick_up_tasks", "Pick up a review task (open → in review)", _pick_up_roles(),
           "the review state machine lets anyone start a review"),
    Action("decide_tasks", "Decide review tasks (verify, dismiss, uphold, override)", frozenset(sm.DECIDER_ROLES),
           "dismiss, uphold and override need a reason code"),
    Action("republish", "Mark a verified stale artifact as republished", frozenset(sm.REPUBLISH_ROLES),
           "the task must be verified first"),
    Action("approve_test_cases", "Approve a test case (a different person from its creator)", OPERATOR_ROLES,
           "never one you created yourself: two-person rule",
           (("POST", "/api/test-cases/{case_id}/approve"),)),
    Action("start_runs", "Start a harness run", OPERATOR_ROLES, "", (("POST", "/api/runs"),)),
    Action("start_scans", "Scan the artifact inventory", OPERATOR_ROLES, "", (("POST", "/api/scans"),)),
    Action("check_rule_sources", "Check the regulators' source pages for changed text", OPERATOR_ROLES, "",
           (("POST", "/api/sources/check"),)),
    Action("propose_rule_versions", "Propose a new rule version (what-if)", OPERATOR_ROLES, "",
           (("POST", "/api/rules/{code}/versions"),)),
    Action("reload_rules", "Reload the rule corpus from git", OPERATOR_ROLES, "",
           (("POST", "/api/rules/reload"),)),
    Action("ingest_transcripts", "Ingest transcripts from an export file", OPERATOR_ROLES, "",
           (("POST", "/api/ingest/transcripts"),)),
    Action("open_stale_tasks", "Open stale-artifact review tasks by reading a rule's impact", OPEN_STALE_TASK_ROLES,
           "an analyst's impact read shows the same verdicts and changes nothing"),
    Action("export_evidence", "Export evidence bundles and run results", EVERYONE,
           "every export is audit-logged"),
    Action("use_sandbox", "Check pasted text in the sandbox", EVERYONE,
           "rate-limited per user; nothing pasted is stored"),
)


def _names(roles: frozenset[str]) -> str:
    ordered = [r for r in ROLE_ORDER if r in roles]
    if set(ordered) == VALID_ROLES:
        return "any signed-in role"
    return " or ".join(ordered)


def permissions_for(role: str) -> list[dict]:
    out = []
    for a in ACTIONS:
        allowed = role in a.roles
        who = _names(a.roles)
        if allowed:
            why = f"Allowed for {who}" + (f"; {a.rule}" if a.rule else "") + "."
        else:
            why = f"Not allowed: only {who} may do this" + (f" ({a.rule})" if a.rule else "") + "."
        out.append({"action": a.action, "label": a.label, "allowed": allowed, "why": why})
    return out


def roles_overview() -> list[dict]:
    return [
        {"role": r, "label": ROLE_INFO[r][0], "description": ROLE_INFO[r][1],
         "can": [a.action for a in ACTIONS if r in a.roles]}
        for r in ROLE_ORDER
    ]


def me(name: str, role: str) -> dict:
    label, description = ROLE_INFO[role]
    return {"name": name, "role": role, "role_label": label, "role_description": description,
            "permissions": permissions_for(role), "roles": roles_overview()}
