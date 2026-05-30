import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import * as THREE from "three";

import type { ClusterCentroid } from "../types";

export interface FlyToTargetsHandle {
  getMesh: (id: ClusterCentroid["id"]) => THREE.Mesh | null;
}

interface Props {
  clusters: ClusterCentroid[];
  onPick?: (id: ClusterCentroid["id"]) => void;
}

/**
 * Invisible spheres at every cluster centroid. CameraControls.fitToSphere()
 * frames whichever one the host hands it; raycasting against these is O(K)
 * instead of O(N=points), which is the only way fly-to stays usable at 100k+
 * points (the spike hard-learned this).
 */
export const FlyToTargets = forwardRef<FlyToTargetsHandle, Props>(function FlyToTargets(
  { clusters, onPick },
  ref,
) {
  const refs = useRef(new Map<ClusterCentroid["id"], THREE.Mesh>());

  useImperativeHandle(
    ref,
    () => ({
      getMesh: (id) => refs.current.get(id) ?? null,
    }),
    [],
  );

  const sphereGeom = useMemo(() => new THREE.SphereGeometry(1, 12, 8), []);

  return (
    <group>
      {clusters.map((c) => {
        const r = c.radius ?? 1;
        return (
          <mesh
            key={String(c.id)}
            ref={(m) => {
              if (m) refs.current.set(c.id, m);
              else refs.current.delete(c.id);
            }}
            geometry={sphereGeom}
            position={[c.cx, c.cy, c.cz]}
            scale={[r, r, r]}
            visible={false}
            onClick={onPick ? (e) => { e.stopPropagation(); onPick(c.id); } : undefined}
          >
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
});
