"""Sampling parameters for Anthropic models that still accept them.

The anthropic 1.x SDK removed `temperature` from `messages.create()`, and newer models
reject it on the wire: Opus 4.7 and later refuse any value, and Claude Sonnet 5 refuses a
non-default one. Older models still honour it. The setting is therefore sent raw
(`extra_body`) only to models documented to accept it; every other model runs at its own
default, and the run records which one applied.
"""

from __future__ import annotations

from typing import Any

# Model families that accept `temperature`. Anything not listed (including future models)
# gets no sampling parameter: sending one to a model that rejects it is a 400.
ACCEPTS_TEMPERATURE: tuple[str, ...] = (
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-opus-4-6",
)


def accepts_temperature(model_id: str) -> bool:
    return model_id.startswith(ACCEPTS_TEMPERATURE)


def sampling(model_id: str, temperature: float) -> dict[str, Any]:
    """Keyword arguments for `messages.create()`: the temperature when the model takes one, else none."""
    return {"extra_body": {"temperature": temperature}} if accepts_temperature(model_id) else {}


def applied_temperature(model_id: str, temperature: float) -> float | str:
    """What to record for a run: the value sent, or that the model's default applied."""
    return temperature if accepts_temperature(model_id) else "model default"
