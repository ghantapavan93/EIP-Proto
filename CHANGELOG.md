# Changelog

## 0.2.0 — 2026-09-30

A line-by-line review of the whole repository, and the fixes it led to. Each
defect is described in [`docs/honesty.md`](docs/honesty.md#corrections).

### Added

- `tcpa-ai-generated-voice`: FCC 24-17 (in force since 2024-02-08) puts AI-generated
  and cloned voices under the TCPA's artificial-voice rules; v2 is the FCC 24-84
  AI-call disclosure proposal, undated. Two matchers, one of them for artifacts
  that claim an AI voice counts as a live agent, and nine golden cases.
- `docs/eip-integration.md`: each system in EIP's public stack, labelled built, not
  built or assumed, with the ingest limits.
- `docs/aep-runbook.md`: October 1 through AEP, the steps once the FCC's revocation
  order is published, and the first 30 days on real data.

### Fixed

- Confirmed edges and verified source changes were counted as open work and
  never closed; task terminality now depends on the task kind.
- PII redaction leaked the second of two overlapping hits; overlapping spans
  now merge. `C-PII-01` uses the same detector registry as the redactor.
- Historical comparisons read a contract's current severity; each contract
  version now snapshots the severity it was scored under.
- "Today" was the server's local date; rule dates now use one compliance clock
  (America/New_York).
- A crash while scoring left a zombie `RUNNING` run; it is now marked `FAILED`.
- A comparison could call a difference significant after Holm correction had
  removed it, or on a handful of changed calls.
- Reloading rules silently dropped edits to annotations such as `disputed`
  and `sources`; they are now refreshed and audited.

### Changed

- `GET /rules/{code}/impact` is read-only; `POST /rules/{code}/impact/evaluate`
  opens the review tasks.
- Alembic owns the Postgres schema; the container migrates before it serves.
- `/status` verifies the audit chain incrementally instead of in full on
  every poll.
- Comparison statistics and contract metrics moved from the API routers into
  `core/compare.py` and `core/metrics.py`.
- Terraform: HTTPS-only load balancer behind an IP allow-list, encrypted RDS
  with deletion protection, secrets in Secrets Manager, the UI container, a
  DST-aware nightly schedule and an alert when the nightly gate fails. CI now
  runs `terraform fmt` and `validate`.
- The nginx upstream is configurable, so one UI image runs under Compose and
  in the ECS task.
- Console: permissions come only from the server (`/me`); the duplicate
  hard-coded role check is gone, and the governance matrix is the server's.
  Mutations share one invalidation helper, so the audit log, status rail and
  readiness refresh after every write. Routes load lazily (main bundle 730 kB
  → 390 kB). Drawers trap and restore focus. Types match `schemas.py`; fields
  the API always sends are required, not optional.
- Tooling: Prettier and `knip` (dead code) in CI; a `make check` target.

### Fixed in the console

- The data table passed a new empty array on every render while loading,
  which re-rendered without end and froze the page.
- A review task with no recorded rule version showed an invented "bound"
  version; it now says unknown.

## 0.1.0 — 2026-09-25

First public version. The build ran 2026-09-21 to 2026-09-25; before publishing, its
history was reorganised into one commit per logical change (the decision log in
[`docs/decisions.md`](docs/decisions.md) keeps the dates).

### Added

- Rule corpus: thirteen Medicare, TCPA and state rules as versioned, effective-dated
  YAML, including vacated and proposed versions that are never enforced.
- Scanner: deterministic matchers that bind artifacts to rule versions, with staleness
  direction, negation handling and a golden suite of 113 cases.
- Harness: one AI workflow under test, eight contracts, simulated, recorded and live
  model adapters, and a release gate for CI.
- Measured runs on Qwen2.5 7B, Qwen2.5 3B and Llama 3.1 8B, recorded for offline replay,
  plus a held-out corpus that tests prompt changes for overfitting.
- Comparisons with exact paired statistics, attribution to a single change, and the
  held-out result shown ahead of the development result.
- Review workflow: tasks, overrides with a second approver, test cases scoped to the
  rule they were decided under.
- Governance: server-enforced roles, an admin access review, rule-corpus adoption, and
  audit checkpoints on top of a hash-chained, append-only log.
- Evidence bundles per run, task or rule, with explicit truncation.
- Console: change triggers, readiness, blast radius, runs and compare, review, models,
  evals, audit, governance, and a sandbox for pasted text.
- Docker Compose stack, Terraform for the production shape, and a read-only preflight.

### Fixed

- Live Anthropic calls failed before sending with the anthropic 1.x SDK, which dropped the
  `temperature` argument. Temperature is now sent only to models that accept it; newer
  models run at their default, and the run records which applied.

### Tooling

- Backend dependencies pinned in `backend/requirements.lock` and used by CI and Docker.
- The backend is type-checked with mypy in CI; a test checks the Alembic migrations
  produce the same schema as the models.

### Known limitations

Listed in [`docs/honesty.md`](docs/honesty.md), including the items the pre-review
audit found and deliberately left for the next version.
