"""OpenAI-compatible adapter: tool path, JSON fallback, retry on 429, usage accounting, judge parsing.

Uses httpx.MockTransport — no network, no keys.
"""

from __future__ import annotations

import json

import httpx
import pytest

from backstop.harness import openai_compat as oc
from backstop.harness.providers import PROVIDERS, provider_for, spec_for


def _adapter(handler, model_id="ollama/qwen2.5:7b-instruct", **kw) -> oc.OpenAICompatibleAdapter:
    adapter = oc.OpenAICompatibleAdapter(model_id, **kw)
    provider = provider_for(model_id)
    adapter.client = httpx.Client(base_url=provider.base_url.rstrip("/") + "/", transport=httpx.MockTransport(handler))
    adapter.judge_client = adapter.client  # same provider in these tests; the cross-provider test builds its own
    oc._PACERS.clear()
    return adapter


GOOD = {"extraction": {"product_line": "MA", "disclaimer_delivered": True, "disclaimer_compliant": True,
                       "soa_collected": True, "appointment_scheduled": True, "soa_wait_compliant": True},
        "composition": {"summary": "s", "coaching_note": "c", "crm_record": {}}}


def _completion(*, tool_args=None, content=None, usage=(100, 20)):
    message = {"role": "assistant", "content": content}
    if tool_args is not None:
        message["tool_calls"] = [{"id": "c1", "type": "function",
                                  "function": {"name": "record_qa", "arguments": json.dumps(tool_args)}}]
    return {"choices": [{"message": message}], "usage": {"prompt_tokens": usage[0], "completion_tokens": usage[1]},
            "model": "qwen2.5:7b-instruct"}


def test_tool_call_path_returns_arguments_and_usage():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["tool_choice"]["function"]["name"] == "record_qa"
        assert "<transcript>" in body["messages"][1]["content"]
        return httpx.Response(200, json=_completion(tool_args=GOOD))

    result = _adapter(handler).generate("prompt", "AGENT: hi", "T001", {}, {})
    assert result.error is None
    assert result.raw["extraction"]["product_line"] == "MA"
    assert result.usage["input_tokens"] == 100 and result.usage["mode"] == "tool"


def test_prose_answer_falls_back_to_json_mode():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append("json" if body.get("response_format") else "tool")
        if body.get("response_format"):
            return httpx.Response(200, json=_completion(content="Here you go: " + json.dumps(GOOD)))
        return httpx.Response(200, json=_completion(content="The call was fine."))

    result = _adapter(handler).generate("prompt", "AGENT: hi", "T001", {}, {})
    assert calls == ["tool", "json"]
    assert result.error is None and result.usage["mode"] == "json"
    assert result.usage["attempts"] == ["tool:unparsed", "json"]
    assert result.usage["input_tokens"] == 200  # both attempts are paid for and counted


def test_models_without_tool_support_go_straight_to_json_mode():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body.get("response_format", {}).get("type"))
        assert "tools" not in body
        return httpx.Response(200, json=_completion(content=json.dumps(GOOD)))

    import os

    assert "openrouter" in PROVIDERS
    os.environ["OPENROUTER_API_KEY"] = "test"
    try:
        adapter = _adapter(handler, model_id="openrouter/google/gemma-3-27b-it:free")
        assert spec_for("openrouter/google/gemma-3-27b-it:free").supports_tools is False
        result = adapter.generate("prompt", "AGENT: hi", "T001", {}, {})
    finally:
        os.environ.pop("OPENROUTER_API_KEY", None)
    assert calls == ["json_object"] and result.error is None


def test_429_is_retried_with_retry_after_then_succeeds():
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        if attempts["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, json={"error": "rate limited"})
        return httpx.Response(200, json=_completion(tool_args=GOOD))

    result = _adapter(handler).generate("prompt", "AGENT: hi", "T001", {}, {})
    assert attempts["n"] == 2 and result.error is None


def test_hard_failures_become_adapter_errors_not_exceptions():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "bad key"})

    result = _adapter(handler).generate("prompt", "AGENT: hi", "T001", {}, {})
    assert result.error is not None and "401" in result.error and result.raw == {}


def test_judge_parses_numbers_and_survives_bad_replies():
    replies = iter(["4", "3.5", "I think five", "2"])

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["temperature"] == 1.0
        return httpx.Response(200, json=_completion(content=next(replies)))

    import math

    scores, meta = _adapter(handler).judge("rubric", "note", "", "canary:x", 4)
    assert scores[:2] == [4.0, 3.5] and math.isnan(scores[2]) and scores[3] == 2.0
    assert meta["judge_model"] == "ollama/qwen2.5:7b-instruct"


def test_unconfigured_provider_is_refused_clearly(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(ValueError, match="GROQ_API_KEY"):
        oc.OpenAICompatibleAdapter("groq/llama-3.1-8b-instant")


FLAT = {"disclaimer_delivered": True, "disclaimer_compliant": True, "product_line": "PDP"}  # what qwen2.5's
# chat template makes of a nested tool schema on Ollama: one shallow object, no sections


def test_flattened_tool_call_is_retried_in_json_mode_then_tool_mode_is_disabled():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append("json" if body.get("response_format") else "tool")
        if body.get("response_format"):
            return httpx.Response(200, json=_completion(content=json.dumps(GOOD)))
        return httpx.Response(200, json=_completion(tool_args=FLAT))

    adapter = _adapter(handler)
    first = adapter.generate("prompt", "AGENT: hi", "T001", {}, {})
    assert first.error is None and first.raw == GOOD
    assert first.usage["attempts"] == ["tool:flat", "json"] and first.usage["mode"] == "json"
    assert "tool_mode" not in first.usage  # one flat answer is not yet a pattern

    second = adapter.generate("prompt", "AGENT: hi", "T002", {}, {})
    assert second.usage["attempts"] == ["tool:flat", "json"]
    assert second.usage["tool_mode"].startswith("disabled")

    third = adapter.generate("prompt", "AGENT: hi", "T003", {}, {})
    assert third.usage["attempts"] == ["json"]  # no more doomed tool attempts on this run
    assert calls == ["tool", "json", "tool", "json", "json"]


def test_flat_output_in_both_modes_is_returned_for_the_schema_contract_to_judge():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if body.get("response_format"):
            return httpx.Response(200, json=_completion(content=json.dumps(FLAT)))
        return httpx.Response(200, json=_completion(tool_args=FLAT))

    result = _adapter(handler).generate("prompt", "AGENT: hi", "T001", {}, {})
    # The adapter neither repairs nor hides the model's answer: the flat object is returned
    # without an adapter error, so C-SCHEMA-01 fails it as a model defect, on the record.
    assert result.raw == FLAT and result.error is None
    assert result.usage["attempts"] == ["tool:flat", "json:flat"]


def test_judge_at_another_provider_uses_its_own_client_and_key(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "groq-test")
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-test")
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers["authorization"]))
        body = json.loads(request.content)
        if "tools" in body:
            return httpx.Response(200, json=_completion(tool_args=GOOD))
        return httpx.Response(200, json=_completion(content="4"))

    adapter = oc.OpenAICompatibleAdapter("groq/llama-3.1-8b-instant", judge_model_id="gemini/gemini-2.5-flash-lite")
    for attr in ("client", "judge_client"):
        base = getattr(adapter, attr).base_url
        headers = dict(getattr(adapter, attr).headers)
        setattr(adapter, attr, httpx.Client(base_url=base, headers=headers, transport=httpx.MockTransport(handler)))
    oc._PACERS.clear()

    assert adapter.generate("prompt", "AGENT: hi", "T001", {}, {}).error is None
    scores, meta = adapter.judge("rubric", "note", "", "T001", 1)
    assert scores == [4.0] and meta["provider"] == "gemini"
    assert seen[0] == ("api.groq.com", "Bearer groq-test")
    assert seen[-1][0] == "generativelanguage.googleapis.com" and seen[-1][1] == "Bearer gemini-test"


def test_judge_provider_without_a_key_is_refused_up_front(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "groq-test")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        oc.OpenAICompatibleAdapter("groq/llama-3.1-8b-instant", judge_model_id="gemini/gemini-2.5-flash-lite")
