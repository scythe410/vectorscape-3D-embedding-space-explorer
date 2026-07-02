import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Refreshes Supabase auth cookies on every request so server components see a live session. */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(items) {
          for (const { name, value } of items) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of items) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Touch the session so cookies refresh. Fail open: if Supabase is
  // unreachable or slow, never block the request — an unrefreshed session is
  // far better than 504-ing the entire site (incl. pages that need no auth).
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("supabase auth timeout")), 3000),
    );
    await Promise.race([supabase.auth.getUser(), timeout]);
  } catch {
    // Swallow: cookies just won't refresh this request.
  }

  return response;
}
