/**
 * CloudKmsKekProvider tests — Fake-Client deckt boot-Decrypt + lazy-init +
 * roundtrip + destroyKey + concurrent-init-race ab. Echte KMS-Calls werden
 * NICHT getriggert (clientFactory wird gemockt).
 */

import { webcrypto as nodeWebCrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CloudKmsKekProvider, type CloudKmsDecryptClient } from './cloud_kms.js';

const FAKE_KEY_NAME =
  'projects/test-project/locations/eu/keyRings/test-ring/cryptoKeys/test-key';

function randomMaster(): Uint8Array {
  const m = new Uint8Array(32);
  (globalThis.crypto ?? nodeWebCrypto).getRandomValues(m);
  return m;
}

function wrappedB64ForFake(master: Uint8Array): string {
  // Fake-Wrap: ciphertext = base64(master). Der Fake-Client gibt den
  // master direkt zurueck (siehe makeFakeClient).
  return Buffer.from(master).toString('base64');
}

function makeFakeClient(opts: { failOnce?: boolean } = {}): {
  client: CloudKmsDecryptClient;
  calls: number;
} {
  let calls = 0;
  let failed = false;
  const client: CloudKmsDecryptClient = {
    async decrypt({ ciphertext }) {
      calls++;
      if (opts.failOnce && !failed) {
        failed = true;
        throw new Error('fake KMS transient error');
      }
      const ct =
        ciphertext instanceof Uint8Array
          ? ciphertext
          : Buffer.from(ciphertext as ArrayBufferLike);
      // Fake: plaintext == ciphertext (test seam).
      return [{ plaintext: Buffer.from(ct) }];
    },
  };
  return {
    client,
    get calls() {
      return calls;
    },
  } as { client: CloudKmsDecryptClient; calls: number };
}

describe('CloudKmsKekProvider', () => {
  it('wraps and unwraps roundtrip', async () => {
    const master = randomMaster();
    const { client } = makeFakeClient();
    const provider = new CloudKmsKekProvider({
      keyName: FAKE_KEY_NAME,
      wrappedMasterB64: wrappedB64ForFake(master),
      clientFactory: async () => client,
    });

    const dek = new Uint8Array(32);
    (globalThis.crypto ?? nodeWebCrypto).getRandomValues(dek);
    const ref = 'cloudkms://user-abc';

    const wrapped = await provider.wrap(dek, ref);
    expect(wrapped.byteLength).toBeGreaterThan(32); // nonce + ct + tag

    const unwrapped = await provider.unwrap(wrapped, ref);
    expect(Array.from(unwrapped)).toEqual(Array.from(dek));
  });

  it('caches the master across multiple wrap calls (single KMS hit)', async () => {
    const master = randomMaster();
    const fake = makeFakeClient();
    const provider = new CloudKmsKekProvider({
      keyName: FAKE_KEY_NAME,
      wrappedMasterB64: wrappedB64ForFake(master),
      clientFactory: async () => fake.client,
    });

    const dek = new Uint8Array(32);
    (globalThis.crypto ?? nodeWebCrypto).getRandomValues(dek);

    for (let i = 0; i < 5; i++) {
      await provider.wrap(dek, `cloudkms://user-${i}`);
    }
    expect(fake.calls).toBe(1);
  });

  it('dedupes concurrent first-callers (single KMS hit under race)', async () => {
    const master = randomMaster();
    const fake = makeFakeClient();
    const provider = new CloudKmsKekProvider({
      keyName: FAKE_KEY_NAME,
      wrappedMasterB64: wrappedB64ForFake(master),
      clientFactory: async () => fake.client,
    });

    const dek = new Uint8Array(32);
    (globalThis.crypto ?? nodeWebCrypto).getRandomValues(dek);

    await Promise.all([
      provider.wrap(dek, 'cloudkms://user-a'),
      provider.wrap(dek, 'cloudkms://user-b'),
      provider.wrap(dek, 'cloudkms://user-c'),
    ]);
    expect(fake.calls).toBe(1);
  });

  it('different refs produce different ciphertexts (KEK-derivation per ref)', async () => {
    const master = randomMaster();
    const { client } = makeFakeClient();
    const provider = new CloudKmsKekProvider({
      keyName: FAKE_KEY_NAME,
      wrappedMasterB64: wrappedB64ForFake(master),
      clientFactory: async () => client,
    });

    const dek = new Uint8Array(32);
    (globalThis.crypto ?? nodeWebCrypto).getRandomValues(dek);

    const wA = await provider.wrap(dek, 'cloudkms://user-a');
    const wB = await provider.wrap(dek, 'cloudkms://user-b');
    expect(Array.from(wA)).not.toEqual(Array.from(wB));
  });

  it('destroyKey blocks subsequent wrap/unwrap for that ref', async () => {
    const master = randomMaster();
    const { client } = makeFakeClient();
    const provider = new CloudKmsKekProvider({
      keyName: FAKE_KEY_NAME,
      wrappedMasterB64: wrappedB64ForFake(master),
      clientFactory: async () => client,
    });

    const dek = new Uint8Array(32);
    (globalThis.crypto ?? nodeWebCrypto).getRandomValues(dek);
    const ref = 'cloudkms://user-doomed';

    const wrapped = await provider.wrap(dek, ref);
    await provider.destroyKey(ref);
    await expect(provider.unwrap(wrapped, ref)).rejects.toThrow(/destroyed/);
    await expect(provider.wrap(dek, ref)).rejects.toThrow(/destroyed/);
  });

  it('rejects wrong-ref unwrap (AAD-binding)', async () => {
    const master = randomMaster();
    const { client } = makeFakeClient();
    const provider = new CloudKmsKekProvider({
      keyName: FAKE_KEY_NAME,
      wrappedMasterB64: wrappedB64ForFake(master),
      clientFactory: async () => client,
    });

    const dek = new Uint8Array(32);
    (globalThis.crypto ?? nodeWebCrypto).getRandomValues(dek);

    const wrapped = await provider.wrap(dek, 'cloudkms://user-a');
    await expect(provider.unwrap(wrapped, 'cloudkms://user-b')).rejects.toThrow();
  });

  it('throws on non-32-byte unwrapped master', async () => {
    const badClient: CloudKmsDecryptClient = {
      async decrypt() {
        return [{ plaintext: Buffer.from(new Uint8Array(16)) }];
      },
    };
    const provider = new CloudKmsKekProvider({
      keyName: FAKE_KEY_NAME,
      wrappedMasterB64: Buffer.from(new Uint8Array(16)).toString('base64'),
      clientFactory: async () => badClient,
    });
    const dek = new Uint8Array(32);
    await expect(provider.wrap(dek, 'cloudkms://user-x')).rejects.toThrow(
      /32 bytes/,
    );
  });

  it('constructor throws on missing keyName / wrappedMasterB64', () => {
    expect(
      () =>
        new CloudKmsKekProvider({
          keyName: '',
          wrappedMasterB64: 'xxx',
        }),
    ).toThrow(/keyName required/);
    expect(
      () =>
        new CloudKmsKekProvider({
          keyName: FAKE_KEY_NAME,
          wrappedMasterB64: '',
        }),
    ).toThrow(/wrappedMasterB64 required/);
  });
});
