/**
 * Internal Credentials-Resolve-Endpoint (Sub-MCP-Backchannel).
 *
 *   POST /internal/v1/credentials/resolve
 *
 * Plan-Ref: PLAN-architecture-v1.md §5.4 (Sub-MCP-Credential-Verteilung).
 *
 * Verantwortung:
 *   - Sub-MCP-Server (cf/github/gws/gcloud/utils) callen diesen Endpoint,
 *     um JIT einen User-Token zu holen (Refresh-Token-pfad wenn OAuth,
 *     raw-PAT bei kind='api_token').
 *
 * Auth ist 2-stufig:
 *   1. `X-Service-Token: <plain>` — pre-shared Token zwischen mcp-approval2
 *      und dem konkreten Sub-MCP. Wir validieren via
 *      `registry.verifyServiceToken(subMcpName, presented)`. SubMcp-Name
 *      kommt aus dem Body (`sub_mcp_name`) ODER aus dem `aud`-Claim des
 *      user-JWT — beide muessen matchen, sonst 401.
 *   2. `user_jwt` im Body — signed by mcp-approval2 (HS256), aud=sub_mcp_name,
 *      sub=user_id. 60s TTL.
 *
 * Response liefert NUR access_token + Metadata — kein refresh_token-Plaintext,
 * kein PAT-Plaintext entweicht je den Worker direkt; `secret` ist hier der
 * decrypted Service-Token (z.B. PAT). Bei oauth_refresh-kind muesste der
 * Resolver vorher gegen den Issuer einen Access-Token-Refresh durchfuehren —
 * das ist Phase-spezifisch, hier liefern wir die persisted secret zurueck und
 * markieren `kind` damit der Caller weiss, was er hat.
 *
 * PRF: wenn das User-Credential `prf_enabled=true` ist, kann der Sub-MCP es NICHT
 * direkt holen — der User muss in der PWA approved haben + prfSessionId im
 * Hub-Cache liegen. Wir akzeptieren optional `prf_session_id` im Body und holen
 * den prfOutput aus dem PrfSessionService. Wenn nicht angegeben + Credential
 * verlangt PRF → 428 prf_required (Sub-MCP triggert Approval-Flow via Hub).
 */
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { jwtVerify } from 'jose';
import { z } from 'zod';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { HttpError } from '../../lib/errors.js';
import {
  PrfRequiredError,
  type CredentialsService,
} from '../../services/credentials.js';
import type { PrfSessionService } from '../../services/prf-session.js';
import type { SubMcpRegistry } from '../../mcp/gateway/registry.js';
import { emitAudit } from '../../services/audit.js';

export interface InternalCredentialsRouteDeps {
  readonly server: ServerContext;
  readonly credentials: CredentialsService;
  readonly registry: SubMcpRegistry;
  /**
   * Optional: prf-session-service. Wenn nicht uebergeben, koennen PRF-pflichtige
   * credentials nicht resolved werden (428).
   */
  readonly prfSessions?: PrfSessionService;
}

const ResolveBodySchema = z.object({
  user_jwt: z.string().min(1),
  provider: z.string().min(1).max(64),
  label: z.string().min(1).max(128).optional(),
  sub_mcp_name: z.string().min(1).max(64).optional(),
  prf_session_id: z.string().min(1).optional(),
});

interface UserJwtClaims {
  readonly sub: string;
  readonly aud: string;
}

async function verifyUserJwt(
  jwt: string,
  server: ServerContext,
  expectedAud: string,
): Promise<UserJwtClaims> {
  const secret = new TextEncoder().encode(server.config.JWT_SECRET);
  try {
    const { payload } = await jwtVerify(jwt, secret, {
      issuer: server.config.JWT_ISSUER,
      audience: expectedAud,
      algorithms: ['HS256'],
    });
    if (!payload.sub || typeof payload.sub !== 'string') {
      throw new Error('missing sub');
    }
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (typeof aud !== 'string') throw new Error('missing aud');
    return { sub: payload.sub, aud };
  } catch (err) {
    throw HttpError.unauthorized(`invalid user_jwt: ${err instanceof Error ? err.message : 'verify_failed'}`);
  }
}

export function internalCredentialsRoutes(deps: InternalCredentialsRouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const { server, credentials, registry } = deps;

  app.post('/internal/v1/credentials/resolve', zValidator('json', ResolveBodySchema), async (c) => {
    const body = c.req.valid('json');

    // Step 1: Service-Token-Schicht (Sub-MCP authentication).
    const presentedToken = c.req.header('x-service-token');
    if (!presentedToken) {
      throw HttpError.unauthorized('x-service-token header required');
    }

    // sub_mcp_name kommt entweder aus dem Body oder wir versuchen es aus dem
    // user-JWT-aud-claim zu ziehen. Wir muessen aber den Hash gegen
    // einen bekannten Sub-MCP-Namen validieren; ergo: erst Body bevorzugen,
    // dann ggf. nach JWT-aud lookuppen.
    let subMcpName = body.sub_mcp_name;
    if (!subMcpName) {
      // peek aud-claim ohne Verify (wir verifizieren gleich nochmal mit dem
      // resolved aud, das ist nur fuer Discovery).
      const parts = body.user_jwt.split('.');
      if (parts.length === 3 && parts[1]) {
        try {
          const padded = parts[1].padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '=');
          const decoded = Buffer.from(padded, 'base64').toString('utf8');
          const payload = JSON.parse(decoded) as { aud?: unknown };
          const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
          if (typeof aud === 'string') subMcpName = aud;
        } catch {
          // ignore; fail below
        }
      }
    }
    if (!subMcpName) {
      throw HttpError.unauthorized('sub_mcp_name missing (body or jwt-aud)');
    }

    const subMcpCfg = await registry.verifyServiceToken(subMcpName, presentedToken);
    if (!subMcpCfg) {
      throw HttpError.unauthorized('invalid service token or sub-mcp not registered');
    }

    // Step 2: user-JWT verifizieren mit aud=subMcpName.
    const claims = await verifyUserJwt(body.user_jwt, server, subMcpName);
    if (claims.aud !== subMcpName) {
      throw HttpError.unauthorized('jwt aud mismatch');
    }
    const userId = claims.sub;

    // Step 3: ggf. PRF-Output resolve.
    let prfOutput: Uint8Array | undefined;
    if (body.prf_session_id) {
      if (!deps.prfSessions) {
        throw HttpError.unauthorized('prf_session_id given but no prf-session-service available');
      }
      const out = await deps.prfSessions.get(body.prf_session_id, userId);
      if (!out) throw HttpError.unauthorized('prf_session invalid or expired');
      prfOutput = out;
    }

    // Step 4: credential resolven.
    try {
      const result = await credentials.resolveForSubMcp({
        userId,
        provider: body.provider,
        ...(body.label ? { label: body.label } : {}),
        ...(prfOutput ? { prfOutput } : {}),
      });

      await emitAudit(server.db, {
        action: 'credential.resolved_for_submcp.gateway',
        actorUserId: userId,
        result: 'success',
        details: {
          subMcpName,
          provider: body.provider,
          label: body.label ?? 'default',
        },
      });

      return c.json({
        access_token: result.secret,
        token_type: 'Bearer',
        expires_at: result.expiresAt,
      });
    } catch (err) {
      if (err instanceof PrfRequiredError) {
        return c.json(
          {
            error: {
              code: 'prf_required',
              message: 'credential requires WebAuthn-PRF — trigger approval flow in hub PWA',
            },
          },
          428,
        );
      }
      throw err;
    }
  });

  return app;
}
