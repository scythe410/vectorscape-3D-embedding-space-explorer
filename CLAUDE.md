# CLAUDE.md — VectorScape

Context and conventions for Claude Code. Read this before every task.

## What this is

VectorScape turns AI embeddings into a beautiful 3D space you *fly through*. Users bring their own data (CSV), watch it cluster as a galaxy, and ask an LLM to explain the gaps between clusters. The north star is **navigation feel** — cinematic flight, not a correct-but-ugly scatter plot.

Companion docs: `VectorScape_MVP.md` (scope), `VectorScape_Build_Spec.md` (architecture + data contracts), `design.md` (feel), `prompt_flow.md` (build sequence).

## Monorepo (Bun workspaces)

```
apps/web/         Next.js (App Router, TS, Tailwind): landing, SKM lens, sandbox, bridge UI
services/reducer/ FastAPI (uv): /embed-reduce, /bridge, async jobs
packages/engine/  R3F rendering engine — the crown jewel; framework-clean, renderer-agnostic
supabase/         migrations + RLS policies
```

## Hard constraints — do not violate

- **WebGL2, not WebGPU**, for v1. The renderer spike proved WebGL2 carries the full point budget with the mature `@react-three/postprocessing` stack. Keep the renderer behind a thin interface in `packages/engine` so WebGPU is a future swap, not a rewrite — but do not introduce it now.
- **Point budget ≈ 350k live** for 60fps flight. Above it, **density-downsample for rendering**; keep the full dataset server-side for picking/search. Never try to render 1M labeled points.
- **Downsampling must be O(N).** Use a **voxel-grid filter** (hash each point into a 3D grid cell, keep one representative per occupied cell). Never use pairwise-distance or any O(N²) approach to find dense regions — it will freeze the thread at 1M points.
- **GPU-resident buffers.** Point positions/colors/sizes live in `BufferGeometry` attributes and are **never updated per-frame on the CPU**. This is the single thing that made the spike fast (CPU sat at 1.3ms at 1M points). Animate via uniforms/shaders, not attribute rewrites.
- **One draw call for the cloud.** A single `THREE.Points` with a custom additive `ShaderMaterial`. Do not split the cloud into many meshes.
- **Fly-to hits invisible centroid spheres, not the cloud.** Raycasting 100k+ points per click is too slow.
- **Tenant isolation.** Every `projects`/`points`/`clusters` row carries `tenant_id`; RLS restricts to the caller's tenant. **Uploaded data is private by default.** Never weaken RLS for convenience.
- **Cost discipline.** Default embeddings are the free local `all-MiniLM-L6-v2`. OpenAI is an opt-in toggle, never the default — a sandbox that costs money per upload is a bad shape.
- **No secrets in code or commits.** Use `.env`; document keys in `.env.example`.

## Deferred — do not build in v1

Time-lapse, cross-language collision, the non-SKM lenses, OAuth source connectors, any actual XR build, WebGPU. These are roadmap. If a task seems to require one, stop and flag it.

## Stack specifics

- **Engine:** R3F + drei (`<CameraControls>` with `fitToSphere` for fly-to) + `@react-three/postprocessing` (selective bloom, optional DOF) + `FogExp2`. Soft additive points via custom GLSL.
- **Reducer:** sentence-transformers (`all-MiniLM-L6-v2`, 384-dim, cached) → **conditional PCA** (skip under ~20k points where PaCMAP handles raw 384-dim; apply PCA-100 above as a speed guard) → PaCMAP (default) or UMAP → HDBSCAN → medoids **+ per-point cluster-membership probability**. arq + Redis for >10k rows.
- **Storage/auth:** Supabase (Postgres + pgvector + Auth + RLS + Storage).
- **Transport:** JSON coords under ~50k points; Apache Arrow (typed arrays straight to GPU) above.

## Data contracts (authoritative copy in Build Spec)

- `projects(id, tenant_id, name, status[pending|reducing|ready|error], point_count, embed_model, reducer, created_at)`
- `points(id, project_id, text, x, y, z, cluster_id, cluster_probability, embedding vector(384))`
- `clusters(id, project_id, cluster_id, label, cx, cy, cz, medoid_point_id, size)`
- `waitlist(id, email, platform[quest|vision_pro], created_at)`

## Commands

```
bun install                       # all workspaces (replaces npm + pnpm)
bun --filter web dev              # Next.js dev — runs on NODE (see toolchain note)
bun --filter engine build         # build the engine lib (Bun all the way)
cd services/reducer && uv run dev # FastAPI dev (Python — Bun not involved)
cd services/reducer && uv run pytest
```

## Toolchain — Bun, with one boundary

- **Package manager + workspaces = Bun.** `bun install` everywhere; use Bun's native workspaces (`workspaces` in the root `package.json`). No npm, no pnpm.
- **`apps/web` (Next.js): install with Bun, RUN with Node.** Next.js still relies on Node APIs Bun doesn't fully implement; the `web` dev/build scripts execute under Node, not `bun --bun next`. Do not switch the Next.js runtime to Bun unless explicitly validated later. (Three.js / R3F are pure JS and fine either way — the constraint is Next.js itself.)
- **`packages/engine`: Bun all the way** — pure TS lib; Bun as bundler + test runner.
- **`services/reducer`: untouched by this** — Python on `uv`. Bun is a JS tool with zero role here.

## Build log — read first, append always

Maintain `BUILDLOG.md` at the repo root as the running memory of this build. **At the start of every task, read it first** to reconstruct what's already done, what decisions were made, and what's in progress — especially after a crash, context reset, or a new session. **At the end of every task, append an entry.** Never rewrite or delete past entries; only add.

Each entry records: date/time, which prompt or task, what was built or changed (files + why), any decisions or deviations from the spec and the reason, anything left unfinished or broken, and the next step. If a task fails partway, log what was completed and what wasn't before stopping, so the next run can resume safely. Keep entries terse and factual — this is a recovery tool, not prose.

## Commits — no attribution

- **End every prompt/task with a commit.** One commit per prompt in `prompt_flow.md`; use conventional-commit messages (`feat:`, `fix:`, `chore:`, `refactor:`) that describe *what changed and why*.
- **Never attribute work to Claude, an AI, or any assistant — anywhere.** Not in commit messages, not in a `Co-authored-by` trailer, not in code comments, file headers, PR descriptions, or docs. No "Generated with…", no AI co-author lines. Commits read as ordinary human authorship.

## Conventions

- TypeScript `strict`. Python: `uv` for deps, `ruff` for lint/format, type hints throughout.
- Append to `BUILDLOG.md` after every task (see above); commit it alongside the work it describes.
- **Make it work end-to-end before making it pretty.** The feel-polish pass is the *last* prompt by design.
- Test the reducer standalone (CLI harness) before wiring it to the web app.
- When unsure about scope, prefer the smaller version and flag the question rather than building speculatively.

## Spike gotchas (learned, don't relearn)

- Bloom is **fill-rate bound** — cost scales with glowing pixels, not point count. Shrinking point size buys large headroom at high counts.
- `EffectComposer` bypasses the renderer's built-in antialiasing; add FXAA/SMAA explicitly.
- Generating very large synthetic datasets causes a one-time JS hitch — that's data-gen, not render cost. Real data arrives pre-computed from the reducer, so this won't apply in production.
