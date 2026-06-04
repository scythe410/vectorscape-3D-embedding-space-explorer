import { tableFromArrays, tableToIPC } from "apache-arrow";
import { NextResponse, type NextRequest } from "next/server";
import {
  ARROW_BUNDLE_CONTENT_TYPE,
  packArrowBundle,
} from "@/lib/arrowBundle";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// PostgREST caps a single response at 1000 rows by default; we paginate.
const PAGE = 1000;

// Above this row count, ship Arrow IPC instead of JSON. JSON.parse a few-MB
// string on the main thread is the visible stall we're eliminating.
const ARROW_THRESHOLD = 50_000;

type PointRow = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cluster_id: number | null;
  cluster_probability: number | null;
};

type ClusterRow = {
  cluster_id: number;
  label: string | null;
  cx: number;
  cy: number;
  cz: number;
  size: number;
  medoid_point_id: string | null;
};

type ClusterEdgeRow = {
  cluster_a: number;
  cluster_b: number;
  similarity: number;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // RLS scopes to the user's tenant; missing → 404.
  const { data: project, error: projectErr } = await supabase
    .from("projects")
    .select("id, name, status, point_count")
    .eq("id", id)
    .maybeSingle();
  if (projectErr) {
    return NextResponse.json({ error: projectErr.message }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }
  if (project.status !== "ready") {
    return NextResponse.json(
      { error: `project status is ${project.status}, not ready` },
      { status: 409 },
    );
  }

  // Branch on the project's declared point_count *before* fetching any rows
  // so the Arrow path can pre-allocate typed arrays of the right size and
  // never accumulate an intermediate PointRow[] (which on 500k-point projects
  // alone is ~60MB of JS objects — the audit's OOM concern).
  const useArrow = (project.point_count ?? 0) > ARROW_THRESHOLD;

  const { data: clusters, error: clustersErr } = await supabase
    .from("clusters")
    .select("cluster_id, label, cx, cy, cz, size, medoid_point_id")
    .eq("project_id", id)
    .order("cluster_id", { ascending: true });
  if (clustersErr) {
    return NextResponse.json({ error: clustersErr.message }, { status: 500 });
  }
  const clusterRows = (clusters ?? []) as ClusterRow[];

  // Top semantic adjacencies for the optional "show links" overlay. Older
  // projects (pre-migration) won't have rows — that's fine, we'd just emit
  // an empty array. A missing-table error degrades to an empty list too so
  // a mid-deploy reducer can't tank the data endpoint for older projects.
  let edgeRows: ClusterEdgeRow[] = [];
  const { data: edges, error: edgesErr } = await supabase
    .from("cluster_edges")
    .select("cluster_a, cluster_b, similarity")
    .eq("project_id", id)
    .order("similarity", { ascending: false });
  if (edgesErr) {
    // Don't fail the whole response on a missing optional table — but log
    // it, otherwise a real DB-side error reads identically to "no edges
    // computed yet" and a regression silently empties the links overlay.
    console.warn(
      `[data/route] cluster_edges fetch failed for project ${id}: ${edgesErr.message}`,
    );
    edgeRows = [];
  } else {
    edgeRows = (edges ?? []) as ClusterEdgeRow[];
  }

  if (useArrow) {
    const columns = await streamPointsIntoColumns(supabase, id, project.point_count);
    return arrowResponseFromColumns(project, columns, clusterRows, edgeRows);
  }

  // JSON path — below ARROW_THRESHOLD, the intermediate array is fine.
  const points = await drainPoints(supabase, id);
  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      point_count: project.point_count,
    },
    points,
    clusters: clusterRows,
    edges: edgeRows,
  });
}

async function drainPoints(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  projectId: string,
): Promise<PointRow[]> {
  const out: PointRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const { data, error } = await supabase
      .from("points")
      .select("id, text, x, y, z, cluster_id, cluster_probability")
      .eq("project_id", projectId)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    out.push(...(data as PointRow[]));
    if (data.length < PAGE) break;
  }
  return out;
}

/**
 * Bounded-memory variant: streams pages directly into pre-allocated typed
 * array columns. Peak memory is dominated by the columns themselves (which
 * have to exist in full to serialize to Arrow IPC anyway) instead of an
 * O(N) JS object intermediate. For 500k points this saves ~60MB of GC
 * pressure on the Node main thread.
 *
 * The estimated `n` comes from projects.point_count. We grow lazily if the
 * DB has more rows than expected (defensive against stale point_count); we
 * truncate at the end if it has fewer.
 */
async function streamPointsIntoColumns(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  projectId: string,
  estimatedN: number,
): Promise<{
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  clusterId: Int32Array;
  probability: Float32Array;
  text: string[];
  id: string[];
  n: number;
}> {
  let capacity = Math.max(estimatedN, PAGE);
  let x = new Float32Array(capacity);
  let y = new Float32Array(capacity);
  let z = new Float32Array(capacity);
  let clusterId = new Int32Array(capacity);
  let probability = new Float32Array(capacity);
  const text: string[] = new Array(capacity);
  const id: string[] = new Array(capacity);
  let filled = 0;

  const grow = (newCap: number) => {
    capacity = newCap;
    const grow32 = (old: Float32Array) => {
      const next = new Float32Array(capacity);
      next.set(old);
      return next;
    };
    const growI32 = (old: Int32Array) => {
      const next = new Int32Array(capacity);
      next.set(old);
      return next;
    };
    x = grow32(x);
    y = grow32(y);
    z = grow32(z);
    clusterId = growI32(clusterId);
    probability = grow32(probability);
    text.length = capacity;
    id.length = capacity;
  };

  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const { data, error } = await supabase
      .from("points")
      .select("id, text, x, y, z, cluster_id, cluster_probability")
      .eq("project_id", projectId)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;

    if (filled + data.length > capacity) {
      grow(Math.max(capacity * 2, filled + data.length));
    }
    for (let i = 0; i < data.length; i++) {
      const p = data[i] as PointRow;
      x[filled] = p.x;
      y[filled] = p.y;
      z[filled] = p.z;
      clusterId[filled] = p.cluster_id ?? -1;
      probability[filled] = p.cluster_probability ?? Number.NaN;
      text[filled] = p.text;
      id[filled] = p.id;
      filled++;
    }
    if (data.length < PAGE) break;
  }

  // Trim columns to actual filled length so Arrow doesn't ship trailing zeros.
  if (filled !== capacity) {
    x = x.subarray(0, filled).slice();
    y = y.subarray(0, filled).slice();
    z = z.subarray(0, filled).slice();
    clusterId = clusterId.subarray(0, filled).slice();
    probability = probability.subarray(0, filled).slice();
    text.length = filled;
    id.length = filled;
  }
  return { x, y, z, clusterId, probability, text, id, n: filled };
}

function arrowResponseFromColumns(
  project: { id: string; name: string; point_count: number },
  cols: Awaited<ReturnType<typeof streamPointsIntoColumns>>,
  clusters: ClusterRow[],
  edges: ClusterEdgeRow[],
): Response {
  const table = tableFromArrays({
    id: cols.id,
    x: cols.x,
    y: cols.y,
    z: cols.z,
    cluster_id: cols.clusterId,
    cluster_probability: cols.probability,
    text: cols.text,
  });
  const arrowBytes = tableToIPC(table, "stream");
  const out = packArrowBundle(
    {
      project: {
        id: project.id,
        name: project.name,
        point_count: cols.n,
      },
      clusters,
      edges,
    },
    arrowBytes,
  );

  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": ARROW_BUNDLE_CONTENT_TYPE,
      "Content-Length": String(out.byteLength),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * Arrow bundle envelope (binary), encoded by arrowResponseFromColumns above:
 *   [4-byte LE uint32 metaLength][metaJSON utf8][Arrow IPC stream bytes]
 *
 * `meta` carries the project + cluster info (small enough to keep as JSON).
 * The Arrow table holds only the per-point columns and travels as raw typed
 * arrays — no JSON parse on the client hot path.
 *
 * Sentinels for nulls (Arrow's nullable vectors complicate the typed-array
 * fast path; sentinels keep `Vector.toArray()` returning a flat Float32Array):
 *   - cluster_id: int32, -1 means noise
 *   - cluster_probability: float32, NaN means unknown
 */
