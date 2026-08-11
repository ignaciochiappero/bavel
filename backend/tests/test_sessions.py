import json

from conftest import http_get, http_post


def test_create_and_list_session(http_server):
    status, body, _ = http_post(
        http_server,
        "/api/sessions",
        json.dumps({"title": "Test call", "messages": []}),
    )
    assert status == 200
    session_id = json.loads(body)["id"]

    status, body, _ = http_get(http_server, "/api/sessions")
    assert status == 200
    sessions = json.loads(body)["sessions"]
    assert any(s["id"] == session_id for s in sessions)
    match = next(s for s in sessions if s["id"] == session_id)
    assert match["message_count"] == 0


def test_session_messages_round_trip(http_server):
    status, body, _ = http_post(
        http_server,
        "/api/sessions",
        json.dumps(
            {
                "title": "Round trip",
                "messages": [
                    {
                        "source_lang": "en",
                        "target_lang": "es",
                        "transcript": "Hello",
                        "translation": "Hola",
                    },
                    {
                        "source_lang": "es",
                        "target_lang": "en",
                        "transcript": "Hola mundo",
                        "translation": "Hello world",
                    },
                ],
            }
        ),
    )
    session_id = json.loads(body)["id"]

    status, body, _ = http_get(http_server, f"/api/sessions/{session_id}/messages")
    assert status == 200
    data = json.loads(body)
    assert data["session_id"] == session_id
    assert [m["transcript"] for m in data["messages"]] == ["Hello", "Hola mundo"]
    assert [m["translation"] for m in data["messages"]] == ["Hola", "Hello world"]
    assert [m["source_lang"] for m in data["messages"]] == ["en", "es"]


def test_messages_are_ordered_and_include_created_at(http_server):
    http_post(
        http_server,
        "/api/sessions",
        json.dumps(
            {
                "title": "Order",
                "messages": [
                    {"source_lang": "en", "transcript": "first", "translation": ""},
                    {"source_lang": "en", "transcript": "second", "translation": ""},
                    {"source_lang": "en", "transcript": "third", "translation": ""},
                ],
            }
        ),
    )
    status, body, _ = http_get(http_server, "/api/sessions")
    sessions = json.loads(body)["sessions"]
    newest = max(sessions, key=lambda s: s["id"])
    assert newest["message_count"] == 3

    _, body, _ = http_get(http_server, f"/api/sessions/{newest['id']}/messages")
    messages = json.loads(body)["messages"]
    assert [m["transcript"] for m in messages] == ["first", "second", "third"]
    assert all(m["created_at"] for m in messages)


def test_missing_session_returns_404(http_server):
    status, _, _ = http_get(http_server, "/api/sessions/99999/messages")
    assert status == 404


def test_invalid_payload_returns_400(http_server):
    status, _, _ = http_post(http_server, "/api/sessions", "not json{{")
    assert status == 400


def test_messages_must_be_a_list(http_server):
    status, _, _ = http_post(
        http_server, "/api/sessions", json.dumps({"messages": "nope"})
    )
    assert status == 400
