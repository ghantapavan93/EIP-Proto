# Infrastructure

`terraform/main.tf` is the production shape ADR-004 names — **not applied**.

| Piece | What | Why this size |
|---|---|---|
| ECS Fargate service (0.5 vCPU / 1 GB) behind an ALB | the API (the UI container is **not** in the file yet — see gaps) | 60-transcript runs finish in seconds simulated (live model runs: minutes to an hour on a laptop GPU); one task is plenty |
| RDS Postgres `db.t4g.micro`, 7-day backups | the only state | prototype volumes; grows without a rewrite |
| Scheduled ECS task (02:00 ET) | `backstop scan` → `check-sources` → `run --gate` | the nightly answer to "what still holds" |
| S3 (versioned) | intended for snapshots, cassettes, exports — **the app does not use S3 yet** | the frozen evidence trail, later |
| Secrets Manager | the model key | never in an image (the DB URL still is — see gaps) |
| CloudWatch Logs, 90 days | JSON logs with request ids | "if the platform provides adequate logs" |

Rough run cost: tens of dollars a month. No Kubernetes, no queue, no
vector store — the workload does not need them, and a three-engineer team
should not operate them.

Before applying: narrow the ALB ingress to EIP's egress IPs, put TLS on the
listener (ACM certificate + 443), point `BACKSTOP_USERS` at SSO instead of the
demo stub, and decide who owns the `rules/` repository's branch protection.

## Known gaps in `main.tf` (found in review, 2026-09-23; not fixed because it is not applied)

This file is a sketch of the target shape, not a deployable stack. Before it
could be applied:

- **UI not deployed.** Only the backend image runs; the ALB sends `/` to
  FastAPI. Add the nginx UI container (as in `docker-compose.yml`) or S3 +
  CloudFront.
- **Credentials.** `BACKSTOP_USERS` is unset, so the demo defaults would apply;
  the database URL (with its password) is a plain task-definition variable.
  Both belong in Secrets Manager. The listener is plain HTTP on `0.0.0.0/0`.
- **RDS.** No `storage_encrypted`, `skip_final_snapshot = true`,
  `deletion_protection = false` — prototype settings.
- **Networking.** Tasks sit in private subnets with no NAT gateway or VPC
  endpoints declared, so image pulls, secrets and logs would fail.
- **Migrations.** Nothing runs `alembic upgrade head`; `create_all` does not
  alter existing tables.
- **Nightly task.** It replays frozen snapshots (`check-sources` without
  `--live`, crawler off), so it cannot detect a changed source, and nothing
  alerts when the gate goes RED. Needs `--live` and an EventBridge → SNS rule
  on task exit.
- **Anthropic secret.** An empty default secret value likely fails the apply;
  make the secret conditional.
