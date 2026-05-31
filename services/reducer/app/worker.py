"""arq worker for long-running embed-reduce jobs.

Sync requests at or below ASYNC_ROW_THRESHOLD run inside the API process;
anything above is enqueued here so the request returns immediately and the
client polls /status/{project_id}.

Run with: `uv run arq app.worker.WorkerSettings`
(or `uv run worker` via the console script).
"""
from __future__ import annotations

import sys
from typing import Any

from arq import run_worker
from arq.connections import RedisSettings

from .config import REDIS_URL
from .db import connect, set_status, write_results
from .pipeline import run_pipeline
from .progress import clear_progress, set_progress


def _redis_settings() -> RedisSettings:
    return RedisSettings.from_dsn(REDIS_URL)


async def embed_reduce_job(
    ctx: dict[str, Any],
    *,
    project_id: str,
    tenant_id: str,
    texts: list[str],
    embed_model: str,
    reducer: str,
) -> dict[str, Any]:
    """Run the full pipeline and persist results.

    Status transitions: pending -> reducing -> ready, or -> error with
    error_message on failure. Phase progress is published to Redis so the
    /status endpoint can surface it.
    """
    try:
        await set_progress(project_id, stage="embedding", pct=5.0)
        with connect() as conn:
            set_status(conn, project_id, "reducing")
        await set_progress(project_id, stage="reducing", pct=20.0)

        # Pipeline is CPU-bound and synchronous; arq runs jobs in an
        # asyncio loop, so we just call it inline — one job per worker
        # process keeps this honest.
        result = run_pipeline(texts, embed_model=embed_model, reducer=reducer)

        await set_progress(project_id, stage="writing", pct=85.0)
        with connect() as conn:
            summary = write_results(
                conn, project_id=project_id, tenant_id=tenant_id, texts=texts, result=result
            )
        await set_progress(project_id, stage="ready", pct=100.0)
        await clear_progress(project_id)
        return summary
    except Exception:
        # Log the full exception for operators; only a generic message reaches
        # the user via projects.error_message (QA-6 — no raw Python/Postgres
        # exception text in the UI).
        import logging
        logging.exception("embed_reduce_job failed for project %s", project_id)
        try:
            with connect() as conn:
                set_status(
                    conn,
                    project_id,
                    "error",
                    error_message="Reduction failed. Check the reducer service logs for details.",
                )
        finally:
            await clear_progress(project_id)
        raise


class WorkerSettings:
    functions = [embed_reduce_job]
    redis_settings = _redis_settings()
    # Reducer jobs are CPU-heavy and load big ML libs; one at a time
    # per worker process keeps memory and GIL contention predictable.
    max_jobs = 1
    job_timeout = 60 * 30  # 30 minutes


def main() -> None:
    """Console-script entrypoint: `uv run worker`."""
    run_worker(WorkerSettings)
    sys.exit(0)
