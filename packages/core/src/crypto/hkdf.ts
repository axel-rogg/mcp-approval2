/**
 * HKDF-SHA-256 key derivation.
 *
 * Two implementations are exported:
 *  - hkdfSha256 (Web-Crypto-based, default — runs on Node 20+ and CF Workers)
 *  - hkdfSha256Sync (Noble-hashes-based, sync — handy for tests and tight loops)
 *
 * Plus higher-level helpers used across mcp-approval2:
 *  - deriveRecordKey: per-record 32-byte AES key, salted by recordType + version.
 *  - deriveAuditKey:  audit-HMAC key.
 */

import { hkdf as nobleHkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

const enc = new TextEncoder();

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available');
  }
  return c.subtle;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? enc.encode(input) : input;
}

/**
 * HKDF-SHA-256: derive `length` bytes from `ikm`, salted by `salt`, info-tagged
 * with `info`. Returns a fresh Uint8Array.
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | string,
  info: Uint8Array | string,
  length: number,
): Promise<Uint8Array> {
  if (ikm.byteLength === 0) {
    throw new Error('hkdfSha256: ikm must not be empty');
  }
  if (length <= 0 || !Number.isInteger(length)) {
    throw new Error(`hkdfSha256: length must be a positive integer (got ${length})`);
  }

  const key = await getSubtle().importKey(
    'raw',
    ikm as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await getSubtle().deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toBytes(salt) as BufferSource,
      info: toBytes(info) as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Synchronous HKDF-SHA-256 (noble-hashes). Useful in test setup and code paths
 * that cannot be async. Output is identical to hkdfSha256().
 */
export function hkdfSha256Sync(
  ikm: Uint8Array,
  salt: Uint8Array | string,
  info: Uint8Array | string,
  length: number,
): Uint8Array {
  if (ikm.byteLength === 0) {
    throw new Error('hkdfSha256Sync: ikm must not be empty');
  }
  if (length <= 0 || !Number.isInteger(length)) {
    throw new Error(
      `hkdfSha256Sync: length must be a positive integer (got ${length})`,
    );
  }
  return nobleHkdf(sha256, ikm, toBytes(salt), toBytes(info), length);
}

/**
 * Per-record AES-256-GCM key:
 *   HKDF(MASTER_KEY, salt=recordType, info=`${recordType}|${recordId}|v${version}`, 32)
 */
export async function deriveRecordKey(
  masterKey: Uint8Array,
  recordType: string,
  recordId: string,
  version: number,
): Promise<Uint8Array> {
  return hkdfSha256(
    masterKey,
    recordType,
    `${recordType}|${recordId}|v${version}`,
    32,
  );
}

/**
 * Audit HMAC key:
 *   HKDF(MASTER_KEY, salt=zeros(32), info='audit-hmac', 32)
 *
 * Cheap; recompute per request rather than caching globally.
 */
export async function deriveAuditKey(masterKey: Uint8Array): Promise<Uint8Array> {
  return hkdfSha256(masterKey, new Uint8Array(32), 'audit-hmac', 32);
}
