import { describe, expect, test } from "bun:test";

import {
  markTitleCardSeen,
  selectTopClusters,
  shouldShowTitleCard,
  type SizedCluster,
  type TitleCardStore,
} from "./titleCard";

function makeStore(): TitleCardStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

describe("selectTopClusters", () => {
  const cs: SizedCluster[] = [
    { cluster_id: 0, label: "Stars", size: 50 },
    { cluster_id: 1, label: "Cooking", size: 120 },
    { cluster_id: 2, label: "Programming", size: 80 },
    { cluster_id: 3, label: "Politics", size: 200 },
    { cluster_id: 4, label: "Music", size: 20 },
  ];

  test("returns top-N ordered by size descending", () => {
    const top = selectTopClusters(cs, 3);
    expect(top.map((c) => c.cluster_id)).toEqual([3, 1, 2]);
  });

  test("default N is 8", () => {
    const top = selectTopClusters(cs);
    expect(top.length).toBe(5);
    expect(top[0].cluster_id).toBe(3);
    expect(top[4].cluster_id).toBe(4);
  });

  test("N larger than available clusters returns all eligible", () => {
    const top = selectTopClusters(cs, 100);
    expect(top.length).toBe(5);
  });

  test("ties break by cluster_id ascending (stable)", () => {
    const tied: SizedCluster[] = [
      { cluster_id: 5, label: "Five", size: 100 },
      { cluster_id: 2, label: "Two", size: 100 },
      { cluster_id: 9, label: "Nine", size: 100 },
    ];
    const top = selectTopClusters(tied, 3);
    expect(top.map((c) => c.cluster_id)).toEqual([2, 5, 9]);
  });

  test("skips noise (cluster_id < 0)", () => {
    const withNoise: SizedCluster[] = [
      { cluster_id: -1, label: null, size: 999 },
      { cluster_id: 0, label: "Real", size: 10 },
    ];
    const top = selectTopClusters(withNoise, 8);
    expect(top.map((c) => c.cluster_id)).toEqual([0]);
  });

  test("skips empty clusters (size <= 0)", () => {
    const withEmpty: SizedCluster[] = [
      { cluster_id: 0, label: "Empty", size: 0 },
      { cluster_id: 1, label: "Real", size: 5 },
    ];
    expect(selectTopClusters(withEmpty, 8).map((c) => c.cluster_id)).toEqual([1]);
  });

  test("n <= 0 returns empty", () => {
    expect(selectTopClusters(cs, 0)).toEqual([]);
    expect(selectTopClusters(cs, -3)).toEqual([]);
  });

  test("does not mutate the input", () => {
    const original = [...cs];
    selectTopClusters(cs, 3);
    expect(cs).toEqual(original);
  });
});

describe("title card show-once + dismiss", () => {
  test("first visit shows the card", () => {
    const store = makeStore();
    expect(shouldShowTitleCard("lens-skm", store)).toBe(true);
  });

  test("after marking seen, the card does not show again (dismissed)", () => {
    const store = makeStore();
    expect(shouldShowTitleCard("lens-skm", store)).toBe(true);
    markTitleCardSeen("lens-skm", store);
    expect(shouldShowTitleCard("lens-skm", store)).toBe(false);
  });

  test("scopes are independent — sandbox project A doesn't dismiss project B", () => {
    const store = makeStore();
    markTitleCardSeen("sandbox-aaa", store);
    expect(shouldShowTitleCard("sandbox-aaa", store)).toBe(false);
    expect(shouldShowTitleCard("sandbox-bbb", store)).toBe(true);
    expect(shouldShowTitleCard("lens-skm", store)).toBe(true);
  });

  test("null store returns false (SSR safe — no card during server render)", () => {
    expect(shouldShowTitleCard("lens-skm", null)).toBe(false);
  });

  test("a throwing store degrades to no-card / no-throw", () => {
    const broken: TitleCardStore = {
      getItem: () => {
        throw new Error("disabled");
      },
      setItem: () => {
        throw new Error("disabled");
      },
    };
    expect(shouldShowTitleCard("lens-skm", broken)).toBe(false);
    expect(() => markTitleCardSeen("lens-skm", broken)).not.toThrow();
  });
});
