# VectorScape

Turn AI embeddings into a 3D space you fly through. Bring a CSV, watch it cluster as a galaxy, ask an LLM to explain the gaps between clusters. The north star is **navigation feel** — cinematic flight, not a correct-but-ugly scatter plot.

> See `BUILDLOG.md` for the chronological build history.

---

## What's in the repo

```
apps/web/         Next.js 15 (App Router, TS, Tailwind) — landing, /lens demo, /sandbox upload
services/reducer/ FastAPI (uv) — embed → reduce → cluster pipeline, /embed-reduce + /bridge
packages/engine/  R3F WebGL2 renderer — the crown jewel
supabase/         migrations + RLS policies (applied to a hosted Supabase project)
```

The three surfaces:
- **`/`** — landing with a drifting hero galaxy and an XR waitlist form.
- **`/lens`** — pre-baked SKM galaxy (20 Newsgroups, ~8k points). Cinematic flythrough on entry. No auth, no DB lookup.
- **`/sandbox`** — magic-link sign-in, upload a CSV, watch it become a galaxy, shift-click two clusters to bridge.

---

## Prerequisites

Install once:

- **Bun** — package manager + workspaces (`brew install bun`, ≥ 1.3)
- **Node** — Next.js still runs on Node, not Bun (Bun's the installer, Node's the runtime here)
- **uv** — Python toolchain for the reducer (`brew install uv`)
- **Redis** — backs the arq queue for jobs >10k rows (`brew install redis`)
- **Supabase CLI** — for migrating the hosted project (`brew install supabase/tap/supabase`)
- **A hosted Supabase project** — develop against a cloud project, *not* a local Docker stack. See `CLAUDE.md` § "Supabase — cloud only".

---

## First-time setup

```bash
# 1. Install JS workspaces (web, engine — Bun replaces npm/pnpm here)
bun install

# 2. Install Python deps for the reducer
cd services/reducer && uv sync --extra dev && cd ../..

# 3. Copy env template, fill in your Supabase + Redis values
cp .env.example .env
# then edit .env — see "Environment variables" below

# 4. Apply migrations to the cloud Supabase project
supabase link --project-ref <your-project-ref>
supabase db push

# 5. Build the engine once (consumed by apps/web from its dist/)
bun --filter engine build
```

---

## Run the system locally

Open **three terminals**. Each one is a separate long-running process; you'll keep them open.

**Terminal 1 — Redis** (skip if you already have it running)
```bash
redis-server --daemonize yes
# verify:
redis-cli ping     # → PONG
```

**Terminal 2 — Reducer (FastAPI on :8000)**
```bash
cd services/reducer
uv run dev
# health check:
curl http://127.0.0.1:8000/health   # → {"status":"ok","service":"reducer"}
```

**Terminal 3 — Web app (Next.js on :3000)**
```bash
bun --filter web dev
# open:
open http://localhost:3000
```

**Optional — Reducer worker** (only needed for CSVs over 10k rows; jobs above that threshold are queued through arq+Redis instead of running inline)
```bash
cd services/reducer
uv run worker
```

### Stopping cleanly

`Ctrl-C` in each terminal. Redis daemon: `redis-cli shutdown`.

---

## How to use it

### Just want to look at the demo?
1. Start the web app (Terminal 3 only — no reducer, no Redis, no auth needed).
2. Go to `http://localhost:3000/lens`. The SKM galaxy loads from a baked JSON asset; cinematic intro flythrough plays once, then hands you the controls.
3. Toggle the **HQ** pill bottom-right for depth-of-field bokeh.
4. Leave the mouse alone for ~3.5s and the camera starts a near-imperceptible drift (the "ambient breath"). Touch anything → it stops.

### Want to upload your own CSV?
1. Start **all three** processes (Redis, reducer, web).
2. Go to `http://localhost:3000/sandbox`. Sign in via magic link (Supabase Auth emails the link to the address you enter).
3. Drop a CSV, pick the text column, hit **Embed + reduce**.
4. Watch the status panel (pending → reducing → ready). For a few hundred rows this is seconds; for 10k+ rows it queues through arq and takes a minute or two on first run (sentence-transformers downloads its weights on first invocation).
5. When `ready`, the galaxy renders. Click a cluster name in the sidebar to fly; shift-click two clusters to open the **Bridge** panel and ask the LLM what separates them.

> **Bridge LLM:** If `OPENAI_API_KEY` is set in `.env`, Bridge uses `gpt-4o-mini` for the explanation. Without a key it falls back to a structural summary so the cited-points list still renders — that's intentional, not a failure mode.

### CLI shortcut for the reducer

For headless or scripted runs against your CSV (no web app needed):
```bash
cd services/reducer
uv run reducer-cli sample.csv --text-column body --name "my project"
```

---

## Environment variables

Fill `.env` (gitignored — never commit). Template lives in `.env.example`:

| Variable | Used by | What it is |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | web (browser) | Your hosted Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | web (browser) | Public anon key for RLS-gated reads/writes |
| `SUPABASE_URL` | web (server), reducer | Same project URL — used server-side |
| `SUPABASE_SERVICE_ROLE_KEY` | reducer | Bypasses RLS for service writes — **never expose to the browser** |
| `REDIS_URL` | reducer, worker | Defaults to `redis://localhost:6379/0` |
| `REDUCER_URL` | web (server) | Defaults to `http://127.0.0.1:8000` |
| `REDUCER_SHARED_SECRET` | web (server) **and** reducer | Service-to-service auth header. Must be the **same value** on both sides. Reducer refuses requests with 503 if it's unset. For local dev, `dev-local` is fine; in production, use a 32+ char random string |
| `OPENAI_API_KEY` | reducer (Bridge, optional embeddings) | Leave blank to use the free local MiniLM embedder |

The web app reads `.env` from the **monorepo root** (not `apps/web/.env`) — `apps/web/next.config.ts` loads it at config time and forwards `NEXT_PUBLIC_*` into the browser bundle.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Upload fails with "reducer unreachable at http://127.0.0.1:8000" | Reducer FastAPI service isn't running | Start it: `cd services/reducer && uv run dev` |
| Sandbox upload spins forever, then errors with `status fetch failed (502)` | Worker isn't running for a >10k-row CSV | Start it: `cd services/reducer && uv run worker`, or use a smaller CSV |
| "Cannot connect to Redis" in reducer logs | Redis not running | `redis-server --daemonize yes`, then `redis-cli ping` to verify |
| Magic-link email never arrives | Supabase hosted SMTP rate limit, or the address is in spam | Check Supabase dashboard → Auth → Logs. For more than dev volume, configure a real SMTP provider |
| "Your project's URL and Key are required" on `/sandbox` | `.env` not loaded into the web app | Make sure `.env` lives at the **monorepo root**, not in `apps/web/` |
| First reducer run takes 90s+ | `sentence-transformers` is downloading the MiniLM weights and warming PaCMAP | One-time cost. Subsequent uploads use the disk cache and are much faster |

---

## Development

```bash
# Engine (R3F renderer library)
bun --filter engine typecheck
bun --filter engine build
bun --filter engine dev          # Vite demo harness on :5173

# Web (Next.js app)
cd apps/web && bun run typecheck
cd apps/web && bun run build

# Reducer (FastAPI + pipeline)
cd services/reducer && uv run ruff check
cd services/reducer && uv run pytest
```

When you change `packages/engine`, rebuild it (`bun --filter engine build`) before re-testing the web app — `apps/web` consumes the engine from its `dist/`.

---

## Hard constraints (don't violate)

- **WebGL2 only** for v1. WebGPU is roadmap, not now.
- **350k point budget** for 60fps flight. Above it, voxel-grid downsample for rendering; full dataset stays server-side.
- **One `THREE.Points` draw call** for the cloud. GPU-resident attribute buffers, animated via shader uniforms — **never rewritten per-frame on the CPU**.
- **Tenant isolation via RLS.** Uploaded data is private by default. Never weaken RLS for convenience.
- **Cost discipline.** Local MiniLM is the default embedder. OpenAI is opt-in.
- **No secrets in code or commits.** `.env` only.

Items explicitly **deferred** (not in v1): time-lapse, cross-language collision, non-SKM lenses, OAuth source connectors, actual XR builds, WebGPU.
