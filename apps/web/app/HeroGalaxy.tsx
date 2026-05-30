"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, SMAA } from "@react-three/postprocessing";
import { useMemo, useRef } from "react";
import * as THREE from "three";

/**
 * Decorative hero scene for the landing — a tiny luminous galaxy that drifts
 * on its own. Not the real demo data on purpose: the landing should paint
 * instantly without a network fetch, and the SKM lens is one click away.
 *
 * Points use the same additive-glow shader pattern as the engine, but inline
 * + smaller because we want the landing chunk to stay light.
 */

const N_POINTS = 2400;
const CLUSTER_COUNT = 7;
const RADIUS = 28;

// Soft palette per design.md §3 — luminous teals, blues, ambers, roses, violets.
const PALETTE: Array<[number, number, number]> = [
  [0.42, 0.74, 0.85], // teal
  [0.58, 0.55, 0.95], // violet
  [0.95, 0.72, 0.48], // amber
  [0.92, 0.46, 0.58], // rose
  [0.55, 0.85, 0.72], // mint
  [0.45, 0.62, 0.96], // blue
  [0.85, 0.83, 0.62], // sand
];

function buildScene() {
  const position = new Float32Array(N_POINTS * 3);
  const color = new Float32Array(N_POINTS * 3);
  const size = new Float32Array(N_POINTS);
  const rng = mulberry32(0xA51DE);

  // Cluster centers on a tilted ring, plus a softer scattered halo.
  const centers: Array<[number, number, number, number]> = [];
  for (let i = 0; i < CLUSTER_COUNT; i++) {
    const a = (i / CLUSTER_COUNT) * Math.PI * 2;
    const r = RADIUS * (0.5 + rng() * 0.6);
    centers.push([
      Math.cos(a) * r,
      (rng() - 0.5) * RADIUS * 0.5,
      Math.sin(a) * r,
      i,
    ]);
  }

  for (let i = 0; i < N_POINTS; i++) {
    const inCluster = rng() < 0.78;
    let cx = 0,
      cy = 0,
      cz = 0,
      ci = Math.floor(rng() * PALETTE.length);
    if (inCluster) {
      const c = centers[Math.floor(rng() * centers.length)];
      cx = c[0];
      cy = c[1];
      cz = c[2];
      ci = c[3] % PALETTE.length;
    }
    // Gaussian-ish jitter — sum of uniforms is a cheap CLT approx.
    const jx = (rng() + rng() + rng() - 1.5) * 4.5;
    const jy = (rng() + rng() + rng() - 1.5) * 4.5;
    const jz = (rng() + rng() + rng() - 1.5) * 4.5;
    position[i * 3] = cx + jx;
    position[i * 3 + 1] = cy + jy;
    position[i * 3 + 2] = cz + jz;
    const [r, g, b] = PALETTE[ci];
    color[i * 3] = r;
    color[i * 3 + 1] = g;
    color[i * 3 + 2] = b;
    size[i] = inCluster ? 2.0 : 1.0;
  }
  return { position, color, size };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * (220.0 / -mv.z);
  }
`;
const FRAG = /* glsl */ `
  precision mediump float;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d);
    float a = smoothstep(0.25, 0.0, r2);
    if (a <= 0.0) discard;
    gl_FragColor = vec4(vColor * (a * 1.4), a);
  }
`;

function Points() {
  const { position, color, size } = useMemo(buildScene, []);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(position, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(color, 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    return g;
  }, [position, color, size]);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );
  return <points geometry={geom} material={mat} />;
}

function DriftingCamera() {
  const { camera } = useThree();
  const t0 = useRef(performance.now());
  useFrame(() => {
    const t = (performance.now() - t0.current) / 1000;
    // Wide slow orbit. Period ~120s for a near-imperceptible drift.
    const a = t * 0.052;
    const r = 78;
    camera.position.set(
      Math.cos(a) * r,
      Math.sin(t * 0.018) * 14,
      Math.sin(a) * r,
    );
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function HeroGalaxy() {
  return (
    <Canvas
      className="absolute inset-0"
      gl={{ antialias: false, powerPreference: "high-performance" }}
      dpr={[1, 2]}
      camera={{ position: [0, 0, 80], fov: 50, near: 0.1, far: 2000 }}
    >
      <color attach="background" args={["#05060a"]} />
      <fogExp2 attach="fog" args={[0x05060a, 0.014]} />
      <DriftingCamera />
      <Points />
      <EffectComposer multisampling={0}>
        <Bloom intensity={1.0} luminanceThreshold={0.0} luminanceSmoothing={0.7} mipmapBlur />
        <SMAA />
      </EffectComposer>
    </Canvas>
  );
}
