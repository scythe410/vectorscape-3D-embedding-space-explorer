"""Service-to-service failure modes for the reducer.

QA-6 in BUILDLOG.md established the contract: any exception thrown by the
pipeline path (whether from run_pipeline itself or from the DB writes) gets
captured server-side via `logging.exception` and a *generic* user-facing
message is written to both `projects.error_message` and the HTTP response.
The raw exception text — which can carry Postgres internals, file paths,
or token values — must never reach the UI.

These tests drive a simulated connection-timeout / generic Exception
through the sync `/embed-reduce` path and assert the contract holds:

  1. The HTTP response body does NOT contain the raw exception message.
  2. The DB row's `error_message` column is the static generic copy.
  3. The HTTP response status is 5xx (never 2xx success on a swallowed
     exception, never 200 with a hidden error).
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import api as api_module
from app import auth
from app.main import app

# A sentinel message that would be very embarrassing to leak.
SENSITIVE_MESSAGE = (
    "FATAL: password authentication failed for user 'postgres' "
    "(host=db.internal, db=vectorscape, schema=public)"
)


class _RecordingConn:
    """Captures every `set_status` call so the test can assert what the
    error path wrote vs what the success path would have written."""

    def __init__(self) -> None:
        self.status_calls: list[dict[str, Any]] = []


@contextmanager
def _connect_ctx(state: dict[str, Any]):
    # Track which connect() call we're on so a fresh-conn error-record write
    # is distinguishable from the work-tx connection.
    yield state.setdefault("conn", _RecordingConn())


@pytest.fixture
def auth_on(monkeypatch) -> None:
    monkeypatch.setattr(auth, "REDUCER_SHARED_SECRET", "test-secret")


@pytest.fixture
def mock_db(monkeypatch):
    """Wire api.connect / ensure_project / set_status to fakes so the only
    real thing running is the exception path itself."""
    state: dict[str, Any] = {}
    # `connect()` is called both inside the work-tx and inside the
    # error-record path — both should land here.
    monkeypatch.setattr(api_module, "connect", lambda: _connect_ctx(state))
    monkeypatch.setattr(
        api_module,
        "ensure_project",
        lambda conn, **kw: ("11111111-1111-1111-1111-111111111111", "tenant-1"),
    )

    def fake_set_status(
        conn: _RecordingConn,
        project_id: str,
        status: str,
        error_message: str | None = None,
    ) -> None:
        conn.status_calls.append(
            {"project_id": project_id, "status": status, "error_message": error_message}
        )

    monkeypatch.setattr(api_module, "set_status", fake_set_status)
    return state


def _client() -> TestClient:
    return TestClient(app)


def _hdr() -> dict[str, str]:
    return {"X-Reducer-Secret": "test-secret"}


def _payload() -> dict[str, Any]:
    return {
        "project_id": "11111111-1111-1111-1111-111111111111",
        "tenant_id": "tenant-1",
        "rows": [{"body": "alpha"}, {"body": "beta"}, {"body": "gamma"}],
        "text_column": "body",
        "name": "sanitization probe",
        "embed_model": "all-MiniLM-L6-v2",
        "reducer": "pacmap",
    }


# ---- Tests -----------------------------------------------------------------


def test_pipeline_exception_is_sanitized_in_response_body(
    auth_on, mock_db, monkeypatch
) -> None:
    """A run_pipeline failure must surface as a generic 500 — never the raw
    Postgres-shaped message that could leak credentials or schema names."""

    def raising_pipeline(*_args, **_kwargs):
        raise ConnectionError(SENSITIVE_MESSAGE)

    monkeypatch.setattr(api_module, "run_pipeline", raising_pipeline)
    monkeypatch.setattr(api_module, "write_results", lambda *_a, **_kw: {})

    resp = _client().post("/embed-reduce", headers=_hdr(), json=_payload())
    assert resp.status_code == 500
    body_text = resp.text
    # Headline contract: the sensitive substrings must NOT appear in the body.
    assert "password" not in body_text.lower()
    assert "db.internal" not in body_text
    assert "FATAL" not in body_text
    assert SENSITIVE_MESSAGE not in body_text
    # Body still names the failure shape (type) so operators can see "this
    # was a ConnectionError" at a glance, but no message contents.
    assert "ConnectionError" in body_text or "reduction failed" in body_text.lower()


def test_pipeline_exception_writes_generic_message_to_db(
    auth_on, mock_db, monkeypatch
) -> None:
    """The DB row's error_message must be the static generic copy. The user
    polls /status and sees this string — leaking the raw exception there
    would expose internals to the browser."""

    def raising_pipeline(*_args, **_kwargs):
        raise RuntimeError(SENSITIVE_MESSAGE)

    monkeypatch.setattr(api_module, "run_pipeline", raising_pipeline)
    monkeypatch.setattr(api_module, "write_results", lambda *_a, **_kw: {})

    _client().post("/embed-reduce", headers=_hdr(), json=_payload())

    conn: _RecordingConn = mock_db["conn"]
    # We expect (at least) two set_status calls: 'pending' on entry, 'error'
    # from the error-record path. The 'reducing' status is set inside
    # _do_sync_work which runs on a threadpool with the same fake conn.
    statuses = [c["status"] for c in conn.status_calls]
    assert "pending" in statuses
    assert "error" in statuses
    error_call = next(c for c in conn.status_calls if c["status"] == "error")
    error_msg = error_call["error_message"] or ""
    # The generic copy is the static string committed in QA-6.
    assert "Reduction failed" in error_msg
    assert "logs" in error_msg.lower()
    # The sensitive bits MUST NOT be in the DB column.
    assert SENSITIVE_MESSAGE not in error_msg
    assert "password" not in error_msg.lower()


def test_timeout_style_exception_is_sanitized(auth_on, mock_db, monkeypatch) -> None:
    """A Supabase/Postgres connection timeout (modeled with TimeoutError)
    must surface as the generic copy too — not 'timeout connecting to
    host db.internal:5432'."""

    def timing_out(*_args, **_kwargs):
        raise TimeoutError("read timed out after 30.0s talking to db.internal:5432")

    monkeypatch.setattr(api_module, "run_pipeline", timing_out)
    monkeypatch.setattr(api_module, "write_results", lambda *_a, **_kw: {})

    resp = _client().post("/embed-reduce", headers=_hdr(), json=_payload())
    assert resp.status_code == 500
    assert "db.internal" not in resp.text
    assert "5432" not in resp.text

    conn: _RecordingConn = mock_db["conn"]
    error_call = next(c for c in conn.status_calls if c["status"] == "error")
    assert "db.internal" not in (error_call["error_message"] or "")
    assert "Reduction failed" in (error_call["error_message"] or "")


def test_postgres_error_is_sanitized(auth_on, mock_db, monkeypatch) -> None:
    """Simulate an exception whose `repr` would carry a Postgres traceback
    flavor — UndefinedTable, RaisedNotice etc. The shape leaks internals
    by design; the contract is the sanitization layer hides them."""

    class FakePsycopgError(Exception):
        pass

    def fake_pg(*_args, **_kwargs):
        raise FakePsycopgError(
            'relation "public.secret_audit" does not exist\n'
            'LINE 1: select * from public.secret_audit;'
        )

    monkeypatch.setattr(api_module, "run_pipeline", fake_pg)
    monkeypatch.setattr(api_module, "write_results", lambda *_a, **_kw: {})

    resp = _client().post("/embed-reduce", headers=_hdr(), json=_payload())
    assert resp.status_code == 500
    assert "secret_audit" not in resp.text
    assert "LINE 1" not in resp.text

    conn: _RecordingConn = mock_db["conn"]
    error_call = next(c for c in conn.status_calls if c["status"] == "error")
    msg = error_call["error_message"] or ""
    assert "secret_audit" not in msg
    assert "LINE 1" not in msg
