import os
import sys
import tempfile
import threading

import pytest

# Point the backend at a throwaway data dir BEFORE importing server so the
# SQLite path (TRANSLATOR_DATA) resolves there.
TEST_DATA_DIR = tempfile.mkdtemp(prefix="bavel-test-")
os.environ["TRANSLATOR_DATA"] = TEST_DATA_DIR

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server  # noqa: E402


@pytest.fixture()
def http_server():
    """Boots the real backend on an ephemeral port; returns its base URL."""
    from socketserver import ThreadingTCPServer

    httpd = ThreadingTCPServer(("127.0.0.1", 0), server.ProxyHTTPRequestHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def http_get(base, path):
    import urllib.request
    import urllib.error

    try:
        with urllib.request.urlopen(base + path, timeout=10) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def http_post(base, path, body=None, headers=None):
    import urllib.request
    import urllib.error

    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(
        base + path,
        data=data,
        method="POST",
        headers=headers or {"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)
