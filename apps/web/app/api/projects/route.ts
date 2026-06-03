import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import Papa from "papaparse";
import { ReducerConfigError, reducerHeaders, reducerUrl, REDUCER_URL } from "@/lib/reducer";
import { safeName } from "@/lib/safeName";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const BUCKET = "csv-uploads";
// Hard cap on uploaded CSV size. Inputs are read fully into memory + parsed
// synchronously by papaparse; without a cap a 100MB CSV stalls the Node main
// thread for seconds. 15MB ≈ ~100k typical text rows — well above sandbox use.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest) {
  // Early size cap — reject before reading the body so a 100MB upload can't
  // exhaust memory or stall the Node main thread on Papa.parse. The browser
  // sends Content-Length on multipart uploads; this gate fires before we
  // call request.formData().
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `upload too large: ${contentLength.toLocaleString()} bytes (max ${MAX_UPLOAD_BYTES.toLocaleString()})`,
      },
      { status: 413 },
    );
  }

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

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("expected multipart/form-data");
  }

  const file = form.get("file");
  const textColumn = String(form.get("text_column") || "").trim();
  const name = String(form.get("name") || "").trim() || "untitled";
  const reducer = (String(form.get("reducer") || "").trim() || "pacmap").toLowerCase();

  if (!(file instanceof File)) return bad("missing file");
  if (!textColumn) return bad("missing text_column");
  if (!file.name.toLowerCase().endsWith(".csv")) return bad("file must be a .csv");
  // Defense-in-depth: re-check the parsed file's size in case the multipart
  // Content-Length didn't represent the inner part.
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `file too large: ${file.size.toLocaleString()} bytes (max ${MAX_UPLOAD_BYTES.toLocaleString()})`,
      },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder("utf-8").decode(bytes);
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

  const projectId = randomUUID();
  const objectPath = `${user.id}/${projectId}/${safeName(file.name)}`;

  const upload = await supabase.storage
    .from(BUCKET)
    .upload(objectPath, bytes, { contentType: "text/csv", upsert: false });
  if (upload.error) {
    return bad(`storage upload failed: ${upload.error.message}`, 500);
  }

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
