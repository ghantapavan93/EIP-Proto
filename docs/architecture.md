# Architecture

How Backstop fits together: the components, the data they share, what happens on each
kind of change, and the invariants that hold throughout. The reasons for each choice are
in the [architecture decision records](adr/) and the [decision log](decisions.md).

## Components

```
                 ┌──────────────┐        ┌────────────────────────────────────────────┐
  browser ──────►│ nginx        │──/api─►│ FastAPI (backend/backstop)                 │
                 │ static UI    │        │                                            │
                 │ security     │        │  api/       one router per resource        │
                 │ headers      │        │  core/      rules, staleness, impact,      │
                 └──────────────┘        │             review, audit, evidence, stats │
                                         │  scanner/   crawl, hash, match, watch      │
                                         │  harness/   workflow, adapters, contracts  │
                                         └──────────────┬─────────────────────────────┘
                                                        │ SQLAlchemy
                                                        ▼
                                                 ┌──────────────┐
                                                 │ PostgreSQL   │
                                                 └──────────────┘

  git-owned inputs:  rules/*.yaml · contracts/contracts.yaml · fixtures/ (inventory,
                     page excerpts, golden sets, recorded model output)
```

Only the nginx gateway is published. The API and database bind to localhost; models run
through Ollama on the host or any OpenAI-compatible provider.

## Data model

| Area | Tables | Notes |
|---|---|---|
| Rules | `rules`, `rule_versions`, `rule_source_checks` | Versions are effective-dated and append-only; proposed, vacated and stayed versions are never in force |
| Artifacts | `assets`, `asset_versions`, `scans`, `scan_artifacts`, `rule_asset_edges` | An edge binds an artifact to the *rule version* it encodes, with the exact evidence span |
| Workflow | `workflows`, `prompt_versions`, `models`, `transcripts` | A prompt version declares which rule versions it encodes |
| Runs | `runs`, `workflow_outputs`, `run_results`, `contracts`, `contract_versions` | A run is keyed by everything that determines its outcome, so identical inputs return the same run |
| Review | `review_tasks`, `test_cases` | Tasks move through a state machine; an override becomes a test case a second person approves |
| Audit | `audit_events` | Append-only (database triggers), each row hashed with the previous one |

## What happens on each change

**A rule changes** (a date crosses a version's `effective_from`). The staleness engine
compares each edge's bound version with the version in force on that date and returns
a direction: over-restrictive, under-restrictive or re-verify. Stale edges open review
tasks, routed to the artifact's owner. A run at the new rule date is scored against the
new rule parameters, so workflow outputs that were right yesterday can fail today.

**A prompt changes.** A run with the new prompt version replays the same calls under the
same model and rule date. Compare pairs the two runs call by call, tests the difference
with an exact McNemar test per contract (Holm-corrected), states whether exactly one
input changed, and puts the held-out result first when one exists.

**A model changes.** The same, with the model as the only moving input. Grounding
contracts (verbatim spans, invented figures, PII, schema) catch what a model swap tends
to break; rule judgments catch reasoning errors.

## The run lifecycle

```
execute_run(prompt, model, adapter, rule date, corpus)
  → run key (idempotent; a failed or abandoned run is retired and re-run)
  → run.started committed           (visible at once; the audit lock is released)
  → adapter: simulated | cassette replay | live model
  → contracts score every (call × contract)   → run_results
  → gate: RED if a blocking contract fails or errors, AMBER for advisory flags or
          unlabelled calls, else GREEN (GREY until the run completes)
  → review routing: one task per blocking finding, one advisory item per run × contract
  → run.completed
```

A missing recording is an error, never a silent call to another model: changing the
provider changes the experiment.

## Invariants

- The rule corpus in git is the source of truth; the database is a materialization.
- A model may propose an artifact → rule link with an exact span; only a person confirms it.
- Judged (model-scored) contracts are advisory and cannot block a release.
- Every state change writes an audit row with the actor, role and request id.
- Held-out runs never open review tasks; they exist to test for overfitting.
- Every number shown is labelled measured, recorded, simulated or assumed.

## Where to look in the code

| Question | Start at |
|---|---|
| Which version is in force, and is this artifact stale? | `backend/backstop/core/staleness.py`, `core/impact.py` |
| How is an artifact matched to a rule? | `backend/backstop/scanner/matchers.py` |
| How is a run executed and gated? | `backend/backstop/harness/runner.py`, `harness/contracts.py` |
| How are two runs compared? | `backend/backstop/api/runs.py`, `core/stats.py`, `core/attribution.py` |
| Who may do what? | `backend/backstop/core/permissions.py`, `api/deps.py` |
| How is the audit chain kept? | `backend/backstop/core/audit.py` |
