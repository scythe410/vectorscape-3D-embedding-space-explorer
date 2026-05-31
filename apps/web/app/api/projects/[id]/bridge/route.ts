import { NextResponse, type NextRequest } from "next/server";
import { ReducerConfigError, reducerHeaders, reducerUrl } from "@/lib/reducer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

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

  // Pull the verified tenant_id from the user's own profile (RLS-gated on
  // user_id = auth.uid()) — this is the trusted source we forward to the
  // reducer. The browser cannot supply or override it.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileErr || !profile) {
    return NextResponse.json({ error: "no profile for user" }, { status: 500 });
  }
  const tenantId = profile.tenant_id as string;

  // RLS-scoped tenant check on the project: missing → 404 (never leak existence).
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

  let reducerResp: Response;
  try {
    reducerResp = await fetch(reducerUrl("/bridge"), {
      method: "POST",
      headers: reducerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        project_id: id,
        tenant_id: tenantId,
        cluster_a: a,
        cluster_b: b,
      }),
      cache: "no-store",
    });
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
