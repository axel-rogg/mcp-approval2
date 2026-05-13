/**
 * XOR helper for PRF-DEK combination.
 *
 * PLAN-architecture-v1.md §5.3 — PRF-Layer:
 *   effectiveDek = rawDek XOR prfOutput
 *
 * Both inputs are 32-byte (256-bit) buffers; the function is its own inverse:
 *   xor(xor(a, b), b) === a
 *
 * Constant-time in length (always iterates fixed length), and validates lengths
 * up-front to avoid silent truncation.
 */

export const PRF_DEK_LEN = 32;

/**
 * XOR two equal-length byte arrays, returning a fresh Uint8Array.
 * Throws if lengths differ or either input is not exactly PRF_DEK_LEN bytes.
 */
export function xorPrfDek(a: Uint8Array, b: Uint8Array): Uint8Array {
  assertLen('a', a);
  assertLen('b', b);
  const out = new Uint8Array(PRF_DEK_LEN);
  for (let i = 0; i < PRF_DEK_LEN; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds enforced by assertLen
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

/**
 * Generic equal-length XOR helper (any length). Returns a fresh Uint8Array.
 * Throws on length mismatch.
 */
export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength !== b.byteLength) {
    throw new Error(
      `xorBytes: length mismatch (${a.byteLength} vs ${b.byteLength})`,
    );
  }
  const out = new Uint8Array(a.byteLength);
  for (let i = 0; i < a.byteLength; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < a.byteLength
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

function assertLen(field: string, buf: Uint8Array): void {
  if (buf.byteLength !== PRF_DEK_LEN) {
    throw new Error(
      `xorPrfDek: ${field} must be ${PRF_DEK_LEN} bytes (got ${buf.byteLength})`,
    );
  }
}
