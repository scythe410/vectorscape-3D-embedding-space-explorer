"""Tests for /bridge — focused on the boundary-point retrieval contract.

The prompt-construction invariants (fencing, defang, control-char strip) are
already covered by `test_prompt_injection.py`. Here we prove the *data path*:

  1. Both `_fetch_cluster` SQL calls bind project_id AND tenant_id — bridge
     can't be tricked into reading a different tenant's cluster.

  2. Both `_fetch_boundary` SQL calls bind project_id AND tenant_id AND the
     specific source_cluster — boundary points come from the requested
     cluster only, scoped to the requesting tenant.

  3. The boundary query orders by cosine distance to the *other* cluster's
     medoid embedding (the `<=>` operator) and limits to BOUNDARY_K.

  4. cluster_a == cluster_b is rejected with 400.

  5. A missing cluster returns 404 — never a 500 with a raw DB error.

  6. A cluster medoid with NULL embedding returns 409 — bridge can't run.

We do not call OpenAI / Gemini; `_summarize` is patched to a fixed string.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import auth
from app import bridge as bridge_module
from app.bridge import BOUNDARY_K
from app.main import app

# ---- Fake DB primitives ---------------------------------------------------


class _ClusterFetchScript:
    """One scripted return per _fetch_cluster SQL call, in order."""

    def __init__(self, rows: list[tuple[Any, ...] | None]) -> None:
        self._rows = list(rows)
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def take(self, sql: str, params: tuple[Any, ...]) -> tuple[Any, ...] | None:
        self.calls.append((sql, params))
        return self._rows.pop(0) if self._rows else None


class _BoundaryFetchScript:
    """One scripted return per _fetch_boundary SQL call, in order."""

    def __init__(self, rowsets: list[list[tuple[Any, ...]]]) -> None:
        self._sets = list(rowsets)
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def take(self, sql: str, params: tuple[Any, ...]) -> list[tuple[Any, ...]]:
        self.calls.append((sql, params))
        return self._sets.pop(0) if self._sets else []


class _Cursor:
    def __init__(
        self,
        cluster_script: _ClusterFetchScript,
        boundary_script: _BoundaryFetchScript,
    ) -> None:
        self._cluster = cluster_script
        self._boundary = boundary_script
        self._mode: str = ""
        # Stash the last (sql, params) so fetch* can route correctly.
        self._last: tuple[str, tuple[Any, ...]] | None = None

    def execute(self, sql: str, params: tuple[Any, ...]) -> _Cursor:
        low = sql.lower()
        # _fetch_cluster joins clusters and points; the SQL contains both.
        # _fetch_boundary only reads from points and uses `<=>`.
        if "from public.clusters" in low and "left join public.points" in low:
            self._mode = "cluster"
            self._cluster.calls.append((sql, params))
        elif "from public.points" in low and "<=>" in low:
            self._mode = "boundary"
            self._boundary.calls.append((sql, params))
        else:
            self._mode = "?"
        self._last = (sql, params)
        return self

    def fetchone(self) -> tuple[Any, ...] | None:
        if self._mode == "cluster":
            # Don't double-record; the routing call already appended above.
            row = self._cluster._rows.pop(0) if self._cluster._rows else None
            return row
        return None

    def fetchall(self) -> list[tuple[Any, ...]]:
        if self._mode == "boundary":
            return self._boundary._sets.pop(0) if self._boundary._sets else []
        return []


class _Conn:
    def __init__(self, cursor: _Cursor) -> None:
        self._cursor = cursor

    def execute(self, sql: str, params: tuple[Any, ...]) -> _Cursor:
        return self._cursor.execute(sql, params)


@contextmanager
def _connect_ctx(cursor: _Cursor):
    yield _Conn(cursor)


# ---- Fixtures -------------------------------------------------------------


@pytest.fixture
def auth_on(monkeypatch) -> None:
    monkeypatch.setattr(auth, "REDUCER_SHARED_SECRET", "test-secret")


@pytest.fixture(autouse=True)
def stub_summarize(monkeypatch):
    """Never call a real LLM in these tests."""
    monkeypatch.setattr(
        bridge_module, "_summarize", lambda _prompt: ("stubbed summary", "stub")
    )


def _client() -> TestClient:
    return TestClient(app)


def _hdr() -> dict[str, str]:
    return {"X-Reducer-Secret": "test-secret"}


# Helpers for building cluster rows that match the SELECT shape in
# `_fetch_cluster`: (cluster_id, label, cx, cy, cz, size, medoid_id, medoid_text, medoid_embedding).
def _row(
    cid: int,
    label: str = "Region",
    cx: float = 0.0,
    cy: float = 0.0,
    cz: float = 0.0,
    size: int = 10,
    medoid_id: str | None = "med",
    medoid_text: str | None = "center",
    medoid_embedding: list[float] | None = None,
) -> tuple[Any, ...]:
    if medoid_embedding is None:
        medoid_embedding = [0.1] * 384
    return (cid, label, cx, cy, cz, size, medoid_id, medoid_text, medoid_embedding)


def _boundary_rows() -> list[tuple[Any, ...]]:
    # _fetch_boundary returns (id, text, x, y, z).
    return [
        (f"p{i}", f"boundary text {i}", float(i), float(i), float(i))
        for i in range(BOUNDARY_K)
    ]


# ---- Tests ----------------------------------------------------------------


def test_bridge_rejects_same_cluster_for_a_and_b(auth_on) -> None:
    resp = _client().post(
        "/bridge",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "cluster_a": 5,
            "cluster_b": 5,
        },
    )
    assert resp.status_code == 400
    assert "differ" in resp.json()["detail"].lower()


def test_bridge_404_when_either_cluster_not_found(auth_on, monkeypatch) -> None:
    # Cluster A found; cluster B missing — must 404 (never leak existence
    # via a 5xx).
    cluster_script = _ClusterFetchScript([_row(3), None])
    boundary_script = _BoundaryFetchScript([])
    cursor = _Cursor(cluster_script, boundary_script)
    monkeypatch.setattr(bridge_module, "connect", lambda: _connect_ctx(cursor))

    resp = _client().post(
        "/bridge",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "cluster_a": 3,
            "cluster_b": 7,
        },
    )
    assert resp.status_code == 404
    detail = resp.json()["detail"].lower()
    assert "cluster" in detail and "7" in detail


def test_bridge_409_when_medoid_embedding_is_null(auth_on, monkeypatch) -> None:
    # If the medoid row has no embedding (e.g. mid-migration), we cannot run
    # the cosine search — must surface a 409, not crash on `embedding <=> %s`.
    a = _row(1, medoid_embedding=None)
    a = (*a[:8], None)  # explicitly NULL the embedding column
    b = _row(2)
    cluster_script = _ClusterFetchScript([a, b])
    boundary_script = _BoundaryFetchScript([])
    cursor = _Cursor(cluster_script, boundary_script)
    monkeypatch.setattr(bridge_module, "connect", lambda: _connect_ctx(cursor))

    resp = _client().post(
        "/bridge",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "cluster_a": 1,
            "cluster_b": 2,
        },
    )
    assert resp.status_code == 409
    assert "embedding" in resp.json()["detail"].lower()


def test_bridge_boundary_queries_are_tenant_scoped(auth_on, monkeypatch) -> None:
    """The headline guarantee: a request can't be tricked into reading
    boundary points from another tenant's cluster. Each boundary SQL must
    bind tenant_id."""
    a = _row(1, medoid_embedding=[0.1] * 384, medoid_id="ma", medoid_text="ta")
    b = _row(2, medoid_embedding=[0.2] * 384, medoid_id="mb", medoid_text="tb")
    cluster_script = _ClusterFetchScript([a, b])
    boundary_script = _BoundaryFetchScript([_boundary_rows(), _boundary_rows()])
    cursor = _Cursor(cluster_script, boundary_script)
    monkeypatch.setattr(bridge_module, "connect", lambda: _connect_ctx(cursor))

    tenant = "22222222-2222-2222-2222-222222222222"
    resp = _client().post(
        "/bridge",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": tenant,
            "cluster_a": 1,
            "cluster_b": 2,
        },
    )
    assert resp.status_code == 200, resp.text

    # Both cluster fetches bound the tenant id.
    assert len(cluster_script.calls) == 2
    for sql, params in cluster_script.calls:
        assert "tenant_id" in sql.lower()
        assert tenant in params

    # Both boundary fetches bound the tenant id AND each was scoped to its
    # own source cluster.
    assert len(boundary_script.calls) == 2
    bound_clusters = []
    for sql, params in boundary_script.calls:
        low = sql.lower()
        assert "tenant_id" in low
        assert "cluster_id" in low
        # The SQL uses `<=>` (pgvector cosine distance) — that's the contract.
        assert "<=>" in low
        # `limit` is BOUNDARY_K (4).
        assert "limit" in low
        assert tenant in params
        # Last parameter is the LIMIT value.
        assert params[-1] == BOUNDARY_K
        # The cluster_id parameter is one of {1, 2} depending on direction.
        bound_clusters.append(params[2])

    # Each direction queried its own cluster.
    assert sorted(bound_clusters) == [1, 2]


def test_bridge_boundary_uses_other_cluster_medoid_as_search_anchor(
    auth_on, monkeypatch
) -> None:
    """Boundary semantics: the points in cluster A nearest to cluster B's
    *medoid embedding* (not B's centroid coords). The SQL passes B's
    medoid embedding as the cosine target for A's boundary, and vice versa.
    """
    embed_a = [0.1] * 384
    embed_b = [0.9] * 384
    a = _row(1, medoid_embedding=embed_a, medoid_id="ma", medoid_text="ta")
    b = _row(2, medoid_embedding=embed_b, medoid_id="mb", medoid_text="tb")
    cluster_script = _ClusterFetchScript([a, b])
    boundary_script = _BoundaryFetchScript([_boundary_rows(), _boundary_rows()])
    cursor = _Cursor(cluster_script, boundary_script)
    monkeypatch.setattr(bridge_module, "connect", lambda: _connect_ctx(cursor))

    resp = _client().post(
        "/bridge",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "cluster_a": 1,
            "cluster_b": 2,
        },
    )
    assert resp.status_code == 200

    # First boundary call is for cluster A (params[2] == 1) and its anchor
    # embedding is cluster B's medoid (embed_b). Second is the inverse.
    first_sql, first_params = boundary_script.calls[0]
    second_sql, second_params = boundary_script.calls[1]
    assert first_params[2] == 1  # source_cluster
    assert first_params[3] == embed_b  # target_embedding (B's medoid)
    assert second_params[2] == 2
    assert second_params[3] == embed_a


def test_bridge_response_includes_medoid_and_boundary_examples(
    auth_on, monkeypatch
) -> None:
    """Each side of the response carries the medoid as the first cited
    example (role='medoid') and then the boundary points (role='boundary')."""
    a = _row(1, medoid_id="med-a", medoid_text="center-a", medoid_embedding=[0.1] * 384)
    b = _row(2, medoid_id="med-b", medoid_text="center-b", medoid_embedding=[0.9] * 384)
    cluster_script = _ClusterFetchScript([a, b])
    boundary_script = _BoundaryFetchScript([_boundary_rows(), _boundary_rows()])
    cursor = _Cursor(cluster_script, boundary_script)
    monkeypatch.setattr(bridge_module, "connect", lambda: _connect_ctx(cursor))

    resp = _client().post(
        "/bridge",
        headers=_hdr(),
        json={
            "project_id": "11111111-1111-1111-1111-111111111111",
            "tenant_id": "22222222-2222-2222-2222-222222222222",
            "cluster_a": 1,
            "cluster_b": 2,
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["model"] == "stub"
    assert body["summary"] == "stubbed summary"

    ex_a = body["examples_a"]
    # 1 medoid + BOUNDARY_K boundary = 1 + 4 = 5 examples per side. Boundary
    # rows in this fixture don't overlap the medoid id, so no dedupe.
    assert len(ex_a) == 1 + BOUNDARY_K
    assert ex_a[0]["role"] == "medoid"
    assert ex_a[0]["id"] == "med-a"
    assert ex_a[0]["text"] == "center-a"
    for ex in ex_a[1:]:
        assert ex["role"] == "boundary"
        assert ex["cluster_id"] == 1
