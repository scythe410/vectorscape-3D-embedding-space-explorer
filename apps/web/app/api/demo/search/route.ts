/**
 * POST /api/demo/search — unauthenticated semantic search over the SKM lens
 * demo points. The demo project never exists in Supabase, so the regular
 * /api/projects/[id]/search path can't serve it. This route works entirely
 * off the pre-computed embeddings bundle shipped in `lib/demo/`.
 *
 * Flow:
 *   1. Load embeddings + point metadata (memoized after first call).
 *   2. Ask the reducer's /embed endpoint for the query vector (same MiniLM
 *      model the demo embeddings were produced by — cosine is meaningless
 *      across models).
 *   3. Cosine-score in JS, top-K.
 *   4. Aggregate matches by cluster_id and compose a region summary in the
 *      same shape /api/projects/[id]/search returns.
 *
 * Rate limit: simple per-IP token bucket — the reducer's /embed endpoint
 * does real model work, so a public route must throttle.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ReducerConfigError, reducerHeaders, reducerUrl } from "@/lib/reducer";
import { loadDemoBundle } from "@/lib/demo/skmGalaxy";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_QUERY_CHARS = 2000;
const REGION_TOP_N = 3;
const PLACEHOLDER_RE = /^cluster\s+\d+$/i;

// Token bucket: per-IP, 10 searches / minute. Each query triggers a reducer
// /embed call (real CPU); without throttling a single client could pin the
// service. In-memory — fine for a demo, would graduate to a shared store
// for anything load-bearing.
const RATE_BUCKET = new Map<string, { tokens: number; updated: number }>();
const RATE_CAP = 10;
const RATE_REFILL_PER_MS = RATE_CAP / 60_000;

function takeToken(ip: string): boolean {
  const now = Date.now();
  const entry = RATE_BUCKET.get(ip) ?? { tokens: RATE_CAP, updated: now };
  const elapsed = now - entry.updated;
  entry.tokens = Math.min(RATE_CAP, entry.tokens + elapsed * RATE_REFILL_PER_MS);
  entry.updated = now;
  if (entry.tokens < 1) {
    RATE_BUCKET.set(ip, entry);
    return false;
  }
  entry.tokens -= 1;
  RATE_BUCKET.set(ip, entry);
  return true;
}

type SearchBody = { query?: unknown; limit?: unknown };

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (!takeToken(ip)) {
    return NextResponse.json(
      { error: "rate limited — try again in a few seconds" },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as SearchBody;
  const rawQuery = typeof body.query === "string" ? body.query : "";
  const query = rawQuery.trim().slice(0, MAX_QUERY_CHARS);
  if (!query) {
    return NextResponse.json({ error: "query must be non-empty" }, { status: 400 });
  }
  let limit = Number(body.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
  limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));

  let bundle: Awaited<ReturnType<typeof loadDemoBundle>>;
  try {
    bundle = await loadDemoBundle();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `demo embeddings unavailable: ${msg}` },
      { status: 500 },
    );
  }

  // Ask the reducer for the query vector. We can't embed locally — MiniLM
  // doesn't run in Node without a sidecar, and shipping a JS embedder is a
  // dead-end. The reducer call is ~50ms once the model is warm.
  let queryVec: Float32Array;
  try {
    const resp = await fetch(reducerUrl("/embed"), {
      method: "POST",
      headers: reducerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        texts: [query],
        embed_model: bundle.embedModel,
      }),
      cache: "no-store",
    });
    if (!resp.ok) {
      const text = await resp.text();
      return NextResponse.json(
        { error: `reducer embed failed: ${text.slice(0, 300)}` },
        { status: resp.status },
      );
    }
    const json = (await resp.json()) as {
      vectors: number[][];
      dim: number;
      embed_model: string;
    };
    if (!json.vectors?.[0] || json.dim !== bundle.dim) {
      return NextResponse.json(
        { error: `reducer returned malformed embedding (dim=${json.dim})` },
        { status: 502 },
      );
    }
    queryVec = normalize(new Float32Array(json.vectors[0]));
  } catch (e) {
    if (e instanceof ReducerConfigError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `reducer unreachable — is the FastAPI service running? (${msg})` },
      { status: 502 },
    );
  }

  const topIdx = topKByDot(bundle.embeddings, queryVec, bundle.dim, limit);

  const matches = topIdx.map(({ idx, score }) => {
    const p = bundle.points[idx];
    return {
      id: p.id,
      text: p.text,
      x: p.x,
      y: p.y,
      z: p.z,
      cluster_id: p.cluster_id,
      // Stored vectors are unit-norm + the query is normalized above, so the
      // dot product is cosine similarity. /api/projects/[id]/search returns
      // pgvector's cosine *distance* (0 = identical). Mirror that here so the
      // client treats both responses identically.
      score: 1 - score,
    };
  });

  // Aggregate by cluster_id, join in labels from the bundle, surface a
  // region summary when labels look real.
  const counts = new Map<number, number>();
  for (const m of matches) {
    if (m.cluster_id == null) continue;
    counts.set(m.cluster_id, (counts.get(m.cluster_id) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  );
  const regions = ordered.slice(0, REGION_TOP_N).map(([cid, count]) => {
    const raw = bundle.clusters.get(cid)?.label?.trim() ?? "";
    return {
      cluster_id: cid,
      label: raw || `Cluster ${cid}`,
      count,
    };
  });
  const labelsAreReal = regions.some(
    (r) => !PLACEHOLDER_RE.test(r.label.trim()),
  );
  const namedRegions = regions.filter(
    (r) => !PLACEHOLDER_RE.test(r.label.trim()),
  );
  const totalNamed = namedRegions.reduce((s, r) => s + r.count, 0);
  const summary = labelsAreReal ? composeSummary(namedRegions, totalNamed) : "";

  return NextResponse.json({
    project_id: bundle.projectId,
    query,
    embed_model: bundle.embedModel,
    matches,
    regions,
    labels_are_real: labelsAreReal,
    summary,
  });
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const n = Math.sqrt(sum);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function topKByDot(
  flat: Float32Array,
  q: Float32Array,
  dim: number,
  k: number,
): { idx: number; score: number }[] {
  const n = flat.length / dim;
  // Min-heap of size k by score. For k ≪ n (typical: k=20, n=7660) a simple
  // bounded linear scan with manual heap-like insertion is fine; switching
  // to a real heap is premature.
  const heap: { idx: number; score: number }[] = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) s += flat[off + j] * q[j];
    if (heap.length < k) {
      heap.push({ idx: i, score: s });
      if (heap.length === k) heap.sort((a, b) => a.score - b.score);
    } else if (s > heap[0].score) {
      heap[0] = { idx: i, score: s };
      // Bubble down — only need to keep the min at index 0.
      let cur = 0;
      while (true) {
        const l = cur * 2 + 1;
        const r = cur * 2 + 2;
        let smallest = cur;
        if (l < heap.length && heap[l].score < heap[smallest].score) smallest = l;
        if (r < heap.length && heap[r].score < heap[smallest].score) smallest = r;
        if (smallest === cur) break;
        [heap[cur], heap[smallest]] = [heap[smallest], heap[cur]];
        cur = smallest;
      }
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

function composeSummary(
  regions: { label: string; count: number }[],
  totalMatches: number,
): string {
  if (regions.length === 0 || totalMatches <= 0) return "";
  const top = regions[0];
  const share = top.count / totalMatches;
  if (share >= 0.8 || regions.length === 1) return `mostly ${top.label}`;
  if (regions.length === 2) return `${regions[0].label} and ${regions[1].label}`;
  return `${regions[0].label}, ${regions[1].label}, and ${regions[2].label}`;
}
