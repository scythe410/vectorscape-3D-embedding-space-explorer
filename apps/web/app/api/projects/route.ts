import { NextResponse, type NextRequest } from "next/server";
import Papa from "papaparse";
import { ReducerConfigError, reducerHeaders, reducerUrl, REDUCER_URL } from "@/lib/reducer";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const BUCKET = "csv-uploads";
// Hard cap on uploaded CSV size. The browser uploads straight to Supabase
// Storage (Vercel's ~4.5 MB inbound body cap would otherwise reject anything
// large before our code runs); the server then downloads bytes from Storage
// and parses synchronously. 15 MB ≈ ~100 k typical text rows — well above
// sandbox use, but bounded so a 1 GB CSV can't stall the Node main thread.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
// UUIDv4: 8-4-4-4-12 hex chars. Tight pattern so we don't accept arbitrary
// strings as projectId or as storage path segments.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

type CreateBody = {
  project_id?: string;
  storage_path?: string;
  file_name?: string;
  text_column?: string;
  name?: string;
  reducer?: string;
};

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) return bad("not authenticated", 401);

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("tenant_id")
    .eq("user_id", user.id)
    .single();
  if (profileErr || !profile) return bad("no profile for user", 500);
  const tenantId = profile.tenant_id as string;

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return bad("expected application/json body");
  }

  const projectId = String(body.project_id || "").trim();
  const storagePath = String(body.storage_path || "").trim();
  const textColumn = String(body.text_column || "").trim();
  const fileName = String(body.file_name || "").trim();
  const name = String(body.name || "").trim() || "untitled";
  const reducer = (String(body.reducer || "").trim() || "pacmap").toLowerCase();

  if (!projectId || !UUID_RE.test(projectId)) return bad("invalid project_id");
  if (!textColumn) return bad("missing text_column");
  if (!storagePath) return bad("missing storage_path");
  if (!fileName || !fileName.toLowerCase().endsWith(".csv")) {
    return bad("file must be a .csv");
  }

  // Hard-pin storage_path to <user.id>/<project_id>/<leaf>. Without this the
  // caller could ask the server to read someone else's file (RLS would still
  // block them at the storage layer, but we never want the route to *try*).
  const expectedPrefix = `${user.id}/${projectId}/`;
  if (!storagePath.startsWith(expectedPrefix) || storagePath.includes("..")) {
    return bad("invalid storage_path");
  }

  // Download the file from Storage. The user's session client enforces the
  // storage RLS policy (`(foldername(name))[1] = auth.uid()`), so this only
  // succeeds for objects in the caller's own folder.
  const dl = await supabase.storage.from(BUCKET).download(storagePath);
  if (dl.error || !dl.data) {
    return bad(`storage read failed: ${dl.error?.message || "missing object"}`, 404);
  }
  const blob = dl.data;
  if (blob.size > MAX_UPLOAD_BYTES) {
    // Clean up so the orphan doesn't sit in Storage forever.
    await supabase.storage.from(BUCKET).remove([storagePath]);
    return NextResponse.json(
      {
        error: `file too large: ${blob.size.toLocaleString()} bytes (max ${MAX_UPLOAD_BYTES.toLocaleString()})`,
      },
      { status: 413 },
    );
  }

  const text = await blob.text();
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) {
    return bad(`CSV parse error: ${parsed.errors[0].message}`);
  }
  const rows = parsed.data;
  if (rows.length === 0) return bad("CSV has no rows");
  const fields = parsed.meta.fields || [];
  if (!fields.includes(textColumn)) {
    return bad(`text_column '${textColumn}' not in CSV columns: ${fields.join(", ")}`);
  }

  const objectPath = storagePath;

  const insert = await supabase
    .from("projects")
    .insert({
      id: projectId,
      tenant_id: tenantId,
      name,
      status: "pending",
      reducer,
    })
    .select("id, tenant_id")
    .single();
  if (insert.error) {
    // Roll back the uploaded object so we don't orphan it.
    await supabase.storage.from(BUCKET).remove([objectPath]);
    return bad(`project insert failed: ${insert.error.message}`, 500);
  }

  // Hand off to the reducer. The reducer uses service-role and bypasses RLS,
  // so we pass tenant_id explicitly to keep the row tenant-scoped.
  // Wrap the fetch — a downed reducer (ECONNREFUSED) would otherwise throw and
  // Next would return an empty 500 body, leaving the client to choke on
  // `.json()` with "Unexpected end of JSON input".
  let reducerResp: Response;
  try {
    reducerResp = await fetch(reducerUrl("/embed-reduce"), {
      method: "POST",
      headers: reducerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        project_id: projectId,
        tenant_id: tenantId,
        rows,
        text_column: textColumn,
        name,
        reducer,
      }),
    });
  } catch (e) {
    await supabase
      .from("projects")
      .update({ status: "error", error_message: "Reducer service unreachable." })
      .eq("id", projectId);
    if (e instanceof ReducerConfigError) {
      return bad(e.message, 500);
    }
    const msg = e instanceof Error ? e.message : String(e);
    return bad(
      `reducer unreachable at ${REDUCER_URL} — is the FastAPI service running? (${msg})`,
      502,
    );
  }
  if (!reducerResp.ok) {
    const detail = await reducerResp.text().catch(() => "");
    await supabase
      .from("projects")
      .update({ status: "error" })
      .eq("id", projectId);
    return bad(`reducer error (${reducerResp.status}): ${detail.slice(0, 300)}`, 502);
  }
  const reducerJson = (await reducerResp.json()) as { mode?: "sync" | "queued" };

  return NextResponse.json({
    project_id: projectId,
    mode: reducerJson.mode ?? "sync",
    row_count: rows.length,
    storage_path: objectPath,
  });
}
