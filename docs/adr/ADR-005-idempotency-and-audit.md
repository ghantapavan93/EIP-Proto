# ADR-005 — Idempotency keys everywhere; an append-only audit log is the product's receipt

**Status:** accepted · 2026-09-22

## Context

Call-center workflows are retried constantly. A double-write is a compliance
event. A carrier oversight conversation wants to know who knew what was stale,
when, and what they did about it. The Full Stack posting's job is literally
"turn prototypes into reliable production-ready applications".

## Decision

Unique keys make every operation converge:

| Operation | Key |
|---|---|
| Scan | `idempotency_key` — same key returns the existing scan |
| Artifact version | `(asset, content_hash)` — same content, same row |
| Edge | `(rule_version, asset, evidence_span)` |
| Stale-asset task | `stale:<rule_version_in_force>:<asset>` |
| Proposed-edge task | `edge:<edge>` |
| Run | `workflow:prompt_hash:model:adapter:corpus_hash:contract_set_hash:rule_date`, plus `:tc=<hash>` of the approved test cases in scope, if any |
| Run result | `(run, transcript, contract_version)` |
| Flagged-result task | `result:<run_result>`; judged contracts: one aggregate task per run |

Failure handling: a fetch error marks the artifact `fetch_error` and the scan
`partial`, never failed wholesale; an adapter error is stored on the output
row and every contract records `ERROR` for that transcript; an illegal state
transition returns 409 and is itself audit-logged; a forbidden one returns
403 and is audit-logged.

`audit_events` is append-only with a closed vocabulary
(`core/audit.py::EVENT_TYPES`); the recorder raises on an unknown type so the
vocabulary cannot drift silently.

## Consequences

- Re-running the demo, restarting the container, or double-submitting a form
  changes nothing.
- Approving an override test case changes the run key, so the next run on
  those calls is a new run, not a dedupe to the old one. That run still
  computes the verdict but marks it `override` (test case id, reason, creator,
  approver); it does not block the gate or reopen a task. Expiry (365 days)
  drops the case from the key and restores normal behaviour.
- `staleness.evaluated` events carry the full stale set — the receipt.
- Tests assert idempotency directly (`test_scan_twice_changes_nothing`,
  `test_runs_are_idempotent`).
