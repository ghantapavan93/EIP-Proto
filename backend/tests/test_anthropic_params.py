"""Temperature reaches only the Anthropic models that still accept it.

Opus 4.7 and later reject the parameter and Claude Sonnet 5 rejects a non-default value,
so sending it there turns every call into a 400; the older models honour it.
"""

from __future__ import annotations

from backstop.harness.anthropic_params import applied_temperature, sampling


def test_older_models_get_the_temperature_raw():
    assert sampling("claude-haiku-4-5-20251001", 0.0) == {"extra_body": {"temperature": 0.0}}
    assert sampling("claude-sonnet-4-6", 1.0) == {"extra_body": {"temperature": 1.0}}
    assert applied_temperature("claude-haiku-4-5-20251001", 0.0) == 0.0


def test_models_that_reject_it_run_at_their_default():
    for model in ("claude-sonnet-5", "claude-opus-5", "claude-opus-4-7", "claude-fable-5-1", "claude-future-9"):
        assert sampling(model, 0.0) == {}, model
        assert applied_temperature(model, 0.0) == "model default"
