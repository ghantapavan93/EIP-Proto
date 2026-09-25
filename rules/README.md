# Rule corpus

Git-owned source of truth for the Medicare rules Backstop reasons about. The
database is a materialization of these files; `backstop seed` (or
`POST /api/rules/reload`) loads them. Editing a file and committing it is the
audit trail — nothing is updated in place.

Each file is one rule with an ordered list of versions. The file itself needs
`code`, `title`, `regulator`, `citation` and `versions`; `applies_to`,
`summary` and `source_url` are optional (`source_url` is the page the source
watcher hashes). A version has:

| field | meaning |
|---|---|
| `version` | monotonically increasing integer |
| `status` | `in_force`, `eliminated`, `amended`, `proposed`, `vacated`, `stayed`. The first three are enacted: their windows must not overlap and at most one may be open. `proposed` (not law yet), `vacated` (a court set it aside) and `stayed` (paused by a court or the agency) are **never in force**, whatever their dates say; they sit outside the window checks, and an artifact bound to a vacated or stayed version is always stale |
| `effective_from` / `effective_to` | when the version applies to EIP's workflow; `effective_to` null = current. Only a `proposed` version may leave `effective_from` null (no date until the regulator acts) |
| `regulation_effective` | optional: the regulation's legal effective date when it differs from `effective_from` (the CY2027 rule took effect 2026-06-01; its marketing provisions apply from 2026-10-01) |
| `change_classification` | `INITIAL`, `ADDS_REQUIREMENT`, `REMOVES_REQUIREMENT`, `TIGHTENS`, `LOOSENS`, `MODIFIES`, `CLARIFIES`, `RESTORES_PRIOR` (a later version was set aside and the earlier text governs again) — drives staleness direction (see `backstop/core/staleness.py`) |
| `params` | machine-readable knobs that contracts read (e.g. `window_seconds`) |
| `disputed` / `dispute_note` | when sources disagree, both readings are carried and flagged "verify with counsel" — never silently picked |
| `clause_text` | quoted regulatory text or a faithful paraphrase, marked which |
| `summary` | optional one-paragraph plain-English reading of the version |
| `source_url` | primary source where possible |
| `sources` | provenance list of `{authority, cite, url, reading}`; `authority` is `primary`, `preamble` or `secondary`, and the loader sorts in that order. A secondary reading can raise a question for counsel; it never overrides the primary text |
| `vote_date` | optional: the date a regulator votes on a proposed version |
| `deferrals` | optional list of `{provision, deferred_to, source}`: a clause whose compliance date moved while its text did not (e.g. an FCC waiver) |

A version's identity is its `status`, `clause_text`, `effective_from`,
`change_classification` and `params`. If any of those change for a version
that is already loaded, the loader refuses and asks for a new version instead.
Closing an open window (`effective_to` from null to a date) is the one allowed
edit. `sources`, `vote_date` and `deferrals` are annotations: they describe a
version without changing it, and `vote_date` and `deferrals` are refreshed in
place on reload (audited as `rule.version_annotated`).

A version proposed through `POST /api/rules/{code}/versions` is stored as
`proposed` and is never in force. If a YAML file later claims its number, the
proposal moves to the next free number; Git owns the numbering.

## The rules

| file | subject | versions |
|---|---|---|
| `agent-broker-compensation.yaml` | CMS agent/broker compensation: fair-market-value caps, renewals, referral fees, administrative payments. v2 is vacated; v3 restores the prior text | 3 |
| `call-recording-retention.yaml` | CMS retention period and scope for marketing and sales call recordings | 2 |
| `eip-licensing-footprint.yaml` | EIP's "licensed in N states" claim; an internal fact, not a regulation | 2 |
| `fl-telesolicitation-hours-frequency.yaml` | Florida calling hours (8 a.m. to 8 p.m.) and at most 3 calls in 24 hours on the same subject | 1 |
| `soa-48h-wait.yaml` | CMS 48-hour wait between Scope of Appointment and a personal marketing appointment; eliminated from 2026-10-01 | 2 |
| `soa-all-personal-marketing-appointments.yaml` | CMS Scope of Appointment before every personal marketing appointment, inbound and unscheduled included | 2 |
| `soa-educational-events.yaml` | CMS Scope of Appointment collection at educational events | 2 |
| `superlatives.yaml` | CMS superlatives in marketing materials and sales language | 2 |
| `tcpa-consent-revocation.yaml` | FCC TCPA: honouring revocation of consent for robocalls and robotexts. v1 carries a deferral; v2 is proposed, undated, with a vote date | 2 |
| `tcpa-pewc-one-to-one.yaml` | FCC TCPA prior express written consent: the one-to-one amendment, vacated (v2) | 2 |
| `tpmo-data-sharing-consent.yaml` | CMS: sharing beneficiary data between TPMOs needs prior express written consent, one recipient at a time | 1 |
| `tpmo-disclaimer-text.yaml` | CMS TPMO disclaimer: required wording | 2 |
| `tpmo-disclaimer-timing.yaml` | CMS TPMO disclaimer: when it must be delivered on a sales call (60-second timer, then before any benefits discussion from 2026-10-01) | 2 |

Citations were checked against LII's mirror of 42 CFR Part 422 Subpart V on
2026-09-21 (amendment history ends `91 FR 17583, Apr. 6, 2026`) and the Crowell
& Moring CY2027 client alert. Paragraph-level citations marked `verify` were not
re-read at paragraph level and should be confirmed before being quoted to a
regulator.
