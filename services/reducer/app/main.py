import logging
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI

from .api import router as embed_router
from .bridge import router as bridge_router
from .embed_api import router as embed_primitive_router
from .embeddings import warm_local_model
from .search import router as search_router

_log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the sentence-transformers model on boot so the first
    # /embed-reduce request doesn't pay the cold-load cost. Runs in a
    # thread so torch's slow import doesn't block the event loop during
    # startup; the worker process does the same in worker.py.
    try:
        await anyio.to_thread.run_sync(warm_local_model)
    except Exception:
        _log.exception("warm_local_model failed at startup; first request will pay the cost")
    yield


app = FastAPI(title="VectorScape Reducer", version="0.0.0", lifespan=lifespan)
app.include_router(embed_router)
app.include_router(bridge_router)
app.include_router(search_router)
app.include_router(embed_primitive_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "reducer"}
