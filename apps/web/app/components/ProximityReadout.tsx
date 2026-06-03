"use client";

import { useCallback, useMemo, useState } from "react";

import {
  computeProximity,
  createThrottle,
  type ProximityCentroid,
  type ProximityOptions,
  type ProximityResult,
} from "../../lib/proximity";

/**
 * "You are mostly in X, partly Y." — a quiet glass readout that tracks the
 * camera's position against the named cluster centroids and surfaces the top
 * 2-3 contributors as percentages.
 *
 * Per design.md: glass (translucent dark + hairline border + blurred backdrop),
 * monospace for the numbers (instrument feel), recessive body weight for the
 * names. Fades to zero when the camera is deep inside one cluster ("100% X"
 * is uninformative — silence is the right answer there).
 */

/**
 * Host hook: wires the engine's per-frame `onCameraMove` into a throttled
 * React state update. Returns `cameraPos` (latest throttled position) and
 * `onCameraMove` (the prop you pass to <VectorScape>).
 */
export function useTrackedCamera(throttleMs = 120): {
  cameraPos: [number, number, number] | null;
  onCameraMove: (pos: [number, number, number]) => void;
} {
  const [cameraPos, setCameraPos] = useState<[number, number, number] | null>(null);
  const throttle = useMemo(() => createThrottle(throttleMs), [throttleMs]);
  const onCameraMove = useCallback(
    (pos: [number, number, number]) => {
      if (!throttle.tick(performance.now())) return;
      setCameraPos(pos);
    },
    [throttle],
  );
  return { cameraPos, onCameraMove };
}

interface Props {
  cameraPos: [number, number, number] | null;
  centroids: readonly ProximityCentroid[];
  options?: ProximityOptions;
  /** Visual position of the readout. Default "bottom-center". */
  position?: "bottom-center" | "top-center";
}

export default function ProximityReadout({
  cameraPos,
  centroids,
  options,
  position = "bottom-center",
}: Props) {
  const result: ProximityResult | null = useMemo(() => {
    if (!cameraPos) return null;
    return computeProximity(cameraPos, centroids, options);
  }, [cameraPos, centroids, options]);

  const positionClass =
    position === "top-center"
      ? "left-1/2 top-6 -translate-x-1/2"
      : "bottom-6 left-1/2 -translate-x-1/2";

  // Stay mounted across collapse/uncollapse so the opacity transition reads
  // as a fade rather than a pop. The pointer-none wrapper keeps it
  // non-interactive in either state.
  const visible = result != null && !result.empty && !result.collapsed;

  return (
    <div
      className={"pointer-events-none absolute z-30 select-none " + positionClass}
      style={{
        opacity: visible ? result.opacity : 0,
        transition: "opacity 350ms ease-out",
      }}
      aria-live="polite"
      aria-hidden={!visible}
    >
      {visible ? (
        <div className="flex items-baseline gap-3 rounded-full border border-white/10 bg-black/40 px-4 py-1.5 backdrop-blur-md">
          <span className="font-mono text-[9px] uppercase tracking-[0.28em] text-neutral-500">
            position
          </span>
          <div className="flex items-baseline gap-2">
            {result.contributors.map((c, i) => (
              <span key={c.id} className="flex items-baseline gap-1">
                {i > 0 ? (
                  <span className="px-1 text-[10px] text-neutral-600">·</span>
                ) : null}
                <span className="font-mono text-[12px] tabular-nums text-amber-200/90">
                  {c.pct}%
                </span>
                <span className="max-w-[160px] truncate text-[12px] text-neutral-200">
                  {c.label}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
