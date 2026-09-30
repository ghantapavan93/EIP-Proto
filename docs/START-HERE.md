# Start here

Ten minutes, five stops, in the order the system works: a rule, what goes stale,
how the AI is judged, whether a difference is real, and the evidence left behind.
Every link opens the exact lines.

## 1. A rule is data, with its history (2 min)

[`rules/agent-broker-compensation.yaml`](../rules/agent-broker-compensation.yaml#L44)
— three versions of the CMS compensation rule. v2 was
[vacated by a court](../rules/agent-broker-compensation.yaml#L44), so it is kept as
history and never enforced; [v3](../rules/agent-broker-compensation.yaml#L84)
restores the prior text on 2026-10-01. Primary sources come first; a secondary
reading can raise a question for counsel but never overrides the rule text. For the
newest exposure on a sales floor, see
[`tcpa-ai-generated-voice.yaml`](../rules/tcpa-ai-generated-voice.yaml): FCC 24-17
puts AI-generated voices under the TCPA.

**Look for:** nothing is edited in place. A change is a new version, and the loader
refuses anything else.

## 2. What goes stale, and in which direction (2 min)

[`backend/backstop/core/staleness.py`](../backend/backstop/core/staleness.py#L121)
— `evaluate()` decides, for every artifact that encodes a rule, whether it is still
right on a given date. It is a pure function over frozen views: no database, no
model, no clock. Vacated and stayed versions are
[never in force](../backend/backstop/core/staleness.py#L34), and the
[direction table](../backend/backstop/core/staleness.py#L197) says whether a stale
script is now too strict (costs sales) or too loose (costs a CMS finding).

**Look for:** an artifact already updated for October 1 is "ahead", not stale, when
evaluated on September 30. Pinned by
[`test_impact_flips_on_the_effective_date`](../backend/tests/test_api.py#L49).

## 3. How the AI workflow is judged (2 min)

[`contracts/contracts.yaml`](../contracts/contracts.yaml#L14) — eight behavioural
contracts: schema, verbatim evidence, invented dollar figures, PII, and the rule
judgments themselves. Each check is a small function in
[`harness/contracts.py`](../backend/backstop/harness/contracts.py#L45). The release
gate is [`gate_for()`](../backend/backstop/harness/runner.py#L362): deterministic
BLOCK contracts decide; the model-as-judge
([`J-COACH-01`](../contracts/contracts.yaml#L66)) can only flag.

**Look for:** a run with no model output is GREY, not RED, and a crash while scoring
marks the run FAILED instead of leaving it running.

## 4. Is the difference real? (2 min)

[`backend/backstop/core/stats.py`](../backend/backstop/core/stats.py#L97) — exact
McNemar on paired calls, Fisher when the corpus differs, Wilson intervals, Holm
across contracts, all in integer arithmetic with a log-space fallback.
[`core/compare.py`](../backend/backstop/core/compare.py#L111) refuses to call a
difference significant unless it survives Holm and at least ten calls changed.

**Look for:** the result that went against me. Prompt v3 fixed 15 of 20 wrong
verdicts on the development calls and was significantly worse on 60 held-out calls
it had never seen. It stays in the repository, pinned by
[`test_held_out_replay_reverses_the_prompt_fix`](../backend/tests/test_cassette_replay.py#L80).

## 5. The evidence a regulator or carrier would ask for (2 min)

[`backend/backstop/core/audit.py`](../backend/backstop/core/audit.py#L144) — every
action is a row hashed to the one before it, appended under a Postgres advisory lock
so writers cannot fork the chain. The database itself
[refuses UPDATE, DELETE and TRUNCATE](../backend/backstop/db.py#L55) on the table.
[`verify_chain()`](../backend/backstop/core/audit.py#L187) finds the first row that
no longer links; an admin checkpoint catches even a full, consistent rewrite
([test](../backend/tests/test_admin_governance.py#L124)).

**Look for:** tamper-evident, not tamper-proof, and the docs say which.

## Then, if you have more time

| For | Read |
|---|---|
| What is real, simulated or not built, and the corrections log | [`honesty.md`](honesty.md) |
| How it would connect to Attention, Snowflake, Salesforce and Power BI | [`eip-integration.md`](eip-integration.md) |
| October 1 through AEP, and a 30-day pilot that ends in a decision | [`aep-runbook.md`](aep-runbook.md) |
| Why each design choice was made | [`decisions.md`](decisions.md), [`adr/`](adr/) |

To run it: `docker compose up --build`, then http://localhost:5173 as
`engineer` / `engineer`. No GPU, key or network needed.
