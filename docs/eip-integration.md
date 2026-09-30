# How Backstop would connect to EIP's stack

What the code supports today, what would have to be built, and what is assumed.
The stack named here is from public evidence (assumptions ledger E1: Salesforce and
Marketing Cloud, MuleSoft, Snowflake, Attention, Vigil, Power BI). Nothing below has
been connected to an EIP system.

Labels:

- **Built**: the endpoint or command exists and is tested in this repository.
- **Not built**: a proposal. The mechanism is named so it can be costed and argued with.
- **Assumed**: a guess about EIP's side that has to be confirmed before anything is built.

## At a glance

| EIP system | Direction | Mechanism | Status |
|---|---|---|---|
| Attention (via its Snowflake sync) | into Backstop | CSV export → `backstop ingest <file>` or `POST /api/ingest/transcripts?format=attention-snowflake` | **Built**; column names **assumed** |
| Snowflake / Power BI | out of Backstop | `GET /api/runs/{id}/export?format=csv` (one row per call × contract) | **Built** |
| Power BI (readiness view) | out of Backstop | `GET /api/readiness?as_of=YYYY-MM-DD` (JSON) | Endpoint **built**; Power BI connection **not tried** |
| Salesforce (review work) | out of Backstop | MuleSoft flow reads `GET /api/review?lane=actionable` and upserts Salesforce Tasks | **Not built** |
| Marketing Cloud, website CMS, LMS, scripting tool, Attention scorecard items | into Backstop (artifact text) | source adapters that emit the `fixtures/sources.yaml` record shape | **Not built**; today the inventory is a Git file |
| Dialer call records (CDRs), consent records | none today | rule params via `GET /api/rules/{code}`; the check itself in Snowflake SQL | **Not built** |
| Identity provider | in front of Backstop | OIDC with role claims, or an authenticating proxy | **Not built**; HTTP Basic stub today |
| Uptime monitoring (Vigil or any HTTP monitor) | reads Backstop | `GET /api/health`, `GET /api/health/deep`, `GET /api/status` | Endpoints **built**; monitor **not configured** |
| Release gate in a pipeline | runs Backstop | `backstop run --prompt N --model M --rule-date D --gate` exits non-zero on a blocking failure | **Built**; the nightly ECS task in `infra/terraform/main.tf` is **not applied** |

## 1. Call transcripts: Attention → Snowflake → Backstop

**Built.** `backend/backstop/harness/ingest.py` reads a CSV with the columns
`call_id, started_at, agent_name, product_line, duration_seconds, transcript`
(`fixtures/attention_export_sample.csv` shows the shape). The same code runs from the
CLI (`backstop ingest <file>`) and the API (`POST /api/ingest/transcripts`, engineer or
admin only). On the way in:

- Medicare numbers, SSNs, dates of birth, phone numbers, emails and street addresses
  are replaced with `[REDACTED-*]` before storage (`backstop/core/pii.py`).
- `agent_name` is stored as initials unless `BACKSTOP_INGEST_KEEP_AGENT_NAMES=1`.
- A `product_line` outside MA, PDP, MEDIGAP, LIFE rejects the file. A missing one is
  stored as MA and flagged on the call.
- A re-sent `call_id` is skipped, so a daily export can be re-run safely.
- Every batch writes one `ingest.completed` audit row with its hash and redaction counts.

**Assumed.** The column names. Attention's Snowflake sync carries recordings,
transcripts, scorecards and call metadata, but the exact columns are not public. The
first real step is one Snowflake view that renames columns to the list above, so
Backstop does not change when the export does.

**Limits to know before a real load.**

- One upload is capped at 20 MB (`MAX_INGEST_BYTES`, `backend/backstop/api/ops.py`).
  Assumed arithmetic: 3,000 calls a day at roughly 9 KB of text each is about 27 MB, so
  a full day needs splitting, by team or by half-day. A sampled load (for example 200
  calls a month for labelling) fits easily.
- Names spoken in the call ("my name is ...") are not detected. Addresses without a
  street suffix are missed. See `docs/threat-model.md`.
- There is no dry run and no delete endpoint. Loading is all-or-nothing per file, and
  removing an ingested batch today means a database operation, not an API call.
- Ingested calls have no ground truth, so the three rule-judgment contracts
  (`C-TPMO-01`, `C-SOA-01`, `C-SUP-01`) return ERROR on them. Schema, verbatim spans,
  dollar figures, PII and the advisory judge still run. A QA-labelled sample is what
  turns the rule contracts on.

**Where the text may go.** An ingested transcript is sent only to a local Ollama model,
or to Anthropic when `BACKSTOP_ALLOW_ANTHROPIC_REAL_DATA=1` is set. The free hosted
tiers are refused before any network call (`RealDataGuard`,
`backend/backstop/harness/adapters.py`). Setting that flag should wait for a BAA or
equivalent data agreement with the vendor.

## 2. Results out: Snowflake and Power BI

**Built.**

- `GET /api/runs/{id}/export?format=csv`: one row per transcript × contract with the
  model, prompt hash, rule date, outcome, severity, gate result and product line, plus
  the evidence as a JSON column. Cells that start with `=`, `+`, `-`, `@`, a tab or a carriage
  return are prefixed so a spreadsheet does not run them as formulas. Each export is audited.
- `format=braintrust` and `format=langsmith` give the same rows in those tools' shapes.
- `GET /api/evidence/{tasks|runs|rules}/{id}?format=json|md`: one-file evidence
  bundle with a SHA-256 in the `X-Bundle-SHA256` header.
- `GET /api/readiness`: what changes in the next 30, 60 and 90 days and whose queue is
  open. It writes nothing.

**Not built.** A scheduled job that lands the CSV in a Snowflake stage so Power BI reads
Snowflake, not Backstop. That keeps Backstop off the reporting path and matches how
EIP already reports (assumed). The Power BI Web connector could call the API directly
with Basic auth; that has not been tried.

## 3. Review work into Salesforce, through MuleSoft

**Not built.** Backstop should not become a second place agents or supervisors work
(`docs/buy-vs-build.md`). Proposed shape:

1. A MuleSoft flow polls `GET /api/review?lane=actionable&state=open` every few minutes.
2. It upserts a Salesforce Task per Backstop task, keyed by the Backstop task id as an
   external id, with the rule, the artifact, the evidence sentence and a link back.
3. The decision (verify, dismiss, uphold, or override with a reason code) stays in Backstop,
   because that is where the state machine, the second-approver rule and the hash-chained
   audit live. The Salesforce Task closes when Backstop reports the task terminal.

**Assumed.** That Tasks, not a custom object or a Case, fit EIP's Salesforce model, and
that MuleSoft can reach Backstop's network. Both are questions for EIP.

## 4. The artifacts that encode rules

**Today.** The artifact inventory is `fixtures/sources.yaml` in Git: six real public
pages (frozen excerpts) and fifteen synthetic internal artifacts. Each record is
`code, type, name, source_system, owner_role, text`. The live page fetcher exists but
is off by default (`BACKSTOP_CRAWLER_LIVE=false`) and should run only on pages EIP owns
and approves.

**Not built.** One adapter per source that emits that same record shape: Marketing
Cloud content and CloudPages, the website CMS, the LMS, the agent scripting tool, and
Attention scorecard items if Attention exposes them to EIP (unverified). The matchers,
the staleness engine and the review queue do not change when an adapter is added.

## 5. Dialer and consent data

**Not built, and maybe not Backstop's job.** The Florida calling-hours rule, the TCPA
revocation rule and the AI-voice rule are encoded as versions with machine-readable
params, but Backstop only checks artifact text against them (for example a dialer
policy that dials until 9 p.m.). Checking every call record is a query over dialer
data. Proposed split: the query lives in Snowflake next to the call records; it reads
the params of the version in force from `GET /api/rules/{code}` (for example
`latest_local: "20:00"`, `max_calls_per_24h_same_subject: 3`), so a rule change
reaches the query without anyone editing it.

## 6. Identity

**Today.** HTTP Basic against users set in an environment variable
(`backend/backstop/api/deps.py`). The three roles (analyst decides, engineer operates,
admin governs) are enforced by the server and tested. The demo accounts use the user
name as the password; the tunnel scripts refuse to publish while any account does.

**Not built.** OIDC against EIP's identity provider (not known from public evidence)
with a group claim mapped to the three roles, or an authenticating proxy (Cloudflare
Access, or the load balancer in `infra/terraform`) in front of the gateway. Either has
to be in place before real transcripts are loaded.

## 7. What to confirm with EIP first

1. The Attention → Snowflake column names, and whether transcripts carry speaker labels
   and timestamps.
2. Whether a sampled export (not the full floor) is acceptable for the first month.
3. Which identity provider, and which groups map to analyst, engineer and admin.
4. Whether review work belongs in Salesforce Tasks, and who owns the MuleSoft flow.
5. Where the dialer and consent records live, and whether they are already in Snowflake.
