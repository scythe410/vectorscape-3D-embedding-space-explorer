"""Postgres writes for projects, points, clusters.

Uses service-role DATABASE_URL — bypasses RLS, so the caller is responsible for
passing the correct tenant_id when creating a project.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager

import numpy as np
import psycopg
from pgvector.psycopg import register_vector

from .config import DATABASE_URL, DEFAULT_EMBED_MODEL, DEFAULT_REDUCER
from .pipeline import PipelineResult


@contextmanager
def connect() -> Iterator[psycopg.Connection]:
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not set; check .env")
    with psycopg.connect(DATABASE_URL) as conn:
        register_vector(conn)
        yield conn


def fetch_project(conn: psycopg.Connection, project_id: str) -> tuple[str, str] | None:
    row = conn.execute(
        "select id::text, tenant_id::text from public.projects where id = %s",
        (project_id,),
    ).fetchone()
    return (row[0], row[1]) if row else None


def ensure_project(
    conn: psycopg.Connection,
    *,
    project_id: str | None,
    name: str,
    embed_model: str = DEFAULT_EMBED_MODEL,
    reducer: str = DEFAULT_REDUCER,
    tenant_id: str | None = None,
) -> tuple[str, str]:
    """Return (project_id, tenant_id). Creates if missing, with status='pending'."""
    if project_id:
        existing = fetch_project(conn, project_id)
        if existing:
            return existing

    pid = project_id or str(uuid.uuid4())
    tid = tenant_id or str(uuid.uuid4())
    conn.execute(
        """
        insert into public.projects (id, tenant_id, name, status, embed_model, reducer)
        values (%s, %s, %s, 'pending', %s, %s)
        """,
        (pid, tid, name, embed_model, reducer),
    )
    return pid, tid


def set_status(
    conn: psycopg.Connection,
    project_id: str,
    status: str,
    *,
    error_message: str | None = None,
) -> None:
    """Flip a project's status. On 'error', also record error_message.

    Non-error transitions clear any prior error_message so retries don't
    leave a stale failure reason hanging around.
    """
    if status == "error":
        conn.execute(
            """
            update public.projects
            set status = 'error'::public.project_status,
                error_message = %s
            where id = %s
            """,
            (error_message, project_id),
        )
    else:
        conn.execute(
            """
            update public.projects
            set status = %s::public.project_status,
                error_message = null
            where id = %s
            """,
            (status, project_id),
        )


def fetch_status(conn: psycopg.Connection, project_id: str) -> dict | None:
    row = conn.execute(
        """
        select status::text, point_count, error_message
        from public.projects
        where id = %s
        """,
        (project_id,),
    ).fetchone()
    if not row:
        return None
    return {"status": row[0], "point_count": int(row[1]), "error_message": row[2]}


def _delete_existing(conn: psycopg.Connection, project_id: str) -> None:
    conn.execute("delete from public.clusters where project_id = %s", (project_id,))
    conn.execute("delete from public.points where project_id = %s", (project_id,))


def write_results(
    conn: psycopg.Connection,
    *,
    project_id: str,
    tenant_id: str,
    texts: list[str],
    result: PipelineResult,
) -> dict:
    n = len(texts)
    if n != result.coords.shape[0]:
        raise ValueError("texts and coords length mismatch")

    # Take a row-level lock on the projects row before any writes. Two
    # concurrent reductions of the same project would otherwise race the
    # delete + bulk insert (Postgres MVCC alone doesn't prevent the
    # interleave where B's delete wipes A's just-inserted points right
    # after A commits). The FOR UPDATE serializes them: the second
    # writer blocks here until the first finishes, then proceeds on the
    # post-commit snapshot. Cheap because the lock scope is one row.
    row = conn.execute(
        "select id from public.projects where id = %s for update",
        (project_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"project {project_id} not found")

    set_status(conn, project_id, "reducing")
    _delete_existing(conn, project_id)

    # Pre-generate UUIDs so we can resolve cluster medoid_point_id before insert.
    point_ids = [str(uuid.uuid4()) for _ in range(n)]
    coords = result.coords
    cids = result.cluster_ids
    probs = result.cluster_probabilities
    embs = result.embeddings

    point_rows = [
        (
            point_ids[i],
            project_id,
            tenant_id,
            texts[i],
            float(coords[i, 0]),
            float(coords[i, 1]),
            float(coords[i, 2]),
            int(cids[i]) if int(cids[i]) != -1 else None,
            float(probs[i]),
            np.ascontiguousarray(embs[i], dtype=np.float32),
        )
        for i in range(n)
    ]

    with conn.cursor() as cur:
        cur.executemany(
            """
            insert into public.points
              (id, project_id, tenant_id, text, x, y, z,
               cluster_id, cluster_probability, embedding)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            point_rows,
        )

        cluster_rows = [
            (
                str(uuid.uuid4()),
                project_id,
                tenant_id,
                c.cluster_id,
                c.label,
                c.cx,
                c.cy,
                c.cz,
                point_ids[c.medoid_index],
                c.size,
            )
            for c in result.clusters
        ]
        if cluster_rows:
            cur.executemany(
                """
                insert into public.clusters
                  (id, project_id, tenant_id, cluster_id, label,
                   cx, cy, cz, medoid_point_id, size)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                cluster_rows,
            )

    conn.execute(
        """
        update public.projects
        set status = 'ready', point_count = %s, embed_model = %s, reducer = %s
        where id = %s
        """,
        (n, result.embed_model, result.reducer, project_id),
    )

    noise = int((cids == -1).sum())
    return {
        "project_id": project_id,
        "tenant_id": tenant_id,
        "n_points": n,
        "n_clusters": len(result.clusters),
        "n_noise": noise,
        "used_pca": result.used_pca,
        "reducer": result.reducer,
        "embed_model": result.embed_model,
    }


