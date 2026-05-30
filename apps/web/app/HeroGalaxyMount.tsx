"use client";

import dynamic from "next/dynamic";

const HeroGalaxy = dynamic(() => import("./HeroGalaxy"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-black" />,
});

export default function HeroGalaxyMount() {
  return <HeroGalaxy />;
}
