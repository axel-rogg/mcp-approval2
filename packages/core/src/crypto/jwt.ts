/**
 * JWT sign/verify wrapper around `jose`.
 *
 * - HS256 for intra-service tokens (symmetric, fast — used e.g. for session-JWTs
 *   signed and verified by mcp-approval2 itself).
 * - RS256 / ES256 for service-boundary tokens (asymmetric — mcp-approval2 signs
 *   with private key, mcp-knowledge2 verifies via JWKS; see PLAN §2.1 / §5.4).
 *
 * Keys:
 *   - HS256: Uint8Array (raw secret, ≥32 bytes recommended)
 *   - RS256 / ES256: CryptoKey (PrivateKey for sign, PublicKey for verify),
 *     or a JWKS resolver via `{ jwksUri: string }` on verify.
 */

import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  type JWTPayload,
  type KeyLike,
} from 'jose';

export type JwtAlg = 'HS256' | 'RS256' | 'ES256';

export interface SignJwtArgs {
  payload: Record<string, unknown>;
  privateKey: CryptoKey | Uint8Array;
  alg: JwtAlg;
  /** TTL in seconds added to `iat`. Required for everything except long-lived service tokens. */
  expiresInSec?: number;
  /** Optional `iss` claim. */
  issuer?: string;
  /** Optional `aud` claim. */
  audience?: string;
  /** Optional `sub` claim. */
  subject?: string;
  /** Optional explicit `jti`. */
  jti?: string;
  /** Optional explicit `kid` header. */
  kid?: string;
}

export interface VerifyJwtArgs {
  token: string;
  /** Verification key: CryptoKey, raw secret bytes, or remote JWKS resolver. */
  key: CryptoKey | Uint8Array | { jwksUri: string };
  /** If set, the `iss` claim must equal this value. */
  issuer?: string;
  /** If set, the `aud` claim must equal this value. */
  audience?: string;
  /** Optional explicit set of allowed algs (default: HS256 + RS256 + ES256). */
  algorithms?: ReadonlyArray<JwtAlg>;
}

export interface VerifyJwtResult {
  payload: Record<string, unknown>;
}

const DEFAULT_ALGS: ReadonlyArray<JwtAlg> = ['HS256', 'RS256', 'ES256'];

export async function signJwt(args: SignJwtArgs): Promise<string> {
  const builder = new SignJWT(args.payload as JWTPayload).setProtectedHeader({
    alg: args.alg,
    ...(args.kid !== undefined ? { kid: args.kid } : {}),
  });

  builder.setIssuedAt();
  if (args.expiresInSec !== undefined) {
    if (!Number.isInteger(args.expiresInSec) || args.expiresInSec <= 0) {
      throw new Error(
        `signJwt: expiresInSec must be a positive integer (got ${args.expiresInSec})`,
      );
    }
    builder.setExpirationTime(`${args.expiresInSec}s`);
  }
  if (args.issuer !== undefined) builder.setIssuer(args.issuer);
  if (args.audience !== undefined) builder.setAudience(args.audience);
  if (args.subject !== undefined) builder.setSubject(args.subject);
  if (args.jti !== undefined) builder.setJti(args.jti);

  return builder.sign(args.privateKey as KeyLike | Uint8Array);
}

export async function verifyJwt(args: VerifyJwtArgs): Promise<VerifyJwtResult> {
  const algorithms = (args.algorithms ?? DEFAULT_ALGS).slice();

  const verifyOpts: Parameters<typeof jwtVerify>[2] = {
    algorithms: algorithms as string[],
  };
  if (args.issuer !== undefined) verifyOpts.issuer = args.issuer;
  if (args.audience !== undefined) verifyOpts.audience = args.audience;

  // Resolve key.
  if (isJwksRef(args.key)) {
    const jwks = createRemoteJWKSet(new URL(args.key.jwksUri));
    const { payload } = await jwtVerify(args.token, jwks, verifyOpts);
    return { payload: payload as Record<string, unknown> };
  }

  const { payload } = await jwtVerify(
    args.token,
    args.key as KeyLike | Uint8Array,
    verifyOpts,
  );
  return { payload: payload as Record<string, unknown> };
}

function isJwksRef(
  k: CryptoKey | Uint8Array | { jwksUri: string },
): k is { jwksUri: string } {
  return (
    typeof k === 'object' &&
    k !== null &&
    'jwksUri' in k &&
    typeof (k as { jwksUri: unknown }).jwksUri === 'string'
  );
}
