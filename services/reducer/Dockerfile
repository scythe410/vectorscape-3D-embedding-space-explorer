# VectorScape reducer — Hugging Face Spaces (Docker SDK) image.
#
# HF Spaces requirements baked in:
#   - Runs as uid 1000 ("user"); $HOME must be writable.
#   - App must bind to 0.0.0.0:7860.
#   - sentence-transformers / huggingface caches live under $HOME and are
#     populated at build time so the first request doesn't pay the model
#     download cost (~90 MB for all-MiniLM-L6-v2).
FROM python:3.11-slim

# build-essential is kept because pacmap / hdbscan can fall back to a Cython
# build when a manylinux wheel isn't published for the resolved version. git
# is occasionally needed for pip VCS deps. Both can be dropped later if the
# resolved lock turns out to be pure-wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        git \
    && rm -rf /var/lib/apt/lists/*

# uv from the official static image — matches local toolchain.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

RUN useradd -m -u 1000 user
USER user

ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    HF_HOME=/home/user/.cache/huggingface \
    TRANSFORMERS_CACHE=/home/user/.cache/huggingface \
    SENTENCE_TRANSFORMERS_HOME=/home/user/.cache/huggingface \
    REDUCER_CACHE_DIR=/home/user/.cache/vectorscape/embeddings \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/home/user/.venv \
    PYTHONUNBUFFERED=1

WORKDIR /home/user/app

# Layer 1: install deps only (no project), so source edits don't bust this cache.
COPY --chown=user:user pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Layer 2: pre-warm the local embedding model into the HF cache. First call to
# /embed-reduce in production would otherwise pay a one-time ~90 MB download
# AND torch warmup — both happen here instead, in the build.
RUN uv run python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Layer 3: source + install the project itself.
COPY --chown=user:user app ./app
COPY --chown=user:user reducer ./reducer
RUN uv sync --frozen --no-dev

EXPOSE 7860

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7860"]
