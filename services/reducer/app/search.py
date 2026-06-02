"""POST /search — natural-language search over a project's points.

Flow:
  1. Look up the project (scoped to its tenant) so we know which embed_model
     produced its stored point vectors. Mismatched models = meaningless cosine.
  2. Embed the query text with that same model.
  3. pgvector cosine search over public.points scoped to (project_id, tenant_id).
  4. Return the top matches with id / text / coords / cluster_id / score.

Everything stays server-side: the embedder and the DB credentials never leave
the reducer process. The Next.js web tier proxies a verified tenant_id along
with the project_id so /search can't be tricked into crossing tenants.
"""
from __future__ import annotations

import re

import numpy as np
import psycopg
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import verify_reducer_secret
from .config import DEFAULT_EMBED_MODEL
from .db import connect
from .embeddings import embed_texts

router = APIRouter()

# Top-K matches returned by default. Enough to highlight a cluster of results
# without flooding the panel; the host can override.
DEFAULT_LIMIT = 20
MAX_LIMIT = 200
WIRE_CHAR_CAP = 280

# How many named regions to surface in the summary. Three is enough to convey
# "mostly X, with some Y and Z" without turning into a list.
REGION_TOP_N = 3

# A label is a placeholder if it's missing or matches the pre-labels-commit
# `Cluster N` shape the reducer used to emit. The region summary degrades to
# dot-highlight-only when every matched cluster's label is a placeholder —
# naming "Cluster 3" tells the user nothing the dots don't already.
_PLACEHOLDER_RE = re.compile(r"^cluster\s+\d+$", re.IGNORECASE)


class SearchRequest(BaseModel):
    project_id: str
    # tenant_id is the *verified* tenant the caller (Next.js server) already
    # confirmed against the user's session. Every query here scopes to
    # (project_id, tenant_id) so /search can never return another tenant's
    # rows, even if someone guesses a foreign project_id.
    tenant_id: str
    query: str
    limit: int = Field(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT)


class SearchMatch(BaseModel):
    id: str
    text: str
    x: float
    y: float
    z: float
    cluster_id: int | None
    # Cosine distance (0 = identical, 2 = opposite). Lower is better.
    score: float


class Region(BaseModel):
    cluster_id: int
    label: str
    count: int


class SearchResponse(BaseModel):
    project_id: str
    query: str
    embed_model: str
    matches: list[SearchMatch]
    # Aggregation of matches by cluster_id, joined against this project's
    # cluster labels. Sorted by count desc. Noise matches (cluster_id is
    # null) are excluded — they don't belong to a named region by definition.
    regions: list[Region]
    # False when every region's label is a "Cluster N" placeholder. The
    # client uses this to gate the plain-language summary: without real
    # names the summary is meaningless, so degrade to dot-highlight only.
    labels_are_real: bool
    # Short plain-language summary like "mostly Senate races and campaign
    # finance". Empty string when labels are placeholders or no clustered
    # matches landed.
    summary: str


def _truncate(s: str | None, n: int) -> str:
    if not s:
        return ""
    s = s.strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _fetch_project_embed_model(
    conn: psycopg.Connection, project_id: str, tenant_id: str
) -> str | None:
    row = conn.execute(
        """
        select embed_model
          from public.projects
         where id = %s and tenant_id = %s
        """,
        (project_id, tenant_id),
    ).fetchone()
    if not row:
        return None
    return row[0] or DEFAULT_EMBED_MODEL


def _search_points(
    conn: psycopg.Connection,
    project_id: str,
    tenant_id: str,
    query_vec,
    limit: int,
) -> list[SearchMatch]:
    rows = conn.execute(
        """
        select id::text, text, x, y, z, cluster_id,
               (embedding <=> %s) as score
          from public.points
         where project_id = %s and tenant_id = %s
           and embedding is not null
         order by embedding <=> %s
         limit %s
        """,
        (query_vec, project_id, tenant_id, query_vec, limit),
    ).fetchall()
    return [
        SearchMatch(
            id=r[0],
            text=_truncate(r[1], WIRE_CHAR_CAP),
            x=float(r[2]),
            y=float(r[3]),
            z=float(r[4]),
            cluster_id=(int(r[5]) if r[5] is not None else None),
            score=float(r[6]),
        )
        for r in rows
    ]


def _fetch_cluster_labels(
    conn: psycopg.Connection,
    project_id: str,
    tenant_id: str,
    cluster_ids: list[int],
) -> dict[int, str | None]:
    """Look up labels for the given cluster_ids on this project. Tenant-scoped
    so a forged project_id can't pull labels from another tenant."""
    if not cluster_ids:
        return {}
    rows = conn.execute(
        """
        select cluster_id, label
          from public.clusters
         where project_id = %s and tenant_id = %s
           and cluster_id = any(%s)
        """,
        (project_id, tenant_id, cluster_ids),
    ).fetchall()
    return {int(r[0]): r[1] for r in rows}


def _is_placeholder(label: str | None) -> bool:
    if not label:
        return True
    s = label.strip()
    if not s:
        return True
    return bool(_PLACEHOLDER_RE.match(s))


def _compose_summary(regions: list[Region], total_matches: int) -> str:
    """Plain-language headline. Pre-condition: regions is sorted desc by count
    and every label is non-placeholder (caller checks). Empty string when
    there's nothing useful to say."""
    if not regions or total_matches <= 0:
        return ""
    top = regions[0]
    share = top.count / total_matches
    if share >= 0.8 or len(regions) == 1:
        return f"mostly {top.label}"
    if len(regions) == 2:
        return f"{regions[0].label} and {regions[1].label}"
    return f"{regions[0].label}, {regions[1].label}, and {regions[2].label}"


def _summarize_regions(
    matches: list[SearchMatch],
    labels: dict[int, str | None],
) -> tuple[list[Region], bool, str]:
    """Aggregate matches by cluster_id, joining in labels. Returns
    (regions, labels_are_real, summary).

    - Noise matches (cluster_id is None) are excluded — they aren't in any
      named region.
    - regions is sorted by count desc, capped at REGION_TOP_N.
    - labels_are_real is True iff at least one matched cluster has a
      non-placeholder label. The summary is empty when this is False.
    """
    counts: dict[int, int] = {}
    for m in matches:
        if m.cluster_id is None:
            continue
        counts[m.cluster_id] = counts.get(m.cluster_id, 0) + 1
    if not counts:
        return [], False, ""

    # Sort by count desc, then by cluster_id asc for a deterministic tie-break.
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    labels_are_real = any(not _is_placeholder(labels.get(cid)) for cid, _ in ordered)

    regions: list[Region] = []
    for cid, count in ordered[:REGION_TOP_N]:
        raw = labels.get(cid)
        label = raw.strip() if raw and raw.strip() else f"Cluster {cid}"
        regions.append(Region(cluster_id=cid, label=label, count=count))

    if not labels_are_real:
        return regions, False, ""

    # Compose the summary only from regions whose labels aren't placeholders.
    named = [r for r in regions if not _is_placeholder(labels.get(r.cluster_id))]
    total_named = sum(r.count for r in named)
    summary = _compose_summary(named, total_named)
    return regions, True, summary


@router.post(
    "/search",
    response_model=SearchResponse,
    dependencies=[Depends(verify_reducer_secret)],
)
def search(req: SearchRequest) -> SearchResponse:
    query = (req.query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="query must be non-empty")

    with connect() as conn:
        embed_model = _fetch_project_embed_model(conn, req.project_id, req.tenant_id)
        if embed_model is None:
            # Either the project doesn't exist or it's in another tenant.
            # Same 404 either way — never leak existence across tenants.
            raise HTTPException(status_code=404, detail="project not found")

        # CRITICAL: embed the query with the *same* model the project's stored
        # vectors were produced by. A query embedded by a different model lives
        # in a different latent space — cosine distance is meaningless.
        vecs = embed_texts([query], embed_model=embed_model)
        query_vec = np.ascontiguousarray(vecs[0], dtype=np.float32)

        matches = _search_points(
            conn,
            req.project_id,
            req.tenant_id,
            query_vec,
            req.limit,
        )

        # Pull labels only for clusters that actually appear in the matches.
        unique_cluster_ids = sorted(
            {m.cluster_id for m in matches if m.cluster_id is not None}
        )
        labels = _fetch_cluster_labels(
            conn, req.project_id, req.tenant_id, unique_cluster_ids
        )

    regions, labels_are_real, summary = _summarize_regions(matches, labels)

    return SearchResponse(
        project_id=req.project_id,
        query=query,
        embed_model=embed_model,
        matches=matches,
        regions=regions,
        labels_are_real=labels_are_real,
        summary=summary,
    )
