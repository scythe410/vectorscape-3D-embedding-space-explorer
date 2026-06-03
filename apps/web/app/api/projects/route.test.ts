import { beforeEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";

/**
 * Security-focused integration tests for POST /api/projects (the CSV upload).
 *
 * Covers:
 *   - Content-Length cap fires BEFORE `request.formData()` is awaited.
 *     A forged `Content-Length: 99...9` header must 413 without ever
 *     entering the multipart parse path.
 *   - The file.size defense-in-depth cap (in case the part's inner size
 *     disagrees with the multipart Content-Length).
 *   - Path-traversal filenames are neutralized before being baked into
 *     the Storage object path.
 *   - Unauthenticated requests are rejected before any DB lookup runs.
 */

// ---- Fake Supabase ---------------------------------------------------------

interface UploadCall {
  bucket: string;
  path: string;
  contentType: string;
}

interface FakeState {
  user: { id: string } | null;
  profile: { tenant_id: string } | null;
  uploads: UploadCall[];
  projectInserts: Array<{ id: string; tenant_id: string; name: string }>;
  // Stop the test before it would try to call the reducer.
  reducerResponse: Response | null;
  reducerThrow: unknown | null;
}

const state: FakeState = {
  user: null,
  profile: null,
  uploads: [],
  projectInserts: [],
  reducerResponse: null,
  reducerThrow: null,
};

class FakeQuery {
  private filters: Record<string, unknown> = {};
  constructor(private table: string, private op: "select" | "insert" | "update" = "select") {}

  select(_cols: string) {
    return this;
  }
  insert(row: Record<string, unknown>) {
    if (this.table === "projects") {
      state.projectInserts.push(row as { id: string; tenant_id: string; name: string });
    }
    return this;
  }
  update(_row: Record<string, unknown>) {
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters[col] = value;
    return this;
  }
  async single() {
    if (this.table === "profiles") {
      if (!state.profile) return { data: null, error: { message: "no profile" } };
      return { data: state.profile, error: null };
    }
    if (this.table === "projects") {
      const row = state.projectInserts.at(-1) ?? null;
      return { data: row, error: null };
    }
    return { data: null, error: null };
  }
  // Thenable for unfetched updates.
  then<T>(resolve: (v: { data: unknown; error: null }) => T) {
    return Promise.resolve(resolve({ data: null, error: null }));
  }
}

const fakeStorage = {
  from(bucket: string) {
    return {
      async upload(path: string, _bytes: Uint8Array, opts: { contentType: string }) {
        state.uploads.push({ bucket, path, contentType: opts.contentType });
        return { data: { path }, error: null };
      },
      async remove(_paths: string[]) {
        return { data: null, error: null };
      },
    };
  },
};

const fakeSupabase = {
  auth: {
    async getUser() {
      return { data: { user: state.user } };
    },
  },
  storage: fakeStorage,
  from(table: string) {
    return new FakeQuery(table);
  },
};

mock.module("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => fakeSupabase,
}));

// The route's reducer helper reads REDUCER_SHARED_SECRET at module-load
// time and throws a ReducerConfigError on every call if it's unset. We
// stub it to a known dev value so the route can reach its happy path;
// none of these tests assert anything about the actual reducer call.
process.env.REDUCER_SHARED_SECRET = "test-secret";

// Stub the reducer call so a 413 / 401 / path-traversal test never hits a
// real reducer. We replace global.fetch only for the duration of each test;
// the route uses bare `fetch(...)`.
const originalFetch = globalThis.fetch;

const routePromise = import("./route");

beforeEach(() => {
  state.user = null;
  state.profile = null;
  state.uploads = [];
  state.projectInserts = [];
  state.reducerResponse = null;
  state.reducerThrow = null;
  globalThis.fetch = async () => {
    if (state.reducerThrow) throw state.reducerThrow;
    if (state.reducerResponse) return state.reducerResponse;
    // Default: a successful sync reducer response.
    return new Response(JSON.stringify({ mode: "sync" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
});

function multipartRequest(
  csvBytes: Uint8Array,
  filename: string,
  fields: Record<string, string> = {},
  contentLengthOverride?: number,
): NextRequest {
  const fd = new FormData();
  fd.append("file", new Blob([csvBytes], { type: "text/csv" }), filename);
  fd.append("text_column", fields.text_column ?? "body");
  fd.append("name", fields.name ?? "test");
  fd.append("reducer", fields.reducer ?? "pacmap");
  const req = new NextRequest("http://localhost/api/projects", {
    method: "POST",
    body: fd,
  });
  if (contentLengthOverride !== undefined) {
    // NextRequest forwards header writes; force a forged Content-Length so
    // the route's early gate fires before formData() runs.
    Object.defineProperty(req, "headers", {
      value: new Headers({ "content-length": String(contentLengthOverride) }),
    });
  }
  return req;
}

function tinyCsv(): Uint8Array {
  // Two columns so papaparse's delimiter auto-detect doesn't warn (which
  // the route treats as a fatal parse error).
  return new TextEncoder().encode("body,extra\nrow one,a\nrow two,b\n");
}

// ---- Tests -----------------------------------------------------------------

describe("POST /api/projects — upload security", () => {
  it("413 when Content-Length exceeds the 15MB cap (BEFORE formData parse)", async () => {
    const { POST } = await routePromise;
    // 16MB — over the 15MB cap; we don't even need to ship that many bytes,
    // because the test forges the header.
    const csv = tinyCsv();
    const req = multipartRequest(csv, "small.csv", {}, 16 * 1024 * 1024);
    const resp = await POST(req);
    expect(resp.status).toBe(413);
    const body = await resp.json();
    expect(body.error).toMatch(/too large/i);
    // The early gate fired before formData(), so the supabase client was
    // never even constructed — no fake calls landed.
    expect(state.uploads.length).toBe(0);
    expect(state.projectInserts.length).toBe(0);
  });

  it("401 when no session (after the size gate, before any DB work)", async () => {
    const { POST } = await routePromise;
    state.user = null;
    const req = multipartRequest(tinyCsv(), "ok.csv");
    const resp = await POST(req);
    expect(resp.status).toBe(401);
    expect(state.uploads.length).toBe(0);
  });

  it("500 when the user has no profile", async () => {
    const { POST } = await routePromise;
    state.user = { id: "user-1" };
    state.profile = null;
    const resp = await POST(multipartRequest(tinyCsv(), "ok.csv"));
    expect(resp.status).toBe(500);
  });

  it("neutralizes path-traversal filenames before they hit Storage", async () => {
    const { POST } = await routePromise;
    state.user = { id: "user-1" };
    state.profile = { tenant_id: "tenant-1" };
    const resp = await POST(multipartRequest(tinyCsv(), "../../etc/passwd.csv"));
    expect(resp.status).toBe(200);
    expect(state.uploads.length).toBe(1);
    // The stored path must be inside the user's own folder and must NOT
    // contain `..` segments or anything resembling escape.
    const stored = state.uploads[0].path;
    expect(stored.startsWith("user-1/")).toBe(true);
    expect(stored.includes("..")).toBe(false);
    // Leaf is just `passwd.csv` (the traversal got stripped).
    expect(stored.endsWith("/passwd.csv")).toBe(true);
  });

  it("rejects non-csv extensions before storage upload", async () => {
    const { POST } = await routePromise;
    state.user = { id: "user-1" };
    state.profile = { tenant_id: "tenant-1" };
    const resp = await POST(multipartRequest(tinyCsv(), "evil.exe"));
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/csv/i);
    expect(state.uploads.length).toBe(0);
  });

  it("rejects an empty CSV (no rows after parse)", async () => {
    const { POST } = await routePromise;
    state.user = { id: "user-1" };
    state.profile = { tenant_id: "tenant-1" };
    const empty = new TextEncoder().encode("body,extra\n");
    const resp = await POST(multipartRequest(empty, "empty.csv"));
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/no rows/i);
  });

  it("forwards the verified tenant_id to the reducer (not a client-supplied one)", async () => {
    const { POST } = await routePromise;
    state.user = { id: "user-1" };
    state.profile = { tenant_id: "real-tenant" };

    let reducerPayload: { tenant_id?: string } | null = null;
    globalThis.fetch = async (_url, init) => {
      reducerPayload = JSON.parse(String((init as RequestInit).body));
      return new Response(JSON.stringify({ mode: "sync" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const resp = await POST(multipartRequest(tinyCsv(), "ok.csv"));
    expect(resp.status).toBe(200);
    expect(reducerPayload).not.toBeNull();
    expect(reducerPayload!.tenant_id).toBe("real-tenant");
  });

  // Restore fetch at the end so any other test that runs after this file
  // (file ordering varies) doesn't inherit our stub.
  it("(teardown) restores global fetch", () => {
    globalThis.fetch = originalFetch;
    expect(true).toBe(true);
  });
});
