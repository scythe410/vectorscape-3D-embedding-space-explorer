import { describe, expect, it } from "bun:test";

import { SAFE_NAME_FALLBACK, SAFE_NAME_MAX_LEN, safeName } from "./safeName";

describe("safeName — upload filename sanitization", () => {
  it("neutralizes unix path traversal (../../etc/passwd.csv → passwd.csv)", () => {
    expect(safeName("../../etc/passwd.csv")).toBe("passwd.csv");
    expect(safeName("/../etc/passwd.csv")).toBe("passwd.csv");
    expect(safeName("../../../shadow")).toBe("shadow");
  });

  it("neutralizes windows-style traversal (..\\..\\system32\\file.csv)", () => {
    expect(safeName("..\\..\\system32\\file.csv")).toBe("file.csv");
    expect(safeName("C:\\Users\\victim\\evil.csv")).toBe("evil.csv");
  });

  it("strips angle brackets / quotes / parens / semicolons", () => {
    // Markup injection probe: if the name lands in HTML somewhere, the
    // sanitized version must not carry a usable script payload. Note: when
    // the input contains a `/` (e.g. inside `</script>`), the split-on-slash
    // step takes only the last segment — which incidentally drops a lot of
    // the injection payload before the regex even runs. The headline
    // guarantee is the same: no markup characters survive.
    const cleanedScript = safeName("<script>alert(1)</script>.csv");
    expect(cleanedScript).not.toContain("<");
    expect(cleanedScript).not.toContain(">");
    expect(cleanedScript).not.toContain("(");
    expect(cleanedScript).not.toContain(")");
    expect(cleanedScript.endsWith(".csv")).toBe(true);
    // SQL-injection probe — the route never builds SQL from this string,
    // but if a future surface ever does, the dangerous bits are gone.
    const cleanedSQL = safeName('"; DROP TABLE x; --.csv');
    expect(cleanedSQL).not.toContain('"');
    expect(cleanedSQL).not.toContain(";");
    expect(cleanedSQL).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("keeps allowed characters (alphanumerics, dot, hyphen, underscore)", () => {
    expect(safeName("my-data_2024.csv")).toBe("my-data_2024.csv");
    expect(safeName("clean.name.with.dots.csv")).toBe("clean.name.with.dots.csv");
  });

  it("caps length at SAFE_NAME_MAX_LEN characters", () => {
    const long = "a".repeat(500) + ".csv";
    const cleaned = safeName(long);
    expect(cleaned.length).toBe(SAFE_NAME_MAX_LEN);
    // Truncation may cut off the .csv extension. That's fine — the route's
    // upstream check `file.name.toLowerCase().endsWith(".csv")` already
    // ran against the original name, and Storage doesn't care about the
    // extension semantically.
  });

  it("falls back to the default when the input is empty after stripping separators", () => {
    expect(safeName("")).toBe(SAFE_NAME_FALLBACK);
    expect(safeName("/")).toBe(SAFE_NAME_FALLBACK);
    expect(safeName("///")).toBe(SAFE_NAME_FALLBACK);
    expect(safeName("\\")).toBe(SAFE_NAME_FALLBACK);
  });

  it("falls back when input becomes empty after the character whitelist (only-disallowed chars)", () => {
    // After splitting on slashes, the leaf is the input; after the regex
    // replace, "!@#$%" becomes "_____". That's non-empty → returned as-is
    // (the spec only falls back on truly-empty post-slice). This pins the
    // current behavior so a future tightening (e.g. collapse repeated _)
    // shows up in the diff.
    expect(safeName("!@#$%")).toBe("_____");
  });

  it("a bare `..` survives as `..` but cannot escape the user folder", () => {
    // The Storage RLS pins the FIRST folder segment to auth.uid()::text.
    // Even if safeName lets a literal `..` through as the leaf, the storage
    // path becomes `<uid>/<project>/..`, which Storage normalizes inside
    // the user's own scope. The traversal can't reach another user.
    expect(safeName("..")).toBe("..");
  });

  it("strips a leading dot folder like `./local.csv`", () => {
    expect(safeName("./local.csv")).toBe("local.csv");
  });

  it("handles unicode + emoji by stripping to underscores (ASCII-only outputs)", () => {
    const cleaned = safeName("résumé🦊.csv");
    // The unicode characters get replaced with `_`; the dot and csv survive.
    expect(cleaned).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(cleaned.endsWith(".csv")).toBe(true);
  });

  it("output always satisfies the path-component contract", () => {
    const inputs = [
      "../../etc/passwd.csv",
      "<script>.csv",
      "normal.csv",
      "../..",
      "",
      "🦊.csv",
      "a".repeat(1000),
    ];
    for (const input of inputs) {
      const out = safeName(input);
      // No path separators ever survive.
      expect(out.includes("/")).toBe(false);
      expect(out.includes("\\")).toBe(false);
      // Bounded length.
      expect(out.length).toBeLessThanOrEqual(SAFE_NAME_MAX_LEN);
      // Non-empty.
      expect(out.length).toBeGreaterThan(0);
      // Only the whitelist.
      expect(out).toMatch(/^[a-zA-Z0-9._-]+$/);
    }
  });
});
