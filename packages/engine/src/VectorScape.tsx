import { CameraControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import {
  Bloom,
  DepthOfField,
  EffectComposer,
  SMAA,
} from "@react-three/postprocessing";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as THREE from "three";

import { AmbientDrift } from "./scene/AmbientDrift";
import { ClusterLabels } from "./scene/ClusterLabels";
import { FlyToTargets, type FlyToTargetsHandle } from "./scene/FlyToTargets";
import { PointPicker } from "./scene/PointPicker";
import { PointsCloud } from "./scene/PointsCloud";
import type {
  ClusterCentroid,
  ClusterPickOptions,
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
  /**
   * FogExp2 density. 0.011 is the cinematic default — far field dissolves
   * gently around 150 world units, mid-field stays readable. Lower = more
   * star-chart, higher = closer-feeling.
   */
  fogDensity?: number;
  /** Toggle the bloom pass entirely. Default true. */
  bloomEnabled?: boolean;
  /** Bloom intensity. Higher = more haze around bright cores. */
  bloomIntensity?: number;
  /**
   * Luminance floor for bloom contribution. Lifted off 0 so dim outliers and
   * fog-dimmed midfield don't add to bloom — only confident cluster cores
   * glow. Lower = haze everywhere, higher = sharp stars in dark space.
   */
  bloomThreshold?: number;
  /** Floor on the probability brightness curve. 0 fully kills outliers. */
  minBrightness?: number;
  /** Runtime multiplier on point size. 1.0 = baseline; <1 shrinks, >1 enlarges. */
  pointSizeScale?: number;
  /** Star-sprite core tightness. 0 = soft glow only, 1 = hard pin-prick. */
  coreSharpness?: number;
  /** Star-sprite outer-glow strength. 0 = no halo, ~1 = strong halo. */
  haloStrength?: number;
  /**
   * "High quality" depth-of-field. Default off — DOF is the most expensive
   * effect we ship and not everyone wants it. design.md frames it as a soft
   * bokeh that crisps the focused cluster and dreamifies the rest.
   */
  enableDOF?: boolean;
  /**
   * Subtle ambient drift when the user is idle. design.md: "When idle, the
   * space drifts almost imperceptibly… a breath, not an animation." Default on.
   */
  enableAmbientDrift?: boolean;
  /**
   * Render cluster labels with proximity-based fade. Off by default — the lens
   * cinematic wants them, the sandbox sidebar is canonical for picking. Hosts
   * opt in per surface.
   */
  showClusterLabels?: boolean;
  /**
   * Fired when the user clicks an invisible centroid sphere. The second
   * argument exposes shift/cmd/ctrl modifier state so the host can implement
   * additive multi-selection (Bridge uses this to pick a second cluster).
   */
  onClusterSelect?: (id: ClusterCentroid["id"], opts: ClusterPickOptions) => void;
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
// Steady-state smoothing for user input (drag, wheel). Low enough that Mac
// trackpad wheel events don't leave a half-second tail of phantom dolly after
// the user stops scrolling. Drag has its own draggingSmoothTime override.
const DEFAULT_SMOOTHTIME = 0.3;
// Cinematic smoothing used during fly-to / flyToPoint only.
const CINEMATIC_SMOOTHTIME = 0.65;
// Bounds on the camera's distance from target. Without these, repeated wheel
// events on a Mac trackpad can run dolly to ~0 (stuck) or out past the fog.
const MIN_DOLLY_DISTANCE = 2;
const MAX_DOLLY_DISTANCE = 600;

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
      fogDensity = 0.011,
      bloomEnabled = true,
      bloomIntensity = 1.2,
      bloomThreshold = 0.7,
      minBrightness = 0.51,
      pointSizeScale = 1,
      coreSharpness = 0.7,
      haloStrength = 0.4,
      enableDOF = false,
      enableAmbientDrift = true,
      showClusterLabels = false,
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
            sizeScale={pointSizeScale}
            coreSharpness={coreSharpness}
            haloStrength={haloStrength}
          />

          <SceneController
            clusters={clusters}
            onClusterSelect={onClusterSelect}
            handleRef={handleRef}
            enableAmbientDrift={enableAmbientDrift}
          />

          {showClusterLabels && clusters.length > 0 && (
            <ClusterLabels clusters={clusters} />
          )}

          {onPointPick && (
            <PointPicker
              data={points}
              pixelRadius={pickPixelRadius}
              onPick={onPointPick}
              missedHandlerRef={missedHandlerRef}
            />
          )}

          {/*
            DOF first so subsequent passes work in focused space. focusRange
            is generous so a whole cluster stays sharp once framed, with
            everything outside softly dreamy. The composer is remounted when
            the DOF toggle flips so the effect chain stays valid.
          */}
          {/*
            EffectComposer remounts when the bloom/DOF toggles flip so the
            effect chain stays valid (postprocessing doesn't hot-swap passes
            cleanly). SMAA stays unconditionally — without it, antialias is
            off (we set it that way on the Canvas so the composer owns AA).
          */}
          <EffectComposer
            key={`${bloomEnabled}-${enableDOF}`}
            multisampling={0}
          >
            {enableDOF ? (
              <DepthOfField
                focusDistance={0.012}
                focalLength={0.04}
                bokehScale={3.2}
                height={720}
              />
            ) : (
              <></>
            )}
            {bloomEnabled ? (
              <Bloom
                intensity={bloomIntensity}
                luminanceThreshold={bloomThreshold}
                luminanceSmoothing={0.55}
                mipmapBlur
              />
            ) : (
              <></>
            )}
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
  enableAmbientDrift,
}: {
  clusters: ClusterCentroid[];
  onClusterSelect?: (id: ClusterCentroid["id"], opts: ClusterPickOptions) => void;
  handleRef: React.ForwardedRef<VectorScapeHandle>;
  enableAmbientDrift: boolean;
}) {
  const controlsRef = useRef<CameraControls>(null);
  const targetsRef = useRef<FlyToTargetsHandle>(null);
  const { camera } = useThree();
  // Monotonic counter — every cancel/new play bumps it; in-flight loops bail
  // when they see a stale id. Cleaner than threading AbortControllers through
  // a Promise chain.
  const flythroughGenRef = useRef(0);

  useImperativeHandle(
    handleRef,
    () => ({
      flyTo: (id) => {
        flythroughGenRef.current++;
        const mesh = targetsRef.current?.getMesh(id);
        const controls = controlsRef.current;
        if (!mesh || !controls) return;
        // Mac trackpads keep emitting wheel events with tiny deltas; without
        // stop() those queued dolly targets pre-empt fitToSphere within a
        // frame and the click reads as "nothing happened."
        controls.stop();
        // Invisible meshes still get matrices updated each render, but when
        // fitToSphere fires between frames the world matrix can be a tick
        // stale; force a refresh so the bounds are correct.
        mesh.updateMatrixWorld(true);
        // Cinematic smoothing just for the fly-to. The steady-state
        // smoothTime is lower so wheel-driven dolly snaps instead of drifting.
        const prevSmooth = controls.smoothTime;
        controls.smoothTime = CINEMATIC_SMOOTHTIME;
        void controls.fitToSphere(mesh, true).finally(() => {
          controls.smoothTime = prevSmooth;
        });
      },
      flyToPoint: (position, radius = 3) => {
        flythroughGenRef.current++;
        const controls = controlsRef.current;
        if (!controls) return;
        controls.stop();
        // Frame an ephemeral sphere around the point — same code path as
        // cluster fly-to but for an arbitrary world coord (Bridge cites).
        const sphere = new THREE.Sphere(
          new THREE.Vector3(position[0], position[1], position[2]),
          radius,
        );
        const prevSmooth = controls.smoothTime;
        controls.smoothTime = CINEMATIC_SMOOTHTIME;
        void controls.fitToSphere(sphere, true).finally(() => {
          controls.smoothTime = prevSmooth;
        });
      },
      resetView: () => {
        flythroughGenRef.current++;
        controlsRef.current?.reset(true);
        camera.position.set(0, 0, 60);
      },
      setLookAt: async (position, target, enableTransition = true) => {
        const controls = controlsRef.current;
        if (!controls) return;
        await controls.setLookAt(
          position[0],
          position[1],
          position[2],
          target[0],
          target[1],
          target[2],
          enableTransition,
        );
      },
      playFlythrough: async (keyframes) => {
        const controls = controlsRef.current;
        if (!controls || keyframes.length === 0) return;
        const myGen = ++flythroughGenRef.current;
        const defaultSmooth = controls.smoothTime;
        try {
          for (const kf of keyframes) {
            if (flythroughGenRef.current !== myGen) return;
            if (kf.smoothTime != null) controls.smoothTime = kf.smoothTime;
            await controls.setLookAt(
              kf.position[0],
              kf.position[1],
              kf.position[2],
              kf.target[0],
              kf.target[1],
              kf.target[2],
              true,
            );
            if (flythroughGenRef.current !== myGen) return;
            if (kf.holdMs && kf.holdMs > 0) {
              await new Promise((r) => setTimeout(r, kf.holdMs));
            }
          }
        } finally {
          controls.smoothTime = defaultSmooth;
        }
      },
      cancelFlythrough: () => {
        flythroughGenRef.current++;
      },
    }),
    [camera],
  );

  return (
    <>
      {/*
        Motion feel per design.md "Motion (the heart of it)":
          - smoothTime 0.65 → fly-to decelerates into target like a craft.
          - draggingSmoothTime 0.14 → drag stays responsive but the release
            coasts and settles instead of stopping dead.
          - dollySpeed 0.7 → wheel zoom is calm, not twitchy.
          - infinityDolly false (default) keeps the world bounded.
      */}
      <CameraControls
        ref={controlsRef}
        makeDefault
        smoothTime={DEFAULT_SMOOTHTIME}
        draggingSmoothTime={0.14}
        dollySpeed={0.5}
        truckSpeed={2.2}
        azimuthRotateSpeed={0.8}
        polarRotateSpeed={0.8}
        minDistance={MIN_DOLLY_DISTANCE}
        maxDistance={MAX_DOLLY_DISTANCE}
      />
      {enableAmbientDrift && <AmbientDrift controlsRef={controlsRef} />}
      <FlyToTargets ref={targetsRef} clusters={clusters} onPick={onClusterSelect} />
    </>
  );
}
