"""QA-2: every protected route rejects callers without the shared secret.

These tests don't touch the DB — they verify only that the `verify_reducer_secret`
dependency runs before any handler logic, so a payload that *would* exercise DB
or pipeline code never gets that far without auth.

The dependency reads `app.auth.REDUCER_SHARED_SECRET` at request time. We patch
that module attribute directly rather than fighting `.env` autoload during
config reload.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app import auth
from app.main import app


def _client(monkeypatch, secret: str) -> TestClient:
    monkeypatch.setattr(auth, "REDUCER_SHARED_SECRET", secret)
    return TestClient(app)


def test_embed_reduce_rejects_when_secret_unset(monkeypatch) -> None:
    client = _client(monkeypatch, "")  # empty string = unconfigured
    resp = client.post(
        "/embed-reduce",
        json={"rows": [{"body": "hi"}], "text_column": "body"},
    )
    # Unconfigured → 503 (fail-closed), never silently serve.
    assert resp.status_code == 503


def test_embed_reduce_rejects_without_header(monkeypatch) -> None:
    client = _client(monkeypatch, "test-secret")
    resp = client.post(
        "/embed-reduce",
        json={"rows": [{"body": "hi"}], "text_column": "body"},
    )
    assert resp.status_code == 401
    assert "X-Reducer-Secret" in resp.json()["detail"]


def test_embed_reduce_rejects_wrong_secret(monkeypatch) -> None:
    client = _client(monkeypatch, "test-secret")
    resp = client.post(
        "/embed-reduce",
        json={"rows": [{"body": "hi"}], "text_column": "body"},
        headers={"X-Reducer-Secret": "wrong"},
    )
    assert resp.status_code == 401


def test_bridge_rejects_without_header(monkeypatch) -> None:
    client = _client(monkeypatch, "test-secret")
    resp = client.post(
        "/bridge",
        json={
            "project_id": "00000000-0000-0000-0000-000000000000",
            "tenant_id": "00000000-0000-0000-0000-000000000000",
            "cluster_a": 0,
            "cluster_b": 1,
        },
    )
    assert resp.status_code == 401


def test_status_rejects_without_header(monkeypatch) -> None:
    client = _client(monkeypatch, "test-secret")
    resp = client.get("/status/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 401


def test_health_stays_open(monkeypatch) -> None:
    # /health intentionally has no secret gate — monitoring + liveness probes
    # must reach it without secret distribution.
    client = _client(monkeypatch, "test-secret")
    assert client.get("/health").status_code == 200


