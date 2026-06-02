"use client";

import {
  VectorScape,
  type FlythroughKeyframe,
  type ScenePose,
  type VectorScapeHandle,
} from "engine";
import { folder, LevaPanel, useControls, useCreateStore } from "leva";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clusterColor,
  loadProjectFromUrl,
  type LoadedProject,
} from "../sandbox/loadProject";

const DEMO_URL = "/demo/skm-galaxy.json";

/**
 * Single source of truth for the cinematic's opening pose. The Canvas opens
 * its camera here (via VectorScape `initialPose`) AND the flythrough holds
 * here for `INTRO_HOLD_MS` before the first dive — so the user sees the
 * galaxy from far for a beat with zero camera motion, no teleport jump, no
 * default-pose flash.
 */
const INTRO_START_POSE: ScenePose = {
  position: [0, 32, 130],
  target: [0, 0, 0],
};
const INTRO_HOLD_MS = 600;

/**
 * Hand-tuned cinematic path. The reducer normalizes coords so the longest
 * half-extent is COORD_SCALE=60, so anchor poses can be expressed in absolute
 * world units and still frame any baked galaxy sensibly.
 *
 * Reads as: first dive in from the wide opening pose → swing across the
 * galaxy → settle on the user's home pose. Total ~14.6s (plus INTRO_HOLD_MS
 * of held-still opener).
 */
const FLYTHROUGH: FlythroughKeyframe[] = [
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
  // Seed to true so the cinematic chrome (right rail, tune button, nav hint)
  // stays hidden from the very first paint of the loaded scene. Otherwise the
  // ~150ms gap between "data loaded" and "intro fires" lets those panels
  // render for one frame before the intro hides them — a visible flash.
  const [flythroughRunning, setFlythroughRunning] = useState(true);
  const [hqMode, setHqMode] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [constellationsOpen, setConstellationsOpen] = useState(false);
  const handleRef = useRef<VectorScapeHandle | null>(null);
  const startedRef = useRef(false);

  // Local Leva store. Routing useControls through this keeps Leva's global
  // store empty, which prevents `useControls` from auto-injecting a default
  // panel into document.body. That auto-inject fires inside a useEffect on
  // first mount, briefly painting a panel before our `<Leva hidden />` effect
  // tears it back down — the "tune box flash" symptom. With a local store,
  // the auto-inject path is never taken.
  const levaStore = useCreateStore();

  // Live tuning panel — same knobs the spike used, plus a couple extras for
  // the new HDR/bloom pipeline. Defaults match the spike's "good-looking
  // galaxy" preset (point size 2.2, fog 0.011, bloom 0.9 at threshold 0.35).
  // The panel itself is hidden until the side button flips controlsOpen.
  const ctrl = useControls(
    {
    "point size": { value: 3.0, min: 0.5, max: 8, step: 0.1 },
    fog: { value: 0.0, min: 0, max: 0.02, step: 0.0005 },
    "architectural mode": true,
    "ambient drift": true,
    sprite: folder(
      {
        "core sharpness": { value: 0.7, min: 0, max: 1, step: 0.01 },
        "halo strength": { value: 0.4, min: 0, max: 1.5, step: 0.01 },
      },
      { collapsed: true },
    ),
    effects: folder({
      bloom: true,
      "bloom amount": { value: 1.2, min: 0, max: 3, step: 0.05 },
      "bloom threshold": { value: 0.7, min: 0, max: 1, step: 0.01 },
      "depth of field": false,
      "min brightness": { value: 0.51, min: 0, max: 1, step: 0.01 },
    }),
    },
    { store: levaStore },
  );

  // Architectural mode = points recede so labeled structure takes over (per
  // the spike). Multiply size by the spike's 0.4 fade. Divide by 3.0 because
  // the panel's "point size" 3.0 is the new baseline (= sizeScale 1.0).
  const effectiveSizeScale =
    (ctrl["point size"] / 3.0) * (ctrl["architectural mode"] ? 0.4 : 1);

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

  // VectorScape calls this once after its camera controls are wired and the
  // initial pose is applied. Driving the cinematic from this callback (instead
  // of a setTimeout race against Canvas mount) means there's no window where
  // the camera sits at a default pose before the intro starts.
  const handleRendererReady = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const h = handleRef.current;
    if (!h) {
      // Imperative handle never wired — reveal the chrome instead of leaving
      // the user staring at a stripped UI forever.
      setFlythroughRunning(false);
      return;
    }
    void h
      .playFlythrough(FLYTHROUGH, { initialHoldMs: INTRO_HOLD_MS })
      .finally(() => setFlythroughRunning(false));
  }, []);

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
    // Same copy + styling as LensClient's dynamic-import fallback so the JS
    // chunk → JSON fetch handoff reads as one continuous splash, not two.
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-xs uppercase tracking-[0.2em] text-neutral-500">
        Booting galaxy…
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
        background="#000000"
        initialPose={INTRO_START_POSE}
        onReady={handleRendererReady}
        fogDensity={ctrl.fog}
        pointSizeScale={effectiveSizeScale}
        coreSharpness={ctrl["core sharpness"]}
        haloStrength={ctrl["halo strength"]}
        bloomEnabled={ctrl.bloom}
        bloomIntensity={ctrl["bloom amount"]}
        bloomThreshold={ctrl["bloom threshold"]}
        minBrightness={ctrl["min brightness"]}
        enableDOF={hqMode || ctrl["depth of field"]}
        enableAmbientDrift={ctrl["ambient drift"]}
        onClusterSelect={(id) => {
          handleRef.current?.cancelFlythrough();
          setFlythroughRunning(false);
          handleRef.current?.flyTo(id);
        }}
        onPointPick={(index) => setPickedIndex(index >= 0 ? index : null)}
      />

      {/*
        Live-tuning panel. We use LevaPanel (not <Leva />) bound to a local
        store so that:
          (a) Leva's global store stays empty, so useControls never triggers
              the document.body auto-inject path — no first-frame paint of a
              default panel.
          (b) The panel renders inline (no portal), so a parent React
              conditional cleanly gates whether any panel DOM exists at all.
        The wrapping div carries the panel's fixed position so it sits where
        the old `<Leva />` did. Drag is disabled since the wrapper owns
        positioning; users open/close via the side button.
      */}
      {controlsOpen && !flythroughRunning && (
        <div className="absolute right-14 top-6 z-50 w-[300px]">
          <LevaPanel
            store={levaStore}
            fill
            flat
            titleBar={{ title: "feel", filter: true, drag: false }}
            theme={{
              sizes: { rootWidth: "300px", controlWidth: "150px" },
            }}
          />
        </div>
      )}
      {!flythroughRunning && (
        <button
          type="button"
          onClick={() => setControlsOpen((v) => !v)}
          className={
            "absolute right-6 top-1/2 z-50 -translate-y-1/2 rounded-l-md border border-r-0 border-white/15 bg-black/50 px-2 py-3 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur-md transition " +
            (controlsOpen
              ? "border-amber-300/60 text-amber-200"
              : "text-neutral-300 hover:border-white/30 hover:text-neutral-100")
          }
          title="Adjust feel — point size, fog, bloom"
          style={{ writingMode: "vertical-rl" }}
        >
          {controlsOpen ? "close" : "tune feel"}
        </button>
      )}

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

      {/* Bottom-left toolbar: nav hints + HQ pill, with a home pill stacked
          above. Sit outside the right rail's footprint (absolute right-6
          top-6 bottom-6 w-72) so neither gets stacked under it. The wrapper
          is pointer-events-none so canvas drags pass through; each interactive
          child re-enables them on itself. Home stays visible during flythrough
          (always-available exit); the nav row only renders when not flying. */}
      <div className="pointer-events-none absolute bottom-6 left-6 flex flex-col items-start gap-2">
        <a
          href="/"
          className="pointer-events-auto rounded-full border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-300 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
        >
          ← home
        </a>
        {!flythroughRunning && (
        <div className="flex items-center gap-3">
          <div className="rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] text-neutral-400 backdrop-blur-md">
            drag · scroll · click point · click cluster
          </div>
          <a
            href="/lens/dataset"
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto rounded-full border border-white/10 bg-black/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-300 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
            title="Browse the source dataset the galaxy was built from"
          >
            dataset ↗
          </a>
          <button
            type="button"
            onClick={() => setHqMode((v) => !v)}
            className={
              "pointer-events-auto rounded-full border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur-md transition " +
              (hqMode
                ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
                : "border-white/10 bg-black/40 text-neutral-300 hover:border-white/25 hover:text-neutral-100")
            }
            title="Depth-of-field bokeh — best for screenshots and slow exploration"
          >
            {hqMode ? "HQ · on" : "HQ"}
          </button>
        </div>
        )}
      </div>

      {/* Right rail: clusters + selection. Hidden during intro for cinematic feel. */}
      {!flythroughRunning && (
        <aside className="absolute right-6 top-6 bottom-6 flex w-72 flex-col gap-3">
          <section className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/40 backdrop-blur-md">
            <header
              className={
                "px-3 py-2 " +
                (constellationsOpen ? "border-b border-white/5" : "")
              }
            >
              <button
                type="button"
                onClick={() => setConstellationsOpen((v) => !v)}
                className="group flex w-full items-center justify-between text-left text-[10px] uppercase tracking-[0.18em] text-neutral-400 transition hover:text-neutral-100"
                aria-expanded={constellationsOpen}
              >
                <span>Constellations</span>
                <span
                  className={
                    "flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-neutral-400 transition-all duration-200 group-hover:border-amber-300/60 group-hover:bg-amber-300/10 group-hover:text-amber-200 " +
                    (constellationsOpen ? "rotate-180" : "")
                  }
                  aria-hidden
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 3.5 L5 6.5 L8 3.5" />
                  </svg>
                </span>
              </button>
            </header>
            {constellationsOpen && (
            <ul className="scrollbar-subtle flex-1 overflow-y-auto text-sm">
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
            )}
          </section>

          <section className="flex max-h-[40%] flex-col overflow-hidden rounded-lg border border-white/10 bg-black/40 backdrop-blur-md">
            <header className="border-b border-white/5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
              Selection
            </header>
            <div className="scrollbar-subtle flex-1 overflow-y-auto px-3 py-2 text-sm">
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

    </div>
  );
}
