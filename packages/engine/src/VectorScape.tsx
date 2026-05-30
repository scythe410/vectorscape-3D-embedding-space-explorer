import { CameraControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, SMAA } from "@react-three/postprocessing";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as THREE from "three";

import { FlyToTargets, type FlyToTargetsHandle } from "./scene/FlyToTargets";
import { PointPicker } from "./scene/PointPicker";
import { PointsCloud } from "./scene/PointsCloud";
import type {
  ClusterCentroid,
  PointsData,
  RenderStats,
  VectorScapeHandle,
} from "./types";
import { voxelDownsample } from "./voxel/voxelDownsample";

export interface VectorScapeProps {
  points: PointsData;
  clusters?: ClusterCentroid[];
  /** Soft cap on rendered points. Above this, the voxel filter kicks in. */
  budget?: number;
  /** Background color (also fed into the fog for tonal continuity). */
  background?: string;
  /** FogExp2 density. Default 0.012 matches the spike's "deep space" feel. */
  fogDensity?: number;
  /** Bloom intensity. Higher = more haze around bright cores. */
  bloomIntensity?: number;
  /** Floor on the probability brightness curve. 0 fully kills outliers. */
  minBrightness?: number;
  /** Fired when the user clicks an invisible centroid sphere. */
  onClusterSelect?: (id: ClusterCentroid["id"]) => void;
  /**
   * Fires with the index into `points.position` (full dataset, not the
   * downsampled render subset) when the user clicks the canvas background
   * within ~pixelRadius pixels of a point. -1 when no point is near enough.
   */
  onPointPick?: (index: number) => void;
  /** Click radius in screen pixels for point picking. Default 16. */
  pickPixelRadius?: number;
  /** Reports total/kept counts after the voxel pass. */
  onStats?: (stats: RenderStats) => void;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_BUDGET = 350_000;
const BLOOM_LAYER = 1;

/**
 * Top-level renderer. Owns the Canvas, fog, postprocessing, camera, and
 * cluster fly-to targets. The renderer-specific bits (THREE.Points + shader)
 * are isolated in <PointsCloud>; swapping to a WebGPU backend later means
 * replacing that file, not this one.
 *
 * Hard constraints honored:
 *   - WebGL2 only (no WebGPURenderer import).
 *   - One THREE.Points draw call (in PointsCloud).
 *   - GPU-resident buffers; no per-frame CPU attribute writes.
 *   - Voxel-grid downsample (O(N)) above `budget`.
 *   - Fly-to hits invisible centroid spheres, never raycasts the cloud.
 */
export const VectorScape = forwardRef<VectorScapeHandle, VectorScapeProps>(
  function VectorScape(
    {
      points,
      clusters = [],
      budget = DEFAULT_BUDGET,
      background = "#06070b",
      fogDensity = 0.012,
      bloomIntensity = 1.2,
      minBrightness = 0.18,
      onClusterSelect,
      onPointPick,
      pickPixelRadius,
      onStats,
      className,
      style,
    },
    handleRef,
  ) {
    // Bridge: Canvas onPointerMissed lives at the Canvas level, but the picker
    // needs camera/gl from useThree (only available inside Canvas children).
    // The ref is installed by <PointPicker> on mount.
    const missedHandlerRef = useRef<(e: MouseEvent) => void>(() => {});
    // Voxel filter runs on data/budget change. Doing it during render is safe
    // because it's O(N) and synchronous; for very large datasets the host can
    // memoize `points` upstream.
    const downsample = useMemo(
      () => voxelDownsample(points.position, budget),
      [points, budget],
    );

    useEffect(() => {
      onStats?.({
        total: points.position.length / 3,
        kept: downsample.kept.length,
        downsampled: downsample.downsampled,
      });
    }, [downsample, points, onStats]);

    const fogColor = useMemo(() => new THREE.Color(background), [background]);

    return (
      <div className={className} style={{ width: "100%", height: "100%", background, ...style }}>
        <Canvas
          gl={{
            antialias: false,
            powerPreference: "high-performance",
            // WebGL2 is the default in three; named here for intent.
            // (WebGPURenderer is intentionally not imported.)
          }}
          dpr={[1, 2]}
          camera={{ position: [0, 0, 60], fov: 50, near: 0.1, far: 2000 }}
          // Selective bloom by layer. Anything on BLOOM_LAYER glows; the
          // invisible fly-to spheres don't.
          onCreated={({ camera }) => {
            camera.layers.enable(BLOOM_LAYER);
          }}
          onPointerMissed={(e) => missedHandlerRef.current(e as unknown as MouseEvent)}
        >
          <color attach="background" args={[background]} />
          <fogExp2 attach="fog" args={[fogColor.getHex(), fogDensity]} />

          <PointsCloud
            data={points}
            keptIndices={downsample.downsampled ? downsample.kept : null}
            bloomLayer={BLOOM_LAYER}
            fogColor={fogColor}
            fogDensity={fogDensity}
            minBrightness={minBrightness}
          />

          <SceneController
            clusters={clusters}
            onClusterSelect={onClusterSelect}
            handleRef={handleRef}
          />

          {onPointPick && (
            <PointPicker
              data={points}
              pixelRadius={pickPixelRadius}
              onPick={onPointPick}
              missedHandlerRef={missedHandlerRef}
            />
          )}

          <EffectComposer multisampling={0}>
            <Bloom
              intensity={bloomIntensity}
              luminanceThreshold={0.0}
              luminanceSmoothing={0.6}
              mipmapBlur
            />
            <SMAA />
          </EffectComposer>
        </Canvas>
      </div>
    );
  },
);

/**
 * Lives inside <Canvas> so it can use R3F hooks (useThree) to grab the
 * scene/camera and wire CameraControls.fitToSphere into the imperative
 * handle the parent exposes.
 */
function SceneController({
  clusters,
  onClusterSelect,
  handleRef,
}: {
  clusters: ClusterCentroid[];
  onClusterSelect?: (id: ClusterCentroid["id"]) => void;
  handleRef: React.ForwardedRef<VectorScapeHandle>;
}) {
  const controlsRef = useRef<CameraControls>(null);
  const targetsRef = useRef<FlyToTargetsHandle>(null);
  const { camera } = useThree();

  useImperativeHandle(
    handleRef,
    () => ({
      flyTo: (id) => {
        const mesh = targetsRef.current?.getMesh(id);
        const controls = controlsRef.current;
        if (!mesh || !controls) return;
        // fitToSphere frames the sphere with margin; the boolean enables the
        // smooth transition CameraControls uses by default.
        void controls.fitToSphere(mesh, true);
      },
      resetView: () => {
        controlsRef.current?.reset(true);
        camera.position.set(0, 0, 60);
      },
    }),
    [camera],
  );

  return (
    <>
      <CameraControls
        ref={controlsRef}
        makeDefault
        smoothTime={0.4}
        draggingSmoothTime={0.1}
        dollySpeed={0.8}
      />
      <FlyToTargets ref={targetsRef} clusters={clusters} onPick={onClusterSelect} />
    </>
  );
}
