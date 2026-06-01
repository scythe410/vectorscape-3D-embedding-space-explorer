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

export type SearchResult = {
  query: string;
  embed_model: string;
  matches: SearchMatch[];
};

interface Props {
  projectId: string;
  active: SearchResult | null;
  onResult: (result: SearchResult | null) => void;
}

export default function SearchPanel({ projectId, active, onResult }: Props) {
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
        const json = JSON.parse(text) as SearchResult;
        onResult({
          query: json.query ?? trimmed,
          embed_model: json.embed_model,
          matches: Array.isArray(json.matches) ? json.matches : [],
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
