"""Generate the demo embeddings binary used by /api/demo/search.

One-off: reads the demo JSON (point texts in fixed order), embeds with the
default MiniLM model, and writes a packed float32 array to the web app's
private data dir. The web route mmap-reads this at request time and scores
cosine against the query vector returned by the reducer's /embed endpoint.

Run from the repo root:
    uv --project services/reducer run python -m app.demo_embed_gen

Idempotent — caches via embed_texts' per-text disk cache, so re-runs after
a text change only re-embed the changed rows.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np

from .config import DEFAULT_EMBED_MODEL, EMBED_DIM
from .embeddings import embed_texts

REPO_ROOT = Path(__file__).resolve().parents[3]
DEMO_JSON = REPO_ROOT / "apps" / "web" / "public" / "demo" / "skm-galaxy.json"
OUT_DIR = REPO_ROOT / "apps" / "web" / "lib" / "demo"
OUT_BIN = OUT_DIR / "skm-galaxy.embeddings.bin"
OUT_META = OUT_DIR / "skm-galaxy.embeddings.meta.json"


def main() -> int:
    if not DEMO_JSON.exists():
        print(f"missing {DEMO_JSON}", file=sys.stderr)
        return 1
    with DEMO_JSON.open("r", encoding="utf-8") as f:
        bundle = json.load(f)
    points = bundle.get("points") or []
    if not points:
        print("demo JSON has no points", file=sys.stderr)
        return 1

    texts = [p.get("text") or "" for p in points]
    n = len(texts)
    print(f"embedding {n} demo points with {DEFAULT_EMBED_MODEL}…")
    arr = embed_texts(texts, embed_model=DEFAULT_EMBED_MODEL)
    if arr.shape != (n, EMBED_DIM):
        print(f"unexpected shape {arr.shape}; expected ({n}, {EMBED_DIM})", file=sys.stderr)
        return 1

    # Already normalized by embed_texts; defensive renormalize so the route can
    # use a raw dot-product (== cosine) without per-call np work.
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    arr = (arr / norms).astype(np.float32, copy=False)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # File format: 16-byte header (magic 'VSEM', uint32 N, uint32 dim, uint32 reserved)
    # followed by N*dim float32 LE values. Small + self-describing.
    with OUT_BIN.open("wb") as f:
        f.write(b"VSEM")
        f.write(struct.pack("<III", n, EMBED_DIM, 0))
        f.write(arr.tobytes(order="C"))

    meta = {
        "embed_model": DEFAULT_EMBED_MODEL,
        "count": n,
        "dim": EMBED_DIM,
        "source": str(DEMO_JSON.relative_to(REPO_ROOT)),
        "bin": OUT_BIN.name,
    }
    OUT_META.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT_BIN} ({OUT_BIN.stat().st_size / 1e6:.1f} MB)")
    print(f"wrote {OUT_META}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
