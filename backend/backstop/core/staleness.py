"""Staleness engine — the deterministic core.

Given a rule's version history, an as-of date, and the edges that bind
artifacts to specific rule versions, decide which artifacts are stale and in
which direction. No model is involved; every verdict carries a reason string
that a compliance reviewer can read.

Directions:
  over_restrictive  — the artifact still enforces something the rule no longer
                      requires (lost same-day conversions, needless friction)
  under_restrictive — the artifact encodes an older, weaker clause or misses a
                      new requirement (violation exposure)
  reverify          — the clause changed in a way that needs a human read
                      (basis changed, wording clarified, disputed reading)

Versions that are never in force: ``proposed`` (not law yet), ``vacated`` (a court
set it aside) and ``stayed`` (a court or the agency paused it). They keep their
original dates for history, but they are skipped when resolving the version in
force and when walking the path between two versions. An artifact bound to a
vacated or stayed version is always stale: it encodes text that is not the law,
even when a public source (eCFR) still prints it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

OVER = "over_restrictive"
UNDER = "under_restrictive"
REVERIFY = "reverify"

# Statuses that are never in force, whatever their dates say.
NEVER_IN_FORCE = frozenset({"proposed", "vacated", "stayed"})
# A court (or the agency) set the version aside: it never governed, and an artifact that
# encodes it is stale against whatever version is in force.
SET_ASIDE = frozenset({"vacated", "stayed"})

# change_classification -> (direction, reason) for ENFORCES edges and for PERMITS edges.
_TABLE: dict[str, tuple[tuple[str, str], tuple[str, str]]] = {
    "REMOVES_REQUIREMENT": (
        (OVER, "the requirement this artifact enforces was removed"),
        (REVERIFY, "the clause this artifact describes was removed; confirm the wording no longer implies it"),
    ),
    "LOOSENS": (
        (OVER, "the rule was loosened; the artifact still applies the stricter clause"),
        (REVERIFY, "the rule was loosened; confirm the artifact describes the current, less strict clause"),
    ),
    "ADDS_REQUIREMENT": (
        (UNDER, "a new requirement applies that this artifact does not encode"),
        (UNDER, "a new requirement applies that this artifact does not mention"),
    ),
    "TIGHTENS": (
        (UNDER, "the rule was tightened; the artifact still encodes the weaker clause"),
        (UNDER, "the rule was tightened; the artifact still describes the weaker clause"),
    ),
    "MODIFIES": (
        (REVERIFY, "the basis of the rule changed; both over- and under-restrictive encodings are possible"),
        (REVERIFY, "the basis of the rule changed; confirm the artifact describes the new basis"),
    ),
    "CLARIFIES": (
        (REVERIFY, "wording was clarified; confirm the artifact's text matches the current clause"),
        (REVERIFY, "wording was clarified; confirm the artifact's text matches the current clause"),
    ),
    # A court set a later version aside and the earlier text governs again (often with new
    # figures, e.g. a new year's compensation caps). Same words, different footing: read it.
    "RESTORES_PRIOR": (
        (REVERIFY, "the earlier text was restored after a later version was set aside; confirm the artifact "
                   "matches the restored text and the current figures"),
        (REVERIFY, "the earlier text was restored after a later version was set aside; confirm the artifact "
                   "describes the restored text and the current figures"),
    ),
}


@dataclass(frozen=True)
class VersionView:
    id: str
    version: int
    status: str
    effective_from: date | None  # None only for an undated proposal
    effective_to: date | None
    change_classification: str
    disputed: bool = False


@dataclass(frozen=True)
class EdgeView:
    id: str
    asset_id: str
    bound_version_id: str
    polarity: str  # ENFORCES | PERMITS | INFORMS
    status: str = "confirmed"


@dataclass(frozen=True)
class StaleVerdict:
    edge_id: str
    asset_id: str
    bound_version: int
    in_force_version: int
    direction: str
    reason: str
    disputed: bool


def version_in_force(versions: list[VersionView], as_of: date) -> VersionView | None:
    """The version whose [effective_from, effective_to] contains as_of.

    ``proposed``, ``vacated`` and ``stayed`` versions are never in force, whatever their
    dates say (NEVER_IN_FORCE).
    """
    for v in sorted(versions, key=lambda x: x.version):
        if v.status in NEVER_IN_FORCE or v.effective_from is None:
            continue
        if v.effective_from <= as_of and (v.effective_to is None or as_of <= v.effective_to):
            return v
    return None


def evaluate(
    versions: list[VersionView], edges: list[EdgeView], as_of: date
) -> list[StaleVerdict]:
    """Return one verdict per confirmed edge that is bound to a superseded version."""
    current = version_in_force(versions, as_of)
    if current is None:
        return []
    by_id = {v.id: v for v in versions}
    verdicts: list[StaleVerdict] = []
    for edge in edges:
        if edge.status != "confirmed":
            continue
        bound = by_id.get(edge.bound_version_id)
        if bound is None or bound.id == current.id:
            continue
        if bound.status in SET_ASIDE:
            # Never law. Stale against whatever is in force, before or after it in numbering.
            direction, reason = _direction_for_set_aside(bound, edge.polarity)
            verdicts.append(
                StaleVerdict(
                    edge_id=edge.id,
                    asset_id=edge.asset_id,
                    bound_version=bound.version,
                    in_force_version=current.version,
                    direction=direction,
                    reason=(f"bound to v{bound.version} ({bound.status}); v{current.version} in force as of "
                            f"{as_of.isoformat()}: {reason}"),
                    disputed=bound.disputed or current.disputed,
                )
            )
            continue
        if bound.status == "proposed" or bound.version > current.version:
            # The artifact already encodes a version that is not yet in force (or is only
            # proposed): ahead of the rule, not stale. (Evaluating "as of Sept 30" must not
            # flag artifacts that were updated early for Oct 1.)
            continue
        # Walk the enacted versions between the bound one and the current one; the
        # strongest change on that path decides the direction. Versions that were never in
        # force (a vacated rewrite, a proposal) are not part of the path.
        path = [
            v for v in sorted(versions, key=lambda x: x.version)
            if bound.version < v.version <= current.version and v.status not in NEVER_IN_FORCE
        ]
        direction, reason = _direction_for_path(path, edge.polarity)
        verdicts.append(
            StaleVerdict(
                edge_id=edge.id,
                asset_id=edge.asset_id,
                bound_version=bound.version,
                in_force_version=current.version,
                direction=direction,
                reason=f"bound to v{bound.version}; v{current.version} in force as of {as_of.isoformat()}: {reason}",
                disputed=any(v.disputed for v in path),
            )
        )
    return verdicts


def _direction_for_set_aside(bound: VersionView, polarity: str) -> tuple[str, str]:
    """Direction for an artifact that encodes a vacated or stayed version.

    Enforcing a set-aside tightening is over-restrictive; relying on a set-aside loosening is
    under-restrictive; anything else (an informational mention, a basis change) needs a read.
    """
    what = "a court vacated" if bound.status == "vacated" else "is stayed (paused; the stay could be lifted)"
    cls = bound.change_classification
    if polarity == "INFORMS":
        return REVERIFY, (f"informational artifact references a clause that {what}; it never took effect. "
                          "Confirm the artifact does not present it as the rule")
    if polarity == "ENFORCES" and cls in ("TIGHTENS", "ADDS_REQUIREMENT"):
        return OVER, f"the artifact enforces a stricter clause that {what}; the version in force does not require it"
    if cls in ("LOOSENS", "REMOVES_REQUIREMENT"):
        return UNDER, f"the artifact relies on a relaxation that {what}; the stricter version in force governs"
    return REVERIFY, f"the artifact encodes a clause that {what}; confirm it against the version in force"


def _direction_for_path(path: list[VersionView], polarity: str) -> tuple[str, str]:
    if not path:
        return REVERIFY, "no change classification on path"
    if polarity == "INFORMS":
        return REVERIFY, "informational artifact references a superseded clause"
    directions: list[tuple[str, str]] = []
    for v in path:
        enforce, permit = _TABLE.get(
            v.change_classification,
            ((REVERIFY, "unclassified change"), (REVERIFY, "unclassified change")),
        )
        directions.append(enforce if polarity == "ENFORCES" else permit)
    # Priority: a definite direction beats reverify; if both definite directions
    # appear on the path, the human must look.
    definite = {d for d, _ in directions if d in (OVER, UNDER)}
    if len(definite) == 1:
        d = definite.pop()
        reason = next(r for dd, r in directions if dd == d)
        return d, reason
    if len(definite) > 1:
        return REVERIFY, "successive changes pull in opposite directions"
    return directions[-1]


def summarize(verdicts: list[StaleVerdict]) -> dict[str, int]:
    """Counts by direction (per edge) plus the number of distinct artifacts affected."""
    counts = {OVER: 0, UNDER: 0, REVERIFY: 0, "disputed": 0}
    for v in verdicts:
        counts[v.direction] += 1
        if v.disputed:
            counts["disputed"] += 1
    counts["total"] = len(verdicts)
    counts["artifacts"] = len({v.asset_id for v in verdicts})
    return counts
