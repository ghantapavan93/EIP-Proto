# The screens

| Route | What it is for |
|---|---|
| `/` Change triggers | The decision surface: RULE / PROMPT / MODEL cards with the latest comparison, gate strip per (prompt, model, rule date) with cost and judge-stability chips, open review counts |
| `/rules`, `/rules/:code` | Registry and **blast radius**: version timeline with effective windows and disputed callouts, "evaluate as of" date, fan diagram, stale artifacts grouped by direction with evidence quotes and review-task state, source watch, contracts and prompts on the rule, propose-a-version what-if |
| `/artifacts`, `/artifacts/:code` | Inventory (REAL PAGE / REPO PROMPT / SYNTHETIC), text with every evidence span highlighted, versions with hashes, run-scan with idempotency toast, ingest drawer with the documented column mapping |
| `/runs`, `/runs/:id`, `/runs/:id/transcripts/:code`, `/runs/compare` | Runs matrix (one column per contract), run keys, rule logic in force vs declared by the prompt, judge canary, cost, per-contract summary, results with purpose-built evidence blocks, transcript with verified/unverified spans, compare with "what changed" chips, newly failing cells and the prompt diff |
| `/review`, `/test-cases` | Four task kinds, drawer with context and the allowed transitions, reason codes, 409/403 shown inline, override → test case → approval by a different user; approved test cases mark matching verdicts `override` on later runs |
| `/models` | The vendor-swap board: provider readiness (Ollama probed live, hosted free tiers by key), one row per model with tier, availability, *measured* vs *declared*, gate, defect fingerprint, tokens, latency, cost basis, judge stability and recorded cassettes; tick two rows → Compare |
| `/contracts`, `/evals`, `/audit` | Contract registry; matcher golden-set report; append-only audit log with filters |
| `/contracts/:code` | One contract: description, severity, kind, owner, linked rule and check version; for a chosen corpus and run, how accurate it is (rates with confidence intervals), its findings, where it fails by scenario and product line, and its failure rate across runs |
| `/readiness` | What changes next and who is not ready: milestones on a timeline (Medicare calendar dates, rule versions that apply, votes, deferrals), what flips in the 0–30, 31–60 and 61–90 day bands, owner queues oldest first, burn-down to the next October 1 (days left, stale encodings on that date, decisions a day needed, AEP countdown), and what Backstop deliberately does not enforce |
| `/try` | Sandbox ("Try your data"): tab one checks pasted text (script, scorecard item, email, web page) against the versioned rules as of a chosen date; tab two (`?tab=transcript`) runs one pasted call through the workflow on a local model. Nothing is stored |
| `/login` | Sign-in form with the product summary; the demo accounts are shown only while the server still runs them (password equals username) |
| any other path | "Not found" screen inside the app shell, with a link back to change triggers |
