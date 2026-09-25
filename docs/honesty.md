# Honesty page

What this prototype is, what it is not, and what it would take to make each
piece real. Written so a skeptical reader can find the seams without asking.

## Real

- **The rule change.** CMS's CY2027 final rule (FR doc 2026-06600, 91 FR
  17384, April 6, 2026; regulatory text at 91 FR 17583) makes its marketing
  provisions applicable October 1, 2026. Verified 2026-09-21 against LII's
  mirror of 42 CFR 422.2267 (amendment history ends "91 FR 17583, Apr. 6,
  2026"; TPMO disclaimer "prior to the discussion of any benefits") and
  422.2274 (6-year retention written into (g)(2)(ii)), and the Crowell &
  Moring client alert (48-hour SOA wait eliminated; superlatives prohibition
  removed); re-checked against eCFR and the Federal Register on 2026-09-23.
  Paragraph-level citations marked *verify* in `rules/*.yaml` were not re-read
  at paragraph level and should be confirmed before being quoted to a
  regulator.
- **The public pages.** Six pages on EIP-operated properties were fetched once
  with an identified user agent, a 2-second delay, and no login, then frozen
  under `fixtures/pages/`. The edges the scanner found on them are real:
  - `medicarefaq.com/faqs/scope-of-appointment/` still encodes the 48-hour
    window ("the standard expectation is 48 hours in advance"; "at least two
    days before the meeting").
  - `theelitebrokerage.com` carries the disclaimer wording with the SHIP
    referral that the CY2027 text drops.
  - `medicarefaq.com/` says "Licensed in All 50 States"; `/about-us/` says
    "48 states".
- **The code paths.** Rule loading, scanning, matching, staleness, contracts,
  the harness, the review state machine, the audit log, the API, the tests.
- **The override loop.** A reviewer overrides a result with a reason code,
  which creates a test case. Once a different person approves it, every later
  run on that call still computes the verdict but marks it `override` (test
  case id, reason, creator, approver); it no longer blocks the gate or reopens
  a task. `run.stats.test_cases` reports `{in_scope, applied, agreeing}`:
  applied = the verdict differed and was set aside; agreeing = the model now
  gives the corrected verdict. Approval changes the run key, so reruns do not
  dedupe to an older run. After 365 days the test case expires and normal
  behaviour returns.
- **The three prompt versions.** They are the artifact under test: v1
  really does encode the 2024 rules; v2 encodes the 2027 rules; v3 is v2 with
  the disclaimer-ordering comparison spelled out.

## Synthetic (and labeled as such in the data, not just here)

- **Internal artifacts** (`fixtures/sources.yaml`, `synthetic:`): fifteen
  stand-ins for Attention scorecard items, agent script sections, a coaching
  prompt, an SFMC template, training slides, an IVR line, and (added
  2026-09-25) a lead-form consent paragraph, an agent-recruiting compensation
  one-pager and a dialer policy. They are written in
  the shape those systems produce so an integration would be a source adapter,
  not a redesign. None is EIP's content.
- **Call transcripts** (`backend/backstop/harness/corpus.py`): sixty calls
  generated from a seed with ground-truth labels. Scenario mix is documented
  in the module docstring. Medicare numbers use the MBI shape with characters
  a real MBI cannot contain.

## Simulated (and printed on screen)

- **Model output in the scripted acts (rule flip, model swap).** `sim-large`
  and `sim-small` are deterministic stand-ins. They build the workflow output
  from the corpus ground-truth labels and from the prompt's *declared* rule
  dependencies (`encodes_rule_versions`), not from the prompt text, then apply
  a declared defect profile (`fixtures/simulated_profiles.yaml`) seeded per
  transcript. So the rule-flip numbers (25 results: 22 blocking FAILs, 3
  FLAGs) and the model-swap numbers (8 blocking + 20 advisory judge flags) are
  true by construction. They demonstrate the mechanism (effective-dated rules
  → contracts → diff), not model behaviour. The CI gate on `sim-large` checks
  declared dependencies the same way. The UI badges every run with its
  adapter.
- **Judge scores** under the simulated adapter are seeded noise around the
  profile's baseline. Under the live and cassette adapters they are real
  calls at temperature 1.0 (N=5), recorded per transcript.
- **The judge canary.** Six fixed coaching notes, judged N=5 each at
  temperature 1.0 on a 1–5 scale, with an empty transcript. Each note has an
  author-set band 1.2–1.6 wide. The standard error of a 5-sample mean is about
  0.2–0.45, so only shifts of roughly 1 point or more register. It compares
  against bands set once: a calibration check, not longitudinal drift
  detection. Under the simulated adapter the canary is seeded noise and stable
  by construction.

## Measured (real models, no paid API)

- **Qwen2.5 7B, Qwen2.5 3B and Llama 3.1 8B** ran the full 60-call corpus
  through the same workflow, prompt v2 and contract set on the build laptop
  (Ollama, RTX 3060). Outputs, token counts and wall-clock latencies are
  frozen under `fixtures/cassettes/<prompt_hash>/<model>/` and replayed by
  `backstop demo`; the `/models` board and every run page label them
  **CASSETTE · measured**. Their contract failures are the models' own.
- **What the adapter does and does not do to a real model's answer.** It
  asks for a forced tool call first, falls back to JSON mode when the server
  ignores `tool_choice` or the chat template flattens the nested schema (both
  happen on Ollama), and retires tool mode after two consecutive misses. It
  never repairs an answer: a flat or invalid object reaches `C-SCHEMA-01` and
  fails there. Both attempts' tokens are counted.
- **Prompt v3 exists because of a measurement.** It is v2 with one rule
  line rewritten (the ordering test as an explicit comparison) after the 7B
  contradicted its own timestamps 18 times. The 7B was recorded again under
  v3: wrong judgments 20 → 5 and 21 cells newly passing, with 6 newly
  failing (3 deterministic failures and 3 new judge flags). Both runs are in
  the demo; neither was edited. **This is in-sample:** v3 was written after
  reading the 7B's v2 failures on the same 60 development calls (T001–T060).
  A held-out draw (H001–H060: same generator and scenario mix, seed 2027,
  never read while writing prompts) was recorded afterwards: v2 5 wrong, v3
  22 wrong (14 repeat the reversed comparison), 2 v3 schema failures. **The
  v3 fix did not generalize**, and v2's swing from 20 to 5 between two draws
  of 60 says one draw of 60 cannot rank prompts. It tests overfitting to
  specific calls, not robustness beyond the generator.
- **One adapter change happened between recordings**: `disclaimer_basis`
  became nullable after four Medigap outputs failed the schema for a `null`
  in a field the prompt says does not apply. The recorded answers were not
  touched; they were re-validated on replay.
- **Judge = run model** on the recorded runs unless a cassette set was
  recorded with `--judge-model`; the canary makes that visible as JUDGE DRIFT
  when a small model judges itself.
- **Cost basis** for local runs is "$0 — local GPU"; the projection note says
  so instead of extrapolating a per-token price that does not exist.

## Not built (deliberately)

| Not built | Why | Production path |
|---|---|---|
| Attention scorecard adapter | needs tenant access; Attention's public API surface for scorecards is unverified | `ScorecardSource` reading scorecard items via API → same `sources.yaml` shape |
| SFMC / Salesforce adapters | private systems | CloudPages/templates via SFMC API; review tasks pushed as Salesforce Tasks via MuleSoft or REST; **never a second system of record** |
| Dialer / recording store | vendor unknown from public evidence | transcripts via the Attention → Snowflake export after AEP |
| SSO / RBAC | who may edit rules vs confirm edges is a question for EIP | HTTP Basic stub now; OIDC + role claims later |
| Notifications | one webhook stub would be trivial; wiring it is not the point | Slack/email on `task.opened` |
| Background workers / queue | 60 transcripts run synchronously: seconds simulated; live, minutes to an hour on a laptop GPU (9–55 min measured) | scheduled ECS task for nightly scans and canary runs |
| Embedding-based candidate discovery | 24 artifacts do not need it | interface slot only |
| Terraform apply | `infra/terraform/main.tf` is the shape, reviewed for plausibility, never applied | apply after account owner review; TLS + IP allow-list first |
| LLM edge proposer in the demo | written, tested with a fake client, key-gated; not exercised against a live model here | `backstop scan --llm` with a key |
| Hosted free-tier runs (Groq, Google AI Studio, OpenRouter) | adapter written, paced and tested with a mock transport; no key was created for this build | set the key, `backstop record --model groq/… --limit 20` → cassettes |
| Paid API runs (Anthropic) | not needed; adapter kept for the comparison | `ANTHROPIC_API_KEY` + `backstop record` |

(An initial Alembic migration exists under `backend/alembic/versions/`; the prototype still creates tables directly on start for zero-setup runs.)

## Known limitations

- Staleness is computed per *edge*; an artifact with three encoding sentences
  appears three times. Counts also report distinct artifacts.
- Polarity (ENFORCES / PERMITS / INFORMS) is inferred from enforcement words in
  the sentence; it is a heuristic and is shown so a reviewer can disagree.
- The deterministic matchers are regular expressions with context windows.
  They will miss phrasings nobody anticipated; that is why the LLM proposer
  exists and why it can only propose.
- `MODIFIES` and `CLARIFIES` rule changes produce `reverify`, not a direction.
  That is a decision, not a gap: when the basis of a rule changes, both
  over- and under-restrictive encodings are possible and a human must read.
- The `eip-licensing-footprint` rule's effective dates are placeholders; the
  point of that node is the live contradiction, not the dates.
- The corpus is small (60) and the scenario mix is designed, not sampled.
  The numbers demonstrate the mechanism, not EIP's base rates.
- **Real transcripts are unlabeled.** On ingested EIP transcripts the three
  rule-judgment contracts (`C-TPMO-01`, `C-SOA-01`, `C-SUP-01`) return ERROR
  "no ground truth". What still runs is schema, spans, dollar figures, PII
  and the advisory judge. Real value needs a QA-labelled stratified sample
  (for example 200 calls a month), with Attention scorecard verdicts used as
  a disagreement signal, not as truth.
- **Matcher eval.** 113 author-written fixtures (2026-09-25): 61/61 expected
  edges detected, 0 false positives on 54 negatives, 16 documented known
  limitations. With n=61 the 95% Wilson lower bound on recall is ~0.94. This
  is a regression suite, not production accuracy.
- **Rules added 2026-09-25** (compensation, TPMO data sharing, FCC one-to-one
  consent, TCPA revocation, SOA scope, Florida calling limits) have no
  rule-level `source_url`: the source watcher needs a committed snapshot of
  each watched page, and none was added. Their primary sources, with URLs, are
  on each version. The Florida rule is `disputed` (interstate reach, whether
  a requested callback is a solicitation, the enforcing agency). The CY2027
  compensation caps come from a copy of the CMS memo hosted by Ritter; the
  cms.gov original was not located. The compensation v3 start (2026-10-01) is
  Backstop's date for the CY2027 cycle; the memo sets caps for CY2027
  enrollments, not a calendar date.
- **Readiness ages** are measured when the page is read, not at `as_of`, and
  there is no task history table, so there is no burn-down trend line.
- Nothing here is compliance advice. Backstop surfaces staleness with
  citations; it never opines beyond the quoted rule text.

## Corrections

- **2026-09-25 — TPMO disclaimer, second wording.** `tpmo-disclaimer-text` v2
  carried only the wording for a TPMO that does *not* sell for every MA
  organization in the area. eCFR 42 CFR 422.2267(e)(41) (read 2026-09-23) has a
  second wording for a TPMO that does: "Currently we represent [insert number of
  organizations] organizations which offer [insert number of plans] products in
  your area. You can always contact Medicare.gov or 1-800-MEDICARE for help with
  plan choices." v2's clause text and params now carry both, and a matcher
  recognises the second. This is a data correction to an existing version, so
  the loader refuses it on a database seeded before the change: reseed
  (`scripts/demo-up.ps1 -Fresh`). Whether the CY2024 text (v1) had an
  all-plans variant was not re-read, so v1 is unchanged.

- **2026-09-23 — call-recording retention.** An earlier version of the
  `call-recording-retention` rule, the assumptions ledger and the questions
  page cited a trade-press article as reading the CY2027 rule as
  narrowing recording to enrollment calls, and called the change "10 → 6
  years" as if the 10 years had been in 422.2274. Both were wrong. Re-reading
  the source (dated 2026-04-07) showed it says all required marketing and
  sales calls must still be recorded. Re-reading eCFR showed the pre-CY2027
  422.2274(g)(2)(ii) required recording "all marketing, sales, and enrollment
  calls … in their entirety" with no retention period — the 10 years came
  from 422.504(d). CY2027 writes 6 years into (g)(2)(ii) and drops
  "enrollment" from that paragraph; the preamble calls enrollment-call
  retention out of scope. What is actually disputed is whether enrollment
  calls fall back to 422.504(d)'s 10 years — a question for counsel. Also
  corrected: the first-minute disclaimer timing is from the CY2023 rule
  (87 FR 27704), not the CY2024 rule. Caught by a citation pass against the
  primary text before the repo was shared; the rule YAML carries the same
  dated note.
- **2026-09-23 — secondary text shown as rule text.** The v2 `clause_text` of
  `soa-48h-wait` and `superlatives` put a Crowell & Moring sentence in
  quotation marks under a final-rule label. Both are now labeled as a
  paraphrase of the final rule per Crowell & Moring (secondary), with the
  primary CFR section named, and the quotation marks removed. The
  `tpmo-disclaimer-timing` v1 summary now notes that its 2023-09-30 start is
  where Backstop's history begins (the CY2024 baseline), not when the CY2023
  rule took effect. Databases seeded before this change must be reseeded; the
  loader refuses history edited in place.

## What would kill the hypothesis

A maintained rule→artifact registry at EIP — even a spreadsheet — that is
demonstrably being used for the October 1 changeover. If it exists, this becomes a
coverage check on it, and the conversation moves to what still hurts.
