"""Reduction + clustering pipeline.

embed -> (conditional PCA-100) -> PaCMAP/UMAP to 3D -> HDBSCAN -> medoids -> normalize.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .config import COORD_SCALE, DEFAULT_EMBED_MODEL, DEFAULT_REDUCER, PCA_THRESHOLD
from .embeddings import embed_texts
from .labeling import label_clusters


@dataclass
class ClusterRow:
    cluster_id: int  # -1 for HDBSCAN noise
    label: str
    cx: float
    cy: float
    cz: float
    medoid_index: int  # index into points array
    size: int


@dataclass
class PipelineResult:
    embeddings: np.ndarray  # (N, 384) float32
    coords: np.ndarray  # (N, 3) float32, normalized to engine scale
    cluster_ids: np.ndarray  # (N,) int32 (-1 = noise)
    cluster_probabilities: np.ndarray  # (N,) float32 in [0, 1]
    clusters: list[ClusterRow]
    used_pca: bool
    reducer: str
    embed_model: str


def _maybe_pca(x: np.ndarray, target_dim: int = 100) -> tuple[np.ndarray, bool]:
    """Apply PCA-100 only at/above PCA_THRESHOLD points as a speed guard."""
    n = x.shape[0]
    if n < PCA_THRESHOLD or x.shape[1] <= target_dim:
        return x, False
    from sklearn.decomposition import PCA

    pca = PCA(n_components=target_dim, random_state=0)
    return pca.fit_transform(x).astype(np.float32), True


def _reduce_to_3d(x: np.ndarray, reducer: str) -> np.ndarray:
    n = x.shape[0]
    if n < 4:
        # Degenerate — pad with zeros so the engine still gets (N, 3).
        out = np.zeros((n, 3), dtype=np.float32)
        if n > 0:
            out[:, 0] = np.arange(n, dtype=np.float32)
        return out

    if reducer == "umap":
        import umap  # type: ignore

        nn = min(15, max(2, n - 1))
        m = umap.UMAP(n_components=3, n_neighbors=nn, random_state=42, init="spectral")
        return m.fit_transform(x).astype(np.float32)

    # default: pacmap
    import pacmap  # type: ignore

    nn = min(10, max(2, n - 1))
    m = pacmap.PaCMAP(n_components=3, n_neighbors=nn, random_state=42, verbose=False)
    return m.fit_transform(x, init="pca").astype(np.float32)


def _cluster(
    coords: np.ndarray,
    min_cluster_size: int | None = None,
    selection_method: str = "eom",
) -> tuple[np.ndarray, np.ndarray]:
    """Return (cluster_ids, probabilities). Noise points get id=-1."""
    n = coords.shape[0]
    if n < 5:
        return np.full(n, -1, dtype=np.int32), np.zeros(n, dtype=np.float32)
    import hdbscan  # type: ignore

    # Default scales gently with n; floor of 5 keeps small CSVs useful. The
    # heuristic over-merges on corpora with many small genuine clusters
    # (e.g. 20 newsgroups), so the host can override.
    mcs = min_cluster_size if min_cluster_size else max(5, int(round(np.sqrt(n) / 2)))
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=mcs,
        cluster_selection_method=selection_method,
        prediction_data=False,
    )
    labels = clusterer.fit_predict(coords)
    probs = clusterer.probabilities_
    return labels.astype(np.int32), probs.astype(np.float32)


def _normalize_coords(coords: np.ndarray, scale: float = COORD_SCALE) -> np.ndarray:
    """Center on 0, scale so the longest axis half-extent ~= `scale`."""
    if coords.size == 0:
        return coords.astype(np.float32)
    centered = coords - coords.mean(axis=0, keepdims=True)
    half_extent = float(np.max(np.abs(centered)))
    if half_extent == 0:
        return centered.astype(np.float32)
    return (centered * (scale / half_extent)).astype(np.float32)


def _build_cluster_rows(
    coords: np.ndarray, cluster_ids: np.ndarray, texts: list[str]
) -> tuple[list[ClusterRow], dict[int, list[str]]]:
    """Return (cluster_rows_with_placeholder_labels, medoid_snippets_by_cluster).

    Snippets are the medoid plus up to two next-nearest-to-centroid items —
    feed for the optional LLM labeling pass.
    """
    rows: list[ClusterRow] = []
    snippets: dict[int, list[str]] = {}
    unique = sorted(int(c) for c in np.unique(cluster_ids) if int(c) != -1)
    for cid in unique:
        mask = cluster_ids == cid
        members = coords[mask]
        centroid = members.mean(axis=0)
        dists = np.linalg.norm(members - centroid, axis=1)
        order = np.argsort(dists)
        global_indices = np.flatnonzero(mask)
        sel = [int(global_indices[order[i]]) for i in range(min(3, len(order)))]
        medoid_idx = sel[0]
        snippets[cid] = [texts[i] for i in sel]
        rows.append(
            ClusterRow(
                cluster_id=cid,
                label=f"Cluster {cid}",  # placeholder; replaced by label_clusters.
                cx=float(centroid[0]),
                cy=float(centroid[1]),
                cz=float(centroid[2]),
                medoid_index=medoid_idx,
                size=int(mask.sum()),
            )
        )
    return rows, snippets


def run_pipeline(
    texts: list[str],
    embed_model: str = DEFAULT_EMBED_MODEL,
    reducer: str = DEFAULT_REDUCER,
    min_cluster_size: int | None = None,
    cluster_selection_method: str = "eom",
) -> PipelineResult:
    if not texts:
        raise ValueError("texts is empty")
    reducer = (reducer or DEFAULT_REDUCER).lower()
    if reducer not in {"pacmap", "umap"}:
        raise ValueError(f"unknown reducer: {reducer}")

    embeddings = embed_texts(texts, embed_model=embed_model)
    reduced_in, used_pca = _maybe_pca(embeddings)
    coords_raw = _reduce_to_3d(reduced_in, reducer)
    coords = _normalize_coords(coords_raw)
    cluster_ids, probs = _cluster(
        coords,
        min_cluster_size=min_cluster_size,
        selection_method=cluster_selection_method,
    )
    clusters, medoid_snippets = _build_cluster_rows(coords, cluster_ids, texts)
    labels = label_clusters(
        texts, cluster_ids, medoid_snippets_by_cluster=medoid_snippets
    )
    for row in clusters:
        row.label = labels.get(row.cluster_id, row.label)

    return PipelineResult(
        embeddings=embeddings,
        coords=coords,
        cluster_ids=cluster_ids,
        cluster_probabilities=probs,
        clusters=clusters,
        used_pca=used_pca,
        reducer=reducer,
        embed_model=embed_model,
    )
