"""Service metadata: liveness, build and provider information, and the caller's identity.

    GET /api/health   liveness probe (no auth)
    GET /api/meta     version, adapters, provider readiness, synthetic-data notice
    GET /api/me       the caller's role and what that role may do
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from backstop import __version__
from backstop import schemas as s
from backstop.api.deps import SettingsDep, UserDep

router = APIRouter(tags=["meta"])


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/meta", response_model=s.MetaOut)
def meta(settings: SettingsDep, user: UserDep):
    from backstop.harness import providers as pv
    from backstop.harness.openai_compat import probe_ollama_cached as probe_ollama

    provider_info: dict[str, dict] = {}
    for name, provider in pv.PROVIDERS.items():
        available = provider.available()
        info: dict = {"available": available, "notes": provider.notes, "rpm": provider.rpm, "rpd": provider.rpd,
                      "models": [m.model_id for m in pv.MODELS if m.provider == name]}
        if name == "ollama":
            probe = probe_ollama(provider.base_url)
            info["available"] = probe["reachable"]
            info["local_models"] = probe["models"]
        provider_info[name] = info
    provider_info["anthropic"] = {"available": bool(settings.anthropic_api_key), "notes": "Paid API; ANTHROPIC_API_KEY.",
                                  "models": ["claude-sonnet-5", "claude-haiku-4-5-20251001"]}
    any_live = any(p["available"] for p in provider_info.values())
    return s.MetaOut(
        version=__version__,
        environment_label=settings.environment_label,
        adapters={"simulated": True, "cassette": True, "live": any_live, "anthropic": bool(settings.anthropic_api_key)},
        providers=provider_info,
        default_adapter=settings.default_adapter,
        synthetic_notice=(
            "All call transcripts and internal artifacts are synthetic. Public web pages are real, "
            "fetched read-only and attributed. Simulated model runs use declared defect profiles; "
            "cassette runs replay recorded model output; live runs use a local Ollama model or a free-tier provider."
        ),
        today=date.today(),
        user=user.name,
        role=user.role,
    )


@router.get("/me", response_model=s.MeOut)
def me(user: UserDep):
    """Who am I, and what may my role do? Derived from the rules the code enforces (core/permissions.py)."""
    from backstop.core import permissions

    return permissions.me(user.name, user.role)
