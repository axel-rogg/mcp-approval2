/**
 * Tests fuer den RS256-Key-Pair-Manager.
 *
 * Wir generieren ein frisches RSA-2048-keypair pro Test (via Node crypto)
 * und reichen die PEMs durch loader → sign → verify, um den Roundtrip
 * abzudecken. `jose.SignJWT` + `jose.jwtVerify` werden im
 * jwks.test.ts / dek.test.ts noch einmal genutzt — hier nur der Loader.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, jwtVerify, SignJWT } from 'jose';
import {
  _resetJwtSigningCacheForTests,
  assertRs256Configured,
  getJwksPublicKey,
  getKid,
  getSigningKey,
} from './jwt-signing.js';

function makeKeyPair(): { privatePem: string; publicPem: string } {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: kp.privateKey as string, publicPem: kp.publicKey as string };
}

afterEach(() => {
  _resetJwtSigningCacheForTests();
});

describe('jwt-signing', () => {
  it('returns null when no private key configured', async () => {
    const key = await getSigningKey({});
    expect(key).toBeNull();
  });

  it('returns null when no public key configured', async () => {
    const key = await getJwksPublicKey({});
    expect(key).toBeNull();
  });

  it('loads and caches a valid PKCS#8 private key', async () => {
    const { privatePem } = makeKeyPair();
    const env = { JWT_RS256_PRIVATE_KEY_PEM: privatePem };
    const k1 = await getSigningKey(env);
    const k2 = await getSigningKey(env);
    expect(k1).toBeTruthy();
    expect(k1).toBe(k2); // same Promise resolution → identical key
  });

  it('loads and caches a valid SPKI public key', async () => {
    const { publicPem } = makeKeyPair();
    const env = { JWT_RS256_PUBLIC_KEY_PEM: publicPem };
    const k1 = await getJwksPublicKey(env);
    const k2 = await getJwksPublicKey(env);
    expect(k1).toBeTruthy();
    expect(k1).toBe(k2);
  });

  it('rejects malformed PEM', async () => {
    await expect(getSigningKey({ JWT_RS256_PRIVATE_KEY_PEM: 'not a key' })).rejects.toThrow();
  });

  it('normalizes escaped-newline PEMs', async () => {
    const { privatePem } = makeKeyPair();
    const escaped = privatePem.replace(/\n/g, '\\n');
    const key = await getSigningKey({ JWT_RS256_PRIVATE_KEY_PEM: escaped });
    expect(key).toBeTruthy();
  });

  it('falls back to "default" kid when env missing', () => {
    expect(getKid({})).toBe('default');
    expect(getKid({ JWT_KID: '' })).toBe('default');
    expect(getKid({ JWT_KID: 'key-1' })).toBe('key-1');
  });

  it('assertRs256Configured throws on missing keys', () => {
    expect(() => assertRs256Configured({})).toThrow(/PRIVATE_KEY_PEM/);
  });

  it('end-to-end: sign with private, verify with public + exportJWK', async () => {
    const { privatePem, publicPem } = makeKeyPair();
    const env = {
      JWT_RS256_PRIVATE_KEY_PEM: privatePem,
      JWT_RS256_PUBLIC_KEY_PEM: publicPem,
      JWT_KID: 'kp-test-1',
    };

    const privKey = await getSigningKey(env);
    const pubKey = await getJwksPublicKey(env);
    expect(privKey).toBeTruthy();
    expect(pubKey).toBeTruthy();

    const jwt = await new SignJWT({ scope: 'objects:read' })
      .setProtectedHeader({ alg: 'RS256', kid: getKid(env) })
      .setIssuedAt()
      .setIssuer('mcp-approval2')
      .setAudience('mcp-knowledge2')
      .setSubject('user-1')
      .setExpirationTime('60s')
      .sign(privKey as CryptoKey);

    const verified = await jwtVerify(jwt, pubKey as CryptoKey, {
      issuer: 'mcp-approval2',
      audience: 'mcp-knowledge2',
      algorithms: ['RS256'],
    });
    expect(verified.payload.sub).toBe('user-1');
    expect(verified.protectedHeader.kid).toBe('kp-test-1');

    // exportJWK roundtrip — the very call the JWKS-endpoint performs.
    const jwk = await exportJWK(pubKey as CryptoKey);
    expect(jwk.kty).toBe('RSA');
    expect(jwk.n).toBeTruthy();
    expect(jwk.e).toBeTruthy();
  });
});
