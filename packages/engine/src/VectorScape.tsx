import { CameraControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
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
import { ClusterEdges } from "./scene/ClusterEdges";
import { ClusterLabels } from "./scene/ClusterLabels";
import { FlyToTargets, type FlyToTargetsHandle } from "./scene/FlyToTargets";
import { PointPicker } from "./scene/PointPicker";
import { PointsCloud } from "./scene/PointsCloud";
import { createGenerationCounter } from "./sequencer/generationCounter";
import type {
  ClusterCentroid,
  ClusterEdge,
  ClusterPickOptions,
  PointsData,
  RenderStats,
  ScenePose,
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
  /**
   * Indices that must survive the voxel filter. Search highlighting uses this
   * so matched points are guaranteed to render even on >budget datasets where
   * the cell representative would otherwise be a different point.
   */
  mustKeepIndices?: Uint32Array | null;
  /** Reports total/kept counts after the voxel pass. */
  onStats?: (stats: RenderStats) => void;
  /**
   * Camera + target on first paint. The Canvas opens its camera at this
   * position and CameraControls' internal target is synced to match before
   * any user input or scripted move. Use this to avoid a "default-pose
   * flash" when the host plans to immediately drive the camera (e.g., a
   * cinematic intro). Default position [0, 0, 60] looking at the origin.
   */
  initialPose?: ScenePose;
  /**
   * Fires once after the renderer mounts and `initialPose` has been
   * applied to the controls. Hosts use this to kick scripted camera
   * moves without racing the Canvas mount via setTimeout.
   */
  onReady?: () => void;
  /**
   * Fires with the camera's world-space position on (effectively) every frame
   * while the camera is in motion. The engine emits unthrottled — hosts that
   * setState on this should throttle themselves (see `lib/proximity.ts`
   * `createThrottle`). When the camera is at rest, emissions stop until it
   * moves again, so an idle galaxy doesn't keep the host's React tree busy.
   */
  onCameraMove?: (position: [number, number, number]) => void;
  /**
   * Semantic adjacency edges between cluster pairs. Pre-computed server-side
   * in embedding space; the engine just draws them faintly. Caller is
   * responsible for the top-N cap — pass at most a few or the calm breaks.
   * Off by default in every consumer (opt-in toggle), so omit or pass [] to
   * render nothing.
   */
  edges?: ClusterEdge[];
  onEdgeHover?: (edge: ClusterEdge | null) => void;
  onEdgeClick?: (edge: ClusterEdge) => void;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_INITIAL_POSE: ScenePose = {
  position: [0, 0, 60],
  target: [0, 0, 0],
};

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
      mustKeepIndices,
      onStats,
      initialPose = DEFAULT_INITIAL_POSE,
      onReady,
      onCameraMove,
      edges,
      onEdgeHover,
      onEdgeClick,
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
      () => voxelDownsample(points.position, budget, undefined, mustKeepIndices),
      [points, budget, mustKeepIndices],
    );

    useEffect(() => {
      onStats?.({
        total: points.position.length / 3,
        kept: downsample.kept.length,
        downsampled: downsample.downsampled,
      });
    }, [downsample, points, onStats]);

    const fogColor = useMemo(() => new THREE.Color(background), [background]);

    // Shared focus-point vector for the DOF pass. Lives at the renderer root
    // so SceneController (inside Canvas) can write the live camera-target into
    // it each frame, and <DepthOfField> can read the same instance — that's
    // how postprocessing implements true autofocus: target gets projected into
    // camera space per frame and its depth becomes focusDistance. Seeded from
    // initialPose so the very first DOF frame focuses on the opening look-at,
    // not the origin. Allocated once; never replaced.
    const dofTarget = useMemo(
      () =>
        new THREE.Vector3(
          initialPose.target[0],
          initialPose.target[1],
          initialPose.target[2],
        ),
      // initialPose is opening-pose only; later target changes flow through
      // the per-frame controls.getTarget() write in SceneController.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

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
          camera={{ position: initialPose.position, fov: 50, near: 0.1, far: 2000 }}
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
            initialPose={initialPose}
            onReady={onReady}
            dofTarget={dofTarget}
          />

          {onCameraMove && <CameraReporter onMove={onCameraMove} />}

          {showClusterLabels && clusters.length > 0 && (
            <ClusterLabels clusters={clusters} />
          )}

          {edges && edges.length > 0 && clusters.length > 0 && (
            <ClusterEdges
              edges={edges}
              centroids={clusters}
              onEdgeHover={onEdgeHover}
              onEdgeClick={onEdgeClick}
            />
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
            DOF first so subsequent passes work in focused space. The pass
            autofocuses on `dofTarget` — that vector is synced each frame
            inside SceneController to the CameraControls look-at point, so
            whatever the user has framed (cluster fly-to, manual drag) is
            what stays sharp. `focalLength` widens the in-focus slice enough
            to keep a whole cluster crisp once framed; `bokehScale` is dialed
            down from the earlier static-focus value because real autofocus
            no longer needs an oversized blur radius to mask wrong focus.
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
                target={dofTarget}
                focalLength={0.05}
                bokehScale={2.0}
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
  initialPose,
  onReady,
  dofTarget,
}: {
  clusters: ClusterCentroid[];
  onClusterSelect?: (id: ClusterCentroid["id"], opts: ClusterPickOptions) => void;
  handleRef: React.ForwardedRef<VectorScapeHandle>;
  enableAmbientDrift: boolean;
  initialPose: ScenePose;
  onReady?: () => void;
  /**
   * Shared focus point used by the DOF pass. We rewrite it each frame from
   * the live CameraControls target so autofocus tracks fly-to and manual
   * drags without any host plumbing.
   */
  dofTarget: THREE.Vector3;
}) {
  const controlsRef = useRef<CameraControls>(null);
  const targetsRef = useRef<FlyToTargetsHandle>(null);
  const { camera } = useThree();
  // Monotonic counter — every cancel/new play bumps it; in-flight loops bail
  // when they see a stale id. Cleaner than threading AbortControllers through
  // a Promise chain. Backed by a pure factory (see sequencer/generationCounter)
  // so the cancel-preempts-stale contract is unit-tested without React.
  const flythroughGen = useRef(createGenerationCounter()).current;
  // Capture onReady in a ref so the mount effect's empty-deps closure never
  // calls a stale callback if the host re-renders with a new function.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Sync controls' internal target to initialPose and signal readiness exactly
  // once on first mount. The Canvas already opened its camera at
  // initialPose.position; this aligns the controls so the next user input or
  // playFlythrough call doesn't snap from a stale [0,0,0] default target.
  useEffect(() => {
    let cancelled = false;
    const apply = () => {
      const controls = controlsRef.current;
      if (!controls) {
        // CameraControls ref hasn't committed yet — try again next frame.
        if (!cancelled) requestAnimationFrame(apply);
        return;
      }
      void controls.setLookAt(
        initialPose.position[0],
        initialPose.position[1],
        initialPose.position[2],
        initialPose.target[0],
        initialPose.target[1],
        initialPose.target[2],
        false,
      );
      onReadyRef.current?.();
    };
    apply();
    return () => {
      cancelled = true;
    };
    // Intentionally fire-once: initialPose is the *opening* pose, not a
    // controlled value. Hosts who want to move the camera later use the
    // imperative handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      flyTo: (id) => {
        flythroughGen.bump();
        const controls = controlsRef.current;
        if (!controls) return;
        // Drive framing from the cluster data directly instead of the invisible
        // FlyToTargets mesh. The mesh path depended on a ref + world matrix
        // chain that can no-op silently if the renderer hasn't painted the
        // sphere yet (visible={false} on a freshly mounted mesh) — the cluster
        // record gives us the exact sphere with no plumbing to break.
        const cluster = clusters.find((c) => c.id === id);
        if (!cluster) return;
        // Mac trackpads keep emitting wheel events with tiny deltas; without
        // stop() those queued dolly targets pre-empt fitToSphere within a
        // frame and the click reads as "nothing happened."
        controls.stop();
        const sphere = new THREE.Sphere(
          new THREE.Vector3(cluster.cx, cluster.cy, cluster.cz),
          cluster.radius ?? 5,
        );
        // Cinematic smoothing just for the fly-to. The steady-state
        // smoothTime is lower so wheel-driven dolly snaps instead of drifting.
        const prevSmooth = controls.smoothTime;
        controls.smoothTime = CINEMATIC_SMOOTHTIME;
        void controls.fitToSphere(sphere, true).finally(() => {
          controls.smoothTime = prevSmooth;
        });
      },
      flyToPoint: (position, radius = 3) => {
        flythroughGen.bump();
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
        flythroughGen.bump();
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
      playFlythrough: async (keyframes, options) => {
        const controls = controlsRef.current;
        if (!controls || keyframes.length === 0) return;
        const myGen = flythroughGen.start();
        const defaultSmooth = controls.smoothTime;
        try {
          if (options?.initialHoldMs && options.initialHoldMs > 0) {
            await new Promise((r) => setTimeout(r, options.initialHoldMs));
            if (flythroughGen.isStale(myGen)) return;
          }
          for (const kf of keyframes) {
            if (flythroughGen.isStale(myGen)) return;
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
            if (flythroughGen.isStale(myGen)) return;
            if (kf.holdMs && kf.holdMs > 0) {
              await new Promise((r) => setTimeout(r, kf.holdMs));
            }
          }
        } finally {
          controls.smoothTime = defaultSmooth;
        }
      },
      cancelFlythrough: () => {
        flythroughGen.bump();
      },
    }),
    [camera],
  );

  return (
    <>
      {/*
        Motion feel per design.md "Motion (the heart of it)" — split-smoothTime
        model (do not collapse to a single steady-state value):
          - smoothTime DEFAULT_SMOOTHTIME (0.3) → snappy steady-state / wheel
            dolly. A higher steady-state (e.g. 0.65) lets trackpad two-finger
            scroll dolly drift after the gesture stops and lock at min/max;
            0.3 is the fix. Fly-to bumps to CINEMATIC_SMOOTHTIME (0.65) for
            the cinematic arrival, then restores via .finally().
          - draggingSmoothTime 0.14 → drag stays responsive but the release
            coasts and settles instead of stopping dead.
          - dollySpeed 0.5 → wheel zoom is calm, not twitchy (trackpad-safe).
          - minDistance/maxDistance bound the world; infinityDolly stays off.
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
      <DofAutofocus controlsRef={controlsRef} target={dofTarget} />
      <FlyToTargets ref={targetsRef} clusters={clusters} onPick={onClusterSelect} />
    </>
  );
}

/**
 * Emits the camera's world-space position to the host on every frame *that the
 * camera has actually moved*. Idle frames are skipped (no React state churn,
 * no per-frame allocation past a single Float32 comparison) so the proximity
 * readout settles cleanly when the user stops flying.
 *
 * The host is responsible for throttling its setState — see `createThrottle`
 * in apps/web/lib/proximity.ts. We intentionally don't throttle inside the
 * engine so different surfaces can pick their own cadence.
 */
/**
 * Per-frame sync of the CameraControls look-at point into the shared DOF
 * target Vector3. The DOF pass (in EffectComposer above) reads the same
 * instance to compute focusDistance each frame, so whatever the controls
 * are framing — a cluster fly-to, a manual orbit, the intro flythrough
 * — is exactly what stays sharp.
 *
 * Cost: one Vector3 write per frame regardless of whether DOF is enabled;
 * negligible against the render pass, and keeping the write unconditional
 * means there's no first-frame stale-focus when the user toggles DOF on.
 */
function DofAutofocus({
  controlsRef,
  target,
}: {
  controlsRef: React.RefObject<CameraControls | null>;
  target: THREE.Vector3;
}) {
  useFrame(() => {
    controlsRef.current?.getTarget(target);
  });
  return null;
}

function CameraReporter({
  onMove,
}: {
  onMove: (pos: [number, number, number]) => void;
}) {
  const { camera } = useThree();
  // Latest callback in a ref so a host re-render with a new closure doesn't
  // require remounting this component.
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  // Track the last emitted position so we can early-out on idle frames. 0.001
  // world units is well below any visible motion at the 350k-point budget.
  const lastRef = useRef<[number, number, number]>([NaN, NaN, NaN]);
  useFrame(() => {
    const x = camera.position.x;
    const y = camera.position.y;
    const z = camera.position.z;
    const [lx, ly, lz] = lastRef.current;
    if (Math.abs(x - lx) < 0.001 && Math.abs(y - ly) < 0.001 && Math.abs(z - lz) < 0.001) {
      return;
    }
    lastRef.current = [x, y, z];
    onMoveRef.current([x, y, z]);
  });
  return null;
}
