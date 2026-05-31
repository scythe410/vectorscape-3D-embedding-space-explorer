// Synthetic clustered point cloud generator. Each cluster is a 3D gaussian
// blob; per-point membership probability shrinks with distance from the
// centroid (HDBSCAN-style). Outliers are sprinkled in with prob ~ 0.05.

import type { ClusterCentroid, PointsData } from "../src";

export interface SynthOptions {
  pointCount: number;
  clusterCount: number;
  noiseFraction: number;
  worldRadius: number;
  seed?: number;
}

export interface SynthResult {
  points: PointsData;
  clusters: ClusterCentroid[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (h % 360) / 60;
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

// Box-Muller for normal samples.
function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function synthesize(opts: SynthOptions): SynthResult {
  const { pointCount, clusterCount, noiseFraction, worldRadius } = opts;
  const rng = mulberry32(opts.seed ?? 42);

  const position = new Float32Array(pointCount * 3);
  const color = new Float32Array(pointCount * 3);
  const size = new Float32Array(pointCount);
  const probability = new Float32Array(pointCount);

  // Lay clusters out on a Fibonacci-ish sphere so they don't overlap.
  const clusters: ClusterCentroid[] = [];
  const clusterColors: [number, number, number][] = [];
  const clusterSigmas: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < clusterCount; i++) {
    const y = 1 - (i / Math.max(1, clusterCount - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const cx = Math.cos(theta) * r * worldRadius;
    const cz = Math.sin(theta) * r * worldRadius;
    const cy = y * worldRadius;
    const sigma = worldRadius * (0.06 + rng() * 0.05);
    const hue = (i / clusterCount) * 360;
    const rgb = hsl2rgb(hue, 0.85, 0.62);
    clusters.push({ id: i, cx, cy, cz, radius: sigma * 2.5, label: `cluster ${i}` });
    clusterColors.push(rgb);
    clusterSigmas.push(sigma);
  }

  const noiseCount = Math.floor(pointCount * noiseFraction);
  const memberCount = pointCount - noiseCount;
  const perCluster = Math.floor(memberCount / clusterCount);

  let w = 0;

  // Cluster members.
  for (let c = 0; c < clusterCount; c++) {
    const target = c === clusterCount - 1 ? memberCount - perCluster * c : perCluster;
    const { cx, cy, cz } = clusters[c];
    const sigma = clusterSigmas[c];
    const [r, g, b] = clusterColors[c];
    for (let k = 0; k < target; k++) {
      const dx = gauss(rng) * sigma;
      const dy = gauss(rng) * sigma;
      const dz = gauss(rng) * sigma;
      position[w * 3] = cx + dx;
      position[w * 3 + 1] = cy + dy;
      position[w * 3 + 2] = cz + dz;
      // Membership probability — high in the core, falling off with mahalanobis distance.
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / sigma;
      const prob = Math.max(0.1, Math.exp(-0.5 * d * d));
      probability[w] = prob;
      // HDR boost: drive cluster-core pixels above 1.0 so additive overlap
      // pushes into bloom range. Outside the core, b floors at ~0.55 — same
      // shape the spike used.
      const bcore = Math.min(1.7, Math.max(0.55, 1.7 - d));
      color[w * 3] = r * bcore;
      color[w * 3 + 1] = g * bcore;
      color[w * 3 + 2] = b * bcore;
      size[w] = 1.0 + rng() * 1.6;
      w++;
    }
  }

  // Noise / outliers — uniform sphere, very low probability so they read as fog.
  for (let i = 0; i < noiseCount; i++) {
    let nx = 0, ny = 0, nz = 0, d2 = 2;
    while (d2 > 1) {
      nx = rng() * 2 - 1;
      ny = rng() * 2 - 1;
      nz = rng() * 2 - 1;
      d2 = nx * nx + ny * ny + nz * nz;
    }
    const radius = worldRadius * (0.4 + rng() * 0.6);
    position[w * 3] = nx * radius;
    position[w * 3 + 1] = ny * radius;
    position[w * 3 + 2] = nz * radius;
    probability[w] = 0.04 + rng() * 0.08;
    // Cool pale color for outliers.
    color[w * 3] = 0.55;
    color[w * 3 + 1] = 0.7;
    color[w * 3 + 2] = 0.9;
    size[w] = 0.6 + rng() * 0.4;
    w++;
  }

  return {
    points: { position, color, size, probability },
    clusters,
  };
}
