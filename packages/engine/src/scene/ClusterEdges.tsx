import { useMemo } from "react";
import * as THREE from "three";

import type { ClusterCentroid, ClusterEdge } from "../types";

interface Props {
  edges: ClusterEdge[];
  centroids: ClusterCentroid[];
  /** Hover handler — host wires this to a tooltip + Bridge open hint.
   *  Called with null on pointer-out. */
  onEdgeHover?: (edge: ClusterEdge | null) => void;
  /** Click handler — host routes this to the Bridge panel with (a, b)
   *  preselected. The engine never invents an explanation path. */
  onEdgeClick?: (edge: ClusterEdge) => void;
}

/**
 * Faint adjacency lines between the most semantically-similar cluster pairs.
 *
 * Critical guarantee from design.md + spec: these must NEVER compete with
 * the data glow. Concrete invariants honored by this component:
 *   - thin cylinders, low opacity (~0.18 default), color near-white but
 *     darkened well below the bloom threshold (~0.7) so they cannot bite
 *     into the bloom pass;
 *   - default layer (0) only — no BLOOM_LAYER enable;
 *   - one mesh per edge, but edges are capped at top-N upstream so we
 *     emit at most 2-3 meshes total. There is no hairball mode.
 *
 * Hit testing uses the cylinder geometry directly — wide enough to grab
 * with a cursor (~0.5 world units in the radial direction) but visually
 * understated. Each cluster pair is rendered exactly once.
 */
export function ClusterEdges({ edges, centroids, onEdgeHover, onEdgeClick }: Props) {
  // Lookup by cluster id so an edge that references a cluster the host has
  // since culled doesn't crash — we just skip it.
  const byId = useMemo(() => {
    const m = new Map<number, ClusterCentroid>();
    for (const c of centroids) m.set(Number(c.id), c);
    return m;
  }, [centroids]);

  // Shared geometry: a unit cylinder along +Y. We rotate/translate per
  // instance via position + quaternion so React doesn't churn geometry on
  // re-renders. 8 radial segments is plenty for a ~0.06-radius tube.
  const cylinderGeom = useMemo(
    () => new THREE.CylinderGeometry(1, 1, 1, 8, 1, true),
    [],
  );

  // Up vector for the cylinder's default orientation. Rotated to align with
  // each edge segment via `setFromUnitVectors`.
  const yAxis = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  return (
    <group>
      {edges.map((edge) => {
        const ca = byId.get(edge.a);
        const cb = byId.get(edge.b);
        if (!ca || !cb) return null;

        const start = new THREE.Vector3(ca.cx, ca.cy, ca.cz);
        const end = new THREE.Vector3(cb.cx, cb.cy, cb.cz);
        const mid = start.clone().add(end).multiplyScalar(0.5);
        const dir = end.clone().sub(start);
        const length = dir.length();
        if (length === 0) return null;
        const axis = dir.clone().normalize();

        const quat = new THREE.Quaternion().setFromUnitVectors(yAxis, axis);

        // Similarity drives both opacity and thickness so the strongest edge
        // is the most visible — but everything stays well within "faint."
        // Clamped to [-1, 1] then remapped from [0, 1] for opacity, since
        // adjacency is interesting in the positive-cosine range. Negative
        // cosines (anti-aligned clusters) round down to the floor.
        const s = Math.max(0, Math.min(1, edge.similarity));
        const opacity = 0.12 + 0.18 * s; // ~0.12 to ~0.30
        const radius = 0.06 + 0.10 * s; // ~0.06 to ~0.16 world units

        // Cool, recessive color — design.md "cool, recessive" UI tone. Color
        // is held below ~0.55 luminance so additive overlap with the cloud
        // never lifts the edge above the 0.7 bloom threshold.
        const color = "#6b7e9c";

        return (
          <mesh
            key={`${edge.a}-${edge.b}`}
            geometry={cylinderGeom}
            position={mid}
            quaternion={quat}
            scale={[radius, length, radius]}
            renderOrder={-1}
            onPointerOver={
              onEdgeHover
                ? (e) => {
                    e.stopPropagation();
                    onEdgeHover(edge);
                  }
                : undefined
            }
            onPointerOut={
              onEdgeHover
                ? (e) => {
                    e.stopPropagation();
                    onEdgeHover(null);
                  }
                : undefined
            }
            onClick={
              onEdgeClick
                ? (e) => {
                    e.stopPropagation();
                    onEdgeClick(edge);
                  }
                : undefined
            }
          >
            <meshBasicMaterial
              color={color}
              transparent
              opacity={opacity}
              depthWrite={false}
              toneMapped={false}
              blending={THREE.NormalBlending}
            />
          </mesh>
        );
      })}
    </group>
  );
}
