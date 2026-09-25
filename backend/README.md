# Backstop backend

The FastAPI service, command line and harness that load the rule corpus, scan artifacts, run the AI workflow against contracts, and record every decision in an append-only audit log.

Python 3.12, FastAPI, SQLAlchemy 2, Pydantic v2, Typer. SQLite for tests and local runs; Postgres under docker-compose. The HTTP surface is specified in [../docs/api-contract.md](../docs/api-contract.md); design decisions are in [../docs/adr/](../docs/adr/).

## Package layout

| Module | Purpose |
|---|---|
| `backstop/__init__.py` | Package version (`0.1.0`). |
| `backstop/main.py` | FastAPI app: lifespan (logging, credential check, schema), CORS, request-id middleware, mounts every router under `/api`. |
| `backstop/cli.py` | Typer command line (`backstop ...`); see [Command line](#command-line). |
| `backstop/config.py` | Settings from the environment or `.env`; locates the repository root. |
| `backstop/db.py` | Engine, sessions, `init_schema()`, and the append-only triggers on `audit_events`. |
| `backstop/logging_setup.py` | JSON log lines and the request-id middleware. |
| `backstop/models.py` | SQLAlchemy models: effective-dated rule versions, artifact edges, keyed runs, deduplicated review tasks, audit events. |
| `backstop/schemas.py` | Pydantic request and response shapes the frontend is built against. |
| `api/deps.py` | DB session, HTTP Basic authentication, `require_role`. |
| `api/meta.py` | `GET /health` (no auth), `/meta`, `/me`. |
| `api/audit.py` | `GET /audit` (filtered page) and `/audit/verify` (recomputes the hash chain; optionally checks an admin checkpoint). |
| `api/admin.py` | Governance, admin only: access review and audit checkpoints. |
| `api/rules.py` | Rule registry, reload, change impact as of a date, propose a version. |
| `api/assets.py` | Artifact inventory and scans. |
| `api/runs.py` | Workflows, prompts, models and model board, contracts, transcripts, runs, paired comparison. |
| `api/review.py` | Review queue, task transitions, test cases and their approval. |
| `api/evidence.py` | Evidence bundle export for tasks, runs and rules (JSON or Markdown). |
| `api/contracts_metrics.py` | Per-contract accuracy against ground truth, read from stored results. |
| `api/readiness.py` | Read-only 30/60/90-day view of rule changes, open work by owner, and the marketing calendar. |
| `api/sandbox.py` | Check pasted text against the rules or run one pasted call; nothing stored. |
| `api/ops.py` | Deep health, status rail, matcher evals, rule-source watch, run export, prompt diff, transcript ingest. |
| `api/ratelimit.py` | In-process per-user token buckets. |
| `api/serializers.py` | ORM-to-schema helpers shared by routers. |
| `core/rules_loader.py` | Loads `rules/*.yaml`; refuses edits to existing versions. |
| `core/staleness.py` | Deterministic staleness engine: over-restrictive, under-restrictive, reverify. |
| `core/impact.py` | Rule versions x edges x date to stale set and review tasks (idempotent). |
| `core/state_machine.py` | Legal transitions per review-task kind. |
| `core/review_actions.py` | The single place a task transitions or a test case is approved. |
| `core/lanes.py` | Splits open tasks into actionable and advisory lanes. |
| `core/permissions.py` | The role table behind `GET /api/me`; a test checks it against every guarded route. |
| `core/audit.py` | Event catalogue, `record()`, hash-chain verification. |
| `core/evidence.py` | Self-hashing evidence bundles with the audit chain tip. |
| `core/pii.py` | Regex PII detection and redaction for real text. |
| `core/sandbox.py` | Matches pasted text to rule versions and judges staleness; stores only a hash. |
| `core/stats.py` | Wilson intervals, exact McNemar and Fisher tests. Pure Python. |
| `core/attribution.py` | Whether a run comparison changed exactly one factor, and existing run pairs that isolate each factor when it did not. |
| `harness/workflow.py` | The workflow under test (extract, check, compose, route), prompt versions, rule logic from params. |
| `harness/contracts.py` | Contract checks; see [../contracts/README.md](../contracts/README.md). |
| `harness/runner.py` | Seeds workflow, models, contracts and corpus; executes idempotent runs; computes the gate. |
| `harness/adapters.py` | Simulated, cassette and Anthropic adapters. |
| `harness/openai_compat.py` | OpenAI-compatible adapter (Ollama, Groq, Gemini, OpenRouter) with pacing and retries. |
| `harness/providers.py` | Provider registry, free-tier limits, real-data egress rules. |
| `harness/corpus.py` | Deterministic synthetic call corpus with ground-truth labels. |
| `harness/canary.py` | Judge canary: re-judges fixed notes to separate judge drift from workflow drift. |
| `harness/cost.py` | Cost per call, per day and per AEP. |
| `harness/ingest.py` | CSV transcript ingest with PII and agent-name redaction. |
| `harness/sandbox.py` | One pasted call through the workflow on a local model. |
| `harness/demo_examples.py` | Two labelled example test cases seeded by `backstop demo`. |
| `scanner/service.py` | Scan orchestration: inventory, fetch, hash, match, edges, tasks. |
| `scanner/crawler.py` | Snapshot or live fetch, normalization, hashing. |
| `scanner/matchers.py` | Regex matchers that detect which rule version a text encodes. |
| `scanner/llm_edges.py` | Optional model-proposed edges, span-verified, always sent to review. |
| `scanner/evaluate.py` | Scores matchers against `fixtures/matcher_golden.yaml`. |
| `scanner/sources.py` | Hashes each rule's primary source; opens a task on change. |

## Request lifecycle

1. `RequestIdMiddleware` assigns a request id (an inbound `X-Request-ID` is kept if it matches `[A-Za-z0-9._-]{8,64}`), returns it in the response header, and logs one JSON line per request.
2. `api/deps.py` checks HTTP Basic credentials against `BACKSTOP_USERS` in constant time. A failure returns 401 and writes an `auth.denied` audit row (at most one per username per 60 seconds). `GET /api/health` and `GET /api/health/deep` need no credentials.
3. Write endpoints use `require_role("engineer", "admin")`. A denied role returns 403 and is audited.
4. Every state change goes through `core.audit.record`, which stores the request id as the correlation id and chains a SHA-256 hash to the previous row. Database triggers reject `UPDATE` and `DELETE` on `audit_events`.

## Command line

Installed as `backstop` (or `python -m backstop.cli`). Every command that touches the database creates missing tables first.

| Command | What it does |
|---|---|
| `backstop seed [--rules-only]` | Load rules, contracts, workflow, models, both corpora and the artifact inventory. Idempotent. |
| `backstop scan [--live] [--as-of DATE] [--key KEY] [--llm]` | Scan artifacts (frozen snapshots unless `--live`) and evaluate staleness. `--llm` adds model-proposed edges. |
| `backstop check-sources [--live]` | Hash each rule's primary source; open a task on change. |
| `backstop run [--prompt 2] [--model sim-large] [--rule-date 2026-10-01] [--adapter simulated\|cassette\|live] [--trigger MANUAL] [--limit N] [--gate] [--corpus synthetic\|holdout\|ingested\|all] [--judge-model ID] [--judge-n N]` | One harness run. With `--gate`, exits 1 when the gate is RED. |
| `backstop demo` | Seed, scan, check sources, four simulated runs, a replay of every recorded cassette set (including held-out calls), then two example test cases. |
| `backstop record [--model ollama/qwen2.5:7b-instruct] [--prompt 2] [--rule-date ...] [--limit N] [--trigger ...] [--judge-model ID] [--judge-n N] [--corpus ...]` | Run a real model and record its output to `fixtures/cassettes/`. |
| `backstop providers` | Show which model providers are configured. |
| `backstop eval-matchers [--no-write]` | Score the matchers; writes `docs/eval-report.md` unless `--no-write`. |
| `backstop ingest PATH [--fmt attention-snowflake]` | Load transcripts from an export CSV. |
| `backstop serve [--host 127.0.0.1] [--port 8000] [--reload]` | Run the API with uvicorn. |

## Configuration

Settings are read from the environment or a `.env` file in the working directory. `<repo>` is the directory holding `rules/` and `contracts/`.

| Variable | Default | Purpose |
|---|---|---|
| `BACKSTOP_DATABASE_URL` | `sqlite:///<repo>/backstop.db` | SQLAlchemy URL. |
| `BACKSTOP_RULES_DIR` | `<repo>/rules` | Rule corpus. |
| `BACKSTOP_CONTRACTS_DIR` | `<repo>/contracts` | Contract definitions. |
| `BACKSTOP_FIXTURES_DIR` | `<repo>/fixtures` | Snapshots, golden sets, cassettes. |
| `BACKSTOP_USERS` | `analyst:analyst:analyst,engineer:engineer:engineer,admin:admin:admin` | `user:password:role` list; roles are analyst, engineer, admin. A warning is logged while any password equals its username. |
| `BACKSTOP_DEFAULT_ADAPTER` | `cassette` | Adapter for real models when none is given. |
| `BACKSTOP_CRAWLER_USER_AGENT` | `BackstopPrototype/0.1 (...)` | User agent for live fetches. |
| `BACKSTOP_CRAWLER_DELAY_SECONDS` | `2.0` | Delay between live fetches. |
| `BACKSTOP_CRAWLER_LIVE` | `false` | Live fetch instead of snapshot replay. |
| `BACKSTOP_ENVIRONMENT_LABEL` | `PROTOTYPE · SYNTHETIC DATA` | Banner text in the UI. |
| `BACKSTOP_REPO_ROOT` | auto-detected | Overrides repository-root detection. |

Read elsewhere in the code: `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434/v1`), `BACKSTOP_INGEST_KEEP_AGENT_NAMES` (keep agent names on ingest), and `BACKSTOP_ALLOW_ANTHROPIC_REAL_DATA` (allow real transcripts to reach Anthropic). All are unset by default.

## Database and migrations

`init_schema()` runs at API startup and in the CLI. It creates missing tables and installs the append-only triggers. It does not alter existing tables. Alembic (`alembic.ini`, `alembic/`) holds the schema history and reads the URL from settings:

| Revision | Change |
|---|---|
| `448d0e112242` | Initial schema. |
| `7c1a2f4e9b30` | `audit_events` becomes append-only (UPDATE, DELETE and TRUNCATE raise). |
| `b4e81d2c6a15` | Audit attribution and hash chain; rule-version applicability and ranked sources. |
| `d3f7a1c9e254` | Vacated and stayed statuses, undated proposals, `vote_date`, `deferrals`. |

To upgrade an existing database, run `alembic upgrade head` from `backend/`.

## Tests and lint

From `backend/`, with the dev extras installed (`pip install -e ".[dev]"`):

```
pytest
ruff check backstop tests
```

The suite uses a fresh SQLite file per session. Set `BACKSTOP_TEST_DATABASE_URL` to run it against a disposable Postgres database.
