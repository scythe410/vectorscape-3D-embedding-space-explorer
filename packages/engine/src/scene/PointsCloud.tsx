import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { POINTS_FRAGMENT, POINTS_VERTEX } from "../shaders/points.glsl";
import type { PointsData } from "../types";

interface PointsCloudProps {
  data: PointsData;
  /** Subset indices from the voxel filter. If null, render every point. */
  keptIndices: Uint32Array | null;
  /** Layer index used by the EffectComposer to select what gets bloomed. */
  bloomLayer: number;
  fogColor: THREE.Color;
  fogDensity: number;
  /** Brightness floor for low-probability points so outliers don't vanish. */
  minBrightness?: number;
}

/**
 * Single THREE.Points draw call. Attributes are written to the GPU once on
 * mount/change and never updated per-frame — animation lives entirely in the
 * shader via the uTime uniform. This is the only thing that keeps the CPU at
 * ~1ms with millions of points (the spike's headline finding).
 */
export function PointsCloud({
  data,
  keptIndices,
  bloomLayer,
  fogColor,
  fogDensity,
  minBrightness = 0.18,
}: PointsCloudProps) {
  const pointsRef = useRef<THREE.Points>(null);
  const { gl } = useThree();
  const pixelRatio = gl.getPixelRatio();

  // Build the BufferGeometry once per data/keptIndices change. We slice typed
  // arrays into new ones (the alternative — DrawRange — works only if kept
  // indices are contiguous, which the voxel filter doesn't guarantee).
  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const total = data.position.length / 3;
    const kept = keptIndices ?? identityIndices(total);
    const n = kept.length;

    const position = new Float32Array(n * 3);
    const color = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const probability = new Float32Array(n);
    const hasProb = !!data.probability;

    for (let i = 0; i < n; i++) {
      const src = kept[i];
      position[i * 3] = data.position[src * 3];
      position[i * 3 + 1] = data.position[src * 3 + 1];
      position[i * 3 + 2] = data.position[src * 3 + 2];
      color[i * 3] = data.color[src * 3];
      color[i * 3 + 1] = data.color[src * 3 + 1];
      color[i * 3 + 2] = data.color[src * 3 + 2];
      size[i] = data.size[src];
      probability[i] = hasProb ? data.probability![src] : 1.0;
    }

    // StaticDrawUsage is the default; we rely on it because these attributes
    // are written once and never updated per-frame from the CPU.
    geom.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geom.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    geom.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geom.setAttribute("aProbability", new THREE.BufferAttribute(probability, 1));

    geom.computeBoundingSphere();
    return geom;
  }, [data, keptIndices]);

  const material = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: pixelRatio },
        uFogColor: { value: fogColor.clone() },
        uFogDensity: { value: fogDensity },
        uMinBrightness: { value: minBrightness },
      },
      vertexShader: POINTS_VERTEX,
      fragmentShader: POINTS_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // pixelRatio is read once; if the user resizes between monitors, R3F
    // rebuilds the canvas which remounts us. Good enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep fog uniforms in sync if the host changes scene fog at runtime.
  useEffect(() => {
    material.uniforms.uFogColor.value.copy(fogColor);
    material.uniforms.uFogDensity.value = fogDensity;
    material.uniforms.uMinBrightness.value = minBrightness;
  }, [material, fogColor, fogDensity, minBrightness]);

  // Free GPU memory on unmount. Geometry and material are owned by us.
  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // The only per-frame work: bump uTime. No CPU attribute rewrites.
  useFrame(({ clock }) => {
    material.uniforms.uTime.value = clock.elapsedTime;
  });

  // Tag this object onto the bloom layer so the EffectComposer's selective
  // bloom picks it up. We set on both the Points and (defensively) any child.
  useEffect(() => {
    const p = pointsRef.current;
    if (!p) return;
    p.layers.enable(bloomLayer);
  }, [bloomLayer]);

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
      frustumCulled={false}
    />
  );
}

function identityIndices(n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}
