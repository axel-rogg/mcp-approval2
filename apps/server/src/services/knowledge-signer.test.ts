/**
 * Tests fuer `makeRs256Signer` — OBO-JWT + Legacy-JWT.
 *
 * Plan-Ref: PLAN-as3-autonomous.md §1.2 + §2.1.
 *
 * Scope:
 *   - Legacy `sign({sub, scope, ttlSec})` setzt iss/aud/sub + optional scope.
 *   - Neue `signOBO({sub, aud, on_behalf_of, approval_id?, request_id?, ttlSec})`
 *     setzt iss/aud/sub + on_behalf_of + approval_id + request_id + jti + exp.
 *   - `kid`-Header wandert in den Protected-Header wenn gesetzt.
 *   - Default-TTL fuer signOBO ist 120s (Spec §2.1).
 *   - `aud` der OBO-Methode ueberschreibt die Factory-Audience.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify } from 'jose';
import { makeRs256Signer } from './knowledge.js';

interface KeyPair {
  readonly privatePem: string;
  readonly publicPem: string;
}

function makeKeyPair(): KeyPair {
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: kp.privateKey as string, publicPem: kp.publicKey as string };
}

async function importPrivate(pem: string): Promise<CryptoKey> {
  return (await importPKCS8(pem, 'RS256', { extractable: false })) as unknown as CryptoKey;
}

async function importPublic(pem: string): Promise<CryptoKey> {
  return (await importSPKI(pem, 'RS256', { extractable: true })) as unknown as CryptoKey;
}

describe('makeRs256Signer — sign (legacy)', () => {
  it('produces JWT with iss/aud/sub from factory defaults', async () => {
    const { privatePem, publicPem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const pub = await importPublic(publicPem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'https://approval2.example.org',
      audience: 'mcp-knowledge2',
    });
    const token = await signer.sign({ sub: 'user-123', ttlSec: 60 });

    const { payload } = await jwtVerify(token, pub, {
      issuer: 'https://approval2.example.org',
      audience: 'mcp-knowledge2',
    });
    expect(payload['sub']).toBe('user-123');
    expect(typeof payload['iat']).toBe('number');
    expect(typeof payload['exp']).toBe('number');
    expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(60);
  });

  it('embeds optional scope claim', async () => {
    const { privatePem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'iss',
      audience: 'aud',
    });
    const token = await signer.sign({ sub: 's', scope: 'objects:read' });
    const payload = decodeJwt(token);
    expect(payload['scope']).toBe('objects:read');
  });

  it('sets kid header when configured', async () => {
    const { privatePem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'iss',
      audience: 'aud',
      kid: 'key-2026-05',
    });
    const token = await signer.sign({ sub: 'u' });
    const header = decodeProtectedHeader(token);
    expect(header.kid).toBe('key-2026-05');
    expect(header.alg).toBe('RS256');
  });
});

describe('makeRs256Signer — signOBO (AS-3)', () => {
  it('produces JWT with on_behalf_of + request_id + approval_id + jti + 120s exp', async () => {
    const { privatePem, publicPem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const pub = await importPublic(publicPem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'https://approval2.example.org',
      audience: 'mcp-approval2', // factory audience irrelevant for OBO
    });

    const token = await signer.signOBO({
      sub: '00000000-0000-0000-0000-000000000001',
      aud: 'mcp-knowledge2',
      on_behalf_of: 'axel@example.org',
      approval_id: 'appr-xyz',
      request_id: 'req-42',
    });

    const { payload, protectedHeader } = await jwtVerify(token, pub, {
      issuer: 'https://approval2.example.org',
      audience: 'mcp-knowledge2',
    });

    expect(protectedHeader.alg).toBe('RS256');
    expect(payload['sub']).toBe('00000000-0000-0000-0000-000000000001');
    expect(payload['on_behalf_of']).toBe('axel@example.org');
    expect(payload['approval_id']).toBe('appr-xyz');
    expect(payload['request_id']).toBe('req-42');
    expect(typeof payload['jti']).toBe('string');
    expect((payload['jti'] as string).length).toBeGreaterThan(8);
    // Default TTL 120s per spec
    expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(120);
  });

  it('omits approval_id + request_id when not provided', async () => {
    const { privatePem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'iss',
      audience: 'aud-default',
    });
    const token = await signer.signOBO({
      sub: 'u',
      aud: 'mcp-knowledge2',
      on_behalf_of: 'a@b.de',
    });
    const payload = decodeJwt(token);
    expect(payload['on_behalf_of']).toBe('a@b.de');
    expect(payload['approval_id']).toBeUndefined();
    expect(payload['request_id']).toBeUndefined();
    expect(payload['aud']).toBe('mcp-knowledge2'); // OBO-aud override
  });

  it('respects custom ttlSec', async () => {
    const { privatePem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'iss',
      audience: 'aud',
    });
    const token = await signer.signOBO({
      sub: 'u',
      aud: 'kc2',
      on_behalf_of: 'x@y.de',
      ttlSec: 60,
    });
    const payload = decodeJwt(token);
    expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(60);
  });

  it('generates unique jti per call', async () => {
    const { privatePem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'iss',
      audience: 'aud',
    });
    const t1 = await signer.signOBO({ sub: 'u', aud: 'kc2', on_behalf_of: 'a@b.de' });
    const t2 = await signer.signOBO({ sub: 'u', aud: 'kc2', on_behalf_of: 'a@b.de' });
    expect(decodeJwt(t1)['jti']).not.toBe(decodeJwt(t2)['jti']);
  });

  it('preserves kid header on OBO tokens', async () => {
    const { privatePem } = makeKeyPair();
    const priv = await importPrivate(privatePem);
    const signer = makeRs256Signer({
      privateKey: priv,
      issuer: 'iss',
      audience: 'aud',
      kid: 'rot-2026-05',
    });
    const token = await signer.signOBO({
      sub: 'u',
      aud: 'mcp-knowledge2',
      on_behalf_of: 'x@y.de',
    });
    const header = decodeProtectedHeader(token);
    expect(header.kid).toBe('rot-2026-05');
  });
});
