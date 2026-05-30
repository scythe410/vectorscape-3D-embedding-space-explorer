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
