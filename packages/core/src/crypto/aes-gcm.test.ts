import { describe, expect, it } from 'vitest';
import { aesGcmDecrypt, aesGcmEncrypt } from './aes-gcm.js';
import { buildAad } from './aad.js';
import { randomBytes } from './random.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function key32(): Uint8Array {
  return randomBytes(32);
}

describe('aesGcmEncrypt / aesGcmDecrypt', () => {
  it('round-trips a UTF-8 plaintext with string AAD', async () => {
    const key = key32();
    const plaintext = enc.encode('hello, secrets');
    const aad = buildAad({
      recordType: 'credentials',
      owner: 'u1',
      provider: 'jira',
      kind: 'api_token',
      id: 'c1',
    });
    const { ciphertext, nonce } = await aesGcmEncrypt({ key, plaintext, aad });
    expect(ciphertext.byteLength).toBeGreaterThan(plaintext.byteLength); // tag appended
    expect(nonce.byteLength).toBe(12);

    const out = await aesGcmDecrypt({ key, ciphertext, nonce, aad });
    expect(dec.decode(out)).toBe('hello, secrets');
  });

  it('round-trips an empty plaintext', async () => {
    const key = key32();
    const aad = 'generic|ns|id1';
    const { ciphertext, nonce } = await aesGcmEncrypt({
      key,
      plaintext: new Uint8Array(0),
      aad,
    });
    expect(ciphertext.byteLength).toBe(16); // GCM-tag only
    const out = await aesGcmDecrypt({ key, ciphertext, nonce, aad });
    expect(out.byteLength).toBe(0);
  });

  it('accepts a caller-supplied nonce and returns it unchanged', async () => {
    const key = key32();
    const nonce = randomBytes(12);
    const { nonce: returned } = await aesGcmEncrypt({
      key,
      plaintext: enc.encode('x'),
      aad: 'a',
      nonce,
    });
    expect(returned).toBe(nonce);
  });

  it('detects AAD tampering (auth-tag mismatch)', async () => {
    const key = key32();
    const aad = 'credentials|u1|jira|api_token|c1';
    const { ciphertext, nonce } = await aesGcmEncrypt({
      key,
      plaintext: enc.encode('top-secret'),
      aad,
    });
    await expect(
      aesGcmDecrypt({
        key,
        ciphertext,
        nonce,
        aad: 'credentials|u1|jira|api_token|c2', // <- different id
      }),
    ).rejects.toThrow();
  });

  it('detects ciphertext tampering', async () => {
    const key = key32();
    const aad = 'generic|ns|id1';
    const { ciphertext, nonce } = await aesGcmEncrypt({
      key,
      plaintext: enc.encode('payload'),
      aad,
    });
    const flipped = new Uint8Array(ciphertext);
    // Flip a bit in the body (not the tag).
    if (flipped.length === 0) throw new Error('test pre-condition: empty');
    const idx = 0;
    const current = flipped[idx];
    if (current === undefined) throw new Error('unreachable: idx 0 OOB');
    flipped[idx] = current ^ 0x01;
    await expect(
      aesGcmDecrypt({ key, ciphertext: flipped, nonce, aad }),
    ).rejects.toThrow();
  });

  it('detects nonce tampering', async () => {
    const key = key32();
    const aad = 'generic|ns|id1';
    const { ciphertext, nonce } = await aesGcmEncrypt({
      key,
      plaintext: enc.encode('payload'),
      aad,
    });
    const badNonce = new Uint8Array(nonce);
    const cur = badNonce[0];
    if (cur === undefined) throw new Error('unreachable');
    badNonce[0] = cur ^ 0x01;
    await expect(
      aesGcmDecrypt({ key, ciphertext, nonce: badNonce, aad }),
    ).rejects.toThrow();
  });

  it('rejects wrong key size on encrypt', async () => {
    await expect(
      aesGcmEncrypt({
        key: new Uint8Array(16), // AES-128 — not allowed here
        plaintext: enc.encode('x'),
        aad: 'a',
      }),
    ).rejects.toThrow(/must be 32 bytes/);
  });

  it('rejects wrong nonce size on encrypt', async () => {
    await expect(
      aesGcmEncrypt({
        key: key32(),
        plaintext: enc.encode('x'),
        aad: 'a',
        nonce: new Uint8Array(8),
      }),
    ).rejects.toThrow(/nonce must be 12 bytes/);
  });

  it('rejects wrong nonce size on decrypt', async () => {
    await expect(
      aesGcmDecrypt({
        key: key32(),
        ciphertext: new Uint8Array(32),
        nonce: new Uint8Array(8),
        aad: 'a',
      }),
    ).rejects.toThrow(/nonce must be 12 bytes/);
  });

  it('accepts AAD as raw bytes too', async () => {
    const key = key32();
    const aadStr = 'generic|ns|id1';
    const aadBytes = enc.encode(aadStr);
    const { ciphertext, nonce } = await aesGcmEncrypt({
      key,
      plaintext: enc.encode('hi'),
      aad: aadBytes,
    });
    const out = await aesGcmDecrypt({ key, ciphertext, nonce, aad: aadStr });
    expect(dec.decode(out)).toBe('hi');
  });

  it('produces different ciphertext per call (fresh nonce)', async () => {
    const key = key32();
    const aad = 'generic|ns|id1';
    const a = await aesGcmEncrypt({ key, plaintext: enc.encode('x'), aad });
    const b = await aesGcmEncrypt({ key, plaintext: enc.encode('x'), aad });
    expect(a.nonce).not.toEqual(b.nonce);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });
});
