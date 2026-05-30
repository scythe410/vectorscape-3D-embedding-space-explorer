import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Skip Next internals and static assets — auth cookies only need to refresh
  // on real navigations and API calls.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
