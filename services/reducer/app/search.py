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


class SearchResponse(BaseModel):
    project_id: str
    query: str
    embed_model: str
    matches: list[SearchMatch]


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

    return SearchResponse(
        project_id=req.project_id,
        query=query,
        embed_model=embed_model,
        matches=matches,
    )
