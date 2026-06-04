import Link from "next/link";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import HeroGalaxyMount from "./HeroGalaxyMount";
import XRWaitlist from "./XRWaitlist";

export default async function Home() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getUser();
  const sandboxHref = data.user ? "/sandbox" : "/login?next=/sandbox";

  return (
    <main className="relative min-h-screen overflow-hidden text-neutral-100">
      {/* Hero galaxy fills the viewport behind the content. */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <HeroGalaxyMount />
        {/* Soft vignette so the headline reads against the cores. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at 50% 40%, transparent 30%, rgba(5,6,10,0.55) 70%, rgba(5,6,10,0.9) 100%)",
          }}
        />
      </div>

      {/* Top nav — minimal, glass. */}
      <header className="relative z-10 flex items-center justify-between px-8 py-6">
        <Link
          href="/"
          className="font-display text-lg tracking-tight text-neutral-100 hover:text-accent"
        >
          VectorScape
        </Link>
        <nav className="flex items-center gap-6 text-xs uppercase tracking-[0.18em] text-neutral-400">
          <Link href="/lens" className="hover:text-neutral-100">
            Demo
          </Link>
          <Link href={sandboxHref} className="hover:text-neutral-100">
            Sandbox
          </Link>
        </nav>
      </header>

      {/* Hero — one memorable moment, generous negative space. */}
      <section className="relative z-10 mx-auto flex min-h-[78vh] max-w-4xl flex-col items-center justify-center px-6 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-accent/80">
          An observatory of meaning
        </p>
        <h1 className="mt-6 font-display text-5xl font-light leading-[1.05] tracking-tight text-neutral-50 sm:text-7xl md:text-[88px]">
          Fly through
          <br />
          your <em className="font-display italic text-accent">embeddings</em>.
        </h1>
        <p className="mt-7 max-w-xl text-balance text-base leading-relaxed text-neutral-400 sm:text-lg">
          A cartography of meaning rendered as deep space. Bring a CSV; watch
          it cluster as a galaxy you can move through.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:gap-4">
          <Link
            href="/lens"
            className="group inline-flex items-center gap-3 rounded-full bg-accent px-7 py-3 font-mono text-xs uppercase tracking-[0.2em] text-black transition hover:bg-accent-warm"
          >
            See the demo
            <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
              →
            </span>
          </Link>
          <Link
            href={sandboxHref}
            className="inline-flex items-center gap-3 rounded-full border border-white/15 bg-black/30 px-7 py-3 font-mono text-xs uppercase tracking-[0.2em] text-neutral-200 backdrop-blur-md transition hover:border-accent/40 hover:text-accent"
          >
            Bring your data
          </Link>
        </div>

        <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.22em] text-neutral-600">
          Drag · scroll · click · explore
        </p>
      </section>

      {/* Trailer-style "what it is" panel — quiet, three lines, then a long pause. */}
      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-32 text-center">
        <div className="space-y-6 font-display text-2xl font-light leading-snug text-neutral-300 sm:text-3xl">
          <p>Stars are documents.</p>
          <p>
            Constellations are <em className="italic text-accent">topics</em>.
          </p>
          <p>The dark between them is the question.</p>
        </div>
      </section>

      {/* XR coming soon — honest framing per design.md "framed honestly". */}
      <section className="relative z-10 mx-auto max-w-3xl px-6 pb-28">
        <XRWaitlist />
      </section>

      <footer className="relative z-10 mx-auto max-w-6xl px-6 pb-8 text-center font-mono text-[10px] uppercase tracking-[0.22em] text-neutral-600">
        VectorScape · v1.8.0 · WebGL2 + R3F
      </footer>
    </main>
  );
}
