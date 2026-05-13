/**
 * AES-256-GCM encrypt/decrypt using the Web Crypto API (subtle.crypto).
 *
 * Works on Node 20+ (globalThis.crypto.subtle) and CF Workers.
 *
 * - Key: 32 bytes (256 bit) raw.
 * - Nonce: 12 bytes; auto-generated if omitted. NEVER reuse a (key, nonce) pair.
 * - AAD: string (UTF-8) or raw bytes; authenticated but not encrypted.
 * - Tag: 128 bit, appended to ciphertext by Web-Crypto.
 */

import { aadBytes } from './aad.js';
import { randomBytes } from './random.js';

const NONCE_LEN = 12;
const TAG_LEN_BITS = 128;
const KEY_LEN = 32;

export interface AesGcmEncryptArgs {
  key: Uint8Array;
  plaintext: Uint8Array;
  aad: string | Uint8Array;
  nonce?: Uint8Array;
}

export interface AesGcmEncryptResult {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export interface AesGcmDecryptArgs {
  key: Uint8Array;
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  aad: string | Uint8Array;
}

function getSubtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) is not available');
  }
  return c.subtle;
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== KEY_LEN) {
    throw new Error(
      `AES-256-GCM key must be ${KEY_LEN} bytes, got ${rawKey.byteLength}`,
    );
  }
  return getSubtle().importKey(
    'raw',
    rawKey as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function aesGcmEncrypt(
  args: AesGcmEncryptArgs,
): Promise<AesGcmEncryptResult> {
  const nonce = args.nonce ?? randomBytes(NONCE_LEN);
  if (nonce.byteLength !== NONCE_LEN) {
    throw new Error(`AES-GCM nonce must be ${NONCE_LEN} bytes`);
  }

  const key = await importAesKey(args.key);
  const aad = aadBytes(args.aad);

  const ctBuf = await getSubtle().encrypt(
    {
      name: 'AES-GCM',
      iv: nonce as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: TAG_LEN_BITS,
    },
    key,
    args.plaintext as BufferSource,
  );

  return {
    ciphertext: new Uint8Array(ctBuf),
    nonce,
  };
}

export async function aesGcmDecrypt(
  args: AesGcmDecryptArgs,
): Promise<Uint8Array> {
  if (args.nonce.byteLength !== NONCE_LEN) {
    throw new Error(`AES-GCM nonce must be ${NONCE_LEN} bytes`);
  }
  const key = await importAesKey(args.key);
  const aad = aadBytes(args.aad);

  const ptBuf = await getSubtle().decrypt(
    {
      name: 'AES-GCM',
      iv: args.nonce as BufferSource,
      additionalData: aad as BufferSource,
      tagLength: TAG_LEN_BITS,
    },
    key,
    args.ciphertext as BufferSource,
  );
  return new Uint8Array(ptBuf);
}
