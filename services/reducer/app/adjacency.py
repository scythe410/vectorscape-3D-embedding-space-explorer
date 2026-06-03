"""Cluster adjacency in *embedding* space.

The faint connecting edges we draw between clusters in the engine must
reflect semantic adjacency, not visual adjacency. UMAP/PaCMAP distort
global distances aggressively — two clusters can land far apart in the 3D
projection while being immediate neighbors in the 384-dim embedding space
that drove the clustering in the first place. So:

  - compute each cluster's centroid as the L2-normalized mean of its
    member embeddings (a unit "direction" in the embedding space);
  - rank cluster pairs by cosine similarity (== dot product, since the
    direction vectors are unit length);
  - return the top-N most similar pairs.

The engine just draws what it's told; this module is the ground truth.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ClusterEdgeRow:
    cluster_a: int  # always the lower cluster_id (canonical form)
    cluster_b: int  # always the higher cluster_id
    similarity: float  # cosine in [-1, 1]


def _unit_centroids(
    embeddings: np.ndarray, cluster_ids: np.ndarray
) -> tuple[list[int], np.ndarray]:
    """Return (sorted_cluster_ids, unit_centroids_matrix).

    Embeddings are MiniLM-normalized; the mean of unit vectors is not itself
    unit, so we renormalize. Empty or zero-norm clusters are dropped.
    """
    unique = sorted(int(c) for c in np.unique(cluster_ids) if int(c) != -1)
    keep_ids: list[int] = []
    centroids: list[np.ndarray] = []
    for cid in unique:
        mask = cluster_ids == cid
        if not mask.any():
            continue
        mean = embeddings[mask].mean(axis=0).astype(np.float32)
        norm = float(np.linalg.norm(mean))
        if norm == 0.0:
            continue
        centroids.append(mean / norm)
        keep_ids.append(cid)
    if not centroids:
        return [], np.zeros((0, embeddings.shape[1] if embeddings.ndim == 2 else 0))
    return keep_ids, np.stack(centroids).astype(np.float32)


def compute_top_edges(
    embeddings: np.ndarray,
    cluster_ids: np.ndarray,
    *,
    top_n: int = 3,
) -> list[ClusterEdgeRow]:
    """Top-N most-similar cluster pairs by cosine in embedding space.

    Args:
      embeddings: (N, D) float32 array of per-point embeddings.
      cluster_ids: (N,) int array; -1 marks noise (excluded).
      top_n: cap on the returned edge count. Default 3 — the design target
        is "2-3 faint edges, never a hairball." Pass 0 for an empty list.

    Returns: edges sorted by similarity desc. cluster_a < cluster_b in
    every row so pairs are canonical regardless of which side appears
    first in the input. Empty when fewer than two named clusters exist.
    """
    if top_n <= 0:
        return []
    if embeddings.ndim != 2 or embeddings.shape[0] == 0:
        return []
    if cluster_ids.shape[0] != embeddings.shape[0]:
        raise ValueError("cluster_ids and embeddings length mismatch")

    ids, unit = _unit_centroids(embeddings, cluster_ids)
    k = len(ids)
    if k < 2:
        return []

    # Dot product of unit vectors == cosine similarity. (k, k) is tiny — even
    # 100 clusters is 10k entries, well below any concern.
    sim = unit @ unit.T

    # Upper triangle (i < j) — every unordered pair once.
    pairs: list[ClusterEdgeRow] = []
    for i in range(k):
        for j in range(i + 1, k):
            a = ids[i]
            b = ids[j]
            cluster_a = min(a, b)
            cluster_b = max(a, b)
            pairs.append(
                ClusterEdgeRow(
                    cluster_a=cluster_a,
                    cluster_b=cluster_b,
                    similarity=float(sim[i, j]),
                )
            )
    # Sort by similarity desc, with (cluster_a asc, cluster_b asc) tie-break for
    # determinism across runs / Python versions.
    pairs.sort(key=lambda e: (-e.similarity, e.cluster_a, e.cluster_b))
    return pairs[:top_n]
