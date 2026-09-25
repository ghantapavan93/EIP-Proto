"""Command line: seed, scan, run, gate, demo, record.

    backstop seed                      # rules, contracts, workflow, models, corpus, inventory
    backstop scan [--live]             # crawl (snapshot by default), match, evaluate staleness
    backstop check-sources [--live]    # hash each rule's primary source; task on change
    backstop run --prompt 2 --model sim-large --rule-date 2026-10-01 [--gate]
    backstop demo                      # simulated runs + replay of every recorded cassette set
    backstop providers                 # which real-model providers are configured
    backstop record --model ollama/qwen2.5:7b-instruct --prompt 2   # real model → cassettes
    backstop eval-matchers · backstop ingest <csv> · backstop serve
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date

import typer

from backstop.config import get_settings
from backstop.db import SessionLocal, init_schema

app = typer.Typer(add_completion=False, no_args_is_help=True)


@app.callback()
def _invocation() -> None:
    """Every audit row one CLI invocation writes shares a correlation id."""
    import uuid

    from backstop.logging_setup import request_id_var

    request_id_var.set(f"cli-{uuid.uuid4().hex[:12]}")

# Provider notes and stats contain "≈", "→" and "—"; a Windows console defaults to cp1252
# and would crash on them. Output is UTF-8, with replacement rather than failure.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


@app.command()
def seed(rules_only: bool = False) -> None:
    """Load rules, contracts, workflow, models, corpus and the artifact inventory (idempotent)."""
    from backstop.core.rules_loader import RuleCorpusError, load_rules
    from backstop.harness import corpus as cp
    from backstop.harness import runner
    from backstop.scanner.service import load_inventory

    settings = get_settings()
    init_schema()
    with SessionLocal() as session:
        try:
            report = load_rules(session, settings.rules_dir, actor="system:rules-loader")
        except RuleCorpusError as exc:
            # The loader refuses history edited in place — by design. A database seeded
            # from older rule text needs a reset, not a traceback.
            typer.echo(f"rule corpus refused: {exc}", err=True)
            typer.echo("This database was seeded from different rule text. Reset it: "
                       "scripts/demo-up.ps1 -Fresh (or docker compose down -v), or delete backstop.db.", err=True)
            raise typer.Exit(code=1) from exc
        typer.echo(f"rules: +{report.rules_created} rules, +{report.versions_created} versions, {report.unchanged} unchanged")
        if rules_only:
            return
        runner.seed_models(session)
        runner.seed_workflow(session)
        contracts = runner.seed_contracts(session, settings.contracts_dir)
        chash = runner.seed_corpus(session)
        runner.seed_corpus(session, seed=cp.HOLDOUT_SEED, prefix=cp.HOLDOUT_PREFIX)
        assets = load_inventory(session, settings.fixtures_dir)
        session.commit()
        typer.echo(f"contracts: {len(contracts)} · corpus hash {chash[:16]} · artifacts: {len(assets)}")


@app.command()
def scan(live: bool = False, as_of: str | None = None, key: str | None = None, llm: bool = False) -> None:
    """Scan the artifact inventory and evaluate staleness. --llm adds span-verified model proposals (needs a key)."""
    from backstop.scanner.service import run_scan

    settings = get_settings()
    if live:
        settings.crawler_live = True
    init_schema()
    with SessionLocal() as session:
        outcome = run_scan(
            session, settings,
            idempotency_key=key or (f"cli:{date.today().isoformat()}:{as_of or 'today'}:"
                                    f"{'live' if live else 'snapshot'}{':llm' if llm else ''}"),
            live=live, as_of=date.fromisoformat(as_of) if as_of else None, actor="system:scanner", use_llm=llm,
        )
        typer.echo(("DEDUPLICATED " if outcome.deduplicated else "") + json.dumps(outcome.scan.stats, indent=2))


@app.command()
def run(prompt: int = 2, model: str = "sim-large", rule_date: str = "2026-10-01", adapter: str | None = None,
        trigger: str = "MANUAL", limit: int | None = None, gate: bool = False, corpus: str = "synthetic",
        judge_model: str | None = None, judge_n: int | None = None) -> None:
    """Execute the harness once. With --gate, exit 1 when the gate is RED (for CI).

    --adapter simulated|cassette|live · --corpus synthetic|holdout|ingested|all ·
    --judge-model <provider/model> (default: the run's model) · --judge-n 3 to spare free-tier quotas.
    """
    from backstop.harness.runner import execute_run

    settings = get_settings()
    init_schema()
    with SessionLocal() as session:
        try:
            outcome = execute_run(
                session, settings, workflow_code="qa-handoff", prompt_version=prompt, model_id=model,
                adapter_kind=adapter, rule_date=date.fromisoformat(rule_date), trigger=trigger, limit=limit,
                actor="system:runner", corpus=corpus, judge_model_id=judge_model, judge_n=judge_n,
            )
        except ValueError as exc:  # bad model / prompt / corpus / adapter: say so in one line
            typer.echo(f"run refused: {exc}", err=True)
            raise typer.Exit(code=2) from exc
        r = outcome.run
        typer.echo(f"run {r.id} {'(deduplicated) ' if outcome.deduplicated else ''}gate={r.gate} status={r.status}")
        typer.echo(json.dumps(r.stats.get("contracts", {}), indent=2))
        if gate and r.gate == "RED":
            raise typer.Exit(code=1)


@app.command()
def demo() -> None:
    """Seed, scan, and execute the demo's runs: four simulated acts, five recorded real-model replays, and two held-out replays.

    Then seed two labelled example test cases (one approved, one pending). Idempotent: a
    second invocation reuses every run and creates nothing new.
    """
    from backstop.harness.runner import execute_run
    from backstop.scanner.service import run_scan
    from backstop.scanner.sources import check_sources as _check_sources

    settings = get_settings()
    seed()
    with SessionLocal() as session:
        run_scan(session, settings, idempotency_key="demo:scan", live=False, as_of=date(2026, 10, 1), actor="system:scanner")
        _check_sources(session, settings, live=False, actor="system:source-watch")
        plan = [
            (1, "sim-large", date(2026, 9, 30), "MANUAL"),
            (1, "sim-large", date(2026, 10, 1), "RULE"),
            (2, "sim-large", date(2026, 10, 1), "PROMPT"),
            (2, "sim-small", date(2026, 10, 1), "MODEL"),
        ]
        for prompt, model, rd, trigger in plan:
            outcome = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=prompt, model_id=model,
                                  adapter_kind="simulated", rule_date=rd, trigger=trigger, actor="system:runner",
                                  reuse_pre_override_run=True)
            typer.echo(f"v{prompt} {model} {rd} [{trigger}] → {outcome.run.gate} "
                       f"{json.dumps(outcome.run.stats.get('contracts', {}))}")

        # Real models: replay every recorded cassette set (no GPU, no network needed).
        from sqlalchemy import select as _select

        from backstop.models import Model as _Model
        from backstop.models import PromptVersion as _PV

        cassette_root = settings.fixtures_dir / "cassettes"
        if cassette_root.exists():
            by_hash = {p.prompt_hash: p.version for p in session.scalars(_select(_PV)).all()}
            safe_ids = {re.sub(r"[^A-Za-z0-9._-]+", "_", m.model_id): m.model_id
                        for m in session.scalars(_select(_Model)).all()}
            # Replay order is the story order. Prompt versions ascend, so a model's first run is
            # the MODEL swap and its later prompt is the PROMPT change; within a prompt, the
            # strongest local model comes before the smallest, so the home page's MODEL card
            # compares 7B → 3B; a cross-judged set runs before the self-judged one so the
            # self-judged run is the one the cards pick up.
            preferred = ["ollama/llama3.1:8b", "ollama/qwen2.5:7b-instruct", "ollama/qwen2.5:3b-instruct"]
            replayed: dict[str, int] = {}
            prompt_dirs = sorted((d for d in cassette_root.iterdir() if d.name in by_hash), key=lambda d: by_hash[d.name])
            for prompt_dir in prompt_dirs:
                version = by_hash[prompt_dir.name]
                model_dirs = sorted(
                    (d for d in prompt_dir.iterdir() if d.is_dir()),
                    key=lambda d: (preferred.index(safe_ids[d.name]) if safe_ids.get(d.name) in preferred else -1, d.name),
                )
                for model_dir in model_dirs:
                    model_id = safe_ids.get(model_dir.name)
                    if model_id is None or not any(model_dir.glob("*.generate.json")):
                        continue
                    trigger = "PROMPT" if model_id in replayed and replayed[model_id] != version else "MODEL"
                    replayed[model_id] = version
                    # One run per other judge the model was recorded with ("T001.judge@<safe judge
                    # id>.json") — the "judge has the disease" comparison — then judged by itself.
                    judges: list[str | None] = []
                    for judge_safe in sorted({f.name.split(".judge@", 1)[1][:-5] for f in model_dir.glob("*.judge@*.json")}):
                        if judge_safe in safe_ids:
                            judges.append(safe_ids[judge_safe])
                    judges.append(None)
                    for judge_model_id in judges:
                        outcome = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=version,
                                              model_id=model_id, adapter_kind="cassette", rule_date=date(2026, 10, 1),
                                              trigger=trigger, actor="system:runner", judge_model_id=judge_model_id,
                                              reuse_pre_override_run=True)
                        judged = f", judge={judge_model_id}" if judge_model_id else ""
                        typer.echo(f"v{version} {model_id} 2026-10-01 [{trigger}, cassette{judged}] → {outcome.run.gate} "
                                   f"errors={outcome.run.stats.get('adapter_errors')} "
                                   f"{json.dumps(outcome.run.stats.get('contracts', {}))}")
                    # Held-out calls (H001-H060), recorded after the prompt was written. MANUAL
                    # trigger: they are an honesty check, not one of the home page's three acts.
                    if any(model_dir.glob("H0*.generate.json")):
                        outcome = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=version,
                                              model_id=model_id, adapter_kind="cassette", rule_date=date(2026, 10, 1),
                                              trigger="MANUAL", actor="system:runner", corpus="holdout",
                                              reuse_pre_override_run=True)
                        typer.echo(f"v{version} {model_id} 2026-10-01 [HELD-OUT, cassette] → {outcome.run.gate} "
                                   f"errors={outcome.run.stats.get('adapter_errors')} "
                                   f"{json.dumps(outcome.run.stats.get('contracts', {}))}")

        # Last, after every run above has its numbers: two labelled example test cases so the
        # Test cases page shows the override → approval loop. Nothing above is re-scored.
        from backstop.harness.demo_examples import seed_example_test_cases

        for ex in seed_example_test_cases(session):
            typer.echo(f"seeded example test case: {ex['contract']} on {ex['transcript']} "
                       f"{ex['status']}{'' if ex['created'] else ' (already present)'}")


@app.command()
def record(model: str = "ollama/qwen2.5:7b-instruct", prompt: int = 2, rule_date: str = "2026-10-01",
           limit: int | None = None, trigger: str = "MANUAL", judge_model: str | None = None,
           judge_n: int | None = None, corpus: str = "synthetic") -> None:
    """Run a real model through the cassette adapter: outputs are recorded under fixtures/cassettes and replayed offline afterwards.

    Works with any configured provider: ollama/<model> (local, free), groq/<model>,
    gemini/<model>, openrouter/<model> (free tiers; set the provider's API key), claude-* (paid).
    """
    from backstop.harness.runner import execute_run

    settings = get_settings()
    init_schema()
    with SessionLocal() as session:
        try:
            outcome = execute_run(session, settings, workflow_code="qa-handoff", prompt_version=prompt, model_id=model,
                                  adapter_kind="cassette", rule_date=date.fromisoformat(rule_date), trigger=trigger,
                                  limit=limit, actor="system:model-eval", judge_model_id=judge_model, judge_n=judge_n,
                                  corpus=corpus, record=True)
        except ValueError as exc:
            typer.echo(f"record refused: {exc}", err=True)
            raise typer.Exit(code=2) from exc
        r = outcome.run
        typer.echo(f"run {r.id} {'(deduplicated) ' if outcome.deduplicated else ''}gate={r.gate} status={r.status}")
        typer.echo(json.dumps({k: v for k, v in r.stats.items() if k in ("contracts", "adapter_errors", "cost")}, indent=2))


@app.command()
def providers() -> None:
    """Show which model providers are configured (keys / local Ollama) and their free-tier notes."""
    from backstop.harness import providers as pv
    from backstop.harness.openai_compat import probe_ollama

    for name, p in pv.PROVIDERS.items():
        ok = probe_ollama(p.base_url)["reachable"] if name == "ollama" else p.available()
        typer.echo(f"{name:11} {'READY' if ok else 'not configured':15} {p.notes}")
        for m in pv.MODELS:
            if m.provider == name:
                typer.echo(f"             - {m.model_id}  ({m.tier})")


@app.command(name="eval-matchers")
def eval_matchers(write: bool = True) -> None:
    """Evaluate the deterministic matchers against fixtures/matcher_golden.yaml; write docs/eval-report.md."""
    from backstop.config import REPO_ROOT
    from backstop.scanner import evaluate as ev

    settings = get_settings()
    golden = settings.fixtures_dir / "matcher_golden.yaml"
    report = ev.evaluate(golden)
    summary = report.to_dict()["summary"]
    typer.echo(json.dumps(summary))
    if write:
        out = REPO_ROOT / "docs" / "eval-report.md"
        out.write_text(ev.render_markdown(report, golden), encoding="utf-8")
        typer.echo(f"wrote {out}")


@app.command(name="check-sources")
def check_sources(live: bool = False) -> None:
    """Hash each rule's primary source page; open a RULE_SOURCE_CHANGED task when it changes."""
    from backstop.scanner.sources import check_sources as _check

    settings = get_settings()
    if live:
        settings.crawler_live = True
    init_schema()
    with SessionLocal() as session:
        typer.echo(json.dumps(_check(session, settings, live=live, actor="system:source-watch"), indent=2))


@app.command()
def ingest(path: str, fmt: str = "attention-snowflake") -> None:
    """Load transcripts from an export CSV (shape documented in fixtures/attention_export_sample.csv)."""
    from pathlib import Path

    from backstop.harness.ingest import ingest_csv

    init_schema()
    with SessionLocal() as session:
        typer.echo(json.dumps(ingest_csv(session, Path(path).read_text(encoding="utf-8"), fmt=fmt, actor="system:ingest"), indent=2))


@app.command()
def serve(host: str = "127.0.0.1", port: int = 8000, reload: bool = False) -> None:
    import uvicorn

    uvicorn.run("backstop.main:app", host=host, port=port, reload=reload)


if __name__ == "__main__":
    app()
