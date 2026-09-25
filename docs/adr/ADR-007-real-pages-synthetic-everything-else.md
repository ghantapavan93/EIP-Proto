# ADR-007 — Real public pages, read-only and frozen; everything private is synthetic

**Status:** accepted · 2026-09-22

## Context

A prototype built on guesses about private systems is attackable in the
first minute. A prototype that touches real beneficiary data is a liability
conversation. A demo that depends on the live network is a demo that fails.

## Decision

- **Real:** six public pages on EIP-operated properties, fetched once with an
  identified user agent (`BackstopPrototype/0.1 (+repo URL; read-only research
  crawl)`), a 2-second delay, no login, no form submission, and frozen under
  `fixtures/pages/`. The demo replays snapshots (`BACKSTOP_CRAWLER_LIVE=false`
  by default).
- **Synthetic:** every internal artifact and every call transcript. Synthetic
  status is a column (`assets.is_synthetic`, `transcripts.synthetic`) and a
  badge, not a footnote. Medicare numbers in the corpus use the MBI shape with
  characters a real MBI cannot contain.
- **Never:** beneficiary records, real recordings or transcripts, CRM exports,
  carrier statements, consent artifacts. Not requested, not used.
- The `C-PII-01` contract enforces that even synthetic PII never appears in
  workflow output prose.

## Consequences

- The blast-radius demo includes real, dated evidence from EIP's own estate
  without any private access.
- The public-page crawl is a coverage check that EIP could run against its
  whole estate tomorrow; the private-system adapters are the next step, not
  a precondition.
- The honest framing in the room: "everything internal is a stand-in; the
  public pages are yours."
