# Contracts

`contracts.yaml` defines the checks every output of the `qa-handoff` workflow must satisfy, and how their results decide a run's gate.

A contract names a check function in [`backend/backstop/harness/contracts.py`](../backend/backstop/harness/contracts.py). The runner applies every contract to every transcript in a run and stores one result per (run, transcript, contract version). Checks are pure functions of the model output, the transcript, its ground-truth labels and the rule logic in force. Only the judged contract calls a model.

## Fields

| Field | Meaning |
|---|---|
| `code` | Stable identifier, for example `C-SPAN-01`. |
| `title`, `description` | What the contract promises, in plain language. |
| `kind` | `DETERMINISTIC` (code decides) or `JUDGED` (a model scores; advisory). |
| `severity` | `BLOCK` (a failure can turn the gate RED) or `FLAG` (advisory; at most AMBER). |
| `owner_role` | Team that owns the contract. |
| `check` | Name of the function in `harness/contracts.py` (`REGISTRY`). |
| `rule` | Optional link to a rule code in [`../rules/`](../rules/). |
| `n_runs`, `judge_model_id`, `spec` | Judged contracts only: repetitions, judge (`same-as-run` means the run's own model unless `--judge-model` is given), rubric and threshold. |

## The contracts

| Code | Kind | Severity | What it checks | Rule params it reads |
|---|---|---|---|---|
| `C-SCHEMA-01` | DETERMINISTIC | BLOCK | The output validates against the QA record schema. No output at all is an ERROR, not a FAIL. | None |
| `C-SPAN-01` | DETERMINISTIC | BLOCK | `disclaimer_span`, `benefits_span`, `soa_span` and every superlative text occur verbatim in the transcript (whitespace and case normalized). | None |
| `C-FACT-01` | DETERMINISTIC | BLOCK | Every dollar figure in the summary appears in the transcript. | None |
| `C-PII-01` | DETERMINISTIC | BLOCK | No Medicare-number-shaped string, dashed SSN or slash-format date of birth, and no labelled PII value, in the summary, coaching note or CRM record. | None |
| `C-TPMO-01` | DETERMINISTIC | BLOCK | The model's `disclaimer_compliant` equals ground truth under the rule in force. Medigap calls pass as not applicable. | `tpmo-disclaimer-timing`: `basis` (`timer` or `ordering`), `window_seconds` |
| `C-SOA-01` | DETERMINISTIC | BLOCK | The model's `soa_wait_compliant` equals ground truth under the rule in force, honouring only the exceptions that rule version lists. Medigap calls pass as not applicable. | `soa-48h-wait`: `min_hours_between_soa_and_appointment`, `exceptions` |
| `C-SUP-01` | DETERMINISTIC | FLAG | The superlatives the model flags equal the ones ground truth says must be flagged. A mismatch is FLAG, not FAIL. | `superlatives`: `substantiation_required` |
| `J-COACH-01` | JUDGED | FLAG | A judge scores the coaching note 1 to 5, five times; the mean and variance are stored. A mean below 3.0 is FLAG. | None |

Rule params come from the rule version in force on the run's rule date, collapsed into a few knobs by `rule_logic_from_params` in [`harness/workflow.py`](../backend/backstop/harness/workflow.py). A rule change therefore changes what the contract expects without anyone editing a test. For example, before 2026-10-01 the disclaimer rule is a 60-second timer; from 2026-10-01 it is ordering (disclaimer before any benefits discussion).

Label-dependent contracts (`C-TPMO-01`, `C-SOA-01`, `C-SUP-01`) cannot be judged on ingested transcripts, which carry no ground truth. They return ERROR marked `not_evaluated`, with the model's answer attached.

## Outcomes and the gate

Each result is `PASS`, `FAIL`, `FLAG` or `ERROR`. A check that raises becomes an ERROR result rather than a crash. `gate_for` in [`harness/runner.py`](../backend/backstop/harness/runner.py) reduces a run's results to one verdict:

| Condition | Gate |
|---|---|
| Any `FAIL` or `ERROR` on a `BLOCK` contract | RED |
| Otherwise, any `FLAG`, `FAIL` or `ERROR` on a `FLAG` contract, or any `not_evaluated` result | AMBER |
| Otherwise | GREEN |
| The run is still running, or failed because the adapter produced no output for any transcript | GREY |

Results carrying an approved, unexpired override (a test case approved by a second person) are still computed and shown, but are skipped by the gate. `backstop run --gate` exits 1 when the gate is RED, for use in CI.

## Versioning

`backstop seed` syncs this file into the database. A new contract starts at version 1. A changed definition (title, description, severity, kind, check, owner, rule, spec, judge or `n_runs`) appends a new version effective that day and writes a `contract.version_created` audit event with the before and after values. Past runs keep the version they used. The run key includes a hash of this file, so editing it produces new runs instead of reusing old ones.

## Adding a contract

1. Write the check in `harness/contracts.py`. It takes a `CheckContext` and returns a `Verdict(outcome, evidence)`; put what a reviewer needs to see in `evidence`. Return ERROR when there is no valid output.
2. Register it in `REGISTRY` under the name you will use in `check`.
3. If it needs a rule parameter, add that parameter to the rule version's `params` in `rules/*.yaml` and to `rule_logic_from_params`.
4. Add the entry to `contracts.yaml`. Use `BLOCK` only for deterministic checks and keep judged contracts at `FLAG` ([ADR-006](../docs/adr/ADR-006-judged-contracts-are-advisory.md)). The seed does not enforce this; the gate reads `severity` alone.
5. Add a test under `backend/tests/`, then run `backstop seed` to load it.
