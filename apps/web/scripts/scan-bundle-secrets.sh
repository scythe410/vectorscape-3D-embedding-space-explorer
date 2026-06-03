#!/usr/bin/env bash
# Scan the built Next.js client bundle for known server-only secrets.
#
# The browser receives every byte in `.next/static/`. Anything secret that
# ends up there is publicly readable. We assert:
#
#   1. SUPABASE_SERVICE_ROLE_KEY (the variable name AND its current value)
#      does not appear in any client chunk.
#   2. REDUCER_SHARED_SECRET (the variable name AND its current value)
#      does not appear in any client chunk.
#
# Positive control: the anon key SHOULD appear in the client bundle (it's
# meant to be public). If it doesn't, the build itself is broken.
#
# Run after `bun run build`:
#
#   ./scripts/scan-bundle-secrets.sh
#
# Exits 0 on clean, 1 on any leak.

set -euo pipefail

STATIC_DIR="${1:-.next/static}"

if [ ! -d "$STATIC_DIR" ]; then
  echo "error: $STATIC_DIR not found. Run 'bun run build' first." >&2
  exit 2
fi

fail=0

# Variable NAMES — these should not appear in client code (Next only inlines
# NEXT_PUBLIC_*). If a NAME appears it usually means somebody wrote
# `process.env.SUPABASE_SERVICE_ROLE_KEY` from a client component.
for name in SUPABASE_SERVICE_ROLE_KEY REDUCER_SHARED_SECRET SUPABASE_DB_PASSWORD; do
  hits=$(grep -rl "$name" "$STATIC_DIR" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "LEAK: variable name '$name' appears in client bundle:" >&2
    echo "$hits" >&2
    fail=1
  else
    echo "ok: '$name' name absent from client bundle"
  fi
done

# Variable VALUES — only check if the env var is currently set in the shell.
# We compare the actual bytes; even a partial match (first 12 chars) is
# enough signal to flag a leak.
check_value() {
  local name="$1"
  local val="${!name:-}"
  if [ -z "$val" ]; then
    echo "skip: $name not set in env (value scan skipped)"
    return
  fi
  # Use a 12-char prefix so we don't have to worry about line splits in
  # minified output; secrets are long and high-entropy enough that a
  # 12-char hit is a real match.
  local prefix="${val:0:12}"
  hits=$(grep -rl "$prefix" "$STATIC_DIR" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "LEAK: value of $name (prefix '$prefix') appears in client bundle:" >&2
    echo "$hits" >&2
    fail=1
  else
    echo "ok: value of $name absent from client bundle"
  fi
}

check_value SUPABASE_SERVICE_ROLE_KEY
check_value REDUCER_SHARED_SECRET
check_value SUPABASE_DB_PASSWORD

# Positive control: the anon key SHOULD be inlined into the client bundle.
# If it isn't, the build's env-inlining is broken (which would also break
# the app at runtime).
if [ -n "${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}" ]; then
  prefix="${NEXT_PUBLIC_SUPABASE_ANON_KEY:0:8}"
  if grep -rl "$prefix" "$STATIC_DIR" >/dev/null 2>&1; then
    echo "ok: positive control — NEXT_PUBLIC_SUPABASE_ANON_KEY did inline into the client bundle (expected)"
  else
    echo "WARN: positive control — NEXT_PUBLIC_SUPABASE_ANON_KEY did NOT inline into the client bundle. Build env may be wrong." >&2
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "scan-bundle-secrets: FAIL — one or more server-only secrets reached the client bundle." >&2
  exit 1
fi

echo ""
echo "scan-bundle-secrets: PASS"
exit 0
