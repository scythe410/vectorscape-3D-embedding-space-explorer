/**
 * Pure helpers for the "what's in here, broadly?" intro title card. Kept
 * framework-free so the selection + once-per-session logic can be unit tested
 * without a React renderer.
 */

export interface SizedCluster {
  cluster_id: number;
  label: string | null;
  size: number;
}

/**
 * Pick the top-N clusters by size for the title card. Skips noise (cluster_id < 0)
 * since "noise" is not a place. Ties break by cluster_id ascending so two
 * equally-sized clusters render in a stable order across reloads.
 */
export function selectTopClusters<T extends SizedCluster>(
  clusters: readonly T[],
  n = 8,
): T[] {
  if (n <= 0) return [];
  const eligible = clusters.filter((c) => c.cluster_id >= 0 && c.size > 0);
  const sorted = [...eligible].sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return a.cluster_id - b.cluster_id;
  });
  return sorted.slice(0, n);
}

const STORAGE_KEY_PREFIX = "vs:titlecard-seen:";

/**
 * Minimal storage shape — accepts the browser `sessionStorage` or any object
 * with `getItem`/`setItem`. Tests pass an in-memory fake.
 */
export interface TitleCardStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function shouldShowTitleCard(
  scope: string,
  store: TitleCardStore | null | undefined,
): boolean {
  if (!store) return false;
  try {
    return store.getItem(STORAGE_KEY_PREFIX + scope) !== "1";
  } catch {
    return false;
  }
}

export function markTitleCardSeen(
  scope: string,
  store: TitleCardStore | null | undefined,
): void {
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY_PREFIX + scope, "1");
  } catch {
    // sessionStorage can throw under privacy modes; we silently degrade —
    // worst case the card shows again on the next navigation.
  }
}

/** Read the browser's sessionStorage, guarded for SSR. */
export function getSessionStorage(): TitleCardStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
