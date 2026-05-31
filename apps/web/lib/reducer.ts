/**
 * Server-only helper for calling the reducer FastAPI service. Centralizes:
 *   - REDUCER_URL resolution
 *   - the X-Reducer-Secret header (must match REDUCER_SHARED_SECRET on the
 *     reducer; never exposed to the browser)
 *
 * Import this only from server code (route handlers, server actions). The
 * secret must not leak into a client bundle.
 */

const REDUCER_URL = process.env.REDUCER_URL || "http://127.0.0.1:8000";
const REDUCER_SECRET = process.env.REDUCER_SHARED_SECRET || "";

export class ReducerConfigError extends Error {}

export function reducerHeaders(extra: Record<string, string> = {}): HeadersInit {
  if (!REDUCER_SECRET) {
    throw new ReducerConfigError(
      "REDUCER_SHARED_SECRET is not set in the web server env. The reducer " +
        "will reject this call. Add it to your .env and restart the dev server.",
    );
  }
  return {
    "X-Reducer-Secret": REDUCER_SECRET,
    ...extra,
  };
}

export function reducerUrl(path: string): string {
  return `${REDUCER_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export { REDUCER_URL };
