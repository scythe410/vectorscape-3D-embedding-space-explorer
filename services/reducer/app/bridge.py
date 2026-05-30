"""POST /bridge — explain the shared theme and contrast between two clusters.

For each cluster we pull:
  - its medoid (the representative center)
  - its boundary points: the items in cluster A whose embedding is closest
    (cosine) to cluster B's medoid embedding, and vice versa.

Boundary points sit where the two concepts actually diverge, so they yield
sharper insight than medoids alone. The medoids + boundary texts go to the LLM,
which must name the shared theme and the concrete contrast / missing context.

Returns prose + cited example points (medoid + boundary) for each side. The
host UI uses the (x, y, z) on each example to fly the camera to it on click.
"""
from __future__ import annotations

from typing import Literal

import psycopg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .config import OPENAI_API_KEY
from .db import connect

router = APIRouter()

# Number of boundary points to pull per cluster. Four gives the LLM enough
# texture to spot the divergence without burning context on near-duplicates.
BOUNDARY_K = 4
# Per-point text cap. The LLM doesn't need the full body to read the gradient.
LLM_CHAR_CAP = 600
# Tighter cap on the wire so the UI panel renders snappily.
WIRE_CHAR_CAP = 280
# Chat model. Cheap + fast; the task is short-form explanation, not reasoning.
LLM_MODEL = "gpt-4o-mini"


class BridgeRequest(BaseModel):
    project_id: str
    cluster_a: int
    cluster_b: int


class BridgeExample(BaseModel):
    id: str
    text: str
    cluster_id: int
    x: float
    y: float
    z: float
    role: Literal["medoid", "boundary"]


class BridgeClusterMeta(BaseModel):
    cluster_id: int
    label: str
    size: int


class BridgeResponse(BaseModel):
    summary: str
    cluster_a: BridgeClusterMeta
    cluster_b: BridgeClusterMeta
    examples_a: list[BridgeExample]
    examples_b: list[BridgeExample]
    model: str


def _truncate(s: str | None, n: int) -> str:
    if not s:
        return ""
    s = s.strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _fetch_cluster(
    conn: psycopg.Connection, project_id: str, cluster_id: int
) -> dict | None:
    row = conn.execute(
        """
        select c.cluster_id, coalesce(c.label, ''), c.cx, c.cy, c.cz, c.size,
               p.id::text, p.text, p.embedding
          from public.clusters c
          left join public.points p on p.id = c.medoid_point_id
         where c.project_id = %s and c.cluster_id = %s
        """,
        (project_id, cluster_id),
    ).fetchone()
    if not row:
        return None
    return {
        "cluster_id": int(row[0]),
        "label": row[1] or f"Cluster {row[0]}",
        "cx": float(row[2]),
        "cy": float(row[3]),
        "cz": float(row[4]),
        "size": int(row[5]),
        "medoid_id": row[6],
        "medoid_text": row[7],
        "medoid_embedding": row[8],
    }


def _fetch_boundary(
    conn: psycopg.Connection,
    project_id: str,
    source_cluster: int,
    target_embedding,
    k: int,
) -> list[dict]:
    """Points in source_cluster sorted by cosine distance to target_embedding."""
    rows = conn.execute(
        """
        select id::text, text, x, y, z
          from public.points
         where project_id = %s and cluster_id = %s and embedding is not null
         order by embedding <=> %s
         limit %s
        """,
        (project_id, source_cluster, target_embedding, k),
    ).fetchall()
    return [
        {
            "id": r[0],
            "text": r[1],
            "x": float(r[2]),
            "y": float(r[3]),
            "z": float(r[4]),
        }
        for r in rows
    ]


def _build_prompt(a: dict, boundary_a: list[dict], b: dict, boundary_b: list[dict]) -> str:
    def block(label: str, medoid_text: str | None, boundary: list[dict]) -> str:
        lines = [f"### {label}", "Medoid (center of the cluster):",
                 _truncate(medoid_text, LLM_CHAR_CAP),
                 "Boundary points (this cluster's items closest to the other cluster):"]
        for i, p in enumerate(boundary, 1):
            lines.append(f"{i}. {_truncate(p['text'], LLM_CHAR_CAP)}")
        return "\n".join(lines)

    return (
        "You are an analyst reading a 3D embedding space. Two clusters have been "
        "selected. For each, you have the medoid (the central item) and the boundary "
        "points (the items closest to the *other* cluster — where the two concepts "
        "actually diverge).\n\n"
        "Write a tight 3–5 sentence explanation that:\n"
        "  (1) names the shared theme between the two clusters in one phrase, then\n"
        "  (2) describes the concrete contrast or the missing context between them, "
        "leaning on what the boundary points reveal.\n\n"
        "Plain prose. No headers, no bullets. Do not quote the example texts back.\n\n"
        + block(a["label"], a["medoid_text"], boundary_a)
        + "\n\n"
        + block(b["label"], b["medoid_text"], boundary_b)
    )


def _summarize(prompt: str) -> tuple[str, str]:
    """Returns (summary, model_name)."""
    if not OPENAI_API_KEY:
        return (
            "OPENAI_API_KEY is not set on the reducer, so no LLM summary was generated. "
            "The medoids and boundary points for both clusters are listed below — they "
            "carry the structural answer even without prose. Set the key to get a written "
            "shared-theme / contrast explanation.",
            "fallback",
        )
    from openai import OpenAI

    client = OpenAI(api_key=OPENAI_API_KEY)
    resp = client.chat.completions.create(
        model=LLM_MODEL,
        messages=[
            {
                "role": "system",
                "content": "You explain semantic structure of embeddings concisely.",
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.4,
        max_tokens=320,
    )
    return (resp.choices[0].message.content or "").strip(), LLM_MODEL


def _to_examples(cluster: dict, boundary: list[dict]) -> list[BridgeExample]:
    out: list[BridgeExample] = []
    if cluster["medoid_id"]:
        out.append(
            BridgeExample(
                id=cluster["medoid_id"],
                text=_truncate(cluster["medoid_text"], WIRE_CHAR_CAP),
                cluster_id=cluster["cluster_id"],
                x=cluster["cx"],
                y=cluster["cy"],
                z=cluster["cz"],
                role="medoid",
            )
        )
    for p in boundary:
        if p["id"] == cluster["medoid_id"]:
            continue
        out.append(
            BridgeExample(
                id=p["id"],
                text=_truncate(p["text"], WIRE_CHAR_CAP),
                cluster_id=cluster["cluster_id"],
                x=p["x"],
                y=p["y"],
                z=p["z"],
                role="boundary",
            )
        )
    return out


@router.post("/bridge", response_model=BridgeResponse)
def bridge(req: BridgeRequest) -> BridgeResponse:
    if req.cluster_a == req.cluster_b:
        raise HTTPException(status_code=400, detail="cluster_a and cluster_b must differ")

    with connect() as conn:
        a = _fetch_cluster(conn, req.project_id, req.cluster_a)
        b = _fetch_cluster(conn, req.project_id, req.cluster_b)
        if a is None:
            raise HTTPException(
                status_code=404, detail=f"cluster {req.cluster_a} not found in project"
            )
        if b is None:
            raise HTTPException(
                status_code=404, detail=f"cluster {req.cluster_b} not found in project"
            )
        if a["medoid_embedding"] is None or b["medoid_embedding"] is None:
            raise HTTPException(
                status_code=409,
                detail="cluster medoid has no embedding — cannot compute boundary",
            )

        boundary_a = _fetch_boundary(
            conn, req.project_id, req.cluster_a, b["medoid_embedding"], BOUNDARY_K
        )
        boundary_b = _fetch_boundary(
            conn, req.project_id, req.cluster_b, a["medoid_embedding"], BOUNDARY_K
        )

    prompt = _build_prompt(a, boundary_a, b, boundary_b)
    summary, model = _summarize(prompt)

    return BridgeResponse(
        summary=summary,
        cluster_a=BridgeClusterMeta(
            cluster_id=a["cluster_id"], label=a["label"], size=a["size"]
        ),
        cluster_b=BridgeClusterMeta(
            cluster_id=b["cluster_id"], label=b["label"], size=b["size"]
        ),
        examples_a=_to_examples(a, boundary_a),
        examples_b=_to_examples(b, boundary_b),
        model=model,
    )
