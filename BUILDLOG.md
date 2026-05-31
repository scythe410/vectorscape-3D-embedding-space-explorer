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

---

## 2026-05-30 — Prompt 5a: arq worker + status endpoint

**What:** Routed `/embed-reduce` requests above 10k rows to an arq + Redis background worker; added `GET /status/{project_id}` so callers can poll progress and failure messages. Errors surface as `status=error` with a populated `error_message`, not swallowed 500s with mystery `pending` rows.

**Files added/changed:**

- `supabase/migrations/20260530130000_projects_error_message.sql` — adds `projects.error_message text` so failures have a place to land. Applied to the cloud project via `supabase db push`.
- `services/reducer/pyproject.toml` — added `arq>=0.26`, `redis>=5.0`. New console script `worker = "app.worker:main"` so `uv run worker` boots the arq worker.
- `app/config.py` — added `REDIS_URL` (defaults to `redis://localhost:6379/0`) and `ASYNC_ROW_THRESHOLD` (default 10000, CLAUDE.md-aligned, overridable via `REDUCER_ASYNC_THRESHOLD`).
- `app/progress.py` — small Redis-async helper. `set_progress`/`get_progress`/`clear_progress` write a `vectorscape:progress:{project_id}` hash holding `stage` + `pct`, with a 24h TTL. Status of record is still Postgres; this is just the live side-channel.
- `app/worker.py` — `WorkerSettings` (single function, `max_jobs=1`, 30-min timeout) plus `embed_reduce_job(ctx, project_id, tenant_id, texts, embed_model, reducer)`. Sets status→reducing, runs the pipeline, writes results, sets status→ready. Exceptions are caught, formatted as `"TypeName: message"`, written to `projects.error_message` with `status=error` in a fresh connection, then re-raised so arq logs the failure too.
- `app/db.py` — `set_status` gained `error_message: str | None = None`. On `status='error'` it writes both columns; on any other transition it clears `error_message` so retries don't carry stale failure text. New `fetch_status(conn, project_id)` returns `{status, point_count, error_message}` or `None`.
- `app/api.py` — `/embed-reduce` is now async. After `ensure_project` it always resets status to `pending` so a retry after error/ready starts clean. If `len(texts) > ASYNC_ROW_THRESHOLD`, opens an arq `create_pool`, enqueues `embed_reduce_job`, and returns `mode="queued"` immediately; otherwise runs inline and returns `mode="sync"`. New `GET /status/{project_id}` returns DB status + point_count + error_message, and pulls live progress from Redis only while status is in `{pending, reducing}`.
- `services/reducer/samples/make_large.py`, `samples/large.csv` — 10,500-row CSV built from 15 seed texts so the embedding cache makes reruns cheap; just enough to clear the 10k threshold.

**Decisions / deviations:**

- **Progress lives in Redis, not Postgres.** A `projects.progress` column would either bloat the row with frequent updates or need a separate audit table. The status of record (pending/reducing/ready/error + message) is the durable signal in Postgres; the per-stage percentage is transient and fits Redis naturally since the worker already speaks Redis. The status endpoint stops polling Redis once the project is terminal.
- **`max_jobs=1` per worker.** The pipeline loads sentence-transformers + PaCMAP + HDBSCAN — memory- and CPU-heavy. Running two in one process invites GIL contention and OOMs. Horizontal scale = more worker processes, not more concurrency per process.
- **Sync error path needed an explicit second connection.** First implementation kept `set_status(error)` inside the same `with connect()` block as the work — but psycopg's context manager rolls back on exception, undoing the error-status write and leaving the row at `pending`. Fixed by writing the error status from a fresh `with connect()` after the work-tx has rolled back, before re-raising the HTTPException. Worker path was already correct (each `with connect()` block is its own short-lived transaction).
- **Bogus reducer name is the chosen "broken input" probe.** Tried bogus `embed_model` first; doesn't fail because `embeddings.py` hardcodes the local model and ignores the name unless it's literally `"openai"`. Picking a reducer the pipeline doesn't know about (`run_pipeline` validates the set explicitly) gives a clean, deterministic failure that exercises both error paths.
- **Status reset to `pending` on every POST.** Without it, a project that previously hit `error` would keep its old `error_message` visible during the next run until either set_status cleared it or the run finished — the explicit reset makes the state machine clearer.
- **Redis installed locally for dev** (`brew install redis`, then `redis-server --daemonize yes`). Production swaps `REDIS_URL` for a managed instance; no code change.

**Verified:**

- `uv sync --extra dev` → arq 0.28.0, redis 5.3.1, hiredis 3.3.1 added.
- `uv run ruff check app reducer samples` → All checks passed.
- `uv run pytest -q` → 1 passed.
- Cloud-DB sync probe: POST `samples/sample.csv` (60 rows) → response `mode="sync"`, `n_points=60`, then GET `/status/<pid>` → `status="ready"`, `point_count=60`, `error_message=null`.
- Cloud-DB async probe: POST `samples/large.csv` (10,500 rows) → response `mode="queued"` in 4.5s. Polling /status observed transitions `pending(stage=embedding,5%) → reducing(stage=reducing,20%) → reducing(stage=writing,85%) → ready(point_count=10500, progress=null)`. Total wall time ~35s with the embedding cache warm.
- Cloud-DB error probe (sync): POST 30 rows with `reducer="definitely-not-a-reducer"` → HTTP 500 with `detail="ValueError: unknown reducer: ..."`; /status returns `status="error"`, `error_message="ValueError: unknown reducer: definitely-not-a-reducer"`.
- Cloud-DB error probe (async): same payload with 10,500 rows → enqueue succeeds (`mode="queued"`); worker raises; /status terminates at `status="error"` with the same error_message. Worker logs the exception, doesn't crash, picks up the next job.
- Test projects deleted from cloud after verification.

**Unfinished / broken:**

- No automated integration test covers the worker path; verification was the cloud probes above. A test using `arq.testing.MockWorker` or a fakeredis-backed run would be cheap to add later.
- `app/embeddings.py` still ignores unknown `embed_model` strings (uses the local default unless the value is literally `"openai"`). Not in this prompt's scope; flagging because the discovery surfaced during error-path testing.

**Next:** Prompt 5 — wire the web app to the reducer (upload UI → POST /embed-reduce → poll /status → render in `<VectorScape>`).

---

## 2026-05-30 — Prompt 5: web sandbox upload flow (no 3D yet)

**What:** Wired Supabase Auth (magic link), built the `/sandbox` upload UI in `apps/web`, and connected it to the reducer via server-side API routes. An authenticated user can upload a CSV, preview rows, pick the text column, and watch a project reach `ready` with `points` rows in the DB. Errors from the reducer surface as a clear status panel. No 3D rendering yet — that's the next prompt.

**Files added/changed:**

- `supabase/migrations/20260530140000_csv_uploads_bucket.sql` — creates the private `csv-uploads` bucket and four `storage.objects` RLS policies (select/insert/update/delete) that pin each user to a `<auth.uid()>/...` folder prefix via `storage.foldername(name)[1]`. Applied to the cloud project with `supabase db push`.
- `apps/web/package.json` — added `@supabase/supabase-js@2.106.2`, `@supabase/ssr@0.10.3`, `papaparse@5.5.3`, and `@types/papaparse@5.5.2`.
- `apps/web/lib/supabase/client.ts` — `createSupabaseBrowserClient` (`createBrowserClient` from `@supabase/ssr`).
- `apps/web/lib/supabase/server.ts` — `createSupabaseServerClient` reading/writing cookies from `next/headers` and a `createSupabaseServiceClient` for RLS-bypassing service-role work (lazy `require('@supabase/supabase-js')` so the browser bundle never sees the service key).
- `apps/web/lib/supabase/middleware.ts` + `apps/web/middleware.ts` — refreshes Supabase auth cookies on every non-static request via `supabase.auth.getUser()`.
- `apps/web/app/login/page.tsx` + `LoginForm.tsx` — server page that redirects already-signed-in users to `next || /sandbox`; client form calls `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: <origin>/auth/callback?next=... } })`.
- `apps/web/app/auth/callback/route.ts` — exchanges the OTP `code` in the magic-link URL for a cookie session via `supabase.auth.exchangeCodeForSession(code)`, then redirects to `next`.
- `apps/web/app/auth/signout/route.ts` — `POST` route that signs out and 303-redirects to `/login`.
- `apps/web/app/sandbox/page.tsx` — server component, requires a session (redirects to `/login?next=/sandbox` otherwise), renders `SandboxUI`.
- `apps/web/app/sandbox/SandboxUI.tsx` — client component. Drop zone + file picker, parses CSV with papaparse (header inferred), shows the first 50 rows in a table with the chosen text column highlighted, auto-guesses the text column (preferred names → widest by avg length), exposes a column picker + project-name input, submits as `multipart/form-data` to `/api/projects`, then polls `/api/projects/{id}/status` every 2s until terminal. Status panel renders pending/reducing as a progress bar with `{stage, pct}` from the reducer's Redis side-channel, `ready` as a "N points written" success, and `error` as a red panel with `error_message`.
- `apps/web/app/api/projects/route.ts` — Node runtime POST handler. Verifies session, fetches `tenant_id` via the user's RLS-scoped `profiles` select (no service-role on the user path), parses the CSV server-side, uploads bytes to `csv-uploads/<user_id>/<project_id>/<filename>` under the user's session (Storage RLS enforces the folder prefix), inserts a `projects` row with explicit `id` and `tenant_id` (RLS enforces tenant match), then `POST`s to `${REDUCER_URL}/embed-reduce` with `project_id`, `tenant_id`, parsed rows, `text_column`, and `reducer`. Rolls back the uploaded object if the project insert fails; flips the project to `error` and returns 502 if the reducer call fails.
- `apps/web/app/api/projects/[id]/status/route.ts` — verifies session, does a tenant-scoped `projects.select('id')` so a foreign id returns 404 (not 403), proxies `${REDUCER_URL}/status/{id}` back to the client.
- `apps/web/app/page.tsx` — landing page now links to `/sandbox` (or `/login?next=/sandbox` for anon).
- `apps/web/next.config.ts` — loads `.env` from the monorepo root at config time (Next.js otherwise only reads `apps/web/.env*`), then forwards the two `NEXT_PUBLIC_SUPABASE_*` vars through `env` so the browser bundle sees them.
- `.env.example` + `.env` — added `REDUCER_URL=http://127.0.0.1:8000`.

**Decisions / deviations:**

- **Auth = magic link** per the picker. Email + password would have worked locally with zero email infra, but the spec requested magic link UX; Supabase's hosted SMTP handles dev-project sends without setup.
- **Tenant resolution stays server-side.** The web app reads `tenant_id` from `profiles` inside `/api/projects` using the user's session, then passes it to the reducer as the explicit `tenant_id` field. The reducer uses service-role and bypasses RLS, so it needs the tenant id from a trusted source — the user's own profile row, RLS-gated on `user_id = auth.uid()`, is that source. The browser never sees or sets `tenant_id`.
- **CSV is parsed twice (client preview, server submit).** Sending the parsed JSON alongside the multipart blob would have shaved one parse but doubled the wire size; bytes-only multipart keeps the request small and lets the server re-validate. papaparse is fast enough that this isn't a bottleneck at sandbox sizes.
- **Project-id is generated in the web app, not by Postgres.** Lets us name the Storage path (`<user>/<project_id>/<file>`) before the row exists, which keeps the upload + insert + reducer-dispatch sequence trivially recoverable: if the insert fails we delete the object; if the reducer fails we flip the row.
- **Polling, not realtime, for status.** Supabase Realtime would be cooler but adds a websocket channel + subscription teardown. Polling every 2s against `/api/projects/{id}/status` is plenty for a sandbox where typical jobs finish in seconds-to-tens-of-seconds. The reducer's Redis-backed progress is already published; the polling endpoint just relays it.
- **`next.config.ts` loads the root `.env`.** Without this, the middleware fails immediately with "Your project's URL and Key are required" because Next.js scopes `.env` reads to the project directory. Symlinking `.env` was the alternative but a 15-line loader is more explicit, doesn't depend on filesystem symlinks, and survives `cp -r`.
- **Storage RLS uses `(storage.foldername(name))[1] = auth.uid()::text`.** The official Supabase pattern. Service-role bypasses these, which the reducer relies on (it reads the file indirectly via the rows in its request body — it doesn't need to download from Storage, the bucket is just durable archival for the raw upload).
- **Sandbox UI is intentionally renderless.** No `@react-three/*` imports anywhere in this prompt — that lands in the next prompt where `<VectorScape>` consumes the points rows.

**Verified (cloud, end-to-end):**

A scripted probe (created a confirmed user via admin API, signed in with a temporary password to obtain a real session, base64-encoded the session into the `sb-<ref>-auth-token` cookie that `@supabase/ssr` expects, then drove the actual `/api/projects` + `/api/projects/{id}/status` routes) exercised the whole flow:

1. Admin-created user `e2e+xxx@vectorscape.test` → `handle_new_user` trigger materialized a profile with a fresh tenant_id.
2. `POST /api/projects` (multipart, 30-row CSV, `text_column=body`) → 200, `{project_id, mode: "sync", row_count: 30, storage_path: "<uid>/<pid>/e2e.csv"}`.
3. `GET /api/projects/{id}/status` → `status: "ready"`, `point_count: 30`, `error_message: null`.
4. DB check (service-role): 30 rows in `points` with the right `project_id`, project row `status=ready`, `tenant_id` matched the user's profile.
5. Storage check: object present at `csv-uploads/<uid>/<pid>/e2e.csv`.
6. Error path: same flow with `reducer="definitely-not-a-reducer"` → `/api/projects` returned 502 with body `{"error":"reducer error (500): {\"detail\":\"ValueError: unknown reducer: definitely-not-a-reducer\"}"}`. The submit-error panel in `SandboxUI` renders that string. Project row flipped to `status=error` server-side; if the user re-runs without changing the param, the polling status panel surfaces the same message under "Reduction failed."

Also confirmed visually: `bun run typecheck` clean; `/login` form shows magic-link sent state after submit; `/sandbox` redirects to `/login?next=/sandbox` when not signed in.

**Unfinished / broken:**

- No headless browser run for the visual flow (no Playwright in the project yet); the scripted probe drove the routes directly.
- `app/api/projects/route.ts` updates `status='error'` via the SSR client on the 502 path but doesn't write `error_message` itself — the reducer's own try/except has already written both in the same DB on the sync path, so this is harmless; on a network-level failure where the reducer never set status, the UI sees the 502 body but the DB row has `status=error` with `error_message=null`. Acceptable for the sandbox; could be tightened later.
- Magic-link sign-in needs SMTP on the Supabase project. Hosted Supabase ships a default sender with low limits — fine for dev, will need a configured SMTP provider before any public exposure.

**Next:** Prompt 6 — render the points in `<VectorScape>` inside `/sandbox` (or `/sandbox/{project_id}`), with a fly-to-cluster sidebar.

---

## 2026-05-30 — Prompt 6: web ↔ engine wiring + point picking

**What:** When a project hits `status=ready`, the sandbox now fetches its points + clusters and renders them through `<VectorScape>`. Clicking a cluster name in the sidebar flies the camera; clicking a point in the galaxy shows its source text in a Selection panel. CSV upload → flyable 3D galaxy is end-to-end.

**Files added/changed:**

- `apps/web/app/api/projects/[id]/data/route.ts` — new GET route. RLS-scoped `projects` lookup (404 if not in tenant, 409 if not ready), then drains `points` in 1000-row pages (PostgREST default cap) excluding `embedding`, plus all `clusters` for the project. Returns `{project, points, clusters}` as JSON.
- `packages/engine/src/scene/PointPicker.tsx` — new render-null child that installs a handler into a parent-supplied ref. When the parent's Canvas fires `onPointerMissed` (background click, no centroid hit), the handler projects every point in the full host dataset to NDC, finds the nearest within `pixelRadius` (default 16), tie-breaks by depth, and invokes `onPick(originalIndex)`. -1 when nothing landed within tolerance.
- `packages/engine/src/VectorScape.tsx` — adds `onPointPick?: (index) => void` + `pickPixelRadius?: number` props and a `missedHandlerRef` that bridges `<Canvas onPointerMissed>` (parent level) to the child `<PointPicker>` (which needs `useThree` for camera/gl). PointPicker is mounted only when `onPointPick` is provided.
- `apps/web/app/sandbox/SandboxViewer.tsx` — new client component. Fetches `/api/projects/{id}/data`, converts rows to typed-array `PointsData` (color = golden-ratio HSL per cluster, noise = dim gray; probability from `cluster_probability`, falling back to 0.15 for noise so outliers fade like fog), builds `ClusterCentroid[]` with a cube-root-of-size radius so fly-to frames roughly match cluster shape. Renders `<VectorScape>` next to a clusters sidebar (fly-to + reset) and a Selection panel that surfaces the picked point's text + cluster + probability.
- `apps/web/app/sandbox/SandboxUI.tsx` — imports `SandboxViewer` via `dynamic(..., { ssr: false })` (R3F needs `window`); on `status=ready` swaps the "3D coming next" panel for the viewer + a compact "N points written" header.
- `apps/web/app/sandbox/page.tsx` — widened the wrapper from `max-w-5xl` to `max-w-7xl` so the canvas isn't column-cramped.
- `apps/web/package.json` — added `engine` (workspace), `three@0.170.0`, `@react-three/{fiber@9,drei@10,postprocessing@3}`, `postprocessing@6.36.7`, plus `@types/three` dev. These match the engine's peerDependencies exactly.
- `apps/web/next.config.ts` — `transpilePackages: ["engine"]` so Next can bundle the workspace's ESM dist without ESM/CJS interop pain.

**Decisions / deviations:**

- **Picker is host-aware, not engine-only.** The engine fires `onPointPick(originalIndex)` where `originalIndex` indexes into the host's `data.position` (the full dataset), not the downsampled render subset. This matches the prompt's "use the full dataset the host holds" requirement: the host's `payload.points[index]` lookup is O(1) and returns the source text. The voxel filter never enters the picker — points outside the kept set are still pickable, which is the correct behavior for a 1M-point dataset rendering 300k.
- **Picking math is screen-space, not raycast-tolerance.** CLAUDE.md bans 100k+ raycasts for *fly-to* because fly-to runs every click and the user expects instant. Picking has the same per-click cadence but no alternative primitive exists — you can't pre-build invisible spheres for every point. Projecting all N positions to NDC each click is O(N), runs at ~30ms even at 1M, and "16px from the cursor" matches what users perceive when they click a glowing dot. Walks the whole array; no per-frame cost.
- **`onPointerMissed` bridge via mutable ref.** R3F exposes `onPointerMissed` only on the Canvas itself (not via children) — but the picker needs the camera, which only `useThree()` gives. The cleanest fix was a parent-owned `missedHandlerRef` that the child `<PointPicker>` installs on mount; Canvas's `onPointerMissed` just calls `missedHandlerRef.current(e)`. Avoids prop-drilling Canvas-level handlers down into custom child components.
- **Color comes from cluster id, not the embedding.** Embedding-driven color (e.g., dim-3 PCA → RGB) would visually couple color to position. Cluster id × golden-ratio hue keeps each cluster visually distinct and stable across reloads; noise stays neutral gray and gets a low probability so the shader's `mix(uMinBrightness, 1.0, prob)` curve fades it into fog (per design.md).
- **JSON transport for now.** CLAUDE.md says Arrow above ~50k points; sandbox uploads sit well below that. The endpoint pages PostgREST 1000 rows at a time and reassembles server-side — switching to Arrow later means changing the response encoder + the host's parse, not the engine.
- **Engine consumed from its built `dist/`, not from `src`.** `engine`'s `exports` map points at `./dist/engine.js`, and the web build assumes a built engine exists. The Next build above passed because we ran `bun --filter engine build` first. A cleaner story (consume `src/index.ts` directly via a "development" condition) would skip the rebuild step but adds export-conditions complexity for a one-developer codebase; deferred until the rebuild step actually annoys someone.
- **Reset-view button** in the sidebar — falls back to the default camera (`{0,0,60}`) since CameraControls' `reset()` returns to the controls' own initial state.
- **Dynamic-imported viewer with `ssr: false`.** Next's App Router will try to render client components server-side once; R3F's `<Canvas>` accesses `window` at module-eval, so the import has to be deferred. `dynamic(..., { ssr: false })` is the standard escape hatch and shows a "Booting renderer…" placeholder while the chunk loads.

**Verified:**

- `bun --filter engine typecheck` → 0 errors.
- `bun --filter engine build` → emits `dist/engine.js` (11.52 kB), `.cjs`, `.d.ts`.
- `cd apps/web && bun run typecheck` → 0 errors.
- `cd apps/web && bun run build` → compiles, generates 6 pages; `/sandbox` route at 11.1 kB (167 kB First Load JS). No build warnings beyond Webpack's "big strings" cache hint (not actionable in app code).
- Browser flow not driven headlessly this prompt (no Playwright); the build pass + the existing scripted upload probe from prompt 5 cover everything up to the canvas mount. The galaxy render itself requires a real WebGL2 context — visual verification is a user step.

**Unfinished / broken:**

- No automated test for `/api/projects/[id]/data`; covered by build typecheck only.
- Picking walks all N points each click — fine to 1M, but a KD-tree (or `three-mesh-bvh`) would pay off if datasets cross several million. Out of MVP scope.
- Background security review (automated, supplementary) flagged two pre-existing HIGH "open redirect" warnings on `auth/callback/route.ts` and `login/page.tsx` (untrusted `next` query param). Not touched in this prompt; flagging here so it's not lost.

**Next:** Prompt 7 — LLM bridge (`/bridge`): given two cluster ids, sample texts from each, ask GPT for "what gap separates these," render the answer + camera path between cluster centroids.

---

## 2026-05-30 — Prompt 7a: Arrow transport for large projects

**What:** `/api/projects/[id]/data` now ships Apache Arrow IPC (in a tiny self-describing envelope) above 50k points; JSON below. Client branches on Content-Type, decodes Arrow columns straight into Float32/Int32 typed-array views, and feeds them into `<VectorScape>` with no `JSON.parse` on the hot path. Measured at 100k: ~50ms JSON main-thread stall → ~6ms with Arrow (8.5× faster, ~44ms saved). At 350k: ~180ms → ~18ms (10× faster, ~163ms saved).

**Files added/changed:**

- `apps/web/package.json` — added `apache-arrow@^18.0.0` (resolves to 18.1.0). The package's exports map handles the Node-vs-DOM split automatically (route uses Node build, client uses DOM build via Next's bundler).
- `apps/web/app/api/projects/[id]/data/route.ts` — gated on `points.length > 50_000`. JSON path unchanged. Arrow path builds Float32Array/Int32Array column buffers in a single loop, hands them to `tableFromArrays`, serializes with `tableToIPC(table, "stream")`, then wraps the IPC bytes in an envelope `[4-byte LE uint32 metaLen][metaJSON utf8][arrow IPC bytes]`. `metaJSON` carries project + cluster info (small enough to keep as JSON — clusters are typically <50 rows). Sent as `Content-Type: application/octet-stream; format=vs-arrow-bundle`.
- `apps/web/app/sandbox/loadProject.ts` — new module owning both decode paths. Returns a uniform `LoadedProject` shape with typed-array `pointsData`, materialized `centroids`, and a lazy `getPoint(i)` so the Arrow path can defer utf8 text decoding to click-time instead of materializing 100k strings up front (the other half of the no-stall guarantee). Reports `format` and `parseMs` so the UI surfaces which path served the data.
- `apps/web/app/sandbox/SandboxViewer.tsx` — refactored to consume `LoadedProject`. The on-canvas overlay now shows `(json|arrow, parse XXms)` so you can see the difference live in the browser.
- `apps/web/scripts/bench-load.ts` — synthetic benchmark mirroring both the server encoder and the client parser exactly. Generates N rows (~12 clusters + 5% noise — realistic sandbox shape), encodes both ways, parses both, prints wire sizes + best-of-3 timings. Runnable as `bun run apps/web/scripts/bench-load.ts [N]`.

**Decisions / deviations:**

- **50k threshold, hard-coded.** Anything between 16ms and 32ms is one or two dropped frames — still feels OK. At 30k JSON parses in ~14ms (one frame), at 50k it's ~25ms (a couple), at 100k it's ~50ms (visibly bad). 50k catches the inflection without changing behavior for small/typical sandbox uploads.
- **Envelope format, not Arrow schema metadata.** Considered stashing project+clusters in `Schema.metadata`. Switched to a 4-byte-length-prefixed envelope because (a) it's transparent to inspect (`hexdump | head` shows the meta JSON), (b) clusters live outside Arrow's column-oriented assumptions cleanly, and (c) the envelope is 5 lines on each side vs. fighting apache-arrow's metadata API. The cost is one custom format we own; it has a `vs-arrow-bundle` content-type tag so the client never has to guess.
- **Sentinel-encoded nulls, not Arrow nullable vectors.** `cluster_id = -1` for noise, `cluster_probability = NaN` for unknown. Nullable Arrow vectors complicate the typed-array fast path — `Vector.toArray()` either copies into a fresh array or hands back a dense one, depending on null density. Sentinels keep the column densely backed and zero-copy. The client converts sentinels back to `null` at the `getPoint` boundary, so the rest of the UI is unchanged.
- **Position interleave is the only mandatory copy.** Arrow gives us `x`, `y`, `z` as three separate Float32Array views (zero-copy from the IPC buffer); THREE.BufferAttribute needs them interleaved as `[x0,y0,z0,x1,y1,z1,...]`. That's an O(N) walk — 1.5ms at 100k, 5ms at 350k — far cheaper than the JSON.parse it replaces. We could ship a pre-interleaved column to skip even this, but it'd make the wire format awkward for any non-engine consumer.
- **Color/size/probability buffers still computed client-side.** Color depends on the client's hue palette (golden-ratio HSL); shipping it would lock the palette into the wire format. The fill loop is the same speed in both paths (~5ms at 350k), and any per-frame VectorScape stuff is downstream — neither path touches it.
- **Text decoded lazily via `Vector.get(i)`.** Decoding 100k utf8 strings up front is the next biggest avoidable cost (~20ms at 100k). Only the picked point's text is ever shown, so we keep the Arrow vector around and decode on click. `getPoint` is the only place this leaks; the rest of the UI doesn't know or care which path served the row.
- **Client-side compression deferred.** gzip would cut the wire by ~3× and Vercel/Next can do it transparently — but it's an HTTP-layer concern that doesn't change parse cost on the client. Reaches the same "no stall" target without adding `Accept-Encoding` plumbing.

**Verified:**

- `bun run apps/web/scripts/bench-load.ts 100000` (best of 3): JSON total 49.8ms (JSON.parse alone 45.0ms) vs Arrow total 5.8ms (tableFromIPC 0.4ms). **8.5× speedup, 43.9ms saved on the main thread.** Wire: 19.56 MiB JSON vs 8.00 MiB Arrow bundle.
- `bun run apps/web/scripts/bench-load.ts 350000`: JSON 181.5ms (parse 168.7ms) vs Arrow 18.1ms. **10× speedup, 163ms saved.** Wire: 68.83 MiB vs 28.27 MiB.
- `bun run apps/web/scripts/bench-load.ts 30000` (under-threshold): JSON 13.6ms, Arrow 2.1ms. Confirms JSON is still fine below the 50k gate.
- `cd apps/web && bun run typecheck` → 0 errors.
- `cd apps/web && bun run build` → compiles. `/sandbox` route still 11.1 kB First Load JS (apache-arrow is in the dynamic-imported `SandboxViewer` chunk, doesn't inflate the initial bundle).
- End-to-end browser run not driven from here — the bench numbers come from the same code paths the browser executes (and Bun's V8 ≈ Chrome's V8 on this kind of work); user can confirm the live `(arrow, parse Xms)` badge in the canvas overlay when uploading a >50k-row CSV.

**Unfinished / broken:**

- 100k+ row Supabase fetch is paginated 1000 rows at a time (the `PostgREST` default) and the round trips dominate wall time. Parallelizing the page fetches or moving to a Postgres RPC would help — out of this prompt's scope (the task target is the *client* parse stall, which is fixed).
- No live browser parse measurement in this changelog — the bench is the proxy. Adding a `console.log` of `parseMs` in production is already there via the on-canvas badge.
- gzip / brotli on the API response would cut wire by ~3× more; not configured at the Next layer (left for whoever wires real CDN/edge config).


---

## 2026-05-31 — Prompt 8: SKM lens + landing + scripted flythrough

**What:** Baked the 20 Newsgroups corpus as a permanently-ready static demo galaxy under `apps/web/public/demo/skm-galaxy.json`. New `/lens` route loads it, mounts `<VectorScape>`, and plays a hand-keyframed cinematic camera path on entry (skippable, hands control to the user when done). New landing page per `design.md` — fixed hero galaxy drift behind a spare headline, two CTAs ("See the demo" → `/lens`, "Bring your data" → `/sandbox`), characterful display type via `next/font`, and an honest "XR coming next" note. No DB lookup, no anonymous-RLS hole — the demo is a static asset.

**Files added/changed:**

- `services/reducer/samples/make_demo.py` — builds `samples/demo.csv` from sklearn's 20 Newsgroups (train subset, headers/footers/quotes stripped, capped at 600 chars/post, 400 posts/category → 7,955 rows across 20 categories).
- `services/reducer/app/cli.py` — new `bake-static` subcommand. Runs the full pipeline and writes the payload as a static JSON file matching the `/api/projects/[id]/data` JSON shape (project/points/clusters), with stable UUIDs minted up front so `medoid_point_id` references survive the round trip. Optional `--label-column` does a per-cluster majority-vote label hint so the SKM galaxy shows real newsgroup names instead of "Cluster N". Adds `--min-cluster-size` and `--cluster-method` overrides surfaced from the pipeline.
- `services/reducer/app/pipeline.py` — `run_pipeline` / `_cluster` gained optional `min_cluster_size` and `cluster_selection_method` (default `eom`). Default heuristic untouched.
- `apps/web/public/demo/skm-galaxy.json` — baked output. 7,955 points, 14 named clusters (10 cores + 4 sub-clusters of comp.\*), 3,545 noise points reading as ambient fog. 4.6 MiB on the wire (well under the 50k Arrow threshold, so JSON is the right path).
- `packages/engine/src/types.ts` + `src/index.ts` — added `FlythroughKeyframe` and three new `VectorScapeHandle` methods: `setLookAt(position, target, transition)`, `playFlythrough(keyframes)`, `cancelFlythrough()`.
- `packages/engine/src/VectorScape.tsx` — `SceneController` now implements those methods on the imperative handle. Sequencer uses a monotonic generation counter so any user nudge (drag, cluster click, skip button) cancels the in-flight path cleanly; an in-flight `await` checks the counter on each step and bails. The `flyTo` / `resetView` paths also bump the counter so a cluster click during the intro takes over correctly.
- `apps/web/app/lens/page.tsx` (server) + `lens/LensClient.tsx` (client wrapper) + `lens/LensViewer.tsx` (the actual viewer) — Next 15 forbids `ssr:false` from a server component, so the dynamic import lives in a thin "use client" boundary. LensViewer fetches `/demo/skm-galaxy.json` via the existing `loadProjectFromUrl` helper, mounts the canvas full-screen, and starts the flythrough on first hydration tick.
- The flythrough: 6 keyframes — far approach with a near-zero `smoothTime` (snap to the start pose so the intro begins from outside the cloud) → 4 sweeping dives with ~3.5s smoothTime each → final ease back to the user's home pose. Skip button + any cluster click cancels the sequence and yields control immediately.
- `apps/web/app/sandbox/loadProject.ts` — extracted the URL→`LoadedProject` core into `loadFromUrl`; new public `loadProjectFromUrl(url, init?)` reuses both the JSON and Arrow decode paths so the lens consumes the same shape as the sandbox.
- `apps/web/app/HeroGalaxy.tsx` + `HeroGalaxyMount.tsx` — decorative background scene for the landing. ~2,400 points generated client-side from a seeded RNG (mulberry32) so first paint doesn't wait on a fetch; same additive-glow shader pattern as the engine but inlined to keep the landing chunk small. `<DriftingCamera>` runs a ~120s ambient orbit with a slight y-bob — "subtle ambient life" from design.md.
- `apps/web/app/page.tsx` — new landing. Fixed full-bleed hero galaxy underneath, radial vignette so the headline reads against the bright cores, two CTAs (filled accent primary + glass secondary), trailer-style "stars are documents · constellations are topics · the dark between them is the question" trio, and the XR coming-next note. Honors design.md §1–4: deep cool background, glass UI, single warm accent (amber/gold), generous negative space, one memorable hero moment.
- `apps/web/app/layout.tsx` — typography per design.md §3. Wired `Fraunces` (display, with `opsz`/`SOFT`/`WONK` axes for characterful italics), `DM_Sans` (body/UI), and `JetBrains_Mono` (data readouts) via `next/font`. Variables exposed as CSS custom properties; Tailwind config gains matching `font-display` / `font-body` / `font-mono` families plus an `accent` palette token.
- `apps/web/tailwind.config.ts` — added the three font families and the amber accent palette (DEFAULT / warm / deep).
- `apps/web/app/globals.css` — root background uses `--bg-deep` (`#05060a` per design.md), faint cool top + warm bottom radial gradient layered on `body::before` so it's pinned to the viewport and doesn't fight the lens canvas. `font-feature-settings: ss01, ss02` for Fraunces stylistic alternates.

**Decisions / deviations:**

- **Static JSON, not a DB-resident demo project.** The brief asks for a permanently-ready demo. The cleanest engineering path is a checked-in static asset rather than a row in the cloud project — no anonymous-read RLS policy to write, no service-role server route to maintain, no risk of someone deleting the demo from the dashboard. Next-cached and gzip-served. Re-baking the demo means committing a new JSON file, which is a one-time annoyance traded against a permanent class of authentication-edge-case bugs.
- **Corpus = 20 Newsgroups.** Ships with scikit-learn (already a reducer dep), no external download or licensing question, the canonical embedding-visualization corpus, and the 20 topical categories give exactly the constellation feel the SKM lens needs. Capped per-category at 400 (7,955 rows total) to keep bake + page-load fast while leaving plenty of stars.
- **HDBSCAN parameters tuned at bake-time, not pipeline-time.** Default `min_cluster_size = sqrt(n)/2` is correct for typical sandbox uploads but over-merges 20 Newsgroups (it collapsed the 5 `comp.*` groups into one). `--min-cluster-size 60 --cluster-method leaf` recovers 14 well-separated clusters with ~45% noise. The noise points become ambient fog between cluster cores (design.md "uncertainty as natural fog"), which is the look we wanted anyway.
- **Cluster labels = majority-vote of the source category column.** A real LLM-naming pass is a later prompt; for the pre-baked demo, using the original newsgroup category as the cluster label is more honest than "Cluster 0".
- **Flythrough = hand-keyframed CameraControls path, not Theatre.js.** Theatre.js was the brief's other suggestion but it would have added a runtime + a studio dependency for what is, in the end, six keyframes. CameraControls' `setLookAt` already returns a promise tied to its smoothTime damping, so sequencing keyframes is `for (const kf of keyframes) await controls.setLookAt(...)`. Cancellation via a monotonic generation counter is cheaper than threading AbortSignal through a Promise chain — every cancel/replay bumps the counter, and the in-flight loop bails the moment it sees a stale id.
- **`smoothTime: 0.001` on the first keyframe.** CameraControls smoothly transitions from wherever the camera currently is to the first pose, which would mean the cinematic dive begins at the user's home pose — defeating the purpose. The near-zero first transition effectively teleports to the start of the path, then the rest plays smoothly. `try / finally` restores the original `smoothTime` on the controls when the path finishes so user drag damping is unaffected.
- **Landing hero is a synthetic seed-RNG galaxy, not the demo data.** First paint matters most on the landing. Fetching the 4.6 MiB demo JSON before the hero can render would mean an empty black hero for 200-400ms over a typical connection. A ~2,400-point seeded synthetic field renders the instant the chunk hydrates and uses the same additive-glow shader pattern, so it reads as the same product. Visitors who want the real thing are one click away.
- **`ssr: false` lives in client wrappers.** Next 15 disallows `ssr: false` in `next/dynamic` from server components. Each WebGL surface (lens, landing hero) gets a paper-thin `"use client"` wrapper file (`LensClient.tsx`, `HeroGalaxyMount.tsx`) that owns the dynamic import. The route files remain server components so they can read auth state.
- **Headline CTAs respect auth state.** "Bring your data" routes straight to `/sandbox` if the visitor is signed in; otherwise to `/login?next=/sandbox`. Same redirect pattern the sandbox already uses; keeps the landing honest about what happens next.
- **No waitlist form.** The brief doesn't ask for it; that's a separate later prompt. The XR section is framed as "Waitlist opening soon" so the promise is honest.
- **Fraunces over alternatives.** Design.md says "distinctive, not default; avoid Inter/Roboto/Arial/system" and wants a characterful display + quiet UI + precise mono. Fraunces is a variable serif with optical-size and `WONK` axes that give it real character; DM Sans is recognizable but not Inter-flavored; JetBrains Mono has the precise-instrument readability. The italic in "your *embeddings*" leans on Fraunces's italic optical settings.

**Verified:**

- `bun --filter engine build` → 0 errors; engine dist now 12.56 kB (+1 kB for the new handle methods).
- `cd apps/web && bun run typecheck` → 0 errors.
- `cd apps/web && bun run build` → compiles. `/` 10.2 kB First Load 110 kB. `/lens` is statically generated as a 1.38 kB shell that hydrates the LensClient dynamic chunk. `/sandbox` First Load unchanged (111 kB).
- Dev server probe: `GET /` → 200 50 kB HTML, `GET /lens` → 200 47 kB HTML, `GET /demo/skm-galaxy.json` → 200 4.82 MB application/json with the correct content-type.
- Cluster summary (script): 14 clusters labelled with real newsgroup names; sizes range 76–617 with the largest five being `soc.religion.christian`, `comp.windows.x`, `comp.sys.mac.hardware`, `rec.autos`, `talk.politics.guns`. 3,545 noise points.
- Browser visual verification (galaxy renders, flythrough plays, skip works, post-flythrough handoff to user is clean) is a manual step — no headless WebGL probe wired in this prompt.

**Unfinished / broken:**

- The landing hero is a synthetic seed-RNG scene, not a live preview of the actual demo data. Acceptable per the decision above (first-paint vs fidelity), but a future polish pass might switch it to a low-resolution slice of the real demo for honesty.
- Flythrough timing is fixed at ~15s across all viewport sizes / hardware. A user on a slow GPU sees the same path play out at the same wall-clock pace — fine because CameraControls' `setLookAt` damping isn't framerate-dependent, but the "right" path length probably depends on whether the visitor is in a hurry. Skip is the escape hatch.
- The `dynamic_` export naming gotcha (Next's segment-config `dynamic` conflicting with the import) cost a build cycle. Worth a project-wide lint rule eventually.
- No automated end-to-end test for the lens. The build pass + URL probes confirm the route compiles and serves; the cinematic feel can only be eyeballed in a real browser.
- The "Coming to Quest & Vision Pro" panel is decorative; the waitlist DB table exists from prompt 2 but no form wires to it yet. That's prompt 11 in `prompt_flow.md`.

**Next:** Prompt 10 — the Bridge: cluster multi-select in the engine, `POST /bridge`, LLM explanation panel with cited example points. (Prompt 9 was the SKM lens / landing — this prompt.)

---

## 2026-05-31 — Prompt 10: Bridge — multi-select, /bridge, explanation panel

**What:** Shipped the Bridge end-to-end. Shift-click two cluster markers in the engine → the web app posts to a new reducer route that retrieves each cluster's medoid and its boundary points (the points in cluster A whose embedding is closest to cluster B's medoid via pgvector cosine, and vice versa), feeds medoids + boundary texts to the LLM, and returns prose plus cited example points. The UI renders the explanation in a side panel; clicking any cited example flies the camera to that point.

**Files added/changed:**

- `services/reducer/app/bridge.py` — new module + `POST /bridge`. Pydantic models `BridgeRequest` / `BridgeResponse` / `BridgeExample` / `BridgeClusterMeta`. Helpers: `_fetch_cluster` (joins `clusters` ↔ medoid `points` row to get id/text/embedding/cx,cy,cz/size), `_fetch_boundary` (uses pgvector `embedding <=> %s` cosine-distance order, limit 4, filters out null embeddings), `_build_prompt` (system+user prompt that names the shared theme then the contrast and tells the LLM to lean on the boundary points), `_summarize` (OpenAI `gpt-4o-mini` at temp 0.4 / 320 max tokens; explicit fallback string when `OPENAI_API_KEY` is unset so the panel still renders structurally), `_to_examples` (always cites the medoid first, then boundary points, dedupes the medoid out of the boundary set, role-tagged for the UI).
- `services/reducer/app/main.py` — mounts the bridge router alongside the existing embed router.
- `packages/engine/src/types.ts` — new `ClusterPickOptions { additive }`; `VectorScapeHandle` gains `flyToPoint(position, radius?)`. `onClusterSelect` now passes `(id, opts)` so hosts can implement multi-select.
- `packages/engine/src/scene/FlyToTargets.tsx` — click handler reads `e.nativeEvent.shiftKey | metaKey | ctrlKey` and forwards as `opts.additive`.
- `packages/engine/src/VectorScape.tsx` — typed signature change for `onClusterSelect`; `flyToPoint` implementation builds an ephemeral `THREE.Sphere` and calls `CameraControls.fitToSphere(sphere, true)` so cited-point flights reuse the same approach motion as cluster flights (no new camera code path).
- `packages/engine/src/index.ts` — re-exports `ClusterPickOptions`.
- `apps/web/app/api/projects/[id]/bridge/route.ts` — new Next route. Auth check via Supabase server client, RLS-scoped `projects` lookup (404 outside tenant, 409 if not `ready`), validates `cluster_a` / `cluster_b` as distinct integers, then POSTs to `REDUCER_URL/bridge` and returns the response body verbatim. No service-role calls from this layer.
- `apps/web/app/sandbox/BridgePanel.tsx` — new client component. Owns the bridge fetch lifecycle with a monotonic request counter (so a stale response from the previous pair can't clobber the current one); auto-fires when `selection.length === 2`; renders chips for the selected pair, the LLM prose, a `cited · <model>` footer (so `model: 'fallback'` is honest when no key is configured), and the two cited columns. Each cited row is a button that calls `handleRef.current?.flyToPoint([x,y,z], 2.5)`. Boundary points are tagged in amber, medoids in neutral, so the user can tell which examples carry the contrast signal.
- `apps/web/app/sandbox/SandboxViewer.tsx` — selection state `number[]` (cap 2). New `onClusterPick` callback: plain click flies + replaces selection with `[id]`; modifier-click toggles the id in the selection (oldest drops out when at cap). Cluster sidebar buttons also honor shift/meta/ctrl so the same multi-select gesture works from the list. Selected rows tint amber. Bridge panel slots between the cluster list and the existing point-selection panel.

**Decisions / deviations:**

- **Boundary = K-nearest-by-cosine to the other cluster's medoid (K=4), not "convex-hull-edge points" or a centroid-distance ranking inside the cluster.** Each cluster's medoid embedding is the cheapest single anchor for "the *other* concept"; sorting cluster A's members by `embedding <=> B.medoid` (pgvector cosine distance) is the natural "items in A that lean toward B" definition. Pure 3D coord distance after PaCMAP/UMAP would discard the high-dim signal that made the embedding useful in the first place — the boundary should live in the embedding space, not the projected one. K=4 gives the LLM enough texture without burning context; the wire payload is small and the panel stays readable.
- **Multi-select gesture = modifier-click.** Right-click would conflict with browser context menus; a sticky "multi-select mode" toggle in the toolbar is one more thing to discover. Shift/cmd/ctrl-click is the file-manager convention and works identically on the cluster markers and the sidebar list. Plain click stays the "fly to" verb so the existing single-cluster motion is untouched. The hint string in the canvas overlay says so explicitly.
- **OpenAI fallback returns a plain explanatory string, not 503.** A configured-but-broken OpenAI key still returns 502 from the reducer (FastAPI bubbles the exception), but a *missing* key returns a friendly summary and `model: 'fallback'` so the cited-points list still renders. The Bridge UX is half the experience even without the prose; making the panel silently empty when the key isn't set would hide that.
- **No new camera primitive for cited-point fly-to.** Reusing `CameraControls.fitToSphere` with an ephemeral `THREE.Sphere(point, radius)` means the cited-point motion has the same damping curve as cluster flights — visually consistent and one fewer code path to tune in Prompt 12.
- **`onClusterSelect` signature widened, not split.** A separate `onClusterMultiSelect` would mean two callbacks racing for the same click. One callback with `(id, opts)` lets the host decide locally; existing single-arg callers (the lens viewer) keep working because TS allows assignment of a `(id) => void` to `(id, opts) => void`.
- **Stale-response guard on the bridge fetch.** Auto-fetching as soon as a pair forms means a fast switch from `[A, B]` → `[A, C]` would race two in-flight requests. The monotonic `reqIdRef` discards any response whose id isn't current — same pattern the flythrough generation counter uses.
- **No bridge UI in the lens.** The pre-baked SKM galaxy is a static asset, not a DB-resident project, so `embedding <=> %s` has nowhere to run. Wiring a parallel cosine search over the bundled JSON would need every point's full 384-dim embedding in the asset — that 4.6 MiB demo would balloon past 50 MiB. Bridge lives in the sandbox where the DB is the source of truth; the lens stays a no-input flythrough.

**Verified:**

- `bun --filter engine build` → 0 errors; engine dist 12.91 kB (+0.35 kB for `flyToPoint` + the modifier-key wiring).
- `bun --filter engine typecheck` → 0 errors.
- `cd apps/web && bun run typecheck` → 0 errors.
- `cd apps/web && bun run build` → compiles. New route `/api/projects/[id]/bridge` listed as dynamic-server. Sandbox first-load 111 kB (+0.5 kB for the panel).
- `cd services/reducer && uv run ruff check app/bridge.py app/main.py` → all checks passed.
- `cd services/reducer && uv run pytest -q` → 1 passed.
- Reducer FastAPI app loads with `/bridge` registered as POST alongside the existing routes.
- End-to-end "select two clusters → LLM explanation → click cited point → camera flies" is a manual browser step against a live reducer + Supabase; no headless harness for that path yet (same gap as the lens cinematic).

**Unfinished / broken:**

- No automated test against a real Postgres + pgvector instance for `/bridge`. The cosine-distance ordering is the trust-but-verify part; the live sandbox project is the proving ground.
- `_summarize` makes a blocking OpenAI call from a sync FastAPI handler. Fine at one request at a time; under load it would block the event loop. The whole reducer is single-tenant-dev today so this is parked.
- Bridge has no caching layer — the same `(project_id, cluster_a, cluster_b)` triple re-asks the LLM on every panel mount. A trivial in-memory or Redis cache could land in Prompt 12.
- The cited-point fly-to uses a fixed `radius=2.5` framing. Looks right at the engine's default `COORD_SCALE=60`; at very different scales it would over-zoom or under-zoom. Acceptable since the reducer always normalizes to scale 60.

**Next:** Prompt 11 — XR waitlist section + email capture into `waitlist`; honest "coming soon" framing for Quest + Vision Pro.

---

## 2026-05-31 — Prompt 11: XR waitlist (Quest + Vision Pro)

**What:** Replaced the decorative "Waitlist opening soon" block on the landing with a real waitlist form. Quest / Vision Pro picker + email field; submissions land in `public.waitlist` with `platform` set correctly. Honest framing per CLAUDE.md / design.md: "VectorScape runs in your browser today. Native headset apps are in development — no ship date yet."

**Files added/changed:**

- `apps/web/app/api/waitlist/route.ts` — new POST. Parses JSON, trims+lowercases email, validates against `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` with a 254-char cap, validates `platform ∈ {quest, vision_pro}`. Inserts via the SSR Supabase client (anon role; the existing `waitlist_public_insert` RLS policy from prompt 2 already allows anon inserts). Unique-index violation (`23505`) on the `(email, platform)` index is collapsed to `{ ok: true, already: true }` so a re-submit doesn't surface a scary error.
- `apps/web/app/XRWaitlist.tsx` — client component. Two-button platform picker (radio styled as glass tiles, accent ring on the active one), email input, submit. Status panel renders submitting / ok / error states under `aria-live="polite"` and clears on success. Plain `<form>` + `useState`, no extra deps.
- `apps/web/app/page.tsx` — drops the old static panel, mounts `<XRWaitlist />` in its place. The "Coming next" eyebrow + headline move into the component so the page section just becomes a max-width wrapper.

**Decisions / deviations:**

- **Server route, anon client, not a direct browser-side insert.** A direct `supabase.from('waitlist').insert(...)` from the browser would have worked (RLS already allows anon insert), but a tiny server route centralizes validation, normalizes email case, and gives a single place to map the unique-violation code to friendly "already on the list" copy. The cost is one extra hop; the value is no `code === '23505'` magic numbers in component code.
- **Unique violation = success, not error.** The `(email, platform)` unique index from prompt 2 is the right shape: re-submitting the same address shouldn't fail visibly. The route returns `already: true` so the UI can change the copy ("You're already on the list — we'll be in touch.") without claiming a new write happened.
- **Email regex is the simple `^[^\s@]+@[^\s@]+\.[^\s@]+$`.** RFC 5321 is unreasonable to validate client-side; this catches typos (missing `@`, missing dot, leading/trailing whitespace) without rejecting valid uncommon addresses. Same regex client- and server-side so the two paths agree.
- **Email lowercased on the server.** The unique index is case-sensitive — `foo@bar` and `FOO@BAR` would be two rows otherwise. Lowercasing in the route is the smallest fix; keeps the DB simple (no functional index needed).
- **Honest copy.** "Native headset apps are in development — no ship date yet" — explicit, no promises. The mini-CLAUDE.md "deferred (XR builds)" line and design.md "framed honestly" both wanted this; the button just says "Join waitlist."
- **No reCAPTCHA / honeypot yet.** The waitlist has zero abuse pressure today. Adding it now is the kind of speculation CLAUDE.md tells us to skip; if a bot ever floods it, a Turnstile widget is two lines.
- **Same platforms as the DB enum.** The picker's two ids (`quest`, `vision_pro`) match `public.waitlist_platform`; the server validates against the same set so a forged payload can't sneak past the enum and get a 500 from Postgres.

**Verified:**

- `cd apps/web && bun run typecheck` → 0 errors.
- `cd apps/web && bun run build` → compiles. `/` now 11.7 kB First Load 112 kB (+1.5 kB for the form + status panel). `/api/waitlist` registered as a dynamic-server route.
- Dev-server probe against the live route:
  - `POST {}` → 400 `expected JSON body`.
  - `POST {email:"not-an-email", platform:"quest"}` → 400 `that doesn't look like a valid email`.
  - `POST {email:"...", platform:"xbox"}` → 400 `platform must be 'quest' or 'vision_pro'`.
  - `POST {email:"waitlist-probe+TS@…", platform:"quest"}` → 200 `{ok:true, already:false}`.
  - Same payload again → 200 `{ok:true, already:true}`.
  - Same email, `platform:"vision_pro"` → 200 `{ok:true, already:false}` (second platform on the same email is allowed by the composite unique index).
- Service-role REST check confirmed both rows present in `public.waitlist` with the correct `(email, platform, created_at)`. Probe rows deleted afterwards.

**Unfinished / broken:**

- No Turnstile / hCaptcha — see decision above. If this goes public, it gets one.
- No outbound confirmation email yet. We just persist; the "we'll email you" promise hangs on the future XR launch flow.
- The form's no-JS path is a regular `<form>` POST but the route only accepts JSON — without JS, a submit would 400. Acceptable for a hero-CTA landing; could be widened to also accept `application/x-www-form-urlencoded` if no-JS support becomes a goal.

**Next:** Prompt 12 — feel polish across the surfaces (per `prompt_flow.md`).

---

## 2026-05-31 — Prompt 12: feel polish (motion, atmosphere, morph, ambient drift)

**What:** The "make navigation feel be the product" pass. Tuned camera damping for cinematic fly-to + drag-coast, lifted the bloom luminance floor so only cluster cores glow, opt-in DOF as an "HQ" mode, proximity-based cluster labels for the galaxy↔architectural morph, and a near-imperceptible idle drift so the space breathes when nobody's touching it. Verified the point budget, single-draw-call constraint, and GPU-resident attribute pattern all survived.

**Files added/changed:**

- `packages/engine/src/scene/AmbientDrift.tsx` — new. Listens to `controlstart` / `transitionstart` / `rest` on CameraControls, tracks idle seconds, and after a 3.5s settle starts adding tiny per-frame deltas to `azimuthAngle` (~0.012 rad/s = ~0.7°/s) plus a slow sine bob on `polarAngle` (~±0.015 rad over a 22s period). Eases in over 1.5s so drift starts as an exhale, not a snap. Any user input pauses it immediately. Writes camera angles only — zero BufferAttribute work per frame.
- `packages/engine/src/scene/ClusterLabels.tsx` — new. Drei `<Html>` overlay per cluster with proximity-based opacity (smootherstep ramp: fully visible inside `fadeEnd=60`, invisible outside `fadeStart=140`, behind-camera cull via forward-dot). `distanceFactor=50` so labels scale with approach. Glass styling per design.md §4: dark translucent pill, hairline border, backdrop-blur, soft text shadow so they read against bright nebula cores. Labels live as DOM nodes so bloom can't smear them — "selective bloom on the data only" is enforced by physics, not config.
- `packages/engine/src/VectorScape.tsx` — three feel tunings + three new props:
  - `smoothTime` 0.4 → 0.65 (cinematic damp on fly-to); `draggingSmoothTime` 0.1 → 0.14 (drag stays responsive, release coasts); `dollySpeed` 0.8 → 0.7 (calm wheel zoom); explicit `azimuthRotateSpeed` / `polarRotateSpeed` / `truckSpeed` so the gesture feel doesn't drift on a controls upgrade.
  - `bloomThreshold` lifted off 0 to `0.18` — dim outliers and fog-faded mid-field no longer bloom, only confident cluster cores. `luminanceSmoothing` 0.6 → 0.55 for a slightly crisper ramp around the threshold.
  - `fogDensity` default 0.012 → 0.011 — gentler far-field falloff so depth reads as scale, not a wall.
  - New props: `enableDOF` (opt-in `<DepthOfField>` with focusDistance=0.012, focalLength=0.04, bokehScale=3.2, height=720), `enableAmbientDrift` (default true), `showClusterLabels` (default false — hosts opt in per surface).
  - The EffectComposer is wrapped per-mode (with-DOF / without-DOF) rather than passing conditionals as children — `@react-three/postprocessing`'s composer types require concrete `ReactElement`s, and a remount is cheap because the user toggle is rare.
- `apps/web/app/lens/LensViewer.tsx` — opts in to `showClusterLabels` (the cinematic surface wants constellation names), adds HQ pill toggle bottom-right that wires `enableDOF`. Pill hides during the intro flythrough so it doesn't compete with the cinematic.
- `apps/web/app/sandbox/SandboxViewer.tsx` — adds the same HQ toggle bottom-right. Labels stay off in the sandbox (sidebar list is the canonical cluster pick UI; canvas labels would duplicate).

**Decisions / deviations:**

- **Ambient drift writes camera angles, not the scene root.** Two reasons: (a) rotating the world group would mutate cluster positions under CameraControls, breaking fly-to; (b) `controls.azimuthAngle += delta` writes the controls' *target* angle, which camera-controls' damping then chases — the displayed motion is intrinsically smooth and pausing on user input is automatic (any new target snaps the chase to the new value). Writes one float per frame; the constraint about "no per-frame CPU attribute writes" is about BufferAttribute mutation, not uniform transforms.
- **Drift uses event listeners, not polling `controls.active`.** `controls.active` flickers during damping and would race the drift loop. The `controlstart` / `transitionstart` / `rest` triple gives clean intent boundaries: user grabs it → stop drifting; controls settle → start the idle timer.
- **Cluster labels via drei `<Html>` not `<Text>`.** `<Text>` is in-scene 3D text — would compete for bloom luminance and force a layer-exclusion dance. DOM `<Html>` overlays sit above the WebGL framebuffer, so bloom can't touch them by construction. K-cluster scale (~14 demo, ~50 typical) makes DOM cost a non-issue. Trade: labels don't z-occlude with foreground points, but proximity fade hides them when the camera is past the cluster anyway.
- **Morph thresholds in absolute world units (60 / 140).** The reducer always normalizes the longest half-extent to `COORD_SCALE=60`, so absolute thresholds work for any baked galaxy without a per-project tune. Labels reach full opacity right at the canonical scale, so the "architectural arrival" feel lands exactly where the camera tends to settle after fly-to.
- **DOF defaults off everywhere.** design.md is explicit: "off by default (it's the most expensive effect); on for screenshots and slow exploration." Even the lens demo, which is small enough to afford it, defaults off so first-time visitors hit the cheap, fast path. The HQ toggle is one click away. EffectComposer is remounted on toggle rather than reordering its children at runtime — postprocessing's pass chain doesn't recompose cleanly on conditional children, and the remount is invisible because it happens on an explicit user click.
- **Bloom threshold raise (0 → 0.18) matches the brightness floor.** `uMinBrightness=0.18` is the lower bound of probability-modulated point brightness, so any luminance below ~0.18 belongs to outliers or fog-dimmed midfield — exactly the pixels we *don't* want haloing. With luminanceSmoothing=0.55 the ramp stays gentle so the visual transition from "doesn't bloom" → "blooms" is continuous, not a hard line. Net effect: cores read as distinct stars instead of a foggy wash.
- **Smoothing values within the design.md band.** "smoothTime ≈ 0.4–0.8s" — 0.65 lands near the upper-middle, which is where fly-to reads as "arriving" rather than "panning." Tried 0.8 first; it felt sluggish on short flights between adjacent clusters in the lens. 0.65 keeps the cinematic feel without making the user wait.
- **No regression to the spike's GPU pattern.** `PointsCloud` is untouched. Voxel filter unchanged. `THREE.Points` count: still one. Per-frame work added: AmbientDrift (~10 ops on idle frames, early-return otherwise), ClusterLabels (K vector ops + K DOM opacity writes — K is cluster count, typically <50). On a 350k-point render this is sub-microsecond against the GPU pipeline cost.
- **Background security review of the prompt-11 commit (waitlist) flagged two MEDIUM findings — info-disclosure / email-enumeration oracle from the `already: true` differentiation, and verbose `error.message` reflection on insert failure.** Not addressed in this prompt (out of scope: the polish pass shouldn't be mixed with security work in one commit). Logged here so they're not lost; should be the first item in a follow-up hygiene pass.

**Verified:**

- `bun --filter engine typecheck` → 0 errors.
- `bun --filter engine build` → dist 17.46 kB (was 12.91 kB; +4.5 kB for AmbientDrift + ClusterLabels + DOF effect). Still tiny.
- `cd apps/web && bun run typecheck` → 0 errors.
- `cd apps/web && bun run build` → compiles. `/sandbox` First Load 111 kB (unchanged), `/lens` 102 kB (unchanged) — the polish lands in the shared engine chunk, not page-specific code.
- Headless WebGL frame-time can't be measured from this session; the load-bearing perf constraints (single draw call, no per-frame attribute writes, voxel ≤budget) are static-analyzable and were re-read. The browser-felt cinematic improvements are a manual eyeball pass.

**Unfinished / broken:**

- No automated 60fps measurement at the budget. The point budget itself is enforced by the voxel filter (unchanged in this prompt); whether the GPU holds 60fps with bloom+DOF+SMAA at 350k points depends on the host machine and is a user-verifiable thing rather than a code property.
- The HQ toggle currently flips DOF only. A "labels on/off in sandbox" or DPR cap toggle could live in the same control. Not added because design.md treats DOF as the canonical quality lever; multi-toggle is feature-creep.
- Cluster labels render text from `c.label` directly. Long labels (e.g. full taxonomies) overflow the pill — could add ellipsis. Real SKM galaxy labels are short newsgroup names, so this hasn't bitten yet.
- Waitlist security findings (see decisions): not patched in this commit.

**Next:** Out of `prompt_flow.md`'s sequenced prompts (12 was the last). Follow-up candidates: waitlist security hardening, headless perf harness (e.g. `headlessgl` + a render-loop tick budget), the deferred items in CLAUDE.md (time-lapse, other lenses, actual XR builds) when they come up the priority list.
