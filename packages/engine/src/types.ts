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

/** Imperative handle the host can ref to drive the camera. */
export interface VectorScapeHandle {
  flyTo: (clusterId: ClusterCentroid["id"]) => void;
  resetView: () => void;
}

/** Total point count and the kept count after voxel downsampling. */
export interface RenderStats {
  total: number;
  kept: number;
  downsampled: boolean;
}
