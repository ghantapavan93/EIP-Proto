# Backstop — frontend

The operator console for Backstop: rules → artifacts → contracts → evidence.

Vite 5 · React 18 · TypeScript (strict) · Tailwind CSS v4 · TanStack Query v5 ·
TanStack Table v8 · react-router v6 · lucide-react.

> A prototype. Not affiliated with or endorsed by Elite Insurance Partners or any
> government agency. All call transcripts and internal artifacts are synthetic;
> public pages are real and attributed.

## Run it

```bash
npm install

# 1. Mock mode — no backend needed. Fixtures in src/mocks, served in-memory.
npm run dev:mock          # http://localhost:5173  (Vite mode "mock" → .env.mock → VITE_MOCK=1)

# 2. Against the FastAPI backend on :8000 (Vite proxies /api → http://localhost:8000)
npm run dev

# Quality gates
npm run build             # tsc -b && vite build → dist/
npm run test              # vitest (jsdom)
npm run lint              # eslint (typescript-eslint recommended, react-hooks, react-refresh)
npm run typecheck         # tsc -b --noEmit
npm run knip              # unused files, exports and dependencies (knip.jsonc)
npm run format            # prettier --write src; CI runs format:check
npm run build:mock        # static build that ships the mock (for a no-backend demo host)
npm run preview           # serve dist/
```

Sign in with a demo user (HTTP Basic; credentials live in `sessionStorage` for the tab and are
sent as `Authorization: Basic …` on every request; a 401 clears them and redirects to `/login`):

| user / password       | role     | can                                                   |
|-----------------------|----------|-------------------------------------------------------|
| `analyst` / `analyst` | analyst  | review and decide tasks                               |
| `engineer` / `engineer` | engineer | plus runs, scans, ingest, rule-version proposals, opening stale-artifact tasks, republish, approving others' test cases |
| `admin` / `admin`     | admin    | everything the engineer can, plus access review, rule-corpus adoption, audit checkpoints |

Mock mode implements the same routes, shapes and refusal codes (401/403/404/409/422) as the
backend, including idempotent scans (same key → `deduplicated: true`), idempotent runs (same
inputs → the existing run), the review state machine, and test-case creation on override.
State lives for the page session; reload to reseed.

## Screen map

| route | screen | what it answers |
|---|---|---|
| `/login` | Sign in | HTTP Basic, demo credentials listed |
| `/` | Change triggers | RULE / PROMPT / MODEL changed cards with the latest comparison headline and gate; gate strip per (prompt, model, rule date); open review tasks by kind |
| `/rules` | Rules | registry: code, title, regulator, citation, in-force version, effective from, change classification, dependents, disputed, contracts |
| `/rules/:code?as_of=` | Blast radius (the demo screen) | source watch strip (hash, changed/unchanged/first seen, excerpt, Check sources), version timeline with SUPERSEDED / IN FORCE AS OF DATE, "evaluate as of" (quick 2026-09-30 / 2026-10-01), "N artifacts · M encodings" stale, over-/under-restrictive / re-verify encodings with evidence spans, fan diagram (one node per artifact), contracts on the rule, prompt versions declaring it, propose a version (engineer/admin), what-if with proposed versions, **Open stale tasks** (engineer/admin; `POST /rules/{code}/impact/evaluate` — reading the impact opens none) |
| `/artifacts` | Artifacts | inventory with REAL PAGE / REPO PROMPT / SYNTHETIC provenance, hashes, edge counts; transcript corpus with SYNTHETIC / INGESTED · REDACTED badges; **Ingest** drawer (multipart upload, documented column mapping); **Run scan** (engineer/admin) with an optional idempotency key |
| `/artifacts/:code` | Artifact | text with every edge's evidence span highlighted (hover: rule · version · polarity), edges, versions, **Run scan** (same scan; same key → deduplicated toast) |
| `/contracts` | Contracts | severity (BLOCK/FLAG), kind (DETERMINISTIC/JUDGED), rule, owner, check, judge model / N |
| `/contracts/:code` | Contract | description, severity, kind, owner, linked rule; accuracy with CIs per corpus/run, confusion matrix, findings, scenario and product-line slices, failure-rate trend |
| `/readiness` | Readiness | milestones, 0–30 / 31–60 / 61–90 day bands, owner queues, burn-down to the next October 1, vacated and proposed versions |
| `/try` | Sandbox | check pasted artifact text against the rules as of a date; run one pasted call on a local model (`?tab=transcript`); nothing stored |
| `/evals` | Evals | matcher precision/recall tiles, per-rule table, golden cases with expected vs detected chips, FP/FN highlighted, known limitations tagged; Markdown report |
| `/models` | Models | the vendor-swap board: provider cards (Ollama probed live with its pulled models; Groq / Gemini / OpenRouter with the env var and console to get a free key), one row per model with tier, availability, **measured** vs **declared**, latest gate + adapter, defect fingerprint (failing contracts as chips), tokens in/out, latency per transcript, cost basis, judge stability, recorded cassette sets; tick two rows → Compare |
| `/runs` | Runs matrix | one row per run, one column per contract (`passed/failing`), multi-select two → Compare, **New run** drawer (adapter options disabled per `/meta`) |
| `/runs/:id` | Run | every run key, rule logic in force vs declared by the prompt, **Judge canary** (six notes, bands, means), **Cost** (usd, per call, projection), Export (Braintrust / LangSmith / CSV), per-contract summary, transcript × contract results |
| `/runs/:id/transcripts/:code` | Transcript | left: timestamped transcript with verified (teal) / unverified (red, "not found in transcript") spans; right: Extraction (rule-dependent judgments called out), Composition, Contracts (expected vs got, basis), Judge (five scores, mean, variance, advisory) |
| `/runs/compare?a=&b=` | Compare | what changed (PROMPT / MODEL / RULE DATE / ADAPTER / CORPUS / CONTRACT SET), **newly failing** (the focus), unified prompt diff + rule-dependency chips when the prompt changed, newly passing, per-contract delta bars |
| `/review?kind=&state=&task=` | Review queue | STALE_ASSET / PROPOSED_EDGE / FLAGGED_RESULT / RULE_SOURCE_CHANGED tabs, state filter, drawer with context (evidence span, rule diff, expected vs got), allowed transitions, reason code (required for dismissed / overridden / upheld), 409/403 shown inline, test case card after override |
| `/test-cases` | Test cases | overrides pending approval by a different user, 12-month expiry; Approve (engineer/admin; disabled when creator = you) |
| `/audit` | Audit log | append-only events, filters by event type / entity type / entity id, pagination, expandable payloads |
| `/governance` | Governance | action × role matrix for everyone; admins get the access review, audit checkpoints (take, list, verify a receipt) and corpus adoption; other roles see what each panel is and why it is refused |

## Layout

```
src/
  api/          client.ts (fetch + Basic auth + JSON errors, mock switch)  types.ts (mirrors backend/backstop/schemas.py)
                hooks.ts (react-query, keys namespaced under "backstop")  queryClient.ts  auth.ts  errors.ts
  components/
    layout/     AppShell NavRail TopBar StatusRail EnvBanner IdentityMenu HealthPopover CommandPalette Page ShellProvider
    ui/         Chip DataTable Drawer Toast KeyValue JsonView Eyebrow HighlightedText TickNumber
                EmptyState ErrorState LoadingState Skeleton useFocusTrap useToast
    charts/     ConfusionMatrix TrendChart StatBars OutcomeBar RateRange FanDiagram ChangeMatrix
    runs/       GateChip AdapterChip CorpusChip ModelId RunFacts DiffChips SignificancePanel AttributionPanel
    rules/      Timeline RuleVersionBadges DirectionChip DateAsOfControl OpenStaleTasksButton ProposeVersionDrawer
                RuleRefChips SourceWatch WhatIfImpact
    review/     TaskDrawer
    audit/      VerifyResult
    artifacts/  SourceBadge RunScanControl ScanStats
    evidence/   EvidenceBlock EvidenceQuote EvidenceExport
    overview/   WhereWeAre ReadinessCard
    access/     GatedButton usePermission
    sandbox/    ArtifactCheck TranscriptCheck SandboxNotes useSandboxTimers
  pages/        Login Home Rules RuleDetail Artifacts ArtifactDetail Runs RunDetail RunTranscript RunCompare Review
                TestCases Audit Governance Contracts ContractDetail Readiness Models Evals Try
  lib/          pure view logic: format, vocab, spans, stats, significance, readiness, review, evidence, sandbox …
  mocks/        server.ts (in-memory API)  rules.ts  assets.ts (artifacts + edges)  registry.ts (contracts, models, prompts)
                corpus.ts (synthetic transcripts)  engine.ts (deterministic replay + contract judging)  staleness.ts
  test/         vitest + testing-library: components, API client, mock server, review transitions, smoke of every screen
```

Every route except `/login` and `/` is code-split with `React.lazy` (`App.tsx`).

## Design tokens

All colors are CSS variables declared once in `src/index.css` (`@theme`, so they are also Tailwind
utilities: `bg-navy`, `text-teal-ink`, `border-hairline`, `bg-teal/12` …). No hex literal exists
outside that file.

| token | value | use |
|---|---|---|
| `--color-navy` | `#222c69` | app chrome (rail), primary headings |
| `--color-slate` | `#344054` | secondary surfaces / headings |
| `--color-teal` | `#3bafbf` | accent for borders, rails, tints and marks; never text (2.6:1 on white) |
| `--color-teal-ink` / `--color-teal-ink-hover` | `#19727d` / `#145f68` | link text, primary button fills, focus ring |
| `--color-green` / `--color-green-ink` | `#65bc7b` / `#2b7640` | success · GREEN gate · PASS |
| `--color-red` | `#ba0000` | BLOCK · FAIL · RED gate · under-restrictive · unverified spans — never decoration |
| `--color-amber` / `--color-amber-ink` | `#d97706` / `#a84d07` | FLAG · AMBER gate · over-restrictive · disputed · environment strip |
| `--color-ink` / `-2` / `-3` | `#172033` / `#5b6679` / `#5f6a7d` | body / secondary / tertiary text |
| `--color-canvas` / `--color-surface` / `--color-band` | `#f6f8fb` / `#ffffff` / `#f2f4f7` | page / data surfaces / table headers and wells |
| `--color-hairline` | `#e4e8ef` | separators |
| `--color-input` | `#cfd5de` | input borders |
| `--color-footer` | `#5f6a7d` | footer text |
| `--font-sans` / `--font-mono` | Inter if installed, else the system UI face / ui-monospace stack | everything / hashes, ids, timestamps, code |
| `--spacing-rail` / `--spacing-topbar` / `--spacing-row` | 232px / 52px / 42px | nav rail, top bar, table row |
| `--radius-ui` / `--radius-card` | 6px / 8px | buttons and inputs / cards |

Type: headings 600; table text 13px; 11px uppercase eyebrows; buttons 34px high, weight 600, 6px
radius; chips 20px (16px for xs), 11px uppercase (10px for xs), 1px border, 4px radius, filled only
for gate states. No gradients except the loading skeleton; one faint card shadow (`--shadow-card`).

## Data layer notes

* `src/api/types.ts` mirrors `backend/backstop/schemas.py` field for field. `date` → `YYYY-MM-DD`
  string, `datetime` → ISO string, `dict[str, Any]` → `Record<string, unknown>` narrowed at the
  point of use (no `any` in `src`).
* Vocabulary (change classifications, directions, gates, outcomes, kinds, states, reason codes,
  audit event types) is used verbatim from `docs/api-contract.md`; see `src/lib/vocab.ts`.
* 4xx responses are never retried; they are decisions (409 illegal transition, 403 role) and are
  rendered inline with their status.

## Live-API shapes the UI relies on (verified against the running backend)

The `dict[str, Any]` fields in the contract carry these shapes on the live API; `src/api/types.ts`
documents them and `src/lib/runStats.ts` / `src/lib/evidence.ts` narrow them defensively (a missing
key degrades to a dash or the JSON fallback, never a crash).

| field | shape |
|---|---|
| `ImpactOut.counts` | `{over_restrictive, under_restrictive, reverify, disputed, total, artifacts}` — `total` counts **encodings** (edges), `artifacts` distinct artifacts; the UI always says "N artifacts · M encodings" |
| `ImpactOut.prompt_versions[]` | `{id, workflow, version, label, prompt_hash, declared_version, stale}` |
| `PromptVersionOut.encodes_rule_versions` | `[{rule, version}]` |
| `RunOut.stats` | `{transcripts, adapter_errors, review_tasks_opened, contracts:{code:{PASS,FAIL,FLAG,ERROR}}, logic_in_force, logic_declared_by_prompt, latency_ms_total, latency_ms_per_transcript, judge_stability:{notes[], n_per_note, out_of_band, mean_variance, stable, note}, cost:{usd, per_call_usd, basis, projection}}` |
| `RunResultOut.evidence` | per family — rule contracts `{expected, got, truth_basis, model_basis, rule_logic, direction?, …}`; C-SPAN-01 `{not_in_transcript:{label:text}, checked}`; C-FACT-01 `{invented_figures[], summary_figures[], transcript_figures[]}`; C-PII-01 `{pii_in_output}` or `{pii_types_reported[]}`; C-SCHEMA-01 `{fields}` or `{error, raw_keys}`; C-SUP-01 `{expected_flags[], got_flags[], substantiation_required}`; J-COACH-01 `{scores[], n, mean, variance, threshold, judge, advisory}`; no ground truth `{error, model_says}` |
| extraction (workflow output) | rule-dependent keys `disclaimer_compliant`, `disclaimer_basis`, `soa_wait_compliant`, `soa_exception`, `superlatives[].flagged` |
| `ScanOut.stats` | `{artifacts, unchanged, new_versions, fetch_errors, edges_new, edges_existing, proposed_new, mode, as_of, staleness:{rule:{counts}}, llm?}` |
| `CompareOut.what_changed` | six booleans (prompt, model, rule_date, adapter, corpus, contract_set) and two counts (`cells_only_in_a`, `cells_only_in_b`); `per_contract[]` = `{contract_code, a_fail, b_fail, newly_failing, newly_passing}` |
| `ReviewTaskOut.payload` | STALE_ASSET `{rule, bound_version, in_force_version, as_of, disputed}`; PROPOSED_EDGE `{rule, version, matcher}` or `{rule, detection}`; FLAGGED_RESULT `{run_id, contract, severity, transcript_id, aggregate?, flagged_transcripts?[]}` (evidence fetched from `/runs/{run_id}/results?transcript=&contract=`); RULE_SOURCE_CHANGED `{rule, source_url, previous_hash, new_hash, excerpt}`; after `overridden`, `test_case_id` |
| transcripts | synthetic text is `[mm:ss] SPEAKER:` per line; ingested exports are inline `[hh:mm:ss] SPEAKER:` — `src/lib/transcript.ts` splits both; `synthetic=false` + `labels.redacted` ⇒ INGESTED · REDACTED |

Additional endpoints used: `POST /rules/{code}/impact/evaluate?as_of=` (Open stale tasks), `GET /rules/{code}/sources`, `POST /sources/check?live=`, `GET /prompts/diff?a=&b=`
(prompt version ids, mapped from `/workflows/{code}`), `GET /runs/{id}/export?format=braintrust|langsmith|csv`
(downloaded through a blob with the auth header), `GET /evals/matchers` and `/evals/matchers.md`,
`GET /ingest/formats`, `POST /ingest/transcripts?format=` (multipart field `file`), `GET /health/deep` (no auth).

## Remaining assumptions

1. Gate: RED if any BLOCK contract has a FAIL; AMBER if anything is FLAG'd or ERROR'd; else GREEN (mock only — the backend computes its own).
2. `MetaOut.adapters` keys are exactly `simulated | cassette | live | anthropic` (`anthropic` is an alias for `live`); an adapter reported `false` is disabled in the New-run form.
3. "Newly failing" = PASS in A and FAIL/FLAG/ERROR in B (FLAG counts as failing in the diff), matching the live compare counts.
4. Role slugs (`compliance`, `sales-innovation`, `ai-enablement`, `training`, …) are shown with EIP-floor labels via `roleLabel()`; the slug stays in the title attribute.
5. The mock adds one labeled-synthetic `EIP` internal-policy rule (`eip-recording-notice`, ADDS_REQUIREMENT) so the under-restrictive direction is exercised without a backend.
