"""Review-task state machine.

Three kinds of task share one vocabulary of states so the UI and the audit
log stay uniform, but each kind has its own legal transitions. Illegal
transitions raise and are audit-logged as rejected attempts by the caller.

  STALE_ASSET     open -> in_review -> verified -> republished
                  open | in_review -> dismissed
  PROPOSED_EDGE   open -> verified (confirm)  |  open -> dismissed (reject)
  FLAGGED_RESULT  open -> in_review -> upheld | overridden
                  open -> upheld | overridden   (fast path)
  RULE_SOURCE_CHANGED
                  open -> in_review -> verified (a new rule version was added) | dismissed (no material change)

Terminal states: republished, dismissed, upheld, overridden; `verified` is
terminal for RULE_SOURCE_CHANGED.
"""

from __future__ import annotations

OPEN = "open"
IN_REVIEW = "in_review"
VERIFIED = "verified"
REPUBLISHED = "republished"
DISMISSED = "dismissed"
UPHELD = "upheld"
OVERRIDDEN = "overridden"

TERMINAL = {REPUBLISHED, DISMISSED, UPHELD, OVERRIDDEN}

TRANSITIONS: dict[str, dict[str, set[str]]] = {
    "STALE_ASSET": {
        OPEN: {IN_REVIEW, DISMISSED},
        IN_REVIEW: {VERIFIED, DISMISSED},
        VERIFIED: {REPUBLISHED},
    },
    "PROPOSED_EDGE": {
        OPEN: {VERIFIED, DISMISSED},
    },
    "FLAGGED_RESULT": {
        OPEN: {IN_REVIEW, UPHELD, OVERRIDDEN},
        IN_REVIEW: {UPHELD, OVERRIDDEN},
    },
    "RULE_SOURCE_CHANGED": {
        OPEN: {IN_REVIEW, DISMISSED},
        IN_REVIEW: {VERIFIED, DISMISSED},
    },
}

# Roles allowed to *decide* (move to a terminal or verified state). Anyone may
# pick a task up (open -> in_review).
DECIDER_ROLES = {"analyst", "engineer", "admin"}
REPUBLISH_ROLES = {"engineer", "admin"}

REASON_CODES = {
    "FALSE_POSITIVE_MATCHER",
    "FALSE_POSITIVE_JUDGE",
    "TRANSCRIPT_AMBIGUOUS",
    "RULE_EXCEPTION_APPLIES",
    "CORRECT_AS_FLAGGED",
    "ARTIFACT_ALREADY_UPDATED",
    "ARTIFACT_NOT_IN_SCOPE",
    "NEEDS_COUNSEL",
    "OTHER",
}


class IllegalTransition(Exception):
    def __init__(self, kind: str, current: str, target: str):
        super().__init__(f"{kind}: {current} -> {target} is not allowed")
        self.kind, self.current, self.target = kind, current, target


class Forbidden(Exception):
    pass


def assert_transition(kind: str, current: str, target: str, role: str) -> None:
    allowed = TRANSITIONS.get(kind, {}).get(current, set())
    if target not in allowed:
        raise IllegalTransition(kind, current, target)
    if target == REPUBLISHED and role not in REPUBLISH_ROLES:
        raise Forbidden(f"role '{role}' may not republish")
    if target in (VERIFIED, DISMISSED, UPHELD, OVERRIDDEN) and role not in DECIDER_ROLES:
        raise Forbidden(f"role '{role}' may not decide review tasks")


def allowed_for_role(kind: str, current: str, role: str) -> set[str]:
    """Targets this role may actually move the task to (what the UI should offer)."""
    out = set()
    for target in TRANSITIONS.get(kind, {}).get(current, set()):
        try:
            assert_transition(kind, current, target, role)
        except (IllegalTransition, Forbidden):
            continue
        out.add(target)
    return out


def is_terminal(state: str) -> bool:
    return state in TERMINAL
