import { tableFromArrays, tableToIPC } from "apache-arrow";
import { NextResponse, type NextRequest } from "next/server";
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

  const points = await drainPoints(supabase, id);

  const { data: clusters, error: clustersErr } = await supabase
    .from("clusters")
    .select("cluster_id, label, cx, cy, cz, size, medoid_point_id")
    .eq("project_id", id)
    .order("cluster_id", { ascending: true });
  if (clustersErr) {
    return NextResponse.json({ error: clustersErr.message }, { status: 500 });
  }
  const clusterRows = (clusters ?? []) as ClusterRow[];

  const useArrow = points.length > ARROW_THRESHOLD;
  if (useArrow) {
    return arrowResponse(project, points, clusterRows);
  }

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      point_count: project.point_count,
    },
    points,
    clusters: clusterRows,
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
 * Arrow bundle envelope (binary):
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
function arrowResponse(
  project: { id: string; name: string; point_count: number },
  points: PointRow[],
  clusters: ClusterRow[],
): Response {
  const n = points.length;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const clusterId = new Int32Array(n);
  const probability = new Float32Array(n);
  const text = new Array<string>(n);

  for (let i = 0; i < n; i++) {
    const p = points[i];
    x[i] = p.x;
    y[i] = p.y;
    z[i] = p.z;
    clusterId[i] = p.cluster_id ?? -1;
    probability[i] = p.cluster_probability ?? Number.NaN;
    text[i] = p.text;
  }

  const table = tableFromArrays({
    x,
    y,
    z,
    cluster_id: clusterId,
    cluster_probability: probability,
    text,
  });
  const arrowBytes = tableToIPC(table, "stream");

  const metaJson = JSON.stringify({
    project: {
      id: project.id,
      name: project.name,
      point_count: project.point_count,
    },
    clusters,
  });
  const metaBytes = new TextEncoder().encode(metaJson);

  const out = new Uint8Array(4 + metaBytes.byteLength + arrowBytes.byteLength);
  new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
  out.set(metaBytes, 4);
  out.set(arrowBytes, 4 + metaBytes.byteLength);

  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream; format=vs-arrow-bundle",
      "Content-Length": String(out.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
