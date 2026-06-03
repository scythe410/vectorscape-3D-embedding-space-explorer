"use client";

import { useEffect, useState } from "react";

import CinematicGalaxy from "../../../components/CinematicGalaxy";
import { loadProject, type LoadedProject } from "../../loadProject";

interface Props {
  projectId: string;
}

/**
 * Sandbox project rendered in the cinematic frame — same title card,
 * flythrough, and chrome as /lens, but loading the user's auth'd project
 * via /api/projects/[id]/data.
 */
export default function CinematicClient({ projectId }: Props) {
  const [loaded, setLoaded] = useState<LoadedProject | null>(null);
  const [fetchError, setFetchError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFetchError(undefined);
    loadProject(projectId)
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
  }, [projectId]);

  if (fetchError) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-black px-6 text-center">
        <div className="max-w-md rounded-md border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          Failed to load galaxy: {fetchError}
          <div className="mt-3">
            <a
              href="/sandbox"
              className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-300 underline hover:text-neutral-100"
            >
              ← back to sandbox
            </a>
          </div>
        </div>
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
      scope={`sandbox-cinematic-${projectId}`}
      eyebrow="Sandbox · cinematic"
      enterLabel="Explore"
      homeHref="/sandbox"
      projectId={projectId}
    />
  );
}
