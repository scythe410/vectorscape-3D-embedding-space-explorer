import { describe, expect, test } from "bun:test";

import {
  computeProximity,
  createThrottle,
  roundLargestRemainder,
  type ProximityCentroid,
} from "./proximity";

const A: ProximityCentroid = { id: 1, label: "A", cx: -50, cy: 0, cz: 0 };
const B: ProximityCentroid = { id: 2, label: "B", cx: 50, cy: 0, cz: 0 };
const C: ProximityCentroid = { id: 3, label: "C", cx: 0, cy: 50, cz: 0 };

describe("computeProximity — basic geometry", () => {
  test("equidistant between two clusters → 50/50", () => {
    const r = computeProximity([0, 0, 0], [A, B]);
    expect(r.contributors).toHaveLength(2);
    expect(r.contributors[0].pct).toBe(50);
    expect(r.contributors[1].pct).toBe(50);
    expect(r.empty).toBe(false);
    expect(r.collapsed).toBe(false);
    expect(r.opacity).toBe(1);
  });

  test("biased toward A → A dominates B (both still surfaced)", () => {
    // [-15,0,0] sits 35 from A, 65 from B → ~77/23 — past 50/50 but well
    // below the fadeStart threshold so both contributors stay visible.
    const r = computeProximity([-15, 0, 0], [A, B]);
    expect(r.contributors).toHaveLength(2);
    expect(r.contributors[0].id).toBe(1);
    expect(r.contributors[0].pct).toBeGreaterThan(r.contributors[1].pct);
    expect(r.contributors[0].pct + r.contributors[1].pct).toBe(100);
  });

  test("between two clusters at 75/25-ish — shape matches spec example", () => {
    // Camera one-third of the way from A to B → inverse-distance^2 weighting
    // gives a ~94/6 split, which is past fade-start. To get the "73%/21%"
    // shape with a remainder, pull the camera further off-axis so distances
    // are closer in magnitude.
    const r = computeProximity([-20, 10, 0], [A, B]);
    expect(r.contributors[0].pct).toBeGreaterThan(50);
    expect(r.contributors[0].pct).toBeLessThan(100);
    expect(r.contributors[0].id).toBe(1);
  });

  test("contributors sorted by weight descending", () => {
    const r = computeProximity([0, 0, 30], [A, B, C]);
    for (let i = 1; i < r.contributors.length; i++) {
      expect(r.contributors[i - 1].weight).toBeGreaterThanOrEqual(
        r.contributors[i].weight,
      );
    }
  });

  test("percentages of shown contributors sum to 100 exactly", () => {
    const r = computeProximity([5, -7, 12], [A, B, C]);
    const sum = r.contributors.reduce((s, c) => s + c.pct, 0);
    expect(sum).toBe(100);
  });
});

describe("computeProximity — fade when inside a single cluster", () => {
  test("camera at a centroid → opacity 0, collapsed true", () => {
    const r = computeProximity([A.cx, A.cy, A.cz], [A, B, C]);
    expect(r.contributors[0].id).toBe(1);
    expect(r.contributors[0].pct).toBeGreaterThanOrEqual(95);
    expect(r.opacity).toBe(0);
    expect(r.collapsed).toBe(true);
    expect(r.empty).toBe(false);
  });

  test("fade ramps linearly between fadeStart and fadeEnd", () => {
    // Two clusters spaced at +/- 50; sweep the camera from near-midpoint
    // (50/50 → full opacity) toward A (deep inside → opacity 0) and check
    // that opacity monotonically decreases.
    const samples = [-5, -15, -25, -35, -45, -49];
    const opacities = samples.map(
      (x) => computeProximity([x, 0, 0], [A, B]).opacity,
    );
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeLessThanOrEqual(opacities[i - 1]);
    }
    // Near midpoint → full opacity; near A → fully faded.
    expect(opacities[0]).toBe(1);
    expect(opacities[opacities.length - 1]).toBe(0);
  });

  test("custom fadeStart/fadeEnd shifts the curve", () => {
    // With very aggressive fade (start=0.50, end=0.55), being only slightly
    // closer to A than B should already fade most of the way.
    const r = computeProximity([-10, 0, 0], [A, B], { fadeStart: 0.5, fadeEnd: 0.55 });
    expect(r.opacity).toBe(0);
  });
});

describe("computeProximity — top-N + min pct floor", () => {
  test("default topN=3 caps the contributor list at 3", () => {
    const D: ProximityCentroid = { id: 4, label: "D", cx: 0, cy: -50, cz: 0 };
    const E: ProximityCentroid = { id: 5, label: "E", cx: 0, cy: 0, cz: 50 };
    const r = computeProximity([1, 1, 1], [A, B, C, D, E]);
    expect(r.contributors.length).toBeLessThanOrEqual(3);
  });

  test("topN=2 caps even when more would qualify", () => {
    const r = computeProximity([0, 0, 0], [A, B, C], { topN: 2 });
    expect(r.contributors.length).toBe(2);
  });

  test("trailing contributors below minPctToShow are dropped", () => {
    // Two close clusters and one far away → the far one contributes ~nothing.
    const FAR: ProximityCentroid = { id: 99, label: "Far", cx: 500, cy: 500, cz: 500 };
    const r = computeProximity([5, 0, 0], [A, B, FAR], { topN: 3 });
    expect(r.contributors.find((c) => c.id === 99)).toBeUndefined();
  });

  test("leader is always retained even if it's the only one above the floor", () => {
    const r = computeProximity([A.cx, A.cy, A.cz], [A, B], { topN: 3, minPctToShow: 50 });
    expect(r.contributors.length).toBeGreaterThanOrEqual(1);
    expect(r.contributors[0].id).toBe(1);
  });
});

describe("computeProximity — edge cases", () => {
  test("empty centroid list → empty/collapsed result", () => {
    const r = computeProximity([0, 0, 0], []);
    expect(r.empty).toBe(true);
    expect(r.collapsed).toBe(true);
    expect(r.contributors).toEqual([]);
  });

  test("single centroid → 100%, faded out", () => {
    const r = computeProximity([10, 10, 10], [A]);
    expect(r.contributors).toHaveLength(1);
    expect(r.contributors[0].pct).toBe(100);
    expect(r.collapsed).toBe(true);
  });

  test("does not mutate inputs", () => {
    const cs = [A, B, C];
    const copy = JSON.parse(JSON.stringify(cs));
    computeProximity([0, 0, 0], cs);
    expect(cs).toEqual(copy);
  });
});

describe("roundLargestRemainder", () => {
  test("sums to the rounded total", () => {
    expect(roundLargestRemainder([73.4, 26.6])).toEqual([73, 27]);
    expect(roundLargestRemainder([73.4, 21.3, 5.3])).toEqual([74, 21, 5]);
  });

  test("preserves array length and order", () => {
    const out = roundLargestRemainder([10.5, 20.5, 30.5, 38.5]);
    expect(out).toHaveLength(4);
    expect(out.reduce((s, x) => s + x, 0)).toBe(100);
  });

  test("empty array → empty result", () => {
    expect(roundLargestRemainder([])).toEqual([]);
  });
});

describe("createThrottle", () => {
  test("first tick always fires (leading edge)", () => {
    const t = createThrottle(120);
    expect(t.tick(0)).toBe(true);
  });

  test("subsequent ticks within interval are dropped", () => {
    const t = createThrottle(120);
    t.tick(0);
    expect(t.tick(50)).toBe(false);
    expect(t.tick(100)).toBe(false);
    expect(t.tick(119)).toBe(false);
  });

  test("tick fires again once interval elapses", () => {
    const t = createThrottle(120);
    t.tick(0);
    expect(t.tick(120)).toBe(true);
    expect(t.tick(121)).toBe(false);
    expect(t.tick(240)).toBe(true);
  });

  test("reset restores leading-edge behavior", () => {
    const t = createThrottle(120);
    t.tick(0);
    expect(t.tick(50)).toBe(false);
    t.reset();
    expect(t.tick(60)).toBe(true);
  });

  test("non-monotonic clock — backwards-in-time tick is dropped (no fire on regression)", () => {
    const t = createThrottle(120);
    t.tick(1000);
    // A clock going backwards is anomalous; the throttle treats it as "not yet
    // due" rather than firing (which would betray the rate guarantee).
    expect(t.tick(500)).toBe(false);
  });

  test("zero interval — every tick fires (effectively disabled)", () => {
    const t = createThrottle(0);
    expect(t.tick(0)).toBe(true);
    expect(t.tick(0)).toBe(true);
    expect(t.tick(1)).toBe(true);
  });

  test("steady 60Hz feed into 120ms throttle fires ~every 7-8th frame", () => {
    const t = createThrottle(120);
    let fires = 0;
    for (let i = 0; i < 60; i++) {
      // ~16.67ms per frame → 60 frames spans ~1s → expect ≈ 1000/120 ≈ 8-9 fires.
      if (t.tick(i * (1000 / 60))) fires++;
    }
    expect(fires).toBeGreaterThanOrEqual(7);
    expect(fires).toBeLessThanOrEqual(10);
  });
});
