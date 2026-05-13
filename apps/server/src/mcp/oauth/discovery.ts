/**
 * OAuth Authorization-Server-Discovery (RFC 8414).
 *
 * GET /.well-known/oauth-authorization-server
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4, MCP-Spec Nov 2025
 * ("OAuth 2.1 + PKCE + DCR + Resource-Indicators Pflicht").
 *
 * Returns RFC 8414 conformes JSON-Dokument mit allen Endpoint-URLs +
 * supported Algorithms / Grant-Types / Auth-Methods.
 */
import { Hono } from 'hono';
import type { AppBindings, ServerContext } from '../../lib/context.js';
import type { AuthorizationServerMetadata } from './types.js';

/**
 * Baut die Discovery-Metadata aus `server.config.ORIGIN` als Issuer +
 * absoluten URLs fuer alle Endpoints.
 */
export function buildDiscoveryMetadata(origin: string): AuthorizationServerMetadata {
  const base = origin.replace(/\/$/, '');
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    scopes_supported: ['mcp:tools', 'mcp:resources'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
  };
}

export function discoveryRoutes(server: ServerContext): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const meta = buildDiscoveryMetadata(server.config.ORIGIN);
    return c.json(meta, 200, {
      'cache-control': 'public, max-age=3600',
    });
  });

  return app;
}
