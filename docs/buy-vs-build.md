# Buy vs build — what is core, what is commodity, where the exit is

Buying a tool means someone else decides when it changes. Owning one means
you maintain it. Each part of Backstop below is labeled by whether EIP should
own it, and each owned part has an exit path.

## Why not Promptfoo + cron?

For the runner and the eval loop, that would work. Running a workflow over a
set of calls, scoring the outputs and failing a build is replaceable: Promptfoo,
Braintrust, LangSmith, or a cron job would do it. Backstop's runner is not the
reason to build this.

What no eval tool supplies is the Medicare-specific part: rule versions with
effective dates and machine-readable params, the graph from each rule version
to the artifacts and prompts that encode it, and the evidence and audit trail
behind each decision. That is the part worth owning.

| Component | Verdict | Why | Exit / interop |
|---|---|---|---|
| **Rule corpus** (`rules/*.yaml`, effective-dated, cited, disputed flag) | **Own — core** | Nobody sells Medicare rule clauses mapped to *your* artifacts. | Plain YAML in Git. Readable without Backstop. |
| **Rule → artifact edges + staleness semantics** | **Own — core** | "Which of our artifacts still encode the rule CMS removed" has no vendor. | Edges export as CSV; the staleness engine is ~170 lines of pure Python. |
| **Evidence + audit log** | **Own — core** | The record of who decided what against which rule version is the compliance artifact. | Append-only table; CSV export trivial. |
| **Contracts** (deterministic checks tied to rule versions) | Own the definitions | They encode EIP's reading of the rules and its QA standards. The code that runs them is ordinary. | Results export in Braintrust / LangSmith / CSV shapes (`/runs/{id}/export`). |
| **Runner / eval loop** | **Replaceable** | Promptfoo, Braintrust, LangSmith or cron can run it. | Swapping means calling the contracts and the rule lookup from that runner. Not tried here. |
| **Judge (advisory)** | Own the rubric, **rent the model** | Any LLM can judge; the rubric, N, variance reporting and canary are EIP's. | Pinned model id per run; swap = a MODEL trigger, compared like any other. |
| **Workflow model calls** | **Rent** | The model is a dependency, not an asset. | Three adapters (simulated, cassette, live); cassettes make any vendor replayable offline. |
| **Eval store / dashboards** (Braintrust, LangSmith, Promptfoo) | **Buy if wanted — commodity** | Good generic plumbing; no Medicare semantics. | Backstop exports to their shapes; it does not depend on them. |
| **Crawling / hashing** | Commodity | `httpx` + BeautifulSoup + SHA-256. | — |
| **Hosting** | Commodity | Compose now; ECS + RDS as code (`infra/terraform`). | Nothing cloud-specific in the app. |
| **Conversation intelligence** (Attention) | **Keep buying** | Scoring every call at scale is their product. Backstop tests the AI that reads those calls and the rules both encode. | Attention → Snowflake export is the planned transcript source, not a vendor API. |
| **Salesforce** | Keep as system of record | Proposed: review tasks would push out as Salesforce Tasks; Backstop should not become a second CRM. | Task push would be an integration, not the home. Not built. |

## Real transcripts need labels

On real EIP transcripts (ingested, unlabeled) the three rule-judgment
contracts (`C-TPMO-01`, `C-SOA-01`, `C-SUP-01`) return ERROR "no ground
truth". What still runs is schema, spans, dollar figures, PII and the advisory
judge. The path to real value is a QA-labelled stratified sample (for example
200 calls a month), with Attention scorecard verdicts used as a disagreement
signal, not as truth. That labeling is an ongoing cost of owning this.

## What this costs to own

- Rule changes: ~2 dated events a year (final rules, MCMG updates). Editing
  the corpus is hours per change; the graph re-evaluates itself.
- Contracts: one per rule clause you care about; the eight here took an
  afternoon.
- Labels: a monthly QA-labelled sample, as above.
- Model spend: $0 simulated; live runs are estimated per run and projected
  per day / per AEP on every run (`stats.cost`), from list prices you can
  edit in `harness/cost.py`.
- Operations: one small container and one small database.

## The honest weakness

If EIP already owns a rule→artifact registry (even a spreadsheet) that is being used for
the October 1 changeover, the "own — core" rows above shrink to "coverage
check on what you have". That is the first question in
[`open-questions.md`](open-questions.md).
