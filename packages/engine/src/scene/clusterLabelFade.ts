// Pure scalar math for the cluster-label proximity fade.
//
// Inside ClusterLabels.tsx the per-frame loop computes two things per
// cluster: (a) a "behind-camera" cull from the dot product of the camera
// forward direction with the camera→cluster delta, and (b) a smootherstep
// distance ramp that's 1.0 at fadeEnd, 0.0 at fadeStart, smooth between.
// The component handles three.js objects; this module handles the numbers.
//
// Extracted so the math is unit-testable without a WebGL context, a Canvas,
// or a React renderer. ClusterLabels imports `computeLabelOpacity` so the
// inline math doesn't drift from the tested contract.

/**
 * Smootherstep — a C2-continuous easing used for the label fade ramp.
 * Clamps to [0, 1] at the endpoints, accelerates and decelerates smoothly
 * between. The fragment shader uses the same shape (see GLSL `smoothstep`).
 */
export function smootherstep(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

/**
 * Compute the opacity of one cluster label given:
 *   - `distance`: world-space distance from camera to cluster centroid
 *   - `forwardDot`: dot(cameraForward, normalize(cluster - camera) * |delta|)
 *      Negative iff the cluster is behind the camera.
 *   - `fadeStart` (default 140): distance at which the label is invisible
 *   - `fadeEnd` (default 60): distance at which the label is fully visible
 *   - `hideBehindCamera`: when true, behind-camera clusters get opacity 0
 *
 * Invariants:
 *   - opacity ∈ [0, 1].
 *   - Monotone non-increasing in `distance` between fadeEnd and fadeStart.
 *   - Returns 1 for distance ≤ fadeEnd and not behind camera.
 *   - Returns 0 for distance ≥ fadeStart or for behind-camera with cull on.
 */
export function computeLabelOpacity(args: {
  distance: number;
  forwardDot: number;
  fadeStart?: number;
  fadeEnd?: number;
  hideBehindCamera?: boolean;
}): number {
  const fadeStart = args.fadeStart ?? 140;
  const fadeEnd = args.fadeEnd ?? 60;
  const hideBehindCamera = args.hideBehindCamera ?? true;

  if (hideBehindCamera && args.forwardDot < 0) return 0;
  if (args.distance <= fadeEnd) return 1;
  if (args.distance >= fadeStart) return 0;

  const u = (fadeStart - args.distance) / (fadeStart - fadeEnd);
  return smootherstep(u);
}

/**
 * Drei `<Html>` overlays accept pointer events; while the label is mostly
 * invisible we want clicks to fall through to the canvas underneath. Threshold
 * shared with `ClusterLabels.tsx` so the inline DOM write stays in sync with
 * the tested rule.
 */
export const LABEL_POINTER_OPACITY_THRESHOLD = 0.05;
