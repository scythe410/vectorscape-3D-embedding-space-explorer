"use client";

import {
  VectorScape,
  type FlythroughKeyframe,
  type PointsData,
  type ScenePose,
  type VectorScapeHandle,
} from "engine";
import { folder, LevaPanel, useControls, useCreateStore } from "leva";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type SearchResult } from "../sandbox/SearchPanel";
import { clusterColor, type LoadedProject } from "../sandbox/loadProject";
import type { ProximityCentroid } from "../../lib/proximity";
import ProximityReadout, { useTrackedCamera } from "./ProximityReadout";
import RegionTitleCard from "./RegionTitleCard";

// Mirrors SandboxViewer's search-dim constants — matches keep full alpha and
// color, misses fade to dust and stop contributing to bloom.
const SEARCH_HIT_PROB = 1.0;
const SEARCH_MISS_PROB = 0.15;
const SEARCH_MISS_COLOR_SCALE = 0.16;
const SEARCH_MIN_BRIGHTNESS = 0;

/**
 * The cinematic galaxy frame — title card → flythrough → live galaxy with
 * tune-feel panel, constellations rail, selection panel, proximity readout,
 * HQ pill, home pill. Used by:
 *   - /lens: the static SKM demo (eyebrow "SKM lens", "Skip intro" pill)
 *   - /sandbox/[id]/cinematic: a user's project in the same frame
 *     (eyebrow "Sandbox · cinematic", "Explore" pill)
 *
 * Data loading lives in the route wrapper; this component is purely the
 * presentation + interaction layer parameterized by a few labels.
 */

/** Single source of truth for the cinematic's opening pose. */
const INTRO_START_POSE: ScenePose = {
  position: [0, 32, 130],
  target: [0, 0, 0],
};
const INTRO_HOLD_MS = 600;

const FLYTHROUGH: FlythroughKeyframe[] = [
  { position: [50, 22, 100], target: [0, 0, 0], smoothTime: 3.0, holdMs: 400 },
  { position: [85, -10, 65], target: [10, -5, 0], smoothTime: 3.2, holdMs: 500 },
  { position: [15, -50, 80], target: [-25, 5, 15], smoothTime: 3.4, holdMs: 500 },
  { position: [-65, 25, 95], target: [-10, 0, -5], smoothTime: 3.4, holdMs: 400 },
  { position: [0, 0, 85], target: [0, 0, 0], smoothTime: 2.6 },
];

interface Props {
  loaded: LoadedProject;
  /** Title-card sessionStorage key — "lens-skm", "sandbox-cinematic-<id>", etc. */
  scope: string;
  /** Small amber eyebrow over the project name in the top-left panel. */
  eyebrow: string;
  /** Pill text shown during the flythrough — clicking it cancels the dive
   *  and snaps to the home pose. "Skip intro" on lens, "Explore" on sandbox. */
  enterLabel: string;
  /** Destination of the "← home" pill (bottom-left). */
  homeHref: string;
  /** Lens-only: surfaces a "dataset ↗" link to /lens/dataset in the bottom
   *  toolbar. Defaults to false. */
  showDatasetLink?: boolean;
  /** Enables the semantic search dropdown when set. Sandbox passes
   *  `/api/projects/${id}/search` (auth'd, RLS-scoped). Lens demo passes
   *  `/api/demo/search` (unauthenticated, pre-baked embeddings). When
   *  undefined, the panel is hidden entirely. */
  searchUrl?: string;
}

export default function CinematicGalaxy({
  loaded,
  scope,
  eyebrow,
  enterLabel,
  homeHref,
  showDatasetLink = false,
  searchUrl,
}: Props) {
  const [pickedIndex, setPickedIndex] = useState<number | null>(null);
  // Seed `flythroughRunning` to true so the cinematic chrome stays hidden
  // from the very first paint — otherwise the gap between data-load and
  // intro-fire would flash the panels for one frame.
  const [flythroughRunning, setFlythroughRunning] = useState(true);
  const [hqMode, setHqMode] = useState(false);
  const [edgesEnabled, setEdgesEnabled] = useState(false);
  const [hoveredEdge, setHoveredEdge] = useState<{ a: number; b: number } | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [constellationsOpen, setConstellationsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSubmitting, setSearchSubmitting] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>();
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [rendererReady, setRendererReady] = useState(false);
  const [titleCardDone, setTitleCardDone] = useState(false);
  const handleRef = useRef<VectorScapeHandle | null>(null);
  const startedRef = useRef(false);
  const searchReqIdRef = useRef(0);
  const { cameraPos, onCameraMove } = useTrackedCamera(120);

  const proximityCentroids: ProximityCentroid[] = useMemo(
    () =>
      loaded.centroids.map((c) => ({
        id: c.id,
        label: c.label ?? `Cluster ${c.id}`,
        cx: c.cx,
        cy: c.cy,
        cz: c.cz,
      })),
    [loaded.centroids],
  );

  // Local Leva store — keeps Leva's global store empty so useControls
  // doesn't auto-inject a default panel into document.body (causes a
  // first-frame flash before our <Leva hidden /> tears it down).
  const levaStore = useCreateStore();
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

  // Architectural mode = points recede so labeled structure takes over.
  const effectiveSizeScale =
    (ctrl["point size"] / 3.0) * (ctrl["architectural mode"] ? 0.4 : 1);

  // Search-aware override: misses fade to dust + dim color so cluster cores
  // stop firing bloom; matches keep full color/alpha. Mirrors SandboxViewer.
  const searchOverride = useMemo(() => {
    if (!searchResult || searchResult.matches.length === 0) return null;
    const matchIndices: number[] = [];
    const matchSet = new Set<number>();
    for (const m of searchResult.matches) {
      const idx = loaded.indexById(m.id);
      if (idx != null && !matchSet.has(idx)) {
        matchSet.add(idx);
        matchIndices.push(idx);
      }
    }
    if (matchIndices.length === 0) return null;
    const n = loaded.totalPoints;
    const probability = new Float32Array(n);
    const color = new Float32Array(n * 3);
    const srcColor = loaded.pointsData.color;
    for (let i = 0; i < n; i++) {
      const hit = matchSet.has(i);
      probability[i] = hit ? SEARCH_HIT_PROB : SEARCH_MISS_PROB;
      const s = hit ? 1.0 : SEARCH_MISS_COLOR_SCALE;
      color[i * 3] = srcColor[i * 3] * s;
      color[i * 3 + 1] = srcColor[i * 3 + 1] * s;
      color[i * 3 + 2] = srcColor[i * 3 + 2] * s;
    }
    return {
      probability,
      color,
      mustKeep: Uint32Array.from(matchIndices),
    };
  }, [loaded, searchResult]);

  const displayPointsData: PointsData = useMemo(() => {
    if (!searchOverride) return loaded.pointsData;
    return {
      position: loaded.pointsData.position,
      color: searchOverride.color,
      size: loaded.pointsData.size,
      probability: searchOverride.probability,
    };
  }, [loaded, searchOverride]);

  const flyToSearchResults = useCallback(
    (result: SearchResult) => {
      if (result.matches.length === 0) return;
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
      handleRef.current?.cancelFlythrough();
      setFlythroughRunning(false);
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

  const runSearch = useCallback(
    async (q: string) => {
      if (!searchUrl) return;
      const trimmed = q.trim();
      if (!trimmed) return;
      const myReq = ++searchReqIdRef.current;
      setSearchSubmitting(true);
      setSearchError(undefined);
      try {
        const resp = await fetch(searchUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmed }),
          cache: "no-store",
        });
        const text = await resp.text();
        if (myReq !== searchReqIdRef.current) return;
        if (!resp.ok) {
          let msg = `search failed (${resp.status})`;
          try {
            const j = JSON.parse(text);
            if (j?.error) msg = j.error;
          } catch {
            if (text) msg = text.slice(0, 300);
          }
          setSearchError(msg);
          return;
        }
        const json = JSON.parse(text) as Partial<SearchResult>;
        const result: SearchResult = {
          query: json.query ?? trimmed,
          embed_model: json.embed_model ?? "",
          matches: Array.isArray(json.matches) ? json.matches : [],
          regions: Array.isArray(json.regions) ? json.regions : [],
          labels_are_real: json.labels_are_real === true,
          summary: typeof json.summary === "string" ? json.summary : "",
        };
        setSearchResult(result);
        if (result.matches.length > 0) flyToSearchResults(result);
      } catch (e) {
        if (myReq !== searchReqIdRef.current) return;
        setSearchError(
          e instanceof Error ? e.message : "network error contacting search",
        );
      } finally {
        if (myReq === searchReqIdRef.current) setSearchSubmitting(false);
      }
    },
    [searchUrl, flyToSearchResults],
  );

  const clearSearch = useCallback(() => {
    searchReqIdRef.current += 1;
    setSearchQuery("");
    setSearchError(undefined);
    setSearchResult(null);
  }, []);

  const handleRendererReady = useCallback(() => {
    setRendererReady(true);
  }, []);

  useEffect(() => {
    if (!rendererReady || !titleCardDone) return;
    if (startedRef.current) return;
    startedRef.current = true;
    const h = handleRef.current;
    if (!h) {
      setFlythroughRunning(false);
      return;
    }
    void h
      .playFlythrough(FLYTHROUGH, { initialHoldMs: INTRO_HOLD_MS })
      .finally(() => setFlythroughRunning(false));
  }, [rendererReady, titleCardDone]);

  const skip = () => {
    handleRef.current?.cancelFlythrough();
    void handleRef.current?.setLookAt([0, 0, 80], [0, 0, 0], true);
    setFlythroughRunning(false);
  };

  const pickedPoint =
    pickedIndex != null ? loaded.getPoint(pickedIndex) : null;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black text-neutral-100">
      <VectorScape
        ref={handleRef}
        points={displayPointsData}
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
        minBrightness={
          searchOverride ? SEARCH_MIN_BRIGHTNESS : ctrl["min brightness"]
        }
        mustKeepIndices={searchOverride?.mustKeep ?? null}
        enableDOF={hqMode || ctrl["depth of field"]}
        enableAmbientDrift={ctrl["ambient drift"]}
        onClusterSelect={(id) => {
          handleRef.current?.cancelFlythrough();
          setFlythroughRunning(false);
          handleRef.current?.flyTo(id);
        }}
        onPointPick={(index) => setPickedIndex(index >= 0 ? index : null)}
        onCameraMove={onCameraMove}
        edges={edgesEnabled ? loaded.edges : undefined}
        onEdgeHover={setHoveredEdge}
        onEdgeClick={(e) => {
          setHoveredEdge(null);
          handleRef.current?.cancelFlythrough();
          setFlythroughRunning(false);
          handleRef.current?.flyTo(e.a);
        }}
      />

      {!flythroughRunning && (
        <ProximityReadout
          cameraPos={cameraPos}
          centroids={proximityCentroids}
          position="bottom-center"
        />
      )}

      <RegionTitleCard
        clusters={loaded.clusters}
        scope={scope}
        title={loaded.project.name}
        subtitle={`${loaded.totalPoints.toLocaleString()} documents · ${loaded.clusters.length} regions`}
        topN={8}
        onComplete={() => setTitleCardDone(true)}
      />

      {controlsOpen && !flythroughRunning && (
        <div className="vs-tune-panel absolute bottom-6 right-[19.5rem] z-50 w-[300px] overflow-hidden rounded-lg">
          <LevaPanel
            store={levaStore}
            fill
            flat
            titleBar={{ title: "feel", filter: false, drag: false }}
            theme={{
              colors: {
                elevation1: "rgba(0,0,0,0)",
                elevation2: "rgba(0,0,0,0)",
                elevation3: "rgba(255,255,255,0.03)",
                accent1: "#fcd34d",
                accent2: "#fbbf24",
                accent3: "#f59e0b",
                highlight1: "rgba(255,255,255,0.45)",
                highlight2: "rgba(252,211,77,0.85)",
                highlight3: "#fde68a",
                vivid1: "#fcd34d",
                folderWidgetColor: "rgba(252,211,77,0.75)",
                folderTextColor: "rgba(253,230,138,0.95)",
                toolTipBackground: "rgba(0,0,0,0.85)",
                toolTipText: "#fde68a",
              },
              fonts: {
                mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
                sans: "ui-sans-serif, system-ui, sans-serif",
              },
              fontSizes: {
                root: "11px",
                toolTip: "11px",
              },
              sizes: {
                rootWidth: "300px",
                controlWidth: "150px",
                titleBarHeight: "36px",
                rowHeight: "28px",
                checkboxSize: "16px",
                scrubberWidth: "10px",
                scrubberHeight: "14px",
              },
              radii: {
                xs: "2px",
                sm: "9999px",
                lg: "8px",
              },
              space: {
                sm: "6px",
                md: "10px",
                rowGap: "8px",
                colGap: "8px",
              },
              shadows: {
                level1: "0 0 0 1px rgba(252,211,77,0.18)",
                level2: "0 0 8px rgba(252,211,77,0.35)",
              },
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

      {/* Top-left: title + meta. */}
      <div className="pointer-events-none absolute left-6 top-6 max-w-xs rounded-lg border border-white/10 bg-black/40 px-4 py-3 backdrop-blur-md">
        <div className="font-display text-xs uppercase tracking-[0.18em] text-amber-200/90">
          {eyebrow}
        </div>
        <div className="mt-1 font-display text-lg leading-tight text-neutral-50">
          {loaded.project.name}
        </div>
        <div className="mt-1 font-mono text-[11px] text-neutral-400">
          {loaded.totalPoints.toLocaleString()} pts · {loaded.clusters.length} clusters
        </div>
      </div>

      {/* Flythrough enter/skip pill — only while playing. */}
      {flythroughRunning && (
        <button
          type="button"
          onClick={skip}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/50 px-6 py-2 text-xs uppercase tracking-[0.22em] text-neutral-200 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
        >
          {enterLabel}
        </button>
      )}

      {/* Bottom-left toolbar. */}
      <div className="pointer-events-none absolute bottom-6 left-6 flex flex-col items-start gap-2">
        <div className="flex items-center gap-2">
          <a
            href={homeHref}
            className="pointer-events-auto rounded-full border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-300 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
          >
            ← home
          </a>
          {!flythroughRunning && loaded.edges.length > 0 && (
            <button
              type="button"
              onClick={() => setEdgesEnabled((v) => !v)}
              className={
                "pointer-events-auto rounded-full border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] backdrop-blur-md transition " +
                (edgesEnabled
                  ? "border-amber-300/60 bg-amber-300/10 text-amber-200"
                  : "border-white/10 bg-black/40 text-neutral-300 hover:border-white/25 hover:text-neutral-100")
              }
              title="Faint lines between the most semantically-similar cluster pairs (computed in embedding space). Hover a line to preview, click to fly there."
            >
              {edgesEnabled ? `links · ${loaded.edges.length}` : "links"}
            </button>
          )}
        </div>
        {!flythroughRunning && (
          <div className="flex items-center gap-3">
            <div className="rounded-md border border-white/10 bg-black/40 px-3 py-2 font-mono text-[11px] text-neutral-400 backdrop-blur-md">
              drag · scroll · click point · click cluster
            </div>
            {showDatasetLink && (
              <a
                href="/lens/dataset"
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto rounded-full border border-white/10 bg-black/40 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-300 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
                title="Browse the source dataset the galaxy was built from"
              >
                dataset ↗
              </a>
            )}
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

      {/* Hover-only edge label. Only mounted when an edge is actively
          hovered AND edges are on; otherwise edges read as pure shape. */}
      {edgesEnabled && hoveredEdge && (
        <div className="pointer-events-none absolute left-1/2 top-6 -translate-x-1/2 rounded-full border border-amber-300/40 bg-black/60 px-4 py-1.5 backdrop-blur-md">
          <div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-amber-200/90">
            <span className="text-neutral-200">
              {loaded.centroids.find((c) => Number(c.id) === hoveredEdge.a)?.label ??
                `Cluster ${hoveredEdge.a}`}
            </span>
            <span className="text-neutral-500">↔</span>
            <span className="text-neutral-200">
              {loaded.centroids.find((c) => Number(c.id) === hoveredEdge.b)?.label ??
                `Cluster ${hoveredEdge.b}`}
            </span>
            <span className="ml-1 text-[9px] text-neutral-500">click to fly</span>
          </div>
        </div>
      )}

      {/* Right rail: constellations + selection. Hidden during intro. */}
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
                  const size = loaded.clusters.find(
                    (cl) => cl.cluster_id === c.id,
                  )?.size;
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
                        <span className="flex-1 truncate text-neutral-200">
                          {c.label}
                        </span>
                        <span className="font-mono text-[10px] text-neutral-500">
                          {size}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {searchUrl && (
            <section className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/40 backdrop-blur-md">
              <header
                className={
                  "px-3 py-2 " + (searchOpen ? "border-b border-white/5" : "")
                }
              >
                <button
                  type="button"
                  onClick={() => setSearchOpen((v) => !v)}
                  className="group flex w-full items-center justify-between text-left text-[10px] uppercase tracking-[0.18em] text-neutral-400 transition hover:text-neutral-100"
                  aria-expanded={searchOpen}
                >
                  <span className="flex items-center gap-2">
                    <span>Search</span>
                    {searchResult && (
                      <span className="font-mono text-[10px] normal-case tracking-normal text-neutral-500">
                        {searchResult.matches.length} match
                        {searchResult.matches.length === 1 ? "" : "es"}
                      </span>
                    )}
                  </span>
                  <span
                    className={
                      "flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-neutral-400 transition-all duration-200 group-hover:border-amber-300/60 group-hover:bg-amber-300/10 group-hover:text-amber-200 " +
                      (searchOpen ? "rotate-180" : "")
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
              {searchOpen && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runSearch(searchQuery);
                  }}
                  className="flex flex-col gap-2 px-3 py-2"
                >
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="describe what you're looking for…"
                      className="flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-amber-300/60 focus:outline-none"
                      disabled={searchSubmitting}
                    />
                    <button
                      type="submit"
                      disabled={searchSubmitting || !searchQuery.trim()}
                      className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-neutral-200 hover:border-amber-300/60 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {searchSubmitting ? "…" : "find"}
                    </button>
                    {(searchResult || searchQuery) && !searchSubmitting && (
                      <button
                        type="button"
                        onClick={clearSearch}
                        className="rounded-md border border-transparent px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300"
                        title="Clear search and restore normal brightness"
                      >
                        clear
                      </button>
                    )}
                  </div>
                  {searchError && (
                    <div className="rounded-md border border-red-900/60 bg-red-950/40 px-2 py-1 text-xs text-red-200">
                      {searchError}
                    </div>
                  )}
                  {searchResult &&
                    !searchError &&
                    searchResult.matches.length === 0 && (
                      <div className="text-xs text-neutral-500">
                        No points matched “{searchResult.query}”. Try a different
                        phrasing.
                      </div>
                    )}
                  {searchResult &&
                    searchResult.matches.length > 0 &&
                    searchResult.labels_are_real &&
                    searchResult.regions.length > 0 && (
                      <div className="space-y-1.5 rounded-md border border-amber-900/30 bg-amber-950/10 px-2 py-1.5">
                        {searchResult.summary && (
                          <div className="text-xs leading-snug text-amber-100/90">
                            {searchResult.summary}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1">
                          {searchResult.regions.map((r) => (
                            <button
                              key={r.cluster_id}
                              type="button"
                              onClick={() => {
                                handleRef.current?.cancelFlythrough();
                                setFlythroughRunning(false);
                                handleRef.current?.flyTo(r.cluster_id);
                              }}
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
                  {searchResult && searchResult.matches.length > 0 && (
                    <div className="text-[10px] text-neutral-500">
                      highlighting nearest {searchResult.matches.length} ·
                      embed_model{" "}
                      <span className="font-mono">{searchResult.embed_model}</span>
                    </div>
                  )}
                </form>
              )}
            </section>
          )}

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
