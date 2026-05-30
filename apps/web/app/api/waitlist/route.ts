import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const PLATFORMS = new Set(["quest", "vision_pro"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad("expected JSON body");
  }

  const raw = (body ?? {}) as Record<string, unknown>;
  const email = String(raw.email ?? "").trim().toLowerCase();
  const platform = String(raw.platform ?? "").trim();

  if (!email) return bad("email is required");
  if (email.length > 254) return bad("email is too long");
  if (!EMAIL_RE.test(email)) return bad("that doesn't look like a valid email");
  if (!PLATFORMS.has(platform)) return bad("platform must be 'quest' or 'vision_pro'");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("waitlist")
    .insert({ email, platform });

  if (error) {
    // Unique (email, platform) — already on the list. Treat as success.
    if (error.code === "23505") {
      return NextResponse.json({ ok: true, already: true });
    }
    return bad(`could not save: ${error.message}`, 500);
  }

  return NextResponse.json({ ok: true, already: false });
}
