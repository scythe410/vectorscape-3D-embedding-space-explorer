from fastapi import FastAPI

from .api import router as embed_router
from .bridge import router as bridge_router

app = FastAPI(title="VectorScape Reducer", version="0.0.0")
app.include_router(embed_router)
app.include_router(bridge_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "reducer"}
