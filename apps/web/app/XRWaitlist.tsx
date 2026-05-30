"use client";

import { useState, type FormEvent } from "react";

type Platform = "quest" | "vision_pro";

const PLATFORMS: Array<{ id: Platform; label: string; hint: string }> = [
  { id: "quest", label: "Meta Quest", hint: "Quest 3 · Quest Pro" },
  { id: "vision_pro", label: "Apple Vision Pro", hint: "visionOS" },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; already: boolean; platform: Platform }
  | { kind: "error"; message: string };

export default function XRWaitlist() {
  const [platform, setPlatform] = useState<Platform>("quest");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setStatus({ kind: "error", message: "Enter a valid email." });
      return;
    }
    setStatus({ kind: "submitting" });
    try {
      const resp = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, platform }),
      });
      const json = (await resp.json().catch(() => ({}))) as {
        error?: string;
        already?: boolean;
      };
      if (!resp.ok) {
        setStatus({ kind: "error", message: json.error || "Something went wrong." });
        return;
      }
      setStatus({ kind: "ok", already: Boolean(json.already), platform });
      setEmail("");
    } catch {
      setStatus({ kind: "error", message: "Network error — try again." });
    }
  }

  const submitting = status.kind === "submitting";

  return (
    <div className="mx-auto w-full max-w-xl rounded-2xl border border-white/10 bg-black/35 px-8 py-9 backdrop-blur-md">
      <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-accent/80">
        Coming next
      </p>
      <p className="mt-3 font-display text-2xl text-neutral-100 sm:text-3xl">
        Step inside on Quest &amp; Vision&nbsp;Pro
      </p>
      <p className="mt-3 text-sm leading-relaxed text-neutral-400">
        VectorScape runs in your browser today. Native headset apps are in
        development — no ship date yet. Join the waitlist for the platform
        you&apos;d use and we&apos;ll email you when the build is real.
      </p>

      <form onSubmit={onSubmit} className="mt-7 space-y-4" noValidate>
        <fieldset disabled={submitting} className="space-y-2">
          <legend className="font-mono text-[10px] uppercase tracking-[0.22em] text-neutral-500">
            Platform
          </legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {PLATFORMS.map((p) => {
              const active = platform === p.id;
              return (
                <label
                  key={p.id}
                  className={`cursor-pointer rounded-xl border px-4 py-3 text-left transition ${
                    active
                      ? "border-accent/60 bg-accent/10 text-neutral-50"
                      : "border-white/10 bg-black/20 text-neutral-300 hover:border-white/25"
                  }`}
                >
                  <input
                    type="radio"
                    name="platform"
                    value={p.id}
                    checked={active}
                    onChange={() => setPlatform(p.id)}
                    className="sr-only"
                  />
                  <span className="block font-display text-base leading-tight">
                    {p.label}
                  </span>
                  <span className="mt-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                    {p.hint}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="space-y-2">
          <label
            htmlFor="waitlist-email"
            className="block font-mono text-[10px] uppercase tracking-[0.22em] text-neutral-500"
          >
            Email
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="waitlist-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@domain.com"
              disabled={submitting}
              className="flex-1 rounded-full border border-white/10 bg-black/40 px-5 py-3 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-accent/50 focus:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 font-mono text-xs uppercase tracking-[0.2em] text-black transition hover:bg-accent-warm disabled:opacity-60"
            >
              {submitting ? "Saving…" : "Join waitlist"}
            </button>
          </div>
        </div>

        <div className="min-h-[1.25rem] font-mono text-[11px] tracking-wide" aria-live="polite">
          {status.kind === "ok" && (
            <span className="text-accent">
              {status.already
                ? "You're already on the list — we'll be in touch."
                : `You're on the ${status.platform === "quest" ? "Quest" : "Vision Pro"} list. Thanks.`}
            </span>
          )}
          {status.kind === "error" && (
            <span className="text-red-400">{status.message}</span>
          )}
        </div>
      </form>
    </div>
  );
}
