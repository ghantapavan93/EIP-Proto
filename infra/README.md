# Infrastructure

`terraform/` is the production shape ADR-004 names. It is **not applied**;
CI runs `terraform fmt -check` and `terraform validate` on every push so it
cannot rot silently.

| Piece | What | Why this size |
|---|---|---|
| ECS Fargate task (1 vCPU / 2 GB): nginx UI gateway + API | Same two containers as `docker-compose.yml`; nginx is the only port the load balancer reaches and proxies `/api` over the task's loopback | 60-transcript runs finish in seconds simulated; one task is plenty |
| ALB, HTTPS only (TLS 1.3 policy), HTTP → 301 | Ingress limited to `allowed_ingress_cidrs`; the variable rejects `0.0.0.0/0` | call transcripts are PHI-adjacent; nothing about this should be world-reachable |
| RDS Postgres `db.t4g.micro` | Encrypted, 7-day backups, deletion protection, final snapshot | the audit log lives here |
| Secrets Manager | Database URL, user list, optional model key | nothing sensitive is a plain task variable |
| EventBridge Scheduler, 02:00 America/New_York | `check-sources --live` → `scan` → `run --gate` | a timezone-aware schedule, so it does not drift an hour at DST |
| EventBridge rule → SNS | Any non-zero exit of the nightly task (gate RED or a failed step) | "tell me when something flips" |
| S3, private + KMS + versioned | Intended for snapshots, cassettes, exports — **the app does not write to S3 yet** | the frozen evidence trail, later |
| CloudWatch Logs, 90 days | JSON logs with request ids | |

Migrations run before the API starts (`alembic upgrade head`); seeding is
idempotent, so a restarted task converges on the same state.

Rough run cost: tens of dollars a month. No Kubernetes, no queue, no vector
store — the workload does not need them, and a small team should not
operate them.

## Assumptions and what is still open

- **Network.** The VPC and subnets are inputs. Private subnets need a NAT
  gateway or VPC endpoints (ECR, Secrets Manager, CloudWatch Logs, S3).
- **Identity.** `backstop_users` is the demo's basic-auth list, now in
  Secrets Manager. Real use means SSO (EIP's IdP) in front of the ALB or in
  the API.
- **Rate limiting.** nginx keys its limit on `CF-Connecting-IP`, else the peer
  address. Behind an ALB the peer is the load balancer, so the limit becomes
  global; add `set_real_ip_from <VPC CIDR>` + `real_ip_header X-Forwarded-For`
  or use AWS WAF rate rules.
- **Alerts.** A task that fails to start (image pull, secret access) stops
  without a container exit code and does not match the alert rule; add a
  `stopCode = TaskFailedToStart` pattern if that matters.
- **Artifact crawling** stays off (`BACKSTOP_CRAWLER_LIVE=false`): the nightly
  job re-checks public rule sources live but replays artifact snapshots until
  the site owner signs off on crawling.
- **State backend.** No remote state is configured; pick the S3 + DynamoDB
  (or HCP) backend EIP already uses.
