import { NextResponse, type NextRequest } from "next/server";
import { ReducerConfigError, reducerHeaders, reducerUrl } from "@/lib/reducer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

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

  // Tenant check via RLS: if the project doesn't belong to the user's tenant,
  // this select returns no row and we 404 rather than leak existence. We also
  // grab status fields so we can fall back to the DB when the reducer service
  // is temporarily unreachable — terminal states (ready/error) are persisted
  // there, so a flaky reducer shouldn't hide a finished job from the UI.
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, status, point_count, error_message")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

  const dbFallback = () => ({
    project_id: id,
    status: project.status,
    point_count: project.point_count ?? 0,
    error_message: project.error_message ?? null,
    progress: null,
  });

  let reducerResp: Response;
  try {
    reducerResp = await fetch(reducerUrl(`/status/${id}`), {
      cache: "no-store",
      headers: reducerHeaders(),
    });
  } catch (e) {
    if (e instanceof ReducerConfigError) {
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    // Reducer unreachable. If the DB already shows a terminal state, that's
    // the truth — return it 200. Otherwise mark the response transient so the
    // client retries instead of latching to a synthetic error.
    if (project.status === "ready" || project.status === "error") {
      return NextResponse.json(dbFallback());
    }
    return NextResponse.json(
      { ...dbFallback(), transient: true, error: "reducer unreachable" },
      { status: 503 },
    );
  }
  if (!reducerResp.ok) {
    const detail = await reducerResp.text().catch(() => "");
    if (project.status === "ready" || project.status === "error") {
      return NextResponse.json(dbFallback());
    }
    return NextResponse.json(
      {
        ...dbFallback(),
        transient: true,
        error: `reducer status fetch failed: ${detail.slice(0, 200)}`,
      },
      { status: 503 },
    );
  }
  const body = await reducerResp.json();
  return NextResponse.json(body);
}
