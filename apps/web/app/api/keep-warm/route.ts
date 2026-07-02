import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Keep-warm cron target. Supabase auto-pauses free-tier projects after ~7 days
 * of *database* inactivity — a paused project 504'd the whole site once (see
 * middleware fail-open). A Vercel function ping alone doesn't count; only a
 * real query against Postgres resets the timer, so we issue a tiny read here.
 * Scheduled daily in vercel.json.
 */
export async function GET(request: NextRequest) {
  // Vercel injects `Authorization: Bearer $CRON_SECRET` when the env var is
  // set. Enforce it if present; otherwise stay open (the read is harmless).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const supabase = await createSupabaseServerClient();
  // A head+count select executes against Postgres even under RLS, which is all
  // we need — the row data is irrelevant, the query is the point.
  const { error } = await supabase
    .from("waitlist")
    .select("id", { head: true, count: "exact" });

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, at: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
