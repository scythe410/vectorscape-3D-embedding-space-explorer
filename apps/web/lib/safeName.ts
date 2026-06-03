// Sanitize a filename for use as a Storage object path component.
//
// The upload route writes to `csv-uploads/<user_id>/<project_id>/<filename>`.
// The filename comes from the browser `File.name`, which an attacker controls.
// Without sanitization an attacker can ship a name like `../../etc/passwd.csv`
// or `<script>alert(1)</script>.csv` and either:
//   (a) traverse out of the user's folder under the Storage RLS scope, or
//   (b) inject markup if the name is ever surfaced verbatim in a UI.
//
// Rules:
//   1. Strip every path separator. We only care about the leaf — slashes and
//      backslashes are never legitimate inside a single filename.
//   2. After stripping separators, replace anything outside [a-zA-Z0-9._-]
//      with `_`. Specifically, `..` survives because `.` is allowed, but the
//      slashes are gone, so `../../etc/passwd.csv` already became `passwd.csv`
//      by step 1. A bare `..` survives as `..` — that's still a leaf in the
//      Storage path and the RLS policy pins the leading segment to auth.uid()
//      so `..` cannot escape the user's folder anyway.
//   3. Cap to 120 characters so Storage object names stay manageable.
//   4. Fall back to `upload.csv` if the result is empty.

export const SAFE_NAME_MAX_LEN = 120;
export const SAFE_NAME_FALLBACK = "upload.csv";

export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() || SAFE_NAME_FALLBACK;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, SAFE_NAME_MAX_LEN);
  return cleaned || SAFE_NAME_FALLBACK;
}
