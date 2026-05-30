import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import type { PointsData } from "../types";

interface Props {
  data: PointsData;
  /** Click radius in screen pixels. Points further than this in NDC space are ignored. */
  pixelRadius?: number;
  /**
   * Fires with the index into the host's full `data.position` array (NOT the
   * downsampled subset). Index is `pos / 3`. Fires with -1 when no point
   * landed within `pixelRadius`.
   */
  onPick: (index: number) => void;
  /**
   * Imperative handle the parent installs so it can route Canvas
   * `onPointerMissed` events here (R3F doesn't expose onPointerMissed via
   * children, only on the Canvas itself).
   */
  missedHandlerRef: React.MutableRefObject<(e: MouseEvent) => void>;
}

/**
 * Per-point picker. Background clicks (handled via Canvas onPointerMissed by
 * the parent, then forwarded into here) project every point in the full host
 * dataset to screen space and return the index of the nearest one within
 * `pixelRadius`. Walks the entire array — picking is per-click, so even at
 * ~1M points the latency is acceptable (~30ms one-shot); per-frame would be
 * forbidden by the spike's "no CPU work per frame" rule.
 *
 * Why screen-space, not raycast: the THREE.Points raycaster is O(N) too, but
 * needs a tolerance in world units that varies with camera distance. Pixel
 * tolerance is what users actually perceive when they click.
 */
export function PointPicker({
  data,
  pixelRadius = 16,
  onPick,
  missedHandlerRef,
}: Props) {
  const { camera, gl } = useThree();
  const projected = useMemo(() => new THREE.Vector3(), []);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  useEffect(() => {
    missedHandlerRef.current = (e: MouseEvent) => {
      const canvas = gl.domElement;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);

      // Pixel tolerance → NDC tolerance (NDC is [-1,1] over the full canvas).
      const tolX = (pixelRadius * 2) / rect.width;
      const tolY = (pixelRadius * 2) / rect.height;

      camera.updateMatrixWorld();
      const pos = data.position;
      const n = pos.length / 3;

      let bestIdx = -1;
      let bestDepth = Infinity;
      let bestDistSq = Infinity;

      for (let i = 0; i < n; i++) {
        projected.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        projected.project(camera);
        // Cull anything behind the camera or outside the NDC tolerance box.
        if (projected.z > 1 || projected.z < -1) continue;
        const dx = projected.x - ndcX;
        const dy = projected.y - ndcY;
        if (Math.abs(dx) > tolX || Math.abs(dy) > tolY) continue;
        const dSq = dx * dx + dy * dy;
        // Pick the screen-closest, tiebreak by NDC depth (closer to camera wins).
        if (
          dSq < bestDistSq - 1e-6 ||
          (Math.abs(dSq - bestDistSq) < 1e-6 && projected.z < bestDepth)
        ) {
          bestDistSq = dSq;
          bestDepth = projected.z;
          bestIdx = i;
        }
      }

      onPickRef.current(bestIdx);
    };
    return () => {
      missedHandlerRef.current = () => {};
    };
  }, [camera, gl, data, pixelRadius, projected, missedHandlerRef]);

  return null;
}
