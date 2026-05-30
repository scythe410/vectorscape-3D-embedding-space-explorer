"use client";

import { VectorScape, type VectorScapeHandle } from "engine";
import { useCallback, useEffect, useRef, useState } from "react";

import BridgePanel from "./BridgePanel";
import { clusterColor, loadProject, type LoadedProject } from "./loadProject";

interface Props {
  projectId: string;
}

// At most two clusters can be in the Bridge selection at once.
const MAX_SELECTION = 2;

export default function SandboxViewer({ projectId }: Props) {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<number[]>([]);
  const handleRef = useRef<VectorScapeHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFetchError(undefined);
    setPickedIndex(null);
    setSelection([]);

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
          points={loaded.pointsData}
          clusters={loaded.centroids}
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
      </div>

      <aside className="flex flex-col gap-3 overflow-hidden">
        <section className="flex max-h-[40%] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
          <header className="border-b border-neutral-900 px-3 py-2 text-xs uppercase tracking-wider text-neutral-400">
            Clusters
          </header>
          <ul className="flex-1 overflow-y-auto text-sm">
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
          <div className="flex-1 overflow-y-auto px-3 py-2 text-sm">
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
