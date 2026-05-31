"""FastAPI routes: /embed-reduce, /status/{project_id}.

Small jobs run inline; >ASYNC_ROW_THRESHOLD rows are handed to the arq
worker and the caller polls /status to learn when it lands.
"""
from __future__ import annotations

from typing import Any, Literal

import anyio
from arq import create_pool
from arq.connections import RedisSettings
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import verify_reducer_secret
from .config import ASYNC_ROW_THRESHOLD, DEFAULT_EMBED_MODEL, DEFAULT_REDUCER, REDIS_URL
from .db import connect, ensure_project, fetch_status, set_status, write_results
from .pipeline import run_pipeline
from .progress import get_progress

router = APIRouter()


class EmbedReduceRequest(BaseModel):
    project_id: str | None = Field(default=None, description="Existing project; created if absent")
    rows: list[dict[str, Any]]
    text_column: str
    embed_model: str = DEFAULT_EMBED_MODEL
    reducer: str = DEFAULT_REDUCER
    name: str | None = None
    tenant_id: str | None = None


class EmbedReduceResponse(BaseModel):
    project_id: str
    tenant_id: str
    n_points: int
    n_clusters: int
    n_noise: int
    used_pca: bool
    reducer: str
    embed_model: str
    mode: Literal["sync", "queued"]


class StatusResponse(BaseModel):
    project_id: str
    status: Literal["pending", "reducing", "ready", "error"]
    point_count: int
    error_message: str | None = None
    progress: dict[str, Any] | None = None


def _extract_texts(req: EmbedReduceRequest) -> list[str]:
    texts: list[str] = []
    for i, row in enumerate(req.rows):
        if req.text_column not in row:
            raise HTTPException(
                status_code=400,
                detail=f"row {i} missing text_column '{req.text_column}'",
            )
        val = row[req.text_column]
        if val is None or str(val).strip() == "":
            continue
        texts.append(str(val))
    if not texts:
        raise HTTPException(status_code=400, detail="no non-empty text rows")
    return texts


@router.post(
    "/embed-reduce",
    response_model=EmbedReduceResponse,
    dependencies=[Depends(verify_reducer_secret)],
)
async def embed_reduce(req: EmbedReduceRequest) -> EmbedReduceResponse:
    if not req.rows:
        raise HTTPException(status_code=400, detail="rows is empty")

    texts = _extract_texts(req)

    with connect() as conn:
        pid, tid = ensure_project(
            conn,
            project_id=req.project_id,
            name=req.name or "untitled",
            embed_model=req.embed_model,
            reducer=req.reducer,
            tenant_id=req.tenant_id,
        )
        # Reset to pending so a re-run after a prior error/ready starts clean.
        set_status(conn, pid, "pending")

    if len(texts) > ASYNC_ROW_THRESHOLD:
        # Hand off to arq. The job sets reducing/ready/error itself.
        pool = await create_pool(RedisSettings.from_dsn(REDIS_URL))
        try:
            await pool.enqueue_job(
                "embed_reduce_job",
                project_id=pid,
                tenant_id=tid,
                texts=texts,
                embed_model=req.embed_model,
                reducer=req.reducer,
            )
        finally:
            await pool.close()
        return EmbedReduceResponse(
            project_id=pid,
            tenant_id=tid,
            n_points=len(texts),
            n_clusters=0,
            n_noise=0,
            used_pca=False,
            reducer=req.reducer,
            embed_model=req.embed_model,
            mode="queued",
        )

    # Sync path — small enough to run inside the request. The pipeline +
    # writes are blocking CPU/IO; running them inline in an `async def`
    # handler would freeze the ASGI event loop and starve /health and
    # /status polls for everyone. anyio.to_thread.run_sync hands the work
    # to Starlette's threadpool so the loop stays responsive.
    def _do_sync_work() -> dict[str, Any]:
        with connect() as conn:
            set_status(conn, pid, "reducing")
            result = run_pipeline(texts, embed_model=req.embed_model, reducer=req.reducer)
            return write_results(
                conn, project_id=pid, tenant_id=tid, texts=texts, result=result
            )

    try:
        summary = await anyio.to_thread.run_sync(_do_sync_work)
    except Exception as e:
        # The work-tx above is rolled back by psycopg's context manager on
        # exception, so record the failure in a fresh connection that can
        # commit independently — otherwise status stays at 'pending'.
        # User-facing error_message is generic (QA-6); the raw exception is
        # logged to the reducer's stderr.
        import logging
        logging.exception("embed_reduce sync path failed for project %s", pid)

        def _record_error() -> None:
            with connect() as err_conn:
                set_status(
                    err_conn,
                    pid,
                    "error",
                    error_message="Reduction failed. Check the reducer service logs for details.",
                )
        await anyio.to_thread.run_sync(_record_error)
        # Return the generic message to the caller; full detail stays in logs.
        raise HTTPException(
            status_code=500,
            detail=f"reduction failed ({type(e).__name__})",
        ) from e

    return EmbedReduceResponse(**summary, mode="sync")


@router.get(
    "/status/{project_id}",
    response_model=StatusResponse,
    dependencies=[Depends(verify_reducer_secret)],
)
async def status(project_id: str) -> StatusResponse:
    with connect() as conn:
        row = fetch_status(conn, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"project {project_id} not found")
    progress = await get_progress(project_id) if row["status"] in {"pending", "reducing"} else None
    return StatusResponse(
        project_id=project_id,
        status=row["status"],
        point_count=row["point_count"],
        error_message=row["error_message"],
        progress=progress,
    )
