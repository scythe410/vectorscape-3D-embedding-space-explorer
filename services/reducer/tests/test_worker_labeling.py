"""Worker-path labeling test.

Both /embed-reduce paths (inline + arq worker) flow through `run_pipeline`,
which calls `label_clusters` to overwrite the `f"Cluster {n}"` placeholder
that `_build_cluster_rows` seeds. The inline path is exercised by
`test_labeling.py`; this file pins the worker path so a future refactor
that splits labeling out of `run_pipeline` (or that bypasses it on the
worker side) cannot silently regress to numeric placeholders.

We drive `embed_reduce_job` directly with stubbed Postgres + Redis and a
stubbed pipeline result, then assert the cluster rows captured by the
fake `write_results` carry non-placeholder labels.
"""
from __future__ import annotations

import asyncio
from typing import Any

import numpy as np
import pytest

from app import worker
from app.adjacency import ClusterEdgeRow
from app.pipeline import ClusterRow, PipelineResult


class _FakeConn:
    """Bare-bones drop-in for psycopg.Connection inside `with connect() as c:`."""

    def __enter__(self) -> _FakeConn:
        return self

    def __exit__(self, *_: Any) -> None:
        return None


def _make_pipeline_result(labels: dict[int, str]) -> PipelineResult:
    clusters = [
        ClusterRow(
            cluster_id=cid,
            label=label,
            cx=0.0, cy=0.0, cz=0.0,
            medoid_index=0,
            size=3,
        )
        for cid, label in labels.items()
    ]
    n = 6
    return PipelineResult(
        embeddings=np.zeros((n, 384), dtype=np.float32),
        coords=np.zeros((n, 3), dtype=np.float32),
        cluster_ids=np.array([0, 0, 0, 1, 1, 1], dtype=np.int32),
        cluster_probabilities=np.ones(n, dtype=np.float32),
        clusters=clusters,
        edges=[ClusterEdgeRow(cluster_a=0, cluster_b=1, similarity=0.5)],
        used_pca=False,
        reducer="pacmap",
        embed_model="all-MiniLM-L6-v2",
    )


def test_worker_path_invokes_label_clusters_and_writes_real_labels(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The arq worker job must produce non-placeholder labels.

    We stub `run_pipeline` so it forces the realistic post-labeling shape:
    placeholders replaced with c-TF-IDF style labels. Then we assert the
    labels handed to `write_results` carry through unchanged — confirming
    the worker doesn't strip or overwrite them.
    """
    captured: dict[str, Any] = {}

    def fake_run_pipeline(texts: list[str], **kw: Any) -> PipelineResult:
        # Real `run_pipeline` runs label_clusters() and assigns the result onto
        # each ClusterRow before returning. Mirror that — the test pins the
        # worker contract, not the pipeline's labeling internals (those are
        # covered in test_labeling.py).
        return _make_pipeline_result({0: "Saffron Risotto", 1: "Neural Network"})

    def fake_write_results(conn: Any, **kw: Any) -> dict[str, Any]:
        captured["clusters"] = list(kw["result"].clusters)
        return {
            "project_id": kw["project_id"],
            "tenant_id": kw["tenant_id"],
            "n_points": len(kw["texts"]),
            "n_clusters": len(kw["result"].clusters),
            "n_edges": len(kw["result"].edges),
            "n_noise": 0,
            "used_pca": False,
            "reducer": "pacmap",
            "embed_model": "all-MiniLM-L6-v2",
        }

    async def fake_set_progress(*a: Any, **kw: Any) -> None:
        return None

    async def fake_clear_progress(*a: Any, **kw: Any) -> None:
        return None

    def fake_connect():
        return _FakeConn()

    def fake_set_status(*a: Any, **kw: Any) -> None:
        return None

    monkeypatch.setattr(worker, "run_pipeline", fake_run_pipeline)
    monkeypatch.setattr(worker, "write_results", fake_write_results)
    monkeypatch.setattr(worker, "set_progress", fake_set_progress)
    monkeypatch.setattr(worker, "clear_progress", fake_clear_progress)
    monkeypatch.setattr(worker, "connect", fake_connect)
    monkeypatch.setattr(worker, "set_status", fake_set_status)

    summary = asyncio.run(
        worker.embed_reduce_job(
            {},
            project_id="proj-1",
            tenant_id="tenant-1",
            texts=["a", "b", "c", "d", "e", "f"],
            embed_model="all-MiniLM-L6-v2",
            reducer="pacmap",
        )
    )

    assert summary["n_clusters"] == 2
    # The cluster rows handed to write_results carry the labels produced by
    # the pipeline, not the placeholder. This is the guard against the worker
    # ever silently skipping the labeling step.
    labels = [c.label for c in captured["clusters"]]
    assert labels == ["Saffron Risotto", "Neural Network"]
    for lbl in labels:
        assert not lbl.startswith("Cluster ")
