"""Judge canary: re-judge fixed notes each run to separate judge drift from workflow drift."""

from __future__ import annotations

import math
import statistics
from pathlib import Path
from typing import Any

import yaml


def load_canary(fixtures_dir: Path) -> list[dict[str, Any]]:
    doc = yaml.safe_load((fixtures_dir / "judge_canary.yaml").read_text(encoding="utf-8"))
    return list(doc["notes"])


def run_canary(adapter: Any, rubric: str, notes: list[dict[str, Any]], n: int) -> dict[str, Any]:
    """Judge every canary note N times. Returns per-note stats and an overall stability verdict."""
    results = []
    out_of_band = 0
    for note in notes:
        scores, meta = adapter.judge(rubric, note["text"].strip(), "", f"canary:{note['id']}", n)
        clean = [s for s in scores if not (isinstance(s, float) and math.isnan(s))]
        if not clean:
            results.append({"id": note["id"], "band": note["band"], "error": "no scores", "meta": meta})
            continue
        mean = statistics.fmean(clean)
        variance = statistics.pvariance(clean) if len(clean) > 1 else 0.0
        lo, hi = note["band"]
        inside = lo <= mean <= hi
        if not inside:
            out_of_band += 1
        results.append({
            "id": note["id"], "band": note["band"], "scores": clean, "mean": round(mean, 2),
            "variance": round(variance, 3), "in_band": inside,
        })
    judged = [r for r in results if "mean" in r]
    return {
        "notes": results,
        "n_per_note": n,
        "out_of_band": out_of_band,
        "mean_variance": round(statistics.fmean([r["variance"] for r in judged]), 3) if judged else None,
        "stable": out_of_band == 0,
        "note": "canary means outside their bands indicate JUDGE drift; compare across runs before trusting a judged flag",
    }
