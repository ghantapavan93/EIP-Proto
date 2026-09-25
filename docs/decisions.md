# Decision log

The calls that shaped Backstop and why I made them. AI assistance did much of the
building (see [`ai-build-ledger.md`](ai-build-ledger.md)); the direction, the scope and
every trade-off below were mine.

## Project decisions

| Date | Decision | Alternatives considered | Why |
|---|---|---|---|
| 2026-09-21 | Answer "full stack or AI workflow?" with a working prototype that is both, built in about 48 hours | A written answer or a slide deck | A running system can be questioned; a description cannot |
| 2026-09-21 | Build Backstop: rules → contracts → evidence for sales-floor AI workflows, anchored on the CY2027 marketing changes of 2026-10-01 | A consumer-facing continuity tool | Two independent research passes ranked it higher; it fits a compliance-bound sales floor and has a real, dated trigger |
| 2026-09-22 | Run real models locally at no cost (Ollama) and record them; keep hosted free tiers optional | Paid model APIs | No model budget, and nothing leaves the machine; recordings make every number replayable offline |
| 2026-09-23 | Label every claim real, simulated, recorded or assumed, and keep results that undercut the work (the held-out reversal of the prompt fix) | Show only the in-sample improvement | A reviewer should find the seams without asking; an honest negative result is itself evidence of the method |
| 2026-09-24 | Put the working application on a live link rather than screenshots, and keep it up for independent review | Screen-share only | The reviewers asked to walk through it themselves |
| 2026-09-25 | Make roles mean something: analysts decide, engineers operate, admins govern (access review, corpus adoption, audit checkpoints) | Admin as a copy of engineer | "What can an engineer do?" deserved a real answer, enforced by the server |
| 2026-09-25 | Every comparison states whether exactly one thing changed, and points to clean comparisons when it did not | Report differences without attribution | "Same prompt, different model" is only a fair question if the answer isolates the model |
| 2026-09-25 | Before external review, fix the high-risk audit findings and disclose the rest rather than change recorded numbers late | Fix everything at once | Late changes to measured results would be harder to trust than disclosed limitations |
| 2026-09-25 | Publish the repository with third-party pages reduced to short attributed excerpts, verified to give identical results | Keep it private; publish full page copies | Open for review without redistributing other people's content |
| 2026-09-25 | Keep AI assistance visible in commit trailers and the build ledger | Remove it | Transparency about how the work was done is part of the work |

## Engineering decisions

The design choices behind the code, in one place. Each links to the record that argues it
in full.

**Why deterministic gates?** A model should not grade its own consequential behaviour.
Release decisions come from code that compares output with ground truth and the rule in
force; a model-as-judge is reported, never allowed to block.
([ADR-002](adr/ADR-002-ai-boundary.md), [ADR-006](adr/ADR-006-judged-contracts-are-advisory.md))

**Why no silent model fallback?** Changing the provider changes the experiment. If the
requested model is unavailable, the run records the failure; another model is a new,
explicitly chosen run configuration, scored by the same contracts.
([ADR-003](adr/ADR-003-adapters.md))

**Why PostgreSQL rather than a vector database?** The hard problem is relational state
and history: which rule version was in force, which artifact encodes it, who decided
what and when. Nothing in it needs similarity search.
([ADR-004](adr/ADR-004-right-sizing.md))

**Why recorded runs (cassettes)?** Reproducibility. Every measured number replays offline
without a GPU or an API key, so a reviewer can check it rather than trust it.

**Why no queue yet?** Prototype volume does not justify the infrastructure. Runs are
synchronous; the production shape (a scheduled worker task) is named in
[`infra/`](../infra/) and [ADR-004](adr/ADR-004-right-sizing.md).

**Why a person confirms semantic rule links?** A model can find and quote evidence that
an artifact encodes a rule; it should not decide legal applicability. Proposed links are
span-verified by code and confirmed by a named reviewer.
([ADR-002](adr/ADR-002-ai-boundary.md))

**Why rules as append-only YAML in git?** Rule history is evidence. Git gives review,
blame and diffs; the loader refuses edits to a published version, so the past cannot be
rewritten quietly. ([ADR-001](adr/ADR-001-rules-as-code.md))
