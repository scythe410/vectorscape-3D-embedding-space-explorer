import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import Papa from "papaparse";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const REDUCER_URL = process.env.REDUCER_URL || "http://127.0.0.1:8000";
const BUCKET = "csv-uploads";

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Sanitize a filename for use as a Storage object path component. */
function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() || "upload.csv";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload.csv";
}

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
  const reducerResp = await fetch(`${REDUCER_URL}/embed-reduce`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      tenant_id: tenantId,
      rows,
      text_column: textColumn,
      name,
      reducer,
    }),
  });
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
