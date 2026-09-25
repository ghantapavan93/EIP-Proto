# Reviewer FAQ

The questions I expect from anyone evaluating Backstop, with the short answer and where
the evidence lives. The longer account of what is real, simulated or not built is in
[`honesty.md`](honesty.md).

## The questions

| Question | Answer |
|---|---|
| "What's your false-positive rate?" | Unknown in production. The Golden Matcher Suite ([`docs/eval-report.md`](eval-report.md)) has 113 hand-written cases: 61 detected, 0 false positives, 0 misses, 16 documented known limitations. These are regression fixtures written by the matchers' author, not a production accuracy estimate. |
| "Same prompt, different model: is that really the model?" | Every comparison reports attribution. **Isolated** means exactly one of prompt, model, rule date, calls scored, contract set, judge or approved overrides changed. **Confounded** means two or more did: the page says the difference cannot be credited to either, and links existing runs that change each one alone. The demo's rule flip, prompt fix and model swap are each isolated. |
| "What can each role actually do?" | Analysts decide review tasks. Engineers also operate the harness: runs, scans, rule proposals, ingest, approving others' test cases. Admins also govern it: the access review, adopting the rule corpus, and audit checkpoints. The server enforces every line of that table, a test fails if an endpoint disagrees with it, and each refusal is audit-logged (`/governance`). |
| "Is prompt B actually better than prompt A?" | Compare reports a paired exact McNemar test per contract with Holm correction, and says when a sample is too small to rank two prompts. The held-out set is where the v3 improvement disappeared. |
| "Your judge has the disease it diagnoses." | Judged contracts never block. Every run re-judges six fixed coaching notes, N=5 each, against author-set bands. It is a calibration check, not longitudinal drift detection. `run.stats.judge_stability`. |
| "What happens when a reviewer disagrees?" | They override with a reason code, which creates a test case. Once a different person approves it, later runs under the same rule mark that verdict `override`; it no longer blocks the gate or reopens a task. A rule change sets it aside, and it expires after 365 days. |
| "What is coming, and who owns it?" | `/readiness` lists rule changes in the next 30/60/90 days, including proposed and vacated versions that are never treated as in force, with open work grouped by owner. |
| "What does this cost at 3,000 calls a day?" | `run.stats.cost`: $0 for simulated runs; measured or estimated USD for live runs, projected per day and per AEP from editable list prices (`harness/cost.py`). |
| "Who tells the corpus the CFR changed?" | `backstop check-sources` hashes each rule's primary source page; a change opens a `RULE_SOURCE_CHANGED` review task. Only a human edits the corpus. |
| "Why not Promptfoo or Braintrust + cron?" | The runner is replaceable. The part worth owning is the effective-dated rule parameters and the rule → artifact graph with its evidence. Runs export to their shapes: `GET /api/runs/{id}/export?format=braintrust\|langsmith\|csv`. See [`docs/buy-vs-build.md`](buy-vs-build.md). |
| "Who approved this, and can you prove it?" | Hash-chained, append-only audit rows with actor and role (`GET /api/audit/verify`), a one-file evidence export per run, task or rule, and admin checkpoints: receipts kept outside the system that stop verifying if history is ever rewritten wholesale. |
| "Are you creating more review work?" | Only BLOCK failures, stale encodings, low-confidence proposed edges and rule-source changes open actionable tasks. FLAG and judged results become one advisory item per run × contract. |
| "We have no model budget." | Neither did this build. Three local models ran through Ollama ($0, nothing leaves the machine). Groq, Google AI Studio and OpenRouter free tiers are one environment variable away. |
| "Is that a real model or a script?" | Every run carries its adapter: **SIMULATED**, **CASSETTE** (recorded real output) or **LIVE**. The Models board labels rows *measured* or *declared* and never mixes them. |

---

## What is real, simulated and not built

| Thing | Status |
|---|---|
| The thirteen rules (`rules/*.yaml`), their versions, statuses, effective dates and citations | **Real.** The original seven were checked against eCFR and the Federal Register on 2026-09-23 (CY2027 final rule: 91 FR 17384); corrections are logged in [`docs/honesty.md`](honesty.md#corrections). Six more (agent compensation, TPMO data sharing, TCPA one-to-one consent and revocation, SOA scope, Florida calling hours) carry citations in each file and model vacated and proposed versions; they have no watched source URL yet. `eip-licensing-footprint` is an EIP business fact, not a regulation, included to show the graph is not CMS-specific. |
| Six public web pages | **Real.** medicarefaq.com, theelitebrokerage.com, rates.medicarecompared.com — fetched once on 2026-09-21, read-only, with an identified user agent, and kept as short attributed excerpts under `fixtures/pages/` (the passages around each rule-bearing sentence; matches identical to the full pages). The demo replays them. |
| Internal artifacts (scorecard items, scripts, coaching prompt, SFMC template, training slides, IVR line, web form, compensation schedule, dialer policy) | **Synthetic.** Written in the shape an integration would produce. Labeled `is_synthetic` in the data and badged SYNTHETIC in the UI. None of it is EIP content. |
| The call transcripts (60 development, 60 held-out) | **Synthetic.** Generated deterministically (`backend/backstop/harness/corpus.py`) with ground-truth labels. Names, Medicare numbers and dates are fabricated in formats that cannot collide with real ones. |
| The workflow (`qa-handoff`: extract → check → compose → route) and its three prompt versions | **Real code.** v1 encodes the 2024 rules; v2 the 2027 rules; v3 is v2 with the disclaimer-ordering test spelled out. |
| The eight contracts | **Real code.** Seven deterministic; one judged (advisory, N=5, variance reported, cannot block). See [`contracts/`](../contracts/). |
| Model output — acts 2–3 | **Simulated.** `sim-large` / `sim-small` build output from ground truth and declared rule dependencies, then apply a declared defect profile (`fixtures/simulated_profiles.yaml`). They are not models, and every run shows its adapter. |
| Model output — acts 4–5 | **Real, recorded.** Local Ollama models through the same workflow and contracts; outputs, token counts and latencies are frozen under `fixtures/cassettes/`. No paid API was used. |
| Statistics | **Real code.** Exact McNemar for paired run comparisons, Fisher's exact test, Wilson intervals and Holm correction, in pure Python (`core/stats.py`). |
| LLM edge proposer ("two business days" ≈ 48 hours) | **Real code, key-gated.** Span-verified and proposal-only; without a key the deterministic matchers carry the demo. |
| Attention / Salesforce / SFMC / dialer integrations | **Not built.** Interfaces and the production path are in [`docs/honesty.md`](honesty.md). |
| SSO / RBAC | **Identity stubbed, roles real.** HTTP Basic with environment-configured users stands in for SSO; the three roles and their permissions are enforced server-side and tested. |
| Deployment | Docker Compose. ECS + RDS is the stated production shape ([ADR-004](adr/ADR-004-right-sizing.md), [`infra/`](../infra/)). |

Full list, including known limitations: [`docs/honesty.md`](honesty.md).

---

## The measured results in full (demo acts 4–5)

The demo runs five acts in order. These two are measured; every cell is a
model's own answer.

4. **Models board.** The same 60 calls, prompt v2 and contracts ran on three
   local models (Ollama on a laptop GPU, $0, recorded to cassettes so the
   demo replays offline).
   - Qwen2.5 7B: **20 wrong disclaimer judgments out of 60.** 18 extract the
     disclaimer at 25 s and benefits at 131 s, then call the call
     non-compliant; 2 miss the disclaimer.
   - Qwen2.5 3B: cites `"00:02:17"` as a quote; **4 spans not in the transcript**.
   - Llama 3.1 8B: returns the JSON schema instead of an answer **12 times**.
5. **Prompt v3** rewrites one rule line of v2: the ordering test is written
   out as a comparison. The 7B ran again: **wrong disclaimer judgments 20 → 5,
   21 cells newly passing, 6 newly failing** (two disclaimer verdicts, one
   reading "40s < 25s → compliant"; one SOA verdict; three coaching notes the
   judge now flags).

   **This result is in-sample.** v3 was written after reading the 7B's v2
   failures on the same 60 development calls (T001–T060). A held-out draw
   (H001–H060: same generator and scenario mix, seed 2027, never read while
   writing prompts) was recorded afterwards. It tests overfitting to specific
   calls. It does not test robustness beyond the generator.

   **Held-out result (recorded 2026-09-23, same 7B, same rules):** on the 60
   unseen calls, v2 got **5** disclaimer judgments wrong (4 missed violations,
   1 false flag) and v3 got **22** wrong (14 false flags that repeat the
   reversed comparison, e.g. "25s < 142s -> non-compliant", plus 8 missed
   violations), and 2 v3 outputs failed the schema. **The v3 fix did not
   generalize**: 20 → 5 in-sample was fitted to those 60 calls. The paired
   comparison on the held-out set reports v3 as significantly worse (exact
   McNemar test). On this evidence neither prompt ships, and the deterministic
   contract, not the model's own explanation, is what caught it. Both held-out
   runs replay in the demo (Runs → "Held-out check").

Measured numbers are frozen under `fixtures/cassettes/`; tests assert they
replay without a GPU (`backend/tests/test_cassette_replay.py`).
Detail: [`docs/free-tier-models.md`](free-tier-models.md).

## The simulated acts in full (demo acts 1–3)

Acts 2–3 run on the simulated adapter. It builds its output from the corpus
ground-truth labels and from the prompt's *declared* rule dependencies, not
from the prompt text. So these numbers follow by construction. They show the
mechanism (effective-dated rules → contracts → diff), not model behaviour. Act 1
is the scanner on frozen pages and synthetic artifacts; no model is involved.

1. **Rules → `soa-48h-wait`.** Evaluate as of 2026-09-30: nothing is stale.
   Evaluate as of 2026-10-01: the 48-hour SOA waiting period ends, and the
   artifacts that encode it are listed: a scorecard item, a coaching prompt,
   an SFMC email, workflow prompt v1, and a real public FAQ page (read on
   2026-09-21) whose two-day guidance is correct until 2026-09-30 and needs
   updating on 2026-10-01. Review tasks open, routed to owner roles.
2. **Runs → Compare.** Prompt v1 (written for the 2024 rules), same 60 calls,
   same simulated model; only the rule date moves from Sept 30 to Oct 1.
   **25 results flip (22 blocking FAILs, 3 FLAGs):** 14 on `C-TPMO-01`, 8 on
   `C-SOA-01` (both BLOCK), 3 on `C-SUP-01` (FLAG).
3. **Compare again:** prompt v2, `sim-large` → `sim-small`. Rule judgments are
   identical. **28 cells newly fail: 8 blocking + 20 advisory judge flags.**
   The 8: 5 spans no longer verbatim, 2 summaries with dollar figures never
   said, 1 leaked Medicare number.

These numbers are asserted by tests (`backend/tests/test_harness_and_scan.py`).

### On real transcripts

`backstop ingest` takes an Attention → Snowflake style export (the column
mapping is an assumption to confirm) and redacts PII before storage. Those
calls have no labels, so the rule-judgment contracts (`C-TPMO-01`, `C-SOA-01`,
`C-SUP-01`) return ERROR ("no ground truth") and the gate reads AMBER (not
evaluated) rather than RED. Schema, spans,
dollar figures, PII and the advisory judge still run. Rule-judgment value on
real calls needs labels: a QA-labelled stratified sample (for example 200 calls
a month), with Attention scorecard verdicts used as a disagreement signal, not
as truth.

---
