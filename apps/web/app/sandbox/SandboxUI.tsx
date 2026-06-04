"use client";

import dynamic from "next/dynamic";
import Papa from "papaparse";
import { useEffect, useMemo, useRef, useState } from "react";
import { safeName } from "@/lib/safeName";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

// The viewer mounts an R3F <Canvas>, which requires `window`. ssr:false keeps
// it out of the server bundle and avoids a hydration mismatch on first paint.
const SandboxViewer = dynamic(() => import("./SandboxViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[78vh] items-center justify-center rounded-lg border border-neutral-800 bg-neutral-950/40 text-sm text-neutral-400">
      Booting renderer…
    </div>
  ),
});

type Status = "pending" | "reducing" | "ready" | "error";

type StatusBody = {
  project_id: string;
  status: Status;
  point_count: number;
  error_message: string | null;
  progress: { stage: string; pct: number } | null;
};

type PreviewState = {
  file: File;
  rows: Record<string, string>[];
  fields: string[];
  totalRows: number;
};

const PREVIEW_LIMIT = 20;

export default function SandboxUI() {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [parseError, setParseError] = useState<string | undefined>();
  const [textColumn, setTextColumn] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [projectId, setProjectId] = useState<string | undefined>();
  const [status, setStatus] = useState<StatusBody | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const guessedColumn = useMemo(() => {
    if (!preview) return "";
    // Prefer common text-ish columns; otherwise widest column on avg length.
    const preferred = ["text", "body", "content", "message", "description"];
    const lower = preview.fields.map((f) => f.toLowerCase());
    for (const p of preferred) {
      const i = lower.indexOf(p);
      if (i !== -1) return preview.fields[i];
    }
    let bestField = preview.fields[0];
    let bestAvg = 0;
    for (const f of preview.fields) {
      const lens = preview.rows.map((r) => (r[f] ? String(r[f]).length : 0));
      const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
      if (avg > bestAvg) {
        bestAvg = avg;
        bestField = f;
      }
    }
    return bestField;
  }, [preview]);

  useEffect(() => {
    if (guessedColumn && !textColumn) setTextColumn(guessedColumn);
  }, [guessedColumn, textColumn]);

  // Poll the status endpoint while the project is in flight. We tolerate a
  // short run of transient failures (reducer cold start, brief network blip)
  // before declaring the job dead — a single bad poll used to latch the UI
  // into a permanent synthetic error, which was the bug behind the 502 report.
  const MAX_TRANSIENT_FAILURES = 5;
  useEffect(() => {
    if (!projectId) return;
    if (status?.status === "ready" || status?.status === "error") return;

    let cancelled = false;
    let failures = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/projects/${projectId}/status`, { cache: "no-store" });
        // 503 with `transient: true` means the server hit a flaky reducer but
        // the DB row is still in-flight — keep the last good status visible,
        // bump the failure counter, and retry on the next tick.
        if (r.status === 503) {
          failures += 1;
          if (failures < MAX_TRANSIENT_FAILURES) return;
          if (!cancelled) {
            setStatus({
              project_id: projectId,
              status: "error",
              point_count: 0,
              error_message:
                "Reducer service is unreachable. The job may still finish on its own — try refreshing in a minute.",
              progress: null,
            });
          }
          return;
        }
        if (!r.ok) {
          failures += 1;
          if (failures < MAX_TRANSIENT_FAILURES) return;
          if (!cancelled) {
            setStatus({
              project_id: projectId,
              status: "error",
              point_count: 0,
              error_message: `status fetch failed (${r.status})`,
              progress: null,
            });
          }
          return;
        }
        const body = (await r.json()) as StatusBody;
        failures = 0;
        if (!cancelled) setStatus(body);
      } catch (e) {
        failures += 1;
        if (failures < MAX_TRANSIENT_FAILURES) return;
        if (!cancelled) {
          setStatus({
            project_id: projectId,
            status: "error",
            point_count: 0,
            error_message: e instanceof Error ? e.message : "network error",
            progress: null,
          });
        }
      }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [projectId, status?.status]);

  // Manual retry from the error panel: clears the synthetic error so the
  // polling effect re-fires. The DB row is the source of truth, so if the
  // job actually finished while we were offline, the next poll picks it up.
  function retryStatus() {
    if (!projectId) return;
    setStatus({
      project_id: projectId,
      status: "reducing",
      point_count: 0,
      error_message: null,
      progress: null,
    });
  }

  async function handleFile(file: File) {
    setParseError(undefined);
    setPreview(null);
    setTextColumn("");
    setProjectId(undefined);
    setStatus(undefined);

    if (!file.name.toLowerCase().endsWith(".csv")) {
      setParseError("Only .csv files are supported.");
      return;
    }

    const text = await file.text();
    const fullParse = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: true,
    });
    if (fullParse.errors.length > 0) {
      setParseError(`CSV parse error: ${fullParse.errors[0].message}`);
      return;
    }
    const fields = fullParse.meta.fields || [];
    if (fields.length === 0) {
      setParseError("CSV has no header row.");
      return;
    }
    setPreview({
      file,
      rows: fullParse.data.slice(0, PREVIEW_LIMIT),
      fields,
      totalRows: fullParse.data.length,
    });
    if (!projectName) {
      setProjectName(file.name.replace(/\.csv$/i, ""));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!preview || !textColumn) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      // Upload the CSV straight to Supabase Storage from the browser. Vercel's
      // serverless functions cap inbound request bodies at ~4.5 MB; sending the
      // raw multipart through /api/projects fails at the edge before our code
      // ever runs and surfaces as "Failed to fetch". Storage has no such cap,
      // and the storage RLS policy already pins uploads to <auth.uid()>/... so
      // the browser-side upload is authorised correctly. The API route then
      // receives only a small JSON pointer and reads the bytes from Storage.
      const supabase = createSupabaseBrowserClient();
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData.user) {
        setSubmitError("not authenticated");
        return;
      }
      const userId = userData.user.id;
      const pid = crypto.randomUUID();
      const fileName = safeName(preview.file.name);
      const objectPath = `${userId}/${pid}/${fileName}`;

      const up = await supabase.storage
        .from("csv-uploads")
        .upload(objectPath, preview.file, { contentType: "text/csv", upsert: false });
      if (up.error) {
        setSubmitError(`storage upload failed: ${up.error.message}`);
        return;
      }

      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: pid,
          storage_path: objectPath,
          file_name: fileName,
          text_column: textColumn,
          name: projectName || preview.file.name,
        }),
      });
      // The route always sends JSON on the happy path, but Next can emit an
      // empty 500 body when an unhandled error bubbles. Read text first so we
      // can surface the status code instead of "Unexpected end of JSON input".
      const raw = await r.text();
      let body: { error?: string; project_id?: string } = {};
      if (raw) {
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          body = { error: raw.slice(0, 300) };
        }
      }
      if (!r.ok || !body.project_id) {
        // Roll back the uploaded object so retries don't accumulate orphans.
        await supabase.storage.from("csv-uploads").remove([objectPath]);
        setSubmitError(
          body.error || `upload failed (${r.status}${raw ? "" : ", empty response"})`,
        );
        return;
      }
      setProjectId(body.project_id);
      setStatus({
        project_id: body.project_id,
        status: "pending",
        point_count: 0,
        error_message: null,
        progress: null,
      });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "network error");
    } finally {
      setSubmitting(false);
    }
  }

  function resetAll() {
    setPreview(null);
    setParseError(undefined);
    setTextColumn("");
    setProjectName("");
    setProjectId(undefined);
    setStatus(undefined);
    setSubmitError(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="space-y-6">
      {!preview && (
        <DropZone
          onFile={handleFile}
          inputRef={fileInputRef}
          parseError={parseError}
        />
      )}

      {preview && (
        <section className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950/40 p-4">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-sm font-medium">{preview.file.name}</div>
              <div className="text-xs text-neutral-500">
                {preview.totalRows.toLocaleString()} rows · {preview.fields.length} columns ·
                showing first {Math.min(PREVIEW_LIMIT, preview.totalRows)}
              </div>
            </div>
            {!projectId && (
              <button
                type="button"
                onClick={resetAll}
                className="text-xs text-neutral-400 underline hover:text-neutral-200"
              >
                Pick another file
              </button>
            )}
          </div>

          <PreviewTable rows={preview.rows} fields={preview.fields} highlight={textColumn} />

          {!projectId && (
            <form onSubmit={handleSubmit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <label className="block text-xs">
                <span className="text-neutral-400 uppercase tracking-wider">Text column</span>
                <select
                  required
                  value={textColumn}
                  onChange={(e) => setTextColumn(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-2 text-sm outline-none focus:border-neutral-600"
                >
                  {preview.fields.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="text-neutral-400 uppercase tracking-wider">Project name</span>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
                />
              </label>
              <button
                type="submit"
                disabled={submitting || !textColumn}
                aria-busy={submitting}
                className="self-end rounded-md bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-60"
              >
                {submitting ? (
                  <span
                    className="inline-flex items-center gap-1.5 py-1"
                    role="status"
                    aria-label="Uploading"
                  >
                    <span
                      className="wiggle-dot inline-block h-1.5 w-1.5 rounded-full"
                      style={{
                        animationDelay: "0ms",
                        ["--dot-color" as string]: "#14b8a6",
                        ["--dot-halo" as string]: "rgba(20, 184, 166, 0.55)",
                      }}
                    />
                    <span
                      className="wiggle-dot inline-block h-1.5 w-1.5 rounded-full"
                      style={{
                        animationDelay: "280ms",
                        ["--dot-color" as string]: "#8b5cf6",
                        ["--dot-halo" as string]: "rgba(139, 92, 246, 0.55)",
                      }}
                    />
                    <span
                      className="wiggle-dot inline-block h-1.5 w-1.5 rounded-full"
                      style={{
                        animationDelay: "560ms",
                        ["--dot-color" as string]: "#f59e0b",
                        ["--dot-halo" as string]: "rgba(245, 158, 11, 0.6)",
                      }}
                    />
                  </span>
                ) : (
                  "Embed + reduce"
                )}
              </button>
              {submitError && (
                <div className="sm:col-span-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                  {submitError}
                </div>
              )}
            </form>
          )}
        </section>
      )}

      {projectId && status && status.status !== "ready" && (
        <StatusPanel status={status} onReset={resetAll} onRetry={retryStatus} />
      )}

      {projectId && status?.status === "ready" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-sm text-emerald-200">
              {status.point_count.toLocaleString()} points written.
            </div>
            <button
              type="button"
              onClick={resetAll}
              className="text-xs text-neutral-400 underline hover:text-neutral-200"
            >
              Upload another CSV
            </button>
          </div>
          <SandboxViewer projectId={projectId} />
        </div>
      )}
    </div>
  );
}

function DropZone({
  onFile,
  inputRef,
  parseError,
}: {
  onFile: (file: File) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  parseError?: string;
}) {
  const [dragging, setDragging] = useState(false);
  return (
    <div className="space-y-2">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        className={`flex h-48 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed text-sm transition ${
          dragging
            ? "border-neutral-400 bg-neutral-900/60"
            : "border-neutral-800 bg-neutral-950/40 hover:border-neutral-700"
        }`}
      >
        <div className="text-neutral-300">Drop a CSV here or click to choose</div>
        <div className="mt-1 text-xs text-neutral-500">
          First row must be a header. Pick the text column on the next step.
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
      </label>
      {parseError && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {parseError}
        </div>
      )}
    </div>
  );
}

function PreviewTable({
  rows,
  fields,
  highlight,
}: {
  rows: Record<string, string>[];
  fields: string[];
  highlight?: string;
}) {
  return (
    <div className="overflow-auto rounded-md border border-neutral-800">
      <table className="min-w-full text-xs">
        <thead className="bg-neutral-900/60 text-neutral-300">
          <tr>
            {fields.map((f) => (
              <th
                key={f}
                className={`whitespace-nowrap px-3 py-2 text-left font-medium ${
                  f === highlight ? "text-emerald-300" : ""
                }`}
              >
                {f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-neutral-900">
              {fields.map((f) => {
                const v = r[f];
                const s = v == null ? "" : String(v);
                return (
                  <td
                    key={f}
                    className={`max-w-[28ch] truncate px-3 py-1.5 align-top ${
                      f === highlight ? "text-emerald-200" : "text-neutral-300"
                    }`}
                    title={s}
                  >
                    {s || <span className="text-neutral-600">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusPanel({
  status,
  onReset,
  onRetry,
}: {
  status: StatusBody;
  onReset: () => void;
  onRetry: () => void;
}) {
  const isTerminal = status.status === "ready" || status.status === "error";
  const pct = status.progress?.pct ?? (status.status === "ready" ? 100 : 0);
  const stage = status.progress?.stage ?? status.status;

  return (
    <section className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950/40 p-4">
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-sm font-medium">Project status</div>
          <div className="text-xs text-neutral-500">id: {status.project_id}</div>
        </div>
        <StatusBadge status={status.status} />
      </div>

      {!isTerminal && (
        <div>
          <div className="mb-1 flex justify-between text-xs text-neutral-400">
            <span>{stage}</span>
            <span>{pct.toFixed(0)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-900">
            <div
              className="h-full bg-neutral-200 transition-[width] duration-500"
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>
        </div>
      )}

      {status.status === "ready" && (
        <div className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          {status.point_count.toLocaleString()} points written. (3D render coming next.)
        </div>
      )}

      {status.status === "error" && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <div className="font-medium">Reduction failed.</div>
          <div className="mt-1 break-words text-red-300">
            {status.error_message ?? "Unknown error"}
          </div>
        </div>
      )}

      {isTerminal && (
        <div className="flex items-center gap-4">
          {status.status === "error" && (
            <button
              type="button"
              onClick={onRetry}
              className="text-xs text-neutral-300 underline hover:text-neutral-100"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-neutral-400 underline hover:text-neutral-200"
          >
            Upload another CSV
          </button>
        </div>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const cls = {
    pending: "bg-neutral-800 text-neutral-300",
    reducing: "bg-amber-900/40 text-amber-200",
    ready: "bg-emerald-900/40 text-emerald-200",
    error: "bg-red-900/40 text-red-200",
  }[status];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{status}</span>
  );
}
