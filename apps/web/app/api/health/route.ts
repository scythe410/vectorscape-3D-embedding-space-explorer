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
    // /auth/v1/health is unauthenticated and returns fast when the project is
    // live. A paused project fails DNS resolution and throws here.
    const resp = await fetch(`${url}/auth/v1/health`, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(t);
    return NextResponse.json<HealthStatus>(
      { ok: resp.ok },
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
