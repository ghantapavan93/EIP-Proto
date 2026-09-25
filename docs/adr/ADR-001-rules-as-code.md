# ADR-001 — The rule corpus lives in Git as versioned YAML; the database is a materialization

**Status:** accepted · 2026-09-22

## Context

Medicare marketing rules change on dated events (final rules, MCMG updates —
roughly two a year). Artifacts across six or more systems encode those rules.
The question "what was the rule on September 30 and what is it on October 1?"
must be answerable, and the answer must survive a vendor swap.

## Decision

- Each rule is one YAML file with an ordered list of versions carrying
  `effective_from`/`effective_to`, a `change_classification`, machine-readable
  `params`, a `disputed` flag, and a citation.
- The loader materializes versions into the database. It is idempotent and
  **refuses to edit an existing version in place** — an edit means "add a new
  version". Git history is the audit trail for the corpus; `audit_events` is
  the audit trail for everything derived from it.
- The UI may *propose* a version through the API (what-if analysis, marked
  `git_commit: ui:<user>`); the expected production flow is a pull request.

## Consequences

- Effective-dated evaluation ("as of") is trivial and testable.
- The corpus is portable: if Attention, Salesforce or the model vendor is
  swapped, the rules and their history survive the swap.
- Two people must agree to change a rule (PR review), which is the right
  friction for compliance content.
- Cost: someone owns the YAML. Rule changes are ~2/year; maintenance is hours
  per change, and every change reuses the graph.
