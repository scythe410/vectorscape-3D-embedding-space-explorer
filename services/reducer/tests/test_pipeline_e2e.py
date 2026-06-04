"""End-to-end smoke tests for the **real** reducer pipeline.

Existing unit tests (`test_pipeline.py`, `test_labeling.py`) cover the pure
helpers and the labeling stage in isolation. They all pass while the user
still sees `Cluster N` in the sandbox if a wiring gap or a stale-data path
intervenes — exactly the bug class this audit targets.

This file drives `run_pipeline` end-to-end on a representative 3-topic CSV
(cooking / astronomy / programming, the same shape as `samples/sample.csv`)
and asserts the **user-visible output** is correct — specifically that no
cluster label survives as the `Cluster N` placeholder. It's the test that
would have caught the original label regression at PR time.

Cost: the first run loads MiniLM once (~3-15s cold); subsequent runs are
cache-warm thanks to `app.embeddings`' disk cache. Marked separately so it's
easy to skip in tight inner loops.
"""
from __future__ import annotations

import os
import re

import pytest

from app.pipeline import run_pipeline

# Three thematic groups, big enough for HDBSCAN's default `min_cluster_size`
# heuristic (max(5, round(sqrt(n)/2))) to discover them. ~60 rows total —
# matches the `samples/sample.csv` shape that the CLI smoke from prompt 4
# used to verify the wiring originally.
_COOKING = [
    "Saffron risotto with a slow-simmered chicken stock and a final knob of cold butter.",
    "Creamy mushroom pasta with garlic, parsley, and a splash of white wine.",
    "Carbonara: guanciale rendered to gold, then pecorino and egg yolks off the heat.",
    "Tomato confit on toasted sourdough with flaky salt and basil leaves.",
    "Braised short ribs in red wine with mirepoix, thyme, and bay leaves.",
    "A bright lemon vinaigrette for a salad of bitter greens and shaved fennel.",
    "Caramelizing onions properly: low heat, patience, a pinch of sugar at the end.",
    "Roast a whole chicken at high heat, then rest it before carving.",
    "Homemade pasta dough: 100g flour, one egg, knead until smooth.",
    "Stewed cannellini beans with rosemary, garlic, and good olive oil.",
    "Hearty minestrone with seasonal vegetables and tiny pasta shapes.",
    "Pizza dough cold-fermented for 48 hours develops a deeper flavor.",
    "Sear scallops in a hot pan, finish with brown butter and capers.",
    "A clean tomato sauce: just tomatoes, basil, garlic, salt, olive oil.",
    "Slow-roasted pork shoulder until the meat shreds with a fork.",
]

_ASTRONOMY = [
    "The Andromeda galaxy is on a collision course with the Milky Way over billions of years.",
    "Pulsars are rapidly rotating neutron stars emitting beams of electromagnetic radiation.",
    "Hubble's law relates the recessional velocity of galaxies to their distance from us.",
    "Black holes warp spacetime so severely that not even light can escape past the event horizon.",
    "Stellar nucleosynthesis forges elements heavier than helium inside massive stars.",
    "The cosmic microwave background is the afterglow of the early hot universe.",
    "Supernovae enrich the interstellar medium with the heavy elements life needs.",
    "Dark matter halos provide the gravitational scaffolding for galaxy formation.",
    "Exoplanets are detected via radial velocity wobble or transit dimming of their host star.",
    "Gravitational lensing distorts the light of background galaxies into rings and arcs.",
    "A galaxy's rotation curve reveals far more mass than its visible matter accounts for.",
    "Star clusters trace the chemical and dynamical history of their parent galaxy.",
    "The Hertzsprung-Russell diagram organizes stars by luminosity and temperature.",
    "Nebulae are stellar nurseries where dense gas collapses to ignite new stars.",
    "Quasars are powered by supermassive black holes accreting material at extreme rates.",
]

_PROGRAMMING = [
    "Refactoring this function into smaller pieces made the call sites self-explanatory.",
    "Adding a type to the public API caught two callers that were passing the wrong shape.",
    "The pull request introduces a cache layer with explicit TTL semantics and tests.",
    "Pinning a dependency revealed a transitive constraint that broke our nightly build.",
    "Git bisect narrowed the regression down to a single commit changing the parser.",
    "Tail-call optimization makes the recursive solution as efficient as a loop.",
    "Async I/O lets the server handle many concurrent clients without thread overhead.",
    "Property-based testing surfaced an edge case the example-based tests missed.",
    "A hash map gives constant-time lookups versus the linear scan we had before.",
    "Code review caught a SQL injection vector hidden behind a helper function.",
    "Migrations should be idempotent so a partial failure can be safely re-applied.",
    "Static analysis flagged an unused import that turned out to mask a real bug.",
    "Memoizing the pure transform brought page load from 800ms to 90ms.",
    "Logging structured events makes the production failure mode reproducible.",
    "Mocking the database in tests masked a migration drift that hit us in prod.",
]


_PLACEHOLDER_RE = re.compile(r"^cluster\s+\d+$", re.IGNORECASE)


def _is_placeholder(label: str | None) -> bool:
    if not label:
        return True
    return bool(_PLACEHOLDER_RE.match(label.strip()))


# Marker so the suite can be filtered with `-m e2e` / `-m 'not e2e'`.
# Registered in pyproject.toml.
pytestmark = pytest.mark.e2e


def test_run_pipeline_three_topic_csv_produces_real_labels() -> None:
    """The exact bug shape we're auditing.

    Push a realistic 3-topic corpus through `run_pipeline` (no stubs, no
    mocks) and assert every cluster label that surfaces in the UI is a
    real keyword, never `Cluster N`. If `label_clusters` regresses to
    placeholder-only — the original bug — this test fails.
    """
    texts = _COOKING + _ASTRONOMY + _PROGRAMMING
    result = run_pipeline(texts)

    # The pipeline must produce at least *one* named cluster on this corpus.
    # If HDBSCAN labels everything as noise, that's a pipeline regression in
    # itself — and the user would see an empty sidebar.
    assert len(result.clusters) >= 1, (
        "run_pipeline produced no named clusters on a 3-topic corpus — "
        "either the embedder broke or HDBSCAN's heuristic is too strict"
    )

    placeholders = [c for c in result.clusters if _is_placeholder(c.label)]
    if placeholders:
        rendered = [(c.cluster_id, c.label) for c in result.clusters]
        pytest.fail(
            "label_clusters returned placeholder labels — the exact bug "
            f"this audit targets. Cluster rows: {rendered}"
        )

    # Sanity: the labels we got should at least *plausibly* relate to the
    # three themes we fed in. A real semantic regression (e.g. all clusters
    # labelled "the") would still pass the placeholder check but is worth
    # flagging here. Cheap to assert at this scale.
    joined = " ".join((c.label or "").lower() for c in result.clusters)
    plausible_terms = (
        "recipe",
        "pasta",
        "cooking",
        "tomato",
        "wine",
        "butter",
        "galaxy",
        "star",
        "black",
        "hole",
        "stellar",
        "cosmic",
        "dark",
        "code",
        "test",
        "build",
        "function",
        "cache",
        "review",
        "git",
        "async",
    )
    assert any(term in joined for term in plausible_terms), (
        f"no plausible domain terms appeared in cluster labels: {joined!r} — "
        "the labels are technically non-placeholders but read as gibberish"
    )


def test_run_pipeline_emits_adjacency_edges() -> None:
    """Real run should produce non-empty `edges` so the sandbox links overlay
    has something to render. This is the same data the engine consumes
    through /api/projects/[id]/data → cluster_edges."""
    texts = _COOKING + _ASTRONOMY + _PROGRAMMING
    result = run_pipeline(texts)
    # 3 themes → at least 2 cluster pairs in the top-N (we ask for 3).
    assert len(result.clusters) >= 2, "fewer than 2 named clusters; can't have edges"
    assert len(result.edges) >= 1, (
        "compute_top_edges returned no edges for a 3-topic corpus — "
        "the links overlay would silently render empty"
    )
    for edge in result.edges:
        assert edge.cluster_a < edge.cluster_b, (
            f"edge not canonical: {edge}"
        )
        # Cosine similarity in [-1, 1]; same-topic should be > 0 here.
        assert -1.0 <= edge.similarity <= 1.0


# Reducer-DB integration smoke: only runs when DATABASE_URL is set (the
# cloud dev project). Local CI without DB access skips. This is the
# closest analog to "real-user upload" the test layer can give us
# without spinning up Postgres in the harness.
@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; skipping cloud-DB integration smoke",
)
def test_pipeline_writes_real_labels_to_db() -> None:  # pragma: no cover
    """When DATABASE_URL points at a real Postgres, drive the whole
    pipeline → write_results path and assert the persisted cluster rows
    carry non-placeholder labels. Tears its own project down afterwards.
    """
    import uuid

    from app.db import connect, ensure_project, write_results

    texts = _COOKING + _ASTRONOMY + _PROGRAMMING
    result = run_pipeline(texts)
    pid = str(uuid.uuid4())
    tid = str(uuid.uuid4())
    try:
        with connect() as conn:
            ensure_project(
                conn,
                project_id=pid,
                name="reality-check-e2e",
                tenant_id=tid,
            )
            write_results(
                conn, project_id=pid, tenant_id=tid, texts=texts, result=result
            )
            # Read back what the UI would actually fetch via /data.
            rows = conn.execute(
                "select cluster_id, label from public.clusters where project_id = %s",
                (pid,),
            ).fetchall()
        assert rows, "no cluster rows landed in the DB"
        bad = [(cid, lbl) for cid, lbl in rows if _is_placeholder(lbl)]
        assert not bad, f"persisted clusters carry placeholder labels: {bad}"
    finally:
        with connect() as conn:
            conn.execute("delete from public.clusters where project_id = %s", (pid,))
            conn.execute("delete from public.points where project_id = %s", (pid,))
            conn.execute("delete from public.projects where id = %s", (pid,))
