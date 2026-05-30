"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function LoginForm({
  next,
  initialSent,
  initialError,
}: {
  next?: string;
  initialSent: boolean;
  initialError?: string;
}) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(initialSent);
  const [error, setError] = useState<string | undefined>(initialError);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(undefined);
    const supabase = createSupabaseBrowserClient();
    const redirectTo = `${window.location.origin}/auth/callback${
      next ? `?next=${encodeURIComponent(next)}` : ""
    }`;
    const { error: err } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-4 text-sm">
        <div className="font-medium">Check your inbox.</div>
        <p className="mt-1 text-neutral-400">
          A sign-in link was sent to{" "}
          <span className="text-neutral-200">{email || "your email"}</span>. Click it to
          continue.
        </p>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="mt-3 text-xs text-neutral-400 underline hover:text-neutral-200"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label className="block">
        <span className="text-xs uppercase tracking-wider text-neutral-400">Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
          placeholder="you@example.com"
        />
      </label>
      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting || !email}
        className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
      >
        {submitting ? "Sending…" : "Send magic link"}
      </button>
    </form>
  );
}
