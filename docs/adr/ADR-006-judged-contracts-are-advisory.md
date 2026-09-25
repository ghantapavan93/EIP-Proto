# ADR-006 — Judged contracts are advisory: N runs, variance reported, never a gate

**Status:** accepted · 2026-09-22

## Context

Published work shows an LLM-as-judge score can move when the judge model is
updated even though the graded output is unchanged, and shifts under small
prompt perturbations. A gate that blocks a release on judge noise at 6 p.m.
during AEP is an outage the tool caused. Any data-literate reviewer will
ask for N and sigma.

## Decision

- Contracts have a `kind`: `DETERMINISTIC` or `JUDGED`.
- Only deterministic contracts may carry severity `BLOCK`; only they can turn
  the gate RED.
- A judged contract runs its judge N times (default 5), stores every score,
  the mean and the population variance, the judge model id and temperature,
  and reports `FLAG` below a threshold — never `FAIL`.
- Judged flags do not open one review task per transcript; they open one
  aggregate task per run so the queue stays about decisions, not noise.
- Under the simulated adapter the judge is seeded noise around a declared
  baseline and says so in its evidence (`"simulated": true`).

## Consequences

- The `J-COACH-01` panel in the UI shows five bars, a mean, a variance, and
  the sentence "advisory — cannot block".
- A judge-model swap is a MODEL trigger like any other and is compared the
  same way; judge drift is visible as variance and mean movement across runs,
  not as a blocked release.
- Built: a canary set of six fixed coaching notes (`fixtures/judge_canary.yaml`)
  is re-judged N times (default 5, temperature 1.0, 1–5 scale, empty
  transcript) on every run and reported as `run.stats.judge_stability`
  (bands, means, variance, `stable`).
- Limits of the canary: the bands are author-set, 1.2–1.6 wide, at one point
  in time. The standard error of a 5-sample mean is about 0.2–0.45, so only
  shifts of roughly 1 point or more register. It is a calibration check
  against those bands, not longitudinal drift detection. Under the simulated
  adapter it is seeded noise and stable by construction.
