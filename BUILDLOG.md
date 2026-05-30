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
