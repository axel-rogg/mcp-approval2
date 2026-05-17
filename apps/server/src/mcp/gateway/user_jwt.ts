/**
 * Sub-MCP-User-JWT-Signer.
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4, §9 (Sub-MCP-Credential-Verteilung).
 *
 * Wird pro `tools/call`-Forward an einen Sub-MCP-Server mitgeschickt
 * (`X-User-JWT`-Header). Sub-MCPs nutzen den Token, um JIT die User-Credentials
 * von approval2 via `POST /internal/v1/credentials/resolve` zu holen.
 *
 * Format (matcht den Verify-Pfad in `routes/internal/credentials.ts`):
 *   - HS256, key = `JWT_SECRET`
 *   - `iss` = `JWT_ISSUER`
 *   - `aud` = `<subMcpName>`  (z.B. "gws", "utils", "gcloud")
 *   - `sub` = `<userId>`
 *   - `exp` = `iat + 60s` (kurzlebig, damit Replay-Window klein)
 */
import { SignJWT } from 'jose';
import type { AppConfig } from '../../lib/config.js';

export interface SignSubMcpUserJwtArgs {
  readonly userId: string;
  readonly subMcpName: string;
  readonly config: Pick<AppConfig, 'JWT_SECRET' | 'JWT_ISSUER'>;
  /** TTL in seconds. Default 60 (kurzlebig, sub-MCP soll Token nicht cachen). */
  readonly ttlSec?: number;
}

const DEFAULT_TTL_SEC = 60;

/**
 * Signs a short-lived HS256 user-JWT für einen sub-MCP-Call.
 */
export async function signSubMcpUserJwt(args: SignSubMcpUserJwtArgs): Promise<string> {
  const ttlSec = args.ttlSec ?? DEFAULT_TTL_SEC;
  const secret = new TextEncoder().encode(args.config.JWT_SECRET);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.userId)
    .setAudience(args.subMcpName)
    .setIssuer(args.config.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(secret);
}
