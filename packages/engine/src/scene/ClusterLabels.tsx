import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

import type { ClusterCentroid } from "../types";

interface Props {
  clusters: ClusterCentroid[];
  /** Distance at which labels begin to fade in. Beyond this → galaxy feel. */
  fadeStart?: number;
  /** Distance at which labels reach full opacity. Below this → architectural. */
  fadeEnd?: number;
  /** Hide labels for clusters this many world units behind the camera. */
  hideBehindCamera?: boolean;
}

/**
 * Proximity-based cluster labels. Far away the galaxy is just luminous data;
 * as the camera approaches, labels fade in and the scene reads as named places
 * to walk among — the "galaxy ↔ architectural morph" from design.md.
 *
 * Rendered as drei <Html> overlays so they sit *above* the WebGL framebuffer
 * and bloom can't accidentally smear them. One DOM node per cluster — fine at
 * the ≤50-cluster scale a real SKM galaxy produces.
 *
 * Per-frame work: O(K=clusters), each touching only its own DOM node opacity.
 * No BufferAttribute writes, no geometry rebuilds.
 */
export function ClusterLabels({
  clusters,
  fadeStart = 140,
  fadeEnd = 60,
  hideBehindCamera = true,
}: Props) {
  const { camera } = useThree();
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const tmpVec = useMemo(() => new THREE.Vector3(), []);
  const camForward = useMemo(() => new THREE.Vector3(), []);
  const camDelta = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    // Read camera forward direction once per frame.
    camera.getWorldDirection(camForward);
    for (const c of clusters) {
      const node = nodeRefs.current.get(String(c.id));
      if (!node) continue;
      tmpVec.set(c.cx, c.cy, c.cz);
      camDelta.copy(tmpVec).sub(camera.position);
      const dist = camDelta.length();

      // Behind-camera cull: dot of forward · (cluster - camera) < 0 → behind.
      const behind = hideBehindCamera && camDelta.dot(camForward) < 0;

      // fadeStart > fadeEnd: 1.0 at <= fadeEnd, 0.0 at >= fadeStart, smooth between.
      let t = 0;
      if (!behind) {
        if (dist <= fadeEnd) t = 1;
        else if (dist >= fadeStart) t = 0;
        else {
          const u = (fadeStart - dist) / (fadeStart - fadeEnd);
          // Smootherstep — easier on the eye than linear.
          t = u * u * (3 - 2 * u);
        }
      }
      // Setting style.opacity (instead of removing the node) keeps the DOM
      // measurement cheap; drei's <Html> still computes screen-space transform.
      node.style.opacity = t.toFixed(3);
      // Avoid pointer events when invisible so labels don't intercept clicks
      // for clusters the user can't actually see.
      node.style.pointerEvents = t > 0.05 ? "auto" : "none";
    }
  });

  return (
    <group>
      {clusters.map((c) => (
        <Html
          key={String(c.id)}
          position={[c.cx, c.cy, c.cz]}
          center
          // distanceFactor scales the label by camera distance — small far
          // away, readable up close. Matches the morph: labels grow into the
          // architectural moment.
          distanceFactor={50}
          // Don't run the depth-occlusion mesh; we handle visibility ourselves
          // and it adds a quad per label.
          zIndexRange={[20, 0]}
          // Keep the underlying node so we can drive opacity per-frame.
          wrapperClass="vs-cluster-label-wrapper"
        >
          <div
            ref={(el) => {
              if (el) nodeRefs.current.set(String(c.id), el);
              else nodeRefs.current.delete(String(c.id));
            }}
            // Glass label per design.md §4 — quiet, readable against bright cores.
            style={{
              opacity: 0,
              transition: "opacity 80ms linear",
              transform: "translate(-50%, -120%)",
              padding: "4px 10px",
              borderRadius: "999px",
              background: "rgba(8, 10, 18, 0.55)",
              border: "1px solid rgba(255,255,255,0.10)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
              color: "rgba(245,245,250,0.92)",
              fontSize: "11px",
              letterSpacing: "0.08em",
              fontFamily:
                "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
              whiteSpace: "nowrap",
              // Free c-TF-IDF caps at ~24 chars and LLM caps at 4 words, but
              // pre-0a labels in the DB (e.g. full newsgroup taxonomies) can
              // be longer. Truncate with ellipsis so the pill stays compact.
              maxWidth: "180px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              // Soft shadow so labels stay legible over bright nebula cores.
              textShadow: "0 1px 2px rgba(0,0,0,0.85)",
              boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
              userSelect: "none",
            }}
          >
            <span title={c.label ?? `Cluster ${c.id}`}>
              {c.label ?? `Cluster ${c.id}`}
            </span>
          </div>
        </Html>
      ))}
    </group>
  );
}
