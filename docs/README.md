# Documentation

Everything written about Backstop beyond the code, grouped by what the reader needs.

## Reading order

| If you have | Read |
|---|---|
| 5 minutes | The [root README](../README.md), then the [honesty page](honesty.md) |
| 30 minutes | Add the [decision records](adr/), the [buy-vs-build analysis](buy-vs-build.md) and the [threat model](threat-model.md) |
| A build to review | The [API contract](api-contract.md), the [backend](../backend/) and [frontend](../frontend/) READMEs, then the tests |

## Index

### Product and decisions

| Document | What it covers |
|---|---|
| [`decisions.md`](decisions.md) | The author's decision log: each call that shaped the prototype, the alternatives and why |
| [`adr/`](adr/) | Seven architecture decision records: rules as code, the AI boundary, model adapters, right-sizing, idempotency and audit, advisory judges, real pages vs synthetic data |
| [`buy-vs-build.md`](buy-vs-build.md) | Which parts are worth owning, which are commodity, and the exit path for each |
| [`open-questions.md`](open-questions.md) | The questions public research cannot answer, grouped by the decision they unlock |
| [`screens.md`](screens.md) | Every route in the console and what it is for |
| [`demo-script.md`](demo-script.md) | The timed walkthrough, with fallbacks that work offline |

### Evidence and honesty

| Document | What it covers |
|---|---|
| [`honesty.md`](honesty.md) | What is real, simulated or not built; known limitations; the corrections log |
| [`assumptions-ledger.md`](assumptions-ledger.md) | Every claim the prototype rests on, labelled FACT, HYPOTHESIS or ASSUMPTION |
| [`eval-report.md`](eval-report.md) | Golden Matcher Suite results, per rule, with known limitations |
| [`free-tier-models.md`](free-tier-models.md) | Measured results on local models and how to run any OpenAI-compatible provider at no cost |
| [`ai-build-ledger.md`](ai-build-ledger.md) | How AI assistance was used in the build, what it got wrong and how that was caught |

### Engineering and operations

| Document | What it covers |
|---|---|
| [`api-contract.md`](api-contract.md) | Endpoints, request and response shapes, error codes |
| [`threat-model.md`](threat-model.md) | Threats, the mitigation in place, and what production would add |
| [`operations.md`](operations.md) | Running the stack, publishing a demo through a Cloudflare tunnel, rotating accounts |
| [`../infra/`](../infra/) | The production shape as Terraform (ECS, RDS, scheduled task), not applied |

## Conventions

- Every claim is labelled with its basis: measured, simulated, recorded, or assumed.
- Simulated results are never presented as model behaviour.
- Dates are absolute (for example 2026-10-01), never relative.
- Corrections are logged in [`honesty.md`](honesty.md#corrections), not silently edited.
