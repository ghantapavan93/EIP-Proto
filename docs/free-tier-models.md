# Running real models for $0

Backstop does not depend on a paid model API. One adapter speaks the
OpenAI-compatible chat-completions protocol to whichever provider is
configured; the contracts, the harness and the UI do not change.

| Provider | Cost | How to enable | What it is good for |
|---|---|---|---|
| **Ollama (local)** | $0, offline, nothing leaves the machine | install Ollama, `ollama pull qwen2.5:7b-instruct` (fits a 6 GB GPU) | the default live path; the honest "no API spend" baseline; the demo's recorded cassettes |
| **Groq** | free tier | key from console.groq.com → `GROQ_API_KEY` | Llama 3.3 70B (≈100K tokens/day: one 20-transcript run + judge) and Llama 3.1 8B (≈500K tokens/day: a full run); very fast |
| **Google AI Studio** | free tier | key from aistudio.google.com → `GEMINI_API_KEY` | Gemini 2.5 Flash (≈250 requests/day) and Flash-Lite (≈1000/day, a good cheap judge) |
| **OpenRouter** | free `:free` models | key from openrouter.ai → `OPENROUTER_API_KEY` | ≈50 requests/day without credits — samples only |
| Anthropic | paid | `ANTHROPIC_API_KEY` | not needed for anything here |

Limits are the providers' published free-tier numbers at the time of writing;
the adapter paces itself to them (`harness/providers.py`) and retries 429s
with backoff. They change — check the provider's page.

## Recipe: record once, replay forever

```bash
backstop providers                                   # what is configured
backstop record --model ollama/qwen2.5:7b-instruct --prompt 2 --rule-date 2026-10-01 --trigger MODEL
backstop record --model ollama/qwen2.5:3b-instruct --prompt 2 --rule-date 2026-10-01 --trigger MODEL
backstop record --model ollama/llama3.1:8b          --prompt 2 --rule-date 2026-10-01 --trigger MODEL
# the "judge has the disease it diagnoses" answer: the small model's notes, judged by the larger one
backstop record --model ollama/qwen2.5:3b-instruct --judge-model ollama/qwen2.5:7b-instruct --trigger MODEL
backstop demo                                        # replays every recorded set, offline
```

Each `record` runs the model live through the **cassette** adapter and writes
one JSON file per transcript (and per judge call) under
`fixtures/cassettes/<prompt_hash>/<model>/` — `T017.generate.json`,
`T017.judge.json`, `canary_c1.judge.json`, and `T017.judge@<judge>.json`
when the judge is another model. The next run with the same inputs replays
the cassettes — no GPU, no network, identical results. The UI shows
`CASSETTE` on those runs; token usage and latency are the recorded values.
`record` is idempotent on the run key: to re-record, delete the run (or the
database) first.

## What the adapter does with a small model's answer

Small local models do not always follow a nested tool schema. The adapter
gives every model the same fair chance and never repairs an answer:

1. a forced tool call (`tool_choice`), when the model supports tools;
2. if the server ignored `tool_choice`, returned unparseable arguments, or
   the chat template flattened the nested schema into one shallow object
   (Ollama's Qwen 2.5 template does this every time), one JSON-mode attempt
   with the schema in the system prompt;
3. after two consecutive tool-mode misses, JSON mode only for the rest of the
   run — so the run does not pay for a doomed attempt on every transcript.

Whatever comes back is validated by `C-SCHEMA-01`; a flat or invalid object
fails there, on the record, as the model's own defect. Both attempts' tokens
are counted (`usage.attempts` on every output, shown on the transcript page).

The judge can live at another provider (`--judge-model gemini/…` on a Groq
run): it gets its own client, key and pacing.

On a hosted free tier, spare the quota:

```bash
backstop record --model groq/llama-3.3-70b-versatile --prompt 2 --limit 20 --judge-n 3 --judge-model groq/llama-3.1-8b-instant
backstop record --model gemini/gemini-2.5-flash --prompt 2 --limit 30 --judge-n 3 --judge-model gemini/gemini-2.5-flash-lite
```

`--limit` caps transcripts, `--judge-n` lowers the judge's N (the canary
still runs), `--judge-model` moves the advisory judge to a cheaper model.
Every run records which judge it used and how many times.

## Measured on this laptop (prompt v2 · rules as of 2026-10-01 · 60 synthetic calls)

Recorded 2026-09-22 on an RTX 3060 through Ollama; replayed by `backstop demo`.
Cells are failing contract results out of 60 (FLAG for `C-SUP-01` and
`J-COACH-01`); "schema" failures make the remaining contracts report ERROR for
that call, which opens no tasks.

| Model | Gate | Schema | Spans not verbatim | TPMO judgment | SOA judgment | Superlatives | Judge flags | Tokens in / out | Wall clock per call | Recording time | Judge canary (self-judged) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Qwen2.5 7B | RED | 0 | 3 | **20** (18 over-restrictive, 2 missed) | 0 | 3 | 2 | 86,173 / 28,973 | 17.6 s | 18 min | drift — 2 of 6 notes out of band |
| Qwen2.5 3B | RED | 2 | 4 | 4 | 0 | 0 | 1 | 106,774 / 27,607 | 8.5 s | 9 min | drift — 1 of 6 |
| Llama 3.1 8B | RED | **15** | 3 | 9 | 3 | 6 | 0 | 151,362 / 53,150 | 52.5 s | 55 min | stable |
| Qwen2.5 3B, judged by 7B | RED | 2 | 4 | 4 | 0 | 0 | 0 | — (judge only) | — | 37 s | drift — 2 of 6 |
| Qwen2.5 7B, **prompt v3** | RED | 0 | 1 | **5** (2 over-restrictive, 3 missed) | 1 | 3 | 3 | 91,007 / 30,700 | 17.8 s | 19 min | drift — 1 of 6 |

What the numbers say, and what they do not:

- **The 7B reads the call correctly and reasons wrong.** In 18 calls it
  extracted the disclaimer at 25 s and benefits at 130+ s, then marked the
  disclaimer non-compliant. `C-TPMO-01` catches it because the verdict is
  compared with ground truth under the rule in force, not with the model's own
  explanation.
- **Prompt v3 spells the comparison out** (it rewrites one rule line of v2;
  same rule versions): wrong judgments drop 20 → 5 and 21 cells pass that did
  not (17 `C-TPMO-01`, 2 `C-SPAN-01`, 2 `J-COACH-01`) — but 6 fail that
  passed before: two disclaimer verdicts and one SOA verdict (the
  model now writes `"40s < 25s -> compliant"` on two calls and `"25s < 117s
  -> non-compliant"` on another), plus three coaching notes the judge flags
  that it did not before. Runs → Compare shows all of it because both runs exist;
  that is the PROMPT trigger, measured.
- **The v3 result is in-sample.** v3 was written after reading the 7B's v2
  failures on the same 60 development calls (T001–T060). A held-out draw
  (H001–H060: same generator and scenario mix, seed 2027, never read while
  writing prompts) was recorded afterwards. It tests overfitting to specific
  calls, not robustness beyond the generator: both sets come from the same
  generator.

  **Held-out result (recorded 2026-09-23, same 7B, same rules):** on the 60
  unseen calls, v2 got **5** disclaimer judgments wrong (4 missed violations,
  1 false flag) and v3 got **22** wrong (14 false flags that repeat the
  reversed comparison, e.g. "25s < 142s -> non-compliant", plus 8 missed
  violations), and 2 v3 outputs failed the schema. **The v3 fix did not
  generalize**: 20 → 5 in-sample was fitted to those 60 calls. It also shows
  v2's error rate swinging from 20 to 5 between two draws of 60, so one set
  of 60 calls with one generation each cannot rank two prompts. On this
  evidence neither prompt ships, and the deterministic contract, not the
  model's own explanation, is what caught it. Both held-out runs replay in
  the demo (Runs → "Held-out check").
- **The 3B's defects are grounding defects**: `soa_span: "00:02:17"` (a
  timestamp instead of a quote), "Signing the Scope of Appointment to your
  email" (a paraphrase). `C-SPAN-01` fails them because the span is not a
  verbatim substring of the transcript.
- **Llama 3.1 8B returned the JSON schema itself instead of an instance** in
  12 of 60 calls; two more outputs omitted `product_line` and one listed a
  superlative with no text. The 3B's two schema failures omitted the required
  `appointment_scheduled` boolean (one of them also put a customer's surname
  into `pii_detected`, where only types belong). The schema contract fails
  those calls; nothing downstream guesses.
- **Judge canary.** The 3B judging itself puts one canary note outside its
  band; the 7B judging the 3B's notes puts two outside. Read that with its
  limits: six notes, N=5 each at temperature 1.0 on a 1–5 scale, judged with
  an empty transcript, against author-set bands 1.2–1.6 wide. The SE of a
  5-sample mean is about 0.2–0.45, so only shifts of roughly 1 point
  register. It checks calibration against bands set once; it does not track
  drift over time.
- These are three small local models on a laptop, under a prompt written for
  a frontier model. They say nothing about a production model's base rates.
  They say a great deal about whether the harness measures what it claims to.

## Why this matters in the room

- The **MODEL trigger** becomes real: local 7B vs local 3B, or Groq Llama 70B
  vs Gemini Flash — measured grounding defects, not a declared profile.
- **Vendor independence is demonstrated, not claimed**: the same contract
  set, the same corpus, three providers, one parameter.
- **Cost is measured**: token usage comes from the provider; local runs
  report "$0 — local GPU" and hosted free tiers report "$0 — rate-limited",
  with the projection note that production volume needs a paid tier or a
  local host.
- **Nothing private leaves the laptop** on the local path — the same posture
  EIP would want for real transcripts.
