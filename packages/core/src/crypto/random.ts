/**
 * Secure random helpers.
 *
 * - randomBytes(n): n random bytes via crypto.getRandomValues
 * - randomUuidV4(): RFC-4122 v4 UUID via crypto.randomUUID
 * - randomUlid():   Crockford-base32 ULID (26 chars, lexicographically sortable)
 *
 * All output is cryptographically secure (CSPRNG-backed).
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function getRng(): Crypto {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Secure RNG (crypto.getRandomValues) is not available');
  }
  return c;
}

/** Return `len` cryptographically random bytes. */
export function randomBytes(len: number): Uint8Array {
  if (!Number.isInteger(len) || len <= 0) {
    throw new Error(`randomBytes: len must be a positive integer (got ${len})`);
  }
  const out = new Uint8Array(len);
  getRng().getRandomValues(out);
  return out;
}

/** Return an RFC-4122 v4 UUID string. */
export function randomUuidV4(): string {
  const c = getRng();
  // crypto.randomUUID is available in Node 20+ and CF Workers.
  if (typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Fallback: build manually from 16 random bytes (set version + variant bits).
  const b = randomBytes(16);
  // biome-ignore lint/style/noNonNullAssertion: indexes 6, 8 are guaranteed in a 16-byte array
  b[6] = (b[6]! & 0x0f) | 0x40;
  // biome-ignore lint/style/noNonNullAssertion: see above
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < 16
    hex.push(b[i]!.toString(16).padStart(2, '0'));
  }
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * Generate a ULID: 48-bit timestamp (ms) + 80-bit randomness, encoded as 26
 * Crockford-base32 chars. Lexicographically sortable by time.
 */
export function randomUlid(now: number = Date.now()): string {
  if (!Number.isFinite(now) || now < 0) {
    throw new Error(`randomUlid: now must be a non-negative finite number (got ${now})`);
  }

  // 10 chars for time (48 bit), 16 chars for randomness (80 bit).
  const timeChars = encodeTime(now, 10);
  const rand = randomBytes(10);
  const randChars = encodeRandom(rand);
  return timeChars + randChars;
}

function encodeTime(timeMs: number, length: number): string {
  let t = Math.floor(timeMs);
  let out = '';
  for (let i = length - 1; i >= 0; i--) {
    const mod = t % 32;
    out = CROCKFORD.charAt(mod) + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes = 80 bits = 16 base32 chars. We bit-pack manually.
  let bitBuf = 0n;
  for (let i = 0; i < bytes.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < bytes.length
    bitBuf = (bitBuf << 8n) | BigInt(bytes[i]!);
  }
  let out = '';
  for (let i = 0; i < 16; i++) {
    const idx = Number(bitBuf & 31n);
    out = CROCKFORD.charAt(idx) + out;
    bitBuf >>= 5n;
  }
  return out;
}
