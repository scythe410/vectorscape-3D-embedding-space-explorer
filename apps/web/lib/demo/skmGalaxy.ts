/**
 * Server-only loader for the SKM demo embeddings.
 *
 * The demo points live in `public/demo/skm-galaxy.json` (text + coords +
 * cluster ids). Their embeddings were pre-computed by the reducer and
 * shipped as a packed float32 binary at `lib/demo/skm-galaxy.embeddings.bin`.
 * This module memoizes both so cold-start work happens once per Node process.
 *
 * The binary lives outside `public/` so the client never downloads ~12 MB
 * of vectors — only the API route reads it.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const REPO_DIR = join(process.cwd());

const EMBED_BIN_PATH = join(REPO_DIR, "lib", "demo", "skm-galaxy.embeddings.bin");
const DEMO_JSON_PATH = join(REPO_DIR, "public", "demo", "skm-galaxy.json");

const MAGIC = "VSEM";

export type DemoPoint = {
  id: string;
  text: string;
  x: number;
  y: number;
  z: number;
  cluster_id: number | null;
};

export type DemoCluster = {
  cluster_id: number;
  label: string | null;
};

export type DemoBundle = {
  projectId: string;
  points: DemoPoint[];
  clusters: Map<number, DemoCluster>;
  embeddings: Float32Array; // length = points.length * dim, row-major
  dim: number;
  embedModel: string;
};

let cached: Promise<DemoBundle> | null = null;

/**
 * Returns the demo bundle (points + embeddings). Memoized: first call pays
 * the disk + parse cost; subsequent calls return the same Promise.
 */
export function loadDemoBundle(): Promise<DemoBundle> {
  if (!cached) cached = loadFromDisk();
  return cached;
}

async function loadFromDisk(): Promise<DemoBundle> {
  const [binBuf, jsonBuf] = await Promise.all([
    readFile(EMBED_BIN_PATH),
    readFile(DEMO_JSON_PATH, "utf8"),
  ]);

  // Header: 4-byte magic 'VSEM', uint32 LE count, uint32 LE dim, uint32 LE reserved.
  const magic = binBuf.subarray(0, 4).toString("latin1");
  if (magic !== MAGIC) {
    throw new Error(`bad demo embeddings header: got ${JSON.stringify(magic)}`);
  }
  const dv = new DataView(binBuf.buffer, binBuf.byteOffset, binBuf.byteLength);
  const count = dv.getUint32(4, true);
  const dim = dv.getUint32(8, true);
  const payloadStart = 16;
  const expectedBytes = count * dim * 4;
  if (binBuf.byteLength - payloadStart !== expectedBytes) {
    throw new Error(
      `demo embeddings size mismatch: header says ${count}×${dim} (${expectedBytes} bytes), file has ${binBuf.byteLength - payloadStart}`,
    );
  }
  // Copy into a fresh ArrayBuffer so the Float32Array isn't tied to Buffer's
  // pooled allocation (Node's Buffer sometimes shares the underlying array).
  const fresh = new ArrayBuffer(expectedBytes);
  new Uint8Array(fresh).set(binBuf.subarray(payloadStart));
  const embeddings = new Float32Array(fresh);

  const bundle = JSON.parse(jsonBuf) as {
    project: { id: string };
    points: DemoPoint[];
    clusters: Array<{ cluster_id: number; label: string | null }>;
  };
  if (bundle.points.length !== count) {
    throw new Error(
      `demo point/embedding count mismatch: ${bundle.points.length} points vs ${count} vectors`,
    );
  }

  const clusters = new Map<number, DemoCluster>();
  for (const c of bundle.clusters ?? []) {
    clusters.set(c.cluster_id, { cluster_id: c.cluster_id, label: c.label ?? null });
  }

  return {
    projectId: bundle.project.id,
    points: bundle.points,
    clusters,
    embeddings,
    dim,
    embedModel: "all-MiniLM-L6-v2",
  };
}
