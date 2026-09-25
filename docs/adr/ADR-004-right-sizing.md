# ADR-004 — Right-sized architecture: FastAPI + Postgres + React + Compose; ECS/RDS named as the target

**Status:** accepted · 2026-09-22

## Context

The problem is small: 7 rules, 18 artifacts, 60 transcripts, 8 contracts (at the time of this decision; 13 rules and 24 artifacts since),
a handful of comparisons. The organization is small: a handful of engineers
who cannot operate a platform. Small teams do better with Compose-scale
infrastructure and a named target shape (ECS) than with an orchestrator they
must run for one job. Sophistication should come from correct decisions, not
component count.

## Decision

- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2.0, one process, synchronous
  runs (60 transcripts finish in seconds simulated; live, with N=5 judging,
  a 60-transcript run measured 9–55 minutes on a laptop GPU —
  `docs/free-tier-models.md`).
- **Persistence:** PostgreSQL 16 in Compose; SQLite for tests and
  zero-dependency local runs. Models use only portable SQLAlchemy types.
- **Frontend:** React + TypeScript + Tailwind, served statically.
- **Deployment:** `docker compose up`. GitHub Actions runs lint, tests, and
  the contract gate.
- **Not used, on purpose:** message queues, Kubernetes, vector databases,
  agent frameworks, workflow orchestrators, multiple services.

## Production shape (stated, not built)

One ECS service for the API behind an ALB, RDS Postgres, a scheduled ECS task
for nightly scans and canary runs, S3 for page snapshots and cassettes,
Secrets Manager for the model key, Terraform for all of it. Nothing in the
code assumes otherwise: the crawler, runner and scanner are plain functions
that a scheduled task can call.

## Consequences

- A stranger can run it in under five minutes.
- Operating cost is one small database and one container.
- The moment volume justifies it, the runner moves to a scheduled task
  without a rewrite.
