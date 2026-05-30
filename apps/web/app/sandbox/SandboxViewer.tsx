"use client";

import { VectorScape, type ClusterCentroid, type PointsData, type VectorScapeHandle } from "engine";
import { useEffect, useMemo, useRef, useState } from "react";

type PointRow = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cluster_id: number | null;
  cluster_probability: number | null;
};

type ClusterRow = {
  cluster_id: number;
  label: string | null;
  cx: number;
  cy: number;
  cz: number;
  size: number;
  medoid_point_id: string | null;
};

type DataPayload = {
  project: { id: string; name: string; point_count: number };
  points: PointRow[];
  clusters: ClusterRow[];
};

interface Props {
  projectId: string;
}

const NOISE_COLOR: [number, number, number] = [0.35, 0.38, 0.45];

/**
 * Hash a cluster id into an HSL hue, then RGB in [0,1]. Stable across
 * reloads so the same cluster keeps the same color.
 */
function clusterColor(clusterId: number): [number, number, number] {
  // Golden-ratio hue stride keeps adjacent ids visually distinct.
  const h = ((clusterId * 0.61803398875) % 1 + 1) % 1;
  return hslToRgb(h, 0.65, 0.6);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

export default function SandboxViewer({ projectId }: Props) {
  const [payload, setPayload] = useState<DataPayload | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const handleRef = useRef<VectorScapeHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setFetchError(undefined);
    setPickedIndex(null);

    (async () => {
      try {
        const r = await fetch(`/api/projects/${projectId}/data`, { cache: "no-store" });
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
          if (!cancelled) setFetchError(body.error || `HTTP ${r.status}`);
          return;
        }
        const body = (await r.json()) as DataPayload;
        if (!cancelled) setPayload(body);
      } catch (e) {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : "network error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Build the typed-array PointsData the engine consumes. Memoized on payload
  // identity — the engine treats `points` as a stable reference key for the
  // voxel pass and the GPU-resident buffers.
  const pointsData = useMemo<PointsData | null>(() => {
    if (!payload) return null;
    const n = payload.points.length;
    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const probability = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = payload.points[i];
      position[i * 3] = p.x;
      position[i * 3 + 1] = p.y;
      position[i * 3 + 2] = p.z;
      const rgb = p.cluster_id == null ? NOISE_COLOR : clusterColor(p.cluster_id);
      color[i * 3] = rgb[0];
      color[i * 3 + 1] = rgb[1];
      color[i * 3 + 2] = rgb[2];
      size[i] = 1.6;
      probability[i] = p.cluster_probability ?? (p.cluster_id == null ? 0.15 : 1);
    }
    return { position, color, size, probability };
  }, [payload]);

  const centroids = useMemo<ClusterCentroid[]>(() => {
    if (!payload) return [];
    return payload.clusters.map((c) => ({
      id: c.cluster_id,
      cx: c.cx,
      cy: c.cy,
      cz: c.cz,
      // A loose radius from cluster size so fly-to frames are roughly cluster-shaped.
      radius: Math.max(3, Math.min(15, Math.cbrt(c.size) * 1.8)),
      label: c.label ?? `Cluster ${c.cluster_id}`,
    }));
  }, [payload]);

  const pickedPoint = pickedIndex != null && payload ? payload.points[pickedIndex] ?? null : null;

  if (fetchError) {
    return (
      <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        Failed to load project: {fetchError}
      </div>
    );
  }
  if (!payload || !pointsData) {
    return (
      <div className="flex h-[70vh] items-center justify-center rounded-lg border border-neutral-800 bg-neutral-950/40 text-sm text-neutral-400">
        Loading galaxy…
      </div>
    );
  }

  return (
    <div className="grid h-[78vh] grid-cols-[1fr_280px] gap-3">
      <div className="relative overflow-hidden rounded-lg border border-neutral-800 bg-black">
        <VectorScape
          ref={handleRef}
          points={pointsData}
          clusters={centroids}
          onClusterSelect={(id) => handleRef.current?.flyTo(id)}
          onPointPick={(index) => setPickedIndex(index >= 0 ? index : null)}
        />
        <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-black/50 px-2 py-1 text-xs text-neutral-300 backdrop-blur">
          {payload.project.name} · {payload.points.length.toLocaleString()} points ·{" "}
          {payload.clusters.length} clusters
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-black/50 px-2 py-1 text-[11px] text-neutral-400 backdrop-blur">
          Drag to orbit · scroll to zoom · click a cluster name to fly · click a point to inspect
        </div>
      </div>

      <aside className="flex flex-col gap-3 overflow-hidden">
        <section className="flex flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
          <header className="border-b border-neutral-900 px-3 py-2 text-xs uppercase tracking-wider text-neutral-400">
            Clusters
          </header>
          <ul className="flex-1 overflow-y-auto text-sm">
            <li>
              <button
                type="button"
                onClick={() => handleRef.current?.resetView()}
                className="block w-full px-3 py-2 text-left text-neutral-400 hover:bg-neutral-900/60"
              >
                ← reset view
              </button>
            </li>
            {centroids.map((c) => {
              const rgb = clusterColor(Number(c.id));
              return (
                <li key={String(c.id)}>
                  <button
                    type="button"
                    onClick={() => handleRef.current?.flyTo(c.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900/60"
                  >
                    <span
                      className="inline-block h-3 w-3 rounded-sm"
                      style={{
                        background: `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`,
                      }}
                    />
                    <span className="flex-1 truncate text-neutral-200">{c.label}</span>
                    <span className="text-xs text-neutral-500">
                      {payload.clusters.find((cl) => cl.cluster_id === c.id)?.size}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="flex max-h-[40%] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/40">
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
