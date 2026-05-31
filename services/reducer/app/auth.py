"""Shared-secret auth dependency for service-to-service calls.

Every web→reducer call must carry `X-Reducer-Secret`. The Next.js server is
the only legitimate caller; the browser never sees this header. This is the
MVP-grade gate — full JWT verification is deferred (see roadmap.md).
"""
from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import REDUCER_SHARED_SECRET


def verify_reducer_secret(
    x_reducer_secret: str | None = Header(default=None, alias="X-Reducer-Secret"),
) -> None:
    """Reject any caller missing a matching X-Reducer-Secret.

    Behavior:
    - REDUCER_SHARED_SECRET unset → reducer rejects ALL non-loopback calls
      with 503. Operator must set the secret to enable the service. This is
      fail-closed: an unconfigured reducer should not silently serve traffic.
      (In local dev, set REDUCER_SHARED_SECRET=dev-local in your .env.)
    - Secret set + header missing or wrong → 401.
    - Match (constant-time) → pass through.
    """
    if not REDUCER_SHARED_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "reducer not configured: REDUCER_SHARED_SECRET is unset. "
                "The reducer refuses to serve requests without an explicit secret."
            ),
        )
    if x_reducer_secret is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing X-Reducer-Secret header",
        )
    if not hmac.compare_digest(x_reducer_secret, REDUCER_SHARED_SECRET):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid X-Reducer-Secret",
        )
