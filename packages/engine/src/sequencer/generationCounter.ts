// Monotonic generation counter used to invalidate in-flight async sequences.
//
// The flythrough scheduler and the imperative fly-to / flyToPoint / resetView
// handlers share a single counter. Starting a new sequence captures its `myGen`
// at `start()`; every `await` inside the sequence checks `isStale(myGen)` and
// bails if the counter has moved. `bump()` is the cancel verb — any user nudge
// (drag, cluster click, skip button, a new flyTo, etc.) bumps it, and any
// in-flight sequence sees the change on its next await point and exits cleanly
// without touching shared state past that point.
//
// Pure: no closures over external mutable state, no I/O. The component owns
// the instance via `useRef(createGenerationCounter())` so React's render
// cycle never replaces it.

export interface GenerationCounter {
  /** Current generation value. Useful for snapshotting before an await. */
  readonly current: number;
  /**
   * Start a new sequence. Bumps the counter and returns the new value so the
   * caller can stash it as `myGen` and compare on each await point.
   */
  start(): number;
  /**
   * Cancel any in-flight sequence. Same effect as `start()` minus the return
   * value — just moves the counter forward so existing snapshots become stale.
   */
  bump(): void;
  /**
   * True if `myGen` no longer matches the current counter — i.e. some other
   * action started a newer sequence (or called `bump()`).
   */
  isStale(myGen: number): boolean;
}

export function createGenerationCounter(initial = 0): GenerationCounter {
  let value = initial;
  return {
    get current() {
      return value;
    },
    start() {
      value += 1;
      return value;
    },
    bump() {
      value += 1;
    },
    isStale(myGen: number) {
      return value !== myGen;
    },
  };
}
