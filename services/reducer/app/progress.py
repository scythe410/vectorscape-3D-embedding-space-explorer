"""Redis-backed progress tracking for async embed-reduce jobs.

Status of record lives in projects.status; this is the live progress
side-channel for jobs still in flight — phase + percent so the UI has
something to render between pending and ready.

Redis is OPTIONAL. The in-process background-task path (the HF Space
default) runs without Redis; any connection failure here degrades to
no-op (setters) or None (getter) so /status keeps working. Status of
record is in Postgres regardless.
"""
from __future__ import annotations

import logging
from typing import Any

import redis.asyncio as aioredis
from redis.exceptions import RedisError

from .config import REDIS_URL

_log = logging.getLogger(__name__)
_PROGRESS_TTL_SECONDS = 60 * 60 * 24  # one day; status of record is in Postgres

# Latch: once a Redis call fails, stop trying for the lifetime of the
# process. Avoids paying connection-timeout cost on every /status poll
# when Redis isn't deployed (the common case on the HF Space).
_redis_disabled = False


def _key(project_id: str) -> str:
    return f"vectorscape:progress:{project_id}"


def _disable_redis(exc: BaseException) -> None:
    global _redis_disabled
    if not _redis_disabled:
        _log.warning("progress: disabling Redis side-channel (%s: %s)", type(exc).__name__, exc)
        _redis_disabled = True


async def set_progress(project_id: str, *, stage: str, pct: float) -> None:
    if _redis_disabled:
        return
    pct_clamped = max(0.0, min(100.0, float(pct)))
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await client.hset(_key(project_id), mapping={"stage": stage, "pct": f"{pct_clamped:.2f}"})
        await client.expire(_key(project_id), _PROGRESS_TTL_SECONDS)
    except (RedisError, OSError) as exc:
        _disable_redis(exc)
    finally:
        await client.close()


async def get_progress(project_id: str) -> dict[str, Any] | None:
    if _redis_disabled:
        return None
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        data = await client.hgetall(_key(project_id))
    except (RedisError, OSError) as exc:
        _disable_redis(exc)
        return None
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
    if _redis_disabled:
        return
    client = aioredis.from_url(REDIS_URL, decode_responses=True)
    try:
        await client.delete(_key(project_id))
    except (RedisError, OSError) as exc:
        _disable_redis(exc)
    finally:
        await client.close()
