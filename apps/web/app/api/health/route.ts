import { NextResponse } from "next/server";

export const runtime = "nodejs";

export type HealthStatus = {
  ok: boolean;
  // "backend_unavailable" == Supabase unreachable (e.g. paused free-tier
  // project → DNS NXDOMAIN, or a transient outage).
  reason?: "backend_unavailable" | "not_configured";
};

/** Lightweight reachability probe for the Supabase backend. */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    return NextResponse.json<HealthStatus>(
      { ok: false, reason: "not_configured" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    // Reachability probe: what we're detecting is a paused project, whose
    // subdomain stops resolving (DNS NXDOMAIN) so fetch THROWS. A live project
    // returns *some* HTTP status through the gateway — even a 401 for the
    // missing apikey — which means it's up. So any response == reachable; only
    // a thrown error means unavailable. (Don't check resp.ok: the gateway 401s
    // /auth/v1/* without an apikey and that would false-positive the banner.)
    await fetch(`${url}/auth/v1/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(t);
    return NextResponse.json<HealthStatus>(
      { ok: true },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json<HealthStatus>(
      { ok: false, reason: "backend_unavailable" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
