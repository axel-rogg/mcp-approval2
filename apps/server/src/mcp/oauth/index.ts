/**
 * OAuth-2.1-Authorization-Server-Router (MCP-Spec Nov 2025).
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4.
 *
 * Mountet:
 *   - GET  /.well-known/oauth-authorization-server   (RFC 8414)
 *   - GET  /.well-known/jwks.json                    (RFC 7517)
 *   - POST /oauth/register                           (RFC 7591 DCR)
 *   - GET  /oauth/authorize                          (OAuth 2.1 + PKCE)
 *   - POST /oauth/token                              (Code + Refresh-Grant)
 *   - POST /oauth/revoke                             (RFC 7009)
 *
 * Mount in apps/server/src/index.ts:
 *
 *   import { oauthRoutes } from './mcp/oauth/index.js';
 *   app.route('/', oauthRoutes(server));
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import { discoveryRoutes } from './discovery.js';
import { jwksRoutes } from './jwks.js';
import { registerRoutes } from './register.js';
import { authorizeRoutes } from './authorize.js';
import { tokenRoutes } from './token.js';
import { revokeRoutes } from './revoke.js';

export function oauthRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.route('/', discoveryRoutes(server));
  app.route('/', jwksRoutes(server));
  app.route('/', registerRoutes(server));
  app.route('/', authorizeRoutes(server));
  app.route('/', tokenRoutes(server));
  app.route('/', revokeRoutes(server));
  return app;
}

export { buildDiscoveryMetadata } from './discovery.js';
export type {
  AuthorizationServerMetadata,
  ClientMetadataInput,
  ClientRegistrationResponse,
  TokenRequest,
  TokenResponse,
  AccessTokenClaims,
  OauthErrorCode,
} from './types.js';
