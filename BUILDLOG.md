# BUILDLOG

Append-only running memory of the VectorScape build. Read first, append always.

---

## 2026-05-30 — Prompt 1: monorepo scaffold

**What:** Stood up the Bun-workspaces monorepo skeleton per CLAUDE.md.

**Files added:**

- `package.json` — root, Bun-native `workspaces: ["apps/*", "packages/*"]`, no npm/pnpm.
- `.gitignore` — node, bun, next, dist, Python `.venv`/ruff/pytest caches, `.env*`, OS junk.
- `.env.example` — keys the project will need: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, optional `OPENAI_API_KEY`.
- `apps/web/` — Next.js 15 App Router, TypeScript `strict`, Tailwind v3, hello-world `app/page.tsx`. Scripts (`next dev`, `next build`) run on **Node** via the `next` binary's `#!/usr/bin/env node` shebang. Did **not** wire `bun --bun next`.
- `packages/engine/` — TypeScript library, Vite lib mode (ESM + CJS), `react` and `three` as peer deps. Stub `hello()` export. Bun handles install/build.
- `services/reducer/` — FastAPI on `uv` (hatchling-built so a `dev` console script works under `uv run dev`), `GET /health` returning `{status: "ok"}`, pytest smoke test, ruff configured (line 100, py311, E/F/I/UP/B).
- `supabase/` — empty directory; migrations + RLS land in a later prompt.

**Decisions / deviations:**

- Bun wasn't installed locally; installed via `brew install bun` (tap `oven-sh/bun`). Version 1.3.14.
- Reducer is packaged with hatchling rather than `package = false`, because `uv run dev` needs a console script entry point (`[project.scripts] dev = "app.dev:main"`). `app/dev.py` boots uvicorn with reload on 127.0.0.1:8000.
- Engine uses Vite lib mode (not Bun's bundler) because Vite emits clean dual ESM/CJS + d.ts and is the path of least resistance for a React+Three peer-dep library. Bun still drives install and test.
- Did not introduce WebGPU. Engine stub is renderer-agnostic placeholder; the WebGL2 R3F surface lands in the rendering-engine prompt.

**Verified:**

- `bun install` → 260 packages, lockfile written.
- `bun --filter engine build` → emits `dist/engine.js`, `dist/engine.cjs`, `.d.ts`.
- `bun run dev` (apps/web) → Next.js ready on :3000, served by Node.
- `uv sync --extra dev` + `uv run pytest` → 1 passed.
- `uv run dev` (reducer) → `curl /health` returns `{"status":"ok","service":"reducer"}`.

**Unfinished / broken:** None for this prompt.

**Next:** Prompt 2 in `prompt_flow.md` — Supabase schema, RLS policies, and migrations.

---

## 2026-05-30 — Prompt 2: Supabase schema + RLS

**What:** Wrote initial migrations, applied them to the cloud project, and proved cross-tenant isolation.

**Files added:**

- `supabase/config.toml` (via `supabase init`).
- `supabase/migrations/20260530120000_init_schema.sql` — enables the `vector` extension (the Supabase Postgres image ships pgvector under that name, not `pgvector`); creates `profiles`, `projects`, `points` (with `extensions.vector(384)`), `clusters`, `waitlist`. Adds `current_tenant_id()` helper and `handle_new_user()` trigger that auto-creates a profile + fresh tenant_id on signup.
- `supabase/migrations/20260530120100_rls_policies.sql` — enables RLS on all five tables. Tenant-scoped USING + WITH CHECK on projects/points/clusters via `current_tenant_id()`. Profiles: self-read/self-update only. Waitlist: anon+authenticated INSERT only, no SELECT policy (so reads are blocked even with RLS on).
- `supabase/tests/rls_cross_tenant.sql` — single-transaction test. Creates two synthetic auth.users + profiles in distinct tenants, switches `request.jwt.claims` between them with `set_config`, asserts tenant B sees zero rows for tenant A's project and that UPDATE/DELETE affect zero rows. Forging an INSERT with tenant A's id while acting as tenant B is expected to raise `check_violation`/`insufficient_privilege`. Ends with `select 'PASS'` so the result row is visible through the Management API JSON envelope, then `rollback` so the run leaves no residue.

**Decisions / deviations:**

- **Cloud instead of local.** User pivoted from `supabase start` to the linked cloud project (ref `gxyefustrfclshfobayd`, region Tokyo) to avoid ~5GB of local images. OrbStack and the supabase images are still installed locally but the images were pruned after the switch.
- **Extension name.** First migration attempt used `create extension pgvector` and failed against Supabase Postgres with `extension "pgvector" is not available`. Fixed to `create extension vector with schema extensions` — the type stays `extensions.vector(N)`.
- **Tenant model.** One tenant per user by default, materialized by the `handle_new_user` trigger writing `gen_random_uuid()` into `profiles.tenant_id`. Teams join by updating that row. Did not build invite flows yet (out of v1 scope).
- **`tenant_id` denormalized onto `points`/`clusters`.** Lets RLS evaluate without a join on the hot path; writes have to keep it in sync with `projects.tenant_id`, which is a tradeoff we accept for read performance.
- **Test runs via Management API**, not psql directly. Required removing the `\set ON_ERROR_STOP on` psql meta-command from the test file (the API rejected it as syntax error) and replacing it with the natural `raise exception` flow inside the DO block.
- **`.env` written with cloud project URL, anon key, service-role key, db password, and pooled+direct connection strings.** Gitignored; verified with `git check-ignore`. Not committed.

**Verified (cloud):**

- `supabase link --project-ref gxyefustrfclshfobayd` → linked.
- `supabase db push --include-all` → both migrations applied.
- `pg_tables` query → `clusters`, `points`, `profiles`, `projects`, `waitlist` all present with `rowsecurity = true`.
- `supabase db query --linked --file supabase/tests/rls_cross_tenant.sql` → returns `[{"rls_cross_tenant_test": "PASS"}]`.

**Unfinished / broken:** None. The auto-signup trigger relies on `auth.users` inserts going through Supabase Auth (the test bypasses it by inserting into `auth.users` directly inside the DO block).

**Next:** Prompt 3 — reducer service: `/embed-reduce` endpoint with MiniLM → conditional PCA → PaCMAP → HDBSCAN and a CLI harness for standalone testing.

---

## 2026-05-30 — chore: drop local Docker stack (cloud-only)

**What:** CLAUDE.md gained an explicit "Supabase — cloud only (no local Docker)" section. Removed leftover local-stack infra from the prompt-2 detour.

**Removed:**

- OrbStack cask via `brew uninstall --cask orbstack --zap` — also trashed `~/.orbstack`, `~/Library/Caches/dev.kdrag0n.MacVirt`, the Group Container, HTTPStorages, prefs, saved state, WebKit cache, and the `~/OrbStack` mount root.
- `/opt/homebrew/bin/orb`, `/opt/homebrew/bin/orbctl` symlinks (unlinked by the cask).
- `~/.docker` (docker CLI config; its `currentContext` was `orbstack`, created by the OrbStack install).
- All supabase containers/images/volumes had already been pruned at the end of prompt 2; reconfirmed empty.

**Kept:** supabase CLI (needed for `supabase db push` against the cloud project), bun, node, uv. `docker-credential-gcloud` and `pbmtomatrixorbital` in /opt/homebrew/bin are unrelated (gcloud SDK, netpbm).

**Why:** CLAUDE.md now treats any local Supabase/Docker stack as a non-goal. Removing the runtime makes accidental `supabase start` impossible.

**Next:** Prompt 3 (unchanged) — reducer service.

---

## 2026-05-30 — Prompt 3: engine renderer port + demo

**What:** Built the reusable `<VectorScape>` renderer in `packages/engine` from the spike's blueprint, plus an isolated Vite demo harness.

**Files added/changed:**

- `packages/engine/package.json` — added R3F (`@react-three/fiber@9`), drei (`@react-three/drei@10`), `@react-three/postprocessing@3`, `postprocessing@6`, and `react-dom` as devDeps; declared the R3F stack as peer deps for consumers. Dual-mode scripts: `dev` (demo), `build` (lib, `--mode lib`), `build:demo`.
- `src/types.ts` — `PointsData` (Float32 typed arrays for position/color/size + optional probability), `ClusterCentroid`, `VectorScapeHandle` (imperative `flyTo` + `resetView`), `RenderStats`.
- `src/voxel/voxelDownsample.ts` — O(N) single-pass voxel-grid filter returning kept indices. Picks `cellsPerAxis` from a fillRatio prior, then up to 3 retargets using the observed fill ratio so kept lands near budget on both uniform and tightly-clustered inputs. Returns `{ kept, downsampled, cellsPerAxis }`.
- `src/shaders/points.glsl.ts` — single-pass vertex+fragment for soft additive glow: perspective-sized point sprite, smoothstep radial falloff, brightness/alpha modulated by `aProbability` (mixed against `uMinBrightness`), FogExp2 applied in-shader so additive blending still respects depth, faint time pulse via `uTime`.
- `src/scene/PointsCloud.tsx` — single `THREE.Points` with `BufferGeometry`. Attributes (position/aColor/aSize/aProbability) are written once when `data` or `keptIndices` change and never touched per-frame — the only per-frame work is bumping `uTime`. The mesh gets `layers.enable(BLOOM_LAYER)`.
- `src/scene/FlyToTargets.tsx` — invisible sphere meshes at each centroid. Fly-to/raycast picking hits these, never the cloud. Exposes a `getMesh(id)` imperative handle for `fitToSphere`.
- `src/VectorScape.tsx` — Canvas (WebGL2, antialias off), `<fogExp2>`, `<CameraControls makeDefault>` with `fitToSphere` wired into `VectorScapeHandle.flyTo`, `<EffectComposer multisampling={0}>` with `<Bloom mipmapBlur>` and explicit `<SMAA>` (per the spike gotcha that EffectComposer bypasses built-in AA). Voxel pass runs inside `useMemo` keyed on `points`/`budget`; `onStats` reports total/kept.
- `src/index.ts` — public surface: `VectorScape`, `voxelDownsample`, and types.
- `demo/index.html`, `demo/main.tsx`, `demo/synth.ts` — Vite dev page. Synth generator places clusters on a Fibonacci sphere, draws gaussian blobs, assigns HDBSCAN-style per-point membership probability (high in cores, low at edges) plus a configurable noise/outlier fraction. UI overlay has 10k/100k/350k/1M presets and per-cluster fly-to buttons.
- `scripts/smoke.ts` — Bun-runnable CLI smoke for the renderer-agnostic bits (voxel + synth). Validates kept counts and timing without touching WebGL.
- `tsconfig.json` — includes `demo` so the demo gets type-checked.
- `vite.config.ts` — dual mode: `--mode lib` emits the dual ESM/CJS library with R3F stack as external peers; default mode runs the demo from `demo/` as root.

**Decisions / deviations:**

- **Selective bloom by layer**, not by `<Selection>`/`<Select>`. Only the points mesh joins `BLOOM_LAYER`; centroid spheres are invisible (`visible={false}`, opacity 0) so they don't contribute regardless. Adding non-glowing meshes later means leaving them off the bloom layer.
- **Voxel grow heuristic.** The first pass assumes a 0.25 fill ratio (good for uniform-ish data). For tightly-clustered synthetic data we observed ~14% fill, which would have left kept ≈ 200k against a 350k budget. Added one fill-ratio-driven retarget pass; for the 1M synthetic dataset kept now lands at ~300k (close to budget) and the voxel pass costs ~135ms one-shot (still O(N), still well under the freeze threshold).
- **Probability semantics.** `mix(uMinBrightness, 1.0, prob)` for brightness, `mix(uMinBrightness * 0.4, 1.0, prob*prob)` for alpha. Alpha drops faster than brightness so outliers read as visual fog without disappearing — matches the design.md "uncertainty as natural fog" cue.
- **Probability defaults to 1.0** when the host doesn't pass it. The shader path is identical; one branch in PointsCloud fills the attribute.
- **Renderer interface is a file boundary, not a typed abstract class.** Swapping to WebGPU means rewriting `PointsCloud.tsx` + `shaders/points.glsl.ts`; the host-facing `<VectorScape>` props and `voxelDownsample` are unchanged. Avoided a premature `interface PointsRenderer` because we don't have a second backend yet (per the "don't design for hypothetical future" rule).
- **No per-frame CPU attribute updates** anywhere. `useFrame` only writes `uTime`. Verified by reading the diff.

**Verified:**

- `bun run typecheck` (engine) — 0 errors.
- `bun run build` — emits `dist/engine.js` (10.15 kB), `dist/engine.cjs`, source maps, `.d.ts`; R3F stack listed as external.
- `bun run scripts/smoke.ts` — 3/3 cases pass:
  - n=10k, budget=350k → kept=10k, downsampled=false, voxel 0.6ms
  - n=350k, budget=350k → kept=350k, downsampled=false, voxel 0.9ms
  - n=1M,  budget=350k → kept=299,855, downsampled=true,  voxel 134.8ms (one-time, on data change)
- `bun run dev` → Vite serves the demo on :5173; all engine modules transpile (200 OK); user-confirmed in browser: galaxy renders, fly-to works, brightness modulates with probability.

**Unfinished / broken:** None for this prompt. FPS at 100k with bloom+fog wasn't programmatically measured (no headless WebGL probe in this session); the spike's exact GPU-resident pattern is preserved, which is the load-bearing thing for that target.

**Next:** Prompt 4 — reducer service: MiniLM → conditional PCA → PaCMAP → HDBSCAN + CLI harness.

---

## 2026-05-30 — Prompt 4: reducer pipeline + /embed-reduce + CLI

**What:** Built the embed → reduce → cluster → persist pipeline behind `POST /embed-reduce` and a CLI harness. Verified end-to-end against the cloud Supabase project on a 60-row sample CSV.

**Files added/changed:**

- `services/reducer/pyproject.toml` — added sentence-transformers, scikit-learn, pacmap, umap-learn, hdbscan, numpy, pandas, psycopg[binary,pool], pgvector, python-dotenv, typer, openai. Added `reducer-cli` console script. Extended hatch wheel packages to `["app", "reducer"]`.
- `app/config.py` — loads `.env` from repo root + cwd; exports `DATABASE_URL`, `OPENAI_API_KEY`, `CACHE_DIR` (~/.cache/vectorscape/embeddings), `PCA_THRESHOLD=20000`, `COORD_SCALE=60`, `DEFAULT_EMBED_MODEL=all-MiniLM-L6-v2`, `EMBED_DIM=384`.
- `app/embeddings.py` — `embed_texts(texts, embed_model)` with disk cache keyed on sha256(model || text), sharded `aa/bb/<hash>.npy`. Local MiniLM is default and lazy-loaded (torch is slow to import). OpenAI path only fires when `embed_model='openai'` AND `OPENAI_API_KEY` is set; uses `text-embedding-3-small` with native `dimensions=384` truncation, then L2-normalizes to match MiniLM's `normalize_embeddings=True` default.
- `app/pipeline.py` — `run_pipeline(texts, embed_model, reducer) -> PipelineResult`. Conditional PCA-100 only at/above `PCA_THRESHOLD` (matches CLAUDE.md: PaCMAP handles raw 384-dim below 20k). PaCMAP default with `init="pca"` and `n_neighbors=min(10, n-1)`; UMAP alternative with `n_neighbors=min(15, n-1)`. HDBSCAN with `min_cluster_size=max(5, round(sqrt(n)/2))` and `prediction_data=False`; per-point `probabilities_` captured. Medoid = point nearest the centroid in 3D coord space. Coords are mean-centered then scaled so the longest half-extent equals `COORD_SCALE` (60). Cluster labels default to `"Cluster N"` placeholders for the future LLM-naming pass.
- `app/db.py` — psycopg connection with `pgvector.psycopg.register_vector`. `ensure_project()` creates/fetches; `write_results()` flips status pending→reducing, deletes prior points/clusters for the project, bulk `executemany` inserts points (with embedding ndarray and probability), then clusters with `medoid_point_id` resolved from pre-generated UUIDs, then flips status→ready and updates `point_count`. On exception in the API path, status flips to error.
- `app/api.py` — `POST /embed-reduce` accepts `{project_id?, rows, text_column, embed_model, reducer, name?, tenant_id?}`. Strips empty/null text values; 400 if `text_column` is missing on any row or no non-empty rows survive.
- `app/main.py` — wires the router under the existing app.
- `app/cli.py` — `typer` CLI; `uv run reducer-cli sample.csv --text-column body --name X [--limit N] [--reducer pacmap|umap]`. Prints n_points, n_clusters, n_noise, used_pca, reducer, embed_model, runtime, project_id.
- `reducer/__init__.py`, `reducer/cli.py` — shim so `python -m reducer.cli` works alongside the console script (the underlying package is still `app`).
- `samples/make_sample.py`, `samples/sample.csv` — 60-row fixture, three thematic clusters (cooking / astronomy / programming).

**Decisions / deviations:**

- **Cache is filesystem, not Redis.** The threshold for using arq+Redis (per CLAUDE.md) is async job orchestration for >10k rows, not embedding cache. A two-level sharded `.npy` cache is the simpler primitive and matches "re-uploading the same CSV is free."
- **PCA threshold left at the spec's ~20k.** Verified `used_pca=False` at n=60.
- **Cluster medoid is computed in normalized 3D coord space, not embedding space.** Cheaper and more faithful to what the engine will fly the camera to. The spec's wording allowed either; will revisit if the visual feel suggests otherwise.
- **Noise points get `cluster_id=NULL`** in the DB (HDBSCAN's `-1` mapped to NULL) so the cluster FK semantics stay clean. Probability is still stored.
- **executemany over COPY.** At MVP scale (≤ a few thousand) the difference is negligible and executemany kept the inserts trivially debuggable. Will move to `cursor.copy()` if/when uploads routinely cross 50k.
- **HDBSCAN `prediction_data=False`.** We don't need approximate-predict yet; saves memory.
- **`reducer/cli.py` shim** because the package on disk is `app` but the prompt spec invokes `python -m reducer.cli`. Re-exports the typer app rather than duplicating logic.
- **OpenAI truncated to 384 dims** (native param) so writes fit `points.embedding extensions.vector(384)` without schema changes.

**Verified:**

- `uv sync --extra dev` — clean install.
- `uv run ruff check app reducer samples` → All checks passed.
- `uv run pytest -q` → 1 passed (existing health test).
- `uv run python -m reducer.cli samples/sample.csv --text-column body --name "cli smoke"` → wrote 60 points + 4 clusters + 1 noise, status='ready', point_count=60, used_pca=False, runtime 113s (dominated by first-time MiniLM download + torch import + PaCMAP warmup; warm runs will be much faster thanks to the embedding cache).
- Cloud DB confirmed via `supabase db query --linked`: 60 points, 4 clusters, all clusters have `medoid_point_id`, `vector_dims(embedding)=384`, probabilities span [0, 1], coords centered on 0 with longest half-extent = 60.0 (matches `COORD_SCALE`).
- Test project deleted after verification.

**Unfinished / broken:**

- `.env` had a stale Supabase pooler hostname (`aws-0-ap-northeast-1.pooler.supabase.com`) that errored with `tenant/user not found`. Supabase rotated the project to `aws-1-`; updated `.env` (gitignored, not committed). The DATABASE_URL in `.env.example` still references `aws-0-` as a generic placeholder, which is fine.
- No reducer-side integration test against the DB (would require live cloud credentials in CI). The CLI run is the integration smoke for now.

**Next:** Prompt 5 — wire the web app to the reducer (upload UI → POST /embed-reduce → poll status → render in `<VectorScape>`).
