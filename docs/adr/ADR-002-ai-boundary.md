# ADR-002 — Deterministic code decides; the model proposes; a named human confirms

**Status:** accepted · 2026-09-22

## Context

Medicare sales is a regulated, sensitive domain. An LLM judge's score moves
when the judge model is updated; a crawled page is adversarial input; a
compliance decision must be reproducible and auditable. The prototype's
credibility depends on being precise about where a model is allowed to act.

## Decision

| Decision | Owner |
|---|---|
| Which rule version is in force on a date | code |
| Staleness direction of an edge | code (pure function, `core/staleness.py`) |
| Task state transitions, role checks, deduplication, gate color | code |
| Verbatim rule encodings in artifacts | regular expressions with context windows |
| Semantic rule encodings ("two business days") | model **proposes** with an exact quoted span; the span is verified as a substring by code; no span → no edge; every proposal enters the review queue as `proposed` |
| The workflow's extraction and composition | model — this is the thing under test |
| Whether the workflow's output is acceptable | deterministic contracts against ground truth under the rule in force |
| Coaching-note quality | model-as-judge, **advisory only**, N=5 with variance reported; may FLAG, never FAIL, never gates |
| Editing artifacts, records, or rules | never automated |

Prompt-injection posture: page text and transcripts are wrapped as data with
explicit untrusted-content framing; the extractor and the proposer are
extraction-only with structured output and no tools; deterministic paths are
structurally immune; a fixture with injected instructions is in the test
suite.

## Consequences

- Only BLOCK contracts (all deterministic) can turn the gate RED. A false
  block cannot come from judge noise.
- The model's contribution is visible and bounded: proposed edges carry
  `detection: llm`, `confidence`, and the reviewer's decision.
- If the LLM proposer adds nothing on a corpus, the eval says so and the
  interface stays — a null result is information.
