# Architecture decision records

| ADR | Decision |
|---|---|
| [001](ADR-001-rules-as-code.md) | The rule corpus lives in Git as versioned YAML; the database is a materialization; history is append-only |
| [002](ADR-002-ai-boundary.md) | Deterministic code decides; the model proposes with verified spans; a named human confirms; judges are advisory |
| [003](ADR-003-adapters.md) | Three model adapters; simulation is declared on screen, never disguised |
| [004](ADR-004-right-sizing.md) | FastAPI + Postgres + React + Compose; ECS/RDS named as the production shape; no queue, no K8s, no vector store |
| [005](ADR-005-idempotency-and-audit.md) | Idempotency keys on every operation; an append-only audit log with a closed vocabulary |
| [006](ADR-006-judged-contracts-are-advisory.md) | Judged contracts run N times, report variance, and can never gate |
| [007](ADR-007-real-pages-synthetic-everything-else.md) | Real public pages, read-only and frozen; everything private is synthetic and labeled |
