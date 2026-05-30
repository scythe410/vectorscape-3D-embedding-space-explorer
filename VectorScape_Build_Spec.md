# VectorScape — Build Spec (v1)

Companion to `VectorScape_MVP.md`. This is the lean build plan, written *after* the renderer spike so the rendering question is already answered. It ends in a Claude Code prompt sequence.

## Spike result (settled)

- WebGL2 + R3F holds **30fps at 1,000,000** glowing points, GPU-bound (29ms), CPU idle (1.3ms). Architecture validated: GPU-resident buffers, ~one draw call.
- **Hero look = dense glowing starfield.** No WebGPU needed for v1.
- **Live point budget ≈ 250k–400k** for buttery 60fps flight. Above that → density-downsample for the flythrough; keep full data server-side for picking/search.
- **Amendment to MVP doc:** v1 renders on **WebGL2** (not WebGPU-with-fallback). Keep the engine renderer-agnostic so WebGPU is a later swap, not a rewrite. WebGPU joins XR on the "coming soon" shelf.

## Stack (settled)

| Layer | Choice |
|---|---|
| Front end | Next.js (App Router) + React Three Fiber + drei + `@react-three/postprocessing` (WebGL2) |
| Camera | `camera-controls` via drei `<CameraControls>` — `fitToSphere` for fly-to |
| Reducer service | FastAPI (Python): embed → conditional PCA (skip <20k pts; PCA-100 above) → PaCMAP (default) / UMAP → HDBSCAN → 3D coords + medoids + per-point membership probability |
| Embeddings | `sentence-transformers/all-MiniLM-L6-v2` (free, local, 384-dim) default; OpenAI `text-embedding-3-small` optional toggle |
| Async | Redis + arq for uploads > ~10k rows; sync path under that |
| Storage / auth / tenancy | Supabase (Postgres + pgvector + Auth + RLS); per-project artifacts in Supabase Storage |
| Bridge | RAG over cluster medoids **+ boundary points** (A nearest to B and vice versa) → LLM |

## Monorepo layout

```
vectorscape/
  apps/web/              Next.js app: landing, SKM lens, sandbox, bridge UI
  services/reducer/      FastAPI: /embed-reduce, /bridge
  packages/engine/       the R3F rendering engine — the crown jewel, framework-clean
  supabase/              migrations + RLS policies
  CLAUDE.md              build conventions for Claude Code
```

`packages/engine` is isolated on purpose: it's what gets reused for the XR phase, and what every lens renders through. The spike code ports into here almost directly — swap synthetic data for a `loadProject(coords, clusters)` API.

## Data contracts

**`projects`** — `id, tenant_id, name, status(pending|reducing|ready|error), point_count, embed_model, reducer(pacmap|umap), created_at`

**`points`** — `id, project_id, text, x, y, z, cluster_id, cluster_probability, embedding vector(384)` (pgvector; `embedding` powers search + Bridge; `cluster_probability` is HDBSCAN membership strength, modulating point brightness in the engine)

**`clusters`** — `id, project_id, cluster_id, label, cx, cy, cz, medoid_point_id, size`

**Reducer `POST /embed-reduce`** → in: `{project_id, rows[], text_column, embed_model, reducer}` · out (or job): writes `points` + `clusters`, sets `projects.status=ready`.

**Reducer `POST /bridge`** → in: `{project_id, cluster_a, cluster_b}` · out: `{summary, examples_a[], examples_b[]}` — pulls each cluster's medoid + nearest texts, prompts the LLM to explain the shared/missing semantic context, returns prose + cited example points.

**Coords transport:** JSON for < ~50k points; Apache Arrow (typed arrays straight to GPU buffers) above that.

**RLS:** every `points`/`clusters`/`projects` row carries `tenant_id`; policy restricts to `auth.uid()`'s tenant. Uploaded data private by default.

## Build phases

**Phase 0 — Scaffold + engine.** Monorepo, `CLAUDE.md`, Supabase project + migrations + RLS. Port the spike into `packages/engine` as a clean component that takes real coords/clusters via props instead of generating synthetic data. Density-downsampling to the point budget lives here.

**Phase 1 — Reducer (standalone).** FastAPI service: CSV rows → embed → PCA-100 → PaCMAP → HDBSCAN → coords + medoids. Test against a sample CSV from the command line before any wiring. Sync path + arq job path.

**Phase 2 — Sandbox (end to end).** Upload CSV → Supabase Storage → trigger reduce → poll status → fetch coords → render in the engine. This is the product; get it working start-to-finish before prettifying.

**Phase 3 — SKM lens + landing.** One pre-baked "documents as a galaxy" dataset, the scripted intro flythrough, and the landing page that routes into the lens (marketing) and the sandbox (product).

**Phase 4 — Bridge.** Cluster multi-select in the engine → `/bridge` → render the LLM explanation panel with cited example points.

**Phase 5 — XR waitlist + feel polish.** "Quest / Vision Pro coming soon" section with email capture (Supabase table). Then the polish pass that is the whole point: tune `smoothTime`, easing, fog, selective bloom, optional DOF, the galaxy↔architectural morph thresholds.

## Claude Code prompt sequence

Run in order; each is one discrete task. Commit between prompts.

1. Scaffold the monorepo (Bun workspaces — replaces npm/pnpm): `apps/web` (Next.js App Router + TS; installs with Bun, runs on Node), `services/reducer` (FastAPI + uv), `packages/engine` (TS lib, Bun-native), `supabase/`. Add root `CLAUDE.md` with conventions.
2. Supabase: migrations for `projects`, `points` (pgvector 384), `clusters`, `waitlist`; RLS policies keyed on `tenant_id = auth.uid()`'s tenant; enable pgvector.
3. Port the renderer spike into `packages/engine` as `<VectorScape coords clusters budget>`; replace synthetic generation with prop-driven data; add density-downsampling to a configurable point budget (default 350k); keep the renderer behind a thin interface.
4. Reducer service: `POST /embed-reduce` — accept rows + text column, embed with all-MiniLM-L6-v2 (cached), PCA-100, PaCMAP, HDBSCAN, compute medoids, write `points`+`clusters`, set status. CLI test harness against a sample CSV.
5. Add the arq + Redis job path to the reducer for > 10k rows; `GET /status/{project_id}`.
6. Web: CSV upload UI → Supabase Storage → create `projects` row → call reducer → poll status. No 3D yet; just get a `ready` project with rows in the DB.
7. Web: fetch a ready project's coords/clusters and render through `packages/engine`; JSON transport first. The sandbox now works end to end.
8. Add Arrow transport for projects above ~50k points; verify typed arrays load into GPU buffers without a JSON parse stall.
9. SKM lens: bundle one pre-baked dataset as a ready project; build the landing page routing to lens (demo) and sandbox (product); add the scripted intro flythrough (Theatre.js or a hand-tuned camera path).
10. Bridge: cluster multi-select in the engine; `POST /bridge` retrieves medoids + nearest texts via pgvector and prompts the LLM; render the explanation panel with cited points.
11. XR waitlist section + email capture into `waitlist`; honest "coming soon" framing for Quest + Vision Pro.
12. Feel-polish pass: tune camera `smoothTime`/easing, fog, selective bloom, optional DOF toggle, and the galaxy↔architectural morph distance thresholds. This is the north-star pass — budget real time here.

## The one thing to polish

Navigation feel. Everything else can be average if the flight is exceptional — that's the entire reason VectorScape beats "correct but ugly." Prompt 12 is not cleanup; it's the product.

## Deferred

See `roadmap.md` for everything held out of v1 (time-lapse, cross-language, other lenses, XR, WebGPU) and the technical-review items parked for later (distributed reducer, semantic-zoom dendrogram, multilingual/LoRA) — each with the reasoning for why it waits.
