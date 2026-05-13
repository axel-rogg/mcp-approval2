/**
 * App-JWT-Bridge — signed token zwischen mcp-approval2 (PWA, WebAuthn-authed)
 * und der App-Standalone-Surface (z.B. app.<host>/apps/standalone/<id>).
 *
 * Algo: HS256 mit App-spezifischem Secret (HKDF aus MASTER_KEY). Stateless —
 * keine DB-Row, der State steckt vollstaendig in den Claims. TTL 15min.
 *
 * Multi-User-Anpassung:
 *   - Claims enthalten `sub` (userId) + `aid` (appId) + `scp`.
 *   - Verify-Pfad prueft `aid`-Match gegen den erwarteten App-Pfad.
 *   - Caller (Routes) muss zusaetzlich pruefen, dass `sub` mit dem aktuellen
 *     User uebereinstimmt (RLS via mcp-knowledge2 erledigt das ohnehin —
 *     hier nur Defense-in-Depth).
 */
import { signJwt as coreSignJwt } from '@mcp-approval2/core/crypto';
import { jwtVerify } from 'jose';

export interface AppJwtClaims {
  readonly v: 1;
  readonly sub: string; // userId (UUID)
  readonly aid: string; // app instance id
  readonly scp: 'app:rw';
  readonly iat: number;
  readonly exp: number;
}

const TTL_SEC = 15 * 60; // 15 minutes

/**
 * Derive a HS256 secret from a master-key string + app-id. Per-app keying
 * ist optional, derzeit nutzen wir nur den master-key + festen Salt.
 */
async function appJwtSecret(masterKey: string): Promise<Uint8Array> {
  if (!masterKey || masterKey.length < 32) {
    throw new Error('appJwtSecret: MASTER_KEY required (≥32 chars)');
  }
  // Simple HKDF-SHA256 via WebCrypto (no external dep). Salt fixed, info='app-jwt'.
  const enc = new TextEncoder();
  const ikm = await crypto.subtle.importKey(
    'raw',
    enc.encode(masterKey),
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: enc.encode('app-jwt-v1'),
    },
    ikm,
    256,
  );
  return new Uint8Array(bits);
}

export interface SignAppJwtArgs {
  readonly userId: string;
  readonly appId: string;
  readonly masterKey: string;
  readonly issuer?: string;
  readonly audience?: string;
}

export interface SignedAppJwt {
  readonly token: string;
  readonly expires_at: number; // unix ms
}

export async function signAppJwt(args: SignAppJwtArgs): Promise<SignedAppJwt> {
  const secret = await appJwtSecret(args.masterKey);
  const payload: Record<string, unknown> = {
    v: 1,
    aid: args.appId,
    scp: 'app:rw',
  };
  const signArgs: Parameters<typeof coreSignJwt>[0] = {
    payload,
    privateKey: secret,
    alg: 'HS256',
    expiresInSec: TTL_SEC,
    subject: args.userId,
  };
  if (args.issuer !== undefined) signArgs.issuer = args.issuer;
  if (args.audience !== undefined) signArgs.audience = args.audience;
  const token = await coreSignJwt(signArgs);
  return { token, expires_at: (Math.floor(Date.now() / 1000) + TTL_SEC) * 1000 };
}

export interface VerifyAppJwtArgs {
  readonly token: string;
  readonly expectedAppId: string;
  readonly masterKey: string;
  readonly issuer?: string;
  readonly audience?: string;
}

export async function verifyAppJwt(args: VerifyAppJwtArgs): Promise<AppJwtClaims | null> {
  let secret: Uint8Array;
  try {
    secret = await appJwtSecret(args.masterKey);
  } catch {
    return null;
  }
  try {
    const verifyOpts: Parameters<typeof jwtVerify>[2] = { algorithms: ['HS256'] };
    if (args.issuer !== undefined) (verifyOpts as { issuer?: string }).issuer = args.issuer;
    if (args.audience !== undefined) (verifyOpts as { audience?: string }).audience = args.audience;
    const { payload } = await jwtVerify(args.token, secret, verifyOpts);
    if (payload['v'] !== 1) return null;
    if (typeof payload['aid'] !== 'string') return null;
    if (typeof payload['sub'] !== 'string') return null;
    if (payload['aid'] !== args.expectedAppId) return null;
    if (payload['scp'] !== 'app:rw') return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload['exp'] !== 'number' || payload['exp'] <= now) return null;
    return {
      v: 1,
      sub: payload['sub'] as string,
      aid: payload['aid'] as string,
      scp: 'app:rw',
      iat: typeof payload['iat'] === 'number' ? payload['iat'] : now,
      exp: payload['exp'] as number,
    };
  } catch {
    return null;
  }
}
