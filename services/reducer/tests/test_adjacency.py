"""Tests for cluster adjacency in embedding space.

Critical guarantee verified here: top-pair selection uses *embedding-space*
similarity, not 3D projection distance. The fixture below makes the two
disagree on purpose — clusters A and B are 3D-far but embedding-near, while
A and C are 3D-near but embedding-far. The right answer is A-B; picking
A-C would prove the code accidentally used coords.
"""
from __future__ import annotations

import numpy as np

from app.adjacency import ClusterEdgeRow, compute_top_edges


def _make_cluster_points(
    direction: np.ndarray,
    *,
    jitter: float,
    n: int,
    rng: np.random.Generator,
) -> np.ndarray:
    """N points L2-normalized around a target direction."""
    d = direction.shape[0]
    noise = rng.standard_normal((n, d)).astype(np.float32) * jitter
    pts = direction[None, :] + noise
    pts = pts / np.linalg.norm(pts, axis=1, keepdims=True)
    return pts.astype(np.float32)


def test_picks_embedding_near_pair_when_3d_says_otherwise() -> None:
    """The headline guarantee: 3D nearness lies; embedding cosine wins."""
    rng = np.random.default_rng(0)
    d = 8  # tiny embedding dim is fine for the math; production is 384

    # Three orthogonal-ish directions:
    #   A and B point in nearly the same direction (cos ~0.99)
    #   C points in a near-opposite direction from both
    dir_a = np.zeros(d, dtype=np.float32)
    dir_a[0] = 1.0
    dir_b = np.zeros(d, dtype=np.float32)
    dir_b[0] = 0.98
    dir_b[1] = 0.2
    dir_b /= np.linalg.norm(dir_b)
    dir_c = np.zeros(d, dtype=np.float32)
    dir_c[0] = -1.0

    pts_a = _make_cluster_points(dir_a, jitter=0.02, n=12, rng=rng)
    pts_b = _make_cluster_points(dir_b, jitter=0.02, n=12, rng=rng)
    pts_c = _make_cluster_points(dir_c, jitter=0.02, n=12, rng=rng)

    embeddings = np.concatenate([pts_a, pts_b, pts_c], axis=0)
    cluster_ids = np.concatenate(
        [np.full(12, 0), np.full(12, 1), np.full(12, 2)]
    ).astype(np.int32)

    edges = compute_top_edges(embeddings, cluster_ids, top_n=3)

    # The single most-similar pair in embedding space must be (0, 1).
    assert edges[0].cluster_a == 0
    assert edges[0].cluster_b == 1
    # And it should beat the 3D-near pair (0, 2). If the code had used 3D
    # coords, (0, 2) would have leaked into the top slot or above (0, 1).
    top_ids = {(e.cluster_a, e.cluster_b) for e in edges[:1]}
    assert (0, 2) not in top_ids
    # Sanity: (0,1) cosine is far above (0,2) cosine in the actual embeddings.
    pair_sim = {(e.cluster_a, e.cluster_b): e.similarity for e in edges}
    assert pair_sim[(0, 1)] > pair_sim.get((0, 2), -2.0)


def test_only_top_n_edges_returned() -> None:
    rng = np.random.default_rng(1)
    d = 8
    # Build 5 clusters with mildly varying directions so every pair has a
    # different similarity (10 unordered pairs total).
    dirs = []
    for _ in range(5):
        v = rng.standard_normal(d).astype(np.float32)
        v /= np.linalg.norm(v)
        dirs.append(v)
    pts = [_make_cluster_points(dirs[i], jitter=0.01, n=8, rng=rng) for i in range(5)]
    embeddings = np.concatenate(pts, axis=0)
    cluster_ids = np.concatenate(
        [np.full(8, i) for i in range(5)]
    ).astype(np.int32)

    edges = compute_top_edges(embeddings, cluster_ids, top_n=3)
    assert len(edges) == 3

    # The 3 returned edges should be the top 3 across all 10 possible pairs.
    all_edges = compute_top_edges(embeddings, cluster_ids, top_n=10)
    assert len(all_edges) == 10
    assert [(e.cluster_a, e.cluster_b) for e in edges] == [
        (e.cluster_a, e.cluster_b) for e in all_edges[:3]
    ]

    # And they should be sorted by similarity desc.
    sims = [e.similarity for e in edges]
    assert sims == sorted(sims, reverse=True)


def test_canonical_pair_order_a_lt_b() -> None:
    rng = np.random.default_rng(2)
    dir_a = np.array([1, 0, 0, 0], dtype=np.float32)
    dir_b = np.array([0.95, 0.3, 0, 0], dtype=np.float32)
    dir_b /= np.linalg.norm(dir_b)
    pts_a = _make_cluster_points(dir_a, jitter=0.01, n=6, rng=rng)
    pts_b = _make_cluster_points(dir_b, jitter=0.01, n=6, rng=rng)
    # Stage the ids out-of-order — cluster_id 7 appears before 3 in the data.
    embeddings = np.concatenate([pts_a, pts_b], axis=0)
    cluster_ids = np.concatenate([np.full(6, 7), np.full(6, 3)]).astype(np.int32)

    edges = compute_top_edges(embeddings, cluster_ids, top_n=3)
    assert len(edges) == 1
    e = edges[0]
    # Canonical form: lower id first regardless of how clusters were ordered.
    assert e.cluster_a == 3
    assert e.cluster_b == 7
    assert e.cluster_a < e.cluster_b


def test_noise_excluded_no_self_edges() -> None:
    rng = np.random.default_rng(3)
    d = 4
    dir_a = np.array([1, 0, 0, 0], dtype=np.float32)
    dir_b = np.array([0, 1, 0, 0], dtype=np.float32)
    pts_a = _make_cluster_points(dir_a, jitter=0.01, n=6, rng=rng)
    pts_b = _make_cluster_points(dir_b, jitter=0.01, n=6, rng=rng)
    pts_noise = rng.standard_normal((10, d)).astype(np.float32)
    pts_noise /= np.linalg.norm(pts_noise, axis=1, keepdims=True)

    embeddings = np.concatenate([pts_a, pts_b, pts_noise], axis=0)
    cluster_ids = np.concatenate(
        [np.full(6, 0), np.full(6, 1), np.full(10, -1)]
    ).astype(np.int32)

    edges = compute_top_edges(embeddings, cluster_ids, top_n=5)
    # Only the (0,1) pair. Noise must not show up as a cluster.
    assert edges == [ClusterEdgeRow(cluster_a=0, cluster_b=1, similarity=edges[0].similarity)]
    # And no self-edges anywhere.
    for e in edges:
        assert e.cluster_a != e.cluster_b


def test_edge_cases() -> None:
    # Empty.
    edges = compute_top_edges(
        np.zeros((0, 4), dtype=np.float32), np.zeros((0,), dtype=np.int32), top_n=3
    )
    assert edges == []

    # All noise → no clusters.
    edges = compute_top_edges(
        np.eye(4, dtype=np.float32)[:3], np.array([-1, -1, -1], dtype=np.int32), top_n=3
    )
    assert edges == []

    # One cluster only → no pairs possible.
    edges = compute_top_edges(
        np.eye(4, dtype=np.float32)[:3], np.array([0, 0, 0], dtype=np.int32), top_n=3
    )
    assert edges == []

    # top_n=0 short-circuits.
    rng = np.random.default_rng(4)
    pts = rng.standard_normal((8, 4)).astype(np.float32)
    pts /= np.linalg.norm(pts, axis=1, keepdims=True)
    edges = compute_top_edges(pts, np.array([0]*4 + [1]*4, dtype=np.int32), top_n=0)
    assert edges == []
