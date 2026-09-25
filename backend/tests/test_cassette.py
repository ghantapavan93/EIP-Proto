"""Cassette adapter: record once from a fallback, replay forever, portable file names."""

from __future__ import annotations

import json
from pathlib import Path

from backstop.harness.adapters import AdapterResult, CassetteAdapter


class _Recorder:
    """Stands in for a live adapter; counts how often it is really called."""

    name = "live"

    def __init__(self):
        self.generate_calls = 0
        self.judge_calls = 0

    def generate(self, prompt_text, transcript_text, transcript_code, labels, logic):
        self.generate_calls += 1
        return AdapterResult(raw={"extraction": {"code": transcript_code}, "composition": {}}, latency_ms=42,
                             usage={"input_tokens": 10, "output_tokens": 5, "mode": "json"})

    def judge(self, rubric, coaching_note, transcript_text, transcript_code, n):
        self.judge_calls += 1
        return [4.0] * n, {"judge_model": "fake"}


def test_record_then_replay_without_the_live_adapter(tmp_path: Path):
    live = _Recorder()
    recording = CassetteAdapter(tmp_path, "abc123", "ollama/qwen2.5:7b-instruct", fallback=live)
    first = recording.generate("p", "t", "T001", {}, {})
    scores, _ = recording.judge("rubric", "note", "", "canary:c1", 3)
    assert first.raw["extraction"]["code"] == "T001" and scores == [4.0, 4.0, 4.0]
    assert live.generate_calls == 1 and live.judge_calls == 1

    model_dir = tmp_path / "abc123" / "ollama_qwen2.5_7b-instruct"
    names = sorted(p.name for p in model_dir.iterdir())
    # ":" never reaches the file system — on NTFS it would silently become an alternate data stream.
    assert names == ["T001.generate.json", "canary_c1.judge.json"]
    assert all(":" not in n for n in names)

    replay = CassetteAdapter(tmp_path, "abc123", "ollama/qwen2.5:7b-instruct", fallback=None)
    again = replay.generate("p", "t", "T001", {}, {})
    assert again.raw == first.raw and again.latency_ms == 42 and again.usage["cassette"] is True
    assert again.usage["recorded_at"]
    scores2, meta2 = replay.judge("rubric", "note", "", "canary:c1", 3)
    assert scores2 == scores and meta2["cassette"] is True
    assert live.generate_calls == 1 and live.judge_calls == 1  # nothing went live on replay


def test_missing_cassette_without_fallback_is_an_adapter_error_not_a_crash(tmp_path: Path):
    replay = CassetteAdapter(tmp_path, "abc123", "ollama/qwen2.5:7b-instruct", fallback=None)
    result = replay.generate("p", "t", "T999", {}, {})
    assert result.raw == {} and "no cassette" in (result.error or "")
    scores, meta = replay.judge("rubric", "note", "", "T999", 5)
    assert scores == [] and "no judge cassette" in meta["error"]


def test_adapter_errors_are_not_recorded(tmp_path: Path):
    class _Broken(_Recorder):
        def generate(self, *a, **k):
            return AdapterResult(raw={}, latency_ms=1, usage={}, error="HTTP 500")

    recording = CassetteAdapter(tmp_path, "abc123", "groq/llama-3.1-8b-instant", fallback=_Broken())
    assert recording.generate("p", "t", "T001", {}, {}).error == "HTTP 500"
    assert not list((tmp_path / "abc123").rglob("*.json")), "a failed call must not poison the cassette set"


def test_cassette_payload_is_plain_json_for_review(tmp_path: Path):
    recording = CassetteAdapter(tmp_path, "abc123", "ollama/qwen2.5:3b-instruct", fallback=_Recorder())
    recording.generate("p", "t", "T002", {}, {})
    payload = json.loads((tmp_path / "abc123" / "ollama_qwen2.5_3b-instruct" / "T002.generate.json").read_text())
    assert set(payload) == {"raw", "latency_ms", "usage", "recorded_at"}


def test_judge_cassettes_are_keyed_by_the_judge_model(tmp_path: Path):
    live = _Recorder()
    own = CassetteAdapter(tmp_path, "abc123", "ollama/qwen2.5:3b-instruct", fallback=live)
    own.judge("rubric", "note", "", "T001", 2)
    cross = CassetteAdapter(tmp_path, "abc123", "ollama/qwen2.5:3b-instruct", fallback=live,
                            judge_model_id="ollama/qwen2.5:7b-instruct")
    cross.judge("rubric", "note", "", "T001", 2)
    names = sorted(p.name for p in (tmp_path / "abc123" / "ollama_qwen2.5_3b-instruct").iterdir())
    assert names == ["T001.judge.json", "T001.judge@ollama_qwen2.5_7b-instruct.json"]
    assert live.judge_calls == 2, "a different judge must not replay the run model's own scores"


def test_cassette_adapter_replays_only_unless_recording(tmp_path: Path, monkeypatch):
    """The UI's "cassette" is replay. A miss must be an adapter error, never a silent live
    call that mislabels the run, blocks the request for minutes and writes into fixtures/."""
    from backstop.harness import adapters as ad

    live = _Recorder()
    monkeypatch.setattr(ad, "_live_adapter", lambda *a, **k: live)
    kwargs = dict(model_id="ollama/qwen2.5:3b-instruct", fixtures_dir=tmp_path, prompt_hash="nocassette", api_key=None)

    replay = ad.build_adapter("cassette", **kwargs)
    result = replay.generate("p", "t", "T001", {}, {})
    assert result.error and "no cassette" in result.error
    assert live.generate_calls == 0
    assert not (tmp_path / "cassettes").exists()

    recording = ad.build_adapter("cassette", record=True, **kwargs)
    assert recording.generate("p", "t", "T001", {}, {}).error is None
    assert live.generate_calls == 1
