"""Tests for /search — natural-language similarity search over a project.

We don't hit a real Postgres or run real ML here. The load-bearing guarantees
are static:

  1. The query is embedded with the project's *own* embed_model (read from the
     projects row), never with a hardcoded constant. A mismatched model lives
     in a different latent space — cosine becomes meaningless.

  2. Every points query is tenant-scoped. The same SQL pattern the RLS test in
     supabase/tests/rls_cross_tenant.sql proves at the database layer is
     verified here at the service layer: a request that names a project the
     tenant doesn't own returns 0 rows (404, never the other tenant's data).

  3. The empty-result path returns a clean `matches: []` 200 — no 500, no
     exception, so the UI can render its "no matches" branch directly.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import auth
from app import search as search_module
from app.main import app

# ---- Fakes ---------------------------------------------------------------

class _FakeCursor:
    """Records the (sql, params) of every execute and returns prepared rows."""

    def __init__(
        self,
        project_row: tuple[Any, ...] | None,
        points_rows: list[tuple[Any, ...]],
        cluster_rows: list[tuple[Any, ...]] | None = None,
    ):
        self._project_row = project_row
        self._points_rows = points_rows
        self._cluster_rows = cluster_rows or []
        self._mode: str = ""
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def execute(self, sql: str, params: tuple[Any, ...]) -> _FakeCursor:
        self.calls.append((sql, params))
        # Distinguish the three queries by which table the SQL hits.
        low = sql.lower()
        if "from public.projects" in low:
            self._mode = "project"
        elif "from public.clusters" in low:
            self._mode = "clusters"
        elif "from public.points" in low:
            self._mode = "points"
        else:
            self._mode = "?"
        return self

    def fetchone(self) -> Any:
        if self._mode == "project":
            return self._project_row
        return None

    def fetchall(self) -> list[tuple[Any, ...]]:
        if self._mode == "points":
            return self._points_rows
        if self._mode == "clusters":
            return self._cluster_rows
        return []


class _FakeConn:
    def __init__(self, cursor: _FakeCursor) -> None:
        self.cursor_obj = cursor

    def execute(self, sql: str, params: tuple[Any, ...]) -> _FakeCursor:
        return self.cursor_obj.execute(sql, params)


@contextmanager
def _fake_connect_ctx(cursor: _FakeCursor):
    yield _FakeConn(cursor)


# ---- Fixtures ------------------------------------------------------------

@pytest.fixture
def auth_on(monkeypatch) -> None:
    """Set a known shared secret so the auth dep passes when we send it."""
    monkeypatch.setattr(auth, "REDUCER_SHARED_SECRET", "test-secret")


def _client() -> TestClient:
    return TestClient(app)


def _hdr() -> dict[str, str]:
    return {"X-Reducer-Secret": "test-secret"}


# ---- Tests ---------------------------------------------------------------

def test_query_embedded_with_project_embed_model(monkeypatch, auth_on) -> None:
    """The query must be embedded with whatever model produced the project's
    point vectors. If the projects row says 'openai', we must call embed_texts
    with 'openai' — never with the default constant."""
    captured_model: dict[str, Any] = {}

    def fake_embed_texts(texts: list[str], embed_model: str = "default") -> np.ndarray:
        captured_model["embed_model"] = embed_model
        captured_model["texts"] = list(texts)
        return np.ones((len(texts), 384), dtype=np.float32)

    # Project row carries an unusual embed_model — must propagate.
    cursor = _FakeCursor(project_row=("openai",), points_rows=[])
    monkeypatch.setattr(search_module, "embed_texts", fake_embed_texts)
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "spiral galaxies",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # The model named on the project row was used for the query embedding.
    assert captured_model["embed_model"] == "openai"
    assert captured_model["texts"] == ["spiral galaxies"]
    # And the response advertises the same model so the client can verify.
    assert body["embed_model"] == "openai"


def test_query_embedded_with_minilm_when_project_uses_minilm(monkeypatch, auth_on) -> None:
    """The same guarantee in the common-case direction: a MiniLM project must
    embed its query with MiniLM, never silently fall back to a different model."""
    captured: dict[str, Any] = {}

    def fake_embed_texts(texts: list[str], embed_model: str = "default") -> np.ndarray:
        captured["embed_model"] = embed_model
        return np.zeros((len(texts), 384), dtype=np.float32)

    cursor = _FakeCursor(project_row=("all-MiniLM-L6-v2",), points_rows=[])
    monkeypatch.setattr(search_module, "embed_texts", fake_embed_texts)
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "anything",
        },
    )
    assert resp.status_code == 200, resp.text
    assert captured["embed_model"] == "all-MiniLM-L6-v2"


def test_search_is_tenant_scoped(monkeypatch, auth_on) -> None:
    """A cross-tenant query returns nothing — the project lookup itself filters
    on tenant_id, so a foreign tenant_id sees a 404 (never the real owner's
    rows). The same scoping is also applied to the points search SQL."""

    def fake_embed(texts: list[str], embed_model: str = "x") -> np.ndarray:
        return np.zeros((len(texts), 384), dtype=np.float32)

    monkeypatch.setattr(search_module, "embed_texts", fake_embed)

    # Project lookup returns None — i.e., that (project_id, tenant_id) combo
    # doesn't exist. Mimics a cross-tenant attempt.
    cursor = _FakeCursor(project_row=None, points_rows=[])
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "deadbeef-dead-beef-dead-beefdeadbeef",
            "query": "anything",
        },
    )
    assert resp.status_code == 404

    # Confirm the SQL the route actually issued included tenant_id in both the
    # bind params AND the WHERE clause — so even if the project existed, a
    # request from another tenant would scope to that tenant's points only.
    project_calls = [c for c in cursor.calls if "public.projects" in c[0]]
    assert len(project_calls) == 1
    sql, params = project_calls[0]
    assert "tenant_id" in sql
    # tenant_id should be one of the bind parameters (the call site passes
    # (project_id, tenant_id)).
    assert "deadbeef-dead-beef-dead-beefdeadbeef" in params


def test_points_query_filters_by_tenant_id(monkeypatch, auth_on) -> None:
    """When a project IS found, the subsequent points-search SQL must also
    name tenant_id in its WHERE clause and bind the verified tenant. Defense
    in depth even if the project lookup somehow returned the wrong row."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )
    cursor = _FakeCursor(project_row=("all-MiniLM-L6-v2",), points_rows=[])
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    tenant = "22222222-2222-2222-2222-222222222222"
    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": tenant,
            "query": "anything",
        },
    )
    assert resp.status_code == 200

    points_calls = [c for c in cursor.calls if "public.points" in c[0]]
    assert len(points_calls) == 1
    sql, params = points_calls[0]
    assert "tenant_id" in sql.lower()
    # The verified tenant is bound; an attacker payload's tenant_id can never
    # reach a query without this binding. We check string params only — the
    # query embedding (numpy array) is also in there but doesn't compare with
    # `in`.
    string_params = [p for p in params if isinstance(p, str)]
    assert tenant in string_params


def test_empty_result_renders_cleanly(monkeypatch, auth_on) -> None:
    """When the points-search returns nothing (e.g., query in a void or no
    matches above whatever threshold), the response is a clean 200 with
    matches: [] — never a 500, never an exception, so the UI can render its
    no-results branch directly."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )
    cursor = _FakeCursor(project_row=("all-MiniLM-L6-v2",), points_rows=[])
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "no plausible match",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["matches"] == []
    assert body["query"] == "no plausible match"
    assert body["embed_model"] == "all-MiniLM-L6-v2"


def test_empty_query_rejected(monkeypatch, auth_on) -> None:
    """A blank/whitespace-only query is a 400 — no embedding call, no DB call."""
    called: dict[str, bool] = {"embed": False, "connect": False}

    def fake_embed(*args, **kwargs):
        called["embed"] = True
        return np.zeros((1, 384), dtype=np.float32)

    @contextmanager
    def fake_connect():
        called["connect"] = True
        yield None

    monkeypatch.setattr(search_module, "embed_texts", fake_embed)
    monkeypatch.setattr(search_module, "connect", fake_connect)

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "   ",
        },
    )
    assert resp.status_code == 400
    assert called["embed"] is False
    assert called["connect"] is False


def _points_row(
    pid: str,
    text: str,
    cluster_id: int | None,
    score: float = 0.1,
) -> tuple[Any, ...]:
    """Shape matches the SELECT in _search_points:
    (id::text, text, x, y, z, cluster_id, score)."""
    return (pid, text, 0.0, 0.0, 0.0, cluster_id, score)


def test_region_summary_aggregates_by_cluster_with_real_labels(
    monkeypatch, auth_on
) -> None:
    """Matches across three clusters with real labels → regions ranked by
    count desc, summary names the dominant region(s) in plain language."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )

    # 6 hits in cluster 3 (Senate races), 3 in cluster 7 (campaign finance),
    # 1 in cluster 11 (sports), plus 2 noise hits that must not pollute regions.
    points_rows = [
        *[_points_row(f"p{i}", "t", 3) for i in range(6)],
        *[_points_row(f"p{i + 6}", "t", 7) for i in range(3)],
        _points_row("p9", "t", 11),
        _points_row("pn1", "t", None),
        _points_row("pn2", "t", None),
    ]
    cluster_rows = [
        (3, "Senate Races"),
        (7, "Campaign Finance"),
        (11, "Pro Sports"),
    ]
    cursor = _FakeCursor(
        project_row=("all-MiniLM-L6-v2",),
        points_rows=points_rows,
        cluster_rows=cluster_rows,
    )
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "money in politics",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Regions aggregated and ordered correctly. Noise excluded.
    assert body["labels_are_real"] is True
    assert [r["cluster_id"] for r in body["regions"]] == [3, 7, 11]
    assert [r["count"] for r in body["regions"]] == [6, 3, 1]
    assert [r["label"] for r in body["regions"]] == [
        "Senate Races",
        "Campaign Finance",
        "Pro Sports",
    ]
    # Summary is a plain-language sentence that names the regions. We don't
    # pin exact prose (caller can tweak), but the label that dominates must
    # appear in it.
    assert "Senate Races" in body["summary"]
    assert body["summary"] != ""

    # The cluster lookup was scoped to the verified tenant — defense in depth.
    cluster_calls = [c for c in cursor.calls if "public.clusters" in c[0]]
    assert len(cluster_calls) == 1
    sql, params = cluster_calls[0]
    assert "tenant_id" in sql.lower()
    assert "22222222-2222-2222-2222-222222222222" in params


def test_region_summary_degrades_when_labels_are_placeholders(
    monkeypatch, auth_on
) -> None:
    """If every matched cluster's label is a `Cluster N` placeholder, the
    summary collapses to dot-highlight-only: regions still come back (the
    UI can list them as bare cluster ids), but labels_are_real is False
    and summary is empty so the client knows not to print prose."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )

    points_rows = [
        *[_points_row(f"p{i}", "t", 3) for i in range(4)],
        *[_points_row(f"p{i + 4}", "t", 7) for i in range(2)],
    ]
    # Both labels look like the pre-labels-commit placeholder shape.
    cluster_rows = [(3, "Cluster 3"), (7, "Cluster 7")]
    cursor = _FakeCursor(
        project_row=("all-MiniLM-L6-v2",),
        points_rows=points_rows,
        cluster_rows=cluster_rows,
    )
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "anything",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # Aggregation still ran — the client can use it for dot-highlight bookkeeping.
    assert [r["cluster_id"] for r in body["regions"]] == [3, 7]
    assert [r["count"] for r in body["regions"]] == [4, 2]
    # …but the legibility layer is suppressed.
    assert body["labels_are_real"] is False
    assert body["summary"] == ""


def test_region_summary_handles_missing_and_blank_labels_as_placeholders(
    monkeypatch, auth_on
) -> None:
    """A NULL label or whitespace-only label is just as un-nameable as a
    `Cluster N` placeholder. labels_are_real must remain False unless at
    least one matched cluster has a real, human-readable label."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )

    points_rows = [
        _points_row("p0", "t", 1),
        _points_row("p1", "t", 2),
    ]
    cluster_rows = [(1, None), (2, "   ")]
    cursor = _FakeCursor(
        project_row=("all-MiniLM-L6-v2",),
        points_rows=points_rows,
        cluster_rows=cluster_rows,
    )
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "anything",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["labels_are_real"] is False
    assert body["summary"] == ""


def test_region_summary_excludes_noise_matches(monkeypatch, auth_on) -> None:
    """Matches with cluster_id NULL (HDBSCAN noise) are intentionally absent
    from regions — they don't belong to any named place. With only noise
    matches, regions is empty and the panel falls through to dot-only."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )

    points_rows = [_points_row(f"pn{i}", "t", None) for i in range(5)]
    cursor = _FakeCursor(
        project_row=("all-MiniLM-L6-v2",),
        points_rows=points_rows,
        cluster_rows=[],
    )
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    resp = _client().post(
        "/search",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "anything",
        },
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["regions"] == []
    assert body["labels_are_real"] is False
    assert body["summary"] == ""
    # The cluster-label lookup is skipped entirely when there are no
    # clustered matches — no SQL on public.clusters.
    cluster_calls = [c for c in cursor.calls if "public.clusters" in c[0]]
    assert cluster_calls == []


def test_search_logs_when_embed_model_falls_back_to_default(
    monkeypatch, auth_on, caplog
) -> None:
    """A project row with a NULL/empty embed_model silently used to coerce
    the query to MiniLM. Now that's loud: the fallback still happens, but it
    logs a WARNING so an operator can see it. Pins the observability so a
    future refactor can't quietly drop the log."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )
    # Project row exists but embed_model column is None — pre-column or
    # manually-edited projects.
    cursor = _FakeCursor(project_row=(None,), points_rows=[])
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    with caplog.at_level("WARNING", logger="app.search"):
        resp = _client().post(
            "/search",
            headers=_hdr(),
            json={
                "project_id": "11111111-1111-1111-1111-111111111111",
                "tenant_id": "22222222-2222-2222-2222-222222222222",
                "query": "anything",
            },
        )
    assert resp.status_code == 200
    # The audit principle: a degraded path must never be indistinguishable
    # from the happy path in the logs.
    assert any(
        "empty embed_model" in r.message and "defaulting" in r.message
        for r in caplog.records
    ), caplog.text


def test_search_logs_when_region_summary_degrades_to_dot_only(
    monkeypatch, auth_on, caplog
) -> None:
    """When every matched cluster has a placeholder label, the summary
    suppression happens silently in the response (labels_are_real=False,
    summary=''). The reducer now emits an INFO log so operators can see
    how often users hit the legibility-suppressed path."""
    monkeypatch.setattr(
        search_module,
        "embed_texts",
        lambda texts, embed_model="x": np.zeros((len(texts), 384), dtype=np.float32),
    )
    points_rows = [_points_row(f"p{i}", "t", 3) for i in range(3)]
    cluster_rows = [(3, "Cluster 3")]
    cursor = _FakeCursor(
        project_row=("all-MiniLM-L6-v2",),
        points_rows=points_rows,
        cluster_rows=cluster_rows,
    )
    monkeypatch.setattr(search_module, "connect", lambda: _fake_connect_ctx(cursor))

    with caplog.at_level("INFO", logger="app.search"):
        resp = _client().post(
            "/search",
            headers=_hdr(),
            json={
                "project_id": "11111111-1111-1111-1111-111111111111",
                "tenant_id": "22222222-2222-2222-2222-222222222222",
                "query": "anything",
            },
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["labels_are_real"] is False
    assert body["summary"] == ""
    assert any(
        "region summary degraded" in r.message for r in caplog.records
    ), caplog.text


def test_search_requires_auth(monkeypatch) -> None:
    """Without the shared secret header, /search returns 401 like every other
    web→reducer route."""
    monkeypatch.setattr(auth, "REDUCER_SHARED_SECRET", "test-secret")
    resp = _client().post(
        "/search",
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "query": "anything",
        },
    )
    assert resp.status_code == 401
