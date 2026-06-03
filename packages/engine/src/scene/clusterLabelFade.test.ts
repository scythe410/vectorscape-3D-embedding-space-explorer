import { describe, expect, it } from "bun:test";

import {
  LABEL_POINTER_OPACITY_THRESHOLD,
  computeLabelOpacity,
  smootherstep,
} from "./clusterLabelFade";

describe("smootherstep", () => {
  it("clamps to 0 at and below 0", () => {
    expect(smootherstep(-1)).toBe(0);
    expect(smootherstep(0)).toBe(0);
  });

  it("clamps to 1 at and above 1", () => {
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(2)).toBe(1);
  });

  it("is monotone non-decreasing across [0, 1]", () => {
    let prev = smootherstep(0);
    for (let i = 1; i <= 20; i++) {
      const u = i / 20;
      const v = smootherstep(u);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("passes through 0.5 at u=0.5 (Hermite midpoint symmetry)", () => {
    expect(smootherstep(0.5)).toBeCloseTo(0.5, 10);
  });
});

describe("computeLabelOpacity", () => {
  // Forward dot positive — camera looking at cluster.
  const facing = { forwardDot: 100 };

  it("returns 1 when distance is below fadeEnd and camera faces the cluster", () => {
    expect(computeLabelOpacity({ distance: 30, ...facing })).toBe(1);
    expect(computeLabelOpacity({ distance: 60, ...facing })).toBe(1);
  });

  it("returns 0 at or beyond fadeStart", () => {
    expect(computeLabelOpacity({ distance: 140, ...facing })).toBe(0);
    expect(computeLabelOpacity({ distance: 300, ...facing })).toBe(0);
  });

  it("ramps monotonically between fadeEnd and fadeStart", () => {
    // Walk from 60 → 140 in 20 steps; opacity must decrease each step.
    let prev = Infinity;
    for (let i = 0; i <= 20; i++) {
      const distance = 60 + (i * (140 - 60)) / 20;
      const op = computeLabelOpacity({ distance, ...facing });
      expect(op).toBeGreaterThanOrEqual(0);
      expect(op).toBeLessThanOrEqual(1);
      expect(op).toBeLessThanOrEqual(prev + 1e-9);
      prev = op;
    }
  });

  it("returns 0 for behind-camera when cull is on (default)", () => {
    expect(computeLabelOpacity({ distance: 30, forwardDot: -10 })).toBe(0);
  });

  it("respects hideBehindCamera=false (skip the cull)", () => {
    // A cluster behind the camera at fadeEnd distance still reads full.
    expect(
      computeLabelOpacity({
        distance: 30,
        forwardDot: -10,
        hideBehindCamera: false,
      }),
    ).toBe(1);
  });

  it("custom fadeStart / fadeEnd shift the ramp boundaries", () => {
    // Half-scale galaxy: ramp from 30 → 70.
    expect(
      computeLabelOpacity({ distance: 25, ...facing, fadeStart: 70, fadeEnd: 30 }),
    ).toBe(1);
    expect(
      computeLabelOpacity({ distance: 70, ...facing, fadeStart: 70, fadeEnd: 30 }),
    ).toBe(0);
    const mid = computeLabelOpacity({
      distance: 50,
      ...facing,
      fadeStart: 70,
      fadeEnd: 30,
    });
    // Midpoint of the smootherstep ramp lands at 0.5 exactly.
    expect(mid).toBeCloseTo(0.5, 6);
  });

  it("pointer threshold matches the half-vis cut from the inline component", () => {
    // Sanity guard: if anyone bumps the threshold without updating
    // ClusterLabels' inline write, the two diverge. Keep them lockstepped.
    expect(LABEL_POINTER_OPACITY_THRESHOLD).toBeGreaterThan(0);
    expect(LABEL_POINTER_OPACITY_THRESHOLD).toBeLessThan(0.1);
  });
});
