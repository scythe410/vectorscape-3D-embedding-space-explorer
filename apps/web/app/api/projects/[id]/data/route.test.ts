import { beforeEach, describe, expect, it, mock } from "bun:test";
import { tableFromIPC, type Table } from "apache-arrow";
import { NextRequest } from "next/server";

import { unpackArrowBundle } from "@/lib/arrowBundle";

/**
 * Integration tests for GET /api/projects/[id]/data. A recording fake
 * stands in for the Supabase server client; the route is exercised
 * end-to-end including the auth gate, the tenant-scoped RLS lookup
 * (via .maybeSingle()), the not-ready guard, and the JSON-vs-Arrow
 * threshold gate at point_count > 50_000.
 *
 * Database-side RLS is proved separately in
 * `supabase/tests/rls_cross_tenant.sql` (cross-tenant SELECT/UPDATE/
 * DELETE / INSERT all denied); these tests focus on the route's own
 * branches.
 */

// ---- Fake Supabase chain ---------------------------------------------------

type ProjectRow = {
  id: string;
  name: string;
  status: string;
  point_count: number;
};

type PointRow = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cluster_id: number | null;
  cluster_probability: number | null;
};

type ClusterRow = {
  cluster_id: number;
  label: string | null;
  cx: number;
  cy: number;
  cz: number;
  size: number;
  medoid_point_id: string | null;
};

type EdgeRow = {
  cluster_a: number;
  cluster_b: number;
  similarity: number;
};

interface FakeState {
  user: { id: string } | null;
  project: ProjectRow | null;
  projectError: { message: string } | null;
  clusters: ClusterRow[];
  edges: EdgeRow[];
  edgesError: { message: string } | null;
  points: PointRow[];
}

const state: FakeState = {
  user: null,
  project: null,
  projectError: null,
  clusters: [],
  edges: [],
  edgesError: null,
  points: [],
};

class FakeQuery {
  private filters: Record<string, unknown> = {};
  private rangeArgs: [number, number] | null = null;

  constructor(private table: "projects" | "clusters" | "cluster_edges" | "points") {}

  select(_cols: string) {
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters[col] = value;
    return this;
  }

  order(_col: string, _opts?: unknown) {
    return this;
  }

  range(from: number, to: number) {
    this.rangeArgs = [from, to];
    return this;
  }

  async maybeSingle() {
    if (this.table === "projects") {
      if (state.projectError) return { data: null, error: state.projectError };
      return { data: state.project, error: null };
    }
    return { data: null, error: null };
  }

  // The supabase-js builder is also thenable — `await query` works.
  then<T>(resolve: (v: { data: unknown; error: { message: string } | null }) => T) {
    if (this.table === "clusters") {
      return Promise.resolve(resolve({ data: state.clusters, error: null }));
    }
    if (this.table === "cluster_edges") {
      if (state.edgesError) return Promise.resolve(resolve({ data: null, error: state.edgesError }));
      return Promise.resolve(resolve({ data: state.edges, error: null }));
    }
    if (this.table === "points") {
      const [from, to] = this.rangeArgs ?? [0, state.points.length - 1];
      return Promise.resolve(
        resolve({ data: state.points.slice(from, to + 1), error: null }),
      );
    }
    return Promise.resolve(resolve({ data: null, error: null }));
  }
}

const fakeSupabase = {
  auth: {
    async getUser() {
      return { data: { user: state.user } };
    },
  },
  from(table: string) {
    return new FakeQuery(table as never);
  },
};

mock.module("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => fakeSupabase,
}));

const routePromise = import("./route");

function req(): NextRequest {
  return new NextRequest("http://localhost/api/projects/proj/data");
}

function makePoints(n: number): PointRow[] {
  const out: PointRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `p${i}`,
      text: `row ${i}`,
      x: i,
      y: -i,
      z: i & 0xff,
      cluster_id: i % 3 === 0 ? null : i % 3,
      cluster_probability: i % 5 === 0 ? null : 0.5 + (i % 10) / 20,
    });
  }
  return out;
}

beforeEach(() => {
  state.user = null;
  state.project = null;
  state.projectError = null;
  state.clusters = [];
  state.edges = [];
  state.edgesError = null;
  state.points = [];
});

describe("GET /api/projects/[id]/data", () => {
  it("401 when no session", async () => {
    const { GET } = await routePromise;
    const resp = await GET(req(), { params: Promise.resolve({ id: "proj" }) });
    expect(resp.status).toBe(401);
  });

  it("404 when project not found in the user's tenant (RLS scoped)", async () => {
    const { GET } = await routePromise;
    state.user = { id: "u1" };
    // state.project remains null — RLS would return no row.
    const resp = await GET(req(), { params: Promise.resolve({ id: "proj" }) });
    expect(resp.status).toBe(404);
    expect((await resp.json()).error).toMatch(/not found/i);
  });

  it("500 when projects lookup errors", async () => {
    const { GET } = await routePromise;
    state.user = { id: "u1" };
    state.projectError = { message: "boom" };
    const resp = await GET(req(), { params: Promise.resolve({ id: "proj" }) });
    expect(resp.status).toBe(500);
  });

  it("409 when project is not ready (still reducing)", async () => {
    const { GET } = await routePromise;
    state.user = { id: "u1" };
    state.project = { id: "proj", name: "p", status: "reducing", point_count: 0 };
    const resp = await GET(req(), { params: Promise.resolve({ id: "proj" }) });
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/reducing/);
  });

  it("200 JSON path when point_count is small (under 50k threshold)", async () => {
    const { GET } = await routePromise;
    state.user = { id: "u1" };
    state.project = { id: "proj", name: "demo", status: "ready", point_count: 3 };
    state.clusters = [
      { cluster_id: 0, label: "Stars", cx: 0, cy: 0, cz: 0, size: 2, medoid_point_id: "p0" },
    ];
    state.points = makePoints(3);

    const resp = await GET(req(), { params: Promise.resolve({ id: "proj" }) });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toMatch(/application\/json/);
    const body = await resp.json();
    expect(body.project.id).toBe("proj");
    expect(body.points).toHaveLength(3);
    expect(body.clusters).toHaveLength(1);
    expect(body.edges).toEqual([]);
  });

  it("includes edges in the JSON body when present", async () => {
    const { GET } = await routePromise;
    state.user = { id: "u1" };
    state.project = { id: "proj", name: "demo", status: "ready", point_count: 3 };
    state.clusters = [];
    state.edges = [
      { cluster_a: 0, cluster_b: 1, similarity: 0.91 },
      { cluster_a: 1, cluster_b: 2, similarity: 0.42 },
    ];
    state.points = makePoints(3);

    const resp = await GET(req(), { params: Promise.resolve({ id: "proj" }) });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.edges).toHaveLength(2);
    expect(body.edges[0].similarity).toBeCloseTo(0.91);
  });

  it("degrades to empty edges on a missing cluster_edges table (mid-deploy)", async () => {
    const { GET } = await routePromise;
    state.user = { id: "u1" };
    state.project = { id: "proj", name: "demo", status: "ready", point_count: 1 };
    state.points = makePoints(1);
    state.edgesError = { message: "relation cluster_edges does not exist" };
    const resp = await GET(req(), { params: Promise.resolve({ id: "proj" }) });
    expect(resp.status).toBe(200);
    expect((await resp.json()).edges).toEqual([]);
  });

  it("Arrow path triggers when point_count > 50k and bytes round-trip cleanly", async () => {
    const { GET } = await routePromise;
    const n = 50_001;
    state.user = { id: "u1" };
    state.project = { id: "big", name: "big", status: "ready", point_count: n };
    state.points = makePoints(n);

    const resp = await GET(req(), { params: Promise.resolve({ id: "big" }) });
    expect(resp.status).toBe(200);
    const ct = resp.headers.get("content-type") ?? "";
    expect(ct).toMatch(/vs-arrow-bundle/);

    const bytes = new Uint8Array(await resp.arrayBuffer());
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const { meta, arrowBytes } = unpackArrowBundle<{ project: { point_count: number } }>(buf);
    expect(meta.project.point_count).toBe(n);
    const table = tableFromIPC(arrowBytes) as Table;
    expect(table.numRows).toBe(n);
    const ids = table.getChild("id")!;
    expect(String(ids.get(0))).toBe("p0");
    expect(String(ids.get(n - 1))).toBe(`p${n - 1}`);
  });
});
