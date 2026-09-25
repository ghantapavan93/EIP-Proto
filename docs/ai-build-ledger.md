# AI build ledger

I built this prototype with an AI coding agent (Claude Code) and AI research
agents. I set the direction, the scope and the trade-offs (see
[`decisions.md`](decisions.md)), reviewed the work and decided what shipped; the
agents did much of the research and wrote much of the code under that direction.
The point of this page is not that AI was used, but what it got wrong, how the
mistakes were caught, and what that says about how AI-assisted work should be run.

## Research phase (AI research agents, cross-checked)

| What went wrong | How it was caught | Lesson |
|---|---|---|
| One research agent identified "Vigil" as getvigil.com (an Ohio servicing startup). Two others found vigilnow.com with an EIP case study. | Cross-checking three agents against each other; the vendor's own EIP case study settled it. | Never trust a single agent's vendor identification; look for the first-party artifact. |
| A research agent reported a negative finding that an independent run overturned. | Comparing the two runs; then fetching the URLs directly to verify. | Two independent searches beat one thorough one. Negative findings need a second pass. |
| A second research tool reported an Attention API with scorecard CRUD; a direct fetch of the API reference showed only one endpoint in the excerpt. | Spot-verification of every claim from that tool used in the decision. | External-AI output is data to verify, not a source. |
| A search-engine summary said the TPMO disclaimer with SHIP wording was on medicarefaq.com; the actual pages did not contain it. It was on theelitebrokerage.com. | Grepping raw HTML of the candidate pages. | Search snippets are stale or wrong; verify on the live page. |

## Build phase

| What went wrong | How it was caught | Fix |
|---|---|---|
| `C-FACT-01` failed 58 of 60 transcripts on the *clean* model — the money regex captured a trailing comma ("$25," ≠ "$25"). | The first full run showed a RED gate where the design said GREEN. | A proper currency regex with a negative lookahead; canonicalization that strips separators. Now asserted by the golden test. |
| Combining `Annotated[...]` dependencies with a `Depends(...)` default crashed FastAPI at startup. | The server log. | Role-restricted endpoints take a plain `User` annotation. |
| The staleness engine flagged artifacts that *already* encoded the upcoming rule version as stale when evaluating "as of Sept 30" (the v2 prompt, the updated scorecard draft). | `test_impact_flips_on_the_effective_date` — expected zero stale before Oct 1, got one. | Edges bound to a future version are "ahead", not stale; the pure function skips them. |
| Sentence extraction on navigation-heavy page text produced a 300-character evidence span made of menu labels. | Reading the edge listing after the first live scan. | Cap context per side at word boundaries; spans remain verbatim substrings. |
| The judged contract opened 60 review tasks for one run, drowning the queue in advisory noise. | Reading the task count after the model-swap run. | Judged contracts open one aggregate task per run; deterministic contracts open one per result. |
| The synthetic small-model profile flagged 100% of coaching notes, which made the judge look useless rather than informative. | Same run. | The profile writes a generic note ~45% of the time; the judge flags about a third. Declared in `simulated_profiles.yaml`. |
| Test ordering: the API compare test assumed runs created by a later test file existed. | First full pytest run. | Tests create the runs they need; idempotency makes that free. |
| The first full recording of a real local model (Qwen2.5 7B via Ollama) failed `C-SCHEMA-01` on 60 of 60 transcripts: Ollama's chat template flattened the nested tool schema into one shallow object, and the adapter accepted any well-formed tool call as success. | Reading the recorded cassette: 82 output tokens per call and no `composition` section. | A shallow shape check after extraction; a flat tool call falls through to JSON mode; two consecutive tool-mode misses retire tool mode for the run; a flat answer in every mode is still returned as the model's answer so the schema contract fails it on the record. Both attempts' tokens are counted. |
| Judge cassettes for the canary were written to `canary:c1.judge.json`; on NTFS the colon silently turned the file into an alternate data stream (a zero-byte `canary` file) that would never replay on Linux. | Listing the cassette directory after the run. | Cassette file names are sanitized like model ids; judge cassettes are keyed by the judge model so "3B judged by 7B" cannot replay the 3B's own scores. Pinned by `test_cassette.py`. |
| Re-recording the 7B after the adapter fix returned the *old* run instantly: `record` is idempotent on the run key, and the key did not know the output was bad. | The log said `(deduplicated)`. | Delete the run (or the database) before re-recording; documented in `docs/free-tier-models.md` (the CLI prints `(deduplicated)`). Idempotency is a feature; it just needs to be said out loud. |
| One broken output fanned out into seven review tasks (the schema FAIL plus six consequential ERRORs). | The Review badge read 514. | ERROR outcomes open no tasks; they are a missing output, surfaced by the schema contract and the run's `adapter_errors`. |
| Every run on the home page started five hours in the future: SQLite returns UTC timestamps naive, and a browser parses a naive ISO string as local time. | Comparing a run's start time with the recording log. | Every timestamp field in the API schemas is a `Timestamp` that leaves with an explicit `Z`. |
| Four of the 7B's outputs failed the schema for a `null` `disclaimer_basis` on Medigap calls — a free-text field the prompt itself says does not apply there. | Reading the schema failures after the second recording. | The field is nullable in the output model and the tool schema; the recorded outputs were re-validated on replay (the runs are rebuilt from cassettes, never edited). |
| Under prompt v2 the 7B extracted the right timestamps and contradicted them 18 times. Rather than call that "small model noise", one rule line of the prompt was rewritten as the comparison to make and the model was re-recorded. | `C-TPMO-01` evidence: `disclaimer_seconds 25`, `benefits_started_seconds 131`, `got False`. | Prompt **v3**: wrong judgments 20 → 5 and 21 cells newly passing; also 3 new deterministic failures and 3 new judge flags (6 newly failing), all kept. The regression is the point: a prompt fix is a change the harness must see both sides of. Pinned by `test_prompt_v3_fixes_most_of_the_7b_ordering_verdicts`. In-sample: v3 was written against the same 60 calls. The held-out set (H001–H060, recorded afterwards) reversed it: v2 5 wrong, v3 22 wrong. Kept, and pinned by `test_held_out_replay_reverses_the_prompt_fix`. |

## What the agent could not do

- Verify paragraph-level CFR citations for the CY2024 text (Federal Register
  pages were blocked to fetchers). Marked *verify* in the corpus.
- Exercise a paid API (no key, no budget). The Anthropic adapter is written
  and typed but unexercised. Real-model runs were done with local Ollama
  models instead; hosted free tiers (Groq, Google AI Studio, OpenRouter) are
  wired and mock-tested but no key was created for this build.
- Know whether EIP already has a rule registry. That is the first question
  in [`open-questions.md`](open-questions.md).

## How the work was run

Research: AI research agents on public sources (vendors, rules, job
postings, EIP's public pages) with a shared labeling standard
(FACT / INFERENCE / HYPOTHESIS / UNKNOWN); a second, independent tool as a
cross-check; a synthesis pass that verified every claim it kept. Build: the domain model, rule corpus and contracts were
written first by hand; the frontend was delegated against a written API
contract; every step was checked by running it, and every number the demo
shows was turned into a test.
