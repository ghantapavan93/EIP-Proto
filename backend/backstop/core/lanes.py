"""Review lanes: which open tasks need a human decision and which are observations."""

from __future__ import annotations

from typing import Any

from backstop.models import ReviewTask


def lane_for(kind: str, payload: dict[str, Any] | None) -> str:
    """Advisory items are aggregates of FLAG-severity or judged results; everything else needs a human."""
    payload = payload or {}
    if payload.get("lane") in ("actionable", "advisory"):
        return payload["lane"]
    return "advisory" if kind == "FLAGGED_RESULT" and payload.get("aggregate") else "actionable"


def task_lane(task: ReviewTask) -> str:
    return lane_for(task.kind, task.payload)
