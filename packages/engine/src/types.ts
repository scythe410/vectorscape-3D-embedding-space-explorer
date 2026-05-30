// Typed-array buffers for the point cloud. The host owns these and passes them
// in once; the engine writes them straight into THREE.BufferAttribute and
// never mutates per-frame. probability is optional and lives in [0, 1].
export interface PointsData {
  /** Float32Array of length N*3 — [x, y, z] per point. */
  position: Float32Array;
  /** Float32Array of length N*3 — [r, g, b] per point, each in [0, 1]. */
  color: Float32Array;
  /** Float32Array of length N — world-space size per point. */
  size: Float32Array;
  /** Optional Float32Array of length N — HDBSCAN-style membership probability in [0, 1]. */
  probability?: Float32Array;
}

/** A cluster centroid for fly-to + label overlay. */
export interface ClusterCentroid {
  id: string | number;
  cx: number;
  cy: number;
  cz: number;
  /** Approximate radius for fitToSphere framing. Default 1.0. */
  radius?: number;
  label?: string;
}

/** One stop on a cinematic flythrough path. */
export interface FlythroughKeyframe {
  /** Camera position in world space. */
  position: [number, number, number];
  /** Look-at target in world space. */
  target: [number, number, number];
  /** Override for CameraControls smoothTime during this transition (seconds). */
  smoothTime?: number;
  /** Extra time to hold at this pose after the transition lands (ms). */
  holdMs?: number;
}

/** Extra info on a cluster-pick event so the host can implement multi-select. */
export interface ClusterPickOptions {
  /** True when the click carried Shift / Cmd / Ctrl — toggle-in-selection. */
  additive: boolean;
}

/** Imperative handle the host can ref to drive the camera. */
export interface VectorScapeHandle {
  flyTo: (clusterId: ClusterCentroid["id"]) => void;
  /** Frame a single world-space point. Radius controls the framing distance. */
  flyToPoint: (position: [number, number, number], radius?: number) => void;
  resetView: () => void;
  /** Snap (or smoothly transition) to an explicit camera + target pose. */
  setLookAt: (
    position: [number, number, number],
    target: [number, number, number],
    enableTransition?: boolean,
  ) => Promise<void>;
  /** Play a sequenced cinematic path. Resolves when finished or cancelled. */
  playFlythrough: (keyframes: FlythroughKeyframe[]) => Promise<void>;
  /** Cancel an in-flight flythrough so the user can take over. */
  cancelFlythrough: () => void;
}

/** Total point count and the kept count after voxel downsampling. */
export interface RenderStats {
  total: number;
  kept: number;
  downsampled: boolean;
}
