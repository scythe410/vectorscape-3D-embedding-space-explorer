import { describe, expect, it } from "bun:test";

import { voxelDownsample } from "./voxelDownsample";

// Helpers — build Float32Array position buffers without a lot of setup noise.

function positions(coords: Array<[number, number, number]>): Float32Array {
  const out = new Float32Array(coords.length * 3);
  for (let i = 0; i < coords.length; i++) {
    out[i * 3] = coords[i][0];
    out[i * 3 + 1] = coords[i][1];
    out[i * 3 + 2] = coords[i][2];
  }
  return out;
}

/** Uniform grid of N×N×N points filling a 100³ box. Realistic 3D cloud. */
function uniformGrid(side: number): Float32Array {
  const n = side * side * side;
  const out = new Float32Array(n * 3);
  let w = 0;
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) {
      for (let z = 0; z < side; z++) {
        out[w++] = x;
        out[w++] = y;
        out[w++] = z;
      }
    }
  }
  return out;
}

/** Tight gaussian-ish blob — clustered near origin within a 2-unit ball. */
function densePoints(n: number, seed = 1): Float32Array {
  let s = seed;
  const rng = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = (rng() - 0.5) * 2;
    out[i * 3 + 1] = (rng() - 0.5) * 2;
    out[i * 3 + 2] = (rng() - 0.5) * 2;
  }
  return out;
}

describe("voxelDownsample", () => {
  it("returns every index when input is at or below budget (sparse)", () => {
    const pos = positions([
      [0, 0, 0],
      [1, 1, 1],
      [2, 2, 2],
    ]);
    const res = voxelDownsample(pos, 10);
    expect(res.downsampled).toBe(false);
    expect(res.kept.length).toBe(3);
    expect(Array.from(res.kept)).toEqual([0, 1, 2]);
    expect(res.cellsPerAxis).toBe(0); // sentinel for the trivial path
  });

  it("downsamples a uniform grid that exceeds budget and stays under 1.15x budget", () => {
    // 30³ = 27_000 points, budget 5_000.
    const pos = uniformGrid(30);
    const budget = 5_000;
    const res = voxelDownsample(pos, budget);
    expect(res.downsampled).toBe(true);
    // The implementation aims at budget but caps overflow at 1.15× by
    // shrinking the grid. Make sure it actually landed within bounds.
    expect(res.kept.length).toBeLessThanOrEqual(budget * 1.15);
    // And dropped *at least some* points (not a degenerate full-return).
    expect(res.kept.length).toBeLessThan(27_000);
    // Indices are unique.
    expect(new Set(res.kept).size).toBe(res.kept.length);
    // Indices are in range.
    for (const idx of res.kept) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(27_000);
    }
    expect(res.cellsPerAxis).toBeGreaterThan(1);
  });

  it("handles ultra-dense (tightly-clustered) data without freezing or returning empty", () => {
    // 50k points stuffed into a 2-unit ball. The fill ratio is way off the
    // default 0.25 — the retarget heuristic has to do real work here.
    const pos = densePoints(50_000);
    const budget = 5_000;
    const res = voxelDownsample(pos, budget);
    expect(res.downsampled).toBe(true);
    expect(res.kept.length).toBeGreaterThan(0);
    expect(res.kept.length).toBeLessThanOrEqual(budget * 1.15);
    expect(new Set(res.kept).size).toBe(res.kept.length);
  });

  it("handles a flat plane (zero variance on one axis) without divide-by-zero", () => {
    // All points share z=5 → extent on Z is 0 before the eps pad.
    const coords: Array<[number, number, number]> = [];
    for (let i = 0; i < 1000; i++) {
      coords.push([i % 30, Math.floor(i / 30), 5]);
    }
    const pos = positions(coords);
    const res = voxelDownsample(pos, 200);
    expect(res.downsampled).toBe(true);
    expect(res.kept.length).toBeGreaterThan(0);
    expect(res.kept.length).toBeLessThanOrEqual(200 * 1.15);
    expect(new Set(res.kept).size).toBe(res.kept.length);
  });

  it("handles a degenerate single-point-repeated cloud (all identical coords)", () => {
    // All 1000 points at the origin. Bounding box has zero extent on every
    // axis. Without the eps pad the math divides by zero and every point
    // hashes to the same cell.
    const coords: Array<[number, number, number]> = Array.from({ length: 1000 }, () => [
      0,
      0,
      0,
    ]);
    const pos = positions(coords);
    const res = voxelDownsample(pos, 200);
    expect(res.downsampled).toBe(true);
    // All points share one cell, so we expect exactly one kept index (the
    // first arrival). The function is allowed to fall back to "first
    // `budget` points" but for this hard-degenerate input the natural
    // result is 1.
    expect(res.kept.length).toBeGreaterThanOrEqual(1);
    expect(res.kept.length).toBeLessThanOrEqual(200 * 1.15);
  });

  it("mustKeep indices appear in the result even when their cell would have been won by another point", () => {
    // 8000 points filling a 20×20×20 grid; tight budget so heavy downsample.
    const pos = uniformGrid(20);
    const budget = 200;
    // Force-keep a handful of specific indices.
    const keep = new Uint32Array([0, 17, 99, 4_321, 7_999]);
    const res = voxelDownsample(pos, budget, undefined, keep);
    expect(res.downsampled).toBe(true);
    const set = new Set(res.kept);
    for (const k of keep) {
      expect(set.has(k)).toBe(true);
    }
  });

  it("multiple mustKeep indices sharing a cell all survive via the union pass", () => {
    // Place three points so close together they're guaranteed to hash to
    // the same voxel cell at any reasonable grid resolution. Surround them
    // with enough other points to force downsampling.
    const coords: Array<[number, number, number]> = [
      [0, 0, 0],
      [0.0001, 0.0001, 0.0001],
      [0.0002, 0.0002, 0.0002],
    ];
    for (let i = 0; i < 5_000; i++) {
      coords.push([i % 50, Math.floor(i / 50) % 50, Math.floor(i / 2500)]);
    }
    const pos = positions(coords);
    const budget = 500;
    const keep = new Uint32Array([0, 1, 2]);
    const res = voxelDownsample(pos, budget, undefined, keep);
    const set = new Set(res.kept);
    expect(set.has(0)).toBe(true);
    expect(set.has(1)).toBe(true);
    expect(set.has(2)).toBe(true);
    // And the rest of the kept set is still bounded — the union should add
    // overflow back, not blow the cap wildly.
    expect(res.kept.length).toBeLessThanOrEqual(budget * 1.15 + keep.length);
  });

  it("empty mustKeep behaves the same as omitting mustKeep", () => {
    const pos = uniformGrid(20);
    const a = voxelDownsample(pos, 400);
    const b = voxelDownsample(pos, 400, undefined, new Uint32Array(0));
    expect(a.kept.length).toBe(b.kept.length);
    expect(a.cellsPerAxis).toBe(b.cellsPerAxis);
  });

  it("indices are always within [0, n) and unique", () => {
    const pos = densePoints(20_000, 42);
    const res = voxelDownsample(pos, 1_000);
    const n = pos.length / 3;
    const seen = new Set<number>();
    for (let i = 0; i < res.kept.length; i++) {
      const idx = res.kept[i];
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(n);
      expect(seen.has(idx)).toBe(false);
      seen.add(idx);
    }
  });
});
