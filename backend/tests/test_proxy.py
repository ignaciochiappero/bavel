from conftest import http_get


def test_proxy_rejects_non_localhost_targets(http_server):
    for target in (
        "http://evil.example.com/v1/models",
        "http://127.0.0.2:9379/v1/models",
        "http://localhost.localdomain:9379/v1/models",
    ):
        status, _, _ = http_get(http_server, f"/proxy?url={target}")
        assert status == 403, f"expected 403 for {target}"


def test_proxy_rejects_wrong_ports(http_server):
    for port in (3000, 8080, 22):
        target = f"http://localhost:{port}/v1/models"
        status, _, _ = http_get(http_server, f"/proxy?url={target}")
        assert status == 403, f"expected 403 for {target}"


def test_proxy_allows_localhost_9379(http_server):
    # 9379 targets (http and https) are allowed through the security
    # boundary; with no litert-lm running the upstream call fails, so we
    # expect a 500 from the forward attempt rather than a 403 from the guard.
    for target in (
        "http://localhost:9379/v1/models",
        "http://127.0.0.1:9379/v1/models",
        "https://localhost:9379/v1/models",
    ):
        status, _, _ = http_get(http_server, f"/proxy?url={target}")
        assert status != 403, f"expected allowed for {target}"


def test_proxy_rejects_missing_url(http_server):
    status, body, _ = http_get(http_server, "/proxy")
    assert status == 400
