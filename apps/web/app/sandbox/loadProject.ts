import { tableFromIPC, type Table } from "apache-arrow";
import type { ClusterCentroid, ClusterEdge, PointsData } from "engine";

import { unpackArrowBundle } from "../../lib/arrowBundle";

export type ProjectMeta = { id: string; name: string; point_count: number };

export type ClusterRow = {
  cluster_id: number;
  label: string | null;
  cx: number;
  cy: number;
  cz: number;
  size: number;
  medoid_point_id: string | null;
};

export type ClusterEdgeRow = {
  cluster_a: number;
  cluster_b: number;
  similarity: number;
};

/**
 * What the UI consumes regardless of wire format. `getPoint` is lazy on
 * purpose — the Arrow path decodes utf8 text on demand instead of materializing
 * 100k strings up front, which is the other half of the no-stall guarantee.
 */
export type LoadedProject = {
  project: ProjectMeta;
  pointsData: PointsData;
  centroids: ClusterCentroid[];
  clusters: ClusterRow[];
  /** Top semantic adjacencies between clusters, computed server-side in
   *  embedding space. Empty when the reducer hasn't run on the new pipeline
   *  yet, or when the project has fewer than two named clusters. */
  edges: ClusterEdge[];
  totalPoints: number;
  getPoint: (index: number) => {
    text: string;
    cluster_id: number | null;
    cluster_probability: number | null;
  };
  /** Map a server-side point UUID to its index in pointsData. Used by search
   *  to translate matched ids back into buffer indices for highlighting. */
  indexById: (id: string) => number | undefined;
  /** Tells the UI which path served the data (for the on-screen badge). */
  format: "json" | "arrow";
  /** ms spent in the parse + buffer-build step on the main thread. */
  parseMs: number;
};

const NOISE_COLOR: [number, number, number] = [0.35, 0.38, 0.45];

function clusterColor(clusterId: number): [number, number, number] {
  const h = (((clusterId * 0.61803398875) % 1) + 1) % 1;
  return hslToRgb(h, 0.65, 0.6);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0,
    g = 0,
    b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

export { clusterColor };

function buildCentroids(clusters: ClusterRow[]): ClusterCentroid[] {
  return clusters.map((c) => ({
    id: c.cluster_id,
    cx: c.cx,
    cy: c.cy,
    cz: c.cz,
    radius: Math.max(3, Math.min(15, Math.cbrt(c.size) * 1.8)),
    label: c.label ?? `Cluster ${c.cluster_id}`,
  }));
}

function buildEdges(rows: ClusterEdgeRow[] | undefined): ClusterEdge[] {
  if (!rows) return [];
  return rows.map((r) => ({
    a: r.cluster_a,
    b: r.cluster_b,
    similarity: r.similarity,
  }));
}

/**
 * Tight loops to fill the color / size / probability buffers. Runs on the
 * main thread; ~5ms for 350k points, ~1.5ms for 100k — well under one frame.
 */
function fillDerivedBuffers(
  n: number,
  clusterIdAt: (i: number) => number | null,
  probAt: (i: number) => number | null,
): { color: Float32Array; size: Float32Array; probability: Float32Array } {
  const color = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const probability = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cid = clusterIdAt(i);
    const rgb = cid == null ? NOISE_COLOR : clusterColor(cid);
    const p = probAt(i);
    const prob = p ?? (cid == null ? 0.15 : 1);
    // HDR core boost: drive confident cluster pixels above 1.0 so additive
    // overlap pushes into bloom range. Outliers floor at ~0.55, the same
    // shape the spike used.
    const bcore = 0.55 + prob * 1.15;
    color[i * 3] = rgb[0] * bcore;
    color[i * 3 + 1] = rgb[1] * bcore;
    color[i * 3 + 2] = rgb[2] * bcore;
    size[i] = 1.6;
    probability[i] = prob;
  }
  return { color, size, probability };
}

type JsonPointRow = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cluster_id: number | null;
  cluster_probability: number | null;
};

type JsonPayload = {
  project: ProjectMeta;
  points: JsonPointRow[];
  clusters: ClusterRow[];
  edges?: ClusterEdgeRow[];
};

function fromJson(payload: JsonPayload): LoadedProject {
  const t0 = performance.now();
  const n = payload.points.length;
  const position = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = payload.points[i];
    position[i * 3] = p.x;
    position[i * 3 + 1] = p.y;
    position[i * 3 + 2] = p.z;
  }
  const { color, size, probability } = fillDerivedBuffers(
    n,
    (i) => payload.points[i].cluster_id,
    (i) => payload.points[i].cluster_probability,
  );
  const idIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) idIndex.set(payload.points[i].id, i);
  const parseMs = performance.now() - t0;

  return {
    project: payload.project,
    pointsData: { position, color, size, probability },
    centroids: buildCentroids(payload.clusters),
    clusters: payload.clusters,
    edges: buildEdges(payload.edges),
    totalPoints: n,
    getPoint: (i) => {
      const p = payload.points[i];
      return {
        text: p.text,
        cluster_id: p.cluster_id,
        cluster_probability: p.cluster_probability,
      };
    },
    indexById: (id) => idIndex.get(id),
    format: "json",
    parseMs,
  };
}

type ArrowMeta = {
  project: ProjectMeta;
  clusters: ClusterRow[];
  edges?: ClusterEdgeRow[];
};

function fromArrowBundle(buf: ArrayBuffer): LoadedProject {
  const t0 = performance.now();
  const { meta, arrowBytes } = unpackArrowBundle<ArrowMeta>(buf);

  const table = tableFromIPC(arrowBytes) as Table;
  const n = table.numRows;

  // Direct typed-array views from Arrow vectors. Float32/Int32 columns expose
  // their backing buffers via `.toArray()` — zero-copy when the column is a
  // single chunk, an O(N) concat otherwise.
  const xs = table.getChild("x")!.toArray() as Float32Array;
  const ys = table.getChild("y")!.toArray() as Float32Array;
  const zs = table.getChild("z")!.toArray() as Float32Array;
  const clusterIds = table.getChild("cluster_id")!.toArray() as Int32Array;
  const probs = table.getChild("cluster_probability")!.toArray() as Float32Array;
  const textCol = table.getChild("text")!;
  const idCol = table.getChild("id");

  // Interleave xyz into a single position buffer for THREE.BufferAttribute.
  // This is the only mandatory copy; everything else stays as views.
  const position = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    position[i * 3] = xs[i];
    position[i * 3 + 1] = ys[i];
    position[i * 3 + 2] = zs[i];
  }
  const { color, size, probability } = fillDerivedBuffers(
    n,
    (i) => {
      const c = clusterIds[i];
      return c < 0 ? null : c;
    },
    (i) => {
      const p = probs[i];
      return Number.isNaN(p) ? null : p;
    },
  );
  // Build an id→index map lazily on first lookup. Decoding 350k UUID strings
  // up front would re-introduce the parse stall the Arrow path was built to
  // eliminate; pay the cost only when the user actually runs a search.
  let idIndex: Map<string, number> | null = null;
  const buildIdIndex = (): Map<string, number> => {
    const m = new Map<string, number>();
    if (idCol) {
      for (let i = 0; i < n; i++) m.set(String(idCol.get(i) ?? ""), i);
    }
    return m;
  };
  const parseMs = performance.now() - t0;

  return {
    project: meta.project,
    pointsData: { position, color, size, probability },
    centroids: buildCentroids(meta.clusters),
    clusters: meta.clusters,
    edges: buildEdges(meta.edges),
    totalPoints: n,
    getPoint: (i) => {
      const c = clusterIds[i];
      const p = probs[i];
      return {
        text: String(textCol.get(i) ?? ""),
        cluster_id: c < 0 ? null : c,
        cluster_probability: Number.isNaN(p) ? null : p,
      };
    },
    indexById: (id) => {
      if (idIndex === null) idIndex = buildIdIndex();
      return idIndex.get(id);
    },
    format: "arrow",
    parseMs,
  };
}

export async function loadProject(projectId: string): Promise<LoadedProject> {
  return loadFromUrl(`/api/projects/${projectId}/data`, { cache: "no-store" });
}

/** Load a pre-baked galaxy from a static asset URL (no auth, no DB). */
export async function loadProjectFromUrl(
  url: string,
  init?: RequestInit,
): Promise<LoadedProject> {
  return loadFromUrl(url, init);
}

async function loadFromUrl(url: string, init?: RequestInit): Promise<LoadedProject> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  const ct = r.headers.get("content-type") ?? "";
  if (ct.includes("vs-arrow-bundle")) {
    const buf = await r.arrayBuffer();
    return fromArrowBundle(buf);
  }
  const json = (await r.json()) as JsonPayload;
  return fromJson(json);
}
