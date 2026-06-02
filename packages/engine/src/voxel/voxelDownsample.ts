// O(N) voxel-grid filter. Overlay a 3D grid on the dataset's bounding box,
// hash each point into a cell, keep the first point landing in each occupied
// cell. Returns the indices of the kept points so the host can slice every
// parallel attribute (color, size, probability, embedding...) in lockstep.
//
// CLAUDE.md hard constraint: must be O(N). Never pairwise distances.

const DEFAULT_FILL_RATIO = 0.25;

export interface VoxelDownsampleResult {
  /** Indices into the original point array; length ≤ budget. */
  kept: Uint32Array;
  /** True iff the input was actually larger than the budget. */
  downsampled: boolean;
  /** Cells per axis used. Exposed for diagnostics. */
  cellsPerAxis: number;
}

/**
 * Pick a grid resolution so the number of cells is roughly budget / fillRatio.
 * Real-world point clouds occupy ~10–40% of the bounding-box cells; 0.25 is a
 * decent default. The caller can pass a custom ratio if their data is denser.
 */
function pickCellsPerAxis(budget: number, fillRatio: number): number {
  const cells = Math.max(1, Math.cbrt(budget / fillRatio));
  return Math.max(2, Math.round(cells));
}

export function voxelDownsample(
  positions: Float32Array,
  budget: number,
  fillRatio = DEFAULT_FILL_RATIO,
  /**
   * Indices that must appear in the kept set regardless of voxel occupancy —
   * used so search matches don't get filtered out when the dataset exceeds
   * budget. The match overrides whichever point would otherwise have won its
   * cell, and any cell with no match keeps the first arrival as usual.
   */
  mustKeep?: Uint32Array | null,
): VoxelDownsampleResult {
  const n = positions.length / 3;

  if (n <= budget) {
    const all = new Uint32Array(n);
    for (let i = 0; i < n; i++) all[i] = i;
    return { kept: all, downsampled: false, cellsPerAxis: 0 };
  }

  // Single-pass AABB. ~O(N), one read per coord.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  // Pad to avoid zero-extent axes (e.g. a perfectly flat plane).
  const eps = 1e-6;
  const extentX = Math.max(maxX - minX, eps);
  const extentY = Math.max(maxY - minY, eps);
  const extentZ = Math.max(maxZ - minZ, eps);

  // Iterate up to a few times in case fillRatio was way off. Each pass is
  // O(N) and we usually only need one — preserves the hard O(N) guarantee
  // since the upper bound on iterations is a small constant.
  let cellsPerAxis = pickCellsPerAxis(budget, fillRatio);
  for (let attempt = 0; attempt < 4; attempt++) {
    const occupied = new Map<number, number>();
    const sx = cellsPerAxis / extentX;
    const sy = cellsPerAxis / extentY;
    const sz = cellsPerAxis / extentZ;
    const stride = cellsPerAxis;
    const stride2 = stride * stride;

    for (let i = 0; i < n; i++) {
      const ix = Math.min(stride - 1, Math.floor((positions[i * 3] - minX) * sx));
      const iy = Math.min(stride - 1, Math.floor((positions[i * 3 + 1] - minY) * sy));
      const iz = Math.min(stride - 1, Math.floor((positions[i * 3 + 2] - minZ) * sz));
      const key = ix + iy * stride + iz * stride2;
      if (!occupied.has(key)) occupied.set(key, i);
    }

    // If we vastly overshot, shrink the grid (coarser cells → fewer kept).
    if (occupied.size > budget * 1.15) {
      cellsPerAxis = Math.max(2, Math.floor(cellsPerAxis * 0.85));
      continue;
    }
    // If we undershot, the cells were too coarse for how the input clusters.
    // Use the observed fill ratio to retarget cellsPerAxis in a single jump
    // so we land near budget without dozens of doubling passes. Capped to
    // 4 attempts total to preserve the constant-multiplier O(N) guarantee.
    if (occupied.size < budget * 0.85 && attempt < 3) {
      const observedFill = occupied.size / (cellsPerAxis * cellsPerAxis * cellsPerAxis);
      const targetCells = budget / Math.max(observedFill, 0.02);
      const next = Math.max(cellsPerAxis + 1, Math.round(Math.cbrt(targetCells)));
      // Cap growth per attempt to avoid pathological jumps from tiny fills.
      cellsPerAxis = Math.min(next, Math.floor(cellsPerAxis * 1.8));
      continue;
    }

    if (mustKeep && mustKeep.length > 0) {
      // Overwrite each must-keep point's cell with itself so it becomes the
      // cell's representative. If several must-keeps share a cell, the union
      // step below adds the overflow back.
      for (let k = 0; k < mustKeep.length; k++) {
        const m = mustKeep[k];
        const ix = Math.min(stride - 1, Math.floor((positions[m * 3] - minX) * sx));
        const iy = Math.min(stride - 1, Math.floor((positions[m * 3 + 1] - minY) * sy));
        const iz = Math.min(stride - 1, Math.floor((positions[m * 3 + 2] - minZ) * sz));
        const key = ix + iy * stride + iz * stride2;
        occupied.set(key, m);
      }
      const seen = new Set<number>();
      for (const idx of occupied.values()) seen.add(idx);
      for (let k = 0; k < mustKeep.length; k++) seen.add(mustKeep[k]);
      const kept = new Uint32Array(seen.size);
      let w = 0;
      for (const idx of seen) kept[w++] = idx;
      return { kept, downsampled: true, cellsPerAxis };
    }

    const kept = new Uint32Array(occupied.size);
    let w = 0;
    for (const idx of occupied.values()) kept[w++] = idx;
    return { kept, downsampled: true, cellsPerAxis };
  }

  // Fallback: take the first `budget` points. Shouldn't be reachable for
  // any realistic dataset; here so the function is total.
  const kept = new Uint32Array(budget);
  for (let i = 0; i < budget; i++) kept[i] = i;
  return { kept, downsampled: true, cellsPerAxis };
}
