"""Unit tests for the reducer pipeline's pure helpers.

The full `run_pipeline` end-to-end (embed → reduce → cluster → label) is
exercised in Phase 3 integration tests; this file targets the small
pure-Python pieces where the load-bearing invariants live:

- conditional PCA gate at the n=20k boundary
- HDBSCAN early-return for n < 5
- coordinate normalization to ±COORD_SCALE
- medoid-of-cluster selection (nearest member to centroid)
- input validation in run_pipeline (empty, bad reducer)
- _reduce_to_3d degenerate-n fallback
"""

from __future__ import annotations

import numpy as np
import pytest

from app.config import COORD_SCALE, PCA_THRESHOLD
from app.pipeline import (
    _build_cluster_rows,
    _cluster,
    _maybe_pca,
    _normalize_coords,
    _reduce_to_3d,
    run_pipeline,
)


# ----------------------------------------------------------------------------
# _maybe_pca — the conditional 20k gate
# ----------------------------------------------------------------------------


def test_maybe_pca_skips_when_n_well_below_threshold():
    x = np.random.default_rng(0).standard_normal((50, 384)).astype(np.float32)
    out, used = _maybe_pca(x)
    assert used is False
    assert out.shape == x.shape
    # Should be the same array (not just same shape — the early return must
    # not allocate or transform).
    assert out is x


def test_maybe_pca_skips_just_below_the_threshold():
    # n = 19_999 → still below the gate → no PCA.
    n = PCA_THRESHOLD - 1
    x = np.random.default_rng(1).standard_normal((n, 384)).astype(np.float32)
    out, used = _maybe_pca(x)
    assert used is False
    assert out.shape == (n, 384)
    assert out is x


def test_maybe_pca_skips_when_already_at_or_below_target_dim():
    # Even at n = PCA_THRESHOLD, if dims are already ≤ 100 we don't reduce.
    n = PCA_THRESHOLD
    x = np.random.default_rng(2).standard_normal((n, 50)).astype(np.float32)
    out, used = _maybe_pca(x)
    assert used is False
    assert out is x


def test_maybe_pca_fires_at_the_threshold():
    """The spec is explicit: at/above 20k the PCA-100 speed guard kicks in.

    Runs PCA on (20k, 384) — ~1-2s with sklearn's randomized SVD. Kept in
    the default suite because the test target *is* the threshold behavior.
    """
    n = PCA_THRESHOLD
    rng = np.random.default_rng(3)
    x = rng.standard_normal((n, 384)).astype(np.float32)
    out, used = _maybe_pca(x)
    assert used is True
    assert out.shape == (n, 100)
    # PCA must allocate a new array (the original 384-dim isn't a slice of it).
    assert out is not x


# ----------------------------------------------------------------------------
# _normalize_coords — center on origin, scale longest half-extent to COORD_SCALE
# ----------------------------------------------------------------------------


def test_normalize_centers_on_zero():
    rng = np.random.default_rng(4)
    coords = rng.uniform(-100, 100, size=(200, 3)).astype(np.float32)
    coords += np.array([12.5, -7.0, 33.3], dtype=np.float32)
    out = _normalize_coords(coords)
    # Mean must be effectively zero after re-centering.
    assert np.allclose(out.mean(axis=0), 0.0, atol=1e-4)


def test_normalize_longest_half_extent_equals_coord_scale():
    rng = np.random.default_rng(5)
    coords = rng.uniform(-3, 3, size=(500, 3)).astype(np.float32)
    out = _normalize_coords(coords)
    longest = float(np.max(np.abs(out)))
    # The longest half-extent on any axis must equal COORD_SCALE (= 60).
    assert longest == pytest.approx(COORD_SCALE, rel=1e-4)


def test_normalize_handles_zero_extent_input_without_divide_by_zero():
    # All points at the origin → half_extent is 0; function returns the
    # centered (still-zero) array without trying to scale.
    coords = np.zeros((20, 3), dtype=np.float32)
    out = _normalize_coords(coords)
    assert out.shape == coords.shape
    assert np.all(out == 0)


def test_normalize_handles_flat_plane_input():
    rng = np.random.default_rng(6)
    coords = rng.uniform(-5, 5, size=(100, 3)).astype(np.float32)
    coords[:, 2] = 0.0  # collapse onto Z=0 plane
    out = _normalize_coords(coords)
    # Still centered, still scaled — and Z stays zero through the linear
    # rescale, so the flat-plane property is preserved.
    assert np.allclose(out.mean(axis=0), 0.0, atol=1e-4)
    assert np.max(np.abs(out)) == pytest.approx(COORD_SCALE, rel=1e-4)
    assert np.allclose(out[:, 2], 0.0)


def test_normalize_empty_input_is_safe():
    coords = np.zeros((0, 3), dtype=np.float32)
    out = _normalize_coords(coords)
    assert out.shape == (0, 3)


# ----------------------------------------------------------------------------
# _cluster — HDBSCAN gate at n < 5
# ----------------------------------------------------------------------------


def test_cluster_returns_all_noise_when_n_below_five():
    # n < 5 → HDBSCAN can't do anything useful → early-return all-noise.
    coords = np.array([[0, 0, 0], [1, 1, 1], [2, 2, 2]], dtype=np.float32)
    labels, probs = _cluster(coords)
    assert labels.shape == (3,)
    assert probs.shape == (3,)
    assert (labels == -1).all()
    assert (probs == 0).all()
    # Dtype contract — write_results expects int32 / float32 buffers.
    assert labels.dtype == np.int32
    assert probs.dtype == np.float32


def test_cluster_returns_all_noise_when_n_is_zero():
    coords = np.zeros((0, 3), dtype=np.float32)
    labels, probs = _cluster(coords)
    assert labels.shape == (0,)
    assert probs.shape == (0,)
    assert labels.dtype == np.int32
    assert probs.dtype == np.float32


# ----------------------------------------------------------------------------
# _build_cluster_rows — medoid is the member nearest to the cluster centroid
# ----------------------------------------------------------------------------


def test_build_cluster_rows_medoid_is_nearest_to_centroid():
    # Three points in cluster 0; one of them sits exactly at the centroid.
    coords = np.array(
        [
            [-1, 0, 0],  # 0: cluster 0, off-center
            [1, 0, 0],   # 1: cluster 0, off-center
            [0, 0, 0],   # 2: cluster 0, AT the centroid — should be medoid
            [10, 0, 0],  # 3: cluster 1, lone — medoid is itself
            [0, 0, 0],   # 4: noise, ignored
        ],
        dtype=np.float32,
    )
    ids = np.array([0, 0, 0, 1, -1], dtype=np.int32)
    texts = [f"row {i}" for i in range(5)]
    rows, snippets = _build_cluster_rows(coords, ids, texts)
    # One cluster row per non-noise cluster, sorted by cluster_id asc.
    assert [r.cluster_id for r in rows] == [0, 1]
    # Cluster 0 medoid is global index 2.
    assert rows[0].medoid_index == 2
    # Cluster 1 medoid is its only member, index 3.
    assert rows[1].medoid_index == 3
    # Size matches number of members.
    assert rows[0].size == 3
    assert rows[1].size == 1
    # Centroid is the mean of members.
    assert rows[0].cx == pytest.approx(0.0)
    assert rows[1].cx == pytest.approx(10.0)
    # Placeholder label until label_clusters overwrites it.
    assert rows[0].label == "Cluster 0"
    # Snippets: medoid first, then nearest neighbors. Cluster 0 has 3 members
    # so all 3 texts appear; cluster 1 has 1 so just one.
    assert snippets[0][0] == "row 2"  # medoid
    assert len(snippets[0]) == 3
    assert snippets[1] == ["row 3"]


def test_build_cluster_rows_excludes_noise_entirely():
    coords = np.array([[0, 0, 0], [1, 0, 0], [2, 0, 0]], dtype=np.float32)
    ids = np.array([-1, -1, -1], dtype=np.int32)
    texts = ["a", "b", "c"]
    rows, snippets = _build_cluster_rows(coords, ids, texts)
    assert rows == []
    assert snippets == {}


# ----------------------------------------------------------------------------
# _reduce_to_3d — degenerate small-n fallback
# ----------------------------------------------------------------------------


def test_reduce_to_3d_handles_degenerate_small_n():
    # n < 4 → PaCMAP can't fit → fallback returns (n, 3) with x = index.
    for n in (0, 1, 2, 3):
        x = np.random.default_rng(7).standard_normal((n, 384)).astype(np.float32)
        out = _reduce_to_3d(x, "pacmap")
        assert out.shape == (n, 3)
        assert out.dtype == np.float32
        if n > 0:
            # x-axis is range; y, z are zero.
            assert np.array_equal(out[:, 0], np.arange(n, dtype=np.float32))
            assert (out[:, 1:] == 0).all()


# ----------------------------------------------------------------------------
# run_pipeline — input validation (cheap branches, no model load)
# ----------------------------------------------------------------------------


def test_run_pipeline_rejects_empty_texts():
    with pytest.raises(ValueError, match="empty"):
        run_pipeline([])


def test_run_pipeline_rejects_unknown_reducer():
    # Validation happens before any model is loaded — must raise instantly,
    # not trip a slow embed pass first.
    with pytest.raises(ValueError, match="unknown reducer"):
        run_pipeline(["a", "b", "c"], reducer="definitely-not-a-reducer")
