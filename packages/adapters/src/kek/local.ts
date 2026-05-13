/**
 * LocalKekProvider — Master-Key aus Env, HKDF-derived per-ref KEK.
 *
 * Verwendung: Dev/Tests. NICHT fuer Production (Master-Key liegt
 * unverschluesselt im Worker-Env / Container-Env). Production benutzt
 * `OpenBaoKekProvider`.
 *
 * Crypto-Stack:
 *   - HKDF-SHA-256(masterKey, salt=utf8(ref), info='mcp-approval2-kek-v1')
 *     → 32-byte per-ref KEK
 *   - AES-256-GCM(perRefKek, nonce=12, aad=utf8(ref)) zum Wrap des DEK
 *   - destroyKey: in-memory Set blockiert spaetere `unwrap`/`wrap`-Calls
 *     (Crypto-Shred-Simulation; persistent fuer Tests reicht das Process-Memory).
 *
 * Plan-Reference: docs/plans/active/PLAN-architecture-v1.md §5.
 */

import { webcrypto as nodeWebCrypto } from 'node:crypto';

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

import type { KekProvider, KekRef } from './interface.js';

const HKDF_INFO = new TextEncoder().encode('mcp-approval2-kek-v1');
const NONCE_LEN = 12;
const KEK_LEN = 32;

// Subtle wird im Webworker/Browser global verfuegbar sein; in Node 20+
// gibt's `webcrypto`. Wir nehmen je nachdem.
const subtle: SubtleCrypto =
  (globalThis as typeof globalThis & { crypto?: Crypto }).crypto?.subtle ??
  nodeWebCrypto.subtle;

export interface LocalKekProviderOptions {
  /**
   * 32-byte Master-Key. In Dev aus Env-Var, hex-decoded. Wird per HKDF
   * pro ref zu einem stabilen per-ref KEK derived.
   */
  readonly masterKey: Uint8Array;
}

function randomBytes(len: number): Uint8Array {
  const out = new Uint8Array(len);
  const c =
    (globalThis as typeof globalThis & { crypto?: Crypto }).crypto ??
    nodeWebCrypto;
  c.getRandomValues(out);
  return out;
}

function deriveKek(masterKey: Uint8Array, ref: KekRef): Uint8Array {
  const salt = new TextEncoder().encode(ref);
  return hkdf(sha256, masterKey, salt, HKDF_INFO, KEK_LEN);
}

/** Kopiert die Bytes in eine neue, sicher-typisierte `ArrayBuffer`. */
function toArrayBuffer(raw: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(raw.byteLength);
  copy.set(raw);
  return copy.buffer;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey(
    'raw',
    toArrayBuffer(raw),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export class LocalKekProvider implements KekProvider {
  private readonly masterKey: Uint8Array;
  private readonly destroyed = new Set<KekRef>();

  public constructor(opts: LocalKekProviderOptions) {
    if (opts.masterKey.byteLength !== 32) {
      throw new Error(
        `LocalKekProvider: masterKey must be 32 bytes (got ${opts.masterKey.byteLength}).`,
      );
    }
    this.masterKey = opts.masterKey;
  }

  public async wrap(dek: Uint8Array, ref: KekRef): Promise<Uint8Array> {
    this.assertAlive(ref);
    if (dek.byteLength === 0) {
      throw new Error('LocalKekProvider.wrap: empty dek');
    }
    const kek = deriveKek(this.masterKey, ref);
    const key = await importAesKey(kek);
    const nonce = randomBytes(NONCE_LEN);
    const aad = new TextEncoder().encode(ref);
    const ctBuf = await subtle.encrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad) },
      key,
      toArrayBuffer(dek),
    );
    const ct = new Uint8Array(ctBuf);
    const out = new Uint8Array(NONCE_LEN + ct.byteLength);
    out.set(nonce, 0);
    out.set(ct, NONCE_LEN);
    return out;
  }

  public async unwrap(wrapped: Uint8Array, ref: KekRef): Promise<Uint8Array> {
    this.assertAlive(ref);
    if (wrapped.byteLength < NONCE_LEN + 16) {
      throw new Error(
        `LocalKekProvider.unwrap: ciphertext too short (${wrapped.byteLength} bytes)`,
      );
    }
    const nonce = wrapped.subarray(0, NONCE_LEN);
    const ct = wrapped.subarray(NONCE_LEN);
    const kek = deriveKek(this.masterKey, ref);
    const key = await importAesKey(kek);
    const aad = new TextEncoder().encode(ref);
    const ptBuf = await subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(nonce), additionalData: toArrayBuffer(aad) },
      key,
      toArrayBuffer(ct),
    );
    return new Uint8Array(ptBuf);
  }

  public async rotate(oldRef: KekRef, newRef: KekRef): Promise<void> {
    // LocalKekProvider hat keine persistente Key-Registry; rotate() ist
    // ein No-Op-Lifecycle-Marker. Der Caller (mcp-approval2-core) macht
    // die eigentliche Re-Wrap-Iteration ueber alle credentials-Rows.
    this.assertAlive(oldRef);
    if (oldRef === newRef) return;
    return Promise.resolve();
  }

  public async destroyKey(ref: KekRef): Promise<void> {
    // Crypto-Shred-Simulation: markiere ref als destroyed. Spaetere
    // wrap/unwrap mit diesem ref werfen. Master-Key bleibt, aber HKDF
    // mit identischem ref ist ohnehin deterministisch — ohne die Block-
    // Liste waere "destroy" wirkungslos. Production-Provider (OpenBao)
    // hat echtes Key-Material-Vernichten.
    this.destroyed.add(ref);
    return Promise.resolve();
  }

  private assertAlive(ref: KekRef): void {
    if (this.destroyed.has(ref)) {
      throw new Error(
        `LocalKekProvider: key ref "${ref}" is destroyed (crypto-shredded).`,
      );
    }
  }
}
