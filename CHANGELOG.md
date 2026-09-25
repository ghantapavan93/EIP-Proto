# Changelog

## 0.1.0 — 2026-09-25

First version, built for an external review.

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
