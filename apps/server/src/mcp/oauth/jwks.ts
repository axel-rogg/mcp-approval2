/**
 * JWKS-Endpoint — Public-Key-Discovery fuer Token-Validation.
 *
 * GET /.well-known/jwks.json
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (OAuth 2.1 + Token-Validation)
 *           + ADR-0001 (JWT_RS256 boundary key fuer mcp-knowledge2).
 *
 * Liefert die RSA-Public-Half des Service-Boundary-Signing-Keys
 * (`JWT_RS256_PUBLIC_KEY_PEM`) als JWKS-Dokument. mcp-knowledge2 + andere
 * Resource-Server holen das Dokument via `createRemoteJWKSet(JWKS_URL)` und
 * validieren damit die ausgestellten JWTs.
 *
 * Fallback: wenn kein Public-Key konfiguriert (Dev-Mode), liefern wir
 * `{ keys: [] }` — RFC-7517-konform. Das signalisiert dem Resource-Server
 * "kein public-key verfuegbar, JWT-Validierung muss anders laufen" (z.B.
 * /oauth/introspect oder HS256 mit shared secret).
 *
 * Cache-Control: 5 min — niedrig genug fuer schnelle Key-Rotation (env-tausch
 * + Restart), hoch genug damit upstream Verifier nicht jeden Request hier
 * pollen.
 */
import { Hono } from 'hono';
import { exportJWK } from 'jose';
import { getJwksPublicKey, getKid, type JwtSigningEnv } from '../../auth/jwt-signing.js';
import type { AppBindings, ServerContext } from '../../lib/context.js';

export interface JwksDocument {
  readonly keys: ReadonlyArray<Record<string, unknown>>;
}

export function jwksRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/.well-known/jwks.json', async (c) => {
    const env = (server.config as unknown) as JwtSigningEnv;
    const pub = await getJwksPublicKey(env);
    let doc: JwksDocument;
    if (!pub) {
      doc = { keys: [] };
    } else {
      const jwk = await exportJWK(pub);
      // Bind algorithm + key-id + usage so Verifier picks the right entry.
      jwk.kid = getKid(env);
      jwk.use = 'sig';
      jwk.alg = 'RS256';
      doc = { keys: [jwk as unknown as Record<string, unknown>] };
    }
    return c.json(doc, 200, {
      'cache-control': 'public, max-age=300',
    });
  });

  return app;
}
