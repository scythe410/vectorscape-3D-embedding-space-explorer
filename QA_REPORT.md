# QA_REPORT — VectorScape

Cross-workspace QA pass. Phase 1 audit + targets first, then findings as later phases land. Append-only within a phase; supersede a finding by editing in place and noting the date.

Audit run: 2026-06-04. Branch: `main`. Repo HEAD: matches BUILDLOG through 2026-06-03 "feat(adjacency): faint links between semantically-near clusters".

---

## Phase 1 — Audit & baseline

### Test inventory (per workspace)

**services/reducer** — pytest under `uv`. 35 tests across 6 files:

| File | Tests | Covers |
|---|---|---|
| `test_health.py` | 1 | `/health` open route |
| `test_auth.py` | 6 | `verify_reducer_secret` dep: unset/missing/wrong/correct for `/embed-reduce`, `/bridge`, `/status`; `/health` stays open |
| `test_prompt_injection.py` | 5 | Bridge prompt fences every user span, safety instruction present, closing-tag defang, control-char strip, cluster label fencing |
| `test_search.py` | 11 | embed-model selection from project row, tenant-scoped SQL, empty result, empty query rejected, auth gate, region aggregation (real labels), placeholder degradation, blank/null labels, noise-only matches |
| `test_labeling.py` | 7 | c-TF-IDF down-weights globally common terms, free-path under 24 chars, LLM word+length caps, `Label:` prefix strip, injection-fenced LLM input, fallback on RuntimeError, empty LLM response → `None` |
| `test_adjacency.py` | 5 | embedding-space pairs (not 3D coords), top-N cap, canonical `(a<b)`, noise excluded, edge cases (empty/all-noise/single cluster) |

**packages/engine** — **no formal tests.** One `scripts/smoke.ts` exercises voxel + synth from Bun CLI at three sizes (10k / 350k / 1M). Useful as a manual perf probe; not part of CI and not a test framework.

**apps/web** — `bun test`. 38 tests across 2 files:

| File | Tests | Covers |
|---|---|---|
| `lib/titleCard.test.ts` | 13 | top-N selection (order, ties, noise/empty exclusion, n=0/-3, non-mutation); show-once contract (first/marked-seen/scope independence/null+throwing store) |
| `lib/proximity.test.ts` | 25 | inverse-distance weighting (50/50, bias, sort, sum-to-100, monotonic fade, fade knobs, top-N, trailing drop, leader-kept, empty, single, immutability); largest-remainder rounding (sum, order, empty); leading-edge throttle (immediate, suppress-within-window, edge fire, reset, backward clock, zero interval, 60Hz→120ms cadence) |

**supabase** — `rls_cross_tenant.sql`. One transaction-rollback test proving tenant B sees zero rows of tenant A's project on SELECT/UPDATE/DELETE and that forging an INSERT raises `check_violation`/`insufficient_privilege`. Run via Management API.

### Baseline coverage

Run via `uv run coverage run -m pytest && uv run coverage report --include='app/*'`.

```
Name                Stmts   Miss  Cover
---------------------------------------
app/adjacency.py       47      3    94%
app/api.py             87     45    48%
app/bridge.py         113     52    54%
app/db.py              67     50    25%
app/embeddings.py      85     66    22%
app/labeling.py       115     17    85%
app/pipeline.py       101     68    33%
app/progress.py        31     22    29%
app/search.py         113      4    96%
app/text_fence.py      15      2    87%
---------------------------------------
TOTAL                 816    329    60%
```

Engine and web don't have a measured coverage number yet — neither workspace has a coverage tool wired. Two reasonable surrogates:

- Engine: zero test files → measured coverage on `src/` is 0%. The Bun smoke script touches `voxel/voxelDownsample.ts` and `demo/synth.ts` only.
- Web: 38 tests cover only `lib/titleCard.ts` and `lib/proximity.ts`. Every API route handler, the `loadProject` Arrow+JSON decoder, the reducer helper, and the Supabase server client are untested.

### Targets

| Surface | Target | Rationale |
|---|---|---|
| Reducer logic (`pipeline`, `embeddings`, `labeling`, `adjacency`, `search`, `text_fence`, `bridge`-helpers) | ≥80% line | Brief target; matches what's pure logic vs network I/O |
| Reducer I/O (`db`, `progress`, `worker`, `api` route bodies) | best-effort | Heavy I/O with Postgres/Redis/threads; covered by integration tests in Phase 3, not unit-line targets |
| Web route handlers (logic branches) | ≥80% line | Brief target. Excludes auth-cookie/Supabase-SSR glue (no easy in-process double). |
| Web pure-logic modules (`titleCard`, `proximity`, `reducer` helper, `loadProject` decoders) | ≥80% line | Already met for the first two; gap is `loadProject` |
| Engine pure-logic (`voxelDownsample`, sequencer/generation-counter, math) | ≥90% line | Brief target. R3F components are intentionally excluded — they require WebGL2 and a Canvas, out of unit-test scope. |
| Security paths (auth dep, tenant scoping, prompt injection, path traversal, CSV cap, error sanitization) | explicit tests, regardless of % | Brief mandate. Some already covered (auth dep, fencing, error sanitization); gaps logged below. |

### Gap list

Marked `[H]` for high-priority Phase 2/3/4 work, `[M]` for medium, `[L]` for nice-to-have.

#### Engine
- **[H]** No tests for `voxelDownsample` at all. Need: sparse-under-budget, ultra-dense, zero-variance / flat-plane bounds (all points colinear → range==0), `mustKeep` union behavior with multiple keeps in one cell, `mustKeep` overrides normal reps.
- **[H]** No test for the flythrough generation-counter cancellation logic. The function is inside `VectorScape.tsx` so it's tied to a React component, but the counter pattern itself is a small piece that can be extracted to a pure helper for unit-testability — propose a tiny `createGenerationCounter()` factory and test it directly. Document as the smallest seam that proves "cancel preempts a stale path".
- **[M]** No test for proximity-fade label opacity math inside `ClusterLabels.tsx`. The fade ramp (`smootherstep` between `fadeStart=140` and `fadeEnd=60`, behind-camera dot-product cull) lives inside the component. Extract the pure scalar function (distance → opacity) and test the monotone ramp + cull boundary.

#### Reducer
- **[H]** Pipeline boundary tests are missing despite the spec calling them out:
  - PCA threshold trips correctly at n=20k boundary (n=19_999 → `used_pca=False`, n=20_000+ → `used_pca=True`).
  - HDBSCAN with `n < 5` points still returns a coherent result (no crash, sensible defaults, noise-only OK).
  - Output dimensionality (positions are 3, embeddings 384).
  - Medoid selection: the point nearest to the cluster centroid in 3D is the medoid.
  - Coord normalization to scale 60: longest half-extent equals `COORD_SCALE=60` after normalize.
- **[M]** `bridge.py` uncovered lines are inside `_summarize` (OpenAI/Gemini calls) and `_fetch_cluster` / `_fetch_boundary` (DB cursors). Boundary-point retrieval can be tested with a `_FakeCursor` like `test_search.py` already uses — Phase 2.
- **[M]** Arrow encode/decode round-trip is not covered anywhere. The web `loadProject.fromArrowBundle` decoder is the consumer; the server encoder lives in `app/api/projects/[id]/data/route.ts`. Need round-trip tests for: normal payload, NaN probabilities (sentinel), missing data, large counts, `id` Utf8 column lookup. Web-side bun test.
- **[L]** OpenAI truncation (`_truncate_for_openai` in `embeddings.py`) has no test. Char-cap branch is reachable without tiktoken; tiktoken branch needs a fixture string.

#### Web
- **[H]** No tests for any API route handler. Handlers contain real branches (Content-Length cap, 502 on reducer-unreachable, 409 on `!ready`, tenant-scoped 404 vs 403). Brief target ≥80% can't land without route handler tests.
- **[M]** `loadProject` JSON + Arrow decoders are untested. Round-trip tests slot here.
- **[L]** The reducer-helper `apps/web/lib/reducer.ts` (`reducerHeaders`, `reducerUrl`, `ReducerConfigError`) has no test — simple but worth one assertion per branch.

#### Security tests (explicit, regardless of %)
- **[H]** Tenant forgery on `/embed-reduce` — already covered by `test_search.py`'s `test_search_is_tenant_scoped`? Partially. Brief asks for the same on `/embed-reduce` and `/bridge`. Bridge currently has no explicit "forged tenant_id can't read another tenant" test; `_fetch_cluster` uses `tenant_id`, but the test would prove the binding.
- **[H]** Path traversal on upload filenames. The `apps/web/app/api/projects/route.ts` upload uses `${user_id}/${project_id}/${filename}` as the Storage key. `filename` comes from the browser `File`. A `../../etc/passwd.csv` upload should be neutralized (the Storage RLS already pins the first folder segment to `auth.uid()`, but the route should sanitize the leaf so the *display* doesn't carry traversal characters). No test today.
- **[H]** CSV size cap is enforced (15 MB) per QA-4 in BUILDLOG, but no test asserts the cap triggers before `formData()` is awaited. Worth a test that posts a forged `Content-Length: 999999999` and asserts 413/400 before any body parse.
- **[H]** Error-message sanitization — already implemented per QA-6 (logging.exception + generic copy in `api.py` / `worker.py`). Test exists implicitly via the auth tests but no explicit "exception X should NOT yield raw Python traceback in `projects.error_message`" assertion. Add one.
- **[H]** Prompt-injection through Bridge end-to-end — `test_prompt_injection.py` covers the *prompt-construction* invariants (fence, defang, sanitize). Brief asks for E2E with known injection strings and a check that the *output* stays a benign cluster explanation. We can simulate via a stub LLM that echoes the user span; assertion is "no injected command leaks past the fence into the role tag." Worth a new test class.
- **[H]** Repo secret scan: no committed `.env`. Verified via `git ls-files | xargs grep -l SUPABASE_SERVICE_ROLE_KEY` — every hit is a documentation/code reference, none is a literal key. Need a recurring check + a built-bundle grep (`apps/web/.next/` after `next build`) for the service-role key, which **must never** ship to the browser.
- **[M]** Service-to-service: reducer rejects missing/wrong `X-Reducer-Secret` is fully covered (`test_auth.py`). The 503 (unset secret, fail-closed) is also covered.
- **[M]** Simulated Supabase / connection timeout yields a safe generic `error_message` — not tested explicitly; the QA-6 work guarantees the *shape* (generic copy) but a test should drive the path.

#### CSRF / SameSite posture (documented per brief)

VectorScape uses Supabase Auth via `@supabase/ssr`, which stores the session in cookies. As of this audit:

- All state-changing routes (`POST /api/projects`, `POST /api/projects/[id]/bridge`, `POST /api/projects/[id]/search`, `POST /api/waitlist`) are JSON POST endpoints behind `createSupabaseServerClient` and rely on cookie session for auth. There is no separate CSRF token.
- `@supabase/ssr` sets the auth cookie with `SameSite=Lax` by default (Next.js / Supabase SDK defaults). Lax blocks cross-origin POSTs from form submission, which is the primary CSRF vector. JSON `Content-Type: application/json` requests are also subject to preflight CORS — same-origin browsers will send the cookie; cross-origin attackers cannot, because the Next.js app does not currently set permissive `Access-Control-Allow-Origin`.
- The waitlist `POST /api/waitlist` is intentionally accessible to anonymous users (it's a marketing capture). Its only side effect is an INSERT into `public.waitlist` constrained by a unique index — duplicate submissions return `already: true`. The "CSRF risk" here is a third party causing a victim to submit their own email; the harm is bounded.
- Per CLAUDE.md "deferred — do not build in v1" and QA-7 in BUILDLOG, dedicated CSRF tokens are explicitly deferred. The posture above (cookie `SameSite=Lax` + same-origin assumption + no cross-origin CORS) is sufficient for the MVP threat model. A real production deployment would add an explicit token-per-form check before allowing third-party embedding.

### Findings carried forward (no fixes in Phase 1)

These are observed during the audit but explicitly **not fixed here** — they get triaged in Phase 5 and resolved in Phase 6.

- `services/reducer/app/embeddings.py:47` swallows `Exception` while warming the SentenceTransformer model. Not fatal (the warm-up is best-effort) but the silent swallow hides install/model-resolution errors. Investigate in Phase 5.
- `services/reducer/app/labeling.py:201` and `:226` swallow `Exception` from the OpenAI label call. Intentional per the labeling decision ("per-cluster LLM fallback") but should `logging.exception(...)` before returning the fallback so transient failures are diagnosable.
- `services/reducer/app/worker.py:62` and `app/api.py:136` are intentional per QA-6 (catch + `logging.exception` + generic user-facing copy). Verify the `logging.exception` actually fires in both branches in Phase 5.
- `services/reducer/app/cli.py:63` catches `Exception` around the CLI pipeline run; the error is surfaced via `typer.echo` so this is fine.
- No `: any` / `as any` leakage in `apps/web/app`, `apps/web/lib`, `packages/engine/src` (grep clean). Good.
- Zero secrets in tracked files (grep clean against committed paths). Good. Need a built-bundle scan in Phase 4.

### Targets vs current gap (quick read)

| Surface | Target | Current | Gap |
|---|---|---|---|
| Reducer logic modules | ≥80% line | search 96%, adjacency 94%, labeling 85%, text_fence 87% | pipeline (33%), embeddings (22%), bridge (54%) need targeted unit tests |
| Reducer I/O modules | best-effort | db 25%, progress 29%, api 48%, worker — | Phase 3 integration |
| Engine pure logic | ≥90% line | 0% (no tests) | full Phase 2 build-out for voxel + extracted generation counter + fade math |
| Web pure logic | ≥80% line | titleCard + proximity ~complete; loadProject 0% | Arrow/JSON round-trip tests |
| Web routes | ≥80% line | 0% | every route handler needs a unit test in Phase 3 |
| Security-critical paths | explicit | auth dep ✓, fencing ✓, sanitization ✓ (implicit) | tenant forgery on `/bridge`+`/embed-reduce`, path traversal, size-cap, sanitization-explicit, prompt-injection E2E, bundle secret scan |

---

## Phase 2 — Unit tests (pure logic)

_pending_

## Phase 3 — Integration tests

_pending_

## Phase 4 — Security tests

_pending_

## Phase 5 — Static audit findings

_pending_

## Phase 6 — Final state

_pending_
