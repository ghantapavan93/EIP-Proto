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


# ------------------------------------------------------------------ judge replies


def test_judge_scores_are_read_only_from_a_standalone_1_to_5():
    import math

    from backstop.harness.judge_score import parse_judge_score

    assert parse_judge_score("4") == 4.0 and parse_judge_score("Score: 3.5/5") == 3.5
    for reply in ("", "I cannot score this.", "10", "2026 was a good year"):
        assert math.isnan(parse_judge_score(reply)), reply


def test_an_unparseable_anthropic_judge_reply_is_missing_data_not_a_1():
    import math
    from types import SimpleNamespace

    from backstop.harness.adapters import AnthropicAdapter

    replies = iter(["4", "no idea", "10/10"])
    adapter = AnthropicAdapter.__new__(AnthropicAdapter)  # no client construction, no key
    adapter.judge_model_id = "claude-haiku-4-5-20251001"
    adapter.client = SimpleNamespace(messages=SimpleNamespace(
        create=lambda **_: SimpleNamespace(content=[SimpleNamespace(text=next(replies))])))
    scores, _ = adapter.judge("rubric", "note", "", "T001", 3)
    assert scores[0] == 4.0 and math.isnan(scores[1]) and math.isnan(scores[2])
