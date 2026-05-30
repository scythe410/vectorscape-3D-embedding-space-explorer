import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { VectorScape, type RenderStats, type VectorScapeHandle } from "../src";
import { synthesize } from "./synth";

const PRESETS = [
  { label: "10k", n: 10_000 },
  { label: "100k", n: 100_000 },
  { label: "350k (budget)", n: 350_000 },
  { label: "1M (downsample test)", n: 1_000_000 },
];

function Demo() {
  const [pointCount, setPointCount] = useState(100_000);
  const [clusterCount] = useState(14);
  const [stats, setStats] = useState<RenderStats | null>(null);
  const handleRef = useRef<VectorScapeHandle>(null);

  const data = useMemo(
    () =>
      synthesize({
        pointCount,
        clusterCount,
        noiseFraction: 0.18,
        worldRadius: 26,
        seed: 7,
      }),
    [pointCount, clusterCount],
  );

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh" }}>
      <VectorScape
        ref={handleRef}
        points={data.points}
        clusters={data.clusters}
        onStats={setStats}
        onClusterSelect={(id) => handleRef.current?.flyTo(id)}
      />

      <Overlay
        pointCount={pointCount}
        setPointCount={setPointCount}
        stats={stats}
        clusters={data.clusters}
        onFlyTo={(id) => handleRef.current?.flyTo(id)}
        onReset={() => handleRef.current?.resetView()}
      />
    </div>
  );
}

function Overlay({
  pointCount,
  setPointCount,
  stats,
  clusters,
  onFlyTo,
  onReset,
}: {
  pointCount: number;
  setPointCount: (n: number) => void;
  stats: RenderStats | null;
  clusters: { id: string | number; label?: string }[];
  onFlyTo: (id: string | number) => void;
  onReset: () => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 16,
        left: 16,
        padding: "12px 14px",
        background: "rgba(10, 12, 18, 0.7)",
        backdropFilter: "blur(8px)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 10,
        font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        color: "#e8ecf2",
        maxWidth: 280,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>VectorScape engine demo</div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {PRESETS.map((p) => (
          <button
            key={p.n}
            onClick={() => setPointCount(p.n)}
            style={btnStyle(p.n === pointCount)}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div style={{ opacity: 0.8 }}>
        total {stats?.total.toLocaleString() ?? "—"}
        {" · "}
        rendered {stats?.kept.toLocaleString() ?? "—"}
        {stats?.downsampled ? " (voxel)" : ""}
      </div>

      <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "10px 0" }} />

      <div style={{ marginBottom: 6, opacity: 0.8 }}>fly to cluster</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {clusters.slice(0, 10).map((c) => (
          <button key={String(c.id)} onClick={() => onFlyTo(c.id)} style={btnStyle(false)}>
            {c.label ?? String(c.id)}
          </button>
        ))}
        <button onClick={onReset} style={{ ...btnStyle(false), opacity: 0.7 }}>
          reset
        </button>
      </div>

      <div style={{ marginTop: 10, opacity: 0.55, fontSize: 11 }}>
        click any cluster (invisible target) in the scene to fly to it. drag to orbit, scroll to zoom.
      </div>
    </div>
  );
}

function btnStyle(active: boolean): React.CSSProperties {
  return {
    background: active ? "rgba(120, 180, 255, 0.18)" : "rgba(255,255,255,0.04)",
    border: `1px solid ${active ? "rgba(120,180,255,0.5)" : "rgba(255,255,255,0.1)"}`,
    color: "#e8ecf2",
    padding: "4px 8px",
    borderRadius: 6,
    cursor: "pointer",
    font: "inherit",
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
