import { NextResponse, type NextRequest } from "next/server";
import { ReducerConfigError, reducerHeaders, reducerUrl } from "@/lib/reducer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type SearchBody = {
  query?: unknown;
  limit?: unknown;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_QUERY_CHARS = 2000;

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

  // Verified tenant from the user's own profile row (RLS-gated). The browser
  // cannot supply or override this — it's what we forward to the reducer.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("user_id", userData.user.id)
    .single();
  if (profileErr || !profile) {
    return NextResponse.json({ error: "no profile for user" }, { status: 500 });
  }
  const tenantId = profile.tenant_id as string;

  // RLS-scoped project check — missing → 404 (never leak existence).
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

  const body = (await request.json().catch(() => ({}))) as SearchBody;
  const rawQuery = typeof body.query === "string" ? body.query : "";
  const query = rawQuery.trim().slice(0, MAX_QUERY_CHARS);
  if (!query) {
    return NextResponse.json({ error: "query must be non-empty" }, { status: 400 });
  }
  let limit = Number(body.limit ?? DEFAULT_LIMIT);
  if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
  limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));

  let reducerResp: Response;
  try {
    reducerResp = await fetch(reducerUrl("/search"), {
      method: "POST",
      headers: reducerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        project_id: id,
        tenant_id: tenantId,
        query,
        limit,
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
      { error: `reducer search failed: ${text.slice(0, 300)}` },
      { status: reducerResp.status },
    );
  }
  return new NextResponse(text, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
