"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type SearchMatch = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cluster_id: number | null;
  score: number;
};

export type SearchRegion = {
  cluster_id: number;
  label: string;
  count: number;
};

export type SearchResult = {
  query: string;
  embed_model: string;
  matches: SearchMatch[];
  // Aggregation by cluster_id, joined with project labels. Sorted by count.
  // Always present (possibly empty); the legibility layer renders it only
  // when labels_are_real is true.
  regions: SearchRegion[];
  // False when every region's label is a "Cluster N" placeholder — gate
  // for the plain-language summary. Region names without real meanings
  // would add noise, not legibility.
  labels_are_real: boolean;
  // Plain-language headline ("mostly Senate races and campaign finance").
  // Empty string when labels are placeholders.
  summary: string;
};

interface Props {
  projectId: string;
  active: SearchResult | null;
  onResult: (result: SearchResult | null) => void;
  /** Fly to a cluster centroid when the user clicks a region chip. */
  onFlyToCluster?: (clusterId: number) => void;
}

export default function SearchPanel({
  projectId,
  active,
  onResult,
  onFlyToCluster,
}: Props) {
  const [query, setQuery] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Monotonic request counter — discards stale responses if the user fires a
  // second search before the first returns. Same pattern as BridgePanel.
  const reqIdRef = useRef(0);

  // Reset local state when the active project changes.
  useEffect(() => {
    setQuery("");
    setError(undefined);
  }, [projectId]);

  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      const myReq = ++reqIdRef.current;
      setSubmitting(true);
      setError(undefined);
      try {
        const resp = await fetch(`/api/projects/${projectId}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed }),
          cache: "no-store",
        });
        const text = await resp.text();
        if (myReq !== reqIdRef.current) return;
        if (!resp.ok) {
          let msg = `search failed (${resp.status})`;
          try {
            const j = JSON.parse(text);
            if (j?.error) msg = j.error;
          } catch {
            if (text) msg = text.slice(0, 300);
          }
          setError(msg);
          return;
        }
        const json = JSON.parse(text) as Partial<SearchResult>;
        onResult({
          query: json.query ?? trimmed,
          embed_model: json.embed_model ?? "",
          matches: Array.isArray(json.matches) ? json.matches : [],
          regions: Array.isArray(json.regions) ? json.regions : [],
          // Old responses (pre-region-summary) won't carry these fields;
          // default to "no summary" so the UI degrades to dot-only.
          labels_are_real: json.labels_are_real === true,
          summary: typeof json.summary === "string" ? json.summary : "",
        });
      } catch (e) {
        if (myReq !== reqIdRef.current) return;
        setError(
          e instanceof Error ? e.message : "network error contacting search",
        );
      } finally {
        if (myReq === reqIdRef.current) setSubmitting(false);
      }
    },
    [projectId, onResult],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      runSearch(query);
    },
    [query, runSearch],
  );

  const handleClear = useCallback(() => {
    reqIdRef.current += 1;
    setQuery("");
    setError(undefined);
    onResult(null);
  }, [onResult]);

  return (
    <section className="flex flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
      <header className="flex items-center justify-between border-b border-neutral-900 px-3 py-2 text-xs uppercase tracking-wider text-neutral-400">
        <span>Search</span>
        {active && (
          <span className="font-mono text-[10px] normal-case tracking-normal text-neutral-500">
            {active.matches.length} match{active.matches.length === 1 ? "" : "es"}
          </span>
        )}
      </header>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 px-3 py-2">
        <div className="flex gap-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="describe what you're looking for…"
            className="flex-1 rounded-md border border-neutral-800 bg-black/40 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={submitting || !query.trim()}
            className="rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "…" : "find"}
          </button>
          {(active || query) && !submitting && (
            <button
              type="button"
              onClick={handleClear}
              className="rounded-md border border-transparent px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300"
              title="Clear search and restore normal brightness"
            >
              clear
            </button>
          )}
        </div>
        {error && (
          <div className="rounded-md border border-red-900/60 bg-red-950/40 px-2 py-1 text-xs text-red-200">
            {error}
          </div>
        )}
        {active && !error && active.matches.length === 0 && (
          <div className="text-xs text-neutral-500">
            No points matched “{active.query}”. Try a different phrasing.
          </div>
        )}
        {/* Region summary: the legibility layer. Only renders when real
            cluster labels exist for this project. Without real names the
            summary would say "Cluster 3 and Cluster 7" — useless — so we
            gate hard and fall back to dot-highlight only. */}
        {active &&
          active.matches.length > 0 &&
          active.labels_are_real &&
          active.regions.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-amber-900/30 bg-amber-950/10 px-2 py-1.5">
              {active.summary && (
                <div className="text-xs leading-snug text-amber-100/90">
                  {active.summary}
                </div>
              )}
              <div className="flex flex-wrap gap-1">
                {active.regions.map((r) => (
                  <button
                    key={r.cluster_id}
                    type="button"
                    onClick={() => onFlyToCluster?.(r.cluster_id)}
                    className="rounded-full border border-amber-300/30 bg-amber-300/5 px-2 py-0.5 text-[10px] text-amber-200 hover:border-amber-300/60 hover:bg-amber-300/10"
                    title={`${r.count} match${r.count === 1 ? "" : "es"} in ${r.label} · click to fly`}
                  >
                    <span className="truncate">{r.label}</span>
                    <span className="ml-1 font-mono text-amber-200/60">
                      {r.count}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        {active && active.matches.length > 0 && (
          <div className="text-[10px] text-neutral-500">
            highlighting nearest {active.matches.length} · embed_model{" "}
            <span className="font-mono">{active.embed_model}</span>
          </div>
        )}
      </form>
    </section>
  );
}
