import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// The monorepo's .env lives at the repo root, not in apps/web. Next.js by
// default only reads .env from this app's directory, so we load the root file
// here once at config time and inject anything web needs.
function loadRootEnv() {
  const rootEnvPath = path.resolve(__dirname, "../../.env");
  try {
    const text = readFileSync(rootEnvPath, "utf8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No root .env — leave env alone; per-app .env.local still works.
  }
}
loadRootEnv();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The engine workspace ships ESM-only via Vite. Next.js needs to transpile
  // it so the App Router bundler doesn't choke on its imports.
  transpilePackages: ["engine"],
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  },
};

export default nextConfig;
