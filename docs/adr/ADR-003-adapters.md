# ADR-003 — Three model adapters; simulation is declared, never disguised

**Status:** accepted · 2026-09-22

## Context

The demo must work with no API key, offline, and reproducibly. It must also
be *real* the moment a provider is reachable (local Ollama needs no key). A
prototype that fakes model output and does not say so would be exactly the
demo-ware an experienced engineer discounts on sight.

## Decision

Three adapters behind one interface (`harness/adapters.py`), and the run
records which one produced it:

- **simulated** — builds the workflow output from the corpus ground-truth
  labels and the prompt's *declared* rule dependencies
  (`encodes_rule_versions`), not from the prompt text, then applies a defect
  profile declared in `fixtures/simulated_profiles.yaml` (numeric
  hallucination, span paraphrase, PII leak, timestamp misread, generic
  coaching), seeded by (model, transcript). Consequences: the rule-flip and
  model-swap numbers are true by construction; they demonstrate the
  mechanism, not model behaviour; the CI gate on `sim-large` checks declared
  dependencies; results are idempotent.
- **cassette** — replays outputs recorded from a live model, keyed by
  (prompt hash, model, transcript). Missing cassettes fall back to the live
  adapter when the provider is reachable, and record.
- **live** — one OpenAI-compatible chat-completions client for local Ollama
  and the Groq / Google AI Studio / OpenRouter free tiers (forced tool call
  at temperature 0, falling back to JSON mode), plus Anthropic's API for
  `claude-*` models; `anthropic` is accepted as an alias for `live`. The
  judge runs at temperature 1.0, N times. Every measured run in this
  build was local Ollama, at $0.

Simulated models (`sim-*`) may only run on the simulated adapter; live models
may not run on it. The API refuses the cross.

## Consequences

- Every run in the UI carries an adapter badge; nobody can mistake a
  simulated regression for a measured one.
- `backstop record --model ollama/qwen2.5:7b-instruct --prompt 2` converts
  the demo from simulated to measured on a laptop GPU (9–55 minutes per
  60-transcript set here), then replays offline.
- The simulated profiles are a design artifact reviewers can argue with,
  which is better than hidden randomness.
