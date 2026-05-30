"""Redis-backed progress tracking for async embed-reduce jobs.

Status of record lives in projects.status; this is the live progress
side-channel for jobs still in flight — phase + percent so the UI has
something to render between pending and ready.
"""
from __future__ import annotations

from typing import Any

import redis.asyncio as aioredis

from .config import REDIS_URL

_PROGRESS_TTL_SECONDS = 60 * 60 * 24  # one day; status of record is in Postgres


def _key(project_id: str) -> str:
    return f"vectorscape:progress:{project_id}"


async def set_progress(project_id: str, *, stage: str, pct: float) -> None:
    pct_clamped = max(0.0, min(100.0, float(pct)))
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await client.hset(_key(project_id), mapping={"stage": stage, "pct": f"{pct_clamped:.2f}"})
        await client.expire(_key(project_id), _PROGRESS_TTL_SECONDS)
    finally:
        await client.close()


async def get_progress(project_id: str) -> dict[str, Any] | None:
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        data = await client.hgetall(_key(project_id))
    finally:
        await client.close()
    if not data:
        return None
    try:
        pct = float(data.get("pct", "0"))
    except ValueError:
        pct = 0.0
    return {"stage": data.get("stage", "unknown"), "pct": pct}


async def clear_progress(project_id: str) -> None:
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await client.delete(_key(project_id))
    finally:
        await client.close()
