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
  // this select returns no row and we 404 rather than leak existence.
  const { data: project, error } = await supabase
    .from("projects")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "project not found" }, { status: 404 });
  }

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
    return NextResponse.json(
      { error: "reducer unreachable" },
      { status: 502 },
    );
  }
  if (!reducerResp.ok) {
    const detail = await reducerResp.text().catch(() => "");
    return NextResponse.json(
      { error: `reducer status fetch failed: ${detail.slice(0, 200)}` },
      { status: 502 },
    );
  }
  const body = await reducerResp.json();
  return NextResponse.json(body);
}
