"use client";

import {
  VectorScape,
  type FlythroughKeyframe,
  type VectorScapeHandle,
} from "engine";
import { useEffect, useRef, useState } from "react";

import {
  clusterColor,
  loadProjectFromUrl,
  type LoadedProject,
} from "../sandbox/loadProject";

const DEMO_URL = "/demo/skm-galaxy.json";

/**
 * Hand-tuned cinematic path. The reducer normalizes coords so the longest
 * half-extent is COORD_SCALE=60, so anchor poses can be expressed in absolute
 * world units and still frame any baked galaxy sensibly.
 *
 * Reads as a distant approach → first dive → swing across → gentle pull back
 * to the user's home pose. Total ~15s.
 *
 * Start pose chosen so the galaxy is visible from frame 1: with fogDensity
 * 0.011, exp(-d² × z²) ≈ 0.17 at z=120 — dim distant nebula, not a black
 * screen. The previous z=240 sat at fog factor 0.001, which read as broken.
 */
const FLYTHROUGH: FlythroughKeyframe[] = [
  { position: [0, 32, 130], target: [0, 0, 0], smoothTime: 0.001, holdMs: 600 },
  { position: [50, 22, 100], target: [0, 0, 0], smoothTime: 3.0, holdMs: 400 },
  { position: [85, -10, 65], target: [10, -5, 0], smoothTime: 3.2, holdMs: 500 },
  { position: [15, -50, 80], target: [-25, 5, 15], smoothTime: 3.4, holdMs: 500 },
  { position: [-65, 25, 95], target: [-10, 0, -5], smoothTime: 3.4, holdMs: 400 },
  { position: [0, 0, 85], target: [0, 0, 0], smoothTime: 2.6 },
];

export default function LensViewer() {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  const [flythroughRunning, setFlythroughRunning] = useState(false);
  const [hqMode, setHqMode] = useState(false);
  const handleRef = useRef<VectorScapeHandle | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadProjectFromUrl(DEMO_URL)
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
  }, []);

  // Kick the intro once the renderer mount is live. handleRef is set by R3F
  // inside Canvas's first effect pass, so we wait one tick.
  useEffect(() => {
    if (!loaded || startedRef.current) return;
    startedRef.current = true;
    const t = window.setTimeout(() => {
      const h = handleRef.current;
      if (!h) return;
      setFlythroughRunning(true);
      void h.playFlythrough(FLYTHROUGH).finally(() => setFlythroughRunning(false));
    }, 150);
    return () => window.clearTimeout(t);
  }, [loaded]);

  const skip = () => {
    handleRef.current?.cancelFlythrough();
    void handleRef.current?.setLookAt([0, 0, 80], [0, 0, 0], true);
    setFlythroughRunning(false);
  };

  const pickedPoint =
    pickedIndex != null && loaded ? loaded.getPoint(pickedIndex) : null;

  if (fetchError) {
    return (
      <div className="m-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        Failed to load demo galaxy: {fetchError}
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-sm text-neutral-400">
        Loading galaxy…
      </div>
    );
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-neutral-100">
      <VectorScape
        ref={handleRef}
        points={loaded.pointsData}
        clusters={loaded.centroids}
        showClusterLabels
        enableDOF={hqMode}
        onClusterSelect={(id) => {
          handleRef.current?.cancelFlythrough();
          setFlythroughRunning(false);
          handleRef.current?.flyTo(id);
        }}
        onPointPick={(index) => setPickedIndex(index >= 0 ? index : null)}
      />

      {/* Top-left: title + meta. Translucent glass per design.md. */}
      <div className="pointer-events-none absolute left-6 top-6 max-w-xs rounded-lg border border-white/10 bg-black/40 px-4 py-3 backdrop-blur-md">
        <div className="font-display text-xs uppercase tracking-[0.18em] text-amber-200/90">
          SKM lens
        </div>
        <div className="mt-1 font-display text-lg leading-tight text-neutral-50">
          {loaded.project.name}
        </div>
        <div className="mt-1 font-mono text-[11px] text-neutral-400">
          {loaded.totalPoints.toLocaleString()} pts · {loaded.clusters.length} clusters
        </div>
      </div>

      {/* Flythrough skip — only while playing. */}
      {flythroughRunning && (
        <button
          type="button"
          onClick={skip}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/50 px-5 py-2 text-xs uppercase tracking-[0.18em] text-neutral-200 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
        >
          Skip intro
        </button>
      )}

      {/* Bottom-left: navigation hints, fade in after intro. */}
      {!flythroughRunning && (
        <div className="pointer-events-none absolute bottom-6 left-6 rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] text-neutral-400 backdrop-blur-md">
          drag · scroll · click point · click cluster
        </div>
      )}

      {/* HQ toggle — DOF + bokeh. Off by default (expensive). */}
      {!flythroughRunning && (
        <button
          type="button"
          onClick={() => setHqMode((v) => !v)}
          className={
            "absolute bottom-6 right-6 rounded-full border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur-md transition " +
            (hqMode
              ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
              : "border-white/10 bg-black/40 text-neutral-300 hover:border-white/25 hover:text-neutral-100")
          }
          title="Depth-of-field bokeh — best for screenshots and slow exploration"
        >
          {hqMode ? "HQ · on" : "HQ"}
        </button>
      )}

      {/* Right rail: clusters + selection. Hidden during intro for cinematic feel. */}
      {!flythroughRunning && (
        <aside className="absolute right-6 top-6 bottom-6 flex w-72 flex-col gap-3">
          <section className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/40 backdrop-blur-md">
            <header className="border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
              Constellations
            </header>
            <ul className="flex-1 overflow-y-auto text-sm">
              <li>
                <button
                  type="button"
                  onClick={() => handleRef.current?.resetView()}
                  className="block w-full px-3 py-2 text-left text-xs text-neutral-400 hover:bg-white/5"
                >
                  ← reset view
                </button>
              </li>
              {loaded.centroids.map((c) => {
                const rgb = clusterColor(Number(c.id));
                const size = loaded.clusters.find((cl) => cl.cluster_id === c.id)?.size;
                return (
                  <li key={String(c.id)}>
                    <button
                      type="button"
                      onClick={() => {
                        handleRef.current?.cancelFlythrough();
                        setFlythroughRunning(false);
                        handleRef.current?.flyTo(c.id);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/5"
                    >
                      <span
                        className="inline-block h-3 w-3 rounded-sm"
                        style={{
                          background: `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`,
                          boxShadow: `0 0 8px rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`,
                        }}
                      />
                      <span className="flex-1 truncate text-neutral-200">{c.label}</span>
                      <span className="font-mono text-[10px] text-neutral-500">{size}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="flex max-h-[40%] flex-col overflow-hidden rounded-lg border border-white/10 bg-black/40 backdrop-blur-md">
            <header className="border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
              Selection
            </header>
            <div className="flex-1 overflow-y-auto px-3 py-2 text-sm">
              {pickedPoint ? (
                <div className="space-y-2">
                  <div className="font-mono text-[10px] text-neutral-500">
                    {pickedPoint.cluster_id == null
                      ? "noise"
                      : `cluster ${pickedPoint.cluster_id}`}
                    {pickedPoint.cluster_probability != null &&
                      ` · p=${pickedPoint.cluster_probability.toFixed(2)}`}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-200">
                    {pickedPoint.text}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-neutral-500">
                  Click a star to read its document.
                </div>
              )}
            </div>
          </section>
        </aside>
      )}

      {/* Corner-of-screen exit. */}
      <a
        href="/"
        className="absolute left-6 bottom-6 hidden font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-500 hover:text-neutral-300 sm:block"
        style={{ left: "auto", right: "1.5rem", top: "1.5rem", bottom: "auto" }}
      >
        ← home
      </a>
    </div>
  );
}
