"""POST /embed — primitive that returns vectors for a list of texts.

Exists so the Next.js demo-search path can ask the reducer for a single query
vector without going through /search (which requires a DB-resident project).
Also reusable as a generic embedding primitive.

Same shared-secret auth as the other endpoints — never expose this without
the header check; an open embedding endpoint is a free CPU/GPU sink.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .auth import verify_reducer_secret
from .config import DEFAULT_EMBED_MODEL
from .embeddings import embed_texts

router = APIRouter()

MAX_TEXTS = 64
MAX_CHARS_PER_TEXT = 4000


class EmbedRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=MAX_TEXTS)
    embed_model: str = Field(default=DEFAULT_EMBED_MODEL)


class EmbedResponse(BaseModel):
    embed_model: str
    dim: int
    vectors: list[list[float]]


@router.post(
    "/embed",
    response_model=EmbedResponse,
    dependencies=[Depends(verify_reducer_secret)],
)
def embed(req: EmbedRequest) -> EmbedResponse:
    clean: list[str] = []
    for t in req.texts:
        s = (t or "").strip()
        if not s:
            raise HTTPException(status_code=400, detail="texts must be non-empty")
        clean.append(s[:MAX_CHARS_PER_TEXT])

    model = (req.embed_model or "").strip() or DEFAULT_EMBED_MODEL
    arr = embed_texts(clean, embed_model=model)
    return EmbedResponse(
        embed_model=model,
        dim=int(arr.shape[1]),
        vectors=[row.tolist() for row in arr],
    )
