# October 1 to AEP: a runbook and the first 30 days

How Backstop would be used across the CY2027 changeover and the Annual Enrollment
Period if EIP piloted it. Dates are fixed: CY2027 marketing rules apply from
2026-10-01; AEP runs 2026-10-15 to 2026-12-07 (42 CFR 422.2263(a), 422.62(a)(2)(iii)).
Everything about EIP's people and systems here is **assumed**; the roles are named by
function, not by title.

The point of the pilot is to measure three numbers before anyone argues about value:
how many artifacts encode a changed rule (N), how long a manual check of one takes
(s), and how many business days a stale artifact stays live (L). If EIP already runs a
rule-to-artifact registry for October 1, the pilot shrinks to a coverage check on it
(`docs/honesty.md`, "What would kill the hypothesis").

## Roles for the pilot

| Role | Does | Time |
|---|---|---|
| Compliance owner | Decides what a flagged artifact means; signs rule-version changes | 2–4 h/week |
| QA lead | Labels a monthly call sample; owns scorecard changes | 5 min per labelled call |
| Engineer | Runs scans and ingests; keeps the corpus and adapters working | 2–4 h/week |
| Owners of scripts, pages, prompts, training | Fix what they own when a task names them | as flagged |

## T-1: 2026-09-30

1. `backstop seed`, then open `/readiness` with `as_of=2026-10-01`. It lists every
   rule version that flips on 2026-10-01, stale encodings per owner, and the AEP countdown.
2. Note what flips on 2026-10-01 in this corpus: the 48-hour SOA wait ends; an SOA is
   needed before every personal marketing appointment, inbound and unscheduled
   included; the TPMO disclaimer moves to "before any benefits discussion"; the TPMO
   disclaimer wording is clarified (`tpmo-disclaimer-text` v2); the SOA may
   be collected at educational events; call-recording retention is written as 6 years;
   the superlatives documentation rule ends; the CY2027 compensation caps begin
   (Backstop's date for the CY2027 cycle, not a CMS calendar date).
3. The FCC's vote on the TCPA revocation rewrite is scheduled for this date. **Change
   nothing** in `rules/tcpa-consent-revocation.yaml` until an order is published. See
   "When the FCC order is published".

## Day 0: 2026-10-01

Rules flip at midnight Eastern (`America/New_York`, one clock for the whole system).

1. `backstop scan --as-of 2026-10-01`. Each stale encoding opens one review task with
   the sentence, the rule version it encodes, the direction (too strict, too loose, or
   re-verify) and the owner.
2. Triage in this order, because it is the order of call volume touched:
   1. Inbound call scripts, IVR lines and transfer flows that treat inbound or
      unscheduled calls as exempt from the SOA.
   2. Scorecard items and coaching prompts that still score the 60-second disclaimer
      timer or the 48-hour wait.
   3. Public pages and email templates with the old disclaimer wording or the 48-hour
      explanation.
   4. Training slides.
3. Record for each task: when it opened, when the owner fixed it, and minutes spent.
   Those are the N, s and L measurements.

## Days 1–10: 2026-10-02 to 2026-10-14 (before AEP)

- Close actionable tasks by owner, oldest first (`/review`, lane "actionable").
- For any prompt or model change to a sales-floor workflow, run the gate before it
  ships: `backstop run --prompt N --model M --rule-date 2026-10-15 --gate`. A non-zero
  exit blocks. Compare against the current version with the held-out calls, not only
  the development calls; the README shows why.
- Export an evidence bundle per closed rule (`GET /api/evidence/rules/{code}?format=md`)
  and file it where compliance keeps changeover records.

## During AEP: 2026-10-15 to 2026-12-07

- **Change freeze on sales-floor AI.** Prompt, model or scorecard changes pass the gate
  and a second person signs them off (a process rule; Backstop enforces two people only
  for overrides), or they wait until December 8.
- **Weekly:** re-run the scan; check `/readiness` for anything dated inside the next
  30 days (for example an FCC order becoming effective); check the audit chain
  (`GET /api/audit/verify`) and take an admin checkpoint
  (`POST /api/admin/audit-checkpoints`).
- **If a stale artifact is found live:** the owner fixes it; the task records the fix;
  the evidence bundle records when it was found, who decided and against which rule
  version. That bundle is what goes to a carrier if asked.
- **Not during AEP:** no new integrations, no new rules unless a regulator acts, no live
  crawling of pages EIP has not approved.

## When the FCC order is published

The revocation rewrite takes effect 30 days after Federal Register publication, per the
draft. Until publication there is no date to encode, and `/readiness` keeps showing the
proposal with its vote date. After publication:

1. Keep v2 as it is. A version's `status`, dates, class and params are its identity;
   the loader refuses edits to them. Add a one-line `summary` note that the proposal
   was adopted, with the FR citation (an annotation, allowed in place).
2. Close v1: set its `effective_to` to the day before the new rule's effective date
   (the one edit the loader allows on an enacted version).
3. Add v3 as `in_force` from the effective date, with the adopted text as quoted or
   marked paraphrase, the FR citation as a `primary` source, and params read from the
   adopted text, not the draft. If the Commission changed anything from the draft,
   v3 follows the adopted text.
4. Update the tests that pin two versions
   (`backend/tests/test_rule_statuses_and_readiness.py`, the revocation assertions).
5. Re-run the scan with `--as-of` set to the effective date and triage what flips:
   opt-out language, confirmation texts, and any "exclusive opt-out method" wording.

## After AEP: first 30 days of real data (from 2026-12-08)

| Week | Do | Done when |
|---|---|---|
| 1 | Snowflake view that renames the Attention export columns to Backstop's ingest shape (`docs/eip-integration.md`); SSO or an authenticating proxy in front of the gateway | A sample file ingests with zero rejected rows; no Basic-auth accounts remain |
| 2 | Ingest 200 calls, stratified by product line and team; QA labels disclaimer timing, SOA before plan discussion, superlatives | 200 labelled calls; label disagreements with Attention verdicts logged, not resolved by fiat |
| 3 | Run the current production prompt and model on the labelled set; compare with one candidate change | A comparison with attribution and a held-out check, or a written "sample too small to rank" |
| 4 | Decide: keep, shrink to a coverage check, or stop | A one-page decision with N, s and L from October, and the hours spent |

## What this runbook does not cover

- Call QA of agents. Attention does that.
- Legal interpretation. Disputed readings (enrollment-call retention, Florida
  interstate reach) go to counsel; the rule files carry the question.
- Dialer and consent-record checks. See `docs/eip-integration.md`, section 5.
