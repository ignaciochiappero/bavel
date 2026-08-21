# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import http.server
import socketserver
import urllib.request
import urllib.error
import urllib.parse
import os
import base64
import io
import json
import numpy as np
import wave
import traceback
import socket
import ssl
import time
import sqlite3
import threading
import itertools
from datetime import datetime, timezone
from collections import OrderedDict

# Multilingual STT via Moonshine.
# Language is fixed at recognizer construction, so we lazily build (and cache) one
# recognizer per language actually used.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SUPPORTED_STT_LANGS = {"en", "ar", "es", "ja", "zh", "ko"}
MAX_MODELS = 2

# Which Moonshine architecture to prefer. moonshine-voice defaults English to
# MEDIUM_STREAMING, the heaviest of the family; measured on a 17 s monologue it
# transcribes at 0.83x real time, leaving almost no headroom over live speech.
# TINY_STREAMING ran the same audio at 0.27x — 3x faster — with equal or better
# output on clean audio (it even punctuated "Good morning, everyone." correctly
# where MEDIUM produced "Good morning. Everyone thanks").
#
# MEDIUM is likely still the better choice for noisy rooms or strong accents,
# so this is an env knob rather than a hard-coded downgrade. Set
# MOONSHINE_STT_ARCH=MEDIUM_STREAMING to go back, or "" to use the library
# default for each language.
STT_ARCH = os.environ.get("MOONSHINE_STT_ARCH", "TINY_STREAMING").strip()


def resolve_stt_model(language):
    """(model_path, model_arch) for a language, honouring STT_ARCH when it
    exists for that language and falling back to the library default when it
    does not — not every architecture is published for every language."""
    from moonshine_voice import get_model_for_language
    from moonshine_voice.moonshine_api import ModelArch

    if STT_ARCH:
        wanted = getattr(ModelArch, STT_ARCH, None)
        if wanted is None:
            print(f"[STT] Unknown MOONSHINE_STT_ARCH={STT_ARCH!r}; using default")
        else:
            try:
                return get_model_for_language(language, wanted_model_arch=wanted)
            except Exception as e:
                print(f"[STT] {STT_ARCH} unavailable for {language} ({e}); using default")
    return get_model_for_language(language)


_stt_recognizers = OrderedDict()  # language -> recognizer
# RLock (reentrant): handle_stt holds the lock across get_stt_recognizer() + inference,
# and get_stt_recognizer() re-acquires it on the same thread. A plain Lock() self-deadlocks.
_stt_lock = threading.RLock()

# Multilingual TTS via moonshine-voice (Kokoro / Piper backed). Language is fixed at
# TextToSpeech construction, so we lazily build (and cache) one engine per language used.
# Maps our UI language codes -> moonshine-voice language codes.
TTS_LANG_MAP = {
    "ar": "ar-msa",
    "en": "en-us",
    "es": "es-es",
    "ja": "ja-jp",
    "zh": "zh-hans",
    "ko": "ko-kr",
}
# Optional per-language voice override (moonshine-voice voice IDs). Languages not
# listed here use moonshine's default voice for that language.
TTS_VOICE_MAP = {
    "zh": "kokoro_zf_xiaoxiao",  # 晓晓 — soft, gentle female Mandarin
}
_tts_engines = OrderedDict()  # our-lang-code -> TextToSpeech
# RLock (reentrant): handle_tts holds the lock across get_tts_engine() + synthesis,
# and get_tts_engine() re-acquires it on the same thread. A plain Lock() self-deadlocks.
_tts_lock = threading.RLock()

def get_tts_engine(language="en"):
    if language not in TTS_LANG_MAP:
        language = "en"
    with _tts_lock:
        if language in _tts_engines:
            _tts_engines.move_to_end(language)
            return _tts_engines[language]
        from moonshine_voice import TextToSpeech
        moon_lang = TTS_LANG_MAP[language]
        voice = TTS_VOICE_MAP.get(language)
        print(f"[TTS] Loading moonshine-voice (lang={language} -> {moon_lang}, voice={voice or 'default'})...")
        if len(_tts_engines) >= MAX_MODELS:
            oldest_lang, oldest_engine = _tts_engines.popitem(last=False)
            print(f"[TTS] Evicting model for {oldest_lang}")
            del oldest_engine
        if voice:
            _tts_engines[language] = TextToSpeech(moon_lang, voice=voice)
        else:
            _tts_engines[language] = TextToSpeech(moon_lang)
        return _tts_engines[language]

def get_stt_recognizer(language="en"):
    if language not in SUPPORTED_STT_LANGS:
        language = "en"
    with _stt_lock:
        if language in _stt_recognizers:
            _stt_recognizers.move_to_end(language)
            return _stt_recognizers[language]
        from moonshine_voice import Transcriber
        begin_activity(f"stt:{language}", "stt", language)
        try:
            model_path, model_arch = resolve_stt_model(language)
            print(f"[STT] Loading Moonshine STT (lang={language}, arch={model_arch.name})...")
            if len(_stt_recognizers) >= MAX_MODELS:
                oldest_lang, oldest_recognizer = _stt_recognizers.popitem(last=False)
                print(f"[STT] Evicting model for {oldest_lang}")
                del oldest_recognizer
            _stt_recognizers[language] = Transcriber(model_path=model_path, model_arch=model_arch)
        finally:
            end_activity(f"stt:{language}")
        return _stt_recognizers[language]


# ---------------------------------------------------------------------------
# Fast translation via Argos Translate (CTranslate2 NMT, offline, CPU).
#
# Measured head-to-head against Gemma 4B on this machine, same sentences:
#   Argos  61ms average
#   Gemma  1.76s average      -> 29x slower
# with equivalent quality (Argos was arguably better on 2 of 5 sentences).
#
# A general-purpose LLM is the wrong tool for translation latency: a dedicated
# NMT model does the same job in milliseconds. Gemma stays available as a
# fallback for pairs Argos cannot serve.
#
# Language packages download on first use (~7s per pair) into
# ~/.local/share/argos-translate, which lives in the mounted volume, so the
# download happens once.

# ---------------------------------------------------------------------------
# Warm-up state, exposed at GET /api/ready.
#
# The heavy models (Moonshine STT, moonshine-voice TTS, the Argos NMT) each
# cost seconds to load the first time. Without a signal the UI just looks slow
# during that window, so the frontend polls this and tells the user the system
# is still preparing rather than leaving them guessing.

_warmup_lock = threading.Lock()
_warmup = {
    # pending -> loading -> ready | error
    "stt": "pending",
    "tts": "pending",
    "translation": "pending",
    "started_at": None,   # time.monotonic() when prewarm began
    "ready_at": None,     # time.monotonic() when everything finished
}

# In-flight LAZY loads, which are the expensive ones users actually hit.
# The boot prewarm only covers en->es; picking any other language pair
# downloads and loads its package on first use — measured at 26.66s for
# es->en versus 0.05s once resident. Reporting "ready" during that window is
# what made the app look broken instead of busy.
_activity = {}  # key -> {"kind": str, "detail": str, "started_at": float}


def begin_activity(key, kind, detail):
    with _warmup_lock:
        _activity[key] = {
            "kind": kind,
            "detail": detail,
            "started_at": time.monotonic(),
        }


def end_activity(key):
    with _warmup_lock:
        _activity.pop(key, None)


def set_warmup(component, state):
    with _warmup_lock:
        _warmup[component] = state
        if all(
            _warmup[c] in ("ready", "error") for c in ("stt", "tts", "translation")
        ) and _warmup["ready_at"] is None:
            _warmup["ready_at"] = time.monotonic()


def handle_ready(handler):
    with _warmup_lock:
        components = {c: _warmup[c] for c in ("stt", "tts", "translation")}
        started = _warmup["started_at"]
        finished = _warmup["ready_at"]
    now = time.monotonic()
    with _warmup_lock:
        busy = [
            {
                "kind": a["kind"],
                "detail": a["detail"],
                "elapsed_ms": round((now - a["started_at"]) * 1000),
            }
            for a in _activity.values()
        ]
    # "ready" means usable: a component that failed to warm up still works, it
    # just pays its load cost on first use. An in-flight lazy load makes the
    # system NOT ready — that is precisely the window the UI must announce.
    warm = all(v in ("ready", "error") for v in components.values())
    _send_json(
        handler,
        200,
        {
            "ready": warm and not busy,
            "components": components,
            "busy": busy,
            "elapsed_ms": round((now - started) * 1000) if started else 0,
            "warmup_ms": round((finished - started) * 1000)
            if (started and finished)
            else None,
        },
    )


_argos_lock = threading.Lock()
_argos_installed = set()  # (from_code, to_code) pairs known to be installed


def ensure_argos_pair(src, dst):
    """Installs the src->dst package if missing. Returns True when the pair is
    usable. Safe to call on every request — after the first it is a set lookup."""
    if (src, dst) in _argos_installed:
        return True
    with _argos_lock:
        if (src, dst) in _argos_installed:
            return True
        try:
            import argostranslate.package as pkg

            for installed in pkg.get_installed_packages():
                _argos_installed.add((installed.from_code, installed.to_code))
            if (src, dst) in _argos_installed:
                return True

            pkg.update_package_index()
            match = next(
                (
                    p
                    for p in pkg.get_available_packages()
                    if p.from_code == src and p.to_code == dst
                ),
                None,
            )
            if match is None:
                print(f"[Translate] No Argos package for {src}->{dst}")
                return False
            print(f"[Translate] Downloading Argos package {src}->{dst}...")
            begin_activity(f"argos:{src}-{dst}", "translation", f"{src}→{dst}")
            try:
                pkg.install_from_path(match.download())
            finally:
                end_activity(f"argos:{src}-{dst}")
            _argos_installed.add((src, dst))
            return True
        except Exception as e:
            print(f"[Translate] Argos setup failed for {src}->{dst}: {e}")
            return False


def handle_warmup(handler, body):
    """Preloads a language pair in the background so the cost is paid while the
    user is still choosing languages, not mid-sentence. Returns immediately;
    progress shows up in /api/ready as busy activity."""
    try:
        data = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        _send_json(handler, 400, {"error": "Invalid JSON body"})
        return

    src = str(data.get("source") or "").strip()
    dst = str(data.get("target") or "").strip()
    if not src:
        _send_json(handler, 400, {"error": "source is required"})
        return

    def _warm():
        try:
            if src in SUPPORTED_STT_LANGS:
                get_stt_recognizer(src)
            if dst and dst != src and ensure_argos_pair(src, dst):
                import argostranslate.translate as _argos
                with _argos_lock:
                    _argos.translate("warm up", src, dst)
        except Exception as e:
            print(f"[Warmup] {src}->{dst} failed: {e}", flush=True)

    threading.Thread(target=_warm, daemon=True).start()
    _send_json(handler, 202, {"warming": True, "source": src, "target": dst})


def handle_translate(handler, body):
    try:
        data = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        _send_json(handler, 400, {"error": "Invalid JSON body"})
        return

    text = str(data.get("text") or "").strip()
    src = str(data.get("source") or "").strip()
    dst = str(data.get("target") or "").strip()
    if not text or not src or not dst:
        _send_json(handler, 400, {"error": "text, source and target are required"})
        return
    if src == dst:
        _send_json(handler, 200, {"text": text, "engine": "identity", "ms": 0})
        return

    started = time.monotonic()
    if not ensure_argos_pair(src, dst):
        _send_json(
            handler,
            503,
            {"error": f"No translation package for {src}->{dst}", "engine": "none"},
        )
        return

    # `ms` covers package installation too — the first call for a pair took
    # 26.66s wall while inference alone was 4.4s, and reporting only the latter
    # hid the real cost.
    try:
        import argostranslate.translate as argos

        # CTranslate2 releases the GIL during inference, but the Python wrapper
        # keeps per-model state; serialise to stay safe under the threading server.
        with _argos_lock:
            out = argos.translate(text, src, dst)
    except Exception as e:
        traceback.print_exc()
        _send_json(handler, 500, {"error": f"Translation failed: {e}"})
        return

    _send_json(
        handler,
        200,
        {
            "text": (out or "").strip(),
            "engine": "argos",
            "ms": round((time.monotonic() - started) * 1000),
        },
    )


PORT = 3000

# ---------------------------------------------------------------------------
# Session persistence (SQLite). TRANSLATOR_DATA points at the mounted volume
# in Docker (/root) so saved conversations survive container rebuilds.

DATA_DIR = os.environ.get(
    "TRANSLATOR_DATA", os.path.join(os.path.expanduser("~"), ".gemma-translator")
)
DB_PATH = os.path.join(DATA_DIR, "sessions.db")
_db_lock = threading.Lock()


def _get_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT 'Call',
            created_at TEXT NOT NULL
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            source_lang TEXT NOT NULL DEFAULT '',
            target_lang TEXT NOT NULL DEFAULT '',
            transcript TEXT NOT NULL DEFAULT '',
            translation TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )"""
    )
    conn.commit()
    return conn


def _send_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handle_session_list(handler):
    with _db_lock:
        conn = _get_db()
        try:
            rows = conn.execute(
                """SELECT s.id, s.title, s.created_at,
                          (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id)
                              AS message_count
                   FROM sessions s ORDER BY s.id DESC"""
            ).fetchall()
        finally:
            conn.close()
    _send_json(handler, 200, {"sessions": [dict(r) for r in rows]})


def handle_session_create(handler, body):
    try:
        data = json.loads(body.decode("utf-8")) if body else {}
    except Exception:
        _send_json(handler, 400, {"error": "Invalid JSON body"})
        return

    messages = data.get("messages") or []
    if not isinstance(messages, list):
        _send_json(handler, 400, {"error": "messages must be a list"})
        return

    title = str(data.get("title") or "Call")[:120]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    with _db_lock:
        conn = _get_db()
        try:
            cur = conn.execute(
                "INSERT INTO sessions (title, created_at) VALUES (?, ?)", (title, now)
            )
            session_id = cur.lastrowid
            for m in messages:
                conn.execute(
                    """INSERT INTO messages
                           (session_id, source_lang, target_lang, transcript,
                            translation, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        session_id,
                        str(m.get("source_lang") or "")[:32],
                        str(m.get("target_lang") or "")[:32],
                        str(m.get("transcript") or ""),
                        str(m.get("translation") or ""),
                        now,
                    ),
                )
            conn.commit()
        finally:
            conn.close()
    _send_json(handler, 200, {"id": session_id, "title": title})


def handle_session_messages(handler, session_id):
    with _db_lock:
        conn = _get_db()
        try:
            sess = conn.execute(
                "SELECT id, title FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
            if sess is None:
                _send_json(handler, 404, {"error": "Session not found"})
                return
            rows = conn.execute(
                """SELECT source_lang, target_lang, transcript, translation, created_at
                   FROM messages WHERE session_id = ? ORDER BY id""",
                (session_id,),
            ).fetchall()
        finally:
            conn.close()
    _send_json(
        handler,
        200,
        {
            "session_id": session_id,
            "title": sess["title"],
            "messages": [dict(r) for r in rows],
        },
    )

class ProxyHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    def end_headers(self):
        # Add CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
        self.send_header('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type, x-target-url, authorization')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def handle_proxy(self):
        # Parse query parameter "url"
        parsed_path = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed_path.query)
        target_url = query.get('url', [None])[0]

        if not target_url:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'Error: Missing "url" query parameter.')
            return

        # Restrict target URL to local LLM endpoint (http/https localhost/127.0.0.1)
        parsed_target = urllib.parse.urlparse(target_url)
        if parsed_target.scheme not in ('http', 'https') or parsed_target.hostname not in ('localhost', '127.0.0.1') or parsed_target.port not in (9379, None):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'Forbidden: Proxy target must be localhost:9379')
            return

        print(f"[Proxy] Routing {self.command} request to: {target_url}")
        
        # Read request body if method is POST/PUT/PATCH
        body = None
        if self.command in ['POST', 'PUT', 'PATCH']:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

        # Build request to target url
        req = urllib.request.Request(
            target_url,
            data=body,
            method=self.command
        )

        # Forward headers (Content-Type, Authorization, etc.)
        for key, val in self.headers.items():
            if key.lower() not in ['host', 'connection', 'content-length', 'x-target-url']:
                req.add_header(key, val)

        # A streaming request must NOT be buffered: reading the whole upstream
        # body before replying would erase the entire point of SSE (the client
        # would still wait for the last token). Detected from the request body
        # so only chat completions with "stream": true take the chunked path.
        streaming = bool(body) and b'"stream"' in body and b'true' in body

        try:
            with urllib.request.urlopen(req, timeout=300) as response:
                if streaming:
                    self.send_response(response.status)
                    for key, val in response.headers.items():
                        if key.lower() not in (
                            'content-length',
                            'connection',
                            'transfer-encoding',
                        ):
                            self.send_header(key, val)
                    self.send_header('Transfer-Encoding', 'chunked')
                    self.end_headers()
                    while True:
                        piece = response.read(1024)
                        if not piece:
                            break
                        self.wfile.write(
                            ('%X\r\n' % len(piece)).encode('ascii') + piece + b'\r\n'
                        )
                        self.wfile.flush()
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                    return

                res_body = response.read()
                self.send_response(response.status)
                # Forward response headers
                for key, val in response.headers.items():
                    if key.lower() not in ['content-length', 'connection']:
                        self.send_header(key, val)
                self.end_headers()
                self.wfile.write(res_body)
        except urllib.error.HTTPError as e:
            print(f"[Proxy Error] HTTP Error {e.code}: {e.reason}")
            try:
                res_body = e.read()
            except Exception:
                res_body = str(e).encode('utf-8')
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(res_body)
        except Exception as e:
            print(f"[Proxy Error] Exception: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))

    def handle_tts(self):
        parsed_path = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed_path.query)
        text = query.get('text', [None])[0]
        lang = query.get('lang', ['en'])[0]

        if not text:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'Error: Missing "text" parameter.')
            return

        print(f"[TTS] Synthesizing with moonshine-voice: {text[:50]}... (lang: {lang})")

        try:
            with _tts_lock:
                engine = get_tts_engine(lang)
                audio, sample_rate = engine.synthesize(text)

            # moonshine-voice returns mono float samples in [-1, 1]; encode to 16-bit PCM WAV.
            samples = np.asarray(audio, dtype=np.float32)
            samples = np.clip(samples, -1.0, 1.0)
            pcm16 = (samples * 32767.0).astype('<i2')

            with io.BytesIO() as buf:
                with wave.open(buf, 'wb') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(int(sample_rate))
                    wf.writeframes(pcm16.tobytes())
                wav_bytes = buf.getvalue()

            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)
        except Exception as e:
            traceback.print_exc()
            print(f"[TTS Error] Exception: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))

    def handle_stt(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            
            if not body:
                raise ValueError("No body data")
                
            data = json.loads(body.decode('utf-8'))
            audio_b64 = data.get('audio_base64')
            if not audio_b64:
                raise ValueError("Missing audio_base64 parameter")

            language = data.get('language', 'en')
            raw_data = base64.b64decode(audio_b64)
            
            # The browser sends a raw Float32Array buffer
            audio_np = np.frombuffer(raw_data, dtype=np.float32)

            with _stt_lock:
                recognizer = get_stt_recognizer(language)
                transcript = recognizer.transcribe_without_streaming(audio_np, 16000)
            text = " ".join([line.text for line in transcript.lines])
            print(f"[STT] Transcribed: {text}")

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"text": text}).encode('utf-8'))
        except Exception as e:
            traceback.print_exc()
            print(f"[STT Error] Exception: {e}")
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))

    # -----------------------------------------------------------------------
    # Streaming STT (live transcription). One Moonshine Stream per browser
    # session: audio is appended incrementally and the partial transcript is
    # returned on every update — true subtitle-style streaming, constant
    # inference cost per frame.

    _stt_streams = {}  # stream_id -> {"stream", "recognizer", "lock", "created_at"}
    _stt_stream_lock = threading.Lock()
    _stt_stream_counter = itertools.count(1)
    _STT_STREAM_IDLE_SWEEP_SECONDS = 900

    def _sweep_idle_stt_streams(self):
        now = time.monotonic()
        stale = [
            sid for sid, e in self._stt_streams.items()
            if now - e["created_at"] > self._STT_STREAM_IDLE_SWEEP_SECONDS
        ]
        for sid in stale:
            entry = self._stt_streams.pop(sid, None)
            if entry:
                try:
                    with entry["lock"]:
                        entry["stream"].stop()
                except Exception:
                    pass

    def handle_stt_stream_start(self, body):
        try:
            data = json.loads(body.decode('utf-8')) if body else {}
        except Exception:
            _send_json(self, 400, {"error": "Invalid JSON body"})
            return
        language = data.get('language', 'en')
        if language not in SUPPORTED_STT_LANGS:
            language = "en"

        try:
            from moonshine_voice import Transcriber
            model_path, model_arch = resolve_stt_model(language)
            recognizer = Transcriber(model_path=model_path, model_arch=model_arch)
            stream = recognizer.create_stream(update_interval=0.5)
            stream.start()
        except Exception as e:
            traceback.print_exc()
            _send_json(self, 500, {"error": f"Stream init failed: {e}"})
            return

        with self._stt_stream_lock:
            self._sweep_idle_stt_streams()
            stream_id = next(self._stt_stream_counter)
            self._stt_streams[stream_id] = {
                "stream": stream,
                "recognizer": recognizer,
                "lock": threading.Lock(),
                "created_at": time.monotonic(),
            }
        print(f"[STT Stream] Started stream {stream_id} (lang={language})")
        _send_json(self, 200, {"stream_id": stream_id})

    def handle_stt_stream_append(self, body):
        try:
            data = json.loads(body.decode('utf-8')) if body else {}
            stream_id = int(data.get('stream_id', -1))
            audio_b64 = data.get('audio_base64')
            if not audio_b64:
                raise ValueError("Missing audio_base64 parameter")
        except Exception:
            _send_json(self, 400, {"error": "Invalid request body"})
            return

        with self._stt_stream_lock:
            entry = self._stt_streams.get(stream_id)
        if entry is None:
            _send_json(self, 404, {"error": "Stream not found"})
            return

        audio_np = np.frombuffer(base64.b64decode(audio_b64), dtype=np.float32)
        try:
            with entry["lock"]:
                entry["stream"].add_audio(audio_np.tolist(), 16000)
                transcript = entry["stream"].update_transcription()
                entry["created_at"] = time.monotonic()
        except Exception as e:
            traceback.print_exc()
            _send_json(self, 500, {"error": f"Append failed: {e}"})
            return

        text = " ".join([line.text for line in transcript.lines])
        _send_json(self, 200, {"text": text, "done": False})

    def handle_stt_stream_stop(self, body):
        try:
            data = json.loads(body.decode('utf-8')) if body else {}
            stream_id = int(data.get('stream_id', -1))
        except Exception:
            _send_json(self, 400, {"error": "Invalid request body"})
            return

        with self._stt_stream_lock:
            entry = self._stt_streams.pop(stream_id, None)
        if entry is None:
            _send_json(self, 404, {"error": "Stream not found"})
            return

        try:
            with entry["lock"]:
                transcript = entry["stream"].stop()
        except Exception as e:
            traceback.print_exc()
            _send_json(self, 500, {"error": f"Stop failed: {e}"})
            return

        text = " ".join([line.text for line in transcript.lines])
        print(f"[STT Stream] Closed stream {stream_id}")
        _send_json(self, 200, {"text": text, "done": True})

    def handle_volume(self):
        client_ip = self.client_address[0]
        if client_ip not in ('127.0.0.1', '::1', 'localhost'):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'Forbidden: Volume control is only accessible locally')
            return

        try:
            content_length = int(self.headers.get('Content-Length', 0))
            if content_length > 0:
                body = self.rfile.read(content_length)
                data = json.loads(body.decode('utf-8')) if body else {}
                action = data.get('action')
            else:
                action = "get"
            
            import subprocess
            import re
            
            # PipeWire/wpctl needs XDG_RUNTIME_DIR to find its socket.
            # The server process may not have it set (e.g. when launched by systemd).
            env = os.environ.copy()
            if 'XDG_RUNTIME_DIR' not in env:
                uid = os.getuid()
                env['XDG_RUNTIME_DIR'] = f'/run/user/{uid}'
            
            def get_vol():
                # Try wpctl (PipeWire) first - outputs "Volume: 0.75"
                try:
                    out = subprocess.check_output(
                        ["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"],
                        text=True, timeout=2, env=env
                    )
                    m = re.search(r'Volume:\s+([0-9.]+)', out)
                    if m:
                        return round(float(m.group(1)) * 100)
                except Exception:
                    pass
                # Try pactl (PulseAudio)
                try:
                    out = subprocess.check_output(
                        ["pactl", "get-sink-volume", "@DEFAULT_SINK@"],
                        text=True, timeout=2, env=env
                    )
                    m = re.search(r'(\d+)%', out)
                    if m:
                        return int(m.group(1))
                except Exception:
                    pass
                # Try amixer
                try:
                    out = subprocess.check_output(
                        ["amixer", "sget", "Master"],
                        text=True, timeout=2, env=env
                    )
                    m = re.search(r'\[(\d+)%\]', out)
                    if m:
                        return int(m.group(1))
                except Exception:
                    pass
                return None

            def set_vol(direction):
                # Try wpctl first
                try:
                    arg = "5%+" if direction == "up" else "5%-"
                    subprocess.run(
                        ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", arg],
                        check=True, timeout=2, env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                    )
                    return True
                except Exception:
                    pass
                # Try pactl
                try:
                    arg = "+5%" if direction == "up" else "-5%"
                    subprocess.run(
                        ["pactl", "set-sink-volume", "@DEFAULT_SINK@", arg],
                        check=True, timeout=2, env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                    )
                    return True
                except Exception:
                    pass
                # Try amixer
                try:
                    arg = "5%+" if direction == "up" else "5%-"
                    subprocess.run(
                        ["amixer", "sset", "Master", arg],
                        check=True, timeout=2, env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                    )
                    return True
                except Exception:
                    pass
                return False

            success = False
            if action in ("up", "down"):
                success = set_vol(action)
            elif action == "get":
                success = True

            if success:
                current_vol = get_vol()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok", "volume": current_vol}).encode('utf-8'))
            else:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b'Failed to change system volume')
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))

    def do_POST(self):
        if self.path.startswith('/proxy'):
            self.handle_proxy()
            return
        if self.path.startswith('/api/warmup'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            handle_warmup(self, body)
            return
        if self.path.startswith('/api/translate'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            handle_translate(self, body)
            return
        if self.path.startswith('/api/stt/stream/start'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            self.handle_stt_stream_start(body)
            return
        if self.path.startswith('/api/stt/stream/append'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            self.handle_stt_stream_append(body)
            return
        if self.path.startswith('/api/stt/stream/stop'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            self.handle_stt_stream_stop(body)
            return
        if self.path.startswith('/api/stt'):
            self.handle_stt()
            return
        if self.path.startswith('/api/volume'):
            self.handle_volume()
            return
        if self.path.startswith('/api/sessions'):
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            handle_session_create(self, body)
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/proxy'):
            self.handle_proxy()
            return

        if self.path.startswith('/api/ready'):
            handle_ready(self)
            return

        if self.path.startswith('/api/tts'):
            self.handle_tts()
            return

        if self.path.startswith('/api/volume'):
            self.handle_volume()
            return

        if self.path.startswith('/api/sessions'):
            parts = self.path.split('?', 1)[0].strip('/').split('/')
            # /api/sessions
            if len(parts) == 2:
                handle_session_list(self)
                return
            # /api/sessions/<id>/messages
            if len(parts) == 4 and parts[3] == 'messages' and parts[2].isdigit():
                handle_session_messages(self, int(parts[2]))
                return
            _send_json(self, 404, {"error": "Not found"})
            return

        # Clean path to serve static files (strip any ?query cache-buster)
        url_path = self.path.split('?', 1)[0]
        if url_path == '/':
            url_path = '/index.html'

        dist_dir = os.path.realpath(os.path.join(BASE_DIR, '..', 'frontend', 'dist'))
        if not os.path.exists(dist_dir):
            dist_dir = os.path.realpath(os.path.join(BASE_DIR, 'dist'))
        if not os.path.exists(dist_dir):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'dist/ directory not found')
            return

        filename = url_path.lstrip('/')
        filepath = os.path.realpath(os.path.join(dist_dir, filename))
        
        # Check if the file is within dist directory
        if not filepath.startswith(dist_dir + os.sep) and filepath != dist_dir:
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'Forbidden')
            return

        if not os.path.exists(filepath) or os.path.isdir(filepath):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'File not found')
            return

        # Determine MIME type
        ext = os.path.splitext(filepath)[1].lower()
        mime_types = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf',
            '.otf': 'font/otf',
        }
        content_type = mime_types.get(ext, 'application/octet-stream')

        # Read and serve file
        try:
            with open(filepath, 'rb') as f:
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.end_headers()
                self.wfile.write(f.read())
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode('utf-8'))

if __name__ == '__main__':
    # Allow port reuse
    socketserver.TCPServer.allow_reuse_address = True
    local_ip = "localhost"
    try:
        # Create a dummy socket to find local network IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass

    use_ssl = os.path.exists('cert.pem') and os.path.exists('key.pem')

    with socketserver.ThreadingTCPServer(("", PORT), ProxyHTTPRequestHandler) as httpd:
        if use_ssl:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certfile='cert.pem', keyfile='key.pem')
            httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

        protocol = "https" if use_ssl else "http"
        print(f"===========================================================")
        print(f"LiteRT-LM Audio Testbed client running at:")
        print(f"👉 {protocol}://localhost:{PORT}")
        if local_ip != "localhost":
            print(f"👉 {protocol}://{local_ip}:{PORT} (Local Network)")
        print(f"===========================================================")
        def _prewarm_models():
            with _warmup_lock:
                _warmup["started_at"] = time.monotonic()
            print("[Prewarm] Loading default English STT & TTS models into memory...", flush=True)

            for name, load in (
                ("stt", lambda: get_stt_recognizer("en")),
                ("tts", lambda: get_tts_engine("en")),
            ):
                set_warmup(name, "loading")
                try:
                    load()
                    set_warmup(name, "ready")
                except Exception as e:
                    print(f"[Prewarm Error] {name}: {e}", flush=True)
                    set_warmup(name, "error")

            # Argos costs ~3.6s on its first call and ~50ms afterwards, so pay
            # that once at boot instead of on the user's first sentence.
            set_warmup("translation", "loading")
            try:
                if ensure_argos_pair("en", "es"):
                    import argostranslate.translate as _argos
                    with _argos_lock:
                        _argos.translate("warm up", "en", "es")
                    set_warmup("translation", "ready")
                    print("[Prewarm] Translation engine ready.", flush=True)
                else:
                    set_warmup("translation", "error")
            except Exception as e:
                print(f"[Prewarm Error] translation: {e}", flush=True)
                set_warmup("translation", "error")

            print("[Prewarm] Models pre-warmed successfully.", flush=True)

        threading.Thread(target=_prewarm_models, daemon=True).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
