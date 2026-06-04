/**
 * "Where am I?" math for the live proximity readout — given the camera's
 * world-space position and the named cluster centroids, return the top-N
 * contributors with normalized percentages.
 *
 * Inverse-distance weighting with a soft epsilon and a configurable power.
 * Power 2 (inverse-distance-squared) gives the perceptual "near counts a lot,
 * far counts very little" gradient that matches the design goal: the readout
 * should make the between-space legible, then fade as one region dominates.
 *
 * Pure & framework-free so the math is unit-testable. The host wires
 * `createThrottle` into the engine's per-frame camera callback to keep React
 * state updates off the hot path.
 */

export interface ProximityCentroid {
  id: string | number;
  label: string;
  cx: number;
  cy: number;
  cz: number;
}

interface ProximityContribution {
  id: string | number;
  label: string;
  /** Normalized weight against the full centroid set, in [0, 1]. */
  weight: number;
  /** Integer percentage (0-100), rounded. Top contributor uses largest-remainder
   *  rounding so two contributors that round individually to e.g. 73 + 27 actually
   *  sum to 100, not 99 or 101. */
  pct: number;
  /** Euclidean distance from camera to this centroid in world units. */
  distance: number;
}

export interface ProximityResult {
  /** Top-N contributors, sorted by weight desc. Drops a contributor whose
   *  raw pct falls under `minPctToShow` (top-1 is always retained). */
  contributors: ProximityContribution[];
  /** Suggested readout opacity, in [0, 1]. Eases from 1 toward 0 as the
   *  dominant contributor crosses [fadeStart, fadeEnd] — i.e., the camera
   *  is settling deep inside a single cluster and "100% X" is uninformative. */
  opacity: number;
  /** True when opacity reached 0 — caller can entirely skip rendering. */
  collapsed: boolean;
  /** True when the input set was empty (or all centroids coincide with the
   *  camera position). Distinct from `collapsed` so callers can tell "no
   *  data" from "deep inside one cluster." */
  empty: boolean;
}

export interface ProximityOptions {
  /** Max contributors to surface. Default 3. */
  topN?: number;
  /** Inverse-distance exponent. Default 2 (inverse-distance-squared). */
  power?: number;
  /** Distance softening so a camera at a centroid doesn't divide by zero
   *  and so values stay smooth as you arrive. Default 0.5 world units. */
  epsilon?: number;
  /** Dominant weight above which the readout starts fading out. Default 0.75. */
  fadeStart?: number;
  /** Dominant weight above which the readout is fully faded. Default 0.95. */
  fadeEnd?: number;
  /** Skip trailing contributors whose pct falls below this floor. Default 5%. */
  minPctToShow?: number;
}

export function computeProximity(
  camera: readonly [number, number, number],
  centroids: readonly ProximityCentroid[],
  opts: ProximityOptions = {},
): ProximityResult {
  const topN = opts.topN ?? 3;
  const power = opts.power ?? 2;
  const epsilon = opts.epsilon ?? 0.5;
  const fadeStart = opts.fadeStart ?? 0.75;
  const fadeEnd = opts.fadeEnd ?? 0.95;
  const minPctToShow = opts.minPctToShow ?? 5;

  if (centroids.length === 0) {
    return { contributors: [], opacity: 0, collapsed: true, empty: true };
  }

  let total = 0;
  const raw = centroids.map((c) => {
    const dx = c.cx - camera[0];
    const dy = c.cy - camera[1];
    const dz = c.cz - camera[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const w = 1 / Math.pow(distance + epsilon, power);
    total += w;
    return { id: c.id, label: c.label, weight: w, distance };
  });

  if (!Number.isFinite(total) || total <= 0) {
    return { contributors: [], opacity: 0, collapsed: true, empty: true };
  }

  const normalized = raw
    .map((w) => ({ ...w, weight: w.weight / total }))
    .sort((a, b) => b.weight - a.weight);

  const dominant = normalized[0].weight;
  let opacity = 1;
  if (dominant >= fadeEnd) opacity = 0;
  else if (dominant > fadeStart) {
    opacity = 1 - (dominant - fadeStart) / (fadeEnd - fadeStart);
  }

  // Top-N, then drop trailing contributors below the min — but always retain
  // the leader. minPctToShow operates on the raw weight (true contribution),
  // not the rounded pct, so a 4.6% slice that would round to 5% still drops.
  const headCount = Math.max(1, Math.min(topN, normalized.length));
  const head = normalized.slice(0, headCount);
  const kept: typeof head = [head[0]];
  for (let i = 1; i < head.length; i++) {
    if (head[i].weight * 100 < minPctToShow) break;
    kept.push(head[i]);
  }

  // Round to integers using largest-remainder so the displayed numbers sum
  // cleanly. Without this, "73 + 27" can render as "73 + 26" depending on
  // floor-vs-round which reads as a typo.
  const pcts = roundLargestRemainder(
    kept.map((k) => k.weight * 100),
  );

  return {
    contributors: kept.map((k, i) => ({
      id: k.id,
      label: k.label,
      weight: k.weight,
      pct: pcts[i],
      distance: k.distance,
    })),
    opacity,
    collapsed: opacity <= 0,
    empty: false,
  };
}

/**
 * Round an array of real-valued percentages to integers using the
 * largest-remainder method, keeping the integer sum equal to the rounded
 * total. Operates on the *displayed* subset — we keep the sum of *shown*
 * percentages internally consistent so users don't see "73% + 27% = 99%".
 */
export function roundLargestRemainder(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const targetSum = Math.round(values.reduce((s, v) => s + v, 0));
  const floors = values.map((v) => Math.floor(v));
  const remainders = values.map((v, i) => ({ i, r: v - floors[i] }));
  let leftover = targetSum - floors.reduce((s, f) => s + f, 0);
  // Distribute the leftover units to the largest remainders, breaking ties
  // by original index (stable across reorderings of equal-weighted slices).
  remainders.sort((a, b) => (b.r - a.r) || (a.i - b.i));
  const out = floors.slice();
  for (let k = 0; k < remainders.length && leftover > 0; k++) {
    out[remainders[k].i] += 1;
    leftover -= 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Throttle — keeps the per-frame engine callback from spamming React state.
// ---------------------------------------------------------------------------

export interface Throttle {
  /** Returns true if at least `intervalMs` has elapsed since the last
   *  successful `tick`; when true, the internal "last fire" updates. */
  tick(nowMs: number): boolean;
  /** Reset the clock so the next tick will succeed immediately. */
  reset(): void;
}

/**
 * Leading-edge throttle. The first call fires (we always want the readout to
 * show *something* immediately rather than after a 120ms delay), and
 * subsequent calls are dropped until the interval elapses.
 */
export function createThrottle(intervalMs: number): Throttle {
  let last = -Infinity;
  return {
    tick(nowMs: number): boolean {
      if (nowMs - last >= intervalMs) {
        last = nowMs;
        return true;
      }
      return false;
    },
    reset() {
      last = -Infinity;
    },
  };
}
