"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  getSessionStorage,
  markTitleCardSeen,
  selectTopClusters,
  shouldShowTitleCard,
  type SizedCluster,
} from "../../lib/titleCard";

/**
 * "What's in here, broadly?" — a documentary title card showing the named
 * regions of a galaxy before the camera flies in. Editorial, dark, cinematic
 * per design.md: a beat of stillness with the place's terrain in words, then
 * dissolves and hands off to the live galaxy.
 *
 * Once per session per scope. Skippable. Reads the top-N regions from the
 * cluster sizes the host already loaded — no new data fetch.
 */

interface Props {
  /** Clusters from `loadProject`. The component picks top-N by size itself. */
  clusters: readonly SizedCluster[];
  /**
   * Stable id for show-once gating. `"lens-skm"` for the SKM demo,
   * `"sandbox-<projectId>"` for a sandbox project.
   */
  scope: string;
  /** Big eyebrow over the region list (e.g. galaxy name). */
  title: string;
  /** Quiet line under the title (e.g. "12,540 documents · 8 regions"). */
  subtitle?: string;
  /** Top-N to show. 8–10 is the design target. Default 8. */
  topN?: number;
  /**
   * How long to hold the card before auto-dissolve, in ms. ~2s is the target
   * from the spec — "answers the first question in ~2 seconds."
   */
  holdMs?: number;
  /** Dissolve duration in ms. Matches the CSS transition. */
  fadeMs?: number;
  /**
   * Called after the card has fully dissolved (or was skipped). The host fires
   * its flythrough / hands the user the controls here.
   */
  onComplete: () => void;
}

export default function RegionTitleCard({
  clusters,
  scope,
  title,
  subtitle,
  topN = 8,
  holdMs = 10000,
  fadeMs = 500,
  onComplete,
}: Props) {
  // Decision is taken on mount so the gate runs exactly once per logical
  // entrance. Storing the decision in state (not a ref) keeps render output
  // a pure function of state.
  const [decision] = useState<"show" | "skip">(() => {
    const store = getSessionStorage();
    return shouldShowTitleCard(scope, store) ? "show" : "skip";
  });

  // Three render states for the visible path: hidden (pre-mount paint), shown
  // (faded in, holding), dissolving (fading out toward onComplete). The skip
  // path bypasses all of this and fires onComplete in an effect.
  const [phase, setPhase] = useState<"hidden" | "shown" | "dissolving">(
    decision === "show" ? "hidden" : "hidden",
  );
  // Once true the component returns null — fully unmounts so the invisible
  // overlay can't block pointer events on the canvas beneath.
  const [done, setDone] = useState(false);
  // Countdown seconds shown on the enter button — ticks from ceil(holdMs/1000)
  // down to 0, giving the card a cinematic "launching in N" feel.
  const [countdown, setCountdown] = useState(Math.ceil(holdMs / 1000));

  // Guard against double-fire: the auto-dissolve timer and a user skip can
  // race. Whoever lands first wins; the other is a no-op.
  const completedRef = useRef(false);
  const fire = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    onComplete();
    setDone(true);
  };

  const top = useMemo(() => selectTopClusters(clusters, topN), [clusters, topN]);

  // Skip path — call onComplete on next tick so the parent can render its
  // post-intro UI without a sync re-render during this component's mount.
  useEffect(() => {
    if (decision !== "skip") return;
    const t = setTimeout(fire, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision]);

  // Show path — schedule fade-in, hold, dissolve, complete.
  useEffect(() => {
    if (decision !== "show") return;
    const store = getSessionStorage();
    markTitleCardSeen(scope, store);

    // Fade in next frame so the initial paint catches the hidden-opacity
    // state and the transition actually animates.
    const inT = requestAnimationFrame(() => setPhase("shown"));
    const dissolveT = setTimeout(() => setPhase("dissolving"), holdMs);
    const doneT = setTimeout(fire, holdMs + fadeMs);
    return () => {
      cancelAnimationFrame(inT);
      clearTimeout(dissolveT);
      clearTimeout(doneT);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision, scope, holdMs, fadeMs]);

  // Tick the countdown every second while the card is visible.
  useEffect(() => {
    if (phase !== "shown") return;
    const id = setInterval(() => {
      setCountdown((c) => (c > 0 ? c - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Enter key dismisses the card immediately.
  useEffect(() => {
    if (decision !== "show") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      if (completedRef.current) return;
      e.preventDefault();
      setPhase("dissolving");
      setTimeout(fire, fadeMs);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decision, fadeMs]);

  if (decision === "skip" || done) return null;

  const visible = phase === "shown";
  const dissolving = phase === "dissolving";

  const dismiss = () => {
    if (completedRef.current) return;
    setPhase("dissolving");
    // Wait the dissolve duration so the user sees the dissolve too, then fire.
    setTimeout(fire, fadeMs);
  };

  // If there are no real regions (all noise, fresh upload), just complete
  // immediately rather than showing an empty card.
  if (top.length === 0) {
    if (!completedRef.current) {
      completedRef.current = true;
      // Defer to next tick to keep render pure.
      queueMicrotask(onComplete);
    }
    return null;
  }

  const regionCount = top.length;

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-[60] flex items-center justify-center bg-black"
      style={{
        // Backdrop is fully opaque from first paint so the galaxy beneath
        // doesn't flash through before the card fades in. Only the dissolve
        // (exit) animates opacity; entry is handled by the list-item stagger.
        opacity: dissolving ? 0 : 1,
        transition: `opacity ${fadeMs}ms ease-out`,
      }}
      role="dialog"
      aria-label="Galaxy overview"
      onClick={dismiss}
    >
      {/* Faint vignette + a hair of cool tint so the card matches the galaxy
          backdrop instead of pure black. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(20,28,48,0.35) 0%, rgba(5,6,10,0.85) 70%, #000 100%)",
        }}
      />

      <div
        className="relative flex max-w-3xl flex-col items-center px-8 text-center"
        // Inner content shouldn't fire dismiss on click of a child unless the
        // child intends to — but the whole card is dismissable on click, so
        // we let the bubble through to the outer onClick.
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-amber-200/80">
          {regionCount === 1 ? "One region" : `${regionCount} regions`}
        </div>
        <div className="mt-2 font-display text-2xl leading-tight text-neutral-50 sm:text-3xl">
          {title}
        </div>
        {subtitle ? (
          <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-neutral-500">
            {subtitle}
          </div>
        ) : null}

        <div className="mt-7 h-px w-24 bg-gradient-to-r from-transparent via-amber-300/40 to-transparent" />

        <ul className="mt-7 grid w-full grid-cols-1 gap-x-10 gap-y-2 text-left sm:grid-cols-2">
          {top.map((c, i) => (
            <li
              key={c.cluster_id}
              className="flex items-baseline gap-3 text-neutral-200"
              style={{
                opacity: visible ? 1 : 0,
                transform: visible ? "translateY(0)" : "translateY(6px)",
                transition: `opacity 600ms ease-out ${i * 70}ms, transform 600ms ease-out ${i * 70}ms`,
              }}
            >
              <span className="w-6 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-600">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="flex-1 truncate font-display text-[15px] leading-snug">
                {c.label && c.label.trim() !== ""
                  ? c.label
                  : `Cluster ${c.cluster_id}`}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-neutral-500">
                {c.size}
              </span>
            </li>
          ))}
        </ul>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          className="mt-10 rounded-full border border-white/15 bg-black/40 px-5 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-neutral-300 backdrop-blur-md transition hover:border-amber-300/60 hover:text-amber-200"
          aria-label="Skip overview"
        >
          enter{countdown > 0 ? ` ${countdown}` : ""} ↵
        </button>
      </div>
    </div>
  );
}
