# Assumptions ledger

Every claim the prototype rests on, labeled. **FACT** = first-party or primary
source read on the date given. **HYPOTHESIS** = inferred from public evidence;
could be wrong. **ASSUMPTION** = a design choice made in the absence of
evidence; the prototype works either way. Public sources only; nothing private
was requested or used.

## About the rules

| # | Claim | Label | Source |
|---|---|---|---|
| R1 | CY2027 marketing provisions apply 2026-10-01; AEP opens 2026-10-15 | FACT | Crowell & Moring alert (2026-04-17); medicare.gov/health-drug-plans/open-enrollment |
| R2 | TPMO disclaimer must be conveyed verbally "prior to the discussion of any benefits"; the disclaimer wording sits in the 422.2267(e)(41) lead-in, with (i) who must use it and (ii) when; the CFR wording in force before Oct 1 has no "(SHIP)" | FACT | LII / eCFR, 42 CFR 422.2267(e)(41); CY2027 rule FR doc 2026-06600, 91 FR 17384 (Apr. 6, 2026; reg. text at 17583), read 2026-09-21, re-checked 2026-09-23 |
| R2a | A mere mention of a benefit is not a discussion of benefits | FACT | CY2027 preamble, 91 FR 17448-49 |
| R3 | The first-minute delivery requirement came from the CY2023 rule and stayed in force through CY2026 | FACT (secondary) | CY2023 final rule, 87 FR 27704 (May 9, 2022); paragraph not re-read |
| R4 | 48-hour SOA waiting period eliminated effective 2026-10-01; SOA itself still required | FACT (secondary) | Crowell & Moring alert |
| R5 | Before CY2027, 422.2274(g)(2)(ii) required recording "all marketing, sales, and enrollment calls … in their entirety" and stated no retention period; the 10 years came from 422.504(d). CY2027 writes 6 years into (g)(2)(ii) (3 audio + 3 audio-or-transcript) and drops "enrollment" from that paragraph | FACT | eCFR / LII 42 CFR 422.2274(g)(2)(ii) and 422.504(d); 91 FR 17384 preamble; re-checked 2026-09-23 |
| R6 | Whether enrollment calls now fall back to 422.504(d)'s 10-year retention (the preamble calls enrollment-call retention out of scope) | **Disputed** — ask counsel. All required marketing and sales calls must still be recorded. (Corrected 2026-09-23; see honesty.md → Corrections) | CFR text + preamble |
| R7 | Superlatives-without-documentation prohibition removed | FACT (secondary) | Crowell |
| R8 | SOA collection at educational events permitted; 12-hour gap removed; beneficiaries must be told the educational event is ending and given a sufficient opportunity to leave before marketing begins | FACT | 42 CFR 422.2264(c)(1)(ii)(D) and (c)(2)(i) as amended (eCFR); Crowell |
| R9 | Medigap advertising is state-regulated (NAIC Model 660), not CMS | FACT | NAIC model law |
| R10 | CMS has no AI/chatbot-specific marketing rule in force | FACT | CY2026 final rule fact sheet (AI guardrails not finalized); CY2027 rule has none |
| R11 | The CY2025 agent/broker compensation rewrite (89 FR 30448; 422.2274(a), (c), (d), (e)) was stayed 2024-07-03 and vacated 2025-08-18 (N.D. Tex., No. 4:24-cv-00439-O); not appealed; the pre-CY2025 text "remains in effect until further notice"; eCFR still prints the vacated text | FACT | CMS CY2027 compensation memo (2026-06-01; Ritter-hosted copy, cms.gov original not located); eCFR 422.2274(e)(2) read 2026-09-23 |
| R12 | CY2027 FMV caps: MA national $725 / $363 (CT-PA-DC $816 / $408; CA-NJ $902 / $451; PR-USVI $495 / $248); PDP $130 / $65; referral fees MA $100, PDP $25 | FACT | same memo |
| R13 | The CY2027 caps apply in Backstop from 2026-10-01 | ASSUMPTION — the memo sets caps for CY2027 enrollments, not a calendar date | — |
| R14 | 422.2274(g)(4): TPMO-to-TPMO sharing of beneficiary data needs prior express written consent listing each recipient, in force since 2024-10-01, and was not vacated | FACT (text); FACT (secondary) that the court left it in place | eCFR 422.2274(g)(4); Healthcare Dive 2024-07-10; 91 FR 17449 |
| R15 | The FCC one-to-one consent amendment (64.1200(f)(9), 2023) was vacated by the 11th Circuit on 2025-01-24 before it took effect; text removed by 90 FR 42137 (2025-08-29) | FACT | Federal Register; court decision per the research note |
| R16 | TCPA revocation: any reasonable method, honored within 10 business days, in force 2025-04-11; revoke-all for informational messages deferred to 2027-01-31 | FACT | eCFR 64.1200(a)(10)-(12); DA 26-12 (2026-01-06) |
| R17 | The FCC votes on a revocation rewrite 2026-09-30 (draft FCC-CIRC 2609-05); it would take effect 30 days after Federal Register publication | FACT that the draft says so; the outcome is unknown until the vote | docs.fcc.gov DOC-424844A1 |
| R18 | From 2026-10-01 an SOA is required before every personal marketing appointment, inbound, walk-in, unscheduled call, web chat and web form included ("scheduled" removed from 422.2264(c)(3)(i)) | FACT | eCFR 422.2264(c)(3)(i); 91 FR 17456, 17459 |
| R19 | Florida 501.616(6): no solicitation call before 8 a.m. or after 8 p.m. called-party time; at most 3 calls per 24 hours on the same subject; reaches licensed insurance agents via 501.604 | FACT | Fla. Stat. 501.616, 501.604 (2026) |
| R20 | Whether 501.616(6) reaches interstate calls, and whether a requested callback is a solicitation | **Disputed** — ask counsel | — |
| R21 | CY(N+1) marketing may begin Oct 1; AEP runs Oct 15 – Dec 7; MA OEP Jan 1 – Mar 31 | FACT | 42 CFR 422.2263(a), 422.62(a)(2)(iii), 422.62(a)(3)(i) (eCFR, read 2026-09-23) |

## About EIP (public evidence)

| # | Claim | Label | Source |
|---|---|---|---|
| E1 | EIP uses Salesforce (+ Marketing Cloud), MuleSoft, Snowflake, Attention, Vigil (vigilnow.com), Power BI | FACT | Vigil and Attention case studies; live SFMC CloudPages; job postings 2025–2026 |
| E2 | Attention scores 100% of calls on a 28-item revenue-weighted scorecard with automated daily coaching | FACT (vendor-stated) | attention.com/customers/elite-insurance-partners |
| E3 | Three open technology roles: AI Workflow Engineer, AI Enablement Specialist, Full Stack Software Engineer; the JDs ask for "systematic testing and evaluation approaches" and "turn prototypes … into reliable production-ready applications" | FACT | jobs.jobvite.com/teameip (read 2026-09-21) |
| E4 | Vapi is EIP's voice-AI vendor | **UNKNOWN** — named only in a removed 2025 posting; nothing here depends on it | search snippets |
| E5 | EIP has an eval / prompt-versioning tool today | **UNKNOWN** — no public evidence either way; the JD asks the hire to *create* evaluation approaches | Jobvite |
| E6 | A rule→artifact registry (even a spreadsheet) exists and is being used for Oct 1 | **UNKNOWN** — this is the kill evidence for the hypothesis | — |
| E7 | The public SOA FAQ encodes the 48-hour window (correct until 2026-09-30); one footer carries the pre-CY2027 SHIP disclaimer wording; two pages give different licensing-footprint figures | FACT | excerpts under fixtures/pages/, read 2026-09-21 |

## Design inputs

| # | Claim | Label | Source |
|---|---|---|---|
| D1 | Public talks and posts on vendor change and model monitoring informed ADR-004 (right-sizing) and ADR-006 (advisory judges) | FACT that they were read; how they apply here is a HYPOTHESIS | public posts |

## Design assumptions (the prototype works either way)

| # | Assumption | If wrong |
|---|---|---|
| A1 | Internal artifacts can be represented as (text, type, owner) records from a source adapter | adapters change; the graph does not |
| A2 | The workflow under test is a post-call QA/handoff record | swap the workflow; contracts are per-workflow anyway |
| A3 | Sixty synthetic calls with a designed scenario mix demonstrate the mechanism | they do not demonstrate EIP's base rates, and the README says so |
| A4 | Deterministic-first with a proposal-only model is the right AI boundary for compliance content | if EIP wants the model to decide, that is a one-line change and a conversation about who signs |
| A5 | Rule changes are rare (~2/year) so YAML-in-Git maintenance is cheap | if carrier bulletins count as rules, intake automation (docs/questions) moves up the list |
