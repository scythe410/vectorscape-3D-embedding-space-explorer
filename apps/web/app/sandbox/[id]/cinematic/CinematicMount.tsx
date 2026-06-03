"use client";

import dynamic from "next/dynamic";

// R3F's <Canvas> accesses `window` at module-eval time — defer the engine
// import to the client. Matches the pattern used by SandboxUI for
// SandboxViewer. ssr:false is only allowed inside client components in
// Next 15+, hence this wrapper.
const CinematicClient = dynamic(() => import("./CinematicClient"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-black text-xs uppercase tracking-[0.2em] text-neutral-500">
      Booting galaxy…
    </div>
  ),
});

export default function CinematicMount({ projectId }: { projectId: string }) {
  return <CinematicClient projectId={projectId} />;
}
