import { describe, expect, test } from "bun:test";

import { isPlaceholderLabel } from "./loadProject";

/**
 * The placeholder-label warning in loadProject.ts is the load-bearing
 * observability for the original bug class: a NULL or empty cluster label
 * collapses to "Cluster N" silently, and the user has no way to tell that
 * label generation failed.
 *
 * `isPlaceholderLabel` is the shared predicate. Its contract:
 *   - null / undefined / whitespace-only → placeholder
 *   - "Cluster 0", "cluster 12", " CLUSTER   3 " → placeholder (matches the
 *     pre-labels reducer's emit shape, case-insensitive, whitespace-flex)
 *   - "Stars Universe Galaxies" → real label
 *
 * Pinned here so a future refactor can't quietly slip the regex.
 */
describe("isPlaceholderLabel", () => {
  test("null / undefined / empty → placeholder", () => {
    expect(isPlaceholderLabel(null)).toBe(true);
    expect(isPlaceholderLabel(undefined)).toBe(true);
    expect(isPlaceholderLabel("")).toBe(true);
    expect(isPlaceholderLabel("   ")).toBe(true);
  });

  test("Cluster N shapes → placeholder (case + whitespace insensitive)", () => {
    expect(isPlaceholderLabel("Cluster 0")).toBe(true);
    expect(isPlaceholderLabel("cluster 12")).toBe(true);
    expect(isPlaceholderLabel("CLUSTER 3")).toBe(true);
    expect(isPlaceholderLabel("  Cluster 7  ")).toBe(true);
  });

  test("real labels → not placeholder", () => {
    expect(isPlaceholderLabel("Stars Universe Galaxies")).toBe(false);
    expect(isPlaceholderLabel("Js React App")).toBe(false);
    // A label that *contains* the word "cluster" but isn't the placeholder
    // shape must not false-positive.
    expect(isPlaceholderLabel("Cluster Computing")).toBe(false);
    expect(isPlaceholderLabel("Galaxy Clusters")).toBe(false);
  });
});
