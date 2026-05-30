"use client";

import dynamic from "next/dynamic";

const LensViewer = dynamic(() => import("./LensViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen w-screen items-center justify-center bg-black text-xs uppercase tracking-[0.2em] text-neutral-500">
      Booting galaxy…
    </div>
  ),
});

export default function LensClient() {
  return <LensViewer />;
}
