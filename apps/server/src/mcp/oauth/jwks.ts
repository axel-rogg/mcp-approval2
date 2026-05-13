/**
 * JWKS-Endpoint — Public-Key-Discovery fuer Token-Validation.
 *
 * GET /.well-known/jwks.json
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (OAuth 2.1 + Token-Validation).
 *
 * Phase-1-Approach (HS256):
 *   Wir signieren Access-Tokens aktuell mit HS256 + `config.JWT_SECRET`.
 *   HS256 hat KEINEN Public-Key — symmetrische Secret-Sharing. Der Resource-
 *   Server (z.B. mcp-knowledge2) muss das gleiche Secret kennen (out-of-band
 *   provisioned), oder spaeter Tokens via `/oauth/introspect` (RFC 7662)
 *   validieren.
 *
 * Phase-2-Roadmap (RS256/ES256):
 *   Switch zu asymmetrischer Sig — dann liefert dieser Endpoint die Public-
 *   JWKs mit `kid` zur Key-Rotation. Bis dahin: 200 + leeres `keys`-Array
 *   ist RFC-7517-konform und kommuniziert "kein public-key verfuegbar".
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../../lib/context.js';

export interface JwksDocument {
  readonly keys: ReadonlyArray<Record<string, unknown>>;
}

export function jwksRoutes(_server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/.well-known/jwks.json', (c) => {
    const doc: JwksDocument = { keys: [] };
    return c.json(doc, 200, {
      'cache-control': 'public, max-age=300',
    });
  });

  return app;
}
