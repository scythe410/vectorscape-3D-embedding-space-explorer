import { beforeEach, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";

/**
 * Route-handler integration tests for POST /api/waitlist. The Supabase
 * server client is replaced with a recording fake via `mock.module` so the
 * route runs end-to-end (validation → fake DB → response) without a live
 * Supabase project. This is the closest we can get to a real integration
 * test without standing up the cloud RLS gate; the database-side guarantees
 * (anon insert-only, unique-on-(email, platform)) are proved separately in
 * `supabase/tests/waitlist_rls.sql`.
 */

// ---- Fake Supabase capture --------------------------------------------------

type Insert = { email: string; platform: string };

interface FakeSupabaseState {
  inserts: Insert[];
  nextInsertError: { code?: string; message: string } | null;
}

const state: FakeSupabaseState = { inserts: [], nextInsertError: null };

const fakeSupabase = {
  from(_table: string) {
    return {
      async insert(row: Insert) {
        if (state.nextInsertError) {
          const err = state.nextInsertError;
          state.nextInsertError = null;
          return { error: err };
        }
        state.inserts.push(row);
        return { error: null };
      },
    };
  },
};

mock.module("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => fakeSupabase,
}));

// Late-bind the route after the mock is installed.
const routePromise = import("./route");

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rawRequest(body: string): NextRequest {
  return new NextRequest("http://localhost/api/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

describe("POST /api/waitlist", () => {
  beforeEach(() => {
    state.inserts = [];
    state.nextInsertError = null;
  });

  it("400 when the body isn't JSON", async () => {
    const { POST } = await routePromise;
    const resp = await POST(rawRequest("not-json"));
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: "expected JSON body" });
    expect(state.inserts).toEqual([]);
  });

  it("400 when email is missing", async () => {
    const { POST } = await routePromise;
    const resp = await POST(jsonRequest({ platform: "quest" }));
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/email/i);
  });

  it("400 when email is too long", async () => {
    const { POST } = await routePromise;
    const longLocal = "a".repeat(250);
    const resp = await POST(
      jsonRequest({ email: `${longLocal}@example.com`, platform: "quest" }),
    );
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/long/i);
  });

  it("400 when email is malformed", async () => {
    const { POST } = await routePromise;
    const resp = await POST(jsonRequest({ email: "not-an-email", platform: "quest" }));
    expect(resp.status).toBe(400);
  });

  it("400 when platform is not in the enum", async () => {
    const { POST } = await routePromise;
    const resp = await POST(
      jsonRequest({ email: "a@b.co", platform: "xbox" }),
    );
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/quest.*vision_pro/);
  });

  it("normalizes email to lower case before insert", async () => {
    const { POST } = await routePromise;
    const resp = await POST(
      jsonRequest({ email: "  Foo@Bar.COM  ", platform: "quest" }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, already: false });
    expect(state.inserts).toEqual([{ email: "foo@bar.com", platform: "quest" }]);
  });

  it("treats a unique-violation (23505) as already-on-the-list success", async () => {
    const { POST } = await routePromise;
    state.nextInsertError = { code: "23505", message: "duplicate key value" };
    const resp = await POST(
      jsonRequest({ email: "a@b.co", platform: "vision_pro" }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true, already: true });
  });

  it("500 on a generic DB error (other code)", async () => {
    const { POST } = await routePromise;
    state.nextInsertError = { code: "08000", message: "connection failure" };
    const resp = await POST(
      jsonRequest({ email: "a@b.co", platform: "quest" }),
    );
    expect(resp.status).toBe(500);
    // The error string is reflected (a minor info-disclosure already
    // flagged in the QA report's "carried forward" section); the test
    // pins the current behavior so any future hardening shows up in
    // diff.
    expect((await resp.json()).error).toMatch(/connection failure/);
  });
});
