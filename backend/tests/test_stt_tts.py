import base64
import json

import numpy as np

from conftest import http_get, http_post


class FakeLine:
    def __init__(self, text):
        self.text = text


class FakeTranscript:
    def __init__(self, texts):
        self.lines = [FakeLine(t) for t in texts]


class FakeRecognizer:
    def transcribe_without_streaming(self, audio, sample_rate):
        return FakeTranscript(["hola mundo"])


class FakeEngine:
    def synthesize(self, text):
        return np.zeros(16000, dtype=np.float32), 16000


def _audio_b64(n_samples=1600):
    raw = np.zeros(n_samples, dtype=np.float32).tobytes()
    return base64.b64encode(raw).decode("ascii")


def test_stt_transcribes_with_mocked_recognizer(http_server, monkeypatch):
    monkeypatch.setattr(server_module(), "get_stt_recognizer", lambda lang: FakeRecognizer())
    status, body, _ = http_post(
        http_server,
        "/api/stt",
        json.dumps({"audio_base64": _audio_b64(), "language": "es"}),
    )
    assert status == 200
    assert json.loads(body) == {"text": "hola mundo"}


def test_stt_requires_audio(http_server, monkeypatch):
    monkeypatch.setattr(server_module(), "get_stt_recognizer", lambda lang: FakeRecognizer())
    status, _, _ = http_post(http_server, "/api/stt", json.dumps({}))
    assert status == 500


def test_tts_returns_wav(http_server, monkeypatch):
    monkeypatch.setattr(server_module(), "get_tts_engine", lambda lang: FakeEngine())
    status, body, headers = http_get(http_server, "/api/tts?text=hola&lang=es")
    assert status == 200
    assert headers["Content-Type"] == "audio/wav"
    assert body[:4] == b"RIFF"
    assert len(body) > 44


def test_tts_requires_text(http_server, monkeypatch):
    monkeypatch.setattr(server_module(), "get_tts_engine", lambda lang: FakeEngine())
    status, _, _ = http_get(http_server, "/api/tts?lang=es")
    assert status == 400


def server_module():
    import server

    return server
