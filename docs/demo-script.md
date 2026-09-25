# Demo script

Rehearse each version cold, on a timer. The frozen snapshots, the simulated
adapter and the recorded cassettes mean the demo works with the network off
and without a GPU.

Log in as the **engineer** account — `engineer/engineer` on localhost, or
`pavan` (engineer) from `.env` on a published instance. Analysts cannot start
runs or scans; that is a feature, and it is fine to say so. Give the
reviewer the `reviewer` (analyst) account if he wants to click around himself.

## Before the call

1. `scripts\demo-up.ps1` (or `./scripts/demo-up.sh`) → every component HEALTHY
   (Ollama may say offline; it is optional).
2. `scripts\demo-tunnel.ps1` → copy the `https://….trycloudflare.com` URL.
3. Open it **on your phone over cellular**: log in → Change Triggers → a rule →
   Runs → Review → Audit → export one evidence bundle. Then send the link.
4. Fallbacks: rerun the tunnel script (new URL) → screen-share
   `http://localhost:5173`.

## 3 minutes — the operator's path

The thesis in one sentence: *a rule, a prompt or a model changes; Backstop says
what still holds, what broke, where the evidence is, and who owns the decision.*

1. **(0:00) Status rail.** Before clicking anything: `HEALTHY · 13 rules · 24
   artifacts · 8 contracts · 113 golden cases · last run … · N actionable`. Click
   HEALTHY → components (API, Postgres, rules, artifacts, runner; Ollama
   optional). "Every number here is live state."
2. **(0:20) Change Triggers.** Three cards: RULE / PROMPT / MODEL. Each has a
   **delta** (what this change did) and a **current state** (what is still
   blocking, gate colour). "Zero newly failing next to a red gate is not a
   contradiction — the delta and the state are different questions."
3. **(0:45) Rule → `soa-48h-wait`, as of 2026-09-30 → 2026-10-01.** The
   in-force version flips, the counts tick, the affected artifacts highlight —
   including the real MedicareFAQ page still saying "two days". Point at
   **Applies from 2026-10-01** vs **Regulation effective 2026-06-01**, and the
   provenance list: primary authority first, secondary interpretation last.
4. **(1:15) Call-recording retention.** The OPEN QUESTION block: the primary
   text says 6 years for marketing and sales calls; whether enrollment calls
   fall back to 422.504(d)'s 10 years is flagged for counsel — "Backstop does
   not resolve a legal question by picking a side."
5. **(1:35) Review.** Opens on **Actionable**: artifact/source tasks first,
   then blocking failures grouped by run × contract. Flip to **Advisory**:
   20 judge flags became one item. "The point is a smaller human queue."
6. **(2:00) Open one task → Export evidence (Markdown).** Rule version +
   citation + sources, artifact SHA-256, the exact span, owner role, audit
   rows with their hashes, and the bundle's own SHA-256.
7. **(2:25) Audit.** Human-first rows: `pavan · ENGINEER · Evidence exported`,
   `Runner · SYSTEM · Run completed → RED · 22 blocking failures`. Expand one →
   hashes and "same action". Click **Verify chain** → "Chain verified · N rows".
   "Automation is `system:runner`, never a person; UPDATE and DELETE on this
   table are refused by the database."
8. **(2:50) Close.** "Ctrl+K gets you anywhere. What I would ask you is which
   of these artifacts actually exist at EIP and who owns them today."

## 30 seconds — the flip

1. **Rules** → `soa-48h-wait`. Point at the two versions: v1 (48 hours, CY2024),
   v2 (eliminated, effective 2026-10-01, `REMOVES_REQUIREMENT`), each with its
   citation.
2. Evaluate as of **2026-09-30** → nothing stale.
3. Evaluate as of **2026-10-01** → the blast radius. Read the list out loud:
   scorecard item SC-12 (over-restrictive — still scoring agents down for
   same-day appointments), the coaching prompt, the SFMC confirmation email
   ("as required by CMS … at least 48 hours"), the workflow prompt v1, and
   **the real MedicareFAQ page** — "the form should ideally be submitted at
   least two days before the meeting". Review tasks are open, routed to owner
   roles.

   *Line:* "One rule change, and every artifact that encodes it lights up —
   including a page that was live on your public site on 2026-09-21."

## 90 seconds — the engine

Say first: steps 4–5 run on the simulated adapter. It builds output from the
ground-truth labels and the prompt's declared rule dependencies, not the
prompt text. The numbers are true by construction; they show the mechanism,
not model behaviour.

4. **Runs** → select the two v1 runs (rule date Sept 30 vs Oct 1) → **Compare**.
   "What changed" shows only RULE DATE. 25 results flip (22 blocking FAILs, 3
   FLAGs): 14 disclaimer-timing judgments, 8 SOA-wait judgments, 3
   superlative flags.

   *Line:* "Same prompt, same calls, same model. The prompt declares a
   60-second clock and a 48-hour wait. On October 1 that is 22 blocking
   failures."

5. Compare v2 sim-large vs v2 sim-small (only MODEL changed). Rule judgments
   identical; 28 newly failing cells: 8 blocking (5 spans no longer verbatim,
   2 summaries quoting dollar figures that were never said, 1 leaked Medicare
   number) + 20 advisory judge flags (a seeded simulated profile). Open one
   transcript: the paraphrased span is red, "not found in transcript".

   *Line:* "APIs green, prompt unchanged, output wrong — with the log you'd
   need at 6 p.m. Vigil tells you the API is up; this tells you the answer is
   still right."

## 60 seconds — real models, no budget (act two, measured)

5b. **Models**. Provider cards: Ollama READY with the models pulled on this
    laptop — only if Ollama is running; otherwise the card shows offline and
    the cassette rows still replay. Groq, Google AI Studio and OpenRouter one free key away; Anthropic
    optional. The scoreboard: Qwen2.5 7B, Qwen2.5 3B and Llama 3.1 8B each
    ran all 60 calls through the same prompt and contracts on this GPU —
    **measured**, $0, cassette-replayed so the demo needs neither GPU nor
    network. Tick 7B and 3B → Compare: only MODEL changed; read the newly
    failing cells (real paraphrased spans, real timestamps-instead-of-quotes).

    *Line:* "These aren't declared defects — these are the models' own
    answers. Swapping the vendor is one parameter, and the contracts don't
    move. That's the log you don't get from an API status page."

5b′. **Runs**: select the 7B's two runs (prompt v2, PROMPT trigger v3) →
    Compare. Only PROMPT changed; the diff rewrites one rule line. Wrong
    disclaimer judgments 20 → 5; 21 newly passing (17 `C-TPMO-01`, 2
    `C-SPAN-01`, 2 `J-COACH-01`) — and 6 newly failing (two disclaimer
    verdicts, one reading "40s < 25s → compliant"; one SOA verdict; three
    coaching notes the judge now flags). *Line:* "A prompt fix is a deploy.
    This is the diff, the gain, and the regression, on the same page, before
    it reaches the floor."

    Say it before he asks: v3 was written after reading the 7B's v2 failures
    on these same 60 calls, so 20 → 5 is in-sample. A held-out set (H001–H060,
    same generator, seed 2027, never read while writing prompts) is being
    recorded afterwards. It tests overfitting to these calls, not robustness
    beyond the generator. *Then show it:* Runs → Held-out check → v2 5 wrong,
    v3 22 wrong. *Line:* "My own fix didn't generalize. On 60 calls it hadn't
    seen, v3 is worse, and the contract caught it, not the model's explanation.
    That's why the gate is deterministic, and why one set of 60 can't rank prompts."

5c. If there is time and Ollama is running (required — live needs it):
    **Runs → New run**, model `ollama/qwen2.5:3b-instruct`, adapter **live**,
    Transcripts **3**, Judge N **2** → about 45 seconds. Open a transcript:
    tokens, mode, attempts, the span check, all live. *Line:* "Same harness,
    live, on a laptop."

    ⚠ A live run at prompt 2 / rule date 2026-10-01 becomes that model's
    latest run and replaces its recorded row on the Models board. Use rule
    date **2026-09-30** for this run, or do it only after the Models act.

## 5 minutes — production thinking

6. **Artifacts** → **Run scan** (engineer/admin; also on any artifact's
   detail page). Leave the idempotency key blank: the default key is per day,
   user, as-of date and live/snapshot mode, and the demo seed used
   `demo:scan`, so the first click runs a new scan → 0 new versions, 0 new
   edges, 0 new tasks (the snapshots have not changed). Click again with the
   same inputs → toast: same scan already ran, deduplicated. UI scans
   evaluate staleness as of today unless an as-of date is given.
   *Idempotency by unique keys, not by hope.*
7. **Review** → open the proposed edge on the MedicareFAQ page ("retain
   completed SOA forms for 10 years"). Explain: the matcher proposed it, a
   human decides — this is SOA retention, not recording retention. Dismiss
   with reason `ARTIFACT_NOT_IN_SCOPE`. Try an illegal transition first
   (409) if there is time: the state machine refusing is a feature.
8. Open a FLAGGED_RESULT from the rule-flip run → override with
   `TRANSCRIPT_AMBIGUOUS` → a test case is created, pending approval by a
   different user, expiring in 365 days. Approve as admin. The next run on
   that call still computes the verdict but marks it `override`; it no longer
   blocks the gate or reopens a task. Approval changes the run key, so the
   rerun is a new run; `run.stats.test_cases` shows in_scope / applied /
   agreeing.
9. Open the rule-flip run (**v1 · sim-large · Oct 1**) → **J-COACH-01**:
   five bars, mean, variance, "advisory — cannot block". Then the **Judge
   canary** panel: six fixed notes judged N=5 each at temperature 1.0, 1–5
   scale, empty transcript, against author-set bands 1.2–1.6 wide. Say
   plainly: on the simulated adapter the canary is seeded noise, stable by
   construction. On the Qwen runs 1–2 of 6 notes fall out of band; Llama 3.1
   8B stays in. With N=5 the SE of a mean is ~0.2–0.45, so only shifts of
   about a point register. It is a calibration check against bands set once,
   not drift detection over time.
10. Same page: **Cost** — $0.00 simulated; open a Qwen or Llama run and the
    panel shows measured tokens, "$0 — local GPU", and the projection note
    that says local inference scales with GPUs, not per-token price. "Every
    run carries its price in the vocabulary the floor uses; nothing here was
    a guess."
11. **Rule detail → Source watch**: the CFR page is hashed like an artifact;
    "when LII changes, a task opens — the corpus is never edited by code."
12. **Evals**: the matcher golden set — 113 author-written cases, 61/61
    detected, 0 false positives, 16 documented known limitations. "These
    are regression fixtures, not production accuracy."
13. **Run detail → Export**: Braintrust / LangSmith / CSV. "Own the contracts,
    rent the store."
14. **Audit** → filter the task you just touched: opened → rejected transition
    → transitioned → test case created. "This log is what a carrier
    oversight conversation wants, and it was free."
15. Close on the honesty page: what is real, what is simulated, what is not
    built, `infra/terraform` as the stated shape, and the three questions.

## If he says "we already have that"

"Then you're ahead of every tool I found — Salesforce, Snowflake, Attention,
Vigil and the eval vendors have no rule→artifact map and no cross-vendor
baseline; I checked. Can you show me the registry you are using for October 1? If
it exists I'd rather adopt it and make this a coverage check on it. If it's a
spreadsheet and someone's memory, this is the version that can't forget.
Either way — what still causes friction despite the systems you already have?"

## If the network is down

Nothing changes. Snapshots are frozen; simulated runs need no model; real-model
runs replay from cassettes; the database is seeded on start.

## If asked "is this live model output?"

"The simulated rows are not, and they say so on the run — declared defect
profiles, so the rule-flip act is reproducible to the cell. The Qwen and Llama
rows are: real local models, recorded once on this laptop, replayed from
cassettes so the demo does not depend on a GPU or a network. Swap in Groq or
Gemini with one environment variable; the contracts don't change."
