"use client";

import { useEffect, useState } from "react";

import CinematicGalaxy from "../components/CinematicGalaxy";
import { loadProjectFromUrl, type LoadedProject } from "../sandbox/loadProject";

const DEMO_URL = "/demo/skm-galaxy.json";

export default function LensViewer() {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    loadProjectFromUrl(DEMO_URL)
      .then((p) => {
        if (!cancelled) setLoaded(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setFetchError(e instanceof Error ? e.message : "network error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (fetchError) {
    return (
      <div className="m-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        Failed to load demo galaxy: {fetchError}
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black text-xs uppercase tracking-[0.2em] text-neutral-500">
        Booting galaxy…
      </div>
    );
  }

  return (
    <CinematicGalaxy
      loaded={loaded}
      scope="lens-skm"
      eyebrow="SKM lens"
      enterLabel="Skip intro"
      homeHref="/"
      showDatasetLink
    />
  );
}
