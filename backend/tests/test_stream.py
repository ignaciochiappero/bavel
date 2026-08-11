import base64
import json

import numpy as np

from conftest import http_post


class FakeLine:
    def __init__(self, text):
        self.text = text


class FakeTranscript:
    def __init__(self, texts):
        self.lines = [FakeLine(t) for t in texts]


class FakeStream:
    def __init__(self):
        self.updates = 0

    def start(self):
        pass

    def add_audio(self, audio, sample_rate):
        self.updates += 1

    def update_transcription(self):
        return FakeTranscript(["hola"] * self.updates or ["hola"])

    def stop(self):
        return FakeTranscript(["hola mundo"])


class FakeTranscriber:
    def __init__(self, model_path, model_arch):
        pass

    def create_stream(self, update_interval=0.5):
        return FakeStream()


def _audio_b64(n_samples=1600):
    raw = np.zeros(n_samples, dtype=np.float32).tobytes()
    return base64.b64encode(raw).decode("ascii")


def _patch_moonshine(monkeypatch):
    import moonshine_voice

    monkeypatch.setattr(
        moonshine_voice, "get_model_for_language", lambda lang: ("/tmp/fake", "base")
    )
    monkeypatch.setattr(moonshine_voice, "Transcriber", FakeTranscriber)


def test_stream_lifecycle(http_server, monkeypatch):
    _patch_moonshine(monkeypatch)

    status, body, _ = http_post(
        http_server, "/api/stt/stream/start", json.dumps({"language": "en"})
    )
    assert status == 200
    stream_id = json.loads(body)["stream_id"]

    status, body, _ = http_post(
        http_server,
        "/api/stt/stream/append",
        json.dumps({"stream_id": stream_id, "audio_base64": _audio_b64()}),
    )
    assert status == 200
    data = json.loads(body)
    assert data["done"] is False
    assert data["text"]

    status, body, _ = http_post(
        http_server,
        "/api/stt/stream/stop",
        json.dumps({"stream_id": stream_id}),
    )
    assert status == 200
    data = json.loads(body)
    assert data["done"] is True
    assert data["text"] == "hola mundo"


def test_append_to_unknown_stream_returns_404(http_server, monkeypatch):
    _patch_moonshine(monkeypatch)
    status, _, _ = http_post(
        http_server,
        "/api/stt/stream/append",
        json.dumps({"stream_id": 424242, "audio_base64": _audio_b64()}),
    )
    assert status == 404


def test_stop_unknown_stream_returns_404(http_server, monkeypatch):
    _patch_moonshine(monkeypatch)
    status, _, _ = http_post(
        http_server,
        "/api/stt/stream/stop",
        json.dumps({"stream_id": 424242}),
    )
    assert status == 404


def test_stream_start_with_invalid_language_defaults_to_english(
    http_server, monkeypatch
):
    _patch_moonshine(monkeypatch)
    status, body, _ = http_post(
        http_server, "/api/stt/stream/start", json.dumps({"language": "xx"})
    )
    assert status == 200
    assert json.loads(body)["stream_id"]
