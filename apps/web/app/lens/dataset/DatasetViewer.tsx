"use client";

import Link from "next/link";
import Papa from "papaparse";
import { useEffect, useMemo, useState } from "react";

const CSV_URL = "/demo/skm-galaxy.csv";
// Per-category sample size. The dataset is ~8k rows across 20 categories;
// 20 rows per pick is enough to read the flavor without dumping the whole
// file as DOM. The "download CSV" link is the escape hatch for the raw file.
const ROWS_PER_CATEGORY = 20;
const CATEGORY_FIELD = "category";

type Row = Record<string, string>;

type State =
  | { kind: "loading" }
  | {
      kind: "ready";
      fields: string[];
      totalRows: number;
      rowsByCategory: Map<string, Row[]>;
      categoryCounts: { name: string; count: number }[];
    }
  | { kind: "error"; message: string };

export default function DatasetViewer() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(CSV_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        const parsed = Papa.parse<Row>(text, {
          header: true,
          skipEmptyLines: true,
        });
        if (parsed.errors.length > 0) {
          setState({
            kind: "error",
            message: `CSV parse error: ${parsed.errors[0].message}`,
          });
          return;
        }
        const fields = parsed.meta.fields ?? [];
        const rows = parsed.data;
        const hasCategory = fields.includes(CATEGORY_FIELD);
        // Bucket once on parse so chip clicks are just map lookups.
        const rowsByCategory = new Map<string, Row[]>();
        if (hasCategory) {
          for (const r of rows) {
            const k = r[CATEGORY_FIELD] || "(uncategorized)";
            const bucket = rowsByCategory.get(k);
            if (bucket) bucket.push(r);
            else rowsByCategory.set(k, [r]);
          }
        }
        const categoryCounts = Array.from(rowsByCategory.entries())
          .map(([name, list]) => ({ name, count: list.length }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        setState({
          kind: "ready",
          fields,
          totalRows: rows.length,
          rowsByCategory,
          categoryCounts,
        });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : "network error",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rows to render: 20 from the selected category, or first 20 of the file
  // if no category is selected yet.
  const visibleRows = useMemo<Row[]>(() => {
    if (state.kind !== "ready") return [];
    if (selectedCategory && state.rowsByCategory.has(selectedCategory)) {
      return state.rowsByCategory
        .get(selectedCategory)!
        .slice(0, ROWS_PER_CATEGORY);
    }
    // No selection yet: stitch the first few from each category so the
    // initial view doesn't read as "one category" by accident.
    const out: Row[] = [];
    for (const { name } of state.categoryCounts) {
      const bucket = state.rowsByCategory.get(name);
      if (!bucket) continue;
      out.push(...bucket.slice(0, 1));
      if (out.length >= ROWS_PER_CATEGORY) break;
    }
    return out.slice(0, ROWS_PER_CATEGORY);
  }, [state, selectedCategory]);

  return (
    <main className="min-h-screen bg-black text-neutral-100">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-black/70 px-6 py-4 backdrop-blur-md">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <div className="font-display text-xs uppercase tracking-[0.18em] text-amber-200/90">
              SKM lens · dataset
            </div>
            <div className="mt-1 font-display text-lg leading-tight text-neutral-50">
              skm-galaxy.csv
            </div>
            <div className="mt-1 font-mono text-[11px] text-neutral-400">
              {state.kind === "ready"
                ? `${state.totalRows.toLocaleString()} rows · ${state.fields.length} columns · ${state.categoryCounts.length} categories`
                : state.kind === "loading"
                  ? "parsing CSV…"
                  : "could not load"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <a
              href={CSV_URL}
              download
              className="rounded-full border border-white/10 bg-black/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-300 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
              title="Download the raw CSV"
            >
              download ↓
            </a>
            <Link
              href="/lens"
              className="rounded-full border border-white/10 bg-black/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-300 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
            >
              ← galaxy
            </Link>
          </div>
        </div>
      </header>

      {state.kind === "ready" && state.categoryCounts.length > 0 && (
        <nav className="border-b border-white/5 bg-black/40 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryChip
              label="all"
              count={state.totalRows}
              selected={selectedCategory == null}
              onClick={() => setSelectedCategory(null)}
            />
            {state.categoryCounts.map((c) => (
              <CategoryChip
                key={c.name}
                label={c.name}
                count={c.count}
                selected={selectedCategory === c.name}
                onClick={() => setSelectedCategory(c.name)}
              />
            ))}
          </div>
        </nav>
      )}

      <section className="px-6 pt-6 pb-2">
        {state.kind === "loading" && (
          <div className="flex h-64 items-center justify-center font-mono text-xs uppercase tracking-[0.2em] text-neutral-500">
            Loading dataset…
          </div>
        )}
        {state.kind === "error" && (
          <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {state.message}
          </div>
        )}
        {state.kind === "ready" && (
          <>
            <div className="mb-3 font-mono text-[11px] text-neutral-500">
              {selectedCategory
                ? `showing first ${Math.min(ROWS_PER_CATEGORY, visibleRows.length)} of ${state.rowsByCategory.get(selectedCategory)?.length.toLocaleString() ?? 0} in “${selectedCategory}”`
                : `showing a sample of ${visibleRows.length} rows across all categories — pick a chip above to filter`}
            </div>
            <PreviewTable
              rows={visibleRows}
              fields={state.fields}
              highlight={CATEGORY_FIELD}
            />
          </>
        )}
      </section>

      <footer className="border-t border-white/5 bg-black/40 px-6 py-5 font-mono text-[11px] leading-relaxed text-neutral-500">
        <div>
          Dataset:{" "}
          <a
            href="https://www.kaggle.com/datasets/crawford/20-newsgroups"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-300 underline decoration-neutral-700 underline-offset-2 hover:text-amber-200 hover:decoration-amber-300/60"
          >
            20 Newsgroups
          </a>{" "}
          by Ken Lang, distributed via{" "}
          <a
            href="https://scikit-learn.org/0.19/datasets/twenty_newsgroups.html"
            target="_blank"
            rel="noopener noreferrer"
            className="text-neutral-300 underline decoration-neutral-700 underline-offset-2 hover:text-amber-200 hover:decoration-amber-300/60"
          >
            scikit-learn
          </a>
          .
        </div>
      </footer>
    </main>
  );
}

function CategoryChip({
  label,
  count,
  selected,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition " +
        (selected
          ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
          : "border-white/10 bg-black/40 text-neutral-300 hover:border-white/25 hover:text-neutral-100")
      }
    >
      <span>{label}</span>
      <span className="text-neutral-500">{count.toLocaleString()}</span>
    </button>
  );
}

function PreviewTable({
  rows,
  fields,
  highlight,
}: {
  rows: Row[];
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
                className={
                  "whitespace-nowrap px-3 py-2 text-left font-medium " +
                  (f === highlight ? "text-amber-200" : "")
                }
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
                    className={
                      "max-w-[60ch] truncate px-3 py-1.5 align-top " +
                      (f === highlight
                        ? "font-mono text-[11px] text-amber-100/90"
                        : "text-neutral-300")
                    }
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
