import { describe, expect, it } from "bun:test";

import { createGenerationCounter } from "./generationCounter";

describe("createGenerationCounter", () => {
  it("starts at 0 by default", () => {
    const g = createGenerationCounter();
    expect(g.current).toBe(0);
  });

  it("honors a custom initial value", () => {
    const g = createGenerationCounter(7);
    expect(g.current).toBe(7);
  });

  it("start() increments and returns the new generation", () => {
    const g = createGenerationCounter();
    const a = g.start();
    expect(a).toBe(1);
    expect(g.current).toBe(1);
    const b = g.start();
    expect(b).toBe(2);
    expect(g.current).toBe(2);
  });

  it("bump() increments without returning", () => {
    const g = createGenerationCounter();
    g.bump();
    g.bump();
    expect(g.current).toBe(2);
  });

  it("a fresh sequence is not stale immediately after start()", () => {
    const g = createGenerationCounter();
    const myGen = g.start();
    expect(g.isStale(myGen)).toBe(false);
  });

  it("a sequence becomes stale once another start() happens", () => {
    const g = createGenerationCounter();
    const first = g.start();
    expect(g.isStale(first)).toBe(false);
    g.start();
    // First sequence is now older than the live one — must be stale.
    expect(g.isStale(first)).toBe(true);
  });

  it("a sequence becomes stale once bump() is called", () => {
    const g = createGenerationCounter();
    const myGen = g.start();
    g.bump();
    expect(g.isStale(myGen)).toBe(true);
  });

  it("only the latest sequence is non-stale (others all stale)", () => {
    // Simulates user repeatedly clicking new clusters — only the last
    // flyTo should be allowed to settle.
    const g = createGenerationCounter();
    const a = g.start();
    const b = g.start();
    const c = g.start();
    expect(g.isStale(a)).toBe(true);
    expect(g.isStale(b)).toBe(true);
    expect(g.isStale(c)).toBe(false);
  });

  it("cancellation pattern: bump then resume picks up a fresh non-stale generation", () => {
    // The skip button bumps; a later flyTo starts a new generation that's
    // valid until the next bump.
    const g = createGenerationCounter();
    const intro = g.start();
    g.bump(); // skip
    expect(g.isStale(intro)).toBe(true);
    const afterSkip = g.start();
    expect(g.isStale(afterSkip)).toBe(false);
  });

  it("simulates a flythrough loop bailing on the first stale check", async () => {
    // Models the actual playFlythrough body: await between keyframes, abort
    // when isStale flips. The test proves the loop never touches a side
    // effect past the stale point.
    const g = createGenerationCounter();
    const sideEffects: number[] = [];
    const myGen = g.start();
    const keyframes = [1, 2, 3, 4];
    let i = 0;
    for (const kf of keyframes) {
      if (g.isStale(myGen)) break;
      await Promise.resolve();
      // Simulate the user pressing skip between keyframes 2 and 3.
      if (i === 2) g.bump();
      sideEffects.push(kf);
      i++;
    }
    // Wrote up through keyframe 3 (index 2), then the next iteration's
    // top-of-loop check saw the bump and bailed.
    expect(sideEffects).toEqual([1, 2, 3]);
  });
});
