"""Model providers reachable through the OpenAI-compatible chat-completions protocol.

One adapter, many vendors — that is the vendor-independence claim in code.
Free options first: a local Ollama model (no key, no data leaves the machine),
then hosted free tiers (Groq, Google AI Studio, OpenRouter). Each provider
carries the rate limit its free tier publishes so the adapter can pace itself
instead of tripping 429s.

Model ids are "<provider>/<model name>"; the provider prefix picks the base URL
and the key. Limits and prices below are configuration, not facts — check the
provider's page before quoting them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Provider:
    name: str
    base_url: str
    key_env: str | None            # None = no key needed
    rpm: int                       # requests per minute the adapter paces to (0 = no pacing)
    rpd: int | None                # published requests per day on the free tier (informational)
    notes: str
    extra_headers: dict[str, str] = field(default_factory=dict)
    # May this provider receive REAL (ingested, non-synthetic) transcripts? Only a model
    # running on this machine may. Hosted free tiers log and may train on inputs.
    real_data_allowed: bool = False

    def api_key(self) -> str | None:
        if self.key_env is None:
            return "local"
        return os.environ.get(self.key_env) or None

    def available(self) -> bool:
        return self.api_key() is not None


PROVIDERS: dict[str, Provider] = {
    "ollama": Provider(
        name="ollama",
        base_url=os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1"),
        key_env=None,
        rpm=0,
        rpd=None,
        notes="Local models on this machine. $0, offline, nothing leaves the laptop. Quality depends on the model you pull.",
        real_data_allowed=True,
    ),
    "groq": Provider(
        name="groq",
        base_url="https://api.groq.com/openai/v1",
        key_env="GROQ_API_KEY",
        rpm=28,
        rpd=1000,
        notes="Free tier (console.groq.com). Llama 3.3 70B ≈ 30 RPM / 1K RPD / 100K tokens per day; Llama 3.1 8B ≈ 30 RPM / 14.4K RPD / 500K TPD. Very fast.",
    ),
    "gemini": Provider(
        name="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        key_env="GEMINI_API_KEY",
        rpm=9,
        rpd=250,
        notes="Google AI Studio free tier (aistudio.google.com). Gemini 2.5 Flash ≈ 10 RPM / 250 RPD; Flash-Lite ≈ 15 RPM / 1000 RPD. Strong structured output.",
    ),
    "openrouter": Provider(
        name="openrouter",
        base_url="https://openrouter.ai/api/v1",
        key_env="OPENROUTER_API_KEY",
        rpm=18,
        rpd=50,
        notes="Free ':free' models (openrouter.ai). ≈ 20 RPM and 50 requests/day without credits — samples only.",
        extra_headers={"HTTP-Referer": "https://github.com/ghantapavan93/EIP-Proto", "X-Title": "Backstop"},
    ),
}


@dataclass(frozen=True)
class ModelSpec:
    model_id: str          # "<provider>/<name>"
    label: str
    tier: str              # local | free-tier | paid
    supports_tools: bool
    price_in: float        # USD per 1M tokens if paid; 0 for free tier / local
    price_out: float
    notes: str = ""

    @property
    def provider(self) -> str:
        return self.model_id.split("/", 1)[0]

    @property
    def name(self) -> str:
        return self.model_id.split("/", 1)[1]


MODELS: list[ModelSpec] = [
    ModelSpec("ollama/qwen2.5:7b-instruct", "Qwen2.5 7B — local (Ollama, RTX 3060)", "local", True, 0, 0,
              "Runs on this laptop's GPU. The honest baseline for 'no API spend'."),
    ModelSpec("ollama/qwen2.5:3b-instruct", "Qwen2.5 3B — local (Ollama)", "local", True, 0, 0,
              "Small local model; expect grounding defects — measured, not simulated."),
    ModelSpec("ollama/llama3.1:8b", "Llama 3.1 8B — local (Ollama)", "local", True, 0, 0,
              "A different model family at the same size: the vendor-swap case, on this laptop."),
    ModelSpec("groq/llama-3.3-70b-versatile", "Llama 3.3 70B — Groq free tier", "free-tier", True, 0, 0,
              "≈100K tokens/day free: enough for one 20-transcript run + judge per day."),
    ModelSpec("groq/llama-3.1-8b-instant", "Llama 3.1 8B — Groq free tier", "free-tier", True, 0, 0,
              "≈500K tokens/day free: a full 60-transcript run fits."),
    ModelSpec("gemini/gemini-2.5-flash", "Gemini 2.5 Flash — AI Studio free tier", "free-tier", True, 0, 0,
              "≈250 requests/day free; use --limit 30 and judge N=3."),
    ModelSpec("gemini/gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite — AI Studio free tier", "free-tier", True, 0, 0,
              "≈1000 requests/day free; good judge model."),
    ModelSpec("openrouter/google/gemma-3-27b-it:free", "Gemma 3 27B — OpenRouter free", "free-tier", False, 0, 0,
              "50 requests/day without credits; JSON mode, no tool calls."),
]


def spec_for(model_id: str) -> ModelSpec | None:
    return next((m for m in MODELS if m.model_id == model_id), None)


def provider_for(model_id: str) -> Provider | None:
    return PROVIDERS.get(model_id.split("/", 1)[0])


def availability() -> dict[str, bool]:
    """Which providers have a key (or, for Ollama, are configured). Ollama reachability is probed elsewhere."""
    return {name: p.available() for name, p in PROVIDERS.items()}


# Anthropic may receive real transcripts only when the operator says so explicitly
# (a BAA / data-processing agreement is in place). Off by default.
ANTHROPIC_REAL_DATA_ENV = "BACKSTOP_ALLOW_ANTHROPIC_REAL_DATA"


def real_data_refusal(model_id: str) -> str | None:
    """None when ``model_id`` may receive real (ingested) transcripts, else the reason it may not.

    Allowed: local Ollama models; Anthropic models when BACKSTOP_ALLOW_ANTHROPIC_REAL_DATA=1.
    Refused: hosted free tiers (Groq, Gemini AI Studio, OpenRouter) and anything unknown.
    """
    if model_id.startswith("claude-") or model_id.startswith("anthropic/"):
        if os.environ.get(ANTHROPIC_REAL_DATA_ENV, "").strip().lower() in ("1", "true", "yes"):
            return None
        return (f"real transcripts may not be sent to {model_id}: Anthropic is allowed only when "
                f"{ANTHROPIC_REAL_DATA_ENV}=1 is configured (a BAA / data agreement is in place)")
    provider = provider_for(model_id)
    if provider is not None and provider.real_data_allowed:
        return None
    where = f"the hosted '{provider.name}' free tier" if provider is not None else "an unknown provider"
    return (f"real transcripts may not be sent to {model_id} ({where}); ingested calls may only go to a "
            f"local Ollama model, or to Anthropic with {ANTHROPIC_REAL_DATA_ENV}=1")
