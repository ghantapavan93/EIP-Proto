# Fixtures

Frozen inputs, labelled test sets and recorded model output that let Backstop run offline and reproduce the same numbers on every machine.

The backend finds this folder through `BACKSTOP_FIXTURES_DIR` (default: `fixtures/` at the repository root). Nothing here is written during a normal demo. Live scans (`--live`) refresh the snapshots, and `backstop record` adds cassettes.

## Inventory

| Path | What it is | Real or synthetic | Read by |
|---|---|---|---|
| `sources.yaml` | Artifact inventory: 6 public web pages (`real_pages`) and 15 stand-ins for internal artifacts (`synthetic`: scorecard items, scripts, a coaching prompt, an email template, training slides, an IVR line, a lead-form consent, a compensation sheet, a dialer policy). Synthetic entries carry their text inline. | Page URLs real; internal artifacts synthetic | `scanner/service.py` (`load_inventory`, scans) |
| `pages/<code>.html` | Short attributed excerpts of the six public pages (the passages around each rule-bearing sentence; every matcher result is identical to the full page): `mfaq-home`, `mfaq-about`, `mfaq-soa`, `mfaq-ma-compare` (medicarefaq.com), `teb-home` (theelitebrokerage.com), `mcmp-rates` (rates.medicarecompared.com). | Real | `scanner/crawler.py` (snapshot mode; live mode overwrites) |
| `sources/<host>-<hash>.html` | Short excerpts of the primary source each rule cites (`source_url`): the passages relevant to the rule. The watcher hashes them; a live check refreshes the full page locally. The name is the host plus the first 10 hex characters of the SHA-256 of the URL. | Real | `scanner/sources.py` (`backstop check-sources`, `POST /api/sources/check`) |
| `matcher_golden.yaml` | 113 labelled snippets with the rule-version edges a careful analyst would draw, including near-misses. | Synthetic | `scanner/evaluate.py` (`backstop eval-matchers`, `GET /api/evals/matchers`), `api/ops.py` status rail |
| `pii_golden.yaml` | 42 labelled strings for scoring the PII redactor, including negatives. | Synthetic | `backend/tests/test_governance_and_pii.py` |
| `judge_canary.yaml` | Six fixed coaching notes with expected score bands, re-judged on every judged run to detect judge drift. | Synthetic | `harness/canary.py` via `harness/runner.py` |
| `simulated_profiles.yaml` | Declared defect rates for the two simulated models, `sim-large` (clean) and `sim-small` (defect-prone). | Synthetic | `harness/adapters.py` (simulated adapter) |
| `attention_export_sample.csv` | Two example rows in the assumed Attention-to-Snowflake export shape. The column mapping is an assumption to confirm against the real export. | Synthetic | `backend/tests/test_ops.py`; documents the format for `backstop ingest` and `POST /api/ingest/transcripts` |
| `cassettes/` | Recorded real-model output, replayed offline. See below. | Real model output on synthetic calls | `harness/adapters.py` (`CassetteAdapter`), `backstop demo`, `api/runs.py` model board |

### Rule-source snapshots

| File | Source | Cited by |
|---|---|---|
| `www-law-cornell-edu-14632df50b.html` | LII, 42 CFR 422.2267 | `tpmo-disclaimer-text`, `tpmo-disclaimer-timing` |
| `www-law-cornell-edu-0133f024d1.html` | LII, 42 CFR 422.2274 | `call-recording-retention` |
| `www-crowell-com-10babe5c9b.html` | Crowell & Moring client alert on the CY2027 final rule | `soa-48h-wait`, `soa-educational-events`, `superlatives` |
| `www-medicarefaq-com-f10e3d8ece.html` | medicarefaq.com About Us | `eip-licensing-footprint` |

The other six rules have no `source_url` yet, so the watcher skips them.

## Real and synthetic

- **Real:** `pages/` and `sources/` are short excerpts of third-party pages. The pages were fetched once, read-only, on 2026-09-21 with an identified user agent, for research, and frozen so the demo never depends on the network. Each file is attributed to its publisher through its URL (in `sources.yaml` for pages, in the citing rule's `source_url` for sources). The content belongs to those publishers.
- **Synthetic:** every internal artifact, golden set, canary note, defect profile and the sample CSV. The call transcripts themselves are not stored here; `harness/corpus.py` generates them deterministically (60 development calls, `T001`-`T060`, and 60 held-out calls, `H001`-`H060`).
- **Recorded:** cassettes hold real output from real models, run through the real workflow and contracts on the synthetic calls.

## Cassettes

Layout, as written by `CassetteAdapter`:

```
cassettes/<prompt hash>/<model>/<code>.generate.json
cassettes/<prompt hash>/<model>/<code>.judge.json
cassettes/<prompt hash>/<model>/<code>.judge@<judge model>.json
```

- `<prompt hash>` is the first 16 hex characters of the prompt text's hash (`harness/workflow.py`, `prompt_hash`).
- `<model>` and `<judge model>` are model ids with every character outside `A-Za-z0-9._-` replaced by `_` (`ollama/qwen2.5:7b-instruct` becomes `ollama_qwen2.5_7b-instruct`).
- `<code>` is a transcript code, or `canary_<note id>` for a judge-canary note.
- `.generate.json` holds `raw`, `latency_ms`, `usage` and `recorded_at`. `.judge.json` holds `scores` and `meta`.
- `judge@<judge model>` is used when the judge differs from the model under test, so a cross-judged score never replays as a self-judged one.

Recorded sets:

| Prompt hash | Prompt | Model | Generations | Judge files |
|---|---|---|---|---|
| `e0cc00b5c6409648` | v2 | `ollama/llama3.1:8b` | 60 development | 45 self-judged, 6 canary |
| `e0cc00b5c6409648` | v2 | `ollama/qwen2.5:3b-instruct` | 60 development | 58 self-judged, 58 judged by `qwen2.5:7b-instruct`, 6 canary each |
| `e0cc00b5c6409648` | v2 | `ollama/qwen2.5:7b-instruct` | 60 development, 60 held-out | 120 self-judged, 6 canary |
| `fb2fbdb0b39e7e7e` | v3 | `ollama/qwen2.5:7b-instruct` | 60 development, 60 held-out | 118 self-judged, 6 canary |

There are no cassettes for prompt v1; the demo runs v1 on the simulated adapter. On replay, a missing cassette is an adapter error for that call. Only `backstop record` calls the live model on a miss and writes the new file.

To record a new set, run `backstop record --model <provider/model> --prompt <n>`. See [../backend/README.md](../backend/README.md).
