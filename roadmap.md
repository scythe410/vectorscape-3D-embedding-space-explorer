# roadmap.md — VectorScape (post-v1)

Things deliberately **not** in v1, captured so they're revisited rather than lost. Each is a good idea at the wrong time; the note records *why* it's parked so future-you doesn't have to reconstruct the reasoning.

## Already deferred (from MVP scope)

- **Time-lapse** — clusters forming over a date range. Start with fixed-projection date filtering; add AlignedUMAP for true re-emergence later (UMAP coordinates jump between fits, so this needs aligned/parametric projection to be stable).
- **Cross-language collision (Sinhala/Tamil/English)** — **gated on validation.** Confirm the three languages actually co-cluster on a FLORES-200 sample (LaBSE or BGE-M3) *before* building or promising anything. Sinhala is the high-risk part: lowest resource tier, no published cross-lingual benchmark. Do not pull forward off the bench.
- **Other lenses** — bias debugger, e-commerce, fintech, feedback, arXiv, codebase, music, photos. Each is a data source + skin on the same engine; ship as demand appears.
- **OAuth source connectors** (Drive/Notion/Slack) — CSV covers v1.
- **Real XR build** — Quest first via `@react-three/xr` reusing the engine; Vision Pro later (browser WebXR on visionOS is the uncertain part). Engine is kept renderer-clean so this is an add, not a rewrite.
- **WebGPU renderer** — the path to *smooth* 1M points. WebGL2 carries the v1 budget (validated by the spike); WebGPU is a later swap behind the engine's renderer interface, paired with re-doing post-processing in TSL nodes.

## Parked from technical review (good ideas, premature for v1)

- **Distributed reducer (worker swarm + chunked embedding).** Correct for *concurrent enterprise load* — chunk CSVs, distribute embedding across workers, pull vectors to one node for global reduction. Premature now: solo, pre-launch, ~zero concurrent users. A single arq worker handles real traffic for a long time. Revisit when concurrent large uploads actually queue up. **Trigger to build: sustained job-queue backlog.**
- **Semantic zoom via the HDBSCAN dendrogram.** HDBSCAN already builds a hierarchy; thread it to the frontend so scrolling *semantically* splits a parent nebula into child sub-clusters in real time. Genuinely compelling — and a substantial feature (hierarchy transport, tree state, live re-clustering, wired into navigation feel). A great **v2 headliner**, not an MVP line item. Park deliberately. (Note: per-point membership probability *is* shipping in v1 as shader brightness — the cheap, on-theme slice of this idea.)
- **Dynamic multilingual model-swap + LoRA adapters.** Detect language in the reducer and swap to a multilingual model (e.g. `paraphrase-multilingual-MiniLM-L12-v2`), optionally with LoRA adapters tuned for low-resource syntax. The reasonable *model-swap* version belongs with the cross-language work above — but only **after** FLORES-200 validation proves the languages even cluster. LoRA adapters are a research project on top of a research project; defer hard.

## Adopted from review into v1 (for the record)

These review points were folded into the v1 spec rather than deferred: **voxel-grid (O(N)) downsampling** in the engine, **HDBSCAN per-point probability → shader brightness**, **boundary points (not just medoids) in the Bridge**, and **conditional PCA** (skip under ~20k points). See `prompt_flow.md` prompts 3, 4, 10.
