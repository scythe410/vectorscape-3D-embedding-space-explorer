"use client";

import { VectorScape, type PointsData, type VectorScapeHandle } from "engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import BridgePanel from "./BridgePanel";
import SearchPanel, { type SearchResult } from "./SearchPanel";
import { clusterColor, loadProject, type LoadedProject } from "./loadProject";

interface Props {
  projectId: string;
}

// At most two clusters can be in the Bridge selection at once.
const MAX_SELECTION = 2;

// Probability values driving the shader brightness/alpha during search.
// Matched points stay fully lit; everyone else dims into the background fog.
const SEARCH_HIT_PROB = 1.0;
const SEARCH_MISS_PROB = 0.04;

export default function SandboxViewer({ projectId }: Props) {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<number[]>([]);
  const [hqMode, setHqMode] = useState(false);
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const handleRef = useRef<VectorScapeHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFetchError(undefined);
    setPickedIndex(null);
    setSelection([]);
    setSearchResult(null);

    loadProject(projectId)
      .then((p) => {
        if (!cancelled) setLoaded(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : "network error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Search-aware points data. When search is active, override the probability
   * channel so matched points stay bright and the rest fade — using the
   * existing per-point probability the shader already consumes for
   * brightness/alpha. No new uniforms, no per-frame CPU work; rebuilds the
   * GPU attribute once per search.
   */
  const displayPointsData: PointsData | null = useMemo(() => {
    if (!loaded) return null;
    if (!searchResult || searchResult.matches.length === 0) {
      return loaded.pointsData;
    }
    const matchIndices = new Set<number>();
    for (const m of searchResult.matches) {
      const idx = loaded.indexById(m.id);
      if (idx != null) matchIndices.add(idx);
    }
    if (matchIndices.size === 0) return loaded.pointsData;
    const n = loaded.totalPoints;
    const probability = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      probability[i] = matchIndices.has(i) ? SEARCH_HIT_PROB : SEARCH_MISS_PROB;
    }
    return {
      position: loaded.pointsData.position,
      color: loaded.pointsData.color,
      size: loaded.pointsData.size,
      probability,
    };
  }, [loaded, searchResult]);

  // When search results land, fly to the strongest cluster of results — the
  // cluster_id with the most matches. Falls back to the geometric mean of the
  // match positions if the matches are mostly noise.
  const flyToSearchResults = useCallback(
    (result: SearchResult) => {
      if (!loaded || result.matches.length === 0) return;
      const counts = new Map<number, number>();
      for (const m of result.matches) {
        if (m.cluster_id == null) continue;
        counts.set(m.cluster_id, (counts.get(m.cluster_id) ?? 0) + 1);
      }
      let best: number | null = null;
      let bestCount = 0;
      for (const [cid, c] of counts) {
        if (c > bestCount) {
          best = cid;
          bestCount = c;
        }
      }
      if (best != null && loaded.centroids.some((c) => Number(c.id) === best)) {
        handleRef.current?.flyTo(best);
        return;
      }
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const m of result.matches) {
        cx += m.x;
        cy += m.y;
        cz += m.z;
      }
      const k = result.matches.length;
      handleRef.current?.flyToPoint([cx / k, cy / k, cz / k], 6);
    },
    [loaded],
  );

  const onSearchResult = useCallback(
    (result: SearchResult | null) => {
      setSearchResult(result);
      if (result && result.matches.length > 0) flyToSearchResults(result);
    },
    [flyToSearchResults],
  );

  /**
   * Selection model:
   *   - Plain click → fly to cluster + replace selection with [id].
   *   - Shift/Cmd/Ctrl click → toggle id in selection (max 2). If two are
   *     already chosen and a new one is added, the oldest drops out.
   * This keeps the simple fly-to motion intact while letting Bridge fire as
   * soon as a pair exists.
   */
  const onClusterPick = useCallback(
    (rawId: string | number, opts: { additive: boolean }) => {
      const id = Number(rawId);
      if (opts.additive) {
        setSelection((prev) => {
          if (prev.includes(id)) return prev.filter((x) => x !== id);
          if (prev.length >= MAX_SELECTION) return [...prev.slice(1), id];
          return [...prev, id];
        });
        return;
      }
      handleRef.current?.flyTo(id);
      setSelection([id]);
    },
    [],
  );

  const onClusterRowClick = useCallback(
    (id: number, additive: boolean) => onClusterPick(id, { additive }),
    [onClusterPick],
  );

  const pickedPoint =
    pickedIndex != null && loaded ? loaded.getPoint(pickedIndex) : null;

  if (fetchError) {
    return (
      <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        Failed to load project: {fetchError}
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-[70vh] items-center justify-center rounded-lg border border-neutral-800 bg-neutral-950/40 text-sm text-neutral-400">
        Loading galaxy…
      </div>
    );
  }

  return (
    <div className="grid h-[78vh] grid-cols-[1fr_320px] gap-3">
      <div className="relative overflow-hidden rounded-lg border border-neutral-800 bg-black">
        <VectorScape
          ref={handleRef}
          points={displayPointsData ?? loaded.pointsData}
          clusters={loaded.centroids}
          enableDOF={hqMode}
          onClusterSelect={onClusterPick}
          onPointPick={(index) => setPickedIndex(index >= 0 ? index : null)}
        />
        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/50 px-2 py-1 text-xs text-neutral-300 backdrop-blur">
          {loaded.project.name} · {loaded.totalPoints.toLocaleString()} points ·{" "}
          {loaded.clusters.length} clusters
          <span className="ml-2 text-neutral-500">
            ({loaded.format}, parse {loaded.parseMs.toFixed(0)}ms)
          </span>
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/50 px-2 py-1 text-[11px] text-neutral-400 backdrop-blur">
          Click cluster · scroll/drag to fly · shift-click two clusters to bridge
        </div>
        <button
          type="button"
          onClick={() => setHqMode((v) => !v)}
          className={
            "absolute bottom-3 right-3 rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur transition " +
            (hqMode
              ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
              : "border-white/10 bg-black/50 text-neutral-300 hover:border-white/25 hover:text-neutral-100")
          }
          title="Depth-of-field bokeh — best for screenshots and slow exploration"
        >
          {hqMode ? "HQ · on" : "HQ"}
        </button>
      </div>

      <aside className="flex flex-col gap-3 overflow-hidden">
        <SearchPanel
          projectId={projectId}
          active={searchResult}
          onResult={onSearchResult}
        />

        <section className="flex max-h-[40%] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
          <header className="border-b border-neutral-900 px-3 py-2 text-xs uppercase tracking-wider text-neutral-400">
            Clusters
          </header>
          <ul className="scrollbar-subtle flex-1 overflow-y-auto text-sm">
            <li>
              <button
                type="button"
                onClick={() => {
                  handleRef.current?.resetView();
                  setSelection([]);
                }}
                className="block w-full px-3 py-2 text-left text-neutral-400 hover:bg-neutral-900/60"
              >
                ← reset view
              </button>
            </li>
            {loaded.centroids.map((c) => {
              const rgb = clusterColor(Number(c.id));
              const isSelected = selection.includes(Number(c.id));
              return (
                <li key={String(c.id)}>
                  <button
                    type="button"
                    onClick={(e) =>
                      onClusterRowClick(
                        Number(c.id),
                        e.shiftKey || e.metaKey || e.ctrlKey,
                      )
                    }
                    className={
                      "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900/60 " +
                      (isSelected ? "bg-amber-900/10" : "")
                    }
                    title="Click to fly · Shift-click to add to Bridge"
                  >
                    <span
                      className="inline-block h-3 w-3 rounded-sm"
                      style={{
                        background: `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`,
                      }}
                    />
                    <span
                      className={
                        "flex-1 truncate " +
                        (isSelected ? "text-amber-200" : "text-neutral-200")
                      }
                    >
                      {c.label}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {loaded.clusters.find((cl) => cl.cluster_id === c.id)?.size}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <BridgePanel
          projectId={projectId}
          selection={selection}
          clusters={loaded.clusters}
          handleRef={handleRef}
          onClear={() => setSelection([])}
        />

        <section className="flex max-h-[30%] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
          <header className="border-b border-neutral-900 px-3 py-2 text-xs uppercase tracking-wider text-neutral-400">
            Selection
          </header>
          <div className="scrollbar-subtle flex-1 overflow-y-auto px-3 py-2 text-sm">
            {pickedPoint ? (
              <div className="space-y-2">
                <div className="text-xs text-neutral-500">
                  cluster:{" "}
                  {pickedPoint.cluster_id == null ? (
                    <span className="text-neutral-400">noise</span>
                  ) : (
                    <span className="text-neutral-300">{pickedPoint.cluster_id}</span>
                  )}
                  {pickedPoint.cluster_probability != null && (
                    <> · p={pickedPoint.cluster_probability.toFixed(2)}</>
                  )}
                </div>
                <div className="whitespace-pre-wrap break-words text-neutral-200">
                  {pickedPoint.text}
                </div>
              </div>
            ) : (
              <div className="text-xs text-neutral-500">
                Click a point in the galaxy to see its source text.
              </div>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}
