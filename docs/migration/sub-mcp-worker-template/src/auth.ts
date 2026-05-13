/**
 * Sub-MCP-Worker — Auth-Middleware (Service-Bearer + User-JWT).
 *
 * Plan-Ref: docs/migration/sub-mcp-server-migration-guide.md §1 Phase 2.
 *
 * Zweistufige Validierung pro `/mcp`-Request:
 *   Schicht 1 — Service-Bearer: `Authorization: Bearer ${SERVICE_TOKEN}`
 *               (pre-shared zwischen mcp-approval2 und diesem Worker).
 *               Konstant-Zeit-Vergleich gegen die env-Var.
 *   Schicht 2 — User-JWT:      `X-User-JWT: <hs256-jwt>` mit
 *               iss=mcp-approval2, aud=<SUB_MCP_NAME>, exp ≤ 60s.
 *               jose.jwtVerify mit clockTolerance=5s.
 *
 * Bei Erfolg legt die Middleware in den Hono-Context:
 *   c.set('userId',  payload.sub  as string)
 *   c.set('userJwt', raw-jwt-string)
 *
 * Tools nutzen `c.get('userJwt')` um den JWT 1:1 an mcp-approval2
 * /internal/v1/credentials/resolve weiterzureichen — der JWT ist
 * ja sowohl Identity-Beweis als auch Audience-Binding.
 *
 * Phase 8 (RS256 + JWKS): die HS256-Verify-Implementation kann durch
 *   const jwks = createRemoteJWKSet(new URL(env.MCP_APPROVAL_JWKS_URL));
 *   const { payload } = await jwtVerify(jwt, jwks, { algorithms: ['RS256'], ... });
 * ersetzt werden — der Rest dieser Datei bleibt identisch.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { jwtVerify } from 'jose';

export interface SubMcpEnv {
  readonly SUB_MCP_NAME: string;
  readonly SERVICE_TOKEN: string;
  readonly MCP_APPROVAL_JWT_SECRET: string;
  readonly MCP_APPROVAL_JWT_ISSUER?: string;
  readonly MCP_APPROVAL_BASE_URL: string;
  // Phase 8 RS256 (optional, falls gesetzt schlaegt HS256-Pfad oben durch):
  // readonly MCP_APPROVAL_JWKS_URL?: string;
}

export interface SubMcpVariables {
  userId: string;
  userJwt: string;
}

/**
 * Hono-Generic fuer dieses Template — User-Code kann es eigenes erweitern.
 */
export interface SubMcpBindings {
  Bindings: SubMcpEnv;
  Variables: SubMcpVariables;
}

/**
 * Konstant-Zeit-Vergleich zweier Strings. Wichtig fuer das Service-Token —
 * wir wollen keinen timing-side-channel ueber CPU-Branch-Prediction.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Erstellt die Auth-Middleware fuer `/mcp/*`-Routen.
 *
 * Wird vom Hono-Setup einmal pro Worker-Start aufgerufen:
 *   app.use('/mcp/*', createAuthMiddleware());
 */
export function createAuthMiddleware(): MiddlewareHandler<SubMcpBindings> {
  return async (c, next) => {
    const env = c.env;
    // Health-Check ist hier nicht im Scope (siehe index.ts), aber wir bleiben
    // defensiv: kein env → 500 statt 401-Maskierung.
    if (!env.SERVICE_TOKEN) {
      return c.json({ error: 'server misconfigured: SERVICE_TOKEN missing' }, 500);
    }
    if (!env.MCP_APPROVAL_JWT_SECRET) {
      return c.json(
        { error: 'server misconfigured: MCP_APPROVAL_JWT_SECRET missing' },
        500,
      );
    }

    // ─ Schicht 1 — Service-Bearer ───────────────────────────────────────
    const auth = c.req.header('authorization') ?? '';
    const bearer = auth.replace(/^[Bb]earer\s+/, '').trim();
    if (!bearer || !constantTimeEqual(bearer, env.SERVICE_TOKEN)) {
      return c.json({ error: 'service-token invalid' }, 401);
    }

    // ─ Schicht 2 — User-JWT ─────────────────────────────────────────────
    const userJwt = c.req.header('x-user-jwt') ?? '';
    if (!userJwt) {
      return c.json({ error: 'x-user-jwt missing' }, 401);
    }
    const issuer = env.MCP_APPROVAL_JWT_ISSUER ?? 'mcp-approval2';
    const audience = env.SUB_MCP_NAME;
    try {
      const secret = new TextEncoder().encode(env.MCP_APPROVAL_JWT_SECRET);
      const { payload } = await jwtVerify(userJwt, secret, {
        issuer,
        audience,
        algorithms: ['HS256'],
        clockTolerance: 5,
      });
      if (!payload.sub || typeof payload.sub !== 'string') {
        return c.json({ error: 'user-jwt missing sub' }, 401);
      }
      c.set('userId', payload.sub);
      c.set('userJwt', userJwt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'verify_failed';
      // NICHT den vollen JWT loggen — nur den Verify-Error.
      return c.json({ error: `user-jwt invalid: ${msg}` }, 401);
    }

    await next();
    return undefined;
  };
}

/**
 * Helper fuer Tools: liest den User-Context aus dem Hono-Context.
 * Throws wenn die Auth-Middleware nicht durchgelaufen ist (defensiver
 * Coding-Bug-Guard).
 */
export function getUserContext(
  c: Context<SubMcpBindings>,
): { userId: string; userJwt: string } {
  const userId = c.get('userId');
  const userJwt = c.get('userJwt');
  if (!userId || !userJwt) {
    throw new Error('user-context missing — auth middleware did not run');
  }
  return { userId, userJwt };
}
