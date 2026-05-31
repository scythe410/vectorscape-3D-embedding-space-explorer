import type { CameraControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";

interface Props {
  controlsRef: React.RefObject<CameraControls | null>;
  /** Seconds of inactivity before the drift starts breathing. */
  idleDelaySec?: number;
  /** Radians/sec of azimuth drift once idle. Keep this tiny — design.md asks
   *  for "a breath, not an animation." 0.012 ≈ 0.7°/s. */
  azimuthSpeed?: number;
  /** Polar bob amplitude (radians) and period (sec) — a faint vertical sway. */
  polarAmplitude?: number;
  polarPeriodSec?: number;
}

/**
 * Subtle ambient camera drift when the user hasn't touched the controls in a
 * while. design.md: "When idle, the space drifts almost imperceptibly — a slow
 * parallax. Restraint is key."
 *
 * Approach: track CameraControls activity (controlstart / transitionstart /
 * rest) so we only drift in true rest. Every frame past the idle delay, nudge
 * azimuthAngle by a tiny delta — this writes the controls' *target* angle
 * (camera-controls then damps the displayed angle toward it), which keeps the
 * motion smooth and stops the instant the user touches the mouse.
 *
 * Crucially, this does NOT touch any BufferAttribute and adds no per-frame
 * geometry work — it's a single uniform-transform tick.
 */
export function AmbientDrift({
  controlsRef,
  idleDelaySec = 3.5,
  azimuthSpeed = 0.012,
  polarAmplitude = 0.015,
  polarPeriodSec = 22,
}: Props) {
  const stateRef = useRef({
    lastActivity: performance.now(),
    inMotion: false,
    polarBase: 0,
    polarOffset: 0,
  });

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const markActive = () => {
      stateRef.current.lastActivity = performance.now();
      stateRef.current.inMotion = true;
      // Reset the polar baseline so we don't snap when drift resumes.
      stateRef.current.polarBase = controls.polarAngle - stateRef.current.polarOffset;
      stateRef.current.polarOffset = 0;
    };
    const markRest = () => {
      stateRef.current.inMotion = false;
      stateRef.current.polarBase = controls.polarAngle;
      stateRef.current.polarOffset = 0;
    };
    controls.addEventListener("controlstart", markActive);
    controls.addEventListener("transitionstart", markActive);
    controls.addEventListener("rest", markRest);
    return () => {
      controls.removeEventListener("controlstart", markActive);
      controls.removeEventListener("transitionstart", markActive);
      controls.removeEventListener("rest", markRest);
    };
  }, [controlsRef]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const s = stateRef.current;
    if (s.inMotion) return;
    const idleSec = (performance.now() - s.lastActivity) / 1000;
    if (idleSec < idleDelaySec) return;

    // Ease in over ~1.5s so drift starts as a slow exhale, not a snap.
    const ease = Math.min(1, (idleSec - idleDelaySec) / 1.5);

    // Azimuth: continuous slow orbit. setAzimuthAngle(value, false) jumps the
    // target with no internal transition, which avoids fighting damping.
    controls.azimuthAngle += azimuthSpeed * delta * ease;

    // Polar: gentle sine bob around the baseline captured at last rest.
    const phase = ((performance.now() - s.lastActivity) / 1000 / polarPeriodSec) * Math.PI * 2;
    const target = Math.sin(phase) * polarAmplitude * ease;
    const polarDelta = target - s.polarOffset;
    s.polarOffset = target;
    controls.polarAngle += polarDelta;
  });

  return null;
}
