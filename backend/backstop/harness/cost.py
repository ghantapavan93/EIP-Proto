"""Cost model per run, in the vocabulary the floor uses (per call, per day, per AEP).

Prices are list prices per million tokens and are configuration, not fact —
they live here so a reviewer can change them and see the projection move.
Simulated runs cost $0 and say so. Token counts come from the adapter's usage
when a live model ran; otherwise an estimate from transcript length is used
and labeled as such.
"""

from __future__ import annotations

from typing import Any

# USD per 1M tokens (input, output). Placeholder list prices; update from the vendor's page.
PRICES: dict[str, tuple[float, float]] = {
    "claude-sonnet-5": (3.00, 15.00),
    "claude-haiku-4-5-20251001": (1.00, 5.00),
}

# Rough shape of one qa-handoff call when token usage is not reported.
EST_INPUT_TOKENS_PER_TRANSCRIPT = 1400   # prompt + transcript
EST_OUTPUT_TOKENS_PER_TRANSCRIPT = 450   # structured record + summary + coaching note
EST_JUDGE_INPUT_TOKENS = 260
EST_JUDGE_OUTPUT_TOKENS = 4

# Volume assumptions for projections (declared, not measured; EIP's real numbers are unknown).
ASSUMED_CALLS_PER_DAY = 3000
AEP_DAYS = 54


def estimate(model_id: str, adapter: str, transcripts: int, usage_in: int, usage_out: int,
             *, judged_calls: int = 0) -> dict[str, Any]:
    from backstop.harness.providers import spec_for

    if adapter == "simulated":
        return {"usd": 0.0, "basis": "simulated adapter — no model calls", "per_call_usd": 0.0,
                "projection": {"calls_per_day": ASSUMED_CALLS_PER_DAY, "usd_per_day": 0.0, "usd_per_aep": 0.0,
                               "note": "simulated runs are free; volume is an assumption for scale, not EIP's number"}}
    spec = spec_for(model_id)
    if spec is not None and spec.tier in ("local", "free-tier"):
        measured = usage_in > 0 or usage_out > 0
        how = "local GPU — no API spend" if spec.tier == "local" else "hosted free tier — rate-limited, $0"
        return {
            "usd": 0.0, "per_call_usd": 0.0, "input_tokens": usage_in, "output_tokens": usage_out,
            "basis": f"{how}" + ("; token usage measured" if measured else ""),
            "projection": {"calls_per_day": ASSUMED_CALLS_PER_DAY, "usd_per_day": 0.0, "usd_per_aep": 0.0,
                           "note": ("free tiers cap requests per day — production volume needs a paid tier or a local host"
                                    if spec.tier == "free-tier" else
                                    "local inference scales with GPU count, not per-token price")},
        }
    priced = model_id in PRICES
    # An unknown model gets a visible placeholder price, never a silent one.
    price_in, price_out = PRICES.get(model_id, (3.00, 15.00))
    measured = usage_in > 0 or usage_out > 0
    if not measured:
        usage_in = transcripts * EST_INPUT_TOKENS_PER_TRANSCRIPT + judged_calls * EST_JUDGE_INPUT_TOKENS
        usage_out = transcripts * EST_OUTPUT_TOKENS_PER_TRANSCRIPT + judged_calls * EST_JUDGE_OUTPUT_TOKENS
    usd = usage_in / 1e6 * price_in + usage_out / 1e6 * price_out
    per_call = usd / max(1, transcripts)
    return {
        "usd": round(usd, 4),
        "per_call_usd": round(per_call, 5),
        "input_tokens": usage_in,
        "output_tokens": usage_out,
        "basis": ("measured token usage" if measured else "estimated from transcript count (usage not reported)")
                 + (f"; list prices ${price_in}/M in, ${price_out}/M out" if priced else
                    f"; UNPRICED model — placeholder ${price_in}/M in, ${price_out}/M out, not a quote"),
        "priced": priced,
        "projection": {
            "calls_per_day": ASSUMED_CALLS_PER_DAY,
            "usd_per_day": round(per_call * ASSUMED_CALLS_PER_DAY, 2),
            "usd_per_aep": round(per_call * ASSUMED_CALLS_PER_DAY * AEP_DAYS, 2),
            "note": "volume is an assumption for scale, not EIP's number",
        },
    }
