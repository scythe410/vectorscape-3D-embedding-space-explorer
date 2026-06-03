"""Text embedding with disk cache.

Local MiniLM is the default and free path. OpenAI is opt-in and only kicks in when
embed_model='openai' AND OPENAI_API_KEY is set — never charges the user implicitly.
Cache key is content-hash of (model, text) so re-uploads of the same rows are free.
"""
from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from .config import CACHE_DIR, DEFAULT_EMBED_MODEL, EMBED_DIM, OPENAI_API_KEY

if TYPE_CHECKING:
    # Import only for type-checking — sentence-transformers pulls torch on
    # import and we want the cold reducer to start fast. The runtime import
    # happens lazily inside _get_local_model().
    from sentence_transformers import SentenceTransformer

_st_model: SentenceTransformer | None = None  # lazy-loaded
_log = logging.getLogger(__name__)

OPENAI_MODEL = "text-embedding-3-small"  # 1536-dim natively; truncated to 384
# Token cap for the OpenAI embedding model. text-embedding-3-small refuses
# inputs above 8191 tokens with an unhandled error. We pre-truncate to keep
# under that with margin. tiktoken would be exact; the conservative char-based
# fallback below (~4 chars/token in English) is ~6000 tokens at the worst.
OPENAI_MAX_TOKENS = 8000
# Used by the char-based fallback when tiktoken isn't available.
_FALLBACK_CHARS_PER_TOKEN = 4
OPENAI_CHAR_CAP_FALLBACK = OPENAI_MAX_TOKENS * _FALLBACK_CHARS_PER_TOKEN  # ~32000 chars


def _hash_text(model_name: str, text: str) -> str:
    h = hashlib.sha256()
    h.update(model_name.encode("utf-8"))
    h.update(b"\x00")
    h.update(text.encode("utf-8"))
    return h.hexdigest()


def _cache_path(digest: str) -> Path:
    # Two-level shard to keep directories small.
    return CACHE_DIR / digest[:2] / digest[2:4] / f"{digest}.npy"


def _load_cached(digest: str) -> np.ndarray | None:
    p = _cache_path(digest)
    if p.exists():
        try:
            return np.load(p)
        except Exception:
            # A corrupted/truncated cache file isn't fatal — the caller
            # re-computes. But silently swallowing it hides install/disk
            # problems; log a breadcrumb so the operator can find it.
            _log.exception("embedding cache: failed to load %s", p)
            return None
    return None


def _save_cached(digest: str, vec: np.ndarray) -> None:
    p = _cache_path(digest)
    p.parent.mkdir(parents=True, exist_ok=True)
    np.save(p, vec.astype(np.float32, copy=False))


def _get_local_model() -> SentenceTransformer:
    global _st_model
    if _st_model is None:
        # Import lazily — sentence-transformers pulls in torch which is slow to import.
        from sentence_transformers import SentenceTransformer

        _st_model = SentenceTransformer(DEFAULT_EMBED_MODEL)
    return _st_model


def _embed_local(texts: list[str], batch_size: int = 64) -> np.ndarray:
    model = _get_local_model()
    vecs = model.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=False,
        convert_to_numpy=True,
        normalize_embeddings=True,
    )
    return np.asarray(vecs, dtype=np.float32)


def _truncate_for_openai(texts: list[str]) -> list[str]:
    """Cap each text to a safe token length before sending to OpenAI.

    Uses tiktoken when available for an exact cap; falls back to a generous
    char-based cap otherwise (~4 chars per token in English). Either path
    guarantees the request stays inside the model's 8191-token ceiling, so a
    single oversized row can't fail the whole batch with an unhandled error.
    """
    try:
        import tiktoken

        enc = tiktoken.encoding_for_model(OPENAI_MODEL)
        out: list[str] = []
        for t in texts:
            tokens = enc.encode(t, disallowed_special=())
            if len(tokens) <= OPENAI_MAX_TOKENS:
                out.append(t)
            else:
                out.append(enc.decode(tokens[:OPENAI_MAX_TOKENS]))
        return out
    except ImportError:
        # tiktoken not installed — use char-based cap as a safe over-approximation.
        return [
            t if len(t) <= OPENAI_CHAR_CAP_FALLBACK else t[:OPENAI_CHAR_CAP_FALLBACK]
            for t in texts
        ]


def _embed_openai(texts: list[str], batch_size: int = 128) -> np.ndarray:
    if not OPENAI_API_KEY:
        raise RuntimeError("embed_model='openai' requested but OPENAI_API_KEY is not set")
    from openai import OpenAI

    client = OpenAI(api_key=OPENAI_API_KEY)
    capped = _truncate_for_openai(texts)
    out: list[list[float]] = []
    for i in range(0, len(capped), batch_size):
        chunk = capped[i : i + batch_size]
        resp = client.embeddings.create(
            model=OPENAI_MODEL,
            input=chunk,
            dimensions=EMBED_DIM,  # native truncation to keep schema 384-dim
        )
        out.extend(d.embedding for d in resp.data)
    arr = np.asarray(out, dtype=np.float32)
    # Normalize to match MiniLM's normalize_embeddings=True default.
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def embed_texts(texts: list[str], embed_model: str = DEFAULT_EMBED_MODEL) -> np.ndarray:
    """Return an (N, 384) float32 array. Cached per (model, text) on disk."""
    if not texts:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)

    use_openai = embed_model.lower() == "openai"
    model_key = OPENAI_MODEL if use_openai else DEFAULT_EMBED_MODEL

    digests = [_hash_text(model_key, t) for t in texts]
    cached: list[np.ndarray | None] = [_load_cached(d) for d in digests]

    missing_idx = [i for i, v in enumerate(cached) if v is None]
    if missing_idx:
        missing_texts = [texts[i] for i in missing_idx]
        fresh = _embed_openai(missing_texts) if use_openai else _embed_local(missing_texts)
        for j, i in enumerate(missing_idx):
            cached[i] = fresh[j]
            _save_cached(digests[i], fresh[j])

    out = np.vstack([v for v in cached if v is not None]).astype(np.float32, copy=False)
    if out.shape[1] != EMBED_DIM:
        raise RuntimeError(f"Expected {EMBED_DIM}-dim embeddings, got {out.shape[1]}")
    return out
