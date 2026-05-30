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
