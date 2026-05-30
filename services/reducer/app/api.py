"""FastAPI routes: /embed-reduce."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .config import DEFAULT_EMBED_MODEL, DEFAULT_REDUCER
from .db import connect, ensure_project, set_status, write_results
from .pipeline import run_pipeline

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


@router.post("/embed-reduce", response_model=EmbedReduceResponse)
def embed_reduce(req: EmbedReduceRequest) -> EmbedReduceResponse:
    if not req.rows:
        raise HTTPException(status_code=400, detail="rows is empty")

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

    with connect() as conn:
        pid, tid = ensure_project(
            conn,
            project_id=req.project_id,
            name=req.name or "untitled",
            embed_model=req.embed_model,
            reducer=req.reducer,
            tenant_id=req.tenant_id,
        )
        try:
            result = run_pipeline(texts, embed_model=req.embed_model, reducer=req.reducer)
            summary = write_results(
                conn, project_id=pid, tenant_id=tid, texts=texts, result=result
            )
        except Exception as e:
            set_status(conn, pid, "error")
            raise HTTPException(status_code=500, detail=str(e)) from e

    return EmbedReduceResponse(**summary)
