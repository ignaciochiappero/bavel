"""The proxy must forward SSE bodies chunk by chunk.

Buffering the upstream response (the previous `response.read()`) defeated the
whole point of streaming: the client still waited for the final token. These
tests stand a fake upstream on the allowed port and check that the proxy
relays frames without swallowing them, while non-streaming requests keep
working unchanged.
"""
import http.server
import json
import threading
import time

import pytest
from conftest import http_post

UPSTREAM_PORT = 9379  # the only port the proxy security guard allows


class _Upstream(http.server.BaseHTTPRequestHandler):
    """Emits three SSE frames with a pause between them."""

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        streaming = b'"stream": true' in body or b'"stream":true' in body

        if not streaming:
            payload = json.dumps(
                {"choices": [{"message": {"content": "BATCH"}}]}
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for token in ("Hola", " mundo", "!"):
            frame = "data: %s\n\n" % json.dumps(
                {"choices": [{"delta": {"content": token}}]}
            )
            self.wfile.write(frame.encode())
            self.wfile.flush()
            time.sleep(0.05)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *args):
        pass


@pytest.fixture()
def upstream():
    from socketserver import ThreadingTCPServer

    ThreadingTCPServer.allow_reuse_address = True
    try:
        httpd = ThreadingTCPServer(("127.0.0.1", UPSTREAM_PORT), _Upstream)
    except OSError:
        pytest.skip(f"port {UPSTREAM_PORT} already in use (real litert-lm running)")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://localhost:{UPSTREAM_PORT}/v1/chat/completions"
    httpd.shutdown()
    httpd.server_close()


def _proxy_path(target):
    import urllib.parse

    return "/proxy?url=" + urllib.parse.quote(target, safe="")


def test_sse_frames_survive_the_proxy(http_server, upstream):
    body = json.dumps({"model": "m", "stream": True, "messages": []})
    status, payload, _ = http_post(http_server, _proxy_path(upstream), body)
    assert status == 200
    text = payload.decode()
    # Every token made it through, in order, still as SSE frames.
    for token in ("Hola", "mundo", "!"):
        assert token in text
    assert text.count("data:") >= 3
    assert text.index("Hola") < text.index("mundo")


def test_streaming_response_is_chunked(http_server, upstream):
    body = json.dumps({"model": "m", "stream": True, "messages": []})
    status, _, headers = http_post(http_server, _proxy_path(upstream), body)
    assert status == 200
    assert headers.get("Transfer-Encoding", "").lower() == "chunked"
    # A buffered reply would have announced a fixed size.
    assert "Content-Length" not in headers


def test_non_streaming_requests_are_unaffected(http_server, upstream):
    body = json.dumps({"model": "m", "messages": []})
    status, payload, headers = http_post(http_server, _proxy_path(upstream), body)
    assert status == 200
    assert json.loads(payload)["choices"][0]["message"]["content"] == "BATCH"
    assert headers.get("Transfer-Encoding", "").lower() != "chunked"


def test_security_guard_still_applies_to_streaming(http_server):
    body = json.dumps({"model": "m", "stream": True, "messages": []})
    status, _, _ = http_post(
        http_server, _proxy_path("http://evil.example.com/v1/chat/completions"), body
    )
    assert status == 403
