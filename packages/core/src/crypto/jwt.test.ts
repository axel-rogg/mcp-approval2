import { generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from './jwt.js';
import { randomBytes } from './random.js';

describe('signJwt / verifyJwt (HS256)', () => {
  it('round-trips a payload', async () => {
    const key = randomBytes(32);
    const token = await signJwt({
      payload: { sub: 'u1', role: 'admin' },
      privateKey: key,
      alg: 'HS256',
      expiresInSec: 60,
      issuer: 'mcp-approval2',
      audience: 'mcp-knowledge2',
    });
    expect(token.split('.').length).toBe(3);

    const { payload } = await verifyJwt({
      token,
      key,
      issuer: 'mcp-approval2',
      audience: 'mcp-knowledge2',
    });
    expect(payload['sub']).toBe('u1');
    expect(payload['role']).toBe('admin');
    expect(payload['iss']).toBe('mcp-approval2');
    expect(payload['aud']).toBe('mcp-knowledge2');
    expect(typeof payload['iat']).toBe('number');
    expect(typeof payload['exp']).toBe('number');
  });

  it('rejects a token signed with a different secret', async () => {
    const signingKey = randomBytes(32);
    const wrongKey = randomBytes(32);
    const token = await signJwt({
      payload: { sub: 'u1' },
      privateKey: signingKey,
      alg: 'HS256',
      expiresInSec: 60,
    });
    await expect(verifyJwt({ token, key: wrongKey })).rejects.toThrow();
  });

  it('rejects a token whose issuer does not match', async () => {
    const key = randomBytes(32);
    const token = await signJwt({
      payload: { sub: 'u1' },
      privateKey: key,
      alg: 'HS256',
      issuer: 'real-issuer',
      expiresInSec: 60,
    });
    await expect(
      verifyJwt({ token, key, issuer: 'wrong-issuer' }),
    ).rejects.toThrow();
  });

  it('rejects a token whose audience does not match', async () => {
    const key = randomBytes(32);
    const token = await signJwt({
      payload: { sub: 'u1' },
      privateKey: key,
      alg: 'HS256',
      audience: 'real-aud',
      expiresInSec: 60,
    });
    await expect(
      verifyJwt({ token, key, audience: 'wrong-aud' }),
    ).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const key = randomBytes(32);
    // jose only accepts positive durations, so we craft an already-expired token
    // by signing with a 1s expiry, then waiting briefly.
    const token = await signJwt({
      payload: { sub: 'u1' },
      privateKey: key,
      alg: 'HS256',
      expiresInSec: 1,
    });
    await new Promise((r) => setTimeout(r, 1100));
    await expect(verifyJwt({ token, key })).rejects.toThrow();
  });

  it('rejects non-positive expiresInSec', async () => {
    const key = randomBytes(32);
    await expect(
      signJwt({
        payload: {},
        privateKey: key,
        alg: 'HS256',
        expiresInSec: 0,
      }),
    ).rejects.toThrow();
  });
});

describe('signJwt / verifyJwt (RS256)', () => {
  it('round-trips with an asymmetric key pair', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', {
      extractable: true,
    });
    const token = await signJwt({
      payload: { sub: 'service' },
      privateKey,
      alg: 'RS256',
      expiresInSec: 60,
      kid: 'k1',
    });
    const { payload } = await verifyJwt({
      token,
      key: publicKey,
      algorithms: ['RS256'],
    });
    expect(payload['sub']).toBe('service');
  });
});

describe('signJwt / verifyJwt (ES256)', () => {
  it('round-trips with an ES256 key pair', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256', {
      extractable: true,
    });
    const token = await signJwt({
      payload: { sub: 'service' },
      privateKey,
      alg: 'ES256',
      expiresInSec: 60,
    });
    const { payload } = await verifyJwt({
      token,
      key: publicKey,
      algorithms: ['ES256'],
    });
    expect(payload['sub']).toBe('service');
  });
});
