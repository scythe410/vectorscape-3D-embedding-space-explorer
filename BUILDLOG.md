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
