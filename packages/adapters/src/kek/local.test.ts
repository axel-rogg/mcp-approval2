import { webcrypto as nodeWebCrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { LocalKekProvider } from './local.js';

function makeKey(seed: number): Uint8Array {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = (seed + i) & 0xff;
  return k;
}

function randomDek(): Uint8Array {
  const out = new Uint8Array(32);
  nodeWebCrypto.getRandomValues(out);
  return out;
}

describe('LocalKekProvider', () => {
  it('rejects masterKey of wrong length', () => {
    expect(() => new LocalKekProvider({ masterKey: new Uint8Array(16) })).toThrow(
      /must be 32 bytes/,
    );
  });

  it('wraps and unwraps a DEK roundtrip', async () => {
    const provider = new LocalKekProvider({ masterKey: makeKey(1) });
    const dek = randomDek();
    const ref = 'local://user-00000000-0000-0000-0000-000000000001';

    const wrapped = await provider.wrap(dek, ref);
    expect(wrapped).toBeInstanceOf(Uint8Array);
    expect(wrapped.byteLength).toBeGreaterThan(dek.byteLength);

    const unwrapped = await provider.unwrap(wrapped, ref);
    expect(unwrapped).toEqual(dek);
  });

  it('wrap is non-deterministic (random nonce)', async () => {
    const provider = new LocalKekProvider({ masterKey: makeKey(2) });
    const dek = randomDek();
    const ref = 'local://user-abc';

    const w1 = await provider.wrap(dek, ref);
    const w2 = await provider.wrap(dek, ref);
    expect(w1).not.toEqual(w2);
  });

  it('unwrap fails when ref differs (AAD-bound)', async () => {
    const provider = new LocalKekProvider({ masterKey: makeKey(3) });
    const dek = randomDek();
    const refA = 'local://user-A';
    const refB = 'local://user-B';

    const wrapped = await provider.wrap(dek, refA);
    await expect(provider.unwrap(wrapped, refB)).rejects.toThrow();
  });

  it('unwrap fails when masterKey differs', async () => {
    const p1 = new LocalKekProvider({ masterKey: makeKey(4) });
    const p2 = new LocalKekProvider({ masterKey: makeKey(5) });
    const dek = randomDek();
    const ref = 'local://user-X';

    const wrapped = await p1.wrap(dek, ref);
    await expect(p2.unwrap(wrapped, ref)).rejects.toThrow();
  });

  it('destroyKey blocks subsequent wrap/unwrap on the same ref', async () => {
    const provider = new LocalKekProvider({ masterKey: makeKey(6) });
    const dek = randomDek();
    const ref = 'local://user-destroy-me';

    const wrapped = await provider.wrap(dek, ref);
    await provider.destroyKey(ref);

    await expect(provider.wrap(dek, ref)).rejects.toThrow(/destroyed/);
    await expect(provider.unwrap(wrapped, ref)).rejects.toThrow(/destroyed/);
  });

  it('destroyKey does not affect other refs', async () => {
    const provider = new LocalKekProvider({ masterKey: makeKey(7) });
    const dek = randomDek();
    const refA = 'local://user-A';
    const refB = 'local://user-B';

    const wrappedA = await provider.wrap(dek, refA);
    const wrappedB = await provider.wrap(dek, refB);

    await provider.destroyKey(refA);

    await expect(provider.unwrap(wrappedA, refA)).rejects.toThrow(/destroyed/);
    const okB = await provider.unwrap(wrappedB, refB);
    expect(okB).toEqual(dek);
  });

  it('rotate(sameRef) is a no-op (lifecycle marker only)', async () => {
    const provider = new LocalKekProvider({ masterKey: makeKey(8) });
    const ref = 'local://user-rotate';
    await expect(provider.rotate(ref, ref)).resolves.toBeUndefined();
  });

  it('rotate(oldRef, newRef) does not auto-rewrap existing ciphertexts', async () => {
    // Caller-Responsibility: re-wrap iterates credentials manually.
    const provider = new LocalKekProvider({ masterKey: makeKey(9) });
    const dek = randomDek();
    const oldRef = 'local://user-old';
    const newRef = 'local://user-new';

    const wrapped = await provider.wrap(dek, oldRef);
    await provider.rotate(oldRef, newRef);
    // Alter Ciphertext bleibt unter oldRef entschluesselbar:
    const ok = await provider.unwrap(wrapped, oldRef);
    expect(ok).toEqual(dek);
  });
});
