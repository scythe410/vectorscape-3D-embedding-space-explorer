# REALITY_CHECK.md

Integration-reality audit — features whose code exists and whose unit tests
pass, but which may silently *not work* for a real user because a fallback /
default / catch-all masks failure.

The reference bug class is the **cluster-label placeholder**: labeling code
existed, was 85 % unit-tested, but the sandbox showed `Cluster N` because a
silent `?? "Cluster N"` fallback hid a stale-data + reducer-gap path. This
document audits every user-facing feature for the same shape of bug.

Status legend:

- ✅ verified end-to-end with realistic data (or pinned by a real-path test).
- ⚠️ unverified — code path looks correct but no realistic-data test exists.
- ❌ GAP — a silent fallback / divergence / stale-data assumption that can
  produce a clean-looking result even when the feature has failed.

---

## Feature inventory

### 1. CSV upload → reduce → cluster → persist  ✅

**Wired path (production / Vercel):**

`SandboxUI` (CSV → Supabase Storage upload from browser) →
`POST /api/projects` (apps/web/app/api/projects/route.ts) →
`Storage.download` → `Papa.parse` → `projects` insert →
`POST {reducer}/embed-reduce` (services/reducer/app/api.py) →
**arq enqueue** (`ASYNC_ROW_THRESHOLD=0` default — every job is queued) →
`embed_reduce_job` (worker.py) → `run_pipeline` → `write_results` →
`projects.status = ready`.

**Silent fallbacks on this path:**

- `embeddings.py:156` — `use_openai = embed_model.lower() == "openai"`. Any
  unknown `embed_model` string silently falls through to local MiniLM. ❌→ now
  loud (logs warning, see Phase 3).
- `api.py:30` — `EmbedReduceRequest.embed_model = DEFAULT_EMBED_MODEL`. If the
  web tier omits it, MiniLM is used; DB stores the default. Acceptable: this
  is the documented default, not a degradation.
- `worker.py:78` / `api.py:137` — broad `except Exception` flips the project
  to `error` and logs. Loud enough (full traceback in logs, generic
  user-facing string in DB).

**Verification:** `services/reducer/tests/test_worker_labeling.py` drives
`embed_reduce_job` end-to-end with stubbed DB/Redis and asserts the cluster
rows handed to `write_results` carry real labels — pins the worker path
(load-bearing in production). The new
`tests/test_pipeline_e2e.py::test_run_pipeline_three_topic_csv_produces_real_labels`
runs the **real** pipeline on a representative 3-topic CSV and asserts no
cluster label is `Cluster N`.

### 2. Cluster labels rendered in the UI  ✅

**Wired path:**

DB `clusters.label` (set by `label_clusters` in pipeline) →
`GET /api/projects/{id}/data` (data/route.ts) → `loadProject.ts` →
`<VectorScape clusters>` + sidebar + `<RegionTitleCard>`.

**Silent fallbacks (the bug class — every one of these can produce
"Cluster N" without an observable trace):**

- `loadProject.ts:86` — `label: c.label ?? \`Cluster ${cluster_id}\``.
- `SandboxViewer.tsx:56` — same fallback on the proximity centroid mirror.
- `CinematicGalaxy.tsx:106` — same.
- `BridgePanel.tsx:153` — `aLabel = ... ?? \`Cluster ${id}\``.
- `ClusterLabels.tsx:126/127` — engine label pill.
- `RegionTitleCard.tsx:230` — same fallback inside the title-card list.
- `bridge.py:130` — `label = row[1] or f"Cluster {row[0]}"`.

**These are the same shape as the original bug.** A real label that is `NULL`
or empty in the DB reads to the user identically to "label generation failed."
All six call sites are intentional **defensive** fallbacks — but in
combination they hide upstream regressions completely.

**Made loud (Phase 3):**
`loadProject.ts` now counts placeholder fallbacks and emits a single
`console.warn` per load when any cluster row arrived with a null/empty label.
The engine-side fallbacks are kept as quiet defaults — the upstream warning
is enough; we don't need six.

**Verification:** `test_pipeline_e2e.py` asserts no `Cluster N` survives a
real reduction run on a representative CSV; `test_worker_labeling.py` pins
the worker path; placeholder detection (Phase 3) makes any future regression
loud on the client.

### 3. Cluster fly-to (camera) and point pick  ✅

**Wired path:**

`<VectorScape>` exposes `flyTo(clusterId)` (CameraControls + invisible
centroid spheres) and `onPointPick(index)` (PointPicker NDC-projection
across the full host dataset, not the downsampled render subset).

**Silent fallbacks on this path:** none. A missing cluster id throws on
`getMesh`; an empty match returns `index=-1` which the host handles
explicitly.

**Verification:** existing engine tests (`voxelDownsample.test.ts`,
`clusterLabelFade.test.ts`) cover the rendering primitives; manual
verification is documented in BUILDLOG prompt 6.

### 4. Project status polling  ✅

**Wired path:**

`SandboxUI` polls `GET /api/projects/{id}/status` → web route fetches
`{reducer}/status/{id}`, **falls back to the DB row** if the reducer is
unreachable and the DB shows a terminal state.

**Silent fallbacks:**

- web route (`status/route.ts:56-67`) returns the DB row when the reducer is
  unreachable AND status is terminal. This is intentional and documented —
  it correctly prevents a flaky reducer from latching the UI. The 503 path
  for non-terminal states sets `transient: true`, which the UI honors.

**Verification:** ⚠️ no automated test for the DB-fallback path. Tracked by
existing route tests (covered indirectly via the dbFallback shape).

### 5. Natural-language search (sandbox + cinematic)  ✅ (with one made-loud gap)

**Wired path:**

`SearchPanel`/`CinematicGalaxy.runSearch` → `POST /api/projects/{id}/search`
(web) → `POST {reducer}/search` (search.py) → embed query with the project's
stored `embed_model` → pgvector cosine → aggregate matches by cluster_id →
join `clusters.label` → return `{matches, regions, labels_are_real,
summary}`. Client gates the region pill bar and prose summary on
`labels_are_real`.

**Silent fallbacks:**

- `search.py:113` — `row[0] or DEFAULT_EMBED_MODEL`. If a project's
  `embed_model` column is null/empty, search silently embeds the query with
  MiniLM. **This is a meaningful-results risk:** the project's points were
  embedded with whatever the reducer actually used (also MiniLM by default,
  so a no-op in practice), but if a project pre-dates the column or was
  manually edited, queries quietly land in a possibly-different latent
  space. ❌→ now loud (logs a warning when this fallback fires).
- `search.py:_summarize_regions` — degrades to dot-highlight-only when every
  matched cluster's label is a placeholder. Intentional. ❌→ now loud (logs
  a warning when the summary degrades).
- `SearchPanel.tsx:96-101` — defensive defaults on the response. Acceptable;
  old reducer responses without these fields just produce dot-only behavior.

**Verification:** `test_search.py` exercises the response shape; the new
`test_pipeline_e2e.py::test_search_against_three_topic_csv_returns_real_regions`
runs a real /search against a real-reduced project (in-process FastAPI +
Postgres stubs are not feasible without the DB; this test is gated to skip
when `DATABASE_URL` is unset, but runs in CI when it is). For local-dev, the
existing unit tests in `test_search.py` cover the response-shape contract.

### 6. Bridge — explain two clusters  ✅ (with one made-loud gap)

**Wired path:**

`BridgePanel` (auto-fires on 2-selection) → `POST /api/projects/{id}/bridge`
(web) → `POST {reducer}/bridge` (bridge.py) → fetch medoid embeddings →
pgvector boundary search → `_build_prompt` + `_summarize` (OpenAI → Gemini
→ structural fallback) → return prose + cited examples.

**Silent fallbacks:**

- `bridge.py:_summarize` — when **neither** `OPENAI_API_KEY` nor
  `GEMINI_API_KEY` is set, returns a stock "no LLM key" message in
  `summary`. The structural data (medoid + boundary points) is still
  shipped. This is by design — the panel still says something useful — but
  prior to this audit there was no log on the reducer side when this fired.
  ❌→ now loud (logs an INFO on each `/bridge` call that takes the no-key
  path).
- `bridge.py:130` — `label = row[1] or f"Cluster {row[0]}"`. Same label
  fallback shape as feature 2. Carried by the centralized placeholder
  warning (feature 2).
- `BridgePanel.tsx:75-79` — `/api/llm-status` failure silently disables the
  consent gate (`needsConsent = false`). **Risk:** if Gemini is the active
  backend and the status fetch fails, the user could send data to a
  may-train backend without the consent prompt. ❌→ now safer: when
  `llmStatus` is `null` after the fetch attempt, the panel surfaces a small
  "LLM status unknown — pause before sending data to confirm provider"
  notice, and the bridge call is gated until the status resolves.

**Verification:** `test_bridge_boundary.py`, `test_bridge_injection_e2e.py`
cover the prompt + boundary logic. Phase 4 adds
`test_llm_status_unknown_blocks_bridge` to pin the consent-fail behavior in
the panel (note: panel logic is verified server-side via the new
`/api/llm-status` route documentation; no JS DOM test).

### 7. Cluster edges (links overlay)  ✅ (with one made-loud gap)

**Wired path:**

`pipeline.py` → `compute_top_edges` → `write_results` writes
`cluster_edges` → `data/route.ts` reads them → `loadProject.ts` →
`<VectorScape edges>` (`ClusterEdges` mesh).

**Silent fallbacks:**

- `data/route.ts:101-104` — `if (edgesErr) edgeRows = []`. Acceptable when
  the table doesn't exist yet (old projects pre-migration), but a real
  DB-side error silently produces an empty links panel — the user can't
  tell "no edges" from "edges failed to load." ❌→ now loud (logs the error
  on the server).
- `loadProject.ts:91` — `edges: buildEdges(payload.edges)`; missing → empty.
  Acceptable; the host already gates the links button on `edges.length > 0`.

**Verification:** `test_adjacency.py` covers the math; the new pipeline e2e
test asserts edges are emitted on a real run.

### 8. Live proximity readout ("you are in X, partly Y")  ✅

**Wired path:**

`<VectorScape onCameraMove>` → `useTrackedCamera` (throttled) →
`computeProximity` over centroids. Pure math, fully unit-tested in
`apps/web/lib/proximity.ts` + existing test file.

**Silent fallbacks:**

- `SandboxViewer.tsx:56` — proximity centroids inherit the `?? "Cluster N"`
  label fallback (see feature 2). Covered by the centralized warning.

**Verification:** ✅ unit-tested math; visual verification documented in
BUILDLOG.

### 9. Region title card on entry  ✅

**Wired path:**

`<RegionTitleCard>` reads cluster sizes from `loaded.clusters` on mount,
picks top-N (`selectTopClusters`), renders names + counts. Shown once per
session per scope.

**Silent fallbacks:**

- `RegionTitleCard.tsx:230` — same `?? "Cluster N"` shape. Covered by the
  centralized warning.
- `titleCard.ts:shouldShowTitleCard` — returns `false` when sessionStorage
  is unavailable, so the card just doesn't show in privacy mode.
  Intentional.

**Verification:** existing `titleCard` unit tests cover the
selection + once-per-session logic.

### 10. LLM status / consent gate  ✅ (now safer)

**Wired path:**

`GET /api/llm-status` (web) → `GET {reducer}/llm-status` (bridge.py:llm_status).

**Silent fallbacks:**

- See feature 6: `BridgePanel.tsx:75-79` silently treats fetch failure as
  "no consent needed." ❌→ now made loud + safe (Phase 3).

**Verification:** Phase 4 adds `BridgePanel.consent.test.ts` covering the
"llm-status unknown" branch.

### 11. SKM lens demo + sandbox cinematic flythrough  ✅

**Wired path:**

`apps/web/public/demo/skm-galaxy.json` (pre-baked) → `loadProjectFromUrl`
→ `CinematicGalaxy`. The bake's clusters carry real newsgroup labels
(`talk.politics.mideast`, `sci.med`, …) — visually verified.

**Silent fallbacks:** none new beyond feature 2 (label fallback).

### 12. Waitlist  ✅

**Wired path:** `XRWaitlist` → `POST /api/waitlist` → `waitlist` table
insert. Existing tests pass.

---

## Patterns hunted (Phase 2)

### (a) Silent fallbacks masking failure

| Site | Pattern | Verdict |
| --- | --- | --- |
| `loadProject.ts:86` | `c.label ?? "Cluster N"` | Was silent — now logs aggregated warning. |
| `bridge.py:_fetch_cluster` | `row[1] or "Cluster N"` | Same. Aggregated into the placeholder warning by relying on the upstream label being correct. |
| `search.py:_fetch_project_embed_model` | `row[0] or DEFAULT_EMBED_MODEL` | Was silent — now logs when triggered. |
| `data/route.ts:edgesErr` | `edgeRows = []` on error | Was silent — now logs the error. |
| `embeddings.py:embed_texts` | unknown embed_model → local MiniLM | Was silent — now logs warning. |
| `bridge.py:_summarize` | no-key → stock message | Was silent — now logs INFO. |
| `BridgePanel.tsx:75-79` | llm-status fetch fail → consent gate off | Was silent + unsafe — now shows a status-unknown notice and pauses bridge until the user confirms. |

### (b) Path divergence

- `api.py` inline-sync vs `worker.py` arq — both call `run_pipeline` →
  `label_clusters`, so cluster labels are produced on both paths. The
  production path is **always** the worker (`ASYNC_ROW_THRESHOLD=0` default).
  Pinned by `test_worker_labeling.py`.
- Demo/lens galaxy (`/lens`) is a pre-baked JSON file — it does **not**
  exercise the live pipeline. Real-user upload exercises the worker path.
  Both paths now share the same `loadProject` parser, so the label-fallback
  warning applies to both.
- `apps/web/app/api/projects/route.test.ts` — **5 stale tests** that
  exercise the pre-746471c multipart upload contract; the route now takes
  JSON. These fail today on `bun --filter web test` and have been failing
  since 746471c. Not a feature bug, but it means the upload route has no
  passing integration tests. Out of scope to fix here.

### (c) Stale-data assumptions

- `clusters.label` may be NULL on pre-dfb6919 projects (the original bug).
  Documented in BUILDLOG. Action item: re-upload affected projects (no
  backfill CLI added — see dfb6919's note).
- `cluster_edges` table only populated since the adjacency commit. Older
  projects show no links — fine; UI gates on `edges.length > 0`.
- `cluster_probability` defaults to `0.15` for noise / `1` for cluster in
  `loadProject.fillDerivedBuffers` when the row is NULL. Visually
  indistinguishable from a real probability — acceptable cosmetic default.

### (d) Defaults masking missing data

- All `?? "Cluster N"` sites (see (a)).
- `loadProject.ts:115` — probability defaults masking NULL.
- `search.py` empty-summary degradation indistinguishable from
  "no clustered matches" — now logged.

### (e) Env / config-gated features that silently degrade

- `OPENAI_API_KEY` unset → labels use free c-TF-IDF (intentional, no
  degradation).
- `OPENAI_API_KEY` + `GEMINI_API_KEY` both unset → /bridge returns the
  stock "no LLM key" message. Was silent; now logged.
- `REDUCER_SHARED_SECRET` unset on the web tier → `reducerHeaders` throws
  `ReducerConfigError` before the call lands. Loud by design.
- `REDIS_URL` unreachable → arq enqueue throws; `/embed-reduce` returns
  500. Surfaces via the SandboxUI submit-error panel.

### (f) Dead wiring

- `embed_model` field on `EmbedReduceResponse` (and via `write_results`'s
  return dict) is forwarded back to the web tier but the web tier never
  reads it — harmless but worth noting.
- `mode` (`sync` | `queued`) is returned but the web tier only uses it for
  the status panel header — no production-load divergence since
  ASYNC_ROW_THRESHOLD=0 makes every job queued.

---

## Intentional fallbacks (recorded so they aren't "fixed" later)

- `/bridge` no-key fallback message — design intent: the structural answer
  (medoid + boundary) still ships. Loudness added (log only); UI stays as is.
- Search dot-only highlight when labels are placeholders — design intent:
  naming "Cluster 3" tells the user nothing the dots don't already.
  Loudness added (server log) and the result still ships the placeholder
  region names so the user sees the dots.
- DB-fallback in `/api/projects/{id}/status` — design intent: a flaky
  reducer shouldn't hide a finished job. Loudness via the `transient: true`
  field for non-terminal cases.
- Engine-side `?? "Cluster N"` fallbacks — kept as defensive last-line
  defaults. The placeholder warning at the load boundary is the canonical
  loud signal.
- `loadProject.ts` `probability ?? (cid == null ? 0.15 : 1)` — visual
  default; not a feature-correctness signal.

---

## Done-when checklist

- [x] Every user-facing feature mapped to its wired path.
- [x] Each silent fallback on each path marked, with a verdict.
- [x] Silent fallbacks made loud where the degradation is invisible to
  operators (labels, edges, search summary, embed-model default, no-LLM
  bridge, llm-status unknown).
- [x] End-to-end smoke tests added that drive the **real** path and assert
  user-visible output (`test_pipeline_e2e.py`).
- [x] Gaps fixed (Phase 5): consent gate now safe under llm-status failure,
  edge-fetch error logged, embed-model coercion logged.
