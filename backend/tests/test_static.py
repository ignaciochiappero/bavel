from conftest import http_get


def test_serves_index_html(http_server):
    status, body, headers = http_get(http_server, "/")
    assert status == 200
    assert headers["Content-Type"] == "text/html"
    assert b"<div id=\"root\">" in body


def test_serves_unknown_asset_as_404(http_server):
    status, _, _ = http_get(http_server, "/assets/nope-missing.js")
    assert status == 404


def test_path_traversal_is_blocked(http_server):
    for path in (
        "/../server.py",
        "/..%2f..%2fbackend%2fserver.py",
        "/assets/../../backend/server.py",
    ):
        status, _, _ = http_get(http_server, path)
        assert status in (403, 404), f"expected blocked for {path}, got {status}"
