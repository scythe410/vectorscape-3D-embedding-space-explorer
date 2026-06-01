---
title: VectorScape Reducer
emoji: 🌌
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
short_description: Embeddings + dim reduction + clustering for VectorScape.
---

# VectorScape Reducer

FastAPI service that turns text rows into 3D coordinates + clusters for the
VectorScape web app. The web app calls this service over HTTPS with a shared
secret in the `X-Reducer-Secret` header.

## Endpoints

- `GET /health` — liveness probe (unauthenticated).
- `POST /embed-reduce` — embed → optional PCA → PaCMAP/UMAP → HDBSCAN, then
  write `points` + `clusters` rows to Supabase. Requires `X-Reducer-Secret`.
- `GET /status/{project_id}` — poll project status. Requires `X-Reducer-Secret`.
- `POST /bridge` — explain the gap between two clusters via LLM. Requires
  `X-Reducer-Secret`.

## Required environment

Set these as **secrets** in the Space settings (Settings → Variables and secrets):

| Name | Purpose |
| --- | --- |
| `REDUCER_SHARED_SECRET` | Must match the value set on the web app. Auth fails closed if unset. |
| `DATABASE_URL` | Supabase Postgres connection string (service-role; bypasses RLS). |
| `OPENAI_API_KEY` | Optional. Only used when callers request `embed_model=openai` or for `/bridge`. |
| `GEMINI_API_KEY` | Optional. `/bridge` fallback when `OPENAI_API_KEY` isn't set — routes through Gemini's OpenAI-compatible endpoint (free tier on AI Studio). |
| `REDUCER_ASYNC_THRESHOLD` | Set to `999999` here — no Redis on this Space, so all jobs must run inline. |

## Notes

- The `all-MiniLM-L6-v2` model is pre-downloaded at image build time, so the
  first request after a cold start doesn't pay the model download cost.
- Inline-only on this Space (no arq worker, no Redis). Datasets above the
  threshold will time out the HTTP request — small/demo CSVs only.
- Source of truth: this directory is mirrored from the
  [`vector-scape`](https://github.com/) monorepo's `services/reducer/`.
