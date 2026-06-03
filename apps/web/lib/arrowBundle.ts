// vs-arrow-bundle envelope codec.
//
// Wire format:
//   [4-byte little-endian uint32 metaLen][metaJSON utf8][Arrow IPC bytes]
//
// The server builds the envelope in `/api/projects/[id]/data`; the client
// decodes it in `loadProject.ts`. Both sides import these primitives so the
// format is impossible to drift between encoder and decoder without breaking
// the round-trip test.
//
// Sentinels for null in the Arrow columns (kept here as documentation; both
// sides bake them into / interpret them from the typed arrays directly):
//   - cluster_id   : int32, -1 means noise
//   - cluster_probability : float32, NaN means unknown

export const ARROW_BUNDLE_CONTENT_TYPE =
  "application/octet-stream; format=vs-arrow-bundle";

/**
 * Pack a JSON-serializable meta blob plus pre-encoded Arrow IPC bytes into
 * the envelope bytes. Returns a Uint8Array that can be written to a Response
 * or stashed in a test fixture.
 */
export function packArrowBundle(meta: unknown, arrowBytes: Uint8Array): Uint8Array {
  const metaJson = JSON.stringify(meta);
  const metaBytes = new TextEncoder().encode(metaJson);
  const out = new Uint8Array(4 + metaBytes.byteLength + arrowBytes.byteLength);
  // The DataView is over the Uint8Array's underlying buffer; the buffer is
  // freshly allocated so it's guaranteed to be an ArrayBuffer (not Shared).
  new DataView(out.buffer).setUint32(0, metaBytes.byteLength, true);
  out.set(metaBytes, 4);
  out.set(arrowBytes, 4 + metaBytes.byteLength);
  return out;
}

/**
 * Unpack the envelope bytes back into the meta JSON object and the inner
 * Arrow IPC bytes. The Arrow bytes are returned as a Uint8Array view into
 * the input buffer (no copy) — callers should not mutate them.
 */
export function unpackArrowBundle<TMeta = unknown>(
  buf: ArrayBuffer,
): { meta: TMeta; arrowBytes: Uint8Array } {
  if (buf.byteLength < 4) {
    throw new Error("vs-arrow-bundle: buffer too short to contain header");
  }
  const view = new DataView(buf);
  const metaLen = view.getUint32(0, true);
  if (4 + metaLen > buf.byteLength) {
    throw new Error(
      `vs-arrow-bundle: meta length ${metaLen} exceeds buffer (${buf.byteLength})`,
    );
  }
  const metaBytes = new Uint8Array(buf, 4, metaLen);
  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as TMeta;
  const arrowBytes = new Uint8Array(buf, 4 + metaLen, buf.byteLength - 4 - metaLen);
  return { meta, arrowBytes };
}
