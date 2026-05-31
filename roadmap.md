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

## Deferred production hardening (from QA audit, 2026-05-31)

The QA pass (`qa_fixes.md`) applied the correctness + safety bugs that bite even a single-user demo (event-loop starvation, S2S auth, prompt-injection fence, upload cap, bounded data fetch, write race, OpenAI truncation, error sanitization). The items below are valid audit findings deliberately **not** built in this pass — they grade a deployed multi-tenant SaaS, and VectorScape is a pre-launch MVP. Trigger for nearly all of them is **before public launch / first real users.**

- **Per-tenant rate limiting** on `/api/projects` POST and `/api/projects/[id]/bridge` (Upstash Redis or built-in arq). Caps LLM cost-blowup + worker-queue abuse. **Trigger:** first public deploy, or any tenant >1.
- **Tenant DB + storage quotas** (max projects, max points, max bytes per tenant). Postgres triggers or a precheck in the upload route. **Trigger:** same as above.
- **Waitlist CAPTCHA** (Cloudflare Turnstile is the lowest-friction). Prompt-11's waitlist insert is open to anon — fine while the form sees zero traffic; ugly the first time a bot finds it. **Trigger:** waitlist hits its first bot row.
- **CSRF tokens / custom-header check** on state-changing POSTs. Today we rely on `SameSite=Lax` cookies + JSON body — defense-in-depth, not nothing, but not full belt-and-suspenders. **Trigger:** before any third-party site embeds VectorScape, or before launch.
- **Next.js security headers** in `next.config.ts`: CSP (locked to self + Supabase + the Arrow blob origin), HSTS, X-Frame-Options DENY, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy minimal. **Trigger:** launch.
- **Dockerfiles + CI/CD + Terraform.** Today the whole thing runs from `bun --filter web dev` + `uv run dev` + local Redis. Need a `Dockerfile` for `apps/web` (multistage Node), one for `services/reducer` (uv-based Python), a worker variant, and a GitHub Actions pipeline (lint → typecheck → pytest → build → image push). Terraform modules for the hosting target (Fly.io / Railway / GCP Cloud Run all reasonable). **Trigger:** first deploy beyond a single developer's laptop.
- **Message broker upgrade vs. staying on arq+Redis.** arq is fine to ~thousands of jobs/day; beyond that, RabbitMQ or NATS for durable retries and dead-letter queues. **Trigger:** sustained queue backlog or a need for retry-after-N policies arq doesn't model well.
- **Full unit / integration / pentest test suites.** This QA pass added targeted tests (auth gate, prompt-injection fence). The complete coverage the audit asks for — Next.js route handlers, Arrow encoder, pipeline edge cases, RLS storage policies, prompt-injection end-to-end via the real LLM, path-traversal `safeName`, DoS event-loop test — is its own substantial work. **Trigger:** before launch; the targeted regression tests already in place are the QA fixes' own validation, not a stand-in for full coverage.
- **External secrets manager + key rotation** at deploy. `.env` works for one dev; production needs Doppler / 1Password / Vault / AWS Secrets Manager and a rotation runbook for `SUPABASE_SERVICE_ROLE_KEY` + `REDUCER_SHARED_SECRET` + `OPENAI_API_KEY`. **Trigger:** first deploy.
- **Service-to-service TLS** between web and reducer (HTTPS even on the internal hop, not plain HTTP loopback). On most platforms this is the default once both services have ingress; on others (Cloud Run egress, Fly internal DNS) it needs explicit TLS termination. **Trigger:** any deployment topology where web and reducer aren't in the same node/process group.

The audit's local-stack suggestion (`supabase start` for dev secrets) is **rejected** per `CLAUDE.md` — VectorScape is cloud-only. The valid half (rotate any service-role key that ever sat in a commit history; keep secrets out of git) is standard hygiene.
