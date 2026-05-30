import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const REDUCER_URL = process.env.REDUCER_URL || "http://127.0.0.1:8000";

type BridgeBody = {
  cluster_a?: unknown;
  cluster_b?: unknown;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // RLS-scoped tenant check: missing → 404 (never leak existence).
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
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

  const body = (await request.json().catch(() => ({}))) as BridgeBody;
  const a = Number(body.cluster_a);
  const b = Number(body.cluster_b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return NextResponse.json(
      { error: "cluster_a and cluster_b must be integers" },
      { status: 400 },
    );
  }
  if (a === b) {
    return NextResponse.json(
      { error: "cluster_a and cluster_b must differ" },
      { status: 400 },
    );
  }

  const reducerResp = await fetch(`${REDUCER_URL}/bridge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: id, cluster_a: a, cluster_b: b }),
    cache: "no-store",
  });
  const text = await reducerResp.text();
  if (!reducerResp.ok) {
    return NextResponse.json(
      { error: `reducer bridge failed: ${text.slice(0, 300)}` },
      { status: reducerResp.status },
    );
  }
  return new NextResponse(text, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
