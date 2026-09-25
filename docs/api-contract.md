# Backstop API contract (v0.1)

Base path `/api`. JSON everywhere. Every endpoint except `/health` and `/health/deep` requires HTTP Basic auth (demo
users: `analyst/analyst`, `engineer/engineer`, `admin/admin`; roles are the
usernames). Shapes are defined in `backend/backstop/schemas.py` — that file is
the source of truth; this page is the map.

| Method | Path | Purpose | Returns |
|---|---|---|---|
| GET | `/health` | liveness probe (no auth) | `{ok: true}` |
| GET | `/meta` | environment label, adapter availability, provider readiness (Ollama probed, hosted tiers by key), current user/role, today | `MetaOut` |
| GET | `/rules` | rule registry with in-force version, dependents count, contracts | `RuleOut[]` (versions included) |
| GET | `/rules/{code}` | one rule with all versions | `RuleOut` |
| GET | `/rules/{code}/impact?as_of=YYYY-MM-DD&include_proposed=&assume_version=` | **blast radius** as of a date: stale edges (direction + reason + task), healthy edges, contracts, prompt versions that declare the rule. `include_proposed=true` is a **what-if**: evaluate as if the newest *dated* proposal effective on `as_of` were enacted; `assume_version=N` picks proposed version N (an undated proposal is assumed to apply from `as_of`). A what-if writes nothing (no tasks, no audit rows) and returns `hypothetical: true`, `assumed_version`, `note`; without it those are `false` / `null` / `""` | `ImpactOut` + `{hypothetical, assumed_version, note}` |
| POST | `/rules/{code}/versions` | propose a new rule version (what-if); role engineer/admin | `RuleVersionOut` |
| POST | `/rules/reload` | reload `rules/*.yaml` (idempotent; refuses in-place edits) | `{rules_created, versions_created, unchanged, files}` |
| GET | `/assets` | artifact inventory (real pages + labeled synthetic internals) | `AssetOut[]` |
| GET | `/assets/{code}` | artifact with latest text and its edges | `AssetDetailOut` |
| POST | `/scans` | run a scan (`{idempotency_key?, live?, as_of?}`); same key → same scan (`deduplicated: true`) | `ScanOut` |
| GET | `/scans`, `/scans/{id}` | scan history | `ScanOut[]`, `ScanOut` |
| GET | `/workflows`, `/workflows/{code}` | workflows and their prompt versions | `WorkflowOut` |
| GET | `/prompts/{id}` | prompt version with full text | `PromptVersionOut` |
| GET | `/models` | pinned model registry (simulated, local Ollama, free tiers, anthropic) | `ModelOut[]` |
| GET | `/models/board?prompt=2&rule_date=2026-10-01` | one row per model: tier, availability + detail, key env, recorded cassette sets, latest COMPLETE run for the prompt/date (or any, flagged `matched=false`), `measured` (live/cassette without adapter errors) | `ModelBoardOut` |
| GET | `/contracts` | contract registry (severity, kind, rule) | `ContractOut[]` |
| GET | `/transcripts?limit=&offset=`, `/transcripts/{code}` | synthetic corpus | `TranscriptOut` |
| POST | `/runs` | execute the harness: `{workflow, prompt_version, model_id, adapter?, rule_date, trigger, limit?, corpus?, judge_model_id?, judge_n?}`; `adapter` is `simulated \| cassette \| live`; a judge other than the run model is part of the run key; same inputs → same run (`deduplicated: true`) | `RunOut` |
| GET | `/runs` | runs matrix source (all runs with per-contract summaries) | `RunOut[]` |
| GET | `/runs/{id}` | one run + per-contract summary | `RunOut` |
| GET | `/runs/{id}/results?contract=&outcome=&transcript=` | per-transcript × contract outcomes with evidence | `RunResultOut[]` |
| GET | `/runs/{id}/transcripts/{code}` | transcript text, workflow output, results, verified spans | `RunTranscriptOut` |
| GET | `/runs/compare?a=&b=` | diff two runs: what changed (prompt/model/rule date/adapter), newly failing/passing cells, per-contract deltas (`a_error`/`b_error` break out ERROR), `failure_definition`, and `statistics`: per contract plus `ALL-BLOCK`, a paired table on shared calls, failure rates with 95% Wilson CIs, exact McNemar p (Fisher exact when the corpus differs), Holm-adjusted p, a plain-language verdict at alpha 0.05 and cautions | `CompareOut` |
| GET | `/contracts/{code}/metrics?run_id=&corpus=synthetic&rule_date=&trend_limit=50` | one run, or the latest COMPLETE run per model/prompt on `corpus`: outcome counts, failure rate + CI; for C-TPMO-01/C-SOA-01 a per-call confusion matrix (positive = violation) and for C-SUP-01 a per-phrase one, with precision/recall/specificity/F1 and Wilson CIs; per-scenario and per-product-line slices with `notable` flags and `findings`; `trend` of the contract's failure rate across COMPLETE runs, oldest first | `ContractMetricsOut` |
| GET | `/review?state=&kind=`, `/review/{id}` | review queue (STALE_ASSET, PROPOSED_EDGE, FLAGGED_RESULT, RULE_SOURCE_CHANGED) with allowed transitions for the caller's role | `ReviewTaskOut` |
| POST | `/review/{id}/transition` | `{to, reason_code?, note}`; illegal → 409 (audit-logged); forbidden → 403 | `ReviewTaskOut` |
| GET | `/test-cases` | test cases created by overrides | `TestCaseOut[]` |
| POST | `/test-cases/{id}/approve` | approver ≠ creator; role engineer/admin | `TestCaseOut` |
| GET | `/audit?entity_type=&event_type=&entity_id=&limit=&offset=` | append-only audit log | `Page{items: AuditOut[], total}` |
| GET | `/audit/verify` | recompute the SHA-256 hash chain; `ok=false` names the first row that no longer links | `{ok, …}` |
| GET | `/health/deep` | readiness with substance: db, rules, contracts, transcripts, last scan, adapters (no auth) | `{ready, database, …}` |
| GET | `/evals/matchers` · `/evals/matchers.md` | matcher precision/recall against the labeled golden set | `{summary, per_rule, cases}` / markdown |
| GET | `/rules/{code}/sources` | rule-source watch history (hash per check, changed flag, excerpt) | `RuleSourceCheck[]` |
| POST | `/sources/check?live=` | hash every rule's primary source; open `RULE_SOURCE_CHANGED` tasks on change; engineer/admin | `{checked, changed, unchanged, first_seen, errors, mode}` |
| GET | `/prompts/diff?a=&b=` | unified diff of two prompt versions + rule-dependency deltas | `{a, b, unified_diff[], rule_dependencies{removed,added,unchanged}}` |
| GET | `/runs/{id}/export?format=braintrust\|langsmith\|csv` | run results in an eval vendor's shape or flat CSV for Power BI | JSON / CSV download |
| POST | `/ingest/transcripts?format=attention-snowflake\|generic` (multipart `file`) | load transcripts from an export; PII patterns redacted; unlabeled → rule contracts report ERROR; engineer/admin | `{format, created, skipped_existing, redacted, batch_hash, note}` |
| GET | `/ingest/formats` | documented column mappings (assumptions, to be confirmed) | `{format: {description, columns, redaction}}` |
| GET | `/readiness?as_of=YYYY-MM-DD` | **are we ready?** (default `as_of` today). Read-only: staleness is evaluated in memory; no tasks, no audit rows. See *Readiness* below | `ReadinessOut` |
| GET | `/me` | who am I: role label and description, every action with `allowed` + `why`, and all roles with their `can` (action ids). Derived from `core/permissions.py`, which a test checks against every `require_role` route | `MeOut` |
| GET | `/sandbox/samples` | 3 synthetic artifact snippets + 1 synthetic transcript to try | `{artifacts: [{label, text}], transcripts: [{label, text}]}` |
| POST | `/sandbox/artifact` | `{text (1..20000), as_of?, label? (≤80)}` → deterministic matchers + staleness engine, per match: rule, bound/in-force version, `verdict`, `direction`, `reason`. Nothing stored | `SandboxArtifactOut` |
| POST | `/sandbox/transcript` | `{text (1..30000), product_line?, model_id?}` → one generation on a local Ollama model (prompt v2), grounding contracts run, label-dependent ones `NEEDS_LABEL`. Nothing stored | `SandboxTranscriptOut` |

**Failure, for statistics and metrics:** FAIL or ERROR on a BLOCK contract; FAIL, FLAG or ERROR on a FLAG contract. ERROR (no usable output) is a failure. Unlabelled ingested cells (ERROR with `not_evaluated`) are excluded and counted as `excluded_not_evaluated`. Verdicts are raw; approved overrides are not applied. Legacy `per_contract.a_fail`/`b_fail` count every non-PASS outcome.

`RunRequest.corpus` = `synthetic` (default) \| `ingested` \| `all`. `RunOut.stats` carries `cost` (usd, per_call_usd, basis, projection) and `judge_stability` (canary notes with bands, means, variance, `stable`). Review task kind `RULE_SOURCE_CHANGED` transitions `open → in_review | dismissed`, `in_review → verified | dismissed`.

## Rule versions (statuses, undated proposals, annotations)

`RuleVersionOut` carries `status` ∈ `in_force | eliminated | amended | proposed |
vacated | stayed`. **`proposed`, `vacated` and `stayed` are never in force**,
whatever their dates say. A vacated version keeps the dates it was written with
(history) and may overlap the enacted version it never displaced; the UI should
not draw it as a window that applied. An artifact bound to a vacated or stayed
version is always `stale` (enforcing a vacated tightening → `over_restrictive`;
relying on a vacated loosening → `under_restrictive`; otherwise `reverify`).

* `effective_from` is **nullable**: `null` only for a proposed version with no
  date yet (e.g. `tcpa-consent-revocation` v2, FCC vote 2026-09-30).
* `vote_date: date | null` — when the regulator votes on a proposed version.
* `deferrals: [{provision, deferred_to (YYYY-MM-DD), source}]` — a clause whose
  compliance date moved while the text did not (FCC waiver). Annotations: not
  part of the version's fingerprint; the loader refreshes them in place and
  audits `rule.version_annotated`.
* `change_classification` adds `RESTORES_PRIOR` (a court set a later version
  aside and the earlier text governs again) → `reverify`.
* `RuleOut` is unchanged (`in_force_version` never points at a
  proposed/vacated/stayed version).

## Readiness (`GET /readiness`)

```
{as_of, generated_at,
 milestones: [{date, label, kind, rule_code?, version?, status?, days_from_as_of}],
 horizon: {"30": [H], "60": [H], "90": [H]},
 owners: [{role, open, actionable, oldest_days, median_age_days, by_kind: {STALE_ASSET: n, …}}],
 burn_down: {target, label, open_actionable_now, stale_encodings_on_target, days_left,
             aep: {date, days_left}, note},
 vacated: [{rule_code, version, status: vacated|stayed, why, source, source_url}],
 proposed: [{rule_code, version, vote_date|null, why, effective_from|null, origin: yaml|api}]}
H = {rule_code, rule_title, version, applies_from, change_classification,
     stale_encodings_on_that_date, artifacts_on_that_date, open_tasks}
```

* **milestones**, sorted by date, from `as_of` to `as_of + 365`. `kind` ∈
  `marketing_start` (Oct 1, 42 CFR 422.2263(a)), `aep_start` (Oct 15),
  `aep_end` (Dec 7), `oep_start` (Jan 1) — the next occurrence on or after
  `as_of` — plus `rule_applies` (an enacted version's `effective_from`),
  `vote` (a proposal's `vote_date`) and `deferral_ends` (a deferral's
  `deferred_to`). Calendar milestones have `rule_code/version/status = null`.
* **horizon** bands are **disjoint**: `"30"` = `as_of`…`as_of+30` days
  (inclusive), `"60"` = +31…+60, `"90"` = +61…+90. Items are enacted versions
  that start applying in the band; `stale_encodings_on_that_date` counts
  confirmed edges stale on `applies_from` (evaluated, nothing written),
  `artifacts_on_that_date` the distinct artifacts behind them, `open_tasks`
  the open review tasks already keyed to that version.
* **owners**: open tasks (a state the state machine can still move out of) by
  `assignee_role`; `actionable` = lane `actionable`. Ages in days (1 decimal)
  are measured at `generated_at`, **not** at `as_of`. Demo tasks are all
  opened when the demo is seeded, so demo ages are ~0.
* **burn_down**: `target` is the next Oct 1 on or after `as_of`, `label`
  `"CY{year+1} marketing changes apply"`; `stale_encodings_on_target` sums
  every rule's stale edges on `target`; `open_actionable_now` = sum of
  `owners[].actionable`. There is no history table, so no trend series.
* **vacated** lists vacated and stayed versions (`source` = the top-ranked
  source's citation). **proposed** lists every proposal, dated or not, YAML or
  API (`origin`).

## Sandbox (nothing persisted)

Any signed-in role. Text is PII-redacted (`core.pii`: Medicare numbers, SSNs,
dates of birth, phone numbers, emails, street addresses) before anything reads
it; spans and offsets refer to the redacted text. `redacted` (`RedactionCounts`)
has one count per kind: `{medicare_number, ssn, dob, phone, email, address}`. The only write is one audit row — `sandbox.artifact_checked`
`{text_sha256, chars, matches, stale, as_of, label}` or
`sandbox.transcript_checked` `{text_sha256, chars, model_id, latency_ms,
outcomes}` — never the text; text is never logged.

* **Refusals.** Empty/whitespace-only, over the cap, control characters other
  than tab/CR/LF, or unpaired surrogates → 422. A body larger than 12 bytes per
  allowed character + 4 KB → 413 unread. Rate limit per user (in-process token
  bucket): 30/min artifact, 6/min transcript → 429 with `Retry-After`.
* **Artifact verdicts.** `current` (bound version is in force on `as_of`),
  `stale` (older version; `direction` and `reason` come from the staleness
  engine's table, same as the impact view), `ahead` (bound version applies
  later; not stale), `no_version_in_force` (e.g. a date before the rule
  existed). `edge_status: proposed` = a reading a human must confirm (the reason
  says so). `applies_from`/`regulation_effective` belong to the in-force version
  for `current`/`stale`, to the bound version for `ahead`/`no_version_in_force`.
  `summary.stale` splits into `over_restrictive`/`under_restrictive`/`reverify`.
  Default `as_of` is today.
* **Transcript.** Local Ollama models only (a hosted `model_id` → 422), so pasted
  text never leaves the server. Default: the smallest pulled of
  `ollama/qwen2.5:3b-instruct`, `ollama/qwen2.5:7b-instruct`. No reachable model
  → 409 `"No live model is reachable from this server; the recorded runs still
  replay. Start Ollama to try a transcript."`; a requested model not pulled →
  409. Hard deadline 75 s → 504; model transport failure → 502; more than 2
  checks in flight → 429. `contracts[]`: C-SCHEMA-01, C-SPAN-01, C-FACT-01,
  C-PII-01 run (`PASS | FAIL | FLAG | ERROR`, with `evidence`); C-TPMO-01,
  C-SOA-01, C-SUP-01 are `NEEDS_LABEL` with `why` and `evidence.model_says`
  (null when the output did not validate). J-COACH-01 is not run. `output` is the
  validated record (`extraction`, `composition`, `route` — route recomputed by
  code, never taken from the model) or the raw model object when it failed
  validation.

`backstop demo` also seeds two example test cases (one `APPROVED`, one
`PENDING_APPROVAL`) by actors `demo-seed:qa-reviewer` /
`demo-seed:compliance-lead` (audit role `demo-seed`), marked
`seeded_example: true` on the test case `expected` and the task `payload`.

## Vocabulary the UI must use verbatim

Rule · Rule version (status `in_force`, `eliminated`, `amended`, `proposed`,
`vacated`, `stayed`) · Effective from/to · Vote date · Deferral · Change
classification (`INITIAL`, `ADDS_REQUIREMENT`, `REMOVES_REQUIREMENT`,
`TIGHTENS`, `LOOSENS`, `MODIFIES`, `CLARIFIES`, `RESTORES_PRIOR`) · Artifact
(types: `web_page`, `scorecard_item`, `script_section`, `coaching_prompt`,
`email_template`, `training_slide`, `ivr_script`, `workflow_prompt`,
`web_form`, `comp_schedule`, `dialer_policy`) · Edge (polarity `ENFORCES` / `PERMITS` / `INFORMS`;
detection `deterministic` / `llm` / `manual`; status `proposed` / `confirmed` /
`rejected`) · Staleness direction (`over_restrictive`, `under_restrictive`,
`reverify`) · Contract (severity `BLOCK` / `FLAG`; kind `DETERMINISTIC` /
`JUDGED`) · Run (trigger `RULE` / `PROMPT` / `MODEL` / `MANUAL`; gate `GREEN` /
`AMBER` / `RED` / `GREY`) · Outcome (`PASS` / `FAIL` / `FLAG` / `ERROR`; sandbox only: `NEEDS_LABEL`) · Sandbox verdict (`current`, `stale`, `ahead`, `no_version_in_force`) · Review
task (kinds `STALE_ASSET`, `PROPOSED_EDGE`, `FLAGGED_RESULT`,
`RULE_SOURCE_CHANGED`; states `open`,
`in_review`, `verified`, `republished`, `dismissed`, `upheld`, `overridden`) ·
Reason codes (`FALSE_POSITIVE_MATCHER`, `FALSE_POSITIVE_JUDGE`,
`TRANSCRIPT_AMBIGUOUS`, `RULE_EXCEPTION_APPLIES`, `CORRECT_AS_FLAGGED`,
`ARTIFACT_ALREADY_UPDATED`, `ARTIFACT_NOT_IN_SCOPE`, `NEEDS_COUNSEL`, `OTHER`).

EIP-floor vocabulary for labels and copy: Licensed Agent, QA Compliance
Analyst, Sales Supervisor, Training Supervisor, AI Enablement, AEP, TPMO,
SOA (Scope of Appointment), Medicare Advantage (MA), Part D (PDP), Medicare
Supplement (Medigap), carriers.
