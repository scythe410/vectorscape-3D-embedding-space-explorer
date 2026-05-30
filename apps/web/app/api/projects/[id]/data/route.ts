import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Page size for the points scan. Supabase's PostgREST caps a single response
// at 1000 rows by default; we re-window with .range() until the project is
// fully drained. Sandbox projects sit comfortably under 50k.
const PAGE = 1000;

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

  // RLS scopes the row to the user's tenant; missing → 404.
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

  // Drain the points table in PAGE-sized windows. We exclude the embedding
  // column — 384 floats × N points would be huge JSON for no rendering use.
  const points: PointRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const { data, error } = await supabase
      .from("points")
      .select("id, text, x, y, z, cluster_id, cluster_probability")
      .eq("project_id", id)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    points.push(...(data as PointRow[]));
    if (data.length < PAGE) break;
  }

  const { data: clusters, error: clustersErr } = await supabase
    .from("clusters")
    .select("cluster_id, label, cx, cy, cz, size, medoid_point_id")
    .eq("project_id", id)
    .order("cluster_id", { ascending: true });
  if (clustersErr) {
    return NextResponse.json({ error: clustersErr.message }, { status: 500 });
  }

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      point_count: project.point_count,
    },
    points,
    clusters: (clusters ?? []) as ClusterRow[],
  });
}
