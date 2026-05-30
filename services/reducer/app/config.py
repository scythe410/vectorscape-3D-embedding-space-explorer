"""Reducer service configuration."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(REPO_ROOT / ".env", override=False)
load_dotenv(Path.cwd() / ".env", override=False)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()

CACHE_DIR = Path(
    os.environ.get("REDUCER_CACHE_DIR", str(Path.home() / ".cache" / "vectorscape" / "embeddings"))
)
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Threshold at which to apply PCA-100 as a speed guard before PaCMAP/UMAP.
PCA_THRESHOLD = int(os.environ.get("REDUCER_PCA_THRESHOLD", "20000"))

# Default scale the engine expects after coord normalization (cube radius).
COORD_SCALE = float(os.environ.get("REDUCER_COORD_SCALE", "60.0"))

DEFAULT_EMBED_MODEL = "all-MiniLM-L6-v2"
DEFAULT_REDUCER = "pacmap"
EMBED_DIM = 384
