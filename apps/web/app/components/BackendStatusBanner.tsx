"use client";

import { useEffect, useState } from "react";

import type { HealthStatus } from "../api/health/route";

/**
 * Slim, unobtrusive banner shown when the Supabase backend is unreachable —
 * most commonly a paused free-tier project (DNS NXDOMAIN). Without this, the
 * app silently degrades to a logged-out state and auth-gated features fail with
 * no explanation. Polls /api/health and auto-clears once the backend is back.
 */
export default function BackendStatusBanner() {
  const [down, setDown] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const resp = await fetch("/api/health", { cache: "no-store" });
        const data = (await resp.json()) as HealthStatus;
        if (!cancelled) setDown(!data.ok);
      } catch {
        // A failed probe itself is inconclusive (could be the app), so don't
        // flip the banner on solely from a fetch error here.
      }
    };

    check();
    // Re-probe while down so the banner disappears on its own once the project
    // is restored — no reload needed. 30s is gentle.
    const id = setInterval(check, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!down) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-2 border-b border-amber-300/20 bg-amber-950/70 px-4 py-2 text-center font-mono text-[11px] tracking-[0.08em] text-amber-100/90 backdrop-blur-md"
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-300"
      />
      <span>
        Backend temporarily unavailable — it may be waking up. Saved projects
        and sign-in are paused; this page still works.
      </span>
    </div>
  );
}
