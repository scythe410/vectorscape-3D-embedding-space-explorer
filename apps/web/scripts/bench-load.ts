/**
 * Headless parse benchmark for the data endpoint's two wire formats.
 *
 * Generates N synthetic point rows, encodes them as
 *   (a) the JSON shape /api/projects/[id]/data emits below ARROW_THRESHOLD
 *   (b) the Arrow IPC bundle envelope it emits above the threshold
 * and measures the time the client spends turning each into the same
 * PointsData typed-array set the engine consumes.
 *
 * Main-thread parse is what we're optimizing — the "visible stall" the spec
 * calls out. The benchmark mirrors the real client codepath in loadProject.ts
 * (interleave xyz, fill color/size/probability from cluster ids), so the
 * numbers are directly comparable to what a user would feel.
 *
 * Run:  bun run apps/web/scripts/bench-load.ts [N]
 */

import { performance } from "node:perf_hooks";

import { tableFromArrays, tableFromIPC, tableToIPC, type Table } from "apache-arrow";

const N = Number(process.argv[2] ?? 100_000);

// ---- synthesize rows (the server's view: rows out of Supabase) -------------

type PointRow = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cluster_id: number | null;
  cluster_probability: number | null;
};

function makeRows(n: number): PointRow[] {
  const out = new Array<PointRow>(n);
  // ~12 clusters with a noise sprinkle. Realistic shape for a sandbox upload.
  for (let i = 0; i < n; i++) {
    const isNoise = Math.random() < 0.05;
    out[i] = {
      id: `id-${i.toString(36)}`,
      text: `synthetic sample row ${i} — bench text for parse cost`,
      x: (Math.random() - 0.5) * 60,
      y: (Math.random() - 0.5) * 60,
      z: (Math.random() - 0.5) * 60,
      cluster_id: isNoise ? null : i % 12,
      cluster_probability: isNoise ? null : 0.4 + Math.random() * 0.6,
    };
  }
  return out;
}

// ---- mirror the server encoders -------------------------------------------

function encodeJson(rows: PointRow[]): string {
  return JSON.stringify({
    project: { id: "bench", name: "bench", point_count: rows.length },
    points: rows,
    clusters: [],
  });
}

function encodeArrowBundle(rows: PointRow[]): Uint8Array {
  const n = rows.length;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  const cluster = new Int32Array(n);
  const prob = new Float32Array(n);
  const text = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    x[i] = rows[i].x;
    y[i] = rows[i].y;
    z[i] = rows[i].z;
    cluster[i] = rows[i].cluster_id ?? -1;
    prob[i] = rows[i].cluster_probability ?? Number.NaN;
    text[i] = rows[i].text;
  }
  const table = tableFromArrays({
    x,
    y,
    z,
    cluster_id: cluster,
    cluster_probability: prob,
    text,
  });
  const arrowBytes = tableToIPC(table, "stream");
  const meta = JSON.stringify({
    project: { id: "bench", name: "bench", point_count: n },
    clusters: [],
  });
  const metaBytes = new TextEncoder().encode(meta);
  const out = new Uint8Array(4 + metaBytes.byteLength + arrowBytes.byteLength);
  new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
  out.set(metaBytes, 4);
  out.set(arrowBytes, 4 + metaBytes.byteLength);
  return out;
}

// ---- mirror the client parsers (the main-thread work we care about) -------

const NOISE_COLOR: [number, number, number] = [0.35, 0.38, 0.45];
function clusterColor(cid: number): [number, number, number] {
  const h = (((cid * 0.61803398875) % 1) + 1) % 1;
  return hslToRgb(h, 0.65, 0.6);
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const xx = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, xx, 0];
  else if (hp < 2) [r, g, b] = [xx, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, xx];
  else if (hp < 4) [r, g, b] = [0, xx, c];
  else if (hp < 5) [r, g, b] = [xx, 0, c];
  else [r, g, b] = [c, 0, xx];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

function parseJson(jsonStr: string) {
  const t0 = performance.now();
  const tParseStart = performance.now();
  const payload = JSON.parse(jsonStr) as {
    points: PointRow[];
    clusters: unknown[];
  };
  const tParseEnd = performance.now();
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
  const total = performance.now() - t0;
  return { totalMs: total, jsonParseMs: tParseEnd - tParseStart, n };
}

function parseArrowBundle(buf: Uint8Array) {
  const t0 = performance.now();
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const view = new DataView(ab);
  const metaLen = view.getUint32(0, true);
  const metaStart = performance.now();
  JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 4, metaLen))); // meta
  const metaEnd = performance.now();
  const arrowBytes = new Uint8Array(ab, 4 + metaLen, ab.byteLength - 4 - metaLen);

  const tArrowStart = performance.now();
  const table = tableFromIPC(arrowBytes) as Table;
  const tArrowEnd = performance.now();

  const n = table.numRows;
  const xs = table.getChild("x")!.toArray() as Float32Array;
  const ys = table.getChild("y")!.toArray() as Float32Array;
  const zs = table.getChild("z")!.toArray() as Float32Array;
  const clusterIds = table.getChild("cluster_id")!.toArray() as Int32Array;
  const probs = table.getChild("cluster_probability")!.toArray() as Float32Array;

  const position = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const size = new Float32Array(n);
  const probability = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    position[i * 3] = xs[i];
    position[i * 3 + 1] = ys[i];
    position[i * 3 + 2] = zs[i];
    const cid = clusterIds[i];
    const rgb = cid < 0 ? NOISE_COLOR : clusterColor(cid);
    color[i * 3] = rgb[0];
    color[i * 3 + 1] = rgb[1];
    color[i * 3 + 2] = rgb[2];
    size[i] = 1.6;
    const pp = probs[i];
    probability[i] = Number.isNaN(pp) ? (cid < 0 ? 0.15 : 1) : pp;
  }
  const total = performance.now() - t0;
  return {
    totalMs: total,
    metaParseMs: metaEnd - metaStart,
    arrowDecodeMs: tArrowEnd - tArrowStart,
    n,
  };
}

// ---- run -------------------------------------------------------------------

const ROUNDS = 3;

console.log(`bench: N=${N.toLocaleString()} rows, rounds=${ROUNDS}`);

const rows = makeRows(N);
const jsonStr = encodeJson(rows);
const arrowBundle = encodeArrowBundle(rows);
console.log(
  `wire size: json=${(jsonStr.length / 1024 / 1024).toFixed(2)} MiB · ` +
    `arrow-bundle=${(arrowBundle.byteLength / 1024 / 1024).toFixed(2)} MiB`,
);

function bestOf<T extends { totalMs: number }>(fn: () => T): T {
  let best: T | null = null;
  for (let i = 0; i < ROUNDS; i++) {
    const r = fn();
    if (!best || r.totalMs < best.totalMs) best = r;
  }
  return best!;
}

const jsonResult = bestOf(() => parseJson(jsonStr));
const arrowResult = bestOf(() => parseArrowBundle(arrowBundle));

console.log("");
console.log(
  `JSON  → total ${jsonResult.totalMs.toFixed(1)}ms  ` +
    `(JSON.parse alone: ${jsonResult.jsonParseMs.toFixed(1)}ms)`,
);
console.log(
  `Arrow → total ${arrowResult.totalMs.toFixed(1)}ms  ` +
    `(tableFromIPC: ${arrowResult.arrowDecodeMs.toFixed(1)}ms, ` +
    `meta JSON: ${arrowResult.metaParseMs.toFixed(2)}ms)`,
);
console.log(
  `speedup: ${(jsonResult.totalMs / arrowResult.totalMs).toFixed(2)}× faster ` +
    `(${(jsonResult.totalMs - arrowResult.totalMs).toFixed(1)}ms saved on the main thread)`,
);
